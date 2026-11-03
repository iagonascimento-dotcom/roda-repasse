// ============================================================
//  Edge Function: tuya-kwh
//  Ponte entre o app de Repasse e a Tuya Cloud.
//
//  ACHADO (03/11/2026) — o que destravou a integracao:
//  O acumulado de energia NAO esta em /v1.0/devices/{id}/status nem nas
//  /specifications destes medidores. Ele so aparece no modelo de coisas:
//      GET /v2.0/cloud/thing/{device_id}/shadow/properties
//  no campo "total_ele" (dp 101), multiplicado por 100.
//  Conferido em 2 aparelhos contra o historico do Repasse:
//    PDV 139767: total_ele 1445894 -> 14458,94 kWh (medidor fim out/26 = 14129)
//    PDV 141040: total_ele  996942 ->  9969,42 kWh (medidor fim out/26 =  9815)
//  cur_power NAO serve: e potencia instantanea em W, nao acumulado.
//
//  Assinatura: o SHA-256 do corpo vai em MINUSCULO dentro do stringToSign e
//  so o HMAC final vai em MAIUSCULO. Inverter isso da "sign invalid".
//
//  Acoes (POST JSON):
//    diag  -> confere secrets e token, sem expor segredo
//    list  -> lista os medidores da conta
//    kwh   -> leitura acumulada em kWh  { device_id, energy_code?, energy_scale? }
//    specs -> codigos que o aparelho declara  { device_id }
//    raw   -> GET de leitura livre na Tuya    { path }  (investigacao)
//
//  Secrets: TUYA_ACCESS_ID / TUYA_ACCESS_SECRET / TUYA_API_BASE
// ============================================================

const ACCESS_ID = (Deno.env.get("TUYA_ACCESS_ID") ?? "").trim();
const ACCESS_SECRET = (Deno.env.get("TUYA_ACCESS_SECRET") ?? "").trim();
// .trim() importa: o TUYA_API_BASE foi colado com um TAB na frente.
const API_BASE = (Deno.env.get("TUYA_API_BASE") ?? "https://openapi.tuyaus.com").trim().replace(/\/$/, "");

// Escala padrao destes medidores. Fica aqui tambem (e nao so no banco) para o
// caso de alguem chamar a funcao sem passar energy_scale.
const ESCALA_PADRAO = 100;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))).toUpperCase();
}

async function buildSign(method: string, path: string, body: string, token: string, t: string) {
  const stringToSign = [method, await sha256Hex(body || ""), "", path].join("\n");
  return hmacSha256Hex(ACCESS_ID + token + t + "" + stringToSign, ACCESS_SECRET);
}

async function getToken(): Promise<string> {
  const t = Date.now().toString();
  const path = "/v1.0/token?grant_type=1";
  const sign = await buildSign("GET", path, "", "", t);
  const res = await fetch(API_BASE + path, {
    headers: { client_id: ACCESS_ID, sign, t, sign_method: "HMAC-SHA256", nonce: "" },
  });
  const json = await res.json();
  if (!json.success) throw new Error(`Tuya recusou o token (code ${json.code}): ${json.msg ?? ""}`);
  return json.result.access_token;
}

async function tuyaGet(path: string, token: string): Promise<any> {
  const t = Date.now().toString();
  const sign = await buildSign("GET", path, "", token, t);
  const res = await fetch(API_BASE + path, {
    headers: { client_id: ACCESS_ID, access_token: token, sign, t, sign_method: "HMAC-SHA256", nonce: "" },
  });
  return res.json();
}

const LIST_ENDPOINTS = [
  "/v1.0/iot-01/associated-users/devices?size=100",
  "/v1.3/iot-03/devices?page_no=1&page_size=100",
  "/v2.0/cloud/thing/device?page_size=100",
];

function normalizeDevices(result: any): any[] | null {
  const arr = result?.devices ?? result?.list ?? (Array.isArray(result) ? result : null);
  if (!Array.isArray(arr)) return null;
  return arr.map((d: any) => ({
    device_id: d.id ?? d.device_id ?? d.uuid,
    nome_tuya: d.name ?? d.custom_name ?? "",
    online: d.online ?? d.is_online ?? null,
    categoria: d.category ?? "",
    produto: d.product_name ?? d.productName ?? "",
  })).filter((d: any) => d.device_id);
}

async function listDevices(token: string) {
  const tentativas: any[] = [];
  for (const path of LIST_ENDPOINTS) {
    const json = await tuyaGet(path, token);
    const devices = json?.success ? normalizeDevices(json.result) : null;
    if (devices && devices.length) {
      return { ok: true, endpoint_que_funcionou: path, total: devices.length, devices, tentativas };
    }
    tentativas.push({ path, success: json?.success ?? false, code: json?.code, msg: json?.msg });
  }
  return { ok: false, erro: "Nenhum endpoint de listagem retornou dispositivos.", tentativas };
}

// Acumulado, em ordem de preferencia. cur_power esta de fora de proposito.
const ENERGY_CODES = [
  "total_ele", "add_ele", "total_forward_energy", "forward_energy_total",
  "energy_forward", "total_energy", "electricity_total",
];

async function readKwh(token: string, deviceId: string, code?: string, scale?: number) {
  const json = await tuyaGet(`/v2.0/cloud/thing/${deviceId}/shadow/properties`, token);
  if (!json.success) return { ok: false, device_id: deviceId, code: json.code, msg: json.msg };
  const props: Array<{ code: string; value: any; time?: number }> = json.result?.properties ?? [];
  const preferidos = code ? [code, ...ENERGY_CODES] : ENERGY_CODES;
  const achado = preferidos.map(c => props.find(p => p.code === c)).find(Boolean) ?? null;
  const divisor = Number(scale) > 0 ? Number(scale) : ESCALA_PADRAO;
  return {
    ok: !!achado,
    device_id: deviceId,
    campo: achado?.code ?? null,
    valor_bruto: achado?.value ?? null,
    escala: divisor,
    kwh: achado ? Number(achado.value) / divisor : null,   // pronto para o medidor fim
    lido_em: achado?.time ? new Date(achado.time).toISOString() : null,
    erro: achado ? null : "Nenhum campo de energia acumulada neste aparelho.",
    todas_as_propriedades: props,
  };
}

// Caminhos de leitura permitidos no modo "raw". Somente GET.
const RAW_OK = [/^\/v1\.[0-9]\/devices\//, /^\/v1\.[0-9]\/iot-0[13]\//, /^\/v2\.[0-9]\/cloud\//];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const J = (o: unknown, s = 200) => Response.json(o, { status: s, headers: CORS });
  try {
    if (!ACCESS_ID || !ACCESS_SECRET) {
      return J({ ok: false, erro: "Faltam os secrets TUYA_ACCESS_ID e/ou TUYA_ACCESS_SECRET." }, 500);
    }
    const body = await req.json().catch(() => ({ action: "diag" }));
    const { action, device_id, path, energy_code, energy_scale } = body ?? {};

    if (action === "diag") {
      const d: any = {
        api_base: API_BASE,
        access_id_prefixo: ACCESS_ID.slice(0, 4) + "...",
        access_id_tamanho: ACCESS_ID.length,
        access_secret_tamanho: ACCESS_SECRET.length,
      };
      try { d.token_ok = !!(await getToken()); } catch (e) { d.token_ok = false; d.token_erro = String(e); }
      return J({ ok: true, diag: d });
    }

    const token = await getToken();
    if (action === "list") return J(await listDevices(token));
    if (action === "kwh") {
      if (!device_id) return J({ ok: false, erro: "device_id obrigatorio" }, 400);
      return J(await readKwh(token, device_id, energy_code, energy_scale));
    }
    if (action === "specs") {
      if (!device_id) return J({ ok: false, erro: "device_id obrigatorio" }, 400);
      return J(await tuyaGet(`/v1.0/devices/${device_id}/specifications`, token));
    }
    if (action === "raw") {
      if (typeof path !== "string" || !path.startsWith("/") || /[\s\\]/.test(path)) {
        return J({ ok: false, erro: "path invalido" }, 400);
      }
      if (!RAW_OK.some(re => re.test(path))) return J({ ok: false, erro: "caminho nao permitido" }, 403);
      return J({ ok: true, path, resposta: await tuyaGet(path, token) });
    }
    return J({ ok: false, erro: "action invalida (diag, list, kwh, specs, raw)" }, 400);
  } catch (e) {
    return J({ ok: false, erro: String(e) }, 500);
  }
});

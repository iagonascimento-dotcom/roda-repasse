import { useState, useEffect } from "react";

const CONTRACT_TYPES = [
  "Medidor","Fixo","Percentual do Faturamento","Medidor + Mínimo",
  "Percentual do Faturamento + Mínimo","Percentual do Faturamento OU Mínimo",
  "Medidor + Percentual de Faturamento","Medidor OU Percentual de Faturamento",
  "Medidor OU Percentual de Faturamento OU Mínimo",
  "Conta de Energia + Percentual do Faturamento","Boleto"
];
const REV_TYPES = ["Líquido","Bruto"];
const LIQ = 0.87;

/* ─── Supabase REST adapter ─── */
const SB_URL = "https://nssjemcdifdkxfhzukmz.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zc2plbWNkaWZka3hmaHp1a216Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MjAxNzcsImV4cCI6MjA5NTM5NjE3N30.HYHSc7xaQgKzLGkDqJ3uOdOYHRzaaRLrGLu21ceOdhY";

const SB = {
  token: null,
  headers(extra={}){
    return {"apikey":SB_KEY,"Content-Type":"application/json",
      "Authorization":`Bearer ${this.token||SB_KEY}`,...extra};
  },
  async api(path,opts={}){
    const r=await fetch(`${SB_URL}${path}`,{...opts,headers:this.headers(opts.headers||{})});
    if(!r.ok){const t=await r.text();throw new Error(t);}
    const ct=r.headers.get("content-type")||"";
    if(ct.includes("json")){const j=await r.json();return j;}
    return null;
  },
  /* Auth */
  async signIn(email,pw){
    let r;
    try{
      r=await fetch(`${SB_URL}/auth/v1/token?grant_type=password`,{
        method:"POST",headers:{"apikey":SB_KEY,"Content-Type":"application/json"},
        body:JSON.stringify({email,password:pw})});
    }catch(e){throw new Error("Erro de conexão. Verifique sua internet.");}
    let d;
    try{d=await r.json();}catch(e){throw new Error(`Erro do servidor (${r.status}). Tente novamente.`);}
    if(!r.ok||d.error){
      const msg=(d.error_description||d.msg||d.error||"").toLowerCase();
      if(msg.includes("invalid login")||msg.includes("invalid credentials"))
        throw new Error("Email ou senha incorretos. Verifique seus dados ou solicite acesso.");
      if(msg.includes("email not confirmed"))
        throw new Error("Email não confirmado. Entre em contato com o administrador.");
      if(msg.includes("user not found"))
        throw new Error("Usuário não cadastrado. Clique em 'Solicitar' para pedir acesso.");
      throw new Error(d.error_description||d.msg||d.error||`Erro ${r.status}`);
    }
    this.token=d.access_token;return d;
  },
  async signUp(email,pw,name){
    const r=await fetch(`${SB_URL}/auth/v1/signup`,{
      method:"POST",headers:{"apikey":SB_KEY,"Content-Type":"application/json"},
      body:JSON.stringify({email,password:pw,data:{name:name||""}})});
    const d=await r.json();
    if(d.error){
      const msg=(d.error_description||d.msg||d.error||"").toLowerCase();
      if(msg.includes("already registered")||msg.includes("already exists"))
        throw new Error("Este email já está cadastrado. Tente fazer login.");
      if(msg.includes("disabled")||msg.includes("not allowed"))
        throw new Error("Cadastro desabilitado. Entre em contato com o administrador.");
      if(msg.includes("password")||msg.includes("weak"))
        throw new Error("Senha muito fraca. Use pelo menos 6 caracteres.");
      throw new Error(d.error_description||d.msg||d.error);
    }
    return d;
  },
  async refreshToken(rt){
    const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`,{
      method:"POST",headers:{"apikey":SB_KEY,"Content-Type":"application/json"},
      body:JSON.stringify({refresh_token:rt})});
    const d=await r.json();if(d.error)throw new Error(d.error);
    this.token=d.access_token;return d;
  },
  /* PDVs */
  async loadPdvs(){
    const rows=await this.api("/rest/v1/pdvs?select=*&active=eq.true&order=nome");
    return rows.map(r=>({
      uuid:r.id, id:r.vmpay_id||r.id, name:r.nome,
      contract_type:r.contract_type, revenue_consideration:r.revenue_consideration,
      negotiated_percentage:Number(r.negotiated_percentage)||0,
      kwh_unity_price:Number(r.kwh_unity_price)||0,
      minimal_repass:Number(r.minimal_repass)||0,
      energy_bill:Number(r.energy_bill)||0,
      payment_day:r.payment_day||20,
      bank_cnpj_cond:r.bank_cnpj_cond||"",bank_cnpj:r.bank_cnpj||"",
      bank_name:r.bank_name||"",bank_banco:r.bank_banco||"",
      bank_agencia:r.bank_agencia||"",bank_conta:r.bank_conta||"",
      bank_pix:r.bank_pix||"",
    }));
  },
  async patchPdv(uuid,fields){
    const map={name:"nome"};
    const body={};
    Object.entries(fields).forEach(([k,v])=>{body[map[k]||k]=v;});
    body.updated_at=new Date().toISOString();
    await this.api(`/rest/v1/pdvs?id=eq.${uuid}`,{method:"PATCH",body:JSON.stringify(body),
      headers:{"Prefer":"return=minimal"}});
  },
  /* Periods */
  async loadPeriods(){
    return this.api("/rest/v1/periodos?select=*&order=ano.desc,mes.desc");
  },
  async createPeriod(nome,mes,ano){
    const r=await this.api("/rest/v1/periodos",{method:"POST",
      body:JSON.stringify({nome,mes,ano}),headers:{"Prefer":"return=representation"}});
    return r[0]||r;
  },
  async updatePeriod(id,fields){
    fields.updated_at=new Date().toISOString();
    await this.api(`/rest/v1/periodos?id=eq.${id}`,{method:"PATCH",
      body:JSON.stringify(fields),headers:{"Prefer":"return=minimal"}});
  },
  /* Monthly data */
  async loadMonthlyData(periodoId,pdvMap){
    const rows=await this.api(`/rest/v1/dados_mensais?select=*&periodo_id=eq.${periodoId}`);
    const md={};
    rows.forEach(r=>{
      const vid=pdvMap[r.pdv_id];if(!vid)return;
      md[vid]={meter_start:Number(r.meter_start)||0,meter_end:Number(r.meter_end)||0,
        raw_revenue:Number(r.raw_revenue)||0,manual_adjustment:Number(r.manual_adjustment)||0,
        manual_adjustment_desc:r.manual_adjustment_desc||"",
        energy_bill_cond:Number(r.energy_bill_cond)||0,_id:r.id};
    });return md;
  },
  async upsertMonthly(periodoId,pdvUuid,data){
    const body={periodo_id:periodoId,pdv_id:pdvUuid,
      meter_start:data.meter_start||0,meter_end:data.meter_end||0,
      raw_revenue:data.raw_revenue||0,manual_adjustment:data.manual_adjustment||0,
      manual_adjustment_desc:data.manual_adjustment_desc||"",
      energy_bill_cond:data.energy_bill_cond||0,updated_at:new Date().toISOString()};
    await this.api("/rest/v1/dados_mensais?on_conflict=periodo_id,pdv_id",{method:"POST",body:JSON.stringify(body),
      headers:{"Prefer":"return=minimal,resolution=merge-duplicates"}});
  },
  async bulkUpsertMonthly(periodoId,records){
    if(!records.length)return;
    const body=records.map(r=>({periodo_id:periodoId,pdv_id:r.pdvUuid,
      meter_start:r.data.meter_start||0,meter_end:r.data.meter_end||0,
      raw_revenue:r.data.raw_revenue||0,manual_adjustment:r.data.manual_adjustment||0,
      manual_adjustment_desc:r.data.manual_adjustment_desc||"",
      energy_bill_cond:r.data.energy_bill_cond||0,updated_at:new Date().toISOString()}));
    await this.api("/rest/v1/dados_mensais?on_conflict=periodo_id,pdv_id",{method:"POST",body:JSON.stringify(body),
      headers:{"Prefer":"return=minimal,resolution=merge-duplicates"}});
  },
  /* Results */
  async loadResults(periodoId,pdvMap){
    const rows=await this.api(`/rest/v1/resultados?select=*&periodo_id=eq.${periodoId}`);
    return rows.map(r=>{
      const vid=pdvMap[r.pdv_id];
      return {id:vid||r.pdv_id,uuid:r.pdv_id,name:"",
        contract_type:r.contract_type_snapshot,revenue_consideration:r.revenue_consideration_snapshot,
        subtotal:Number(r.subtotal)||0,total:Number(r.total)||0,
        energyBill:Number(r.energy_bill)||0,pctRevenue:Number(r.pct_revenue)||0,
        calcRevenue:Number(r.calc_revenue)||0,details:r.details||""};
    });
  },
  async saveAllResults(periodoId,results,pdvUuidMap){
    await this.api(`/rest/v1/resultados?periodo_id=eq.${periodoId}`,{method:"DELETE",
      headers:{"Prefer":"return=minimal"}});
    if(!results.length)return;
    const body=results.map(r=>({
      periodo_id:periodoId,pdv_id:pdvUuidMap[r.id],
      contract_type_snapshot:r.contract_type,revenue_consideration_snapshot:r.revenue_consideration,
      negotiated_pct_snapshot:r.negotiated_percentage||0,
      subtotal:r.subtotal||0,adjustment:r.total-(r.subtotal||0),total:r.total||0,
      energy_bill:r.energyBill||0,pct_revenue:r.pctRevenue||0,
      calc_revenue:r.calcRevenue||0,details:r.details||"",
      payment_day_snapshot:r.payment_day||20
    }));
    await this.api("/rest/v1/resultados",{method:"POST",body:JSON.stringify(body),
      headers:{"Prefer":"return=minimal"}});
  },
  /* User Roles */
  async loadUserRole(email){
    const rows=await this.api(`/rest/v1/user_roles?email=eq.${encodeURIComponent(email)}&select=*`);
    return rows[0]||null;
  },
  async ensureUserRole(userId,email,nome){
    await this.api("/rest/v1/user_roles?on_conflict=email",{method:"POST",
      body:JSON.stringify({user_id:userId,email,nome:nome||"",role:"pendente"}),
      headers:{"Prefer":"return=minimal,resolution=merge-duplicates"}});
  },
  async loadAllUsers(){
    return this.api("/rest/v1/user_roles?select=*&order=created_at.desc");
  },
  async updateUserRole(id,fields){
    fields.updated_at=new Date().toISOString();
    await this.api(`/rest/v1/user_roles?id=eq.${id}`,{method:"PATCH",
      body:JSON.stringify(fields),headers:{"Prefer":"return=minimal"}});
  },
  async deleteUser(id){
    await this.api(`/rest/v1/user_roles?id=eq.${id}`,{method:"DELETE",headers:{"Prefer":"return=minimal"}});
  },
  /* Change Requests */
  async loadChangeRequests(statusFilter){
    const q=statusFilter?`&status=eq.${statusFilter}`:"";
    return this.api(`/rest/v1/change_requests?select=*&order=created_at.desc${q}`);
  },
  async createChangeRequest(req){
    await this.api("/rest/v1/change_requests",{method:"POST",body:JSON.stringify(req),
      headers:{"Prefer":"return=minimal"}});
  },
  async reviewChangeRequest(id,status,reviewerId){
    await this.api(`/rest/v1/change_requests?id=eq.${id}`,{method:"PATCH",
      body:JSON.stringify({status,reviewed_by:reviewerId,reviewed_at:new Date().toISOString()}),
      headers:{"Prefer":"return=minimal"}});
  },
};

/* ─── Token persistence via localStorage ─── */
async function tokenGet(){try{const r=localStorage.getItem("sb-session");return r?JSON.parse(r):null;}catch{return null;}}
async function tokenSet(d){try{localStorage.setItem("sb-session",JSON.stringify(d));}catch(e){console.error(e);}}
async function tokenClear(){try{localStorage.removeItem("sb-session");}catch{}}

/* ─── Calculation engine ─── */
function calc(pdv, ms, me, rev, eBillCond) {
  const ct=pdv.contract_type;
  if(ct==="Boleto") return {subtotal:0,total:0,details:"Boleto",energyBill:0,pctRevenue:0,calcRevenue:0};
  const kwh=pdv.kwh_unity_price||0, pct=pdv.negotiated_percentage||0;
  const mn=pdv.minimal_repass||0, adj=pdv.manual_adjustment||0;
  const rf=pdv.revenue_consideration==="Bruto"?1.0:LIQ;
  const eb=(me-ms)*kwh, cr=rev*rf, pr=cr*pct;
  let sub=0, det="";
  switch(ct){
    case"Fixo":sub=mn;det=`Fixo: R$${mn.toFixed(2)}`;break;
    case"Medidor":sub=eb;det=`(${me}-${ms})×${kwh}=R$${eb.toFixed(2)}`;break;
    case"Percentual do Faturamento":sub=pr;det=`R$${rev.toFixed(0)}×${rf}×${(pct*100).toFixed(1)}%=R$${pr.toFixed(2)}`;break;
    case"Medidor + Mínimo":sub=eb+mn;det=`En R$${eb.toFixed(2)}+Mín R$${mn.toFixed(2)}`;break;
    case"Medidor + Percentual de Faturamento":sub=eb+pr;det=`En R$${eb.toFixed(2)}+%F R$${pr.toFixed(2)}`;break;
    case"Percentual do Faturamento + Mínimo":sub=pr+mn;det=`%F R$${pr.toFixed(2)}+Mín R$${mn.toFixed(2)}`;break;
    case"Percentual do Faturamento OU Mínimo":sub=Math.max(pr,mn);det=`MAX(%F R$${pr.toFixed(2)}, Mín R$${mn.toFixed(2)})`;break;
    case"Medidor OU Percentual de Faturamento":sub=Math.max(eb,pr);det=`MAX(En R$${eb.toFixed(2)}, %F R$${pr.toFixed(2)})`;break;
    case"Medidor OU Percentual de Faturamento OU Mínimo":sub=Math.max(eb,pr,mn);det=`MAX(En,%%F,Mín)=R$${Math.max(eb,pr,mn).toFixed(2)}`;break;
    case"Conta de Energia + Percentual do Faturamento":sub=pr+(eBillCond||0);det=`%F R$${pr.toFixed(2)}+Conta R$${(eBillCond||0).toFixed(2)}`;break;
    default:sub=0;
  }
  return {subtotal:sub,total:sub+adj,energyBill:eb,pctRevenue:pr,calcRevenue:cr,details:det};
}

const fmt=v=>new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(v||0);

const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
:root { --accent: #00314f; --accent-bg: #e8f0f5; --accent-light: #004d7a; --orange: #ff8b00; --orange-bg: #fff5e6; --warn: #ff8b00; --warn-bg: #fff5e6; --ok: #9bf400; --ok-bg: #f0ffe0; --red: #f2401a; --red-bg: #fef0ed; --cream: #fffae9; }
body { font-family: 'DM Sans', sans-serif; }
.app { display: flex; min-height: 100vh; background: var(--color-background-tertiary, #f5f4f0); color: var(--color-text-primary, #1a1a1a); }
.side { width: 220px; background: var(--accent); padding: 0 0 16px; flex-shrink: 0; display: flex; flex-direction: column; }
.logo { padding: 0 16px 12px; font-size: 18px; font-weight: 700; border-bottom: 1px solid rgba(255,255,255,0.12); margin-bottom: 6px; letter-spacing: -0.5px; color: #fff; display: flex; align-items: center; gap: 10px; flex-direction: column; }
.nav-item { padding: 10px 16px; cursor: pointer; font-size: 13px; transition: all 0.15s; display: flex; align-items: center; gap: 8px; color: rgba(255,255,255,0.6); }
.nav-item:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.9); }
.nav-item.active { color: #fff; background: rgba(255,255,255,0.12); border-right: 3px solid var(--orange); font-weight: 600; }
.main { flex: 1; padding: 24px; overflow: auto; max-height: 100vh; }
.card { background: var(--color-background-primary, #fff); border-radius: 10px; padding: 20px; margin-bottom: 16px; border: 1px solid var(--color-border-tertiary, #e5e5e3); }
.h2 { font-size: 18px; font-weight: 700; margin-bottom: 14px; letter-spacing: -0.3px; color: var(--accent); }
.h3 { font-size: 14px; font-weight: 700; margin-bottom: 10px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
.grid4 { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 12px; }
.stat { background: var(--color-background-primary, #fff); border-radius: 8px; padding: 14px; border: 1px solid var(--color-border-tertiary, #e5e5e3); }
.stat-val { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
.stat-lbl { font-size: 11px; color: var(--color-text-secondary, #6b6b6b); margin-top: 3px; text-transform: uppercase; letter-spacing: 0.4px; }
input, select { width: 100%; padding: 7px 10px; border-radius: 7px; border: 1px solid var(--color-border-tertiary, #e5e5e3); background: var(--color-background-secondary, #f5f5f3); color: var(--color-text-primary, #1a1a1a); font-size: 13px; font-family: inherit; outline: none; }
input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-bg); }
textarea { width: 100%; padding: 8px 10px; border-radius: 7px; border: 1px solid var(--color-border-tertiary, #e5e5e3); background: var(--color-background-secondary, #f5f5f3); color: var(--color-text-primary, #1a1a1a); font-size: 12px; font-family: monospace; min-height: 100px; resize: vertical; outline: none; }
.btn { padding: 7px 16px; border-radius: 7px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; font-family: inherit; transition: all 0.12s; }
.btn-p { background: var(--accent); color: #fff; }
.btn-p:hover { background: var(--accent-light); }
.btn-s { background: var(--color-background-secondary, #f0f0ee); color: var(--color-text-primary, #1a1a1a); }
.btn-d { background: var(--red-bg); color: var(--red); }
.btn-o { background: var(--orange); color: #fff; }
.btn-o:hover { background: #e67d00; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { padding: 8px 10px; text-align: left; border-bottom: 2px solid var(--color-border-tertiary, #e5e5e3); font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--color-text-secondary, #6b6b6b); font-weight: 600; }
td { padding: 7px 10px; border-bottom: 1px solid var(--color-border-tertiary, #e5e5e3); }
tr:hover { background: var(--color-background-secondary, #fafaf8); }
.badge { display: inline-block; padding: 2px 7px; border-radius: 5px; font-size: 10px; font-weight: 600; }
.badge-info { background: var(--accent-bg); color: var(--accent); }
.badge-warn { background: var(--orange-bg); color: #b45309; }
.badge-ok { background: var(--ok-bg); color: #3d7a00; }
.badge-danger { background: var(--red-bg); color: var(--red); }
.chip { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 500; background: var(--color-background-secondary, #f0f0ee); color: var(--color-text-secondary, #6b6b6b); white-space: nowrap; }
.mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; }
.tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid var(--color-border-tertiary, #e5e5e3); }
.tab { padding: 8px 16px; cursor: pointer; font-size: 13px; color: var(--color-text-secondary, #6b6b6b); border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.12s; }
.tab.active { color: var(--accent); border-bottom-color: var(--orange); font-weight: 600; }
.field { margin-bottom: 10px; }
.field label { display: block; font-size: 11px; font-weight: 600; color: var(--color-text-secondary, #6b6b6b); margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.3px; }
.empty { padding: 32px; text-align: center; color: var(--color-text-tertiary, #999); font-size: 13px; }
.trunc { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row { display: flex; gap: 10px; align-items: flex-end; }
.bdr-l { border-left-width: 4px; border-left-style: solid; }
.scroll-x { overflow-x: auto; }
.fade-in { animation: fadeIn 0.2s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
`;

function Stat({val,label,color}) {
  return <div className="stat bdr-l" style={{borderLeftColor:color}}><div className="stat-val">{val}</div><div className="stat-lbl">{label}</div></div>;
}
function Field({label,children}) {
  return <div className="field"><label>{label}</label>{children}</div>;
}
function ConfirmModal({msg,detail,onConfirm,onCancel}) {
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",
    justifyContent:"center",zIndex:999}} onClick={onCancel}>
    <div style={{background:"var(--color-background-primary,#fff)",borderRadius:12,padding:24,maxWidth:420,
      width:"90%",boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}} onClick={e=>e.stopPropagation()}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:8}}>⚠ Confirmar alteração</div>
      <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:6}}>{msg}</div>
      {detail&&<div className="mono" style={{fontSize:12,background:"var(--color-background-secondary)",
        borderRadius:6,padding:10,marginBottom:16,maxHeight:200,overflow:"auto",whiteSpace:"pre-wrap"}}>{detail}</div>}
      <div style={{fontSize:11,color:"var(--color-text-warning,#b45309)",marginBottom:16,fontWeight:600}}>
        Isso vai alterar a base e recalcular todos os valores.
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
        <button className="btn btn-s" onClick={onCancel}>Cancelar</button>
        <button className="btn btn-p" onClick={onConfirm}>Sim, alterar</button>
      </div>
    </div>
  </div>;
}

/* ─── Login Screen ─── */
function LoginScreen({onAuth}){
  const [email,setEmail]=useState("");
  const [pw,setPw]=useState("");
  const [nome,setNome]=useState("");
  const [mode,setMode]=useState("login");
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const [msg,setMsg]=useState("");

  async function submit(e){
    e?.preventDefault?.();
    if(!email||!pw){setErr("Preencha email e senha");return;}
    if(mode==="signup"&&!nome.trim()){setErr("Preencha seu nome");return;}
    setLoading(true);setErr("");setMsg("");
    try{
      if(mode==="login"){
        const d=await SB.signIn(email,pw);
        await tokenSet({access_token:d.access_token,refresh_token:d.refresh_token});
        onAuth(d);
      }else{
        await SB.signUp(email,pw,nome.trim());
        setMsg("Solicitação enviada! Aguarde aprovação do administrador.");setMode("login");
      }
    }catch(e){setErr(e.message||"Erro desconhecido");}
    finally{setLoading(false);}
  }

  const inputSt={width:"100%",padding:"10px 12px",borderRadius:8,border:"1px solid #e5e5e3",fontSize:14};

  return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
    background:"linear-gradient(135deg,#00314f 0%,#004d7a 100%)",fontFamily:"'DM Sans',sans-serif"}}>
    <div style={{background:"#fff",borderRadius:16,padding:40,width:380,boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
      <div style={{textAlign:"center",marginBottom:24}}>
        <div style={{fontSize:32,fontWeight:700,color:"#00314f",marginBottom:4}}>Roda Repasse</div>
        <div style={{fontSize:13,color:"#6b6b6b"}}>{mode==="login"?"Entre com sua conta":"Solicitar acesso"}</div>
      </div>
      {err&&<div style={{padding:"8px 12px",borderRadius:8,background:"#fef0ed",color:"#f2401a",fontSize:12,marginBottom:12,fontWeight:500}}>{err}</div>}
      {msg&&<div style={{padding:"8px 12px",borderRadius:8,background:"#f0ffe0",color:"#3d7a00",fontSize:12,marginBottom:12,fontWeight:500}}>{msg}</div>}
      {mode==="signup"&&<div className="field"><label style={{fontSize:11,fontWeight:600,color:"#6b6b6b",marginBottom:3,display:"block"}}>Nome completo</label>
        <input type="text" value={nome} onChange={e=>setNome(e.target.value)} placeholder="Seu nome"
          style={inputSt}/></div>}
      <div className="field"><label style={{fontSize:11,fontWeight:600,color:"#6b6b6b",marginBottom:3,display:"block"}}>Email</label>
        <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="seu@email.com"
          style={inputSt} onKeyDown={e=>e.key==="Enter"&&submit()}/></div>
      <div className="field"><label style={{fontSize:11,fontWeight:600,color:"#6b6b6b",marginBottom:3,display:"block"}}>Senha</label>
        <input type="password" value={pw} onChange={e=>setPw(e.target.value)} placeholder="••••••"
          style={inputSt} onKeyDown={e=>e.key==="Enter"&&submit()}/></div>
      <button onClick={submit} disabled={loading}
        style={{width:"100%",padding:"11px",borderRadius:8,border:"none",cursor:"pointer",
          fontSize:14,fontWeight:700,fontFamily:"inherit",marginTop:8,
          background:loading?"#ccc":"#00314f",color:"#fff"}}>
        {loading?"Aguarde...":(mode==="login"?"Entrar":"Solicitar acesso")}
      </button>
      <div style={{textAlign:"center",marginTop:16,fontSize:12,color:"#6b6b6b"}}>
        {mode==="login"?<>Não tem acesso? <span style={{color:"#00314f",fontWeight:600,cursor:"pointer"}} onClick={()=>{setMode("signup");setErr("");setMsg("");}}>Solicitar</span></>
        :<>Já tem conta? <span style={{color:"#00314f",fontWeight:600,cursor:"pointer"}} onClick={()=>{setMode("login");setErr("");setMsg("");}}>Fazer login</span></>}
      </div>
    </div>
  </div>;
}

/* ─── Dashboard ─── */
function Dashboard({pdvs,results,period,allPeriods,onLoadPeriodResults,revUuidMap,userRole}) {
  const [compPeriods,setCompPeriods]=useState([]);
  const [compData,setCompData]=useState({});
  const [loadingComp,setLoadingComp]=useState(false);
  const [filterType,setFilterType]=useState(null);
  const [compError,setCompError]=useState("");

  const canExport=userRole?.role==="master"||userRole?.role==="admin";
  const tot=results.reduce((s,r)=>s+(r.total||0),0);
  const totE=results.reduce((s,r)=>s+(r.energyBill||0),0);
  const totP=results.reduce((s,r)=>s+(r.pctRevenue||0),0);
  const byType={};
  pdvs.forEach(p=>{if(p.contract_type!=="Boleto")byType[p.contract_type]=(byType[p.contract_type]||0)+1;});
  const active=pdvs.filter(p=>p.contract_type!=="Boleto").length;
  const filteredResults=filterType?results.filter(r=>r.contract_type===filterType):results;

  async function togglePeriod(p){
    const id=p.id;setCompError("");
    if(compPeriods.find(x=>x.id===id)){
      setCompPeriods(prev=>prev.filter(x=>x.id!==id));
      setCompData(prev=>{const nd={...prev};delete nd[id];return nd;});
      return;
    }
    setLoadingComp(true);
    try{
      const res=await onLoadPeriodResults(id);
      setCompPeriods(prev=>[...prev,p]);
      setCompData(prev=>({...prev,[id]:res}));
      if(!res||res.length===0) setCompError(`"${p.nome}" não tem resultados calculados. Rode o cálculo primeiro.`);
    }catch(e){setCompError("Erro ao carregar: "+e.message);console.error(e);}
    setLoadingComp(false);
  }

  const selPeriods=compPeriods;
  const allPdvNames=pdvs.filter(p=>p.contract_type!=="Boleto").map(p=>({id:p.id,name:p.name}));
  const compRows=allPdvNames.map(({id,name})=>{
    const row={id,name};
    selPeriods.forEach(p=>{const pRes=compData[p.id]||[];const r=pRes.find(x=>x.id===id);row[p.id]=r?.total||0;});
    return row;
  }).filter(row=>selPeriods.some(p=>row[p.id]>0));

  function exportCompCSV(){
    if(!canExport)return;
    const h="PDV,"+selPeriods.map(p=>p.nome).join(",")+"\n";
    const rows=compRows.map(r=>
      `"${r.name}",${selPeriods.map(p=>(r[p.id]||0).toFixed(2)).join(",")}`
    ).join("\n");
    const totRow=`"TOTAL",${selPeriods.map(p=>compRows.reduce((s,r)=>s+(r[p.id]||0),0).toFixed(2)).join(",")}`;
    const b=new Blob([h+rows+"\n"+totRow],{type:"text/csv;charset=utf-8;"});
    const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="comparativo_periodos.csv";a.click();
  }

  return <div className="fade-in">
    <div className="h2">Dashboard</div>
    <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:16}}>Período ativo: <strong>{period||"Não definido"}</strong></div>
    <div className="grid4" style={{marginBottom:16}}>
      <Stat val={fmt(tot)} label="Total repasse" color="#00314f"/>
      <Stat val={active} label="PDVs ativos" color="#9bf400"/>
      <Stat val={fmt(totE)} label="Total energia" color="#ff8b00"/>
      <Stat val={fmt(totP)} label="Total % fat." color="#00314f"/>
    </div>
    <div className="card">
      <div className="h3">Por tipo de contrato {filterType&&<span style={{fontSize:11,fontWeight:400,color:"var(--color-text-secondary)"}}>(filtro: {filterType}) <span style={{cursor:"pointer",color:"var(--accent)"}} onClick={()=>setFilterType(null)}>✕ limpar</span></span>}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
        {Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([t,c])=>
          <span key={t} className="chip" onClick={()=>setFilterType(filterType===t?null:t)}
            style={{padding:"4px 10px",fontSize:11,cursor:"pointer",
              background:filterType===t?"var(--accent)":"",color:filterType===t?"#fff":""}}>{t}: <strong>{c}</strong></span>
        )}
      </div>
    </div>
    {results.length>0&&<div className="card">
      <div className="h3">{filterType?`${filterType} (${filteredResults.length})`:`Top 10 maiores repasses`}</div>
      <table><thead><tr><th>PDV</th><th>Tipo</th><th>Valor</th></tr></thead>
      <tbody>{[...filteredResults].sort((a,b)=>b.total-a.total).slice(0,filterType?999:10).map((r,i)=>
        <tr key={i}><td className="trunc" style={{fontWeight:500}}>{r.name}</td>
        <td><span className="chip">{r.contract_type}</span></td>
        <td className="mono" style={{fontWeight:700}}>{fmt(r.total)}</td></tr>
      )}</tbody></table>
      {filterType&&<div style={{fontSize:12,fontWeight:700,textAlign:"right",padding:"8px 4px",color:"var(--accent)"}}>
        Total {filterType}: {fmt(filteredResults.reduce((s,r)=>s+r.total,0))}</div>}
    </div>}

    {allPeriods&&allPeriods.length>0&&<div className="card">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <div className="h3">Comparar períodos</div>
        {canExport&&selPeriods.length>0&&compRows.length>0&&<button className="btn btn-s" onClick={exportCompCSV} style={{fontSize:11}}>⬇ Exportar CSV</button>}
      </div>
      <p style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:10}}>Clique nos períodos para comparar valores por PDV:</p>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
        {allPeriods.map(p=>{const sel=compPeriods.find(x=>x.id===p.id);
          return <div key={p.id} onClick={()=>togglePeriod(p)} style={{padding:"5px 12px",borderRadius:8,cursor:"pointer",fontSize:12,
            fontWeight:sel?700:400,background:sel?"var(--accent)":"var(--color-background-secondary)",
            color:sel?"#fff":"var(--color-text-secondary)",border:sel?"none":"1px solid var(--color-border-tertiary)",
            transition:"all 0.12s"}}>{p.nome}</div>;})}
      </div>
      {loadingComp&&<div style={{fontSize:12,color:"var(--color-text-secondary)",padding:10}}>Carregando...</div>}
      {compError&&<div style={{padding:"8px 12px",borderRadius:8,background:"var(--orange-bg)",color:"#92400e",fontSize:12,marginBottom:10}}>{compError}</div>}
      {selPeriods.length>0&&compRows.length>0&&<div className="scroll-x"><table>
        <thead><tr><th>PDV</th>{selPeriods.map(p=><th key={p.id} className="mono" style={{textAlign:"right"}}>{p.nome}</th>)}</tr></thead>
        <tbody>
          {compRows.sort((a,b)=>{const last=selPeriods[selPeriods.length-1]?.id;return (b[last]||0)-(a[last]||0);}).map(row=>
            <tr key={row.id}><td className="trunc" style={{fontWeight:500}}>{row.name}</td>
              {selPeriods.map(p=><td key={p.id} className="mono" style={{textAlign:"right",fontWeight:600,
                color:row[p.id]>0?"inherit":"var(--color-text-tertiary)"}}>{row[p.id]>0?fmt(row[p.id]):"-"}</td>)}
            </tr>
          )}
          <tr style={{fontWeight:700,borderTop:"2px solid var(--color-border-secondary)"}}>
            <td style={{textAlign:"right"}}>TOTAL</td>
            {selPeriods.map(p=><td key={p.id} className="mono" style={{textAlign:"right",color:"var(--accent)",fontSize:13}}>
              {fmt(compRows.reduce((s,r)=>s+(r[p.id]||0),0))}</td>)}
          </tr>
        </tbody>
      </table></div>}
      {selPeriods.length>0&&compRows.length===0&&!loadingComp&&<div className="empty">Nenhum resultado calculado nos períodos selecionados. Rode o cálculo na aba Calcular primeiro.</div>}
      {selPeriods.length===0&&<div style={{fontSize:12,color:"var(--color-text-tertiary)",textAlign:"center",padding:16}}>Clique nos períodos acima para comparar</div>}
    </div>}
  </div>;
}

/* ─── PDV Manager ─── */
function PdvManager({pdvs,setPdvs,save}) {
  const [search,setSearch]=useState("");
  const [editing,setEditing]=useState(null);
  const [showForm,setShowForm]=useState(false);

  const empty={id:"",name:"",contract_type:"Fixo",revenue_consideration:"Líquido",
    negotiated_percentage:0,kwh_unity_price:0,minimal_repass:0,manual_adjustment:0,
    manual_adjustment_description:"",payment_day:20,bank_cnpj_cond:"",bank_cnpj:"",
    bank_name:"",bank_banco:"",bank_agencia:"",bank_conta:"",bank_pix:""};

  const filtered=pdvs.filter(p=>
    p.name?.toLowerCase().includes(search.toLowerCase())||
    p.id?.toString().includes(search)||
    p.contract_type?.toLowerCase().includes(search.toLowerCase())
  );

  function savePdv(f){
    const u=editing!==null?pdvs.map((p,i)=>i===editing?{...pdvs[editing],...f}:p):[...pdvs,f];
    setPdvs(u);save(u);setEditing(null);setShowForm(false);
  }
  function del(idx){const u=pdvs.filter((_,i)=>i!==idx);setPdvs(u);save(u);}

  return <div className="fade-in">
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
      <div className="h2">Cadastro de PDVs ({pdvs.length})</div>
      <button className="btn btn-p" onClick={()=>{setEditing(null);setShowForm(true);}}>+ Novo PDV</button>
    </div>
    <input placeholder="Buscar por nome, ID ou tipo..." value={search} onChange={e=>setSearch(e.target.value)} style={{marginBottom:14}}/>
    {showForm&&<PdvForm pdv={editing!==null?pdvs[editing]:empty} onSave={savePdv} onCancel={()=>{setShowForm(false);setEditing(null);}}/>}
    <div className="scroll-x">
      <table><thead><tr>
        <th>ID</th><th>Nome</th><th>Contrato</th><th>Receita</th><th>%</th><th>kWh</th><th>Mínimo</th><th></th>
      </tr></thead><tbody>
        {filtered.map((p,idx)=>{const ri=pdvs.indexOf(p);return <tr key={idx}>
          <td className="mono">{p.id}</td>
          <td className="trunc" style={{fontWeight:500}}>{p.name}</td>
          <td><span className="chip">{p.contract_type}</span></td>
          <td><span className={`badge ${p.revenue_consideration==="Bruto"?"badge-warn":"badge-info"}`}>{p.revenue_consideration}</span></td>
          <td className="mono">{((p.negotiated_percentage||0)*100).toFixed(1)}%</td>
          <td className="mono">{p.kwh_unity_price||"-"}</td>
          <td className="mono">{p.minimal_repass?fmt(p.minimal_repass):"-"}</td>
          <td>
            <span style={{cursor:"pointer",marginRight:6}} onClick={()=>{setEditing(ri);setShowForm(true);}}>✎</span>
            <span style={{cursor:"pointer",color:"var(--red)"}} onClick={()=>del(ri)}>✕</span>
          </td>
        </tr>;})}
      </tbody></table>
    </div>
    {filtered.length===0&&<div className="empty">Nenhum PDV encontrado</div>}
  </div>;
}

function PdvForm({pdv,onSave,onCancel}) {
  const [f,sf]=useState({...pdv});
  const s=(k,v)=>sf(o=>({...o,[k]:v}));
  return <div className="card fade-in" style={{border:"2px solid var(--accent)",marginBottom:16}}>
    <div className="h3">{pdv.id?"Editar":"Novo"} PDV</div>
    <div className="grid3">
      <Field label="ID"><input value={f.id} onChange={e=>s("id",e.target.value)}/></Field>
      <Field label="Nome"><input value={f.name} onChange={e=>s("name",e.target.value)}/></Field>
      <Field label="Tipo contrato"><select value={f.contract_type} onChange={e=>s("contract_type",e.target.value)}>
        {CONTRACT_TYPES.map(t=><option key={t}>{t}</option>)}</select></Field>
      <Field label="Receita"><select value={f.revenue_consideration} onChange={e=>s("revenue_consideration",e.target.value)}>
        {REV_TYPES.map(t=><option key={t}>{t}</option>)}</select></Field>
      <Field label="% Negociado"><input type="number" step="0.001" value={f.negotiated_percentage} onChange={e=>s("negotiated_percentage",parseFloat(e.target.value)||0)}/></Field>
      <Field label="kWh preço"><input type="number" step="0.01" value={f.kwh_unity_price} onChange={e=>s("kwh_unity_price",parseFloat(e.target.value)||0)}/></Field>
      <Field label="Mínimo"><input type="number" step="0.01" value={f.minimal_repass} onChange={e=>s("minimal_repass",parseFloat(e.target.value)||0)}/></Field>
      <Field label="Dia pgto"><input type="number" value={f.payment_day} onChange={e=>s("payment_day",parseInt(e.target.value)||20)}/></Field>
    </div>
    <details style={{marginTop:12}}>
      <summary style={{cursor:"pointer",fontSize:12,fontWeight:600,color:"var(--color-text-secondary)"}}>Dados bancários</summary>
      <div className="grid3" style={{marginTop:10}}>
        <Field label="CNPJ Cond."><input value={f.bank_cnpj_cond||""} onChange={e=>s("bank_cnpj_cond",e.target.value)}/></Field>
        <Field label="CNPJ Conta"><input value={f.bank_cnpj||""} onChange={e=>s("bank_cnpj",e.target.value)}/></Field>
        <Field label="Nome Conta"><input value={f.bank_name||""} onChange={e=>s("bank_name",e.target.value)}/></Field>
        <Field label="Banco"><input value={f.bank_banco||""} onChange={e=>s("bank_banco",e.target.value)}/></Field>
        <Field label="Agência"><input value={f.bank_agencia||""} onChange={e=>s("bank_agencia",e.target.value)}/></Field>
        <Field label="Conta"><input value={f.bank_conta||""} onChange={e=>s("bank_conta",e.target.value)}/></Field>
        <Field label="PIX"><input value={f.bank_pix||""} onChange={e=>s("bank_pix",e.target.value)}/></Field>
      </div>
    </details>
    <div style={{marginTop:12,display:"flex",gap:8}}>
      <button className="btn btn-p" onClick={()=>onSave(f)}>Salvar</button>
      <button className="btn btn-s" onClick={onCancel}>Cancelar</button>
    </div>
  </div>;
}

/* ─── Data Entry ─── */
function DataEntry({pdvs,md,setMd,period,save}) {
  const [tab,setTab]=useState("meters");
  const [paste,setPaste]=useState("");
  const [localMd,setLocalMd]=useState(md);
  const [dirty,setDirty]=useState(0);
  const [saving,setSaving]=useState(false);
  const [lastSave,setLastSave]=useState("");

  // Sync localMd when md changes externally (e.g. period switch)
  useEffect(()=>{setLocalMd(md);setDirty(0);},[md]);

  const needsMeter=ct=>["Medidor","Medidor + Mínimo","Medidor + Percentual de Faturamento",
    "Medidor OU Percentual de Faturamento","Medidor OU Percentual de Faturamento OU Mínimo"].includes(ct);
  const needsRev=ct=>["Percentual do Faturamento","Percentual do Faturamento + Mínimo",
    "Percentual do Faturamento OU Mínimo","Medidor + Percentual de Faturamento",
    "Medidor OU Percentual de Faturamento","Medidor OU Percentual de Faturamento OU Mínimo",
    "Conta de Energia + Percentual do Faturamento"].includes(ct);

  const mPdvs=pdvs.filter(p=>needsMeter(p.contract_type));
  const rPdvs=pdvs.filter(p=>needsRev(p.contract_type));

  // Local edit functions (no save, just state)
  function upd(pid,field,val){
    setLocalMd(o=>({...o,[pid]:{...(o[pid]||{}),[field]:parseFloat(val)||0}}));
    setDirty(d=>d+1);
  }
  function updStr(pid,field,val){
    setLocalMd(o=>({...o,[pid]:{...(o[pid]||{}),[field]:val}}));
    setDirty(d=>d+1);
  }

  // Explicit save to Supabase
  async function saveAll(){
    setSaving(true);
    try{
      setMd(localMd);
      await save(localMd);
      setDirty(0);
      setLastSave(new Date().toLocaleTimeString("pt-BR"));
    }catch(e){alert("Erro ao salvar: "+e.message);}
    setSaving(false);
  }

  function parseBR(s){
    if(!s)return 0;
    const clean=s.toString().trim().replace(/[R$\s]/g,"");
    // Both dot and comma: "15.510,20" → dot=thousands, comma=decimal
    if(clean.includes(".")&&clean.includes(","))return parseFloat(clean.replace(/\./g,"").replace(",","."))||0;
    // Only comma: "15510,20" → comma=decimal
    if(clean.includes(",")&&!clean.includes("."))return parseFloat(clean.replace(",","."))||0;
    // Only dot: check if it's thousands separator (3 digits after each dot)
    if(clean.includes(".")){
      const parts=clean.split(".");
      const allThousands=parts.slice(1).every(p=>p.length===3);
      if(allThousands&&parts.length>1) return parseFloat(clean.replace(/\./g,""))||0;
    }
    return parseFloat(clean)||0;
  }

  function findPdv(name){
    if(!name)return null;
    const n=name.trim().toUpperCase();
    return pdvs.find(p=>p.name?.toUpperCase()===n)
      || pdvs.find(p=>p.name?.toUpperCase().includes(n)||n.includes(p.name?.toUpperCase()))
      || pdvs.find(p=>p.id===name.trim());
  }

  async function importMeters(type){
    const lines=paste.trim().split("\n");
    const u={...localMd};let matched=0,skipped=0;
    lines.forEach(line=>{
      const cols=line.split("\t");
      if(cols.length<2)return;
      let name,val;
      if(cols.length>=3){
        // 3+ cols: Date | Name | Value | Photo (original format)
        const c0=cols[0]?.trim().toLowerCase();
        if(c0.includes("data")||c0.includes("pdv")||c0.includes("hora")||c0==="")return;
        name=cols[1]?.trim();val=parseBR(cols[2]);
        if(!isNaN(parseFloat(name))&&val===0){val=parseBR(name);name=cols[0]?.trim();}
      }else{
        // 2 cols: Name | Value
        const c0=cols[0]?.trim().toLowerCase();
        if(c0.includes("data")||c0.includes("pdv")||c0.includes("hora")||c0.includes("local")||c0==="")return;
        name=cols[0]?.trim();val=parseBR(cols[1]);
      }
      if(!val||val<=0){skipped++;return;}
      const mp=findPdv(name);
      if(mp){u[mp.id]={...(u[mp.id]||{}),[type]:val};matched++;}
      else{skipped++;}
    });
    if(matched===0){alert(`Nenhum PDV encontrado! ${skipped} linhas não combinaram. Verifique se os nomes batem.`);return;}
    setLocalMd(u);setMd(u);setPaste("");setDirty(0);
    try{await save(u);setLastSave(new Date().toLocaleTimeString("pt-BR"));alert(`✓ ${matched} PDVs salvos no banco! (${skipped} ignoradas)`);}
    catch(e){alert(`Importou ${matched} PDVs mas erro ao salvar: ${e.message}`);}
  }

  async function importRevenue(){
    const lines=paste.trim().split("\n");
    const u={...localMd};let matched=0,skipped=0;
    for(let i=0;i<lines.length;i++){
      const cols=lines[i].split("\t");if(cols.length<2)continue;
      const name=cols[0]?.trim();const nl=name?.toLowerCase()||"";
      if(!name||nl.includes("local")||nl.includes("filtro")||nl.includes("período")||nl.includes("periodo")
        ||nl.includes("data")||nl.includes("agrupamento")||nl.includes("emitido")||nl.includes("número")
        ||nl.includes("vendas")||nl.includes("customizado")||nl==="total")continue;
      let rev=0;
      if(cols.length>=4)rev=parseBR(cols[3]);
      if(rev===0){for(let c=1;c<cols.length;c++){const p=parseBR(cols[c]);if(p>rev&&p>10) rev=p;}}
      const mp=findPdv(name);
      if(mp&&rev>0){u[mp.id]={...(u[mp.id]||{}),raw_revenue:rev};matched++;}
      else if(rev>0){skipped++;}
    }
    if(matched===0){alert(`Nenhum PDV encontrado! ${skipped} não combinaram.`);return;}
    setLocalMd(u);setMd(u);setPaste("");setDirty(0);
    try{await save(u);setLastSave(new Date().toLocaleTimeString("pt-BR"));alert(`✓ ${matched} PDVs com faturamento salvos no banco! (${skipped} não encontrados)`);}
    catch(e){alert(`Importou ${matched} PDVs mas erro ao salvar: ${e.message}`);}
  }

  return <div className="fade-in">
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
      <div className="h2">Entrada de dados</div>
      <div style={{display:"flex",gap:10,alignItems:"center"}}>
        {dirty>0&&<span style={{fontSize:11,color:"var(--warn)",fontWeight:600}}>{dirty} alteração(ões) não salvas</span>}
        {dirty>0&&<button className="btn btn-p" onClick={saveAll} disabled={saving}>
          {saving?"Salvando...":"💾 Salvar no banco"}</button>}
        {lastSave&&dirty===0&&<span style={{fontSize:11,color:"#3d7a00",fontWeight:500}}>✓ Salvo às {lastSave}</span>}
        <div style={{fontSize:13,color:"var(--color-text-secondary)"}}>Período: <strong>{period||"Selecione na aba Histórico"}</strong></div>
      </div>
    </div>
    <div className="tabs">
      {[["meters","Medidores ("+mPdvs.length+")"],["revenue","Faturamento ("+rPdvs.length+")"],["adjust","Ajustes"],["energy","Contas energia"]].map(([k,l])=>
        <div key={k} className={`tab ${tab===k?"active":""}`} onClick={()=>setTab(k)}>{l}</div>
      )}
    </div>

    {tab==="meters"&&<div>
      <div className="card" style={{background:"var(--accent-bg)",border:"none"}}>
        <div className="h3">Importar medidores</div>
        <p style={{fontSize:12,color:"var(--color-text-secondary)",marginBottom:6}}>Cole direto da planilha de medidores.</p>
        <textarea value={paste} onChange={e=>setPaste(e.target.value)} placeholder="Cole aqui..."/>
        <div style={{display:"flex",gap:6,marginTop:6}}>
          <button className="btn btn-p" onClick={()=>importMeters("meter_start")}>↑ Importar INÍCIO</button>
          <button className="btn btn-p" onClick={()=>importMeters("meter_end")}>↑ Importar FIM</button>
        </div>
      </div>
      <div className="card"><div className="h3">Leituras</div>
      <div className="scroll-x"><table><thead><tr>
        <th>PDV</th><th>Início</th><th>Fim</th><th>kWh</th><th>Consumo</th><th>Energia</th>
      </tr></thead><tbody>
        {mPdvs.map(p=>{const d=localMd[p.id]||{};const s=d.meter_start||0;const e=d.meter_end||0;
          const c=e-s;const b=c*(p.kwh_unity_price||0);
          return <tr key={p.id}>
            <td className="trunc">{p.name}</td>
            <td><input type="number" style={{width:90}} value={s||""} onChange={ev=>upd(p.id,"meter_start",ev.target.value)}/></td>
            <td><input type="number" style={{width:90}} value={e||""} onChange={ev=>upd(p.id,"meter_end",ev.target.value)}/></td>
            <td className="mono" style={{color:"var(--color-text-secondary)"}}>{p.kwh_unity_price||"-"}</td>
            <td className="mono">{c>0?c:"-"}</td>
            <td className="mono" style={{fontWeight:600}}>{b>0?fmt(b):"-"}</td>
          </tr>;})}
      </tbody></table></div></div>
    </div>}

    {tab==="revenue"&&<div>
      <div className="card" style={{background:"var(--accent-bg)",border:"none"}}>
        <div className="h3">Importar faturamento VMPAY</div>
        <textarea value={paste} onChange={e=>setPaste(e.target.value)} placeholder="Cole aqui..."/>
        <button className="btn btn-p" style={{marginTop:6}} onClick={importRevenue}>↑ Importar</button>
      </div>
      <div className="card"><div className="h3">Faturamento por PDV</div>
      <div className="scroll-x"><table><thead><tr>
        <th>PDV</th><th>Tipo</th><th>Fat. bruto</th><th>Receita calc.</th><th>%</th><th>Valor %</th>
      </tr></thead><tbody>
        {rPdvs.map(p=>{const d=localMd[p.id]||{};const raw=d.raw_revenue||0;
          const cr=raw*(p.revenue_consideration==="Bruto"?1:LIQ);const pv=cr*(p.negotiated_percentage||0);
          return <tr key={p.id}>
            <td className="trunc">{p.name}</td>
            <td><span className={`badge ${p.revenue_consideration==="Bruto"?"badge-warn":"badge-info"}`}>{p.revenue_consideration}</span></td>
            <td><input type="number" style={{width:100}} value={raw||""} onChange={ev=>upd(p.id,"raw_revenue",ev.target.value)}/></td>
            <td className="mono">{raw>0?fmt(cr):"-"}</td>
            <td className="mono">{((p.negotiated_percentage||0)*100).toFixed(1)}%</td>
            <td className="mono" style={{fontWeight:600}}>{pv>0?fmt(pv):"-"}</td>
          </tr>;})}
      </tbody></table></div></div>
    </div>}

    {tab==="adjust"&&<div className="card">
      <div className="h3">Ajustes manuais</div>
      <div className="scroll-x"><table><thead><tr><th>PDV</th><th>Valor</th><th>Descrição</th></tr></thead>
      <tbody>{pdvs.filter(p=>p.contract_type!=="Boleto").map(p=>{const d=localMd[p.id]||{};
        return <tr key={p.id}>
          <td className="trunc">{p.name}</td>
          <td><input type="number" style={{width:90}} value={d.manual_adjustment||""} onChange={e=>upd(p.id,"manual_adjustment",e.target.value)}/></td>
          <td><input style={{width:180}} value={d.manual_adjustment_desc||""} onChange={e=>updStr(p.id,"manual_adjustment_desc",e.target.value)}/></td>
        </tr>;})}</tbody></table></div>
    </div>}

    {tab==="energy"&&<div className="card">
      <div className="h3">Contas de energia (condominial)</div>
      <table><thead><tr><th>PDV</th><th>Valor conta</th></tr></thead>
      <tbody>{pdvs.filter(p=>p.contract_type==="Conta de Energia + Percentual do Faturamento").map(p=>{const d=localMd[p.id]||{};
        return <tr key={p.id}><td>{p.name}</td>
        <td><input type="number" style={{width:120}} value={d.energy_bill_cond||""} onChange={e=>upd(p.id,"energy_bill_cond",e.target.value)}/></td>
        </tr>;})}</tbody></table>
    </div>}
  </div>;
}

/* ─── CalcResults ─── */
function CalcResults({pdvs,md,results,setResults,save,period}) {
  const [filter,setFilter]=useState("");
  const [typeF,setTypeF]=useState("Todos");

  function run(){
    const res=pdvs.filter(p=>p.contract_type!=="Boleto").map(p=>{
      const d=md[p.id]||{};
      const r=calc({...p,manual_adjustment:d.manual_adjustment||p.manual_adjustment||0},
        d.meter_start||0,d.meter_end||0,d.raw_revenue||0,d.energy_bill_cond||0);
      return {...r,id:p.id,uuid:p.uuid,name:p.name,contract_type:p.contract_type,
        revenue_consideration:p.revenue_consideration,payment_day:p.payment_day,
        negotiated_percentage:p.negotiated_percentage};
    });
    setResults(res);save(res);
  }

  const fil=results.filter(r=>{
    const ms=r.name?.toLowerCase().includes(filter.toLowerCase())||r.id?.toString().includes(filter);
    const mt=typeF==="Todos"||r.contract_type===typeF;
    return ms&&mt;
  });
  const tot=fil.reduce((s,r)=>s+(r.total||0),0);

  function exportCSV(){
    const h="ID,Nome,Tipo,Receita,Subtotal,Ajuste,Total,Detalhes\n";
    const rows=results.map(r=>`${r.id},"${r.name}","${r.contract_type}","${r.revenue_consideration}",${r.subtotal?.toFixed(2)},${(r.total-r.subtotal)?.toFixed(2)},${r.total?.toFixed(2)},"${r.details}"`).join("\n");
    const b=new Blob([h+rows],{type:"text/csv;charset=utf-8;"});
    const a=document.createElement("a");a.href=URL.createObjectURL(b);
    a.download=`repasse_${period||"periodo"}.csv`;a.click();
  }

  return <div className="fade-in">
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
      <div className="h2">Calcular repasse</div>
      <div style={{display:"flex",gap:8}}>
        <button className="btn btn-p" onClick={run}>⟳ Calcular tudo</button>
        {results.length>0&&<button className="btn btn-s" onClick={exportCSV}>↓ CSV</button>}
      </div>
    </div>
    {results.length>0?<>
      <div className="stat bdr-l" style={{borderLeftColor:"#00314f",marginBottom:16}}>
        <div className="stat-val">{fmt(tot)}</div>
        <div className="stat-lbl">Total {typeF!=="Todos"?typeF:""} — {fil.length} PDVs</div>
      </div>
      <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap"}}>
        <input style={{width:220}} placeholder="Buscar..." value={filter} onChange={e=>setFilter(e.target.value)}/>
        <select style={{width:260}} value={typeF} onChange={e=>setTypeF(e.target.value)}>
          <option>Todos</option>{CONTRACT_TYPES.filter(t=>t!=="Boleto").map(t=><option key={t}>{t}</option>)}
        </select>
      </div>
      <div className="card" style={{padding:0,overflow:"hidden"}}>
        <div className="scroll-x"><table><thead><tr>
          <th>PDV</th><th>Tipo</th><th>Subtotal</th><th>Ajuste</th><th>Total</th><th>Detalhes</th>
        </tr></thead><tbody>
          {fil.sort((a,b)=>b.total-a.total).map(r=>{const adj=r.total-r.subtotal;
            return <tr key={r.id}>
              <td className="trunc" style={{fontWeight:500}}>{r.name}</td>
              <td><span className="chip">{r.contract_type}</span></td>
              <td className="mono">{fmt(r.subtotal)}</td>
              <td className="mono" style={{color:adj!==0?"var(--warn)":"var(--color-text-tertiary)"}}>{adj!==0?fmt(adj):"-"}</td>
              <td className="mono" style={{fontWeight:700}}>{fmt(r.total)}</td>
              <td style={{fontSize:10,color:"var(--color-text-secondary)",maxWidth:260}}>{r.details}</td>
            </tr>;})}
        </tbody></table></div>
      </div>
    </>:<div className="card empty">
      <div style={{fontSize:28,marginBottom:8}}>⟳</div>
      Clique em "Calcular tudo" para processar<br/>
      <span style={{fontSize:11,color:"var(--color-text-tertiary)"}}>Preencha medidores e faturamento primeiro</span>
    </div>}
  </div>;
}

/* ─── Pendencias ─── */
function Pendencias({pdvs,setPdvs,md,setMd,savePdvs,saveMd,onDirty,userRole,onRequestChange}) {
  const [editMode,setEditMode]=useState(false);
  const [pdvEdits,setPdvEdits]=useState({});
  const [mdEdits,setMdEdits]=useState({});
  const [confirm,setConfirm]=useState(null);
  const [filter,setFilter]=useState("all");

  const changeCount=Object.values(pdvEdits).reduce((s,e)=>s+Object.keys(e).length,0)
    +Object.values(mdEdits).reduce((s,e)=>s+Object.keys(e).length,0);
  useEffect(()=>{if(onDirty)onDirty(editMode?changeCount:0);},[changeCount,editMode]);

  const needsMeter=ct=>["Medidor","Medidor + Mínimo","Medidor + Percentual de Faturamento",
    "Medidor OU Percentual de Faturamento","Medidor OU Percentual de Faturamento OU Mínimo"].includes(ct);
  const needsRev=ct=>["Percentual do Faturamento","Percentual do Faturamento + Mínimo",
    "Percentual do Faturamento OU Mínimo","Medidor + Percentual de Faturamento",
    "Medidor OU Percentual de Faturamento","Medidor OU Percentual de Faturamento OU Mínimo",
    "Conta de Energia + Percentual do Faturamento"].includes(ct);
  const needsMin=ct=>["Fixo","Medidor + Mínimo","Percentual do Faturamento + Mínimo",
    "Percentual do Faturamento OU Mínimo","Medidor OU Percentual de Faturamento OU Mínimo"].includes(ct);
  const needsKwh=ct=>needsMeter(ct);
  const needsPct=ct=>needsRev(ct);

  const issues=[];
  pdvs.forEach(p=>{
    if(p.contract_type==="Boleto") return;
    const d=md[p.id]||{};const pIssues=[];
    if(needsKwh(p.contract_type)&&!p.kwh_unity_price) pIssues.push({cat:"calc",field:"kwh_unity_price",msg:"Preço kWh não definido",isMd:false});
    if(needsPct(p.contract_type)&&!p.negotiated_percentage) pIssues.push({cat:"calc",field:"negotiated_percentage",msg:"Percentual negociado = 0%",isMd:false});
    if(needsMin(p.contract_type)&&!p.minimal_repass&&p.contract_type!=="Percentual do Faturamento OU Mínimo")
      pIssues.push({cat:"calc",field:"minimal_repass",msg:"Valor mínimo não definido",isMd:false});
    if(needsMeter(p.contract_type)){
      if(!d.meter_start) pIssues.push({cat:"meter",field:"meter_start",msg:"Medidor início não informado",isMd:true});
      if(!d.meter_end) pIssues.push({cat:"meter",field:"meter_end",msg:"Medidor fim não informado",isMd:true});
      if(d.meter_start&&d.meter_end&&d.meter_end<=d.meter_start) pIssues.push({cat:"meter",field:"meter_end",msg:"Medidor fim ≤ início",isMd:true});
    }
    if(needsRev(p.contract_type)&&!d.raw_revenue) pIssues.push({cat:"revenue",field:"raw_revenue",msg:"Faturamento não importado",isMd:true});
    if(!p.bank_cnpj) pIssues.push({cat:"bank",field:"bank_cnpj",msg:"CNPJ da conta ausente",isMd:false});
    if(!p.bank_name) pIssues.push({cat:"bank",field:"bank_name",msg:"Nome da conta ausente",isMd:false});
    if(!p.bank_banco&&!p.bank_pix) pIssues.push({cat:"bank",field:"bank_banco",msg:"Sem banco e sem PIX",isMd:false});
    if(!p.bank_agencia&&!p.bank_pix) pIssues.push({cat:"bank",field:"bank_agencia",msg:"Sem agência e sem PIX",isMd:false});
    if(!p.bank_conta&&!p.bank_pix) pIssues.push({cat:"bank",field:"bank_conta",msg:"Sem nº conta e sem PIX",isMd:false});
    if(p.contract_type==="Conta de Energia + Percentual do Faturamento"&&!d.energy_bill_cond)
      pIssues.push({cat:"calc",field:"energy_bill_cond",msg:"Conta de energia não informada",isMd:true});
    if(pIssues.length>0) issues.push({pdv:p,data:d,issues:pIssues});
  });

  const cats={calc:"Cálculo",meter:"Medidores",revenue:"Faturamento",bank:"Dados bancários"};
  const catColors={calc:"danger",meter:"warning",revenue:"info",bank:"warning"};
  const catCounts={};
  issues.forEach(i=>i.issues.forEach(is=>{catCounts[is.cat]=(catCounts[is.cat]||0)+1;}));
  const filtered=filter==="all"?issues:issues.filter(i=>i.issues.some(is=>is.cat===filter));
  const totalIssues=issues.reduce((s,i)=>s+i.issues.length,0);

  function getVal(pid,field,isMd){
    if(isMd&&mdEdits[pid]?.[field]!==undefined) return mdEdits[pid][field];
    if(!isMd&&pdvEdits[pid]?.[field]!==undefined) return pdvEdits[pid][field];
    if(isMd) return (md[pid]||{})[field]||"";
    const p=pdvs.find(x=>x.id===pid);return p?p[field]||"":"";
  }
  function setVal(pid,field,val,isMd){
    if(isMd) setMdEdits(o=>({...o,[pid]:{...(o[pid]||{}),[field]:parseFloat(val)||0}}));
    else setPdvEdits(o=>({...o,[pid]:{...(o[pid]||{}),[field]:val}}));
  }

  const isUsuario=userRole?.role==="usuario";

  function requestSave(){
    const changes=[];
    const changeReqs=[];
    Object.entries(pdvEdits).forEach(([pid,fields])=>{
      const p=pdvs.find(x=>x.id===pid);if(!p)return;
      Object.entries(fields).forEach(([k,v])=>{
        if(String(v)!==String(p[k]||"")){
          changes.push(`${p.name}: ${k}: ${p[k]||"(vazio)"} → ${v}`);
          changeReqs.push({tipo:"pdv_edit",pdv_vmpay_id:p.id,pdv_nome:p.name,campo:k,
            valor_atual:String(p[k]||""),valor_novo:String(v),
            requester_email:userRole?.email||"",requester_nome:userRole?.nome||"",
            requester_id:userRole?.user_id||null});
        }
      });
    });
    Object.entries(mdEdits).forEach(([pid,fields])=>{
      const p=pdvs.find(x=>x.id===pid);if(!p)return;const old=md[pid]||{};
      Object.entries(fields).forEach(([k,v])=>{
        if(v!==(old[k]||0)){
          changes.push(`${p.name}: ${k}: ${old[k]||0} → ${v}`);
          changeReqs.push({tipo:"md_edit",pdv_vmpay_id:p.id,pdv_nome:p.name,campo:k,
            valor_atual:String(old[k]||0),valor_novo:String(v),
            requester_email:userRole?.email||"",requester_nome:userRole?.nome||"",
            requester_id:userRole?.user_id||null});
        }
      });
    });
    if(changes.length===0){setEditMode(false);setPdvEdits({});setMdEdits({});return;}

    if(isUsuario&&onRequestChange){
      setConfirm({msg:`Enviar ${changeReqs.length} solicitação(ões) de alteração?`,detail:changes.join("\n"),
        onConfirm:async()=>{
          try{for(const r of changeReqs) await onRequestChange(r);
            alert("Solicitações enviadas! Aguarde aprovação do administrador.");
          }catch(e){alert("Erro: "+e.message);}
          setConfirm(null);setEditMode(false);setPdvEdits({});setMdEdits({});
        }
      });
    }else{
      setConfirm({msg:`${changes.length} PDV(s) serão alterados:`,detail:changes.join("\n"),
        onConfirm:()=>{
          if(Object.keys(pdvEdits).length){const np=pdvs.map(p=>pdvEdits[p.id]?{...p,...pdvEdits[p.id]}:p);setPdvs(np);savePdvs(np);}
          if(Object.keys(mdEdits).length){const nm={...md};Object.entries(mdEdits).forEach(([pid,d])=>{nm[pid]={...(nm[pid]||{}),...d};});setMd(nm);saveMd(nm);}
          setConfirm(null);setEditMode(false);setPdvEdits({});setMdEdits({});
        }
      });
    }
  }

  const eStyle={padding:"3px 6px",fontSize:12,borderRadius:5,border:"1.5px solid var(--accent)",background:"#fffbe6"};

  return <div className="fade-in">
    {confirm&&<ConfirmModal msg={confirm.msg} detail={confirm.detail} onConfirm={confirm.onConfirm} onCancel={()=>setConfirm(null)}/>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
      <div className="h2">Pendências</div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {editMode&&changeCount>0&&<span style={{fontSize:11,color:"var(--warn)",fontWeight:600}}>{changeCount} alteração(ões)</span>}
        {editMode?<>
          <button className="btn btn-p" onClick={requestSave}>{isUsuario?"📩 Enviar solicitação":"✓ Salvar na base"}</button>
          <button className="btn btn-s" onClick={()=>{setEditMode(false);setPdvEdits({});setMdEdits({});}}>✕ Cancelar</button>
        </>:<button className="btn btn-s" onClick={()=>setEditMode(true)} style={{border:"1.5px dashed var(--accent)",color:"var(--accent)"}}>{isUsuario?"📩 Solicitar alteração":"✎ Corrigir pendências"}</button>}
      </div>
    </div>
    {totalIssues===0?<div className="card" style={{textAlign:"center",padding:40}}>
      <div style={{fontSize:32,marginBottom:8}}>✓</div>
      <div style={{fontSize:16,fontWeight:600}}>Nenhuma pendência encontrada!</div>
    </div>:<>
      <div className="grid4" style={{marginBottom:20}}>
        <div className="stat bdr-l" style={{borderLeftColor:"#f2401a",cursor:"pointer",outline:filter==="all"?"2px solid #f2401a":"none",borderRadius:10}} onClick={()=>setFilter("all")}>
          <div className="stat-val" style={{color:"var(--red)"}}>{totalIssues}</div><div className="stat-lbl">Total pendências</div></div>
        {Object.entries(cats).map(([key,label])=>{const c=catCounts[key]||0;if(!c)return null;
          const colors={calc:"#f2401a",meter:"#ff8b00",revenue:"#00314f",bank:"#ff8b00"};
          return <div key={key} className="stat bdr-l" style={{borderLeftColor:colors[key],cursor:"pointer",
            outline:filter===key?`2px solid ${colors[key]}`:"none",borderRadius:10}} onClick={()=>setFilter(filter===key?"all":key)}>
            <div className="stat-val" style={{color:colors[key]}}>{c}</div><div className="stat-lbl">{label}</div></div>;})}
      </div>
      {editMode&&<div style={{padding:"8px 14px",borderRadius:8,background:"#fffbe6",color:"#92400e",fontSize:12,fontWeight:600,marginBottom:16}}>MODO CORREÇÃO — edite os campos amarelos</div>}
      <div className="card" style={{padding:0,overflow:"hidden"}}><div className="scroll-x"><table>
        <thead><tr><th>PDV</th><th>Tipo contrato</th><th>Pendência</th><th>Campo</th><th>Valor atual</th>{editMode&&<th style={{background:"#fffbe6"}}>Novo valor ✎</th>}</tr></thead>
        <tbody>{filtered.map(({pdv:p,issues:pIssues})=>
          pIssues.filter(is=>filter==="all"||is.cat===filter).map((is,j)=>
            <tr key={`${p.id}-${is.field}-${j}`}>
              {j===0?<td rowSpan={pIssues.filter(x=>filter==="all"||x.cat===filter).length} style={{fontWeight:500,verticalAlign:"top",borderRight:"1px solid var(--color-border-tertiary)"}}>{p.name}<br/><span className="mono" style={{fontSize:10,color:"var(--color-text-tertiary)"}}>ID: {p.id}</span></td>:null}
              {j===0?<td rowSpan={pIssues.filter(x=>filter==="all"||x.cat===filter).length} style={{verticalAlign:"top"}}><span className="chip">{p.contract_type}</span></td>:null}
              <td><span className={`badge badge-${catColors[is.cat]}`}>{cats[is.cat]}</span><span style={{marginLeft:6,fontSize:12}}>{is.msg}</span></td>
              <td className="mono" style={{fontSize:11}}>{is.field}</td>
              <td className="mono" style={{fontSize:12,color:!getVal(p.id,is.field,is.isMd)?"var(--red)":"inherit"}}>{getVal(p.id,is.field,is.isMd)||"(vazio)"}</td>
              {editMode&&<td><input style={{...eStyle,width:is.field.includes("name")?160:is.field.includes("cnpj")?140:100}}
                type={is.isMd||["kwh_unity_price","negotiated_percentage","minimal_repass"].includes(is.field)?"number":"text"}
                value={is.isMd?(mdEdits[p.id]?.[is.field]??""):(pdvEdits[p.id]?.[is.field]??getVal(p.id,is.field,false))}
                onChange={e=>setVal(p.id,is.field,e.target.value,is.isMd)}/></td>}
            </tr>
          )
        )}</tbody></table></div></div>
      <div style={{marginTop:12,fontSize:12,color:"var(--color-text-tertiary)"}}>{filtered.length} PDVs com pendências</div>
    </>}
  </div>;
}

/* ─── Financeiro ─── */
function Financeiro({pdvs,setPdvs,results,period,savePdvs,onDirty}) {
  const [dayFilter,setDayFilter]=useState("all");
  const [search,setSearch]=useState("");
  const [editMode,setEditMode]=useState(false);
  const [edits,setEdits]=useState({});
  const [confirm,setConfirm]=useState(null);

  const bankFields=[{key:"payment_day",label:"Dia pgto",w:50},{key:"bank_cnpj_cond",label:"CNPJ cond.",w:130},
    {key:"bank_cnpj",label:"CNPJ conta",w:130},{key:"bank_name",label:"Nome conta",w:160},
    {key:"bank_banco",label:"Banco",w:100},{key:"bank_agencia",label:"Agência",w:70},
    {key:"bank_conta",label:"Nº conta",w:90},{key:"bank_pix",label:"PIX",w:130}];

  function getVal(pid,field){if(edits[pid]&&edits[pid][field]!==undefined) return edits[pid][field];const p=pdvs.find(x=>x.id===pid);return p?p[field]||"":"";}
  function setVal(pid,field,val){setEdits(o=>({...o,[pid]:{...(o[pid]||{}),[field]:field==="payment_day"?parseInt(val)||20:val}}));}
  const changeCount=Object.values(edits).reduce((s,e)=>s+Object.keys(e).length,0);
  useEffect(()=>{if(onDirty)onDirty(editMode?changeCount:0);},[changeCount,editMode]);

  const rows=results.map(r=>{const p=pdvs.find(x=>x.id===r.id);if(!p)return null;
    const pd=editMode?(parseInt(getVal(p.id,"payment_day"))||20):(p.payment_day||20);
    return {id:p.id,name:r.name,payment_day:pd,total:r.total,
      cnpj_cond:getVal(p.id,"bank_cnpj_cond"),cnpj:getVal(p.id,"bank_cnpj"),
      bank_name:getVal(p.id,"bank_name"),banco:getVal(p.id,"bank_banco"),
      agencia:getVal(p.id,"bank_agencia"),conta:getVal(p.id,"bank_conta"),pix:getVal(p.id,"bank_pix")};
  }).filter(Boolean);

  const filtered=rows.filter(r=>{
    const matchDay=dayFilter==="all"||(dayFilter==="20"&&r.payment_day===20)||(dayFilter==="3"&&r.payment_day===3);
    return matchDay&&(!search||r.name.toLowerCase().includes(search.toLowerCase())||r.id.includes(search));
  }).sort((a,b)=>a.name.localeCompare(b.name));

  const total=filtered.reduce((s,r)=>s+r.total,0);
  const count20=rows.filter(r=>r.payment_day===20).length;const count3=rows.filter(r=>r.payment_day===3).length;
  const total20=rows.filter(r=>r.payment_day===20).reduce((s,r)=>s+r.total,0);
  const total3=rows.filter(r=>r.payment_day===3).reduce((s,r)=>s+r.total,0);

  function requestSave(){
    const changes=[];
    Object.entries(edits).forEach(([pid,fields])=>{const p=pdvs.find(x=>x.id===pid);if(!p)return;
      const diffs=[];Object.entries(fields).forEach(([k,v])=>{const old=p[k]||"";
        if(String(v)!==String(old))diffs.push(`${bankFields.find(f=>f.key===k)?.label||k}: ${old||"(vazio)"} → ${v}`);});
      if(diffs.length>0)changes.push(`${p.name}:\n  ${diffs.join("\n  ")}`);});
    if(changes.length===0){setEditMode(false);setEdits({});return;}
    setConfirm({msg:`${changes.length} PDV(s) terão dados bancários alterados:`,detail:changes.join("\n\n"),
      onConfirm:()=>{const newPdvs=pdvs.map(p=>{const e=edits[p.id];return e?{...p,...e}:p;});
        setPdvs(newPdvs);savePdvs(newPdvs);setConfirm(null);setEditMode(false);setEdits({});}});
  }

  function exportCSV(){
    const dayLabel=dayFilter==="all"?"todos":("dia_"+dayFilter);
    const h="Id do Local;Local;Data de Pagamento;CNPJ CONDOMINIO;CNPJ da Conta;Nome da Conta;Banco;Agência;Número da Conta;Chave Pix;Total\n";
    const rws=filtered.map(r=>`${r.id};"${r.name}";${r.payment_day};"${r.cnpj_cond}";"${r.cnpj}";"${r.bank_name}";"${r.banco}";"${r.agencia}";"${r.conta}";"${r.pix}";${r.total.toFixed(2).replace(".",",")}`).join("\n");
    const blob=new Blob(["\uFEFF"+h+rws],{type:"text/csv;charset=utf-8;"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);
    a.download=`report_financeiro_${dayLabel}_${period||"periodo"}.csv`;a.click();
  }

  const editSt={width:80,padding:"3px 6px",fontSize:11,borderRadius:5,border:"1.5px solid var(--accent)",background:"#fffbe6"};

  return <div className="fade-in">
    {confirm&&<ConfirmModal msg={confirm.msg} detail={confirm.detail} onConfirm={confirm.onConfirm} onCancel={()=>setConfirm(null)}/>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
      <div className="h2">Relatório financeiro</div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {editMode&&changeCount>0&&<span style={{fontSize:11,color:"var(--warn)",fontWeight:600}}>{changeCount} alteração(ões)</span>}
        {editMode?<>
          <button className="btn btn-p" onClick={requestSave}>✓ Salvar na base</button>
          <button className="btn btn-s" onClick={()=>{setEditMode(false);setEdits({});}}>✕ Cancelar</button>
        </>:<>{filtered.length>0&&<button className="btn btn-p" onClick={exportCSV}>↓ Exportar CSV</button>}
          {filtered.length>0&&<button className="btn btn-s" onClick={()=>setEditMode(true)} style={{border:"1.5px dashed var(--accent)",color:"var(--accent)"}}>✎ Editar dados</button>}</>}
      </div>
    </div>
    <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:20}}>Período: <strong>{period||"Não definido"}</strong></div>

    {results.length===0?<div className="card empty"><div style={{fontSize:28,marginBottom:8}}>⚠</div>Execute o cálculo primeiro na aba "Calcular"</div>:<>
      <div className="grid3" style={{marginBottom:20}}>
        <div className="stat bdr-l" style={{borderLeftColor:"#00314f",cursor:"pointer",outline:dayFilter==="20"?"2px solid var(--accent)":"none",borderRadius:10}} onClick={()=>setDayFilter(dayFilter==="20"?"all":"20")}>
          <div style={{fontSize:11,fontWeight:600,color:"var(--color-text-secondary)",marginBottom:4}}>DIA 20 — mês vigente</div>
          <div className="stat-val">{fmt(total20)}</div><div className="stat-lbl">{count20} PDVs</div></div>
        <div className="stat bdr-l" style={{borderLeftColor:"#ff8b00",cursor:"pointer",outline:dayFilter==="3"?"2px solid var(--warn)":"none",borderRadius:10}} onClick={()=>setDayFilter(dayFilter==="3"?"all":"3")}>
          <div style={{fontSize:11,fontWeight:600,color:"var(--color-text-secondary)",marginBottom:4}}>DIA 3 — mês seguinte</div>
          <div className="stat-val">{fmt(total3)}</div><div className="stat-lbl">{count3} PDVs</div></div>
        <div className="stat bdr-l" style={{borderLeftColor:"#9bf400",cursor:"pointer",outline:dayFilter==="all"?"2px solid #9bf400":"none",borderRadius:10}} onClick={()=>setDayFilter("all")}>
          <div style={{fontSize:11,fontWeight:600,color:"var(--color-text-secondary)",marginBottom:4}}>TOTAL</div>
          <div className="stat-val">{fmt(total20+total3)}</div><div className="stat-lbl">{count20+count3} PDVs</div></div>
      </div>
      <div style={{display:"flex",gap:10,marginBottom:16}}><input style={{width:240}} placeholder="Buscar PDV..." value={search} onChange={e=>setSearch(e.target.value)}/></div>
      <div className="card" style={{padding:0,overflow:"hidden"}}><div className="scroll-x"><table>
        <thead><tr><th>Id</th><th>Local</th>
          {bankFields.map(f=><th key={f.key} style={editMode?{background:"#fffbe6"}:{}}>{f.label}{editMode&&" ✎"}</th>)}
          <th style={{background:"var(--accent-bg)"}}>Total</th></tr></thead>
        <tbody>{filtered.map(r=><tr key={r.id}>
          <td className="mono" style={{fontSize:11}}>{r.id}</td>
          <td style={{fontWeight:500,whiteSpace:"nowrap"}}>{r.name}</td>
          {editMode?bankFields.map(f=><td key={f.key}><input style={{...editSt,width:f.w}} value={getVal(r.id,f.key)} onChange={e=>setVal(r.id,f.key,e.target.value)}/></td>)
            :<><td style={{textAlign:"center"}}><span className={`badge ${r.payment_day===3?"badge-warn":"badge-info"}`}>Dia {r.payment_day}</span></td>
            <td className="mono" style={{fontSize:11}}>{r.cnpj_cond||"-"}</td>
            <td className="mono" style={{fontSize:11}}>{r.cnpj||"-"}</td>
            <td style={{fontSize:11,maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.bank_name||"-"}</td>
            <td style={{fontSize:11}}>{r.banco||"-"}</td>
            <td className="mono" style={{fontSize:11}}>{r.agencia||"-"}</td>
            <td className="mono" style={{fontSize:11}}>{r.conta||"-"}</td>
            <td className="mono" style={{fontSize:11,maxWidth:140,overflow:"hidden",textOverflow:"ellipsis"}}>{r.pix||"-"}</td></>}
          <td className="mono" style={{fontWeight:700,background:"var(--accent-bg)",color:"var(--accent)"}}>{fmt(r.total)}</td>
        </tr>)}
        <tr style={{fontWeight:700,borderTop:"2px solid var(--color-border-secondary)"}}>
          <td colSpan={2+bankFields.length} style={{textAlign:"right",paddingRight:12}}>TOTAL ({filtered.length} PDVs)</td>
          <td className="mono" style={{background:"var(--accent-bg)",color:"var(--accent)",fontSize:14}}>{fmt(total)}</td></tr>
        </tbody></table></div></div>
    </>}
  </div>;
}

/* ─── Demonstrativo ─── */
function Demonstrativo({pdvs,setPdvs,md,setMd,period,savePdvs,saveMd,onDirty,userRole,onRequestChange}) {
  const [selType,setSelType]=useState(CONTRACT_TYPES[0]);
  const [editMode,setEditMode]=useState(false);
  const [localMd,setLocalMd]=useState({});
  const [localPdvEdits,setLocalPdvEdits]=useState({});
  const [confirm,setConfirm]=useState(null);
  const [changeCount,setChangeCount]=useState(0);
  useEffect(()=>{if(onDirty)onDirty(editMode?changeCount:0);},[changeCount,editMode]);

  const typePdvs=pdvs.filter(p=>p.contract_type===selType);
  const counts={};CONTRACT_TYPES.filter(t=>t!=="Boleto").forEach(t=>{counts[t]=pdvs.filter(p=>p.contract_type===t).length;});

  useEffect(()=>{const lm={};typePdvs.forEach(p=>{lm[p.id]={...(md[p.id]||{})}});
    setLocalMd(lm);setLocalPdvEdits({});setChangeCount(0);},[selType,editMode]);

  const needsMeter=ct=>["Medidor","Medidor + Mínimo","Medidor + Percentual de Faturamento","Medidor OU Percentual de Faturamento","Medidor OU Percentual de Faturamento OU Mínimo"].includes(ct);
  const needsRev=ct=>["Percentual do Faturamento","Percentual do Faturamento + Mínimo","Percentual do Faturamento OU Mínimo","Medidor + Percentual de Faturamento","Medidor OU Percentual de Faturamento","Medidor OU Percentual de Faturamento OU Mínimo","Conta de Energia + Percentual do Faturamento"].includes(ct);
  const needsMin=ct=>["Fixo","Medidor + Mínimo","Percentual do Faturamento + Mínimo","Percentual do Faturamento OU Mínimo","Medidor OU Percentual de Faturamento OU Mínimo"].includes(ct);
  const hasMeter=needsMeter(selType),hasRev=needsRev(selType),hasMin=needsMin(selType),hasOU=selType.includes(" OU "),isEnergyConta=selType==="Conta de Energia + Percentual do Faturamento";

  function editMd(pid,field,val){setLocalMd(o=>({...o,[pid]:{...(o[pid]||{}),[field]:parseFloat(val)||0}}));setChangeCount(c=>c+1);}
  function editPdvField(pid,field,val){setLocalPdvEdits(o=>({...o,[pid]:{...(o[pid]||{}),[field]:parseFloat(val)||0}}));setChangeCount(c=>c+1);}
  function getPdv(p){return {...p,...(localPdvEdits[p.id]||{})};}

  const isUsuario=userRole?.role==="usuario";

  function requestSave(){
    const changes=[];const changeReqs=[];
    typePdvs.forEach(p=>{const origMd=md[p.id]||{},newMd=localMd[p.id]||{},pe=localPdvEdits[p.id]||{};
      const mdFields=[["meter_start","Med.início"],["meter_end","Med.fim"],["raw_revenue","Fat"],["manual_adjustment","Ajuste"],["energy_bill_cond","Conta"]];
      mdFields.forEach(([k,label])=>{
        if((newMd[k]||0)!==(origMd[k]||0)){
          changes.push(`${p.name}: ${label}: ${origMd[k]||0} → ${newMd[k]||0}`);
          changeReqs.push({tipo:"md_edit",pdv_vmpay_id:p.id,pdv_nome:p.name,campo:k,
            valor_atual:String(origMd[k]||0),valor_novo:String(newMd[k]||0),
            requester_email:userRole?.email||"",requester_nome:userRole?.nome||"",requester_id:userRole?.user_id||null});
        }
      });
      Object.entries(pe).forEach(([k,v])=>{if(v!==p[k]){
        changes.push(`${p.name}: ${k}: ${p[k]} → ${v} (base)`);
        changeReqs.push({tipo:"pdv_edit",pdv_vmpay_id:p.id,pdv_nome:p.name,campo:k,
          valor_atual:String(p[k]||""),valor_novo:String(v),
          requester_email:userRole?.email||"",requester_nome:userRole?.nome||"",requester_id:userRole?.user_id||null});
      }});
    });
    if(changes.length===0){setEditMode(false);return;}

    if(isUsuario&&onRequestChange){
      setConfirm({msg:`Enviar ${changeReqs.length} solicitação(ões)?`,detail:changes.join("\n"),onConfirm:async()=>{
        try{for(const r of changeReqs) await onRequestChange(r);
          alert("Solicitações enviadas! Aguarde aprovação do administrador.");
        }catch(e){alert("Erro: "+e.message);}
        setConfirm(null);setEditMode(false);setChangeCount(0);}});
    }else{
      setConfirm({msg:`${changes.length} PDV(s) serão alterados:`,detail:changes.join("\n"),onConfirm:()=>{
        const newMdAll={...md};Object.entries(localMd).forEach(([pid,data])=>{newMdAll[pid]={...(newMdAll[pid]||{}),...data};});setMd(newMdAll);saveMd(newMdAll);
        if(Object.keys(localPdvEdits).length>0){const np=pdvs.map(p=>{const e=localPdvEdits[p.id];return e?{...p,...e}:p;});setPdvs(np);savePdvs(np);}
        setConfirm(null);setEditMode(false);setChangeCount(0);}});
    }
  }

  const rows=typePdvs.map(p=>{const ep=editMode?getPdv(p):p;const d=editMode?(localMd[p.id]||{}):(md[p.id]||{});
    const ms=d.meter_start||0,me=d.meter_end||0,raw=d.raw_revenue||0,kwh=ep.kwh_unity_price||0,pct=ep.negotiated_percentage||0,mn=ep.minimal_repass||0,adj=d.manual_adjustment||ep.manual_adjustment||0;
    const rf=ep.revenue_consideration==="Bruto"?1.0:LIQ,eb=(me-ms)*kwh,cr=raw*rf,pr=cr*pct,eBillCond=d.energy_bill_cond||0;
    let sub=0;
    switch(selType){case"Fixo":sub=mn;break;case"Medidor":sub=eb;break;case"Percentual do Faturamento":sub=pr;break;
      case"Medidor + Mínimo":sub=eb+mn;break;case"Medidor + Percentual de Faturamento":sub=eb+pr;break;
      case"Percentual do Faturamento + Mínimo":sub=pr+mn;break;case"Percentual do Faturamento OU Mínimo":sub=Math.max(pr,mn);break;
      case"Medidor OU Percentual de Faturamento":sub=Math.max(eb,pr);break;case"Medidor OU Percentual de Faturamento OU Mínimo":sub=Math.max(eb,pr,mn);break;
      case"Conta de Energia + Percentual do Faturamento":sub=pr+eBillCond;break;default:sub=0;}
    let winner="";if(hasOU){const vals=[];if(hasMeter)vals.push({name:"Energia",val:eb});if(hasRev)vals.push({name:"%Fat",val:pr});if(hasMin)vals.push({name:"Mínimo",val:mn});
      const maxVal=Math.max(...vals.map(v=>v.val));winner=vals.find(v=>v.val===maxVal)?.name||"";}
    return {p:ep,pid:p.id,ms,me,eb,raw,cr,pr,mn,adj,sub,total:sub+adj,kwh,pct,rf,eBillCond,winner,revType:ep.revenue_consideration};
  });
  const totalRepasse=rows.reduce((s,r)=>s+r.total,0),totalSub=rows.reduce((s,r)=>s+r.sub,0);

  const editSt2={padding:"3px 6px",fontSize:12,borderRadius:5,border:"1.5px solid var(--accent)",background:"#fffbe6"};
  function ec(pid,field,val,isMd,w){
    if(!editMode) return typeof val==="number"?(val>0||val<0?fmt(val):"-"):val;
    return <input type="number" style={{...editSt2,width:w||80}}
      value={isMd?(localMd[pid]?.[field]??""):(localPdvEdits[pid]?.[field]??val)}
      onChange={e=>isMd?editMd(pid,field,e.target.value):editPdvField(pid,field,e.target.value)}/>;
  }

  return <div className="fade-in">
    {confirm&&<ConfirmModal msg={confirm.msg} detail={confirm.detail} onConfirm={confirm.onConfirm} onCancel={()=>setConfirm(null)}/>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
      <div className="h2">Demonstrativo por tipo</div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {editMode&&changeCount>0&&<span style={{fontSize:11,color:"var(--warn)",fontWeight:600}}>{changeCount} alteração(ões)</span>}
        {editMode?<><button className="btn btn-p" onClick={requestSave}>{isUsuario?"📩 Enviar solicitação":"✓ Salvar"}</button>
          <button className="btn btn-s" onClick={()=>{setEditMode(false);setChangeCount(0);}}>✕ Cancelar</button></>
          :<button className="btn btn-s" onClick={()=>setEditMode(true)} style={{border:"1.5px dashed var(--accent)",color:"var(--accent)"}}>{isUsuario?"📩 Solicitar alteração":"✎ Editar valores"}</button>}
      </div>
    </div>
    <div style={{fontSize:13,color:"var(--color-text-secondary)",marginBottom:16}}>Período: <strong>{period||"—"}</strong></div>
    <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:20}}>
      {CONTRACT_TYPES.filter(t=>t!=="Boleto").map(t=>
        <div key={t} onClick={()=>{if(!editMode||changeCount===0)setSelType(t);}}
          style={{padding:"6px 12px",borderRadius:8,cursor:editMode&&changeCount>0?"not-allowed":"pointer",fontSize:12,
            fontWeight:selType===t?700:400,opacity:editMode&&changeCount>0&&selType!==t?0.4:1,
            background:selType===t?"var(--accent)":"var(--color-background-secondary)",
            color:selType===t?"#fff":"var(--color-text-secondary)",border:selType===t?"none":"1px solid var(--color-border-tertiary)"}}>
          {t} <span style={{opacity:0.7}}>({counts[t]||0})</span></div>)}
    </div>
    <div className="card" style={{display:"flex",gap:20,alignItems:"center",padding:14,flexWrap:"wrap"}}>
      <div><span className="stat-lbl">Tipo</span><div style={{fontWeight:700,fontSize:14}}>{selType}</div></div>
      <div style={{borderLeft:"1px solid var(--color-border-tertiary)",height:36}}/>
      <div><span className="stat-lbl">PDVs</span><div style={{fontWeight:700,fontSize:14}}>{typePdvs.length}</div></div>
      <div style={{borderLeft:"1px solid var(--color-border-tertiary)",height:36}}/>
      <div><span className="stat-lbl">Total repasse</span><div className="mono" style={{fontWeight:700,fontSize:16,color:"var(--accent)"}}>{fmt(totalRepasse)}</div></div>
    </div>
    {typePdvs.length>0?<div className="card" style={{padding:0,overflow:"hidden"}}><div className="scroll-x"><table>
      <thead><tr><th>ID</th><th>Nome do PDV</th>
        {hasMin&&<th style={editMode?{background:"#fffbe6"}:{}}>Mínimo{editMode&&" ✎"}</th>}
        {hasMeter&&<><th style={editMode?{background:"#fffbe6"}:{}}>Med. início{editMode&&" ✎"}</th><th style={editMode?{background:"#fffbe6"}:{}}>Med. fim{editMode&&" ✎"}</th>
          <th style={editMode?{background:"#fffbe6"}:{}}>kWh{editMode&&" ✎"}</th><th>Energia</th></>}
        {hasRev&&<><th style={editMode?{background:"#fffbe6"}:{}}>Fat. bruto{editMode&&" ✎"}</th><th>Tipo rec.</th><th>Fat. cálculo</th>
          <th style={editMode?{background:"#fffbe6"}:{}}>%{editMode&&" ✎"}</th><th>Valor %</th></>}
        {isEnergyConta&&<th style={editMode?{background:"#fffbe6"}:{}}>Conta energ.{editMode&&" ✎"}</th>}
        {hasOU&&<th>Vencedor</th>}
        <th>Subtotal</th><th style={editMode?{background:"#fffbe6"}:{}}>Ajuste{editMode&&" ✎"}</th>
        <th style={{background:"var(--accent-bg)"}}>Total</th></tr></thead>
      <tbody>{rows.map(r=><tr key={r.pid}>
        <td className="mono" style={{fontSize:11}}>{r.pid}</td>
        <td className="trunc" style={{fontWeight:500,minWidth:180}}>{r.p.name}</td>
        {hasMin&&<td className="mono">{editMode?ec(r.pid,"minimal_repass",r.mn,false,80):fmt(r.mn)}</td>}
        {hasMeter&&<><td className="mono">{editMode?ec(r.pid,"meter_start",r.ms,true,80):(r.ms||"-")}</td>
          <td className="mono">{editMode?ec(r.pid,"meter_end",r.me,true,80):(r.me||"-")}</td>
          <td className="mono">{editMode?ec(r.pid,"kwh_unity_price",r.kwh,false,60):r.kwh}</td>
          <td className="mono" style={{fontWeight:600,color:r.eb>0?"inherit":"var(--color-text-tertiary)"}}>{r.eb>0?fmt(r.eb):"-"}</td></>}
        {hasRev&&<><td className="mono">{editMode?ec(r.pid,"raw_revenue",r.raw,true,90):(r.raw>0?fmt(r.raw):"-")}</td>
          <td><span className={`badge ${r.revType==="Bruto"?"badge-warn":"badge-info"}`}>{r.revType}</span></td>
          <td className="mono">{r.cr>0?fmt(r.cr):"-"}</td>
          <td className="mono">{editMode?ec(r.pid,"negotiated_percentage",r.pct,false,60):`${(r.pct*100).toFixed(1)}%`}</td>
          <td className="mono" style={{fontWeight:600,color:r.pr>0?"inherit":"var(--color-text-tertiary)"}}>{r.pr>0?fmt(r.pr):"-"}</td></>}
        {isEnergyConta&&<td className="mono">{editMode?ec(r.pid,"energy_bill_cond",r.eBillCond,true,90):(r.eBillCond>0?fmt(r.eBillCond):"-")}</td>}
        {hasOU&&<td><span className={`badge ${r.winner==="Energia"?"badge-warn":r.winner==="%Fat"?"badge-info":"badge-ok"}`}>{r.winner}</span></td>}
        <td className="mono" style={{fontWeight:600}}>{fmt(r.sub)}</td>
        <td className="mono">{editMode?ec(r.pid,"manual_adjustment",r.adj,true,80):<span style={{color:r.adj!==0?"var(--warn)":"var(--color-text-tertiary)"}}>{r.adj!==0?fmt(r.adj):"-"}</span>}</td>
        <td className="mono" style={{fontWeight:700,background:"var(--accent-bg)",color:"var(--accent)"}}>{fmt(r.total)}</td>
      </tr>)}
      <tr style={{fontWeight:700,borderTop:"2px solid var(--color-border-secondary)"}}>
        <td colSpan={2} style={{textAlign:"right",paddingRight:12}}>TOTAL</td>
        {hasMin&&<td className="mono">{fmt(rows.reduce((s,r)=>s+r.mn,0))}</td>}
        {hasMeter&&<><td colSpan={3}/><td className="mono">{fmt(rows.reduce((s,r)=>s+r.eb,0))}</td></>}
        {hasRev&&<><td className="mono">{fmt(rows.reduce((s,r)=>s+r.raw,0))}</td><td/><td className="mono">{fmt(rows.reduce((s,r)=>s+r.cr,0))}</td><td/><td className="mono">{fmt(rows.reduce((s,r)=>s+r.pr,0))}</td></>}
        {isEnergyConta&&<td className="mono">{fmt(rows.reduce((s,r)=>s+r.eBillCond,0))}</td>}
        {hasOU&&<td/>}
        <td className="mono">{fmt(totalSub)}</td>
        <td className="mono" style={{color:"var(--warn)"}}>{fmt(rows.reduce((s,r)=>s+r.adj,0))}</td>
        <td className="mono" style={{background:"var(--accent-bg)",color:"var(--accent)",fontSize:14}}>{fmt(totalRepasse)}</td>
      </tr></tbody></table></div></div>:<div className="card empty">Nenhum PDV com este tipo de contrato</div>}
  </div>;
}

/* ─── Histórico de Períodos ─── */
function Historico({periods,activePeriod,onSelectPeriod,onCreatePeriod,onUpdatePeriod,userRole}) {
  const canManage=userRole?.role==="master"||userRole?.role==="admin";
  const [showNew,setShowNew]=useState(false);
  const [newNome,setNewNome]=useState("");
  const [newMes,setNewMes]=useState(new Date().getMonth()+1);
  const [newAno,setNewAno]=useState(new Date().getFullYear());
  const [confirm,setConfirm]=useState(null);

  const meses=["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  useEffect(()=>{setNewNome(`${meses[newMes-1]} ${newAno}`);},[newMes,newAno]);

  function statusBadge(s){return s==="entregue"?<span className="badge badge-ok">Entregue</span>:<span className="badge badge-warn">Pendente</span>;}
  function statusPeriodo(p){return p.status==="fechado"?<span className="badge badge-info">Fechado</span>:<span className="badge badge-ok">Aberto</span>;}

  async function create(){
    if(!newNome.trim())return;
    await onCreatePeriod(newNome.trim(),newMes,newAno);
    setShowNew(false);
  }

  function confirmAction(msg,detail,action){
    setConfirm({msg,detail,onConfirm:async()=>{await action();setConfirm(null);}});
  }

  return <div className="fade-in">
    {confirm&&<ConfirmModal msg={confirm.msg} detail={confirm.detail} onConfirm={confirm.onConfirm} onCancel={()=>setConfirm(null)}/>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
      <div className="h2">Histórico de períodos</div>
      {canManage&&<button className="btn btn-p" onClick={()=>setShowNew(!showNew)}>+ Novo período</button>}
    </div>

    {showNew&&canManage&&<div className="card fade-in" style={{border:"2px solid var(--accent)",marginBottom:16}}>
      <div className="h3">Criar novo período</div>
      <div className="grid3">
        <Field label="Mês"><select value={newMes} onChange={e=>setNewMes(parseInt(e.target.value))}>
          {meses.map((m,i)=><option key={i} value={i+1}>{m}</option>)}</select></Field>
        <Field label="Ano"><input type="number" value={newAno} onChange={e=>setNewAno(parseInt(e.target.value)||2025)}/></Field>
        <Field label="Nome"><input value={newNome} onChange={e=>setNewNome(e.target.value)}/></Field>
      </div>
      <div style={{marginTop:10,display:"flex",gap:8}}>
        <button className="btn btn-p" onClick={create}>Criar e abrir</button>
        <button className="btn btn-s" onClick={()=>setShowNew(false)}>Cancelar</button>
      </div>
    </div>}

    {activePeriod&&<div className="card" style={{background:"var(--accent-bg)",border:"2px solid var(--accent)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div><div className="h3" style={{marginBottom:2}}>Período ativo: {activePeriod.nome}</div>
          <div style={{fontSize:12,color:"var(--color-text-secondary)"}}>
            Dia 20: {activePeriod.status_dia20==="entregue"?"✓ Entregue":"⏳ Pendente"} • Dia 3: {activePeriod.status_dia3==="entregue"?"✓ Entregue":"⏳ Pendente"}
          </div>
        </div>
        {statusPeriodo(activePeriod)}
      </div>
      {canManage&&<div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {activePeriod.status_dia20==="pendente"&&<button className="btn btn-o"
          onClick={()=>confirmAction("Entregar dia 20?",`Marcar dia 20 do período "${activePeriod.nome}" como entregue.`,
            ()=>onUpdatePeriod(activePeriod.id,{status_dia20:"entregue",data_entrega_dia20:new Date().toISOString()}))}>
          ✓ Entregar dia 20</button>}
        {activePeriod.status_dia20==="entregue"&&activePeriod.status_dia3==="pendente"&&<button className="btn btn-o"
          onClick={()=>confirmAction("Entregar dia 3?",`Marcar dia 3 do período "${activePeriod.nome}" como entregue.`,
            ()=>onUpdatePeriod(activePeriod.id,{status_dia3:"entregue",data_entrega_dia3:new Date().toISOString()}))}>
          ✓ Entregar dia 3</button>}
        {activePeriod.status_dia20==="entregue"&&activePeriod.status_dia3==="entregue"&&activePeriod.status==="aberto"&&
          <button className="btn btn-p"
            onClick={()=>confirmAction("Fechar período?",`Fechar "${activePeriod.nome}" definitivamente. Dados viram histórico consultável.`,
              ()=>onUpdatePeriod(activePeriod.id,{status:"fechado"}))}>
            🔒 Fechar período</button>}
      </div>}
    </div>}

    <div className="card">
      <div className="h3">Todos os períodos ({periods.length})</div>
      {periods.length===0?<div className="empty">Nenhum período criado ainda</div>:
      <table><thead><tr><th>Período</th><th>Mês/Ano</th><th>Status</th><th>Dia 20</th><th>Dia 3</th><th></th></tr></thead>
      <tbody>{periods.map(p=>{
        const isActive=activePeriod?.id===p.id;
        return <tr key={p.id} style={isActive?{background:"var(--accent-bg)"}:{}}>
          <td style={{fontWeight:600}}>{p.nome}{isActive&&<span className="badge badge-ok" style={{marginLeft:6}}>Ativo</span>}</td>
          <td className="mono">{String(p.mes).padStart(2,"0")}/{p.ano}</td>
          <td>{statusPeriodo(p)}</td>
          <td>{statusBadge(p.status_dia20)}{p.data_entrega_dia20&&<div style={{fontSize:10,color:"var(--color-text-tertiary)"}}>{new Date(p.data_entrega_dia20).toLocaleDateString("pt-BR")}</div>}</td>
          <td>{statusBadge(p.status_dia3)}{p.data_entrega_dia3&&<div style={{fontSize:10,color:"var(--color-text-tertiary)"}}>{new Date(p.data_entrega_dia3).toLocaleDateString("pt-BR")}</div>}</td>
          <td>{!isActive&&p.status==="aberto"&&<button className="btn btn-s" style={{fontSize:11,padding:"4px 10px"}} onClick={()=>onSelectPeriod(p)}>Selecionar</button>}</td>
        </tr>;})}
      </tbody></table>}
    </div>
  </div>;
}

/* ─── Admin Panel (Master only) ─── */
function AdminPanel({userRole,onRefresh}){
  const [users,setUsers]=useState([]);
  const [requests,setRequests]=useState([]);
  const [tab,setTab]=useState("users");
  const [loading,setLoading]=useState(true);
  const [editId,setEditId]=useState(null);
  const [editFields,setEditFields]=useState({});

  const ROLES=[{k:"master",l:"Master",c:"#f2401a"},{k:"admin",l:"Administrador",c:"#00314f"},
    {k:"usuario",l:"Usuário",c:"#ff8b00"},{k:"view",l:"Visualizador",c:"#9bf400"},{k:"pendente",l:"Pendente",c:"#999"}];

  useEffect(()=>{load();},[]);
  async function load(){
    setLoading(true);
    try{
      const [u,r]=await Promise.all([SB.loadAllUsers(),SB.loadChangeRequests()]);
      setUsers(u||[]);setRequests(r||[]);
    }catch(e){console.error(e);}
    setLoading(false);
  }

  async function saveRole(u){
    const nome=editFields.nome??u.nome;
    const role=editFields.role??u.role;
    try{await SB.updateUserRole(u.id,{nome,role});setEditId(null);setEditFields({});await load();
    }catch(e){alert("Erro: "+e.message);}
  }

  async function removeUser(u){
    if(!confirm(`Remover ${u.email}?`))return;
    try{await SB.deleteUser(u.id);await load();}catch(e){alert("Erro: "+e.message);}
  }

  async function reviewReq(req,status){
    try{await SB.reviewChangeRequest(req.id,status,userRole.user_id);await load();
    }catch(e){alert("Erro: "+e.message);}
  }

  const roleBadge=(r)=>{const rd=ROLES.find(x=>x.k===r)||{l:r,c:"#999"};
    return <span className="badge" style={{background:rd.c+"22",color:rd.c,fontWeight:600}}>{rd.l}</span>;};

  const pendingCount=requests.filter(r=>r.status==="pendente").length;
  const pendingUsers=users.filter(u=>u.role==="pendente").length;

  if(loading) return <div className="fade-in"><div className="h2">Administração</div><div className="empty">Carregando...</div></div>;

  return <div className="fade-in">
    <div className="h2">Administração Master</div>
    <div className="tabs">
      <div className={`tab ${tab==="users"?"active":""}`} onClick={()=>setTab("users")}>
        Usuários ({users.length}){pendingUsers>0&&<span className="badge badge-danger" style={{marginLeft:6}}>{pendingUsers}</span>}
      </div>
      <div className={`tab ${tab==="requests"?"active":""}`} onClick={()=>setTab("requests")}>
        Solicitações{pendingCount>0&&<span className="badge badge-danger" style={{marginLeft:6}}>{pendingCount}</span>}
      </div>
      <div className={`tab ${tab==="perms"?"active":""}`} onClick={()=>setTab("perms")}>Permissões</div>
    </div>

    {tab==="users"&&<>
      {pendingUsers>0&&<div style={{padding:"10px 14px",borderRadius:8,background:"var(--orange-bg)",color:"#92400e",
        fontSize:12,fontWeight:600,marginBottom:16}}>{pendingUsers} usuário(s) aguardando aprovação</div>}
      <div className="card" style={{padding:0,overflow:"hidden"}}><div className="scroll-x"><table>
        <thead><tr><th>Nome</th><th>Email</th><th>Cargo</th><th>Criado em</th><th></th></tr></thead>
        <tbody>{users.map(u=>{
          const isEditing=editId===u.id;
          return <tr key={u.id} style={u.role==="pendente"?{background:"var(--orange-bg)"}:{}}>
            <td>{isEditing?<input style={{width:160,padding:"4px 8px",fontSize:12,borderRadius:5,border:"1.5px solid var(--accent)"}}
              value={editFields.nome??(u.nome||"")} onChange={e=>setEditFields(o=>({...o,nome:e.target.value}))}/>
              :<span style={{fontWeight:500}}>{u.nome||<span style={{color:"#999",fontStyle:"italic"}}>Sem nome</span>}</span>}</td>
            <td className="mono" style={{fontSize:11}}>{u.email}</td>
            <td>{isEditing?<select style={{padding:"4px 8px",fontSize:12,borderRadius:5,border:"1.5px solid var(--accent)"}}
              value={editFields.role??u.role} onChange={e=>setEditFields(o=>({...o,role:e.target.value}))}>
              {ROLES.map(r=><option key={r.k} value={r.k}>{r.l}</option>)}</select>
              :roleBadge(u.role)}</td>
            <td style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{new Date(u.created_at).toLocaleDateString("pt-BR")}</td>
            <td style={{whiteSpace:"nowrap"}}>
              {isEditing?<>
                <button className="btn btn-p" style={{fontSize:11,padding:"3px 10px",marginRight:4}} onClick={()=>saveRole(u)}>✓</button>
                <button className="btn btn-s" style={{fontSize:11,padding:"3px 10px"}} onClick={()=>{setEditId(null);setEditFields({});}}>✕</button>
              </>:<>
                <span style={{cursor:"pointer",marginRight:8}} onClick={()=>{setEditId(u.id);setEditFields({});}}>✎</span>
                {u.role==="pendente"&&<button className="btn btn-o" style={{fontSize:10,padding:"2px 8px",marginRight:4}}
                  onClick={()=>{setEditId(u.id);setEditFields({role:"view"});setTimeout(()=>saveRole(u),100);}}>Aprovar</button>}
                {u.email!==userRole.email&&<span style={{cursor:"pointer",color:"var(--red)"}} onClick={()=>removeUser(u)}>✕</span>}
              </>}
            </td>
          </tr>;})}
        </tbody></table></div></div>
    </>}

    {tab==="requests"&&<>
      {requests.length===0?<div className="card empty">Nenhuma solicitação de alteração</div>:
      <div className="card" style={{padding:0,overflow:"hidden"}}><div className="scroll-x"><table>
        <thead><tr><th>Solicitante</th><th>PDV</th><th>Campo</th><th>De</th><th>Para</th><th>Descrição</th><th>Status</th><th></th></tr></thead>
        <tbody>{requests.map(r=><tr key={r.id} style={r.status==="pendente"?{background:"var(--orange-bg)"}:{}}>
          <td style={{fontSize:11}}>{r.requester_nome||r.requester_email}</td>
          <td className="trunc" style={{fontSize:11}}>{r.pdv_nome||r.pdv_vmpay_id}</td>
          <td className="mono" style={{fontSize:11}}>{r.campo}</td>
          <td className="mono" style={{fontSize:11}}>{r.valor_atual||"—"}</td>
          <td className="mono" style={{fontSize:11,fontWeight:600}}>{r.valor_novo}</td>
          <td style={{fontSize:11,maxWidth:150,overflow:"hidden",textOverflow:"ellipsis"}}>{r.descricao||"—"}</td>
          <td>{r.status==="pendente"?<span className="badge badge-warn">Pendente</span>
            :r.status==="aprovado"?<span className="badge badge-ok">Aprovado</span>
            :<span className="badge badge-danger">Rejeitado</span>}</td>
          <td style={{whiteSpace:"nowrap"}}>{r.status==="pendente"&&<>
            <button className="btn btn-o" style={{fontSize:10,padding:"2px 8px",marginRight:4}} onClick={()=>reviewReq(r,"aprovado")}>Aprovar</button>
            <button className="btn btn-d" style={{fontSize:10,padding:"2px 8px"}} onClick={()=>reviewReq(r,"rejeitado")}>Rejeitar</button>
          </>}</td>
        </tr>)}</tbody></table></div></div>}
    </>}

    {tab==="perms"&&<div className="card">
      <div className="h3">O que cada cargo pode fazer</div>
      <div className="scroll-x"><table>
        <thead><tr><th style={{minWidth:220}}>Funcionalidade</th><th style={{textAlign:"center"}}>⭐ Master</th><th style={{textAlign:"center"}}>🔧 Admin</th><th style={{textAlign:"center"}}>👤 Usuário</th><th style={{textAlign:"center"}}>👁 View</th></tr></thead>
        <tbody>
          {[["Dashboard — visualizar","✓","✓","✓","✓"],["Administração — gerenciar usuários","✓","✗","✗","✗"],
            ["Aprovar/rejeitar solicitações","✓","✗","✗","✗"],["Histórico — ver períodos","✓","✓","✓","✓"],
            ["Histórico — criar/entregar/fechar","✓","✓","✗","✗"],["Cadastro de PDVs","✓","✓","✗","✗"],
            ["Entrada de dados (importar)","✓","✓","✗","✗"],["Pendências — corrigir direto","✓","✓","✗","✗"],
            ["Pendências — solicitar alteração","—","—","✓","✗"],["Calcular repasse","✓","✓","✗","✗"],
            ["Demonstrativo — editar direto","✓","✓","✗","✗"],["Demonstrativo — solicitar alteração","—","—","✓","✗"],
            ["Financeiro (relatório + CSV)","✓","✓","✗","✗"]
          ].map(([f,...perms],i)=><tr key={i}><td style={{fontWeight:500,fontSize:12}}>{f}</td>
            {perms.map((p,j)=><td key={j} style={{textAlign:"center",fontSize:14,
              color:p==="✓"?"#3d7a00":p==="✗"?"#ccc":"#ff8b00",fontWeight:700}}>{p}</td>)}</tr>)}
        </tbody>
      </table></div>
    </div>}
  </div>;
}

/* ─── LOGO SVG DATA ─── */
const LOGO_SVG = "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/Pgo8IURPQ1RZUEUgc3ZnIFBVQkxJQyAiLS8vVzNDLy9EVEQgU1ZHIDEuMS8vRU4iICJodHRwOi8vd3d3LnczLm9yZy9HcmFwaGljcy9TVkcvMS4xL0RURC9zdmcxMS5kdGQiPgo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHdpZHRoPSI4NC43NSIgem9vbUFuZFBhbj0ibWFnbmlmeSIgdmlld0JveD0iMCAwIDg0Ljc1IDg0Ljc0OTk5OSIgaGVpZ2h0PSI4NC43NSIgcHJlc2VydmVBc3BlY3RSYXRpbz0ieE1pZFlNaWQgbWVldCIgdmVyc2lvbj0iMS4wIj48ZGVmcz48Y2xpcFBhdGggaWQ9ImE5MDUwMjIzOTciPjxwYXRoIGQ9Ik0gMzYuMjgxMjUgMjcuNTkzNzUgTCA1Ny4yNDYwOTQgMjcuNTkzNzUgTCA1Ny4yNDYwOTQgNTcuMTk1MzEyIEwgMzYuMjgxMjUgNTcuMTk1MzEyIFogTSAzNi4yODEyNSAyNy41OTM3NSAiIGNsaXAtcnVsZT0ibm9uemVybyIvPjwvY2xpcFBhdGg+PGNsaXBQYXRoIGlkPSI2NjgxZmQxZjQ3Ij48cGF0aCBkPSJNIDQ3LjEwOTM3NSA0My43NSBDIDQ3LjAxMTcxOSA0My42NDA2MjUgNDYuOTEwMTU2IDQzLjUzMTI1IDQ2LjgyMDMxMiA0My40MjE4NzUgQyA0Ni4wNTQ2ODggNDMuOTQ5MjE5IDQ1LjI1NzgxMiA0NC40Mzc1IDQ0LjUxOTUzMSA0NS4wMTU2MjUgQyA0Mi45NDE0MDYgNDYuMjIyNjU2IDQxLjUxNTYyNSA0Ny42MDkzNzUgNDAuNjk5MjE5IDQ5LjUxMTcxOSBDIDQwLjE3OTY4OCA1MC42OTkyMTkgMzkuOTE0MDYyIDUxLjk1NzAzMSA0MC4zMTI1IDUzLjU2MjUgQyA0My44MzIwMzEgNTEuMDI3MzQ0IDQ1LjE4NzUgNDcuMTcxODc1IDQ3LjEyMTA5NCA0My43NSBNIDQ2LjcyMjY1NiAzOS4yNTM5MDYgQyA0Ni45Mjk2ODggMzkuMzA0Njg4IDQ3LjQxMDE1NiAzOS4zMjQyMTkgNDcuNzg5MDYyIDM5LjUyMzQzOCBDIDQ4LjUyNzM0NCAzOS45MjE4NzUgNDguNzE0ODQ0IDM5LjU4MjAzMSA0OC45MTQwNjIgMzguODk0NTMxIEMgNDkuNTgyMDMxIDM2LjU0Mjk2OSA1MC4zMDA3ODEgMzQuMTg3NSA1MS4wMzEyNSAzMS44NTU0NjkgQyA1MS4zMzk4NDQgMzAuODY3MTg4IDUxLjcyNjU2MiAyOS45MDIzNDQgNTIuMDY2NDA2IDI4LjkyNTc4MSBDIDUyLjI0NjA5NCAyOC4zOTQ1MzEgNTIuNTkzNzUgMjguMTk1MzEyIDUzLjEyNSAyOC4xMzY3MTkgQyA1NC4xMjg5MDYgMjguMDE1NjI1IDU1LjEzNjcxOSAyNy44MDg1OTQgNTYuMTQ0NTMxIDI3LjY1NjI1IEMgNTYuMzI0MjE5IDI3LjYyODkwNiA1Ni42NDQ1MzEgMjcuNjk5MjE5IDU2LjY4MzU5NCAyNy44MDg1OTQgQyA1Ni45ODA0NjkgMjguNjA1NDY5IDU3LjQ0OTIxOSAyOS40MjE4NzUgNTYuOTQxNDA2IDMwLjI4OTA2MiBDIDU0LjUwNzgxMiAzNC4zOTg0MzggNTMuNjYwMTU2IDM5LjA0Mjk2OSA1Mi43MzQzNzUgNDMuNjcxODc1IEMgNTIuMjE0ODQ0IDQ2LjI3MzQzOCA1MS44NzUgNDguOTE0MDYyIDUxLjQzNzUgNTEuNTQ2ODc1IEMgNTEuMjE4NzUgNTIuOTAyMzQ0IDUxLjMwODU5NCA1NC4xOTkyMTkgNTIuMDI3MzQ0IDU1LjQwNjI1IEMgNTIuMTM2NzE5IDU1LjU5Mzc1IDUyLjA0Njg3NSA1Ni4wOTM3NSA1MS44NzUgNTYuMjUzOTA2IEMgNTAuNTcwMzEyIDU3LjQ4MDQ2OSA1MC40MDIzNDQgNTcuNDgwNDY5IDQ5LjIyNjU2MiA1Ni4wODIwMzEgQyA0OC41ODU5MzggNTUuMzI0MjE5IDQ4LjA0Njg3NSA1NC40NzY1NjIgNDcuNSA1My42NDA2MjUgQyA0Ni44MDA3ODEgNTIuNTg1OTM4IDQ2LjYzMjgxMiA1Mi41MTU2MjUgNDUuOTI1NzgxIDUzLjU4MjAzMSBDIDQ0LjkzNzUgNTUuMDY2NDA2IDQzLjY0MDYyNSA1NS45NzI2NTYgNDEuOTY0ODQ0IDU2LjM3MTA5NCBDIDM5LjM1NTQ2OSA1Ny4wMTE3MTkgMzcuMTc5Njg4IDU1LjYxMzI4MSAzNi41ODIwMzEgNTIuODgyODEyIEMgMzUuMTY3OTY5IDQ2LjM4MjgxMiAzOS45MjE4NzUgMzkuNzMwNDY5IDQ2LjMyNDIxOSAzOS4yNTM5MDYgQyA0Ni4zODI4MTIgMzkuMjQyMTg4IDQ2LjQzMzU5NCAzOS4yNTM5MDYgNDYuNzEwOTM4IDM5LjI1MzkwNiAiIGNsaXAtcnVsZT0ibm9uemVybyIvPjwvY2xpcFBhdGg+PGNsaXBQYXRoIGlkPSIyODlhZWJhNWY0Ij48cGF0aCBkPSJNIDUzLjY5OTIxOSAzNi41MzUxNTYgTCA3NC4yMDMxMjUgMzYuNTM1MTU2IEwgNzQuMjAzMTI1IDU2LjI2OTUzMSBMIDUzLjY5OTIxOSA1Ni4yNjk1MzEgWiBNIDUzLjY5OTIxOSAzNi41MzUxNTYgIiBjbGlwLXJ1bGU9Im5vbnplcm8iLz48L2NsaXBQYXRoPjxjbGlwUGF0aCBpZD0iMzY4MjBlZGIyMSI+PHBhdGggZD0iTSA1Ny44NjcxODggNTEuNzg1MTU2IEMgNTkuNjY0MDYyIDUxLjM0NzY1NiA2NC41ODk4NDQgNDMuOTQ5MjE5IDY0LjM5ODQzOCA0Mi4wMzUxNTYgQyA2MC41MTk1MzEgNDQuMDg5ODQ0IDU2Ljg4MjgxMiA0OC4wNTg1OTQgNTcuODY3MTg4IDUxLjc4NTE1NiBNIDc0LjE5OTIxOSA1My4zODI4MTIgQyA3Mi44NjMyODEgNTYuMDkzNzUgNjkuMDA3ODEyIDU3LjEwOTM3NSA2Ni43OTI5NjkgNTUuNDU3MDMxIEMgNjUuOTg0Mzc1IDU0Ljg1NTQ2OSA2NS42NTYyNSA1My45ODgyODEgNjUuNTE1NjI1IDUzLjAxMTcxOSBDIDY1LjQwNjI1IDUyLjI0NjA5NCA2NS4yODkwNjIgNTEuNDg4MjgxIDY1LjE0ODQzOCA1MC40ODgyODEgQyA2NC40Njg3NSA1MS4yNDYwOTQgNjMuODgyODEyIDUxLjgwNDY4OCA2My4zOTQ1MzEgNTIuNDQ1MzEyIEMgNjEuOTM3NSA1NC4zNzg5MDYgNjAuMTMyODEyIDU1LjU5Mzc1IDU3LjczMDQ2OSA1NS44MjQyMTkgQyA1Ni45NDE0MDYgNTUuODk0NTMxIDU2LjMxMjUgNTUuNzY1NjI1IDU1Ljc1MzkwNiA1NS4yMTQ4NDQgQyA1My44MzIwMzEgNTMuMzMyMDMxIDUzLjMwMDc4MSA1MSA1NC4yMTg3NSA0OC40MjU3ODEgQyA1NS44NzUgNDMuNzgxMjUgNTguNjE3MTg4IDQwLjA2MjUgNjIuODE2NDA2IDM3LjY2MDE1NiBDIDY1LjE5OTIxOSAzNi4zMDA3ODEgNjcuNjQwNjI1IDM2LjIyMjY1NiA3MC4wMTE3MTkgMzcuNjY3OTY5IEMgNzEuNTI3MzQ0IDM4LjU4NTkzOCA3MS44MzU5MzggMzkuODMyMDMxIDcwLjk2MDkzOCA0MS40MjU3ODEgQyA3MC4yMDMxMjUgNDIuNzkyOTY5IDY5Ljc1MzkwNiA0NC4xODc1IDY5Ljc5Mjk2OSA0NS43OTI5NjkgQyA2OS44NTU0NjkgNDcuNzU3ODEyIDY5LjY2NDA2MiA0OS43NDIxODggNjkuODYzMjgxIDUxLjY5NTMxMiBDIDcwLjA5Mzc1IDUzLjg5ODQzOCA3MC45NjA5MzggNTQuMzU5Mzc1IDczLjAyMzQzOCA1My43NDIxODggQyA3My4zODI4MTIgNTMuNjMyODEyIDczLjc0MjE4OCA1My41MTk1MzEgNzQuMTkxNDA2IDUzLjM4MjgxMiAiIGNsaXAtcnVsZT0ibm9uemVybyIvPjwvY2xpcFBhdGg+PGNsaXBQYXRoIGlkPSJhZTQyMmIxYzkzIj48cGF0aCBkPSJNIDIxLjMyODEyNSAzOC4zODY3MTkgTCAzNi4yODEyNSAzOC4zODY3MTkgTCAzNi4yODEyNSA1Ny4xOTUzMTIgTCAyMS4zMjgxMjUgNTcuMTk1MzEyIFogTSAyMS4zMjgxMjUgMzguMzg2NzE5ICIgY2xpcC1ydWxlPSJub256ZXJvIi8+PC9jbGlwUGF0aD48Y2xpcFBhdGggaWQ9IjM2NTM5YTdmNDUiPjxwYXRoIGQ9Ik0gMjUuNzY1NjI1IDUxLjk0NTMxMiBDIDI1Ljc2NTYyNSA1Mi4xNzU3ODEgMjUuNzUzOTA2IDUyLjQxNDA2MiAyNS43NjU2MjUgNTIuNjQ0NTMxIEMgMjUuODA0Njg4IDUzLjY3MTg3NSAyNi4wOTM3NSA1My44Nzg5MDYgMjYuOTIxODc1IDUzLjMyMDMxMiBDIDI3LjU4OTg0NCA1Mi44NzUgMjguMjQ2MDk0IDUyLjMzNTkzOCAyOC43MjY1NjIgNTEuNjk1MzEyIEMgMzAuNjAxNTYyIDQ5LjE3NTc4MSAzMS4zMTY0MDYgNDYuMjIyNjU2IDMxLjM4NjcxOSA0My4wODIwMzEgQyAzMS4zOTg0MzggNDIuNzkyOTY5IDMxLjA3MDMxMiA0Mi4zMTI1IDMwLjgwODU5NCA0Mi4yMzQzNzUgQyAzMC4zMDA3ODEgNDIuMDc0MjE5IDI5LjY3MTg3NSA0MS42Njc5NjkgMjkuMjE0ODQ0IDQyLjM1NTQ2OSBDIDI3LjMwMDc4MSA0NS4yNDYwOTQgMjUuNjU2MjUgNDguMjU3ODEyIDI1Ljc2NTYyNSA1MS45NDUzMTIgTSAyMS4zOTg0MzggNTEuMzI4MTI1IEMgMjEuNDg4MjgxIDQ2LjMyNDIxOSAyMy4zMzk4NDQgNDIuNTIzNDM4IDI2LjU4MjAzMSAzOS40NTMxMjUgQyAyNy41ODk4NDQgMzguNDk2MDk0IDI4Ljc1MzkwNiAzOC4xMjUgMzAuMDg5ODQ0IDM4Ljg4MjgxMiBDIDMwLjQ2ODc1IDM5LjA5Mzc1IDMwLjk4ODI4MSAzOS4wMzUxNTYgMzEuNDM3NSAzOS4wODU5MzggQyAzMi42NDQ1MzEgMzkuMjAzMTI1IDMzLjg1OTM3NSAzOS4yMzQzNzUgMzUuMDQ2ODc1IDM5LjQ1MzEyNSBDIDM1Ljg1NTQ2OSAzOS42MDE1NjIgMzYuMzMyMDMxIDQwLjI4MTI1IDM2LjI3MzQzOCA0MS4xNzk2ODggQyAzNS45MzM1OTQgNDYuODEyNSAzNC4yMTg3NSA1MS43NzczNDQgMjkuODMyMDMxIDU1LjM4NjcxOSBDIDI5LjM4MjgxMiA1NS43NjU2MjUgMjguODg2NzE5IDU2LjA5Mzc1IDI4LjM2NzE4OCA1Ni4zNzEwOTQgQyAyNi40MTQwNjIgNTcuNDQxNDA2IDI1LjQxNDA2MiA1Ny4yNjk1MzEgMjMuODUxNTYyIDU1LjY2NDA2MiBDIDIzLjYwOTM3NSA1NS40MjU3ODEgMjMuMzkwNjI1IDU1LjE0NDUzMSAyMy4xMjEwOTQgNTQuOTU3MDMxIEMgMjEuNzU3ODEyIDU0IDIxLjI2NTYyNSA1Mi42MzI4MTIgMjEuMzk4NDM4IDUxLjMyODEyNSAiIGNsaXAtcnVsZT0ibm9uemVybyIvPjwvY2xpcFBhdGg+PGNsaXBQYXRoIGlkPSI1ZmI0ZWE4YzI2Ij48cGF0aCBkPSJNIDEwLjUzNTE1NiAzNi44NDM3NSBMIDI0LjQxMDE1NiAzNi44NDM3NSBMIDI0LjQxMDE1NiA1Ni44ODY3MTkgTCAxMC41MzUxNTYgNTYuODg2NzE5IFogTSAxMC41MzUxNTYgMzYuODQzNzUgIiBjbGlwLXJ1bGU9Im5vbnplcm8iLz48L2NsaXBQYXRoPjxjbGlwUGF0aCBpZD0iZGY5Y2RlMzk2OSI+PHBhdGggZD0iTSAxNi43NjE3MTkgNDEuMTA5Mzc1IEMgMTcuMTQwNjI1IDQwLjYwOTM3NSAxNy40Njg3NSA0MC4wNTA3ODEgMTcuODk4NDM4IDM5LjYxMzI4MSBDIDE5LjE4MzU5NCAzOC4yOTY4NzUgMjAuNjk5MjE5IDM3LjQzNzUgMjIuNTQyOTY5IDM3LjM5MDYyNSBDIDIyLjg5NDUzMSAzNy4zNzg5MDYgMjMuMjgxMjUgMzcuNDE3OTY5IDIzLjU4OTg0NCAzNy41NzAzMTIgQyAyNC40MTAxNTYgMzcuOTg4MjgxIDI0LjQ3NjU2MiAzOC41NTQ2ODggMjMuODAwNzgxIDM5LjE4MzU5NCBDIDIzLjI0MjE4OCAzOS43MDMxMjUgMjIuNjY0MDYyIDQwLjIxMDkzOCAyMi4wNjY0MDYgNDAuNjc5Njg4IEMgMTguNDI1NzgxIDQzLjU3MDMxMiAxNi4zMTI1IDQ3LjQyOTY4OCAxNS40MTQwNjIgNTIuMDY2NDA2IEMgMTUuMjI2NTYyIDUzLjA1MDc4MSAxNS4xMjUgNTQuMDcwMzEyIDE1LjAzNTE1NiA1NS4wNzgxMjUgQyAxNC45MjU3ODEgNTYuMzk0NTMxIDE0LjMwODU5NCA1Ni45NDkyMTkgMTMuMDYyNSA1Ni43NzM0MzggQyAxMS43MjY1NjIgNTYuNTgyMDMxIDEwLjkyOTY4OCA1NS40OTYwOTQgMTAuNzU3ODEyIDUzLjg5ODQzOCBDIDEwLjMwMDc4MSA0OS41NDI5NjkgMTAuNzc3MzQ0IDQ1LjI3NzM0NCAxMS44MDQ2ODggNDEuMDQ2ODc1IEMgMTIuMDAzOTA2IDQwLjIzMDQ2OSAxMi4xMjUgMzkuMzk0NTMxIDEyLjM3NSAzOC42MDU0NjkgQyAxMi43NzM0MzggMzcuMzIwMzEyIDEzLjM3MTA5NCAzNi43ODkwNjIgMTQuMTY3OTY5IDM2Ljg3MTA5NCBDIDE1LjA2NjQwNiAzNi45NjA5MzggMTUuOTQxNDA2IDM3Ljk3NjU2MiAxNi4xMDE1NjIgMzkuMDkzNzUgQyAxNi4xODM1OTQgMzkuNjkxNDA2IDE2LjMwMDc4MSA0MC4yODkwNjIgMTYuNDEwMTU2IDQwLjg4NjcxOSBDIDE2LjUzMTI1IDQwLjk1NzAzMSAxNi42NDA2MjUgNDEuMDM5MDYyIDE2Ljc2MTcxOSA0MS4xMDkzNzUgIiBjbGlwLXJ1bGU9Im5vbnplcm8iLz48L2NsaXBQYXRoPjwvZGVmcz48ZyBjbGlwLXBhdGg9InVybCgjYTkwNTAyMjM5NykiPjxnIGNsaXAtcGF0aD0idXJsKCM2NjgxZmQxZjQ3KSI+PHBhdGggZmlsbD0iI2ZlOGEwMCIgZD0iTSA1LjYwNTQ2OSAyMi42NjQwNjIgTCA3OS4xMzY3MTkgMjIuNjY0MDYyIEwgNzkuMTM2NzE5IDYyLjEyNSBMIDUuNjA1NDY5IDYyLjEyNSBaIE0gNS42MDU0NjkgMjIuNjY0MDYyICIgZmlsbC1vcGFjaXR5PSIxIiBmaWxsLXJ1bGU9Im5vbnplcm8iLz48L2c+PC9nPjxnIGNsaXAtcGF0aD0idXJsKCMyODlhZWJhNWY0KSI+PGcgY2xpcC1wYXRoPSJ1cmwoIzM2ODIwZWRiMjEpIj48cGF0aCBmaWxsPSIjZmU4YTAwIiBkPSJNIDUuNjA1NDY5IDIyLjY2NDA2MiBMIDc5LjEzNjcxOSAyMi42NjQwNjIgTCA3OS4xMzY3MTkgNjIuMTI1IEwgNS42MDU0NjkgNjIuMTI1IFogTSA1LjYwNTQ2OSAyMi42NjQwNjIgIiBmaWxsLW9wYWNpdHk9IjEiIGZpbGwtcnVsZT0ibm9uemVybyIvPjwvZz48L2c+PGcgY2xpcC1wYXRoPSJ1cmwoI2FlNDIyYjFjOTMpIj48ZyBjbGlwLXBhdGg9InVybCgjMzY1MzlhN2Y0NSkiPjxwYXRoIGZpbGw9IiNmZThhMDAiIGQ9Ik0gNS42MDU0NjkgMjIuNjY0MDYyIEwgNzkuMTM2NzE5IDIyLjY2NDA2MiBMIDc5LjEzNjcxOSA2Mi4xMjUgTCA1LjYwNTQ2OSA2Mi4xMjUgWiBNIDUuNjA1NDY5IDIyLjY2NDA2MiAiIGZpbGwtb3BhY2l0eT0iMSIgZmlsbC1ydWxlPSJub256ZXJvIi8+PC9nPjwvZz48ZyBjbGlwLXBhdGg9InVybCgjNWZiNGVhOGMyNikiPjxnIGNsaXAtcGF0aD0idXJsKCNkZjljZGUzOTY5KSI+PHBhdGggZmlsbD0iI2ZlOGEwMCIgZD0iTSA1LjYwNTQ2OSAyMi42NjQwNjIgTCA3OS4xMzY3MTkgMjIuNjY0MDYyIEwgNzkuMTM2NzE5IDYyLjEyNSBMIDUuNjA1NDY5IDYyLjEyNSBaIE0gNS42MDU0NjkgMjIuNjY0MDYyICIgZmlsbC1vcGFjaXR5PSIxIiBmaWxsLXJ1bGU9Im5vbnplcm8iLz48L2c+PC9nPjwvc3ZnPg==";

/* ─── Main App ─── */
export default function App() {
  const [authed,setAuthed]=useState(false);
  const [authLoading,setAuthLoading]=useState(true);
  const [page,setPage]=useState("dashboard");
  const [pdvs,setPdvs]=useState([]);
  const [md,setMd]=useState({});
  const [results,setResults]=useState([]);
  const [activePeriod,setActivePeriod]=useState(null);
  const [allPeriods,setAllPeriods]=useState([]);
  const [ready,setReady]=useState(false);
  const [dirty,setDirty]=useState(0);
  const [pendingNav,setPendingNav]=useState(null);
  const [loadMsg,setLoadMsg]=useState("Verificando sessão...");
  const [userRole,setUserRole]=useState(null); // {id,email,nome,role,...}
  const [authEmail,setAuthEmail]=useState("");

  // UUID maps: vmpay_id ↔ supabase uuid
  const [uuidMap,setUuidMap]=useState({});     // vmpay_id → uuid
  const [revUuidMap,setRevUuidMap]=useState({}); // uuid → vmpay_id

  const period = activePeriod?.nome || "";
  const role = userRole?.role || "pendente";
  const canEdit = role==="master"||role==="admin";
  const canRequest = role==="usuario";

  useEffect(()=>{
    const handler=e=>{if(dirty>0){e.preventDefault();e.returnValue="";}};
    window.addEventListener("beforeunload",handler);
    return ()=>window.removeEventListener("beforeunload",handler);
  },[dirty]);

  function tryNavigate(target){
    if(dirty>0&&target!==page){setPendingNav(target);}
    else{setPage(target);}
  }

  /* ─── Auth check on mount ─── */
  useEffect(()=>{
    const timeout=setTimeout(()=>{setAuthLoading(false);},5000); // never hang more than 5s
    (async()=>{
      try{
        const session=await tokenGet();
        if(session?.refresh_token){
          const d=await SB.refreshToken(session.refresh_token);
          await tokenSet({access_token:d.access_token,refresh_token:d.refresh_token});
          setAuthed(true);setAuthEmail(d.user?.email||"");
        }
      }catch(e){console.log("No valid session:",e.message);try{await tokenClear();}catch{}}
      finally{clearTimeout(timeout);setAuthLoading(false);}
    })();
    return ()=>clearTimeout(timeout);
  },[]);

  /* ─── Load data when authenticated ─── */
  useEffect(()=>{
    if(!authed||!authEmail)return;
    (async()=>{
      try{
        setLoadMsg("Verificando permissões...");
        let ur=await SB.loadUserRole(authEmail);
        if(!ur){await SB.ensureUserRole(null,authEmail);ur=await SB.loadUserRole(authEmail);}
        setUserRole(ur);
        if(!ur||ur.role==="pendente"){setReady(true);return;}

        setLoadMsg("Carregando PDVs...");
        const pdvList=await SB.loadPdvs();
        const um={},rm={};
        pdvList.forEach(p=>{um[p.id]=p.uuid;rm[p.uuid]=p.id;});
        setUuidMap(um);setRevUuidMap(rm);setPdvs(pdvList);

        setLoadMsg("Carregando períodos...");
        const periods=await SB.loadPeriods();
        setAllPeriods(periods);

        const active=periods.find(p=>p.status==="aberto");
        if(active){
          setActivePeriod(active);
          setLoadMsg("Carregando dados do período...");
          const monthlyData=await SB.loadMonthlyData(active.id,rm);
          setMd(monthlyData);
          const res=await SB.loadResults(active.id,rm);
          const resWithNames=res.map(r=>{const p=pdvList.find(x=>x.id===r.id);return {...r,name:p?.name||r.name};});
          setResults(resWithNames);
        }
        setReady(true);
      }catch(e){console.error("Load error:",e);setLoadMsg("Erro ao carregar: "+e.message);}
    })();
  },[authed,authEmail]);

  /* ─── Save helpers ─── */
  async function savePdvsToSB(newPdvs){
    setPdvs(newPdvs);
    for(const np of newPdvs){
      const op=pdvs.find(p=>p.id===np.id);
      if(!op||JSON.stringify(np)!==JSON.stringify(op)){
        if(np.uuid){
          try{await SB.patchPdv(np.uuid,{nome:np.name,contract_type:np.contract_type,
            revenue_consideration:np.revenue_consideration,negotiated_percentage:np.negotiated_percentage,
            kwh_unity_price:np.kwh_unity_price,minimal_repass:np.minimal_repass,
            payment_day:np.payment_day,bank_cnpj_cond:np.bank_cnpj_cond,bank_cnpj:np.bank_cnpj,
            bank_name:np.bank_name,bank_banco:np.bank_banco,bank_agencia:np.bank_agencia,
            bank_conta:np.bank_conta,bank_pix:np.bank_pix});}catch(e){console.error("Save PDV error:",e);}
        }
      }
    }
  }

  async function saveMdToSB(newMd){
    setMd(newMd);
    if(!activePeriod){console.warn("No active period, skipping save");return;}
    // Collect all changed records for bulk upsert
    const records=[];
    for(const[pid,data] of Object.entries(newMd)){
      const puuid=uuidMap[pid];
      if(!puuid){continue;}
      // Always include if has any non-zero data
      const hasData=(data.meter_start||0)>0||(data.meter_end||0)>0||(data.raw_revenue||0)>0
        ||(data.manual_adjustment||0)!==0||(data.energy_bill_cond||0)>0;
      if(hasData) records.push({pdvUuid:puuid,data});
    }
    if(records.length===0)return;
    try{
      await SB.bulkUpsertMonthly(activePeriod.id,records);
      console.log(`Saved ${records.length} monthly records to Supabase`);
    }catch(e){
      console.error("Bulk save error:",e);
      alert("Erro ao salvar no banco: "+e.message);
    }
  }

  async function saveResultsToSB(res){
    setResults(res);
    if(!activePeriod)return;
    try{await SB.saveAllResults(activePeriod.id,res,uuidMap);}catch(e){console.error("Save results error:",e);}
  }

  // No-op save for read-only roles
  const noSave=()=>{};

  async function handleCreatePeriod(nome,mes,ano){
    try{
      const p=await SB.createPeriod(nome,mes,ano);
      const newPeriods=await SB.loadPeriods();
      setAllPeriods(newPeriods);
      const created=newPeriods.find(x=>x.nome===nome)||p;
      setActivePeriod(created);setMd({});setResults([]);
    }catch(e){alert("Erro ao criar período: "+e.message);}
  }

  async function handleSelectPeriod(p){
    try{
      setLoadMsg("Carregando período...");setReady(false);
      setActivePeriod(p);
      const monthlyData=await SB.loadMonthlyData(p.id,revUuidMap);
      setMd(monthlyData);
      const res=await SB.loadResults(p.id,revUuidMap);
      const resWithNames=res.map(r=>{const pdv=pdvs.find(x=>x.id===r.id);return {...r,name:pdv?.name||r.name};});
      setResults(resWithNames);
      setReady(true);
    }catch(e){console.error(e);setReady(true);}
  }

  async function handleUpdatePeriod(id,fields){
    try{
      await SB.updatePeriod(id,fields);
      const newPeriods=await SB.loadPeriods();
      setAllPeriods(newPeriods);
      if(activePeriod?.id===id){setActivePeriod(newPeriods.find(x=>x.id===id));}
    }catch(e){alert("Erro: "+e.message);}
  }

  function handleAuth(d){
    setAuthed(true);setAuthEmail(d.user?.email||"");
  }

  async function logout(){
    try{await tokenClear();}catch{}
    try{localStorage.clear();}catch{}
    SB.token=null;setAuthed(false);setReady(false);setAuthLoading(false);
    setUserRole(null);setAuthEmail("");setPdvs([]);setMd({});setResults([]);
    setActivePeriod(null);setAllPeriods([]);
  }

  /* ─── Render ─── */
  if(authLoading) return <div style={{display:"flex",justifyContent:"center",alignItems:"center",height:"100vh",
    fontFamily:"'DM Sans',sans-serif",color:"#6b6b6b"}}>{loadMsg}</div>;

  if(!authed) return <><style>{css}</style><LoginScreen onAuth={handleAuth}/></>;

  if(!ready) return <div style={{display:"flex",justifyContent:"center",alignItems:"center",height:"100vh",
    fontFamily:"'DM Sans',sans-serif",color:"#6b6b6b"}}>{loadMsg}</div>;

  // Pending user screen
  if(role==="pendente") return <><style>{css}</style>
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",
      background:"linear-gradient(135deg,#00314f 0%,#004d7a 100%)",fontFamily:"'DM Sans',sans-serif"}}>
      <div style={{background:"#fff",borderRadius:16,padding:40,width:400,textAlign:"center",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
        <div style={{fontSize:40,marginBottom:12}}>⏳</div>
        <div style={{fontSize:20,fontWeight:700,color:"#00314f",marginBottom:8}}>Acesso pendente</div>
        <div style={{fontSize:13,color:"#6b6b6b",marginBottom:20}}>Sua solicitação foi recebida. Aguarde o administrador liberar seu acesso.</div>
        <button onClick={logout} style={{padding:"8px 20px",borderRadius:8,border:"none",cursor:"pointer",
          fontSize:13,fontWeight:600,background:"#f0f0ee",color:"#333"}}>Sair</button>
      </div>
    </div></>;

  // Build nav based on role
  const allNav=[
    ["dashboard","◫","Dashboard",["master","admin","usuario","view"]],
    ["admin","⚙","Administração",["master"]],
    ["---","","Passo a passo do repasse",["master","admin"]],
    ["historico","⏱","Histórico",["master","admin","usuario","view"]],
    ["pdvs","⊞","Cadastro PDVs",["master","admin"]],
    ["entrada","⇥","Entrada dados",["master","admin"]],
    ["pendencias","⚑","Pendências",["master","admin","usuario"]],
    ["calcular","≡","Calcular",["master","admin"]],
    ["demo","☷","Demonstrativo",["master","admin","usuario"]],
    ["fin","$","Financeiro",["master","admin"]],
  ];
  const nav=allNav.filter(([,,, roles])=>roles.includes(role)).map(([k,ic,lb])=>[k,ic,lb]);

  return <>
    <style>{css}</style>
    {pendingNav&&<ConfirmModal
      msg="Você tem alterações não salvas!"
      detail="Se trocar de página agora, suas edições serão perdidas."
      onConfirm={()=>{setDirty(0);setPage(pendingNav);setPendingNav(null);}}
      onCancel={()=>setPendingNav(null)}/>}
    <div className="app" lang="en">
      <div className="side">
        <div className="logo" style={{flexDirection:"column",alignItems:"center",padding:"10px 16px 12px",gap:1}}>
          <img src={LOGO_SVG} alt="Roda" style={{height:90}}/>
          <span style={{fontSize:11,fontWeight:500,letterSpacing:"2px",color:"rgba(255,255,255,0.45)",textTransform:"uppercase"}}>repasse</span>
        </div>
        {nav.map(([k,ic,lb],i)=>
          k==="---"?<div key={`div-${i}`} style={{padding:"12px 16px 4px",fontSize:9,fontWeight:700,letterSpacing:"1.5px",
            textTransform:"uppercase",color:"rgba(255,255,255,0.3)",borderTop:"1px solid rgba(255,255,255,0.08)",marginTop:6}}>{lb}</div>
          :<div key={k} className={`nav-item ${page===k?"active":""}`} onClick={()=>tryNavigate(k)}>
            <span style={{fontSize:15,width:18,textAlign:"center"}}>{ic}</span>{lb}
          </div>
        )}
        <div style={{flex:1}}/>
        <div style={{padding:"8px 16px",fontSize:10,color:"rgba(255,255,255,0.35)",borderTop:"1px solid rgba(255,255,255,0.1)"}}>
          <div style={{marginBottom:3}}>{userRole?.nome||authEmail}</div>
          <div>{({master:"⭐ Master",admin:"🔧 Admin",usuario:"👤 Usuário",view:"👁 Visualizador"})[role]||role}</div>
          {role!=="view"&&<div style={{marginTop:3}}>{pdvs.length} PDVs • {period||"Sem período"}</div>}
        </div>
        <div onClick={logout} style={{padding:"8px 16px",fontSize:11,color:"rgba(255,255,255,0.5)",cursor:"pointer",borderTop:"1px solid rgba(255,255,255,0.06)"}}>
          ↩ Sair
        </div>
      </div>
      <div className="main">
        {page==="dashboard"&&<Dashboard pdvs={pdvs} results={results} period={period}
          allPeriods={allPeriods} revUuidMap={revUuidMap} userRole={userRole}
          onLoadPeriodResults={async(pid)=>{
            const res=await SB.loadResults(pid,revUuidMap);
            return res.map(r=>{const p=pdvs.find(x=>x.id===r.id);return {...r,name:p?.name||""};});
          }}/>}
        {page==="admin"&&role==="master"&&<AdminPanel userRole={userRole}/>}
        {page==="historico"&&<Historico periods={allPeriods} activePeriod={activePeriod}
          onSelectPeriod={handleSelectPeriod} onCreatePeriod={handleCreatePeriod} onUpdatePeriod={handleUpdatePeriod} userRole={userRole}/>}
        {page==="pendencias"&&<Pendencias pdvs={pdvs} setPdvs={canEdit?setPdvs:noSave} md={md} setMd={canEdit?setMd:noSave}
          savePdvs={canEdit?savePdvsToSB:noSave} saveMd={canEdit?saveMdToSB:noSave} onDirty={setDirty}
          userRole={userRole} onRequestChange={async(r)=>{try{await SB.createChangeRequest(r);}catch(e){throw e;}}}/>}
        {page==="pdvs"&&<PdvManager pdvs={pdvs} setPdvs={setPdvs} save={savePdvsToSB}/>}
        {page==="entrada"&&<DataEntry pdvs={pdvs} md={md} setMd={setMd} period={period} save={saveMdToSB}/>}
        {page==="calcular"&&<CalcResults pdvs={pdvs} md={md} results={results} setResults={setResults} save={saveResultsToSB} period={period}/>}
        {page==="demo"&&<Demonstrativo pdvs={pdvs} setPdvs={canEdit?setPdvs:noSave} md={md} setMd={canEdit?setMd:noSave} period={period}
          savePdvs={canEdit?savePdvsToSB:noSave} saveMd={canEdit?saveMdToSB:noSave} onDirty={setDirty}
          userRole={userRole} onRequestChange={async(r)=>{try{await SB.createChangeRequest(r);}catch(e){throw e;}}}/>}
        {page==="fin"&&<Financeiro pdvs={pdvs} setPdvs={canEdit?setPdvs:noSave} results={results} period={period}
          savePdvs={canEdit?savePdvsToSB:noSave} onDirty={setDirty}/>}
      </div>
    </div>
  </>;
}

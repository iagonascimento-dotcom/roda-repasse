# CONTEXTO-PROJETO — Roda Repasse

> **Para que serve este arquivo:** dar contexto completo do projeto para **iniciar um chat novo**
> (Claude Code neste repo, ou colado em outra ferramenta). É um **snapshot** — a referência viva,
> atualizada a cada commit, é o **`CLAUDE.md`** na raiz. Se algo aqui divergir do código, o código vence.
> Última atualização deste snapshot: **2026-08-24**.

---

## 1. O que é
Sistema de **cálculo e gestão de repasse de PDVs** (pontos de venda) da Roda Conveniência. SPA que
calcula quanto cada PDV recebe por período conforme o tipo de contrato, gera demonstrativos, dados
financeiros/bancários e planilhas de disparo de e-mail. Sem backend próprio.

## 2. Stack e arquitetura
- **React 18 + Vite**, **sem TypeScript**. Praticamente **tudo vive em um único arquivo:
  `src/App.jsx`** (~4400 linhas), estilo denso/minificado à mão.
- **Supabase** (PostgreSQL + Auth + Realtime), acessado por um **adapter REST próprio** (objeto `SB`
  no topo do `App.jsx`) — **NÃO** usa o SDK `@supabase/supabase-js`. Toda chamada passa por `SB.api()`.
- Única dependência de runtime além do React: **`xlsx`** (planilhas).
- Hospedagem: **GitHub Pages**. Sem servidor.

## 3. Comandos
- `npm run dev` — dev server em `http://localhost:5173` (config em `.claude/launch.json`).
- `npm run build` — build de produção (Vite). Use para validar que compila.
- `npm run preview` — serve o build.

## 4. Deploy
- Push na branch **`main`** dispara `.github/workflows/deploy.yml` → builda e publica no GitHub Pages:
  **https://iagonascimento-dotcom.github.io/roda-repasse/**
- `vite.config.js` grava `public/version.txt` e injeta `__BUILD_TIME__` a cada build.
  **Não commitar mudança que seja só de timestamp** do `version.txt`.

## 5. Backend (Supabase) — ATENÇÃO aos 2 conectores
- Projeto do repasse: **"Repasse"**, ref **`nssjemcdifdkxfhzukmz`** (região sa-east-1). `SB_URL`/anon key
  ficam hardcoded no `App.jsx` (anon key é pública, ok no client).
- **Existem 2 conectores Supabase (MCP) na conta.** Para o repasse use SEMPRE o conector **"Supabase"**
  (enxerga o projeto "Repasse"/ref `nssjemcdifdkxfhzukmz`) — **NUNCA** o **"Supabase Roda"** (aponta para
  `xdlenyhdmuthwclnqhmd`, outro banco). Confirmar o ref antes de qualquer `execute_sql`/`apply_migration`.
- Há também um projeto Supabase **"Roda"/"Agent Roda"** separado e não relacionado — não confundir.
- **Realtime** via WebSocket nativo (`SB.subscribeRealtime`), sem dependência extra.
- **`sync.locais`** = view (base sincronizada, fonte de verdade dos locais). Acesso via header
  `Accept-Profile: sync`; campos: `codigo` (ID VMpay), `local` (nome), + endereço/cidade/estado.
  RLS habilitado na base `sync.all_locais` (o app lê pela view SECURITY DEFINER; n8n usa service_role).

## 6. Modelo de dados / CRUD (~12 entidades)
Todo o CRUD passa pelo adapter `SB` (métodos REST). Mapa:

| Entidade (tabela/view) | C | R | U | D | O que guarda |
|---|:-:|:-:|:-:|:-:|---|
| **pdvs** | ✓ | ✓ | ✓ | ✓ | cadastro do PDV: contrato, %, kwh, mínimo, **dados bancários** (`bank_*`), `vmpay_id`(código), `nome` |
| **periodos** | ✓ | ✓ | ✓ | ✓ | mês/ano, `status` (aberto/fechado/entregue), `nome` |
| **dados_mensais** | ✓ | ✓ | ✓ | ✓¹ | por (periodo,pdv): `meter_start/end`, `raw_revenue`, `manual_adjustment(+_desc)`, `energy_bill_cond` |
| **user_roles** | ✓ | ✓ | ✓ | ✓ | `email`, `nome`, `role` |
| **resultados** | ✓ | ✓ | ~² | ✓ | snapshot do cálculo por período: `subtotal`, `adjustment`, `total` + snapshots do contrato |
| **change_requests** | ✓ | ✓ | ✓ | — | fluxo de aprovação (`pdv_create`/`pdv_edit`/`pdv_delete`/`md_edit`), `status` |
| **pdvs_ignorados** | ✓ | ✓ | — | ✓ | PDVs que não recebem repasse (`vmpay_id`, motivo) |
| **mcr** | ✓ | ✓ | — | ✓ | PDVs com MCR (ar-condicionado) |
| **pdv_emails** | ✓ | ✓ | ✓ | — | e-mail por `vmpay_id` (reusado todo mês no Disparo) |
| **audit_log** | ✓ | ✓ | — | — | log append-only: `user_email/nome`, `acao`, `entidade`, `campo`, `valor_antigo/novo`, `descricao` |
| **menu_config** | — | ✓ | ✓ | — | singleton `id=1`, jsonb `{nodes, pages}` do menu |
| **sync.locais** | — | ✓ | — | — | view externa, só leitura |

¹ delete via cascata do `deletePeriod`  ²  "update" de resultados = apaga e reinsere o período (`saveAllResults`)

**Por verbo:** ~14 leituras (GET) · creates+upserts (POST) · updates (PATCH) · deletes (DELETE).
**CRUD completo:** `pdvs`, `periodos`, `dados_mensais`, `user_roles`.
À parte: 5 operações de **auth** (signIn, signUp, refreshToken, resetPassword, updatePassword) + realtime.

## 7. Domínio / regras de negócio
- **Motor de cálculo:** função `calc()`. **11 tipos de contrato** (`CONTRACT_TYPES`): Fixo, Medidor,
  Percentual do Faturamento, combinações "+ Mínimo", variantes "OU" (pega o maior valor), "Conta de
  Energia + Percentual", e Boleto (sem cálculo).
- **Faturamento:** Bruto (fator 1.0) ou Líquido (`LIQ = 0.87`).
- **Medidor:** `(meter_end − meter_start) × kwh_unity_price`.
- **Ajuste manual:** `total = subtotal + manual_adjustment` (aditivo puro). O ajuste tem descrição
  (`manual_adjustment_desc`). Guardado em `dados_mensais`; refletido em `resultados.adjustment`/`.total`.
- **Cálculo é automático:** `recalcAndSaveResults` roda e grava em `resultados` a cada mudança de PDV ou
  de dados mensais. **Não existe página "Calcular"** (foi removida). Financeiro/Dashboard leem
  `resultados`; o Demonstrativo calcula ao vivo; `handleSelectPeriod` recalcula se houver dados mas
  `resultados` vazio.
- **Papéis** (`user_roles.role`): `master`, `admin`, `usuario`, `view`, `pendente`. Cada página tem
  sua lista de papéis permitidos.

## 8. Fluxos-chave (já implementados)
- **Importação segura (medidor/faturamento) — `DataEntry`:** `matchPdv(nome)` resolve na ordem
  **exato → código (`pdvs.id`) → aproximado** e **nunca lança quando há ambiguidade** (2+ nomes
  parecidos). `classificar` separa em aplicar / aproximados (CONFIRA) / ambíguos (não lança) /
  não-encontrados, e `abrirConfirmacaoImport` abre um `ConfirmModal` **antes de salvar**. A grade
  mostra o **código** ao lado do nome. Mitiga "MC RESIDENCIA" vs "MC RESIDENCIA (PISCINA)".
- **Botão "Média" (preenche FIM de medidor faltante):** `preencherMedia` completa `meter_end` de PDVs
  com início mas sem fim, com **fim = início do mês atual + consumo do mês anterior + N kWh** (caixa
  "Acréscimo", padrão 5). Acha o período anterior por `ano*12+mes`, confere no `ConfirmModal`.
- **Importação de e-mails (Disparo):** casa por **código do cadastro** (não por nome); tolera TAB,
  vírgula, ponto-e-vírgula **ou espaços** (nome no meio não atrapalha); mostra conferência antes de
  salvar; ignora código fora do cadastro. *(Ver §11 — parte disso é mudança recém-feita, não commitada.)*
- **Conferência de PDVs (`Conferencia`):** não importa planilha — carrega `sync.locais` e mostra os
  locais cujo `codigo` não tem PDV cadastrado nem está em `pdvs_ignorados` ("de fora").
- **Cadastro pendente some do fluxo:** `usuario` pede cadastro → `change_requests` `pdv_create`
  `pendente`. Enquanto pendente, some do dropdown do `PdvForm` e da Conferência. Aprovado → vira PDV;
  recusado → reaparece.
- **Sincronização automática de nomes:** no boot (só master/admin), `autoSyncNamesFromBase` compara
  `pdvs.nome` com `sync.locais.local` pelo mesmo código e atualiza o nome (global) + registra no
  histórico. O código nunca muda. Não afeta períodos entregues (valores são snapshot).

## 9. Menu lateral
- **`PAGE_REGISTRY`** = registro central das páginas (`[key, ic, label, roles]`). O admin não cria
  páginas, só organiza/personaliza.
- **`menu_config.config` (jsonb) = `{ nodes:[...], pages:{<key>:{icon,label}} }`** — definido pelo
  master na aba "Organizar menu" (`MenuEditor`), salvo e válido para todos. `nodes` = estrutura
  (grupos/itens/ordem); `pages` = overrides de ícone/nome por página. `normMenu()` mantém compat com o
  formato antigo. Ícone/nome efetivos vêm de `pageInfo(key, pages)`.
- **Ícones = Lucide** (ISC). Objeto `ICONS` guarda o interior de cada SVG 24×24; `Icon` renderiza via
  `dangerouslySetInnerHTML`. `IconPicker` (popover em **portal**, `position:fixed` — não voltar para
  `absolute`) usa `MENU_ICON_CHOICES`.
- **Sidebar sempre aberta (220px).** Grupos começam **fechados** (a pessoa abre clicando; estado
  memorizado por navegador em `localStorage` `menu-expanded-groups`).

## 10. Convenções de código
- **Percentuais** (`negotiated_percentage`) guardados como **fração** (7% = `0.07`). Exibir com
  `toPct(fração)` (não `*100` cru). Salvar dividindo por 100.
- **Inputs numéricos** mostram vazio quando 0 (`value={x||""}` + `placeholder="0"`).
- **CNPJ** (`bank_cnpj`, `bank_cnpj_cond`): máscara `maskCNPJ` + validação `isValidCNPJ` (dígitos
  verificadores). CNPJ preenchido e inválido bloqueia o salvar; vazio é permitido.
- **Upsert em lote** (`upsertEmails`, `bulkUpsertMonthly`) precisa **deduplicar pela chave de conflito**
  antes de enviar (última ocorrência vence) — senão erro Postgres **`21000`** ("ON CONFLICT DO UPDATE
  cannot affect row a second time").
- **Estilo:** `App.jsx` é denso/minificado à mão (nomes curtos, inline styles). Seguir o padrão do
  arquivo, não "formatar bonito".
- **CSS:** tokens em `:root` (`--accent #00314f`, `--orange #ff8b00`, `--red #f2401a`, …) + fallbacks
  `--color-*`. Reusar classes (`btn`, `badge`, `chip`, `card`, `nav-item`…).

## 11. Autenticação / sessão (JWT)
- `SB.token` = `access_token`; renovação via `SB.refreshToken(refresh_token)`. Sessão em
  `localStorage` chave **`sb-session`** (`{access_token, refresh_token}`), helpers `tokenGet/Set/Clear`.
- O access_token dura **~1h**. **Sintoma clássico:** página aberta > 1h → qualquer POST falha com
  **`PGRST303 "JWT expired"`** (ex.: "Erro ao importar" no Disparo). Não é problema de formato do dado.
- **Correção (feita nesta sessão):** `SB.api` detecta 401/JWT-expired e **renova + repete o request uma
  vez** (`SB.tryRefresh()`), e há um **timer que renova a cada 45 min** enquanto a página fica aberta.

## 12. Git / publicação (workflow com o usuário)
- Após terminar QUALQUER alteração de código: **atualizar o `CLAUDE.md`** no mesmo commit e entregar ao
  usuário o bloco para ele publicar manualmente:
  ```
  cd C:\Users\Iago\Documents\roda-repasse
  git add .
  git commit -m "<mensagem>"
  git push
  ```
- **Mensagens de commit:** minúsculas, **sem acentos**, prefixo `feat:` / `ui:` / `fix:`.
- Não commitar mudança só de timestamp do `public/version.txt`.

## 13. Estado atual / pendências (snapshot 2026-08-24)
- **Períodos no banco:** Maio 2026 (fechado), Junho 2026 (aberto), Julho 2026 (fechado), Agosto 2026
  (aberto). O "período anterior" a agosto = **Julho**.
- **Código NÃO commitado em `src/App.jsx`** (feito, falta compilar + commit + push):
  1. **JWT auto-refresh** (`SB.api` retry + `SB.tryRefresh` + timer 45 min) — §11.
  2. **Import de e-mail robusto + conferência** no `DisparoEmail` (casa por código, tolera espaços,
     `ConfirmModal` antes de salvar). Texto de ajuda atualizado.
  → Mensagem sugerida: `fix: renova token jwt expirado automaticamente + import de e-mail casa por codigo com conferencia e tolera espacos`.
- **Pendência ULIVING (aguardando "sim" do usuário):** trocar beneficiário dos 2 PDVs
  `MC ULIVING` (cód 16757, uuid a751a7ac-29ef-41f7-a9bc-d737c1056e38) e
  `MC ULIVING (8 ANDAR)` (cód 47596, uuid 70360d12-13ce-4129-8489-a2ffc3cab91d),
  de **ASSOCIACAO PRAIA DO FLAMENGO 2** para **ULIVING BRASIL HOSPEDAGEM ESTUDANTIL LTDA.**:
  CNPJ `18.359.617/0001-63` (válido), PIX (definir dígitos `18359617000163` vs máscara), Banco
  `Itaú Unibanco`, Agência `0285`, Conta `04023-4`. CNPJ condominial fica como está. Registrar **12
  logs** no `audit_log` (`acao="Editou cadastro PDV"`, `campo` no rótulo `Banco/Agência/Conta/PIX/CNPJ/Nome conta`).

## 14. Operações de dados já feitas nesta sessão (para não refazer)
- **Ajustes Julho→Agosto:** copiados os **5 ajustes recorrentes "Taxa mercadinho"** (BELA VIDA II,
  FLORES DO BRITO, JARDINS DO BRITO, MOINHO, SANTIAGO II) para agosto, em `dados_mensais` **e**
  `resultados` (recalc `total = subtotal + ajuste`). **NÃO** copiados: DUQUE DE CAXIAS (agosto já tinha
  R$ 800 do Victor; julho era parcela 2/4) e os 2 "Ajuda festa junina" (CHACARA, WIND). Julho intocado.
- **RLS:** habilitado em `sync.all_locais` (migration `enable_rls_sync_all_locais`) — o app não foi
  afetado (lê pela view SECURITY DEFINER).

## 15. Como começar um chat novo
1. Ler o **`CLAUDE.md`** (referência viva por commit) + este arquivo.
2. Confirmar o conector Supabase certo (§5) antes de tocar no banco.
3. Ver §13 (pendências) para retomar de onde parou.
4. Ao mexer no `App.jsx`, seguir o estilo denso (§10) e entregar o bloco de git (§12) ao terminar.

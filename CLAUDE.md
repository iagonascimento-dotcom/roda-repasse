# CLAUDE.md — Roda Repasse

> **Manutenção:** mantenha este arquivo atualizado a cada commit. Ao concluir uma
> alteração relevante (nova página, tabela, regra de negócio, convenção), atualize
> a seção correspondente antes de gerar o commit.

## O que é
Sistema de cálculo e gestão de **repasse de PDVs** da Roda Conveniência. SPA que calcula
quanto cada ponto de venda recebe por período conforme o tipo de contrato, gera
demonstrativos, dados financeiros/bancários e planilhas de disparo de e-mail.

## Stack
- **React 18 + Vite** (sem TypeScript). Praticamente tudo vive em um único arquivo: `src/App.jsx` (~4400 linhas).
- **Supabase** (PostgreSQL + Auth + Realtime), acessado por um adapter REST próprio (objeto `SB` no topo do `App.jsx`) — **não** usa o SDK `@supabase/supabase-js`.
- **GitHub Pages** para hospedagem. Sem backend próprio.
- Única dependência de runtime além do React: `xlsx` (geração/leitura de planilhas).

## Comandos
- `npm run dev` — dev server em `http://localhost:5173` (config em `.claude/launch.json`).
- `npm run build` — build de produção (Vite). Use para validar que compila.
- `npm run preview` — serve o build.

## Deploy
Push na branch **`main`** dispara `.github/workflows/deploy.yml`, que builda e publica no
GitHub Pages: https://iagonascimento-dotcom.github.io/roda-repasse/
`vite.config.js` grava `public/version.txt` e injeta `__BUILD_TIME__` a cada build (não commitar mudança só de timestamp).

## Backend (Supabase)
- Projeto: **"Repasse"**, ref `nssjemcdifdkxfhzukmz` (`SB_URL`/anon key ficam hardcoded no `App.jsx` — a anon key é pública, ok no client).
- Existe um projeto Supabase **"Roda" separado e não relacionado** — não confundir com o do repasse.
- Tabelas principais (schema `public`): `pdvs`, `periodos`, `dados_mensais`, `resultados`
  (guarda snapshots do contrato na época do cálculo), `user_roles`, `change_requests`
  (fluxo de aprovação de alterações), `audit_log`, `pdvs_ignorados` (PDVs que não recebem
  repasse), `pdv_emails`, `mcr`, `menu_config`. Há também a view `sync.locais` (base
  sincronizada, fonte de verdade dos locais — acesso via header `Accept-Profile: sync`;
  campos usados: `codigo` = ID VMpay, `local` = nome, + endereço/cidade/estado).
- **Realtime** via WebSocket nativo (`SB.subscribeRealtime`), sem dependência extra.
- A **Conferência de PDVs** (`Conferencia`) NÃO importa mais planilha — carrega `sync.locais`
  automaticamente e mostra os locais cujo `codigo` não tem PDV cadastrado (`pdvs.vmpay_id`) nem
  está em `pdvs_ignorados` (os "de fora"/pendentes). O cadastro (`PdvForm`) já usa a mesma base.
- **Cadastro pendente some do fluxo:** quando um `usuario` pede cadastro de PDV, cria um
  `change_requests` tipo `pdv_create` status `pendente`. Enquanto pendente, esse `codigo` some do
  dropdown do `PdvForm` **e** da lista "de fora" da Conferência (via `SB.loadPendingPdvCreateCodes()`).
  Aprovado → vira PDV (cadastrado). Recusado (status `rejeitado`) → deixa de ser pendente e reaparece.
- **Sincronização automática de nomes:** no boot (só master/admin), `autoSyncNamesFromBase` compara
  `pdvs.nome` com `sync.locais.local` pelo mesmo `codigo` e, se mudou, atualiza o nome (global) e
  registra no histórico ("Nome sincronizado da base"). O código nunca muda. **Não afeta períodos
  entregues** — o nome não entra em cálculo e os valores são snapshot no `resultados`.

## Domínio / regras de negócio
- **Motor de cálculo:** função `calc()` no `App.jsx`. São **11 tipos de contrato**
  (`CONTRACT_TYPES`): Fixo, Medidor, Percentual do Faturamento, combinações "+ Mínimo",
  variantes "OU" (pegam o maior valor), "Conta de Energia + Percentual", e Boleto (sem cálculo).
- **Faturamento** pode ser **Bruto** (fator 1.0) ou **Líquido** (`LIQ = 0.87`).
- Medidor: `(medidorFim − medidorInício) × kwh_unity_price`. Há ajuste manual com justificativa.
- **Cálculo é automático:** `recalcAndSaveResults` roda e grava na tabela `resultados` a cada
  mudança de PDV ou de dados mensais. NÃO existe mais página "Calcular" (era redundante — removida).
  Financeiro/Dashboard leem `resultados`; o Demonstrativo calcula ao vivo; `handleSelectPeriod`
  recalcula sozinho se um período tiver dados mas `resultados` vazio.
- **Entrada de dados / importação (`DataEntry`):** colar-e-importar (medidor início/fim, faturamento)
  NÃO casa mais por nome fuzzy cego. `matchPdv(nome)` resolve na ordem **exato → código (`pdvs.id`) →
  aproximado** e **nunca lança quando há ambiguidade** (2+ PDVs com nome parecido). `classificar`
  separa em aplicar / aproximados (CONFIRA) / ambíguos (não lança) / não-encontrados e
  `abrirConfirmacaoImport` abre um `ConfirmModal` com o resumo do casamento **antes de salvar**. A
  grade de leituras/faturamento mostra o **código** (`pdvs.id`) ao lado do nome. Mitiga lançar no PDV
  errado (ex.: "MC RESIDENCIA" vs "MC RESIDENCIA (PISCINA)").
- **Botão "Média" (preenche FIM de medidor faltante):** na aba Medidores, `preencherMedia` completa o
  `meter_end` dos PDVs de medidor que têm **início mas sem fim**, com
  **fim = início do mês atual + consumo do mês anterior + N kWh** (N vem da caixa "Acréscimo (kWh)",
  padrão 5). Acha o período anterior por `ano*12+mes`, lê `SB.loadMonthlyData(prev.id, pdvMap)`, pula
  quem não tem dado no mês anterior e confirma no `ConfirmModal` antes de salvar. Ex.: início 1535,
  consumo do mês anterior 511, N=5 → fim 2051. Para PDV sem medidor físico no local (paga média).
- **Papéis** (`user_roles.role`): `master`, `admin`, `usuario`, `view`, `pendente`.
  Cada página do menu tem sua lista de papéis permitidos.

## Menu lateral (importante)
- `PAGE_REGISTRY` = registro central das páginas (`[key, ic, label, roles]`), com os padrões de
  ícone/nome. O admin **não cria páginas novas**, só as organiza e personaliza.
- **`menu_config.config` (jsonb) = `{ nodes:[...], pages:{<key>:{icon,label}} }`**, definido pelo
  master na aba "Organizar menu" (`MenuEditor`), salvo e válido para todos.
  - `nodes` = estrutura (grupos/itens/ordem). Grupo = `{type:"group",label,icon,children:[keys]}`;
    item = `{type:"item",page}`.
  - `pages` = **overrides por página** de ícone e nome (o admin escolhe o ícone e edita o nome de
    cada página/grupo). Persistido — não é só visual local.
  - Compatível com o formato antigo (só o array de nodes) via `normMenu()`. O ícone/nome efetivos
    de uma página vêm de `pageInfo(key, pages)` (override tem prioridade sobre `PAGE_MAP`).
- **Ícones = Lucide** (licença ISC, https://lucide.dev). Objeto `ICONS` guarda o interior de cada
  SVG 24×24; `Icon` renderiza via `dangerouslySetInnerHTML` com `stroke:currentColor`. `IconPicker`
  é o seletor (popover em grade) usado no editor; a lista fica em `MENU_ICON_CHOICES` (todos os
  nomes têm de existir em `ICONS`). O popover é renderizado em **portal** (`createPortal` no
  `document.body`) com `position:fixed` — necessário porque os cards do editor têm `overflow:hidden`
  e cortariam um popover `absolute`. Não voltar para `absolute`. Para adicionar um ícone novo: pegar o SVG em lucide.dev, colar o
  **interior** no `ICONS` e o par `[nome, rótulo]` em `MENU_ICON_CHOICES`. Manter 24×24, traço 2.
- **Sidebar sempre aberta (largura fixa 220px).** Não existe mais o modo "recolhido em barra de
  ícones" — foi removido a pedido do usuário (sem toggle no logo, sem classe `.side.collapsed`).
- **Grupos começam FECHADOS** (`isOpen = expandedGroups[node.id]===true`); a pessoa abre clicando no
  cabeçalho (seta ► fechado / ▼ aberto). Itens diretos (não-grupo) aparecem sempre. Os **grupos que a
  pessoa abriu são memorizados** por navegador (`expandedGroups` ↔ localStorage `menu-expanded-groups`).
  É isso que o usuário chama de "menu recolhido": barra cheia com os grupos fechados.

## Convenções
- **Percentuais** (`negotiated_percentage`) são guardados como **fração** (7% = `0.07`). Para exibir
  em input editável, use o helper `toPct(fração)` (não `*100` cru — `0.07*100 = 7.000…1`). Ao salvar,
  divide por 100 de volta. Campos só-leitura já usam `.toFixed(1)`.
- **Inputs numéricos** (cadastro/entrada) mostram vazio quando o valor é 0 (`value={x||""}` +
  `placeholder="0"`) — assim a pessoa clica e o campo já fica limpo, sem apagar o "0".
- **CNPJ** (dados bancários: `bank_cnpj`, `bank_cnpj_cond`) tem máscara `maskCNPJ` (00.000.000/0000-00)
  e validação com dígitos verificadores `isValidCNPJ`. CNPJ preenchido e inválido bloqueia o salvar
  no `PdvForm` (`bloqueiaSalvar`); vazio é permitido. Vale para admin (salvar) e usuário (solicitar).
- **Upsert em lote** (`upsertEmails`, `bulkUpsertMonthly`) precisa **deduplicar pela chave de conflito**
  antes de enviar (última ocorrência vence) — dois registros com a mesma chave no mesmo POST dão o
  erro Postgres `21000` ("ON CONFLICT DO UPDATE cannot affect row a second time").
- **Estilo de código:** o `App.jsx` é denso e minificado à mão (nomes curtos, pouca quebra de
  linha, estilos inline). Ao editar, siga o padrão do arquivo em vez de "formatar bonito".
- **CSS:** tokens em `:root` (`--accent #00314f`, `--orange #ff8b00`, `--red #f2401a`, etc.) +
  fallbacks `--color-*`. Reuse classes existentes (`btn`, `badge`, `chip`, `card`, `nav-item`…).
- **Mensagens de commit:** minúsculas, **sem acentos**, prefixo `feat:` ou `ui:`.
  Ex.: `ui: redesenho do organizador de menu`.
- Após terminar uma alteração, entregar ao usuário o bloco `cd … / git add . / git commit / git push`
  (ele publica manualmente). Atualizar este CLAUDE.md junto.

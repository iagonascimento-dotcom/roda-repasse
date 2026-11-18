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
- **Realtime** via WebSocket nativo (`SB.subscribeRealtime`), sem dependência extra. **Atenção:** o
  cliente entra no canal só com a anon key (não manda `access_token`), e o anon não lê nenhuma tabela de
  dados, então hoje o Realtime **não entrega eventos**. Para voltar a funcionar, o `phx_join` precisa
  levar `access_token: SB.token` (e reenviar no refresh). Não foi mexido de propósito em 17/11/2026.
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

## Segurança do banco (RLS por papel, desde 17/11/2026)
O papel (`user_roles.role`) é conferido **dentro do banco**, não só na tela. Registro completo em
`supabase/migrations/20261117_seguranca_regras_por_papel.sql`.
- **Função `interno.papel()`** (security definer, schema `interno`, que **não** é exposto na API) devolve o
  papel de quem está logado. Toda política usa `(select interno.papel()) in (...)`.
- **Quem pode o quê:** `master` tudo · `admin` tudo menos `user_roles`, `menu_config` e apagar período ·
  `usuario` lê e só grava `change_requests` (as próprias) e `audit_log` · `view` só lê · `pendente` ou
  conta sem linha em `user_roles` não lê nada além da própria linha · **anônimo só lê `menu_config`**
  (o app carrega o menu ao abrir a página, antes de restaurar a sessão; não fechar isso de novo).
- `audit_log` é só-inserção (ninguém altera nem apaga pela API). `user_roles`: ninguém se promove;
  quem não é master só consegue criar a própria linha como `pendente`.
- **`sync.locais`** agora é `security_invoker` e `sync.all_locais` tem política de leitura por papel;
  anônimo não acessa o schema `sync`. A função `sync-locais-do-roda` grava com service role (não é afetada).
- **Edge Function `tuya-kwh` só atende master/admin:** lê o papel do chamador em `user_roles` com o próprio
  token dele e devolve 403 para os demais.
- **TABELA NOVA NASCE FECHADA.** Os default privileges do schema `public` foram revogados para
  `anon`/`authenticated`. Ao criar tabela: `grant select, insert, update, delete ... to authenticated`,
  `alter table ... enable row level security` e políticas no padrão acima. Sem isso o app recebe
  "permission denied" (é proposital: erro visível em vez de tabela aberta). **Nunca criar tabela de
  backup/rascunho no `public`:** use o schema `interno` (foi uma tabela de backup sem RLS que gerou o
  alerta crítico do Supabase em 14/11/2026).
- Escrita de papel não autorizado falha calada em alguns fluxos (ex.: `recalcAndSaveResults` disparado
  por `usuario`/`view` em `handleSelectPeriod` cai no `catch` e só loga no console). É esperado.

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
- **E-mail no cadastro do PDV (`PdvForm`):** o formulário tem a seção **"E-mail"** (sempre visível), que
  lê e grava em **`pdv_emails`** (chave = código/`vmpay_id`) — a mesma base usada no Disparo de e-mail.
  `PdvManager` carrega o mapa `código → email` no boot (`SB.loadEmails`) e salva com `SB.upsertEmails`
  junto com o PDV (+ log no `audit_log`, campo "E-mail"). **Separador de múltiplos destinatários é
  VÍRGULA (`,`), nunca ponto-e-vírgula** — o `;` quebra o sistema de disparo que consome a planilha
  exportada. O campo troca `;` por `,` sozinho ao digitar/colar, salva normalizado (`a@x.com, b@y.com`)
  e o `buildRow` do `DisparoEmail` ainda converte `;` → `, ` na exportação (rede de segurança para
  registros antigos). E-mail preenchido e mal formatado bloqueia o salvar (igual ao CNPJ). Ao **criar** PDV, e-mail vazio
  **não** apaga um e-mail já existente para aquele código. Fluxo `usuario`: vira `change_requests`
  (`pdv_create` leva o e-mail no `payload`; edição vira um `pdv_edit` com `campo="email"`), e o
  `reviewReq` do admin aplica esse caso via `upsertEmails` — nunca via `patchPdv` (não é coluna de `pdvs`).
- **Dados bancários abrem expandidos:** no `PdvForm` o `<details>` de "Dados bancários" tem o atributo
  **`open`** — ao abrir Novo/Editar PDV a seção já aparece preenchida, sem precisar clicar.
- **Exportar cadastro (`exportarCadastro` no `PdvManager`):** botão "⬇ Exportar cadastro" ao lado de
  "+ Novo PDV", **só para master/admin** (`podeExportar`) porque a planilha leva dados bancários.
  Gera xlsx com 16 colunas (ID, PDV, tipo, receita, %, kWh, mínimo, dia pgto, os 7 campos bancários e
  e-mail), ordenado por nome, com filtro e primeira linha congelada; o e-mail vem do mapa `emails` que
  o `PdvManager` já carrega. Registra `audit_log` ("Exportou cadastro de PDVs"). **Existe de propósito
  dentro do sistema:** exportação de dado bancário é feita pela pessoa logada, com papel conferido e
  registro, em vez de arquivo solto gerado fora.
- **Dashboard com chave Geral ⇄ MCR:** o `Dashboard` tem um botão no título que troca a página inteira
  para os PDVs com MCR (aparelho que automatiza o ar-condicionado e derruba o consumo). Em modo MCR,
  `passesFilters` exige `mcrSet.has(id)`, então cards, Top 10, comparação e tabela já saem filtrados, e
  aparece o `McrPanel`. Estado em `localStorage` `dash-view`.
- **`McrPanel` (evolução mês a mês):** carrega, uma vez ao entrar no modo, `onLoadPeriodResults` de
  **todos** os períodos (estado `mcrSerie`). A métrica é **energia em R$** (`energyBill` do resultado =
  consumo × preço do kWh), **não kWh** — foi pedido assim. Só entram PDVs de contrato com **Medidor** e
  com `energyBill > 0` no mês. Mostra KPIs do último mês, variação da energia **média por PDV** de cada
  grupo (com e sem MCR) desde o primeiro mês, gráfico de linhas em SVG puro (sem biblioteca) com hover,
  tabela mês a mês e ranking de maiores quedas/altas por PDV. Como é R$ e não kWh, mudança no
  `kwh_unity_price` do cadastro também move a linha.
  **Comparar o médio por PDV dos dois grupos é proposital:** neutraliza calor e entrada de PDV novo.
  Não é antes/depois — **a tabela `mcr` não guarda data de instalação**, então o efeito do aparelho não
  é isolável hoje. Cores do gráfico `#2176B6` (com MCR) e `#E07400` (sem MCR), validadas para daltonismo
  e contraste; não trocar pelo azul #00314f da marca, que reprova nos dois testes como cor de gráfico.
- **Medidores Tuya (leitura automática do FIM):** a Edge Function **`tuya-kwh`** (código em
  `supabase/functions/tuya-kwh/index.ts`) é a única que fala com a Tuya Cloud; as credenciais ficam
  nos **Secrets do Supabase** (`TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET`, `TUYA_API_BASE`) e **nunca** no
  `App.jsx`, que é público. Duas armadilhas já resolvidas, não regredir:
  1. **Assinatura:** o SHA-256 do corpo vai em **minúsculo** dentro do `stringToSign`; só o HMAC final
     é maiúsculo. Invertido dá `sign invalid`.
  2. **O acumulado NÃO está em `/v1.0/devices/{id}/status` nem nas `/specifications`.** Só aparece em
     **`/v2.0/cloud/thing/{device_id}/shadow/properties`**, campo **`total_ele`**, **multiplicado por 100**.
     `cur_power` é potência instantânea em W e **não serve** como leitura.
  Conferido contra o histórico: PDV 139767 `total_ele` 1445894 → 14458,94 kWh (fim out/26 = 14129).
- **Tabela `tuya_devices`** (RLS ligado, só master/admin leem e gravam): `device_id` único, `pdv_uuid`/`vmpay_id`,
  `energy_code` (`total_ele`), `energy_scale` (**100**), `locked`. **1 PDV = 1 medidor** (índice único em
  `pdv_uuid`). Hoje: 51 aparelhos na conta, **41 vinculados e travados**, 10 fora (os "LV ENERGY" e um
  interruptor de teste). O vínculo é **sempre pelo código**, nunca pelo nome: na Tuya existe um aparelho
  chamado "198162 - MC ATLÉTICO GOLF" que é, na verdade, o MC OCEANA GOLF.
- **Botões na Entrada de Dados (aba Medidores):** `buscarTuya` lê os PDVs vinculados **daquela tela**
  (em paralelo, de 8 em 8), abre o `ConfirmModal` com a conferência e só então grava no `meter_end`;
  marca **⛔ quando a leitura é menor que o início do mês** (medidor trocado/zerado). `extrairTuya` é
  outra coisa: busca na Tuya na hora, em **todos** os medidores vinculados, e baixa uma planilha com
  **só 3 colunas — ID, PDV e kWh** — sem nada da tela nem do período (foi pedido assim). Na tabela de
  Leituras, um **⚡** ao lado do nome mostra o `device_id` vinculado ao passar o mouse.
- **Página "Medidores Tuya"** (`MedidoresTuya`, chave `medidores`, ícone `zap`, master/admin): lista os
  51 aparelhos, vincula cada um a um PDV **por lista suspensa, nunca digitando o `device_id`** (20
  caracteres opacos: um erro de 1 caractere lançaria leitura no PDV errado, calado), filtra por
  vinculados/sem vínculo, testa a leitura na hora (⚡ Testar) e tem a **trava** (🔒) que só o master
  altera. O botão "⟳ Atualizar lista da Tuya" relista e grava aparelhos novos **sem tocar nos vínculos
  existentes**. Um PDV já usado some do dropdown dos outros (índice único em `pdv_uuid`).
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

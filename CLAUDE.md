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
  sincronizada, fonte de verdade dos locais — acesso via header `Accept-Profile: sync`).
- **Realtime** via WebSocket nativo (`SB.subscribeRealtime`), sem dependência extra.

## Domínio / regras de negócio
- **Motor de cálculo:** função `calc()` no `App.jsx`. São **11 tipos de contrato**
  (`CONTRACT_TYPES`): Fixo, Medidor, Percentual do Faturamento, combinações "+ Mínimo",
  variantes "OU" (pegam o maior valor), "Conta de Energia + Percentual", e Boleto (sem cálculo).
- **Faturamento** pode ser **Bruto** (fator 1.0) ou **Líquido** (`LIQ = 0.87`).
- Medidor: `(medidorFim − medidorInício) × kwh_unity_price`. Há ajuste manual com justificativa.
- **Papéis** (`user_roles.role`): `master`, `admin`, `usuario`, `view`, `pendente`.
  Cada página do menu tem sua lista de papéis permitidos.

## Menu lateral (importante)
- `PAGE_REGISTRY` = registro central das páginas (`[key, ic, label, roles]`). O admin **não cria
  páginas novas**, só as organiza.
- `menu_config` (tabela) guarda a organização em **grupos expansíveis + itens soltos**, definida
  pelo master na aba "Organizar menu" (componente `MenuEditor`). Vale para todos os usuários.
- **Ícones do menu = Lucide** (licença ISC, https://lucide.dev). Objeto `ICONS` (guarda o interior
  de cada SVG 24×24) + componente `Icon` que renderiza via `dangerouslySetInnerHTML` com
  `stroke:currentColor` (o ícone herda a cor do texto: branco na sidebar, azul no editor). Em
  `PAGE_REGISTRY` o campo `ic` é o **nome do ícone Lucide** (ex.: `calculator`, `wallet`, `store`).
  Grupos usam um ícone fixo `folder`. No modo recolhido a sidebar mostra só os ícones (reconhecíveis
  por página — foi o objetivo).
- **Não há seletor de ícone** — o usuário não gostou de escolher ícone manualmente; **não reintroduzir**.
  Para trocar/adicionar um ícone: pegar o SVG em lucide.dev, colar o **interior** dele no `ICONS` e
  referenciar o nome no `PAGE_REGISTRY`. Manter o padrão (24×24, traço 2) para preservar a harmonia.

## Convenções
- **Estilo de código:** o `App.jsx` é denso e minificado à mão (nomes curtos, pouca quebra de
  linha, estilos inline). Ao editar, siga o padrão do arquivo em vez de "formatar bonito".
- **CSS:** tokens em `:root` (`--accent #00314f`, `--orange #ff8b00`, `--red #f2401a`, etc.) +
  fallbacks `--color-*`. Reuse classes existentes (`btn`, `badge`, `chip`, `card`, `nav-item`…).
- **Mensagens de commit:** minúsculas, **sem acentos**, prefixo `feat:` ou `ui:`.
  Ex.: `ui: redesenho do organizador de menu`.
- Após terminar uma alteração, entregar ao usuário o bloco `cd … / git add . / git commit / git push`
  (ele publica manualmente). Atualizar este CLAUDE.md junto.

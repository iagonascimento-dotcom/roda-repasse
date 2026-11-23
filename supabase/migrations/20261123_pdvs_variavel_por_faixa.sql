-- Aplicada no projeto Repasse em 23/11/2026 (via MCP). Guardada aqui como registro.
-- Variavel por faixa de faturamento (opcional, por PDV). Ver faixaVar() no App.jsx e o CLAUDE.md.
--   tier_mode: '' | 'extra_excess' | 'replace_all' | 'replace_excess'
--   tier_threshold: limite de faturamento (R$), sobre o faturamento considerado (Bruto/Liquido do cadastro)
--   tier_pct: percentual em fracao (8% = 0.08)
alter table public.pdvs
  add column tier_mode text not null default ''
    check (tier_mode in ('','extra_excess','replace_all','replace_excess')),
  add column tier_threshold numeric not null default 0 check (tier_threshold >= 0),
  add column tier_pct numeric not null default 0 check (tier_pct >= 0 and tier_pct <= 1);

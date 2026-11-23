-- Aplicada no projeto Repasse em 23/11/2026 (via MCP). Guardada aqui como registro.
-- Grupos de rateio: lojas cujo repasse e dividido entre condominios por percentual.
-- Regra: a parte propria de cada loja (luz, minimo, ajuste) fica com o condominio dono;
-- so o percentual do faturamento das lojas do grupo e somado e rateado (ver calcRateio no App.jsx).
create table public.rateio_grupos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  ativo boolean not null default true,
  -- [{ "nome": "Condominio X", "pct": 0.73452, "lojas": ["187710","187732"] }]
  -- pct = fracao (soma 1). A conta de pagamento e a do cadastro da PRIMEIRA loja da lista.
  beneficiarios jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
alter table public.rateio_grupos enable row level security;
grant select, insert, update, delete on public.rateio_grupos to authenticated;

create policy rateio_grupos_ler on public.rateio_grupos for select to authenticated
  using ((select interno.papel()) in ('master','admin','usuario','view'));
create policy rateio_grupos_inserir on public.rateio_grupos for insert to authenticated
  with check ((select interno.papel()) in ('master','admin'));
create policy rateio_grupos_alterar on public.rateio_grupos for update to authenticated
  using ((select interno.papel()) in ('master','admin')) with check ((select interno.papel()) in ('master','admin'));
create policy rateio_grupos_apagar on public.rateio_grupos for delete to authenticated
  using ((select interno.papel()) in ('master','admin'));

insert into public.rateio_grupos (nome, beneficiarios, updated_by) values (
  'Jardim Botafogo',
  '[{"nome":"Condomínio Highlight Jardim Botafogo","pct":0.73452,"lojas":["187710","187732"]},
    {"nome":"Condomínio Spotlight Jardim Botafogo","pct":0.26548,"lojas":["187625"]}]'::jsonb,
  'Iago (via Claude)');

-- Aplicada no projeto Repasse em 17/11/2026 (via MCP). Guardada aqui como registro.
-- Resumo: o papel (user_roles.role) passou a ser conferido DENTRO do banco (RLS).
-- Detalhes e regra para tabelas novas: ver secao "Seguranca do banco" no CLAUDE.md.
--
--   master  : tudo
--   admin   : tudo, menos usuarios (user_roles), menu (menu_config) e apagar periodo
--   usuario : le; grava so change_requests (as proprias) e audit_log
--   view    : so le (e grava audit_log)
--   pendente / sem linha em user_roles : nada, so a propria linha
--   anon    : so SELECT em menu_config (o app carrega o menu antes do login)

create schema if not exists interno;   -- NAO exposto na API (fora de pgrst.db_schemas)
revoke all on schema interno from public, anon;
grant usage on schema interno to authenticated, service_role;

create or replace function interno.papel() returns text
  language sql stable security definer set search_path = ''
  as $f$ select r.role from public.user_roles r where r.user_id = (select auth.uid()) limit 1 $f$;
revoke all on function interno.papel() from public, anon;
grant execute on function interno.papel() to authenticated, service_role;

-- Padrao das tabelas de dados (pdvs, dados_mensais, resultados, pdvs_ignorados, pdv_emails, mcr, periodos):
--   <tabela>_ler      select  using (papel in master, admin, usuario, view)
--   <tabela>_inserir  insert  check (papel in master, admin)
--   <tabela>_alterar  update  using/check (papel in master, admin)
--   <tabela>_apagar   delete  using (papel in master, admin)   -- periodos: so master
-- Sempre no formato  (select interno.papel()) in (...)  para o Postgres avaliar uma vez por consulta.
--
-- Excecoes:
--   tuya_devices     : tudo so master/admin
--   audit_log        : ler master/admin; inserir qualquer papel ativo; ninguem altera nem apaga
--   change_requests  : ler papeis ativos; inserir master/admin/usuario com requester_id = auth.uid();
--                      alterar master/admin; apagar master
--   menu_config      : ler anon + logado; inserir/alterar so master
--   user_roles       : ler a propria linha (master le todas); inserir so a propria como 'pendente'
--                      (master insere qualquer); alterar/apagar so master.
--                      Trigger interno.user_roles_antes_inserir preenche user_id com auth.uid().
--   sync.all_locais  : ler papeis ativos; view sync.locais com security_invoker = on; anon sem acesso ao schema sync
--
-- Privilegios:
--   revoke all on all tables/sequences in schema public from anon;  grant select on menu_config to anon;
--   revoke truncate, references, trigger on all tables in schema public from authenticated;
--   funcoes auto_confirm_email / handle_new_user / bulk_insert_pdvs: sem EXECUTE para public/anon/authenticated
--   handle_new_user: conta nova que reaproveita um e-mail nunca herda o papel antigo (volta a 'pendente')
--   default privileges (role postgres, schema public): tabelas, sequences e funcoes novas nascem SEM grant
--     para anon/authenticated  ->  toda tabela nova precisa de GRANT + RLS + politica explicitos.
--   backups backup_ajustes_set2026 e backup_medidores_set2026_1103 movidos para o schema interno.

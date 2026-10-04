-- Somente leitura. Execute depois de 001_Qest_supabase.sql.
-- Esperado: schema_version=1, prefix=Qest_.
select public."Qest_store"('health', '{}'::jsonb) as conexao;

-- Esperado: três tabelas, todas com RLS habilitado.
select c.relname as tabela, c.relrowsecurity as rls_habilitado
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relname in
  ('Qest_interviews', 'Qest_responses', 'Qest_import_keys') order by c.relname;

-- Esperado: false / false / true.
select has_function_privilege('anon', 'public."Qest_store"(text,jsonb)', 'EXECUTE') as anon_pode_executar,
       has_function_privilege('authenticated', 'public."Qest_store"(text,jsonb)', 'EXECUTE') as usuario_pode_executar,
       has_function_privilege('service_role', 'public."Qest_store"(text,jsonb)', 'EXECUTE') as servidor_pode_executar;

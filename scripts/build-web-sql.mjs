import fs from 'node:fs';
import { buildFlow } from '../public/flow.js';
const instrument = JSON.parse(fs.readFileSync(new URL('../public/questionnaire.json',import.meta.url),'utf8'));
const config = { version: instrument.version, flow: buildFlow(instrument).map(s=>s.id), questions: Object.fromEntries([
  ...instrument.questions.map(q=>[q.id,{type:q.type,options:q.options?.map(o=>o.value)||[]}]),
  ['opening',{type:'single',options:[0,1]}],['checkpoint',{type:'single',options:[0,1]}],
]) };
const template = fs.readFileSync(new URL('../sql/templates/web-access.sql',import.meta.url),'utf8');
const sql = template.replace('-- INSTRUMENT_CONFIG',`insert into public."Qest_web_config" (singleton,instrument) values (true,'${JSON.stringify(config).replaceAll("'","''")}'::jsonb) on conflict (singleton) do update set instrument=excluded.instrument;`);
fs.writeFileSync(new URL('../sql/003_Qest_acesso_web.sql',import.meta.url),sql);
console.log('SQL de acesso web gerado.');
// Atualização autossuficiente das duas RPCs, sem repetir configuração ou autorizações.
const storeSql = fs.readFileSync(new URL('../sql/001_Qest_supabase.sql',import.meta.url),'utf8');
const functionSql = (source, name) => {
  const start = source.indexOf(`create or replace function public."${name}"(`);
  const end = source.indexOf('\n$$;',start);
  if(start < 0 || end < 0) throw new Error(`Função ${name} não encontrada`);
  return source.slice(start,end+4);
};
const deletionSql = `-- Exclusão reversível. Execute TODO este arquivo após 001 e 003 (e 005 para a conta criadora).
-- Não apaga entrevistas, respostas, códigos ou dados de outros sites. Pode ser reaplicado.
-- Gerado por npm run sql:web a partir das RPCs mantidas no projeto.
begin;
alter table public."Qest_interviews"
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by_user_id uuid,
  add column if not exists deleted_by_email text;
comment on column public."Qest_interviews".deleted_at is 'Quando preenchido, exclui o registro das estatísticas, exportações e retomada; respostas preservadas para restauração.';
${functionSql(storeSql,'Qest_store')}
${functionSql(sql,'Qest_web')}
revoke all on function public."Qest_store"(text,jsonb), public."Qest_web"(text,jsonb) from public, anon, authenticated;
grant execute on function public."Qest_store"(text,jsonb) to service_role;
grant execute on function public."Qest_web"(text,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
select exists(select 1 from information_schema.columns where table_schema='public' and table_name='Qest_interviews' and column_name='deleted_at') as exclusao_reversivel_instalada;
`;
fs.writeFileSync(new URL('../sql/006_Qest_exclusao_reversivel.sql',import.meta.url),deletionSql);
console.log('SQL de exclusão reversível gerado.');

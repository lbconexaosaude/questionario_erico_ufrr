-- GitHub Pages + Supabase. Execute após 001_Qest_supabase.sql.
-- Não altera usuários, tabelas ou permissões dos outros sites.
begin;
create table if not exists public."Qest_access" (
  email text primary key check (email = lower(trim(email)) and length(email) between 3 and 254),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public."Qest_web_config" (
  singleton boolean primary key default true check (singleton),
  instrument jsonb not null
);
alter table public."Qest_access" enable row level security;
alter table public."Qest_web_config" enable row level security;
revoke all on public."Qest_access", public."Qest_web_config" from public, anon, authenticated;
grant select on public."Qest_access", public."Qest_web_config" to service_role;

-- INSTRUMENT_CONFIG

create or replace function public."Qest_validate_answers"(p_answers jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare i jsonb; q jsonb; a jsonb; v jsonb; k text; f text; typ text; item jsonb;
begin
  if jsonb_typeof(p_answers) is distinct from 'object' then raise sqlstate 'PT400' using message='Invalid answers'; end if;
  select instrument into i from public."Qest_web_config" where singleton;
  for k, a in select key,value from jsonb_each(p_answers) loop
    q := i->'questions'->k;
    if q is null or jsonb_typeof(a) is distinct from 'object' then raise sqlstate 'PT400' using message='Unknown question or invalid answer'; end if;
    for f in select jsonb_object_keys(a) loop
      if not (f = any(array['value','detail','events','religion','regular','frequency'])) then raise sqlstate 'PT400' using message='Unknown answer field'; end if;
      if f = any(array['detail','religion','regular','frequency']) and jsonb_typeof(a->f) is distinct from 'string' then raise sqlstate 'PT400' using message='Invalid text detail'; end if;
    end loop;
    if a ? 'events' then
      if jsonb_typeof(a->'events') is distinct from 'array' then raise sqlstate 'PT400' using message='Invalid events'; end if;
      for item in select value from jsonb_array_elements(a->'events') loop
        if not ('[1,2,3,4,5,6,7,8,9]'::jsonb @> jsonb_build_array(item)) then raise sqlstate 'PT400' using message='Invalid event code'; end if;
      end loop;
    end if;
    v := a->'value'; typ := q->>'type';
    if v is null or v = 'null'::jsonb or v = '""'::jsonb then continue; end if;
    if typ = any(array['single','events','religion']) then
      if not ((q->'options') @> jsonb_build_array(v)) then raise sqlstate 'PT400' using message='Invalid choice'; end if;
    elsif typ = 'multiple' then
      if k = any(array['q11.1','q19','q20']) and (q->'options') @> jsonb_build_array(v) then continue; end if;
      if jsonb_typeof(v) is distinct from 'array' then raise sqlstate 'PT400' using message='Invalid multiple choice'; end if;
      for item in select value from jsonb_array_elements(v) loop
        if not ((q->'options') @> jsonb_build_array(item)) then raise sqlstate 'PT400' using message='Invalid choice'; end if;
      end loop;
    elsif typ = 'integer' then
      if jsonb_typeof(v) is distinct from 'number' or v::text !~ '^[0-9]+$' then raise sqlstate 'PT400' using message='Invalid integer'; end if;
      if v::text::numeric > 9007199254740991 then raise sqlstate 'PT400' using message='Integer too large'; end if;
    elsif jsonb_typeof(v) is distinct from 'string' then raise sqlstate 'PT400' using message='Invalid text';
    end if;
  end loop;
end;
$$;

create or replace function public."Qest_validate_record"(p_answers jsonb, p_position integer, p_status text)
returns void language plpgsql security invoker set search_path = '' as $$
declare i jsonb; step text; parent text; selected jsonb;
begin
  perform public."Qest_validate_answers"(p_answers);
  select instrument into i from public."Qest_web_config" where singleton;
  if p_position is null or p_position < 0 or p_position >= jsonb_array_length(i->'flow')
    or p_status is null or not (p_status = any(array['in_progress','completed','interrupted_opening','interrupted_checkpoint'])) then
    raise sqlstate 'PT400' using message='Invalid position or status';
  end if;
  step := i->'flow'->>p_position;
  if (p_position > 0 and (p_answers#>'{opening,value}') is distinct from '1'::jsonb)
    or (p_position > 33 and (p_answers#>'{checkpoint,value}') is distinct from '1'::jsonb)
    or (p_status = 'completed' and p_position <> 65)
    or (p_status = 'interrupted_opening' and (p_position <> 0 or (p_answers#>'{opening,value}') is distinct from '0'::jsonb))
    or (p_status = 'interrupted_checkpoint' and (p_position <> 33 or (p_answers#>'{checkpoint,value}') is distinct from '0'::jsonb)) then
    raise sqlstate 'PT400' using message='Invalid continuity';
  end if;
  if (step = 'q7.1' and (p_answers#>'{q7,value}') is distinct from '1'::jsonb)
    or (step = 'q11.1' and (p_answers#>'{q11,value}') is distinct from '1'::jsonb) then
    raise sqlstate 'PT400' using message='Skipped question';
  end if;
  parent := '{"q13":"q12","q14":"q12","q16":"q15","q19":"q18","q23":"q22","q24":"q22","q26":"q25"}'::jsonb->>step;
  if parent is not null and p_answers->parent->'value' = '0'::jsonb then raise sqlstate 'PT400' using message='Skipped question'; end if;
  selected := p_answers#>'{q20,value}';
  if step = 'q21' and (selected = '0'::jsonb or selected = '1'::jsonb or selected @> '[0]'::jsonb or selected @> '[1]'::jsonb) then
    raise sqlstate 'PT400' using message='Skipped question';
  end if;
end;
$$;

-- Única entrada do site público. A autenticação e a autorização são verificadas
-- dentro do banco em TODAS as chamadas, incluindo leitura e exportação.
create or replace function public."Qest_web"(p_operation text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare config jsonb; existing jsonb; answers jsonb; state text; pos integer; row_data jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from auth.users u join public."Qest_access" a on a.email = lower(u.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null and a.active
  ) then raise sqlstate 'PT403' using message='Access to this research is not authorized'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text) > 8000000 then raise sqlstate 'PT400' using message='Invalid payload'; end if;
  select instrument into config from public."Qest_web_config" where singleton;
  if p_operation = 'health' then return jsonb_build_object('schema_version',2,'prefix','Qest_'); end if;
  if p_operation = any(array['get','list']) then return public."Qest_store"(p_operation,p_payload); end if;
  if p_operation = 'create' then
    if p_payload ? 'interviewer' and (jsonb_typeof(p_payload->'interviewer') is distinct from 'string' or length(p_payload->>'interviewer') > 200) then raise sqlstate 'PT400' using message='Invalid interviewer'; end if;
    return public."Qest_store"('create', jsonb_build_object('interviewer',coalesce(p_payload->>'interviewer',''),'instrument_version',config->>'version'));
  elsif p_operation = 'save' then
    perform 1 from public."Qest_interviews" where id=(p_payload->>'id')::uuid for update;
    existing := public."Qest_store"('get',jsonb_build_object('id',p_payload->>'id'));
    if existing->>'status' <> 'in_progress' or (p_payload->'revision') is distinct from (existing->'revision') then raise sqlstate 'PT409' using message='Revision conflict or interview closed'; end if;
    perform public."Qest_validate_answers"(p_payload->'answers');
    answers := (existing->'answers') || (p_payload->'answers');
    if jsonb_typeof(p_payload->'position') is distinct from 'number' or (p_payload->>'position') !~ '^[0-9]{1,2}$' then raise sqlstate 'PT400' using message='Invalid position'; end if;
    pos := (p_payload->>'position')::integer;
    state := 'in_progress';
    if p_payload->>'action' = 'complete' then state := 'completed';
    elsif p_payload->>'action' = 'interrupt' then
      if pos = 0 then state := 'interrupted_opening'; elsif pos = 33 then state := 'interrupted_checkpoint';
      else raise sqlstate 'PT400' using message='Invalid interruption'; end if;
    elsif p_payload ? 'action' then raise sqlstate 'PT400' using message='Unknown action'; end if;
    perform public."Qest_validate_record"(answers,pos,state);
    return public."Qest_store"('save', p_payload || jsonb_build_object('answers',answers,'position',pos,'status',state,'instrument_version',config->>'version'));
  elsif p_operation = any(array['duplicates','import']) then
    if jsonb_typeof(p_payload->'rows') is distinct from 'array' or jsonb_array_length(p_payload->'rows') > 500 then raise sqlstate 'PT400' using message='Invalid import batch'; end if;
    if p_operation = 'duplicates' then return public."Qest_store"('duplicates',p_payload); end if;
    for row_data in select value from jsonb_array_elements(p_payload->'rows') loop
      if jsonb_typeof(row_data) is distinct from 'object'
        or coalesce(row_data->>'instrument_version','') not in ('1.0-original','1.1','1.2',config->>'version')
        or coalesce(row_data->>'fingerprint','') !~ '^[a-f0-9]{64}$'
        or coalesce(row_data->>'code','') !~ '^[A-Za-z0-9_.-]{0,100}$'
        or length(coalesce(row_data->>'interviewer','')) > 200
        or jsonb_typeof(row_data->'position') is distinct from 'number' or (row_data->>'position') !~ '^[0-9]{1,2}$' then
        raise sqlstate 'PT400' using message='Invalid imported record';
      end if;
      perform public."Qest_validate_record"(row_data->'answers',(row_data->>'position')::integer,row_data->>'status');
    end loop;
    return public."Qest_store"('import',p_payload);
  end if;
  raise sqlstate 'PT400' using message='Unknown operation';
end;
$$;
revoke all on function public."Qest_validate_answers"(jsonb), public."Qest_validate_record"(jsonb,integer,text), public."Qest_web"(text,jsonb) from public, anon, authenticated;
grant execute on function public."Qest_web"(text,jsonb) to authenticated;
-- Qest_store e as tabelas continuam inacessíveis diretamente aos usuários.
notify pgrst, 'reload schema';
commit;

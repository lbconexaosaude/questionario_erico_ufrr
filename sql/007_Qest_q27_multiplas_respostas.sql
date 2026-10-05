-- Q27 com múltiplas respostas, instrumento 1.4.
-- Execute TODO este arquivo após a instalação do acesso web (SQL 003).
-- Preserva entrevistas, respostas antigas e objetos dos outros sites. Pode ser reaplicado.
begin;
update public."Qest_web_config" set instrument = jsonb_set(
  jsonb_set(instrument, '{questions,q27,type}', '"multiple"'::jsonb),
  '{version}', '"1.4"'::jsonb
) where singleton;
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
      if k = any(array['q11.1','q19','q20','q27']) and (q->'options') @> jsonb_build_array(v) then continue; end if;
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
  if p_operation = any(array['soft_delete','restore']) then
    if jsonb_typeof(p_payload->'revision') is distinct from 'number' or (p_payload->>'revision') !~ '^[0-9]{1,9}$'
      or coalesce(p_payload->>'id','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then
      raise sqlstate 'PT400' using message='Invalid interview or revision';
    end if;
    return public."Qest_store"(p_operation, jsonb_build_object(
      'id',p_payload->>'id','revision',p_payload->'revision',
      'actor_user_id',auth.uid(),'actor_email',(select lower(email) from auth.users where id=auth.uid())
    ));
  elsif p_operation = 'create' then
    if p_payload ? 'interviewer' and (jsonb_typeof(p_payload->'interviewer') is distinct from 'string' or length(p_payload->>'interviewer') > 200) then raise sqlstate 'PT400' using message='Invalid interviewer'; end if;
    return public."Qest_store"('create', jsonb_build_object('interviewer',coalesce(p_payload->>'interviewer',''),'instrument_version',config->>'version'));
  elsif p_operation = 'save' then
    perform 1 from public."Qest_interviews" where id=(p_payload->>'id')::uuid for update;
    existing := public."Qest_store"('get',jsonb_build_object('id',p_payload->>'id'));
    if existing->>'deleted_at' is not null or existing->>'status' <> 'in_progress' or (p_payload->'revision') is distinct from (existing->'revision') then raise sqlstate 'PT409' using message='Revision conflict or interview closed'; end if;
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
        or coalesce(row_data->>'instrument_version','') not in ('1.0-original','1.1','1.2','1.3',config->>'version')
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
revoke all on function public."Qest_validate_answers"(jsonb), public."Qest_web"(text,jsonb) from public, anon, authenticated;
grant execute on function public."Qest_web"(text,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
select instrument->>'version' as versao_instrumento, instrument#>>'{questions,q27,type}' as tipo_q27
from public."Qest_web_config" where singleton;

-- Exclusão reversível. Execute TODO este arquivo após 001 e 003 (e 005 para a conta criadora).
-- Não apaga entrevistas, respostas, códigos ou dados de outros sites. Pode ser reaplicado.
-- Gerado por npm run sql:web a partir das RPCs mantidas no projeto.
begin;
alter table public."Qest_interviews"
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by_user_id uuid,
  add column if not exists deleted_by_email text;
comment on column public."Qest_interviews".deleted_at is 'Quando preenchido, exclui o registro das estatísticas, exportações e retomada; respostas preservadas para restauração.';
create or replace function public."Qest_store"(p_operation text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid; v_existing public."Qest_interviews"%rowtype;
  v_row jsonb; v_result jsonb; v_answers jsonb; v_status text;
  v_position integer; v_ids jsonb := '[]'::jsonb; v_skipped integer := 0;
  v_time timestamptz := now();
begin
  if p_operation = 'health' then
    return jsonb_build_object('schema_version', 1, 'prefix', 'Qest_');
  elsif p_operation = 'get' then
    v_result := public."Qest_interview_json"((p_payload->>'id')::uuid);
    if v_result is null then raise sqlstate 'PT404' using message = 'Interview not found'; end if;
    return v_result;
  elsif p_operation = 'list' then
    select coalesce(jsonb_agg(public."Qest_interview_json"(s.id) order by s.id), '[]'::jsonb)
      into v_result from (
        select id from public."Qest_interviews"
        where p_payload->>'after' is null or id > (p_payload->>'after')::uuid
        order by id limit least(200, greatest(1, coalesce((p_payload->>'limit')::integer, 200)))
      ) s;
    return v_result;
  elsif p_operation = 'duplicates' then
    select coalesce(jsonb_agg(
      exists(select 1 from public."Qest_interviews" i where i.code = x.value->>'code')
      or exists(select 1 from public."Qest_import_keys" k where k.fingerprint = x.value->>'fingerprint')
      order by x.ordinality
    ), '[]'::jsonb) into v_result
    from jsonb_array_elements(p_payload->'rows') with ordinality x;
    return v_result;
  elsif p_operation = 'create' then
    -- Trava exclusiva deste aplicativo; não bloqueia tabelas dos outros sites.
    perform pg_advisory_xact_lock(742051903121::bigint);
    insert into public."Qest_interviews" (code, instrument_version, interviewer)
      values (public."Qest_next_code"(), p_payload->>'instrument_version', coalesce(p_payload->>'interviewer', ''))
      returning id into v_id;
    return public."Qest_interview_json"(v_id);
  elsif p_operation = any(array['soft_delete','restore']) then
    v_id := (p_payload->>'id')::uuid;
    select * into v_existing from public."Qest_interviews" where id = v_id for update;
    if not found then raise sqlstate 'PT404' using message = 'Interview not found'; end if;
    if (p_payload->>'revision')::integer is distinct from v_existing.revision
      or (p_operation = 'soft_delete' and v_existing.deleted_at is not null)
      or (p_operation = 'restore' and v_existing.deleted_at is null) then
      raise sqlstate 'PT409' using message = 'Interview revision or deletion state changed';
    end if;
    update public."Qest_interviews" set
      deleted_at = case when p_operation = 'soft_delete' then v_time else null end,
      deleted_by_user_id = case when p_operation = 'soft_delete' then (p_payload->>'actor_user_id')::uuid else null end,
      deleted_by_email = case when p_operation = 'soft_delete' then p_payload->>'actor_email' else null end,
      revision = revision + 1, updated_at = v_time
      where id = v_id;
    return public."Qest_interview_json"(v_id);
  elsif p_operation = 'save' then
    v_id := (p_payload->>'id')::uuid;
    select * into v_existing from public."Qest_interviews" where id = v_id for update;
    if not found then raise sqlstate 'PT404' using message = 'Interview not found'; end if;
    if v_existing.deleted_at is not null or v_existing.status <> 'in_progress' or (p_payload->>'revision')::integer is distinct from v_existing.revision then
      raise sqlstate 'PT409' using message = 'Interview revision conflict or interview closed';
    end if;
    v_answers := p_payload->'answers';
    v_status := p_payload->>'status'; v_position := (p_payload->>'position')::integer;
    if jsonb_typeof(v_answers) is distinct from 'object' then raise sqlstate 'PT400' using message = 'Invalid answers'; end if;
    -- Pontos oficiais de continuidade; validação de perguntas e saltos também ocorre no servidor Node.
    if (v_position > 0 and (v_answers#>>'{opening,value}') is distinct from '1')
      or (v_position > 33 and (v_answers#>>'{checkpoint,value}') is distinct from '1')
      or (v_status = 'completed' and v_position <> 65)
      or (v_status = 'interrupted_opening' and (v_position <> 0 or (v_answers#>>'{opening,value}') is distinct from '0'))
      or (v_status = 'interrupted_checkpoint' and (v_position <> 33 or (v_answers#>>'{checkpoint,value}') is distinct from '0')) then
      raise sqlstate 'PT400' using message = 'Invalid continuity state';
    end if;
    insert into public."Qest_responses" as existing (interview_id, question_id, answer, created_at, updated_at)
      select v_id, key, value, v_time, v_time from jsonb_each(v_answers)
      on conflict (interview_id, question_id) do update set answer = excluded.answer, updated_at = excluded.updated_at
      where existing.answer is distinct from excluded.answer;
    update public."Qest_interviews" set position = v_position, status = v_status,
      revision = revision + 1, updated_at = v_time,
      ended_at = case when v_status = 'in_progress' then null else v_time end,
      instrument_version = p_payload->>'instrument_version' where id = v_id;
    return public."Qest_interview_json"(v_id);
  elsif p_operation = 'import' then
    if jsonb_typeof(p_payload->'rows') is distinct from 'array' or jsonb_array_length(p_payload->'rows') > 500 then
      raise sqlstate 'PT400' using message = 'Invalid import batch';
    end if;
    perform pg_advisory_xact_lock(742051903121::bigint);
    for v_row in select value from jsonb_array_elements(p_payload->'rows') loop
      if coalesce((v_row->>'duplicate')::boolean, false)
        or exists(select 1 from public."Qest_interviews" where code = v_row->>'code')
        or exists(select 1 from public."Qest_import_keys" where fingerprint = v_row->>'fingerprint') then
        v_skipped := v_skipped + 1; continue;
      end if;
      v_status := v_row->>'status';
      if (v_status = 'completed' and ((v_row#>>'{answers,opening,value}') is distinct from '1' or (v_row#>>'{answers,checkpoint,value}') is distinct from '1'))
        or (v_status = 'interrupted_opening' and (v_row#>>'{answers,opening,value}') is distinct from '0')
        or (v_status = 'interrupted_checkpoint' and ((v_row#>>'{answers,opening,value}') is distinct from '1' or (v_row#>>'{answers,checkpoint,value}') is distinct from '0')) then
        raise sqlstate 'PT400' using message = 'Invalid imported continuity state';
      end if;
      insert into public."Qest_interviews" (code, instrument_version, interviewer, status, position, started_at, updated_at, ended_at)
        values (coalesce(nullif(v_row->>'code',''), public."Qest_next_code"()), v_row->>'instrument_version', coalesce(v_row->>'interviewer',''),
          v_status, (v_row->>'position')::integer, coalesce((v_row->>'started_at')::timestamptz, v_time),
          coalesce((v_row->>'updated_at')::timestamptz, v_time), case when v_status = 'in_progress' then null else coalesce((v_row->>'ended_at')::timestamptz, v_time) end)
        returning id into v_id;
      insert into public."Qest_responses" (interview_id, question_id, answer)
        select v_id, key, value from jsonb_each(v_row->'answers');
      insert into public."Qest_import_keys" (fingerprint, interview_id) values (v_row->>'fingerprint', v_id);
      v_ids := v_ids || jsonb_build_array(v_id);
    end loop;
    return jsonb_build_object('imported', jsonb_array_length(v_ids), 'skipped', v_skipped, 'ids', v_ids);
  end if;
  raise sqlstate 'PT400' using message = 'Unknown Qest operation';
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
revoke all on function public."Qest_store"(text,jsonb), public."Qest_web"(text,jsonb) from public, anon, authenticated;
grant execute on function public."Qest_store"(text,jsonb) to service_role;
grant execute on function public."Qest_web"(text,jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
select exists(select 1 from information_schema.columns where table_schema='public' and table_name='Qest_interviews' and column_name='deleted_at') as exclusao_reversivel_instalada;

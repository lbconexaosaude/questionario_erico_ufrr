-- Pesquisa Érico / UFRR. Execute TODO este arquivo no SQL Editor do Supabase.
-- As aspas preservam o prefixo exato Qest_ (Q maiúsculo).
-- Este script não altera tabelas, políticas ou funções dos outros sites.
-- Pode ser reaplicado sem apagar registros. Acesso somente pelo servidor.
begin;

create table if not exists public."Qest_interviews" (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  instrument_version text not null,
  interviewer text not null default '' check (length(interviewer) <= 200),
  status text not null default 'in_progress'
    check (status in ('in_progress','completed','interrupted_opening','interrupted_checkpoint')),
  position integer not null default 0 check (position between 0 and 65),
  revision integer not null default 0 check (revision >= 0),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  check ((status = 'in_progress' and ended_at is null) or (status <> 'in_progress' and ended_at is not null))
);

create table if not exists public."Qest_responses" (
  interview_id uuid not null references public."Qest_interviews"(id),
  question_id text not null check (question_id ~ '^(opening|checkpoint|q([1-9]|[1-4][0-9]|5[0-3])|q(7|11|34)\.1)$'),
  answer jsonb not null check (jsonb_typeof(answer) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (interview_id, question_id)
);

create table if not exists public."Qest_import_keys" (
  fingerprint text primary key check (fingerprint ~ '^[a-f0-9]{64}$'),
  interview_id uuid not null references public."Qest_interviews"(id),
  created_at timestamptz not null default now()
);

create index if not exists "Qest_interviews_started_idx" on public."Qest_interviews"(started_at desc);
create index if not exists "Qest_interviews_status_idx" on public."Qest_interviews"(status);
create index if not exists "Qest_import_keys_interview_idx" on public."Qest_import_keys"(interview_id);
create sequence if not exists public."Qest_code_seq";

alter table public."Qest_interviews" enable row level security;
alter table public."Qest_responses" enable row level security;
alter table public."Qest_import_keys" enable row level security;
-- Nenhuma política pública: as chaves anon/publishable e usuários de outros sites não acessam estes dados.
revoke all on public."Qest_interviews", public."Qest_responses", public."Qest_import_keys" from public, anon, authenticated;
revoke all on sequence public."Qest_code_seq" from public, anon, authenticated;
grant select, insert, update on public."Qest_interviews", public."Qest_responses", public."Qest_import_keys" to service_role;
grant usage, select on sequence public."Qest_code_seq" to service_role;

create or replace function public."Qest_interview_json"(p_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select to_jsonb(i) || jsonb_build_object('answers', coalesce((
    select jsonb_object_agg(r.question_id, r.answer)
    from public."Qest_responses" r where r.interview_id = i.id
  ), '{}'::jsonb)) from public."Qest_interviews" i where i.id = p_id;
$$;

create or replace function public."Qest_next_code"()
returns text language plpgsql security invoker set search_path = '' as $$
declare v_code text; v_number text;
begin
  loop
    v_number := nextval('public."Qest_code_seq"'::regclass)::text;
    v_code := 'BIO-' || to_char(now() at time zone 'America/Manaus', 'YYYY') || '-'
      || lpad(v_number, greatest(6, length(v_number)), '0');
    exit when not exists (select 1 from public."Qest_interviews" where code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Uma chamada RPC grava entrevista e respostas na mesma transação.
-- Revisão + FOR UPDATE impedem sobrescrita concorrente e edição de entrevista encerrada.
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
  elsif p_operation = 'save' then
    v_id := (p_payload->>'id')::uuid;
    select * into v_existing from public."Qest_interviews" where id = v_id for update;
    if not found then raise sqlstate 'PT404' using message = 'Interview not found'; end if;
    if v_existing.status <> 'in_progress' or (p_payload->>'revision')::integer is distinct from v_existing.revision then
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

-- PostgreSQL concede EXECUTE a PUBLIC por padrão: restringimos somente nossas funções.
revoke all on function public."Qest_interview_json"(uuid), public."Qest_next_code"(), public."Qest_store"(text,jsonb) from public, anon, authenticated;
grant execute on function public."Qest_interview_json"(uuid), public."Qest_next_code"(), public."Qest_store"(text,jsonb) to service_role;
comment on table public."Qest_interviews" is 'Pesquisa Érico/UFRR: entrevistas e estado de aplicação.';
comment on table public."Qest_responses" is 'Pesquisa Érico/UFRR: respostas por entrevista e questão.';
comment on table public."Qest_import_keys" is 'Pesquisa Érico/UFRR: prevenção de reimportação duplicada.';
notify pgrst, 'reload schema';
commit;

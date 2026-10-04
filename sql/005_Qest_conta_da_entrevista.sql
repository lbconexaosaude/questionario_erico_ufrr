-- Execute TODO este arquivo no SQL Editor, após os SQLs 001 e 003.
-- Registra a conta que cria/importa cada NOVO registro pelo site com login.
-- Pode ser reaplicado. Não atribui autores aos registros antigos.
begin;

alter table public."Qest_interviews"
  add column if not exists created_by_user_id uuid,
  add column if not exists created_by_email text;

comment on column public."Qest_interviews".created_by_user_id is
  'ID da conta autenticada que criou/importou o registro. Nulo nos registros sem identificação. Preservado mesmo após exclusão da conta.';
comment on column public."Qest_interviews".created_by_email is
  'E-mail confirmado da conta no momento da criação/importação. Não representa quem fez alterações posteriores.';

create or replace function public."Qest_stamp_creator"()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid; v_email text;
begin
  if TG_OP = 'UPDATE' then
    if new.created_by_user_id is distinct from old.created_by_user_id
      or new.created_by_email is distinct from old.created_by_email then
      raise sqlstate 'PT400' using message = 'Interview creation account cannot be changed';
    end if;
    return new;
  end if;

  -- Obtém a identidade da sessão validada pelo Supabase, nunca do formulário.
  v_user_id := auth.uid();
  if v_user_id is not null then
    select lower(u.email) into v_email
    from auth.users u join public."Qest_access" a on a.email = lower(u.email)
    where u.id = v_user_id and u.email_confirmed_at is not null and a.active;
    if v_email is null then
      raise sqlstate 'PT403' using message = 'Access to this research is not authorized';
    end if;
  end if;
  -- O servidor local não tem login de usuário: mantém ambos os campos nulos.
  new.created_by_user_id := v_user_id;
  new.created_by_email := v_email;
  return new;
end;
$$;

revoke all on function public."Qest_stamp_creator"() from public, anon, authenticated, service_role;
drop trigger if exists "Qest_interviews_creator" on public."Qest_interviews";
create trigger "Qest_interviews_creator"
  before insert or update on public."Qest_interviews"
  for each row execute function public."Qest_stamp_creator"();

-- Qest_interview_json já devolve todas as colunas; as RPCs não precisam mudar.
-- RLS e permissões existentes permanecem iguais. Nenhum objeto de outro site é alterado.
notify pgrst, 'reload schema';
commit;

select exists (
  select 1 from pg_trigger
  where tgrelid = 'public."Qest_interviews"'::regclass
    and tgname = 'Qest_interviews_creator' and not tgisinternal
) as registro_de_conta_instalado;

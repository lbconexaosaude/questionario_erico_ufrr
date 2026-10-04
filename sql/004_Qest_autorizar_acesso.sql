-- 1. No Supabase: Authentication > Users > Add user > Create new user.
--    Informe o e-mail e uma senha escolhida por você. Marque Auto Confirm User.
--    Se a conta já existe no projeto, use essa mesma conta; não a recrie.
-- 2. Substitua o e-mail abaixo e execute este arquivo no SQL Editor.
--    A autorização vale apenas para esta pesquisa, sem alterar os outros sites.
do $$
declare v_email text := lower(trim('SEU_EMAIL_AQUI'));
begin
  if v_email = 'seu_email_aqui' or position('@' in v_email) = 0 then
    raise exception 'Substitua SEU_EMAIL_AQUI pelo e-mail que vai acessar a pesquisa.';
  end if;
  if not exists(select 1 from auth.users where lower(email)=v_email and email_confirmed_at is not null) then
    raise exception 'Cadastre ou confirme esse e-mail em Authentication > Users antes de autorizar.';
  end if;
  insert into public."Qest_access"(email,active) values(v_email,true)
    on conflict(email) do update set active=true;
end;
$$;

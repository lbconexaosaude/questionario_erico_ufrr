-- 1. No Supabase: Authentication > Users > Add user > Create new user.
--    Informe o e-mail e uma senha escolhida por você. Marque Auto Confirm User.
--    Se a conta já existe no projeto, use essa mesma conta; não a recrie.
-- 2. Acrescente os e-mails na lista v_emails, cada um entre aspas simples,
--    separados por vírgula. Não coloque vírgula depois do último e-mail.
--    Execute o arquivo inteiro. Repetir a execução não duplica autorizações.
--    A autorização vale apenas para esta pesquisa, sem alterar os outros sites.
do $$
declare
  v_emails text[] := array[
    'lucivaldobarroso.dev@gmail.com',
    'macedogoncalves@hotmail.com'
  ];
  v_email text;
begin
  foreach v_email in array v_emails loop
    v_email := lower(trim(v_email));
    if v_email is null or v_email = 'seu_email_aqui' or position('@' in v_email) < 2 then
      raise exception 'Informe um e-mail válido na lista v_emails.';
    end if;
    if not exists(select 1 from auth.users where lower(email)=v_email and email_confirmed_at is not null) then
      raise exception 'Cadastre ou confirme o e-mail % em Authentication > Users antes de autorizar.', v_email;
    end if;
    insert into public."Qest_access"(email,active) values(v_email,true)
      on conflict(email) do update set active=true;
  end loop;
end;
$$;

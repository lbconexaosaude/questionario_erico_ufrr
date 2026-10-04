# GitHub Pages + Supabase

A interface pública usa o mesmo questionário, navegação, impressão, exportação e salvamento automático da versão local. O navegador acessa uma função autenticada no Supabase. Nenhum servidor Node.js precisa ficar ligado para usar o endereço publicado.

## Ativação no projeto Supabase existente

1. Os SQLs `001_Qest_supabase.sql` e `002_Qest_verificar.sql` já fazem parte da instalação local. Não apague tabelas nem entrevistas.
2. No SQL Editor, execute inteiro **`sql/003_Qest_acesso_web.sql`**. Ele instala validação no banco, acesso autenticado e a lista própria de usuários autorizados. Todas as tabelas novas usam `Qest_`.
3. Abra **Authentication → Users → Add user → Create new user**. Cadastre o e-mail e a senha que deseja usar e marque **Auto Confirm User**. Se essa conta já existir, use-a sem recriar ou alterar outras contas.
4. Abra **`sql/004_Qest_autorizar_acesso.sql`**, confira os e-mails na lista `v_emails` e execute o arquivo inteiro no SQL Editor. Cada e-mail deve estar cadastrado e confirmado.
5. Execute **`sql/005_Qest_conta_da_entrevista.sql`** para registrar automaticamente a conta que cria ou importa cada nova entrevista. Confira o resultado `registro_de_conta_instalado = true`.
6. Entre no site publicado com esse e-mail e senha.

Para autorizar outra pessoa, repita os passos 3 e 4. Para revogar apenas o acesso à pesquisa, execute `update public."Qest_access" set active=false where email='EMAIL_DA_PESSOA';`. Isso não exclui a conta nem modifica os demais sites.

Para acrescentar e-mails ao SQL 004, use uma linha por endereço, entre aspas simples, com vírgula entre os itens:

```sql
v_emails text[] := array[
  'lucivaldobarroso.dev@gmail.com',
  'macedogoncalves@hotmail.com',
  'outro@email.com'
];
```

Não coloque vírgula depois do último item. Não junte vários endereços dentro das mesmas aspas. Reexecutar o arquivo mantém os acessos anteriores e ativa os e-mails da lista sem duplicá-los. Se uma conta não estiver confirmada, o lote não é aplicado e a mensagem informa qual e-mail precisa ser conferido. Remover um e-mail da lista não revoga seu acesso; para isso, use `active=false` como descrito acima.

## Publicação no GitHub

Em **Settings → Pages → Build and deployment → Source**, selecione **GitHub Actions**. O workflow `.github/workflows/pages.yml` instala as dependências, executa os testes, gera os módulos para navegador e publica apenas `public/`. Cada envio à branch `main` atualiza o site.

URL: https://lbconexaosaude.github.io/questionario_erico_ufrr/

O arquivo `public/hosting.json` contém somente a URL do projeto e sua chave **publishable**, própria para navegador. Nunca coloque `sb_secret_`, `service_role`, senha ou `.env` nesse arquivo ou nos artefatos do Pages.

## Funcionamento e proteção dos dados

- Visitantes anônimos não podem consultar ou gravar entrevistas.
- Uma conta de outro site no mesmo Supabase só acessa esta pesquisa se seu e-mail confirmado estiver ativo em `Qest_access`.
- `Qest_web` verifica a conta e as permissões em todas as chamadas; valida perguntas, alternativas, saltos, continuidade e revisão antes de gravar.
- As tabelas continuam com RLS e sem acesso direto de `anon`/`authenticated`. A antiga função `Qest_store` continua reservada ao servidor.
- A importação de Excel é lida e conferida no navegador; o banco valida e grava o lote em uma transação. O arquivo Excel não é enviado a outros serviços.
- A sessão de login fica na aba. Respostas pendentes mantêm a cópia local para retomada e sincronização.

## Desenvolvimento e verificações

`npm start` continua usando o servidor local e o `.env` existente. Não é necessário alterar as credenciais locais.

```powershell
npm.cmd test
npm.cmd run build:pages
# Chrome de teste com depuração na porta 9223:
$env:BROWSER_BASE_PATH='/questionario_erico_ufrr'
node scripts/browser-check.mjs
$env:BROWSER_ONLINE='1'
node scripts/browser-check.mjs
```

O teste online intercepta o transporte do Supabase com dados fictícios em memória, sem acessar entrevistas reais. Os testes de SQL executam as funções em PostgreSQL isolado e verificam permissões, conflitos, validações e atomicidade. A verificação final do ambiente publicado exige executar os SQLs e usar uma conta autorizada real.

Ao atualizar perguntas ou regras, gere novamente `npm run sql:web`, revise o SQL gerado e aplique a atualização antes de publicar a interface correspondente.

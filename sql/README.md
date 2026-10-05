# Supabase — pesquisa Érico / UFRR

Todos os SQLs desta integração ficam nesta pasta. Nenhum deve ser executado no SQLite.

Para usar **GitHub Pages + Supabase**, execute também `003_Qest_acesso_web.sql` e configure a conta com `004_Qest_autorizar_acesso.sql`. Veja [o guia de publicação](../docs/PUBLICACAO.md). O acesso local por Node.js permanece disponível. A função nova `Qest_web` só atende contas confirmadas e autorizadas em `Qest_access`; a função antiga `Qest_store` continua exclusiva do servidor.

## 1. Executar no projeto Supabase existente

No **SQL Editor**, abra uma nova consulta e execute, nesta ordem:

1. **`001_Qest_supabase.sql`** — cole e execute o arquivo inteiro. Cria as tabelas, índices, sequência, permissões e funções transacionais.
2. **`002_Qest_verificar.sql`** — verifica a instalação sem criar entrevistas ou alterar respostas.

O primeiro arquivo usa transação: se ocorrer um erro, não prossiga até resolver. Ele pode ser reaplicado sem apagar registros. Não renomeie tabelas nem remova as aspas dos nomes. No PostgreSQL, `"Qest_interviews"` preserva a letra Q maiúscula; sem aspas, o nome seria convertido para minúsculas.

O segundo arquivo deve retornar:

- `schema_version: 1` e `prefix: Qest_`;
- três tabelas, todas com `rls_habilitado = true`;
- `anon_pode_executar = false`, `usuario_pode_executar = false`, `servidor_pode_executar = true`.

## Tabelas e isolamento

Para permitir **várias respostas na Q27**, execute **`007_Qest_q27_multiplas_respostas.sql`**. O resultado esperado é `versao_instrumento = 1.4` e `tipo_q27 = multiple`. A atualização preserva as respostas antigas e suas versões; entrevistas em andamento recebem a versão atual no próximo salvamento. Se já aplicou os anteriores, execute somente o 007. O comando `npm run sql:web` também gera essa migração.

Para habilitar **Excluir / Restaurar**, execute inteiro **`006_Qest_exclusao_reversivel.sql`** após 001 e 003. Se já usa o site, não precisa repetir os SQLs anteriores. O resultado é `exclusao_reversivel_instalada = true`. A migração adiciona campos de exclusão e atualiza as duas RPCs sem apagar dados. Toda conta autorizada da pesquisa pode excluir e restaurar. A operação exige a revisão atual do registro e registra a data/conta da exclusão. A restauração limpa esses campos e preserva o código, as respostas, a conta criadora e a situação original. Registros excluídos continuam reservando seu código e suas chaves de importação, evitando reimportação duplicada. A consulta continua disponível, mas edição, estatísticas, exportação e impressão ficam bloqueadas até restaurar.

`npm run sql:web` gera 003 e 006; o SQL 006 reutiliza as funções de 001 e do template web para mantê-las consistentes. O servidor local recebe a mesma funcionalidade; no SQLite a atualização das colunas acontece automaticamente ao iniciar.

Para mostrar a **Conta de acesso** no painel, execute também **`005_Qest_conta_da_entrevista.sql`** após 001 e 003. O resultado deve ser `registro_de_conta_instalado = true`. O banco registra o ID e o e-mail confirmado de quem cria o registro pelo site autenticado, inclusive nas importações. O e-mail não muda ao consultar, retomar ou encerrar a entrevista com outra conta. Registros antigos e registros criados pelo servidor local sem login ficam como **Não registrado**; não há preenchimento retroativo. O SQL pode ser reaplicado sem apagar dados.

| Tabela | Finalidade |
| --- | --- |
| `Qest_interviews` | Código, versão, aplicador, situação, progresso, revisão e datas da entrevista. |
| `Qest_responses` | Uma resposta JSON por entrevista/questão, com datas de criação e atualização. |
| `Qest_import_keys` | Identifica linhas já importadas para evitar duplicações. |

`Qest_responses.interview_id` e `Qest_import_keys.interview_id` referenciam `Qest_interviews.id`. A chave composta de respostas impede duas respostas para a mesma questão na mesma entrevista. A sequência `Qest_code_seq` gera os códigos BIO. Funções e índices também usam o prefixo `Qest_`.

Não são alteradas tabelas, políticas, usuários do Auth, buckets, configurações de autenticação ou privilégios dos outros sites. Os SQLs não concedem permissões globais em todas as tabelas do schema. Eles usam somente objetos próprios, no schema `public`, já exposto normalmente pelo Supabase.

As tabelas possuem RLS habilitado e não têm políticas para acesso direto de `anon` ou `authenticated`. Somente o servidor Node usa a chave secreta para chamar as funções. Assim, sessões dos outros sites no mesmo Supabase não passam a ter acesso à pesquisa.

## 2. Configurar a conexão no código

Copie `.env.example` para `.env` na raiz, caso ainda não exista. Preencha:

```dotenv
STORAGE_PROVIDER=supabase
PORT=3000
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SECRET_KEY=sb_secret_SUA_CHAVE
```

Os dados necessários são:

- **Project URL:** URL HTTPS do projeto Supabase, por exemplo `https://xxxxxxxx.supabase.co`, disponível em Connect/integração do projeto.
- **Secret API key:** em **Settings → API Keys → Secret keys**. Pode criar uma chave dedicada, identificada como `Qest-servidor`. Isso facilita a revogação, mas a chave continua sendo uma chave privilegiada do projeto.

Caso o projeto ofereça somente chaves legadas, deixe `SUPABASE_SECRET_KEY` vazio e use `SUPABASE_SERVICE_ROLE_KEY` com a chave `service_role`. Não use a chave `anon` ou `publishable` nesta conexão de servidor. Não precisa de senha do banco, connection string PostgreSQL nem token pessoal do Supabase.

Guarde a chave apenas no `.env` local ou, futuramente, nos segredos do servidor de hospedagem. O `.env` é ignorado pelo Git e não é servido pelo aplicativo. Não coloque a chave no navegador, em arquivos públicos ou no SQL. [Documentação oficial sobre chaves](https://supabase.com/docs/guides/getting-started/api-keys).

## 3. Testar e iniciar

No terminal do projeto:

```powershell
npm.cmd run supabase:check
```

Esse comando somente confere a conexão/RPC, sem ler respostas nem criar entrevistas. Quando confirmar a conexão, reinicie o servidor:

```powershell
npm.cmd start
```

Recarregue a página. O cabeçalho deve mostrar **Banco Supabase**. Autosave, retomada, painel, impressão e importação usam o banco selecionado. Não é preciso liberar CORS para o navegador, pois as chamadas ao Supabase saem do servidor Node.

Se a chave/URL estiver errada ou o SQL não tiver sido aplicado, o servidor informa o erro. Não há retorno silencioso para o banco local. A integração usa a Data API do Supabase (`/rest/v1/rpc/Qest_store`), que precisa estar habilitada para o schema `public`.

## Dados locais já existentes

Selecionar Supabase **não transfere nem apaga** o arquivo `storage/research.sqlite`. Os bancos são independentes. Para transferir entrevistas existentes pelo fluxo já disponível:

1. Ainda no modo SQLite, exporte o CSV sem filtros que excluam registros desejados.
2. Configure o modo Supabase e reinicie.
3. No painel, use **Importar Excel**, escolha o CSV, confira a prévia e confirme.

Os códigos, respostas, versões e datas fornecidas são preservados; são gerados novos UUIDs internos. Códigos já existentes no destino são ignorados. Para voltar aos registros locais, configure `STORAGE_PROVIDER=sqlite` e reinicie. Pendências do navegador são separadas por projeto Supabase para não misturar cópias de bancos diferentes.

## Escopo atual e verificações

O servidor continua restrito a `127.0.0.1`, como antes. Conectar ao Supabase não publica o site nem acrescenta login. Publicação e acesso de múltiplos usuários exigem configurar a autenticação do aplicativo antes de expor este servidor.

`npm.cmd test` valida o SQL em PostgreSQL local via PGlite, incluindo RLS, permissões, reaplicação, preservação de uma tabela de outro site, transações, revisões e integração da API. O transporte HTTP é simulado nesses testes; a conexão com o projeto real só é confirmada por `supabase:check` após preencher as credenciais e executar o SQL.

Referências: [funções PostgreSQL no Supabase](https://supabase.com/docs/guides/database/functions), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

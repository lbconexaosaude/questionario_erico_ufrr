# Questionário de Pesquisa Biopsicossocial — Érico / UFRR

**Versão online:** GitHub Pages + Supabase, sem servidor local ligado. Instalação, login e publicação: [docs/PUBLICACAO.md](docs/PUBLICACAO.md).

Aplicação local para conduzir entrevistas, salvar respostas em SQLite, retomar registros e consultar um painel com filtros, distribuição de alternativas, impressão individual/em lote, importação Excel/CSV e exportação CSV/JSON.

## Executar

Requer Node.js 24 ou superior.

```powershell
npm.cmd ci
npm.cmd start
```

Abra **http://localhost:3000**. Para parar, pressione `Ctrl+C` no terminal do servidor. `npm.cmd ci` é necessário na primeira instalação ou após atualizar dependências. A leitura e a criação de arquivos Excel usam [ExcelJS](https://github.com/exceljs/exceljs/tree/v4.4.0).

## Fluxo

- Nova entrevista com código automático, data, horário e aplicador opcional.
- Pergunta de abertura; resposta Não encerra após confirmação.
- Sete blocos com Q1 a Q53 e Q7.1, Q11.1 e Q34.1 (56 itens).
- Pausa oficial entre Q26 e Q27; resposta Não preserva as respostas e encerra.
- Salvamento após cada edição; cópia pendente no navegador em caso de indisponibilidade do servidor, com novas tentativas a cada cinco segundos.
- Retomada na posição anterior, ajustes de fonte, revisão por bloco e conclusão em modo somente leitura.
- Questões comuns podem ficar em branco. Somente as perguntas de continuidade precisam de Sim para avançar.
- Alterar uma resposta não apaga complementos de outras respostas. Campos complementares preenchidos permanecem visíveis mesmo após trocar a alternativa principal.
- Q11.1, Q19, Q20, Q37 e Q48 aceitam múltiplas alternativas. Q31 permite selecionar múltiplos eventos após Sim.

### Saltos autorizados — versão 1.3

| Resposta | Comportamento |
| --- | --- |
| Q7 = Sim | Abre Q7.1; em qualquer outro caso, pula Q7.1. |
| Q11 = Sim | Abre Q11.1; em qualquer outro caso, pula Q11.1. |
| Q12 = Não | Pula Q13 e Q14. |
| Q15 = Não | Pula Q16. |
| Q18 = Não | Pula Q19. |
| Q20 contém código 0 ou 1 | Pula Q21, inclusive se houver outras alternativas marcadas. |
| Q22 = Não | Pula Q23 e Q24. |
| Q25 = Não | Pula Q26 e apresenta a pausa intermediária normalmente. |

Nos saltos acionados por Não, uma resposta em branco não é tratada como Não. As regras valem para avançar, voltar, revisar e retomar. O progresso e a revisão consideram apenas as questões aplicáveis; a consulta e a impressão identificam questões puladas. Respostas preenchidas anteriormente não são apagadas quando uma questão passa a ser pulada.

Entrevistas encerradas antes da atualização mantêm a versão registrada e suas respostas originais, inclusive escolhas escalares. Entrevistas em andamento passam à versão 1.3 no próximo salvamento. A consulta e a impressão de entrevistas encerradas na versão 1.2 conservam a antiga regra da Q7.

## Impressão e PDF

A consulta exibe um quadro com Nome (Q1), Aplicador, Início, Encerramento, Situação e a versão do Instrumento registrada na entrevista. Registros em andamento mostram “Ainda não encerrada”.

No painel, use **Imprimir** ao lado de Consultar para uma entrevista, ou marque as caixas das linhas e clique em **Imprimir selecionadas**. A seleção do cabeçalho marca todas as entrevistas dos filtros atuais; o lote usa somente as selecionadas visíveis nesses filtros. Na consulta também existe **Imprimir / PDF**, junto a Voltar ao painel.

Na janela do navegador, escolha a impressora ou **Salvar como PDF**. Cada entrevista do lote começa em uma nova página, com código, nome, aplicador, situação, datas, versão, perguntas e respostas completas. A impressão não altera os registros.

## Rodapé LB Conexão DEV

O rodapé usa o vídeo da marca diretamente na assinatura de desenvolvimento, com ano automático e aviso de direitos reservados. O vídeo inicia automaticamente sem som, reproduz cinco vezes e para. Recarregar a página reinicia a sequência; navegar entre as telas da entrevista não reinicia o contador. O logo estático aparece enquanto o vídeo carrega.

O componente é independente e pode ser copiado para outros sites: veja [public/lb-footer/README.md](public/lb-footer/README.md). Os arquivos de marca originais foram preservados. As informações da pesquisa permanecem em uma faixa separada, acima da assinatura da empresa.

## Importação de Excel e CSV

1. No painel, clique em **Importar Excel**, ao lado de Exportar CSV.
2. Baixe o modelo `.xlsx`. A aba **Entrevistas** contém os cabeçalhos e a aba **Instruções** explica o preenchimento e os códigos.
3. Preencha uma entrevista por linha. Alternativas usam seus códigos numéricos; múltiplas escolhas usam códigos separados por vírgula. Complementos possuem colunas próprias, como `q20_detail` e `q31_events`.
4. Selecione o arquivo e clique em **Conferir planilha**. O sistema mostra as novas entrevistas, duplicadas e erros por linha.
5. Clique em **Importar** após conferir. Se houver erro, nada é gravado até a planilha ser corrigida.

São aceitos `.xlsx` e `.csv`, até 500 entrevistas e 5 MB por arquivo. Também é aceito o CSV exportado por este sistema, com respostas em JSON nas células. Para `.xls`, salve como `.xlsx` no Excel. A leitura usa a aba Entrevistas, quando presente, ou a primeira aba. Fórmulas precisam ser convertidas em valores. Colunas desconhecidas são apontadas como erro.

Códigos já existentes são ignorados, sem sobrescrever entrevistas. Se o código estiver vazio, será gerado automaticamente; repetir a mesma linha de uma importação já confirmada é detectado. Linhas distintas sem código são mantidas separadas. O modelo informa os estados aceitos e o formato das datas. A importação não inventa respostas de continuidade: uma entrevista concluída exige `opening=1` e `checkpoint=1`.

## Instrumento e alterações autorizadas

`data/instrument-source.json` preserva os parágrafos extraídos do Word original. `scripts/build-instrument.mjs` gera `public/questionnaire.json`; execute `npm.cmd run instrument` após ajustar a configuração do instrumento.

A versão 1.1 incorpora as duas instruções recebidas em 02/10/2026:

1. Retirar da Q20 a frase `(Marque 0 para Não / 1 para Sim):`, mantendo os códigos 0 a 12.
2. Permitir múltiplas escolhas na Q48, incluindo complemento em “Outras”.

A versão 1.3 corrige Q7.1 para abrir somente após Sim e permite múltiplas escolhas em Q11.1 e Q19. Mantém os demais saltos, maior contraste, impressão, importação e a redação “Se a resposta for Não, a entrevista será interrompida…”.

O texto integral de cada questão pode ser consultado durante a entrevista. Rótulos dos campos e diagramação separam alternativas e espaços de resposta sem mudar os códigos. A marca gráfica da interface é uma identificação tipográfica, não o brasão oficial da UFRR.

## Armazenamento e limites desta entrega

O banco fica em `storage/research.sqlite`. Entrevistas e respostas ficam em tabelas separadas. Cada resposta tem chave única por entrevista/questão e datas de criação e atualização. Atualizações usam revisão para detectar alterações simultâneas em abas diferentes. Uma entrevista encerrada não aceita novas alterações pela API.

O armazenamento pode ser **SQLite local** ou **Supabase**, selecionado por `STORAGE_PROVIDER` no `.env`. A aplicação ainda roda neste computador, sem login: o servidor escuta somente em `127.0.0.1`. Conectar ao banco remoto não publica o site nem cria gerenciamento de usuários. Pessoas com acesso ao computador podem consultar os registros do banco configurado.

Para configurar Supabase, siga [sql/README.md](sql/README.md). Os SQLs estão em uma única pasta, `sql/`, e criam somente as tabelas `Qest_interviews`, `Qest_responses` e `Qest_import_keys`, com funções e permissões próprias. O prefixo exato `Qest_` é preservado. Use `.env.example` como modelo e `npm.cmd run supabase:check` para verificar a conexão sem gravar dados.

O modo Supabase substitui o SQLite como destino das operações; não sincroniza os dois automaticamente. Os registros locais continuam preservados e podem ser transferidos pela exportação/importação CSV. A chave secreta permanece no servidor. Antes de publicar o aplicativo para vários usuários, será necessário configurar autenticação e controle de acesso.

Para um backup completo do SQLite, pare o servidor e copie a pasta `storage`. Exportações JSON/CSV incluem os registros dos filtros escolhidos; CSV pode ser reimportado pela interface. A importação direta de JSON não está implementada. A cópia pendente do navegador só é removida após confirmação do banco e não substitui backup. Antes da atualização para 1.2, foi criada uma cópia consistente do banco em `storage/backups/`.

O salvamento usa uma única fila para evitar requisições concorrentes da mesma aba. Quando há uma revisão mais recente no banco, um modal “Atualizando respostas…” sincroniza automaticamente: alterações locais pendentes prevalecem nos campos editados, e alterações remotas dos demais campos são preservadas. O modal fecha e restaura a pergunta, a rolagem e o foco. Falhas de rede mantêm a cópia local e são tentadas novamente. Se outra sessão já encerrou a entrevista, ela permanece encerrada e a cópia pendente fica disponível para download na consulta. Não é necessário executar SQL adicional para esta atualização.

O sistema registra a preferência da Q53; materiais e contatos de apoio não foram fornecidos e devem ser disponibilizados pela equipe aplicadora.

## Verificações

```powershell
npm.cmd test
```

Os testes cobrem numeração e códigos, todos os saltos autorizados, continuidade nos dois pontos oficiais, respostas opcionais, múltipla escolha, retenção de complementos, persistência após reabrir o banco, conflitos de revisão, bloqueio de edição após encerramento e importação de Excel/CSV (validação, duplicadas, confirmação e gravação atômica).

`node scripts/browser-check.mjs` executa também o fluxo de interface em um Chrome/Edge iniciado com `--remote-debugging-port=9223` e um perfil separado. Usa banco em memória, verifica telas de 1440 e 390 pixels, retomada, todos os saltos, Q20/Q48, conclusão, filtros, exportações, impressão individual/em lote e importação de Excel com prévia. Capturas e um PDF de teste ficam em `storage/qa/`. Esse script é opcional; o navegador de depuração não é necessário para usar o sistema.

Arquivos principais: `server.mjs` (API e SQLite), `spreadsheet.mjs` (Excel/CSV), `public/app.js` (interface e autosave), `public/flow.js` (navegação e saltos compartilhados), `public/style.css` (layout e impressão), `public/questionnaire.json` (instrumento versionado).

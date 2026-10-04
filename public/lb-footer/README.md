# Rodapé LB Conexão DEV

Copie a pasta `lb-footer` inteira para a pasta pública de qualquer site. Sem bibliotecas externas, fontes externas ou dependência do questionário.

No HTML, carregue o componente uma vez e insira a tag onde deseja o rodapé:

```html
<script type="module" src="/lb-footer/footer.js"></script>
<lb-dev-footer></lb-dev-footer>
```

Ajuste o caminho do script se o site estiver em uma subpasta. O logo, o CSS e o vídeo são encontrados automaticamente ao lado do script. O servidor deve disponibilizar os quatro arquivos (`footer.js`, `footer.css`, `logo.png` e `apresentacao.mp4`).

O ano é atualizado automaticamente. O vídeo aparece diretamente no rodapé e inicia automaticamente, sem som, repetindo cinco vezes e parando ao final. Recarregar a página inicia uma nova sequência de cinco reproduções; navegar entre as telas do questionário mantém o contador. Não é necessário clicar em um botão ou abrir um modal. O logo estático serve como poster enquanto o vídeo carrega. O CSS é isolado com Shadow DOM, para evitar conflitos com o restante do site. O componente não aparece na impressão.

Para ajustar as cores, use no CSS do seu site:

```css
lb-dev-footer {
  --lb-ink: #173f48;
  --lb-muted: #486268;
  --lb-accent: #205c65;
  --lb-line: #c6d5cf;
}
```

Para alterar os textos, edite `footer.js`. A assinatura identifica a LB Conexão DEV como desenvolvedora do site. Informações específicas do cliente ou projeto devem ficar fora deste componente.

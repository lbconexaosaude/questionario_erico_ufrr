// Componente independente: copie esta pasta e use <lb-dev-footer>.
const asset = name => new URL(name, import.meta.url).href;

class LBDevFooter extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <link rel="stylesheet" href="${asset('footer.css')}">
      <footer class="lb-footer" aria-label="Desenvolvimento do site por LB Conexão DEV">
        <div class="lb-identity">
          <video class="lb-logo" src="${asset('apresentacao.mp4')}" poster="${asset('logo.png')}" autoplay muted playsinline preload="auto" aria-label="Logo animado da LB Conexão DEV"></video>
          <div>
            <p class="lb-eyebrow">DESENVOLVIDO POR</p>
            <p class="lb-name">LB Conexão <span>DEV</span></p>
            <p class="lb-tagline">Tecnologia e Soluções Digitais</p>
          </div>
        </div>
        <div class="lb-signature">
          <p class="lb-copyright">© ${new Date().getFullYear()} LB Conexão DEV.<br>Todos os direitos reservados.</p>
        </div>
      </footer>`;
    const video = root.querySelector('video');
    let completedPlays = 0;
    // O contador pertence a esta página: navegar no questionário não o reinicia.
    // Ao recarregar a página, um novo componente começa suas cinco reproduções.
    video.muted = true;
    const play = () => video.play().catch(() => { /* Mantém o poster se o navegador bloquear a reprodução. */ });
    video.addEventListener('ended', () => {
      completedPlays++;
      if (completedPlays < 5 && this.isConnected) {
        video.currentTime = 0;
        play();
      }
    });
    play();
  }
  disconnectedCallback() { this.shadowRoot?.querySelector('video')?.pause(); }
}

if (!customElements.get('lb-dev-footer')) customElements.define('lb-dev-footer', LBDevFooter);

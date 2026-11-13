/* Trilha do balcão — música ambiente lo-fi gerada no próprio navegador (Web Audio API).
   Original, sem arquivo e sem direito autoral. Começa DESLIGADA: navegador não deixa tocar som
   sem clique. A escolha fica salva; se estava ligada, volta a tocar no primeiro clique na página.
   Liga/desliga pelo botão com id="btn-som". */
(function () {
  const LS = "vhs_som_v1";
  let ctx = null, mestre = null, tocando = false, timer = null, passo = 0;

  // Progressão lo-fi aconchegante (Fmaj7 – Em7 – Dm7 – Cmaj7), em Hz
  const nota = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const ACORDES = [
    [53, 57, 60, 64], // Fmaj7
    [52, 55, 59, 62], // Em7
    [50, 53, 57, 60], // Dm7
    [48, 52, 55, 59], // Cmaj7
  ];
  const DURACAO = 4.2; // segundos por acorde

  function iniciarAudio() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    mestre = ctx.createGain();
    mestre.gain.value = 0;
    // filtro "abafado" de fita
    const filtro = ctx.createBiquadFilter();
    filtro.type = "lowpass"; filtro.frequency.value = 1400; filtro.Q.value = 0.3;
    mestre.connect(filtro).connect(ctx.destination);
    chiadoVinil();
  }

  function voz(freq, inicio, dur, vol, tipo) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = tipo; o.frequency.value = freq;
    o.detune.value = (Math.random() - 0.5) * 8; // leve desafinado de fita
    g.gain.setValueAtTime(0, inicio);
    g.gain.linearRampToValueAtTime(vol, inicio + 0.9);
    g.gain.setTargetAtTime(0, inicio + dur - 0.6, 0.5);
    o.connect(g).connect(mestre);
    o.start(inicio); o.stop(inicio + dur + 2);
  }

  function tocarAcorde() {
    const t = ctx.currentTime + 0.05;
    const ac = ACORDES[passo % ACORDES.length];
    ac.forEach((m) => { voz(nota(m), t, DURACAO + 0.4, 0.05, "sine"); voz(nota(m + 12), t + 0.02, DURACAO, 0.012, "triangle"); });
    voz(nota(ac[0] - 12), t, DURACAO, 0.07, "sine"); // baixo
    // uma notinha de "piano" solta, de vez em quando
    if (Math.random() < 0.7) voz(nota(ac[Math.floor(Math.random() * 4)] + 12), t + 1.4 + Math.random(), 1.6, 0.025, "triangle");
    passo++;
  }

  function chiadoVinil() {
    const n = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() < 0.0008 ? (Math.random() * 2 - 1) * 0.6 : (Math.random() * 2 - 1) * 0.015;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); g.gain.value = 0.25;
    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1800;
    src.connect(hp).connect(g).connect(mestre);
    src.start();
  }

  function ligar() {
    if (!ctx) iniciarAudio();
    ctx.resume();
    mestre.gain.cancelScheduledValues(ctx.currentTime);
    mestre.gain.setTargetAtTime(0.5, ctx.currentTime, 1.2); // entra devagar
    if (!timer) { tocarAcorde(); timer = setInterval(tocarAcorde, DURACAO * 1000); }
    tocando = true; salvar(true); pintar();
  }
  function desligar() {
    if (ctx) mestre.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
    clearInterval(timer); timer = null;
    tocando = false; salvar(false); pintar();
  }
  window.__vhsSom = { estado: () => (ctx ? ctx.state : "sem-audio"), tocando: () => tocando };
  function salvar(v) { try { localStorage.setItem(LS, v ? "1" : "0"); } catch {} }
  function querSom() { try { return localStorage.getItem(LS) === "1"; } catch { return false; } }

  function pintar() {
    const b = document.getElementById("btn-som");
    if (!b) return;
    b.textContent = tocando ? "♪ SOM: LIGADO" : "♪ SOM";
    b.setAttribute("aria-pressed", String(tocando));
    b.title = tocando ? "Desligar a trilha do balcão" : "Ligar uma trilha suave de fundo";
  }

  let embutido = false;
  try { embutido = window.top !== window; } catch { embutido = true; }

  // Página de cima: atende os pedidos do chat embutido
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.vhsSom === "alternar") { tocando ? desligar() : ligar(); }
    if (e.data.vhsSom === "alternar" || e.data.vhsSom === "estado?") e.source.postMessage({ vhsSomEstado: tocando }, location.origin);
    if ("vhsSomEstado" in e.data) { tocando = !!e.data.vhsSomEstado; pintar(); } // (lado do chat embutido)
  });

  document.addEventListener("DOMContentLoaded", () => {
    const b = document.getElementById("btn-som");
    if (embutido) {
      // Dentro da home: não cria áudio próprio, só pede pra página de cima ligar/desligar
      if (b) b.addEventListener("click", (e) => { e.stopPropagation(); window.parent.postMessage({ vhsSom: "alternar" }, location.origin); });
      window.parent.postMessage({ vhsSom: "estado?" }, location.origin);
      return;
    }
    if (b) b.addEventListener("click", (e) => { e.stopPropagation(); tocando ? desligar() : ligar(); });
    pintar();
    // Estava ligado? Tenta voltar NA HORA (o navegador às vezes deixa, logo depois de um clique na página anterior);
    // se ele bloquear, volta no primeiro clique/tecla.
    if (querSom()) {
      try {
        ligar();
        // resume() é assíncrono: confere um instante depois se o navegador deixou tocar
        setTimeout(() => { if (ctx && ctx.state !== "running") { tocando = false; pintar(); } }, 400);
      } catch {}
      const retomar = () => { if (querSom() && (!tocando || ctx?.state !== "running")) ligar(); };
      document.addEventListener("pointerdown", retomar, { once: true });
      document.addEventListener("keydown", retomar, { once: true });
    }
  });
})();

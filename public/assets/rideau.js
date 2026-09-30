// Rideau de poudres de matières premières sur l'accueil : fermé à l'arrivée, il s'ouvre dès qu'on descend
// et se referme quand on remonte tout en haut. Chaque mouvement s'accompagne d'un bruit de poudre (Web Audio).

// [teinte sombre, teinte claire] de chaque poudre
const POUDRES = {
  cacao: ['#4e2c1a', '#8a5a3a'],
  or: ['#b8862e', '#f0d68a'],
  moringa: ['#5f6f24', '#a3b35a'],
  betterave: ['#7a1832', '#c24a66'],
  curcuma: ['#c0701a', '#f0b058'],
  baobab: ['#cfc09c', '#fff4dc'],
  spiruline: ['#1a4c3f', '#3f8a72'],
};
// Plis du rideau, du bord extérieur vers le centre
const PLIS = ['cacao', 'or', 'moringa', 'betterave', 'curcuma', 'or', 'baobab', 'spiruline', 'cacao', 'or'];
const DUREE = 1.5;          // secondes d ouverture
const SEUIL_OUVERTURE = 30; // arrivée déjà plus bas que ça : rideau ouvert d emblée

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { const A = rgb(a), B = rgb(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`; };
const assombrir = (h, k) => `rgb(${rgb(h).map(v => Math.round(v * (1 - k))).join(',')})`;
const hasard = (a, b) => a + Math.random() * (b - a);
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const sortie = t => 1 - Math.pow(1 - t, 3);

export function rideau() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.createElement('div');
  el.className = 'rideau';
    el.innerHTML = `<canvas aria-hidden="true"></canvas>
    <div class="rideau-c"><span class="logo">BIOCEZ</span><em>Naturellement plus loin</em>
      <button type="button" class="rideau-entrer">Entrer</button>
</div>
    <button type="button" class="rideau-son"></button>`;
  document.body.appendChild(el);
  const cv = el.querySelector('canvas'), ctx = cv.getContext('2d'), centre = el.querySelector('.rideau-c'), btnSon = el.querySelector('.rideau-son'), btnEntrer = el.querySelector('.rideau-entrer');

  // --- Son de poudre : bruit granuleux filtré, balayage montant à l'ouverture, descendant à la fermeture.
  let muet = false;
  try { muet = localStorage.getItem('biocez_son') === '0'; } catch {}
  let audio = null, grains = null;
  const debloquer = () => {
    if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } }
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  };
  ['pointerdown', 'keydown', 'touchend'].forEach(e => addEventListener(e, debloquer, { passive: true }));
  function son(ouverture) {
    if (muet || !audio || audio.state !== 'running') return;
    if (!grains) {
      grains = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
      const d = grains.getChannelData(0);
      // Bruit clairsemé : beaucoup de petits « grains » et quelques plus forts, comme du sable qui coule.
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < .03 ? 1 : .18);
    }
    const t = audio.currentTime, dur = 1.4;
    const src = audio.createBufferSource(); src.buffer = grains;
    const bp = audio.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = .7;
    bp.frequency.setValueAtTime(ouverture ? 700 : 4200, t);
    bp.frequency.exponentialRampToValueAtTime(ouverture ? 4200 : 700, t + dur);
    const hp = audio.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 250;
    const g = audio.createGain();
    g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(.32, t + .18);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    src.connect(bp).connect(hp).connect(g).connect(audio.destination);
    src.start(t); src.stop(t + dur + .05);
  }
  const majBouton = () => {
    btnSon.setAttribute('aria-label', muet ? 'Activer le son' : 'Couper le son');
    btnSon.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/>${muet ? '<path d="M17 9l5 6M22 9l-5 6"/>' : '<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'}</svg>`;
  };
  majBouton();
  btnSon.addEventListener('click', e => {
    e.stopPropagation(); muet = !muet; majBouton();
    try { localStorage.setItem('biocez_son', muet ? '0' : '1'); } catch {}
  });

  // --- Textures des deux moitiés (la droite est le miroir de la gauche)
  let W = 0, H = 0, w = 0, s = 1, texture = null, plis = [], chute = [];
  function tisser() {
    W = innerWidth; H = Math.max(innerHeight, document.documentElement.clientHeight) + 140;
    w = Math.ceil(W / 2); s = Math.min(devicePixelRatio || 1, W > 900 ? 1.25 : 2);
    cv.width = Math.round(W * s); cv.height = Math.round(H * s);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const t = document.createElement('canvas'); t.width = Math.ceil(w * s); t.height = Math.ceil(H * s);
    const x = t.getContext('2d');
    // Moins de plis sur petit écran pour qu'ils restent larges
    const noms = PLIS.slice(0, Math.max(5, Math.min(PLIS.length, Math.round(w / 90))));
    const larg = noms.map(() => hasard(.75, 1.35)), tot = larg.reduce((a, b) => a + b, 0);
    let pos = 0;
    plis = noms.map((nom, i) => { const x0 = pos; pos += larg[i] / tot * w; return { x0, x1: pos, c: POUDRES[nom] }; });
    // Texture calculée pixel par pixel (rapide) : couleur de base de chaque colonne, puis grains et coulures.
    const TW = t.width, TH = t.height, img = x.createImageData(TW, TH), px = img.data;
    const fondu = 10 * s; // les plis voisins se mélangent sur quelques pixels
    const base = new Float32Array(TW * 3), clair = new Float32Array(TW * 3), bord = new Float32Array(TW);
    const pli = cx => plis.findIndex(q => cx < q.x1 * s) === -1 ? plis.length - 1 : plis.findIndex(q => cx < q.x1 * s);
    for (let cx = 0; cx < TW; cx++) {
      const i = pli(cx), q = plis[i], a = q.x0 * s, b = q.x1 * s, u = (cx - a) / (b - a);
      const couleur = k => { const [d, l] = plis[k].c.map(rgb); const m = .3 + .35 * Math.sin(Math.PI * Math.min(1, Math.max(0, (cx - plis[k].x0 * s) / ((plis[k].x1 - plis[k].x0) * s)))); return [d.map((v, j) => v + (l[j] - v) * m), l]; };
      let [c, l] = couleur(i);
      // Mélange avec le pli voisin près des bords
      const k = cx - a < fondu && i > 0 ? i - 1 : b - cx < fondu && i < plis.length - 1 ? i + 1 : -1;
      if (k >= 0) { const f = .5 * (1 - Math.min(cx - a, b - cx) / fondu); const [c2, l2] = couleur(k); c = c.map((v, j) => v + (c2[j] - v) * f); l = l.map((v, j) => v + (l2[j] - v) * f); }
      base.set(c, cx * 3); clair.set(l, cx * 3);
      bord[cx] = (TW - cx) / s; // distance au bord central, en px
    }
    const coulee = new Float32Array(TW).map(() => hasard(.85, 1.1));
    for (let cy = 0; cy < TH; cy++) {
      const vy = cy / TH, ombre = vy < .18 ? .45 + .55 * vy / .18 : vy > .72 ? 1 - .5 * (vy - .72) / .28 : 1;
      for (let cx = 0; cx < TW; cx++) {
        // Coulures verticales : chaque colonne varie lentement, comme une poudre qui glisse
        let m = coulee[cx] += (Math.random() - .5) * .035; if (m < .72) coulee[cx] = .72; else if (m > 1.18) coulee[cx] = 1.18;
        const o = (cy * TW + cx) * 4, r = Math.random();
        let R, G, B;
        if (r < .004) { R = 247; G = 227; B = 164; }                                         // paillette dorée
        else if (r < .2) { const t2 = Math.random(); R = base[cx * 3] + (clair[cx * 3] - base[cx * 3]) * t2; G = base[cx * 3 + 1] + (clair[cx * 3 + 1] - base[cx * 3 + 1]) * t2; B = base[cx * 3 + 2] + (clair[cx * 3 + 2] - base[cx * 3 + 2]) * t2; } // grain clair
        else { const k = m * (.62 + .5 * Math.random()); R = base[cx * 3] * k; G = base[cx * 3 + 1] * k; B = base[cx * 3 + 2] * k; }
        px[o] = R * ombre; px[o + 1] = G * ombre; px[o + 2] = B * ombre;
        // Bord central effrité
        const d = bord[cx];
        px[o + 3] = d > 22 || Math.random() > Math.pow(1 - d / 22, 2.2) ? 255 : 0;
      }
    }
    x.putImageData(img, 0, 0);
    texture = t;
    // Poudre qui coule en continu le long du rideau
    chute = Array.from({ length: Math.round(Math.min(900, Math.max(180, w * H / 1500))) }, () => grain(true));
  }
  function grain(partout) {
    const x = Math.random() < .25 ? w - Math.random() * 30 : Math.random() * w;
    const p = plis.find(q => x < q.x1) ?? plis[plis.length - 1];
    return { x, y: partout ? Math.random() * H : hasard(-40, -2), v: hasard(50, 230), r: hasard(.7, 2.1), c: mix(p.c[0], p.c[1], hasard(.4, 1)) };
  }

  // --- Poussière soulevée quand le rideau bouge
  let poussiere = [];
  const COULEURS = Object.values(POUDRES).map(c => c[1]);
  function souffler(x, y, sens, n, fort = 1) {
    for (let i = 0; i < n && poussiere.length < 2600; i++) {
      poussiere.push({ x: x + hasard(-6, 6), y: y ?? Math.random() * innerHeight, vx: sens * hasard(10, 160) * fort + hasard(-40, 40), vy: hasard(-90, 30) * fort,
        r: hasard(.8, 2.8), c: COULEURS[Math.floor(Math.random() * COULEURS.length)], vie: hasard(.8, 2.2), age: 0 });
    }
  }

  // --- Animation
  let p = 0, cible = 0, avant = 0, boucle = 0;
  const visible = v => { el.style.visibility = v ? 'visible' : 'hidden'; };
  function image(t) {
    const dt = Math.min(.05, (t - (avant || t)) / 1000); avant = t;
    const ancien = p;
    if (p !== cible) p = cible > p ? Math.min(cible, p + dt / DUREE) : Math.max(cible, p - dt / DUREE);
    // Ouverture douce ; à la fermeture, les deux pans reviennent tout de suite puis ralentissent.
    const pos = q => cible === 1 ? ease(q) : 1 - sortie(1 - q);
    const e = pos(p), d = e * (w + 30), vitesse = Math.abs(e - pos(ancien)) / (dt || 1);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (p < 1) {
      const fond = Math.max(0, 1 - e * 5);
      if (fond > 0) { ctx.globalAlpha = fond; ctx.fillStyle = '#120d08'; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
      for (const g of chute) { g.y += g.v * dt; if (g.y > H) Object.assign(g, grain(false)); }
      for (const [tx, sx] of [[-d, 1], [W + d, -1]]) {
        ctx.save(); ctx.translate(tx, 0); ctx.scale(sx, 1);
        ctx.drawImage(texture, 0, 0, w, H);
        for (const g of chute) { ctx.globalAlpha = .85; ctx.fillStyle = g.c; ctx.fillRect(g.x, g.y, g.r, g.r * 2.2); }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      // Filet doré au centre quand le rideau est fermé
      if (e < .02) { const g = ctx.createLinearGradient(0, 0, 0, innerHeight); g.addColorStop(0, 'rgba(240,214,138,0)'); g.addColorStop(.5, 'rgba(240,214,138,.55)'); g.addColorStop(1, 'rgba(240,214,138,0)'); ctx.fillStyle = g; ctx.fillRect(W / 2 - .5, 0, 1, innerHeight); }
    }
    // La poudre s'échappe des bords intérieurs tant que le rideau bouge
    if (vitesse > .02 && p > 0 && p < 1) { const n = Math.min(60, Math.round(vitesse * 70)); souffler(w - d, null, -1, n / 2); souffler(W - w + d, null, 1, n / 2); }
    for (const q of poussiere) { q.age += dt; q.vy += 140 * dt; q.vx *= 1 - 1.2 * dt; q.x += q.vx * dt; q.y += q.vy * dt; }
    poussiere = poussiere.filter(q => q.age < q.vie && q.y < H);
    for (const q of poussiere) { ctx.globalAlpha = Math.max(0, 1 - q.age / q.vie) * .9; ctx.fillStyle = q.c; ctx.fillRect(q.x, q.y, q.r, q.r); }
    ctx.globalAlpha = 1;
    centre.style.opacity = String(Math.max(0, 1 - e * 6));
    btnSon.style.opacity = String(Math.max(0, 1 - e * 6));
    if (cible === 1 && p >= 1 && !poussiere.length) { visible(false); boucle = 0; return; }
    boucle = requestAnimationFrame(image);
  }
  const lancer = () => { if (!boucle) { avant = 0; boucle = requestAnimationFrame(image); } };
  function ouvrir() {
    if (cible === 1) return;
    cible = 1; el.classList.add('ouvert'); son(true);
    if (p === 0) souffler(W / 2, innerHeight * .5, 0, 420, 1.6);
    lancer();
  }
  function fermer() {
    if (cible === 0) return;
    cible = 0; el.classList.remove('ouvert'); visible(true); son(false); lancer();
  }

  tisser();
  // Arrivée déjà plus bas (lien #produits, retour en arrière) : le rideau reste ouvert.
  if (location.hash || scrollY > SEUIL_OUVERTURE) { p = cible = 1; el.classList.add('ouvert'); visible(false); }
  else lancer();

  // Une seule façon d'entrer : le bouton « Entrer » (ou la touche Entrée). Tant que le rideau n'est pas
  // ouvert, la page reste en haut ; elle s'ouvre directement sur le haut de l'accueil.
  const bloque = () => cible === 0 || p < 1;
  addEventListener('scroll', () => { if (bloque() && scrollY > 0) scrollTo(0, 0); }, { passive: true });
  addEventListener('wheel', e => { if (bloque()) e.preventDefault(); }, { passive: false });
  addEventListener('touchmove', e => { if (bloque()) e.preventDefault(); }, { passive: false });
  btnEntrer.addEventListener('click', e => { e.stopPropagation(); debloquer(); ouvrir(); });
  addEventListener('keydown', e => {
    if (!bloque()) return;
    if (e.key === 'Enter') { e.preventDefault(); debloquer(); ouvrir(); }
    else if (['ArrowDown', 'PageDown', ' ', 'End'].includes(e.key)) e.preventDefault();
  });
  let largeur = innerWidth, attente = 0;
  addEventListener('resize', () => {
    // Sur mobile, la barre d'adresse change la hauteur en permanence : on ne retisse que si la largeur change.
    if (innerWidth === largeur && innerHeight + 140 <= H) return;
    clearTimeout(attente); attente = setTimeout(() => { largeur = innerWidth; tisser(); if (el.style.visibility !== 'hidden') lancer(); }, 150);
  });
  return { ouvrir, fermer };
}

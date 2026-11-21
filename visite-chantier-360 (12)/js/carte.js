/* ============================================================
   carte.js — carte et plan : déplacement, zoom, repères, mesures
   ------------------------------------------------------------
   Deux fonds possibles, un seul moteur :
     - 'carte' : fonds de l'IGN (Géoplateforme, WMTS, Licence Ouverte)
                 plan IGN ou photographie aérienne
     - 'plan'  : une image importée (plan du bâtiment, de la toiture…)

   Coordonnées MONDE : unités du zoom 0, la carte du monde fait
   256 x 256. Pour un plan image, la largeur fait 256 et la hauteur
   256 x h/l. Tout (repères, mesures) est stocké dans ce repère, donc
   indépendant de l'écran et du niveau de zoom.

   Le nord est en haut, aussi bien sur la carte que sur le plan.
   ============================================================ */

export const COUCHES = {
  plan: { nom: 'Plan IGN', layer: 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', fmt: 'image/png', max: 19 },
  photo: { nom: 'Photo aérienne', layer: 'ORTHOIMAGERY.ORTHOPHOTOS', fmt: 'image/jpeg', max: 19 }
};

export function urlTuile(cle, z, x, y) {
  const c = COUCHES[cle] || COUCHES.plan;
  return 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
    + `&LAYER=${c.layer}&STYLE=normal&TILEMATRIXSET=PM&FORMAT=${encodeURIComponent(c.fmt)}`
    + `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;
}

/* ---------- géométrie ---------- */

const RAD = Math.PI / 180;
const R_TERRE = 6371008.8;

export function monde(lng, lat) {
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * RAD);
  return {
    x: (lng + 180) / 360 * 256,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256
  };
}

export function lngLat(x, y) {
  const n = Math.PI - 2 * Math.PI * (y / 256);
  return { lng: x / 256 * 360 - 180, lat: Math.atan(Math.sinh(n)) / RAD };
}

/** Distance en mètres entre deux points MONDE d'une carte (formule de haversine). */
export function distanceCarte(a, b) {
  const p = lngLat(a.x, a.y), q = lngLat(b.x, b.y);
  const dLat = (q.lat - p.lat) * RAD, dLng = (q.lng - p.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.lat * RAD) * Math.cos(q.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R_TERRE * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Surface en m² d'un polygone de points MONDE d'une carte (projection locale). */
export function surfaceCarte(pts) {
  if (pts.length < 3) return 0;
  const ll = pts.map((p) => lngLat(p.x, p.y));
  const lat0 = ll.reduce((s, p) => s + p.lat, 0) / ll.length;
  const kx = R_TERRE * RAD * Math.cos(lat0 * RAD), ky = R_TERRE * RAD;
  const m = ll.map((p) => ({ x: p.lng * kx, y: p.lat * ky }));
  let s = 0;
  for (let i = 0; i < m.length; i++) {
    const a = m[i], b = m[(i + 1) % m.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Cap en degrés (0 = nord, 90 = est) de a vers b, points MONDE. */
export function capVers(a, b) {
  return Math.atan2(b.x - a.x, -(b.y - a.y)) / RAD;
}

/** Distance en mètres dans un plan image : echelle = mètres par largeur d'image. */
export function distancePlan(a, b, echelle) {
  if (!echelle) return null;
  return Math.hypot(b.x - a.x, b.y - a.y) / 256 * echelle;
}
export function surfacePlan(pts, echelle) {
  if (!echelle || pts.length < 3) return null;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2 / (256 * 256) * echelle * echelle;
}

export function formaterM(m) {
  if (m == null || !isFinite(m)) return '—';
  if (m < 1) return Math.round(m * 100) + ' cm';
  if (m < 100) return m.toFixed(2).replace('.', ',') + ' m';
  if (m < 1000) return m.toFixed(1).replace('.', ',') + ' m';
  return (m / 1000).toFixed(3).replace('.', ',') + ' km';
}
export function formaterM2(s) {
  if (s == null || !isFinite(s)) return '—';
  if (s < 100) return s.toFixed(2).replace('.', ',') + ' m²';
  if (s < 10000) return Math.round(s).toLocaleString('fr-FR') + ' m²';
  return (s / 10000).toFixed(2).replace('.', ',') + ' ha';
}

/* ---------- la carte ---------- */

export class Carte {
  /**
   * @param {HTMLElement} el conteneur (taille donnée par le CSS)
   * @param {{mode?:'carte'|'plan', couche?:string, compact?:boolean}} opt
   */
  constructor(el, opt = {}) {
    this.el = el;
    this.mode = opt.mode || 'carte';
    this.couche = opt.couche || 'plan';
    this.compact = !!opt.compact;
    this.cx = 128; this.cy = 128; this.z = 14;
    this.minZ = this.mode === 'plan' ? -2 : 3;
    this.maxZ = this.mode === 'plan' ? 6 : 20;
    this.largeurImage = 256; this.hauteurImage = 192;
    this.marqueurs = [];
    this.formes = [];
    this.metre = null;           // (a, b) => mètres, fourni par l'appelant
    this.onTap = null;           // ({x,y}) => void
    this.onMarqueur = null;      // (id) => void
    this.onChange = null;
    this.interactif = opt.interactif !== false;
    this._tuiles = new Map();
    this._ptr = new Map();

    el.classList.add('carte', 'carte-map');
    if (this.compact) el.classList.add('compact');
    el.innerHTML = `<div class="c-fond"></div><svg class="c-svg"></svg><div class="c-marq"></div>
      <div class="c-attrib"></div>`;
    this.fond = el.querySelector('.c-fond');
    this.svg = el.querySelector('.c-svg');
    this.zoneMarq = el.querySelector('.c-marq');
    this.attrib = el.querySelector('.c-attrib');
    this._majAttrib();

    if (this.interactif) this._gestes();
    this._ro = new ResizeObserver(() => this.redimensionner());
    this._ro.observe(el);
    this.redimensionner();
  }

  detruire() {
    this._ro && this._ro.disconnect();
    if (this._urlImage) URL.revokeObjectURL(this._urlImage);
    this.el.innerHTML = '';
  }

  _majAttrib() {
    this.attrib.textContent = this.mode === 'carte' ? '© IGN — Géoplateforme' : '';
  }

  redimensionner() {
    const r = this.el.getBoundingClientRect();
    this.L = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.rendre();
  }

  /* ----- fonds ----- */

  setCouche(cle) {
    this.couche = cle;
    for (const t of this._tuiles.values()) t.img.remove();
    this._tuiles.clear();
    this.rendre();
  }

  /** Fond image (plan). Retourne la taille de l'image. */
  async setImage(blob) {
    if (this._urlImage) URL.revokeObjectURL(this._urlImage);
    this._urlImage = URL.createObjectURL(blob);
    const img = new Image();
    img.className = 'c-plan';
    img.draggable = false;
    await new Promise((ok, ko) => { img.onload = ok; img.onerror = () => ko(new Error('Plan illisible')); img.src = this._urlImage; });
    this.fond.innerHTML = '';
    this.fond.appendChild(img);
    this.imgEl = img;
    this.largeurImage = 256;
    this.hauteurImage = 256 * img.naturalHeight / img.naturalWidth;
    this.ratioImage = img.naturalHeight / img.naturalWidth;
    this.ajuster();
    return { w: img.naturalWidth, h: img.naturalHeight };
  }

  /** Cadre le plan entier. */
  ajuster() {
    if (this.mode !== 'plan') return;
    this.cx = this.largeurImage / 2; this.cy = this.hauteurImage / 2;
    const zl = Math.log2(this.L / this.largeurImage);
    const zh = Math.log2(this.H / this.hauteurImage);
    this.z = Math.min(zl, zh) - 0.05;
    this.rendre();
  }

  /** Cadre un ensemble de points MONDE. */
  cadrer(pts, margePx = 40) {
    if (!pts.length) return;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
    const dx = Math.max(x1 - x0, 1e-6), dy = Math.max(y1 - y0, 1e-6);
    const z = Math.min(Math.log2((this.L - 2 * margePx) / dx), Math.log2((this.H - 2 * margePx) / dy));
    this.z = Math.max(this.minZ, Math.min(this.mode === 'carte' ? 19 : this.maxZ, z));
    this.rendre();
  }

  centrer(x, y, z) {
    this.cx = x; this.cy = y;
    if (z != null) this.z = Math.max(this.minZ, Math.min(this.maxZ, z));
    this.rendre();
  }

  /* ----- conversions ----- */

  versEcran(p) {
    const k = 2 ** this.z;
    return { x: (p.x - this.cx) * k + this.L / 2, y: (p.y - this.cy) * k + this.H / 2 };
  }
  depuisEcran(x, y) {
    const k = 2 ** this.z;
    return { x: (x - this.L / 2) / k + this.cx, y: (y - this.H / 2) / k + this.cy };
  }

  /* ----- rendu ----- */

  rendre() {
    if (!this.L) return;
    const k = 2 ** this.z;
    if (this.mode === 'plan') {
      if (this.imgEl) {
        const p = this.versEcran({ x: 0, y: 0 });
        const s = this.imgEl.style;
        s.left = p.x + 'px'; s.top = p.y + 'px';
        s.width = this.largeurImage * k + 'px'; s.height = this.hauteurImage * k + 'px';
      }
    } else {
      this._rendreTuiles(k);
    }
    this._rendreMarqueurs();
    this._rendreFormes();
    this.onChange && this.onChange(this);
  }

  _rendreTuiles(k) {
    const maxZt = COUCHES[this.couche].max;
    const zt = Math.max(0, Math.min(maxZt, Math.round(this.z)));
    const n = 2 ** zt, taille = 256 / n;
    const p0 = this.depuisEcran(0, 0), p1 = this.depuisEcran(this.L, this.H);
    const tx0 = Math.max(0, Math.floor(p0.x / taille)), tx1 = Math.min(n - 1, Math.floor(p1.x / taille));
    const ty0 = Math.max(0, Math.floor(p0.y / taille)), ty1 = Math.min(n - 1, Math.floor(p1.y / taille));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 120) return;

    const voulues = new Set();
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const cle = `${this.couche}/${zt}/${tx}/${ty}`;
        voulues.add(cle);
        let t = this._tuiles.get(cle);
        if (!t) {
          const img = document.createElement('img');
          img.className = 'c-tuile';
          img.draggable = false;
          img.alt = '';
          img.style.zIndex = String(zt);
          t = { img, zt, charge: false };
          img.onload = () => { t.charge = true; this._purger(zt); };
          img.onerror = () => { img.style.visibility = 'hidden'; };
          img.src = urlTuile(this.couche, zt, tx, ty);
          this.fond.appendChild(img);
          this._tuiles.set(cle, t);
        }
        const e = this.versEcran({ x: tx * taille, y: ty * taille });
        const s = t.img.style, px = 256 * (2 ** (this.z - zt));
        s.left = Math.round(e.x) + 'px'; s.top = Math.round(e.y) + 'px';
        s.width = px + 0.6 + 'px'; s.height = px + 0.6 + 'px';
      }
    }
    // tuiles d'un autre zoom : replacées aussi, retirées quand les nouvelles sont chargées
    for (const [cle, t] of this._tuiles) {
      if (voulues.has(cle)) continue;
      const [c, z, x, y] = cle.split('/');
      if (c !== this.couche) { t.img.remove(); this._tuiles.delete(cle); continue; }
      const tz = +z, tt = 256 / (2 ** tz);
      const e = this.versEcran({ x: +x * tt, y: +y * tt });
      const px = 256 * (2 ** (this.z - tz));
      const s = t.img.style;
      s.left = Math.round(e.x) + 'px'; s.top = Math.round(e.y) + 'px';
      s.width = px + 0.6 + 'px'; s.height = px + 0.6 + 'px';
    }
    this._zt = zt;
    if (this._tuiles.size > 260) this._purger(zt, true);
  }

  _purger(zt, force = false) {
    if (zt !== this._zt && !force) return;
    let tousCharges = true;
    for (const [cle, t] of this._tuiles) if (t.zt === this._zt && !t.charge && t.img.style.visibility !== 'hidden') tousCharges = false;
    if (!tousCharges && !force) return;
    for (const [cle, t] of this._tuiles) {
      if (t.zt !== this._zt) { t.img.remove(); this._tuiles.delete(cle); }
    }
  }

  _rendreMarqueurs() {
    const z = this.zoneMarq;
    const vus = new Set();
    for (const m of this.marqueurs) {
      vus.add(m.id);
      let d = z.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
      if (!d) {
        d = document.createElement('div');
        d.dataset.id = m.id;
        d.innerHTML = `<div class="cone"></div><div class="pastille-m"></div>`;
        d.onpointerdown = (e) => e.stopPropagation();
        d.onclick = (e) => { e.stopPropagation(); this.onMarqueur && this.onMarqueur(m.id); };
        z.appendChild(d);
      }
      d.className = 'c-m' + (m.courant ? ' courant' : '') + (m.sansPosition ? ' sans' : '') + (m.classe ? ' ' + m.classe : '');
      d.querySelector('.pastille-m').textContent = m.texte != null ? m.texte : '';
      const cone = d.querySelector('.cone');
      cone.style.display = m.cap != null ? '' : 'none';
      if (m.cap != null) cone.style.transform = `translate(-50%,-50%) rotate(${m.cap}deg)`;
      const e = this.versEcran(m);
      d.style.transform = `translate(${e.x}px, ${e.y}px)`;
    }
    for (const d of [...z.children]) if (!vus.has(d.dataset.id)) d.remove();
  }

  _rendreFormes() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = this.svg;
    svg.setAttribute('width', this.L); svg.setAttribute('height', this.H);
    svg.innerHTML = '';
    for (const f of this.formes) {
      if (!f.pts.length) continue;
      const E = f.pts.map((p) => this.versEcran(p));
      const couleur = f.couleur || '#2fd0b8';
      const chemin = E.map((e) => `${e.x},${e.y}`).join(' ');
      if (f.ferme && E.length >= 3) {
        const poly = document.createElementNS(NS, 'polygon');
        poly.setAttribute('points', chemin);
        poly.setAttribute('fill', couleur); poly.setAttribute('fill-opacity', '0.22');
        poly.setAttribute('stroke', couleur); poly.setAttribute('stroke-width', '2.5');
        svg.appendChild(poly);
      } else if (E.length >= 2) {
        const ln = document.createElementNS(NS, 'polyline');
        ln.setAttribute('points', chemin); ln.setAttribute('fill', 'none');
        ln.setAttribute('stroke', couleur); ln.setAttribute('stroke-width', '2.5');
        svg.appendChild(ln);
      }
      const n = E.length;
      const segs = f.ferme && n >= 3 ? n : n - 1;
      if (this.metre && !f.sansCotes) {
        for (let i = 0; i < segs; i++) {
          const a = f.pts[i], b = f.pts[(i + 1) % n];
          const m = this.metre(a, b);
          if (m == null) continue;
          const ea = E[i], eb = E[(i + 1) % n];
          this._texte(svg, (ea.x + eb.x) / 2, (ea.y + eb.y) / 2 - 7, formaterM(m), couleur);
        }
      }
      for (const e of E) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', e.x); c.setAttribute('cy', e.y); c.setAttribute('r', 5);
        c.setAttribute('fill', '#0e1013'); c.setAttribute('stroke', couleur); c.setAttribute('stroke-width', '2.5');
        svg.appendChild(c);
      }
      if (f.etiquette) {
        const cx = E.reduce((s, e) => s + e.x, 0) / n, cy = E.reduce((s, e) => s + e.y, 0) / n;
        this._texte(svg, cx, cy, f.etiquette, couleur, 15);
      }
    }
  }

  _texte(svg, x, y, txt, couleur, taille = 12) {
    const NS = 'http://www.w3.org/2000/svg';
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', taille); t.setAttribute('font-weight', '700');
    t.setAttribute('fill', '#fff'); t.setAttribute('stroke', 'rgba(8,10,12,.85)');
    t.setAttribute('stroke-width', '3.5'); t.setAttribute('paint-order', 'stroke');
    t.textContent = txt;
    svg.appendChild(t);
  }

  /* ----- gestes ----- */

  _zoomerVers(facteurLog, ex, ey) {
    const avant = this.depuisEcran(ex, ey);
    this.z = Math.max(this.minZ, Math.min(this.maxZ, this.z + facteurLog));
    const apres = this.depuisEcran(ex, ey);
    this.cx += avant.x - apres.x; this.cy += avant.y - apres.y;
    this.rendre();
  }
  zoomer(d) { this._zoomerVers(d, this.L / 2, this.H / 2); }

  _gestes() {
    const el = this.el;
    let depart = null, pinch = null;
    const pos = (e) => { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this._ptr.set(e.pointerId, pos(e));
      if (this._ptr.size === 1) {
        const p = pos(e);
        depart = { x: p.x, y: p.y, cx: this.cx, cy: this.cy, t: performance.now(), bouge: false };
      } else if (this._ptr.size === 2) {
        const [a, b] = [...this._ptr.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.z };
        if (depart) depart.bouge = true;
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._ptr.has(e.pointerId)) return;
      this._ptr.set(e.pointerId, pos(e));
      if (this._ptr.size === 2 && pinch) {
        const [a, b] = [...this._ptr.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const cible = pinch.z + Math.log2(d / Math.max(1, pinch.d));
        this._zoomerVers(cible - this.z, mx, my);
      } else if (this._ptr.size === 1 && depart) {
        const p = pos(e);
        const dx = p.x - depart.x, dy = p.y - depart.y;
        if (!depart.bouge && Math.hypot(dx, dy) < 6) return;
        depart.bouge = true;
        const k = 2 ** this.z;
        this.cx = depart.cx - dx / k; this.cy = depart.cy - dy / k;
        this.rendre();
      }
    });
    const fin = (e) => {
      const p = this._ptr.get(e.pointerId);
      this._ptr.delete(e.pointerId);
      if (this._ptr.size < 2) pinch = null;
      if (depart && this._ptr.size === 0) {
        if (!depart.bouge && performance.now() - depart.t < 600 && p && e.type === 'pointerup') {
          this.onTap && this.onTap(this.depuisEcran(p.x, p.y));
        }
        depart = null;
      }
    };
    el.addEventListener('pointerup', fin);
    el.addEventListener('pointercancel', fin);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      this._zoomerVers(-Math.sign(e.deltaY) * 0.5, p.x, p.y);
    }, { passive: false });
  }
}

/* ---------- recherche d'adresse (géocodeur IGN) ---------- */

export async function chercherAdresse(q) {
  const r = await fetch('https://data.geopf.fr/geocodage/search?limit=5&q=' + encodeURIComponent(q));
  if (!r.ok) throw new Error('Recherche indisponible (' + r.status + ')');
  const j = await r.json();
  return (j.features || []).map((f) => ({
    libelle: f.properties.label,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1]
  }));
}

/** Position GPS ponctuelle ; null si refusée ou trop lente. */
export function positionGPS(delaiMs = 6000) {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    let fini = false;
    const t = setTimeout(() => { if (!fini) { fini = true; ok(null); } }, delaiMs + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => { if (fini) return; fini = true; clearTimeout(t); ok({ lng: p.coords.longitude, lat: p.coords.latitude, precision: p.coords.accuracy }); },
      () => { if (fini) return; fini = true; clearTimeout(t); ok(null); },
      { enableHighAccuracy: true, timeout: delaiMs, maximumAge: 30000 }
    );
  });
}

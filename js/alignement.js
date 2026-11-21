/* ============================================================
   alignement.js — Recalage des prises par comparaison d'images
   ------------------------------------------------------------
   POURQUOI
   Placer chaque photo d'après le seul gyroscope donne une mosaïque
   dont les morceaux ne se raccordent pas : le gyroscope d'un
   téléphone se trompe de 1 à 3°, l'angle de vue réel de la caméra
   n'est pas connu, et à main levée la photo tourne autour du corps
   et non autour de l'objectif. Les logiciels d'assemblage sérieux
   ne s'y fient donc pas : ils comparent les images entre elles.

   COMMENT
   1. Chaque prise est réduite à une vignette en niveaux de gris.
   2. Angle de vue : on essaie plusieurs valeurs et on garde celle
      pour laquelle les photos voisines coïncident le mieux.
   3. Les prises sont posées une à une sur une sphère de travail,
      en commençant par l'horizon puis de proche en proche. Pour
      chacune, on cherche la petite rotation (panoramique,
      inclinaison, roulis) qui la fait le mieux coïncider avec ce
      qui est déjà posé, par corrélation normalisée (insensible aux
      écarts d'exposition).
   4. Une prise sans repère exploitable (mur blanc, ciel) garde la
      position donnée par le gyroscope : mieux vaut un petit écart
      qu'un recalage sur du bruit.

   LIMITE : la parallaxe. Un objet proche ne se voit pas du même
   endroit si la photo est prise depuis un point différent ; aucune
   rotation ne peut alors faire coïncider le proche et le lointain.
   La seule parade est à la prise de vue : faire pivoter le
   téléphone sur lui-même, au même point de l'espace.
   ============================================================ */

const D2R = Math.PI / 180;

/* ---------- matrices 3x3 en lignes ---------- */
function mul(A, B) {
  return [
    A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
    A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
    A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8]
  ];
}
const rotX = (t) => { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const rotY = (t) => { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const rotZ = (t) => { const c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1]; };

/** Orientation corrigée : petite rotation exprimée dans les axes de l'appareil. */
export function corriger(R, inclinaison, panoramique, roulis) {
  return mul(R, mul(rotX(inclinaison * D2R), mul(rotY(panoramique * D2R), rotZ(roulis * D2R))));
}

/** Direction visée (avant de l'objectif) dans le repère terrestre. */
function visee(R) { return [-R[2], -R[5], -R[8]]; }

/* ---------- vignette en niveaux de gris ---------- */
const _toile = document.createElement('canvas');
export const LARGEUR_VIGNETTE = 96;

/** Réduit une image à LARGEUR_VIGNETTE px de large, en luminance 0..1. */
export function vignetteGrise(image) {
  const w = LARGEUR_VIGNETTE;
  const h = Math.round(w * image.height / image.width);
  _toile.width = w; _toile.height = h;
  const ctx = _toile.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  return { w, h, g };
}

/* ---------- rayons de la vignette pour un angle de vue donné ---------- */
function rayons(w, h, fovH) {
  const tH = Math.tan(fovH / 2 * D2R);
  const tV = tH * h / w;
  const r = new Float32Array(w * h * 3), poids = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = ((x + 0.5) / w) * 2 - 1, py = 1 - ((y + 0.5) / h) * 2;
    const dx = px * tH, dy = py * tV, n = Math.hypot(dx, dy, 1);
    const k = y * w + x;
    r[k * 3] = dx / n; r[k * 3 + 1] = dy / n; r[k * 3 + 2] = -1 / n;
    poids[k] = (1 - px * px) * (1 - py * py);
  }
  return { r, poids };
}

/* ---------- sphère de travail ---------- */
const MW = 600, MH = 300;   // 0,6° par pixel

class Mosaique {
  constructor() { this.somme = new Float32Array(MW * MH); this.poids = new Float32Array(MW * MH); }

  /** Indice dans la sphère de la direction (repère appareil) tournée par M. */
  static indice(M, dx, dy, dz) {
    const X = M[0] * dx + M[1] * dy + M[2] * dz;
    const Y = M[3] * dx + M[4] * dy + M[5] * dz;
    const Z = M[6] * dx + M[7] * dy + M[8] * dz;
    let u = Math.atan2(X, Y) / (2 * Math.PI) + 0.5;
    const v = 0.5 - Math.asin(Z > 1 ? 1 : Z < -1 ? -1 : Z) / Math.PI;
    let ix = (u * MW) | 0; if (ix >= MW) ix -= MW;
    let iy = (v * MH) | 0; if (iy >= MH) iy = MH - 1;
    return iy * MW + ix;
  }

  /** Corrélation normalisée entre la prise placée par M et la sphère déjà posée. */
  score(prise, M, ray, pas) {
    const { g } = prise.vignette;
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let k = 0; k < g.length; k += pas) {
      const i = Mosaique.indice(M, ray.r[k * 3], ray.r[k * 3 + 1], ray.r[k * 3 + 2]);
      const p = this.poids[i];
      if (p <= 0) continue;
      const a = g[k], b = this.somme[i] / p;
      n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    if (n < 120 / pas) return { ncc: null, n };
    const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    // zone sans contraste (mur uni, ciel) : pas de recalage possible
    if (va < 1e-4 * n || vb < 1e-4 * n) return { ncc: null, n };
    return { ncc: cov / Math.sqrt(va * vb), n };
  }

  poser(prise, M, ray, gain = prise.gain) {
    const { g } = prise.vignette;
    for (let k = 0; k < g.length; k++) {
      const i = Mosaique.indice(M, ray.r[k * 3], ray.r[k * 3 + 1], ray.r[k * 3 + 2]);
      const w = ray.poids[k];
      this.somme[i] += g[k] * gain * w;
      this.poids[i] += w;
    }
  }

  /**
   * Gain qui accorde la prise, placée par M, à ce qui est déjà posé : rapport
   * des luminosités moyennes sur la zone commune. Plus juste que la luminosité
   * moyenne de toute l'image : une photo qui découvre une fenêtre n'est pas
   * pour autant surexposée.
   */
  gainSurRecouvrement(prise, M, ray, gain) {
    const { g } = prise.vignette;
    let sm = 0, sp = 0, n = 0;
    for (let k = 0; k < g.length; k++) {
      const i = Mosaique.indice(M, ray.r[k * 3], ray.r[k * 3 + 1], ray.r[k * 3 + 2]);
      const p = this.poids[i];
      if (p <= 0) continue;
      sm += this.somme[i] / p; sp += g[k] * gain; n++;
    }
    if (n < 150 || sp < 1e-3) return gain;
    return gain * Math.max(0.75, Math.min(1.33, sm / sp));
  }
}

/* ---------- ordre de pose : horizon d'abord, puis de proche en proche ---------- */
function ordreDePose(prises) {
  const f = prises.map((p) => visee(p.R));
  const restant = new Set(prises.map((_, i) => i));
  let premier = 0, mini = Infinity;
  for (const i of restant) { const s = Math.abs(f[i][2]); if (s < mini) { mini = s; premier = i; } }
  const ordre = [premier]; restant.delete(premier);
  while (restant.size) {
    let meilleur = null, proche = -2;
    for (const i of restant) {
      for (const j of ordre) {
        const d = f[i][0] * f[j][0] + f[i][1] * f[j][1] + f[i][2] * f[j][2];
        if (d > proche) { proche = d; meilleur = i; }
      }
    }
    ordre.push(meilleur); restant.delete(meilleur);
  }
  return ordre;
}

/* ---------- recherche de la correction d'une prise ---------- */
// Par degré de correction. Le gyroscope est bruité mais il ne dérive pas d'une
// prise à l'autre, alors qu'un recalage de proche en proche reprend à chaque
// pas le petit biais d'un angle de vue imparfait : sur un tour d'horizon, ces
// biais s'additionnaient jusqu'à 8°. On retient donc chaque prise près du
// gyroscope ; seule une coïncidence nettement meilleure justifie de s'en écarter.
const PENALITE = 0.015;

function chercher(mosaique, prise, ray, etapes) {
  let c = [0, 0, 0];   // inclinaison, panoramique, roulis
  const evaluer = (cc, pas) => {
    const s = mosaique.score(prise, corriger(prise.R, cc[0], cc[1], cc[2]), ray, pas);
    if (s.ncc == null) return null;
    return s.ncc - PENALITE * (Math.abs(cc[0]) + Math.abs(cc[1]) + Math.abs(cc[2]));
  };
  let meilleur = evaluer(c, 2);
  if (meilleur == null) return null;
  for (const { portee, pas, roulis, echant } of etapes) {
    for (const axe of [1, 0, 2, 1]) {
      const p = axe === 2 ? roulis : portee;
      for (let d = -p; d <= p + 1e-9; d += pas) {
        if (Math.abs(d) < 1e-9) continue;
        const t = c.slice(); t[axe] += d;
        const s = evaluer(t, echant);
        if (s != null && s > meilleur) { meilleur = s; c = t; }
      }
    }
  }
  return { correction: c, score: meilleur + PENALITE * (Math.abs(c[0]) + Math.abs(c[1]) + Math.abs(c[2])) };
}

const ETAPES_COMPLETES = [
  { portee: 4.5, pas: 1.5, roulis: 3, echant: 2 },
  { portee: 1.5, pas: 0.5, roulis: 1, echant: 2 },
  { portee: 0.5, pas: 0.25, roulis: 0.5, echant: 1 }
];
const ETAPES_RAPIDES = [
  { portee: 4, pas: 2, roulis: 2, echant: 3 },
  { portee: 1.5, pas: 0.75, roulis: 1.5, echant: 2 }
];
const SEUIL_CONFIANCE = 0.35;

/** Aligne toutes les prises pour un angle de vue donné. */
async function alignerAvec(prises, fovH, etapes, surProgres) {
  const ray = rayons(prises[0].vignette.w, prises[0].vignette.h, fovH);
  const mosaique = new Mosaique();
  const ordre = ordreDePose(prises);
  const res = prises.map((p) => ({ R: p.R, score: null, recale: false, gain: p.gain }));
  let somme = 0, compte = 0;

  for (let n = 0; n < ordre.length; n++) {
    const i = ordre[n], p = prises[i];
    if (n > 0) {
      const r = chercher(mosaique, p, ray, etapes);
      if (r && r.score >= SEUIL_CONFIANCE) {
        res[i] = { R: corriger(p.R, ...r.correction), score: r.score, recale: true, correction: r.correction, gain: p.gain };
      } else if (r) {
        res[i].score = r.score;
      }
      if (r) { somme += r.score; compte++; }
      res[i].gain = mosaique.gainSurRecouvrement(p, res[i].R, ray, p.gain);
    }
    mosaique.poser(p, res[i].R, ray, res[i].gain);
    if (surProgres) { surProgres(n + 1, ordre.length); await new Promise((ok) => setTimeout(ok, 0)); }
  }
  return { orientations: res, qualite: compte ? somme / compte : null };
}

/**
 * Angle de vue horizontal, mesuré sur les images.
 *
 * Une erreur d'angle de vue décale tout le recouvrement de deux photos
 * voisines d'un même bloc ; le recalage l'absorbe en tournant la seconde
 * photo, et la coïncidence redevient bonne. Juger l'angle à la qualité de la
 * coïncidence ne marche donc pas : elle est presque la même pour tous les
 * angles. Ce qui le trahit, c'est le SENS des corrections. Avec le bon angle,
 * la correction de panoramique entre deux voisines n'est que le bruit du
 * gyroscope, tantôt à gauche, tantôt à droite. Avec un angle trop petit ou
 * trop grand, elles partent toutes du même côté, proportionnellement à
 * l'écart entre les deux prises. On cherche l'angle qui annule ce biais.
 */
function biaisPanoramique(paires, fov) {
  const rapports = [];
  for (const [A, B, ecartDeg] of paires) {
    const ray = rayons(A.vignette.w, A.vignette.h, fov);
    const m = new Mosaique();
    m.poser(A, A.R, ray);
    // recherche libre (sans retenue vers le gyroscope) de la panoramique de B
    let meilleur = null, pan = 0;
    for (const [portee, pas] of [[8, 1], [1, 0.25]]) {
      const centre = pan;
      for (let d = -portee; d <= portee + 1e-9; d += pas) {
        const r = m.score(B, corriger(B.R, 0, centre + d, 0), ray, 1);
        // légère préférence pour la plus petite correction : face à un motif qui
        // se répète (carrelage, garde-corps, fenêtres), plusieurs décalages
        // coïncident presque aussi bien, et le plus proche est le vrai
        const v = r.ncc == null ? null : r.ncc - 0.004 * Math.abs(centre + d);
        if (v != null && (meilleur == null || v > meilleur)) { meilleur = v; pan = centre + d; }
      }
    }
    if (meilleur != null && meilleur + 0.004 * Math.abs(pan) >= SEUIL_CONFIANCE) rapports.push(pan / ecartDeg);
  }
  if (rapports.length < 3) return null;
  rapports.sort((a, b) => a - b);
  return rapports[rapports.length >> 1];   // médiane : insensible aux paires aberrantes
}

async function estimerChamp(prises, fovDefaut, surProgres) {
  // paires de voisines sur l'horizon, dans l'ordre du tour
  const horizon = prises
    .map((p) => { const f = visee(p.R); return { p, az: Math.atan2(f[0], f[1]) / D2R, site: Math.asin(f[2]) / D2R }; })
    .filter((x) => Math.abs(x.site) < 25)
    .sort((a, b) => a.az - b.az);
  const paires = [];
  for (let i = 0; i < horizon.length; i++) {
    const a = horizon[i], b = horizon[(i + 1) % horizon.length];
    let ecart = b.az - a.az; if (ecart <= 0) ecart += 360;
    if (ecart > 5 && ecart < 60) paires.push([a.p, b.p, ecart]);
  }
  const essais = [];
  const mesurer = async (fov) => {
    const b = biaisPanoramique(paires, fov);
    essais.push({ fov, biais: b });
    if (surProgres) surProgres(essais.length);
    await new Promise((ok) => setTimeout(ok, 0));
    return b;
  };
  if (paires.length < 3) return { fovH: fovDefaut, fiable: false, essais };

  // le biais varie régulièrement avec l'angle : méthode de la sécante
  let f1 = 46, f2 = 66;
  let b1 = await mesurer(f1), b2 = await mesurer(f2);
  if (b1 == null || b2 == null || b1 === b2) return { fovH: fovDefaut, fiable: false, essais };
  for (let iter = 0; iter < 4; iter++) {
    let f3 = f2 - b2 * (f2 - f1) / (b2 - b1);
    f3 = Math.max(36, Math.min(90, f3));
    const b3 = await mesurer(f3);
    if (b3 == null) break;
    f1 = f2; b1 = b2; f2 = f3; b2 = b3;
    if (Math.abs(b3) < 0.004 || b1 === b2) break;
  }
  const fov = Math.round(f2 * 10) / 10;
  // un résultat hors de toute caméra de téléphone trahit des images sans repères
  if (fov <= 36.5 || fov >= 89.5) return { fovH: fovDefaut, fiable: false, essais };
  return { fovH: fov, fiable: true, essais };
}

/**
 * Traitement complet.
 * @param prises [{ R: matrice appareil->terre (9, en lignes), gain, vignette: {w,h,g} }]
 * @param options { fovDefaut, estimerLeChamp, surEtape(texte, fraction) }
 */
export async function traiter(prises, options = {}) {
  const { fovDefaut = 52, estimerLeChamp = true, surEtape = () => {} } = options;
  let champ = { fovH: fovDefaut, fiable: false, qualite: null };

  if (estimerLeChamp && prises.length >= 4) {
    surEtape('Mesure de l\'angle de vue de la caméra', 0);
    champ = await estimerChamp(prises, fovDefaut, (k) => surEtape('Mesure de l\'angle de vue de la caméra', Math.min(0.45, k / 6 * 0.45)));
  }

  surEtape('Recalage des photos entre elles', 0.45);
  const r = await alignerAvec(prises, champ.fovH, ETAPES_COMPLETES,
    (k, n) => surEtape('Recalage des photos entre elles', 0.45 + 0.55 * k / n));

  const recalees = r.orientations.filter((o) => o.recale).length;
  return {
    fovH: champ.fovH,
    champFiable: champ.fiable,
    essaisChamp: champ.essais || [],
    orientations: r.orientations.map((o) => o.R),
    gains: r.orientations.map((o) => o.gain),
    recalees,
    total: prises.length,
    qualite: r.qualite
  };
}

/* accès aux rouages, pour les essais */
export const _interne = { biaisPanoramique, rayons, Mosaique, corriger, visee };

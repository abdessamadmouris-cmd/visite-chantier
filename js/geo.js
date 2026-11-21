/* ============================================================
   geo.js — Géométrie de mesure dans une panoramique équirectangulaire
   ------------------------------------------------------------
   PRINCIPE
   Une panoramique 360x180 prise depuis un point fixe donne, pour chaque
   pixel, une direction exacte dans l'espace (azimut + site). Elle ne donne
   aucune distance. Mais si on connaît la hauteur de l'objectif au-dessus
   du sol (hc), toute direction qui pointe vers le bas coupe le plan du sol
   en un point unique : on retrouve donc les coordonnées réelles de tout
   point posé au sol, et par conséquent les distances entre eux.

   Repère : origine = objectif. Y vers le haut. Plan du sol : y = -hc.
     azimut  a (rad) : 0 = axe de prise de vue, + vers la droite
     site    e (rad) : 0 = horizon, + vers le haut, -pi/2 = nadir
     direction : d = (cos(e)sin(a), sin(e), cos(e)cos(a))

   PORTEE ET LIMITES — à lire avant de coter un ouvrage
   - Point au sol : exact si le sol est plan et horizontal, et si hc est juste.
   - Hauteur (acrotère, linteau, allège) : on vise le pied de l'ouvrage
     (au sol, qui donne la distance) puis le haut. Le haut doit être à
     l'aplomb du pied.
   - L'erreur est proportionnelle à hc : 1 cm d'erreur sur la hauteur
     d'objectif donne environ 0,6 % d'erreur sur les distances.
   - L'erreur croît très vite quand le point visé s'éloigne : près de
     l'horizon (site faible) la précision s'effondre. On avertit au-delà
     d'un rapport distance/hauteur de 8.
   - L'horizon de la panoramique doit être au milieu de l'image. Un
     décalage se corrige par le réglage "horizon" de la station.
   ============================================================ */

export const DEG = 180 / Math.PI;

/* ---------- conversions pixel <-> direction ---------- */

/**
 * Coordonnées image normalisées -> angles.
 * @param {number} u 0..1 de gauche à droite
 * @param {number} v 0..1 de haut en bas
 * @param {number} horizonOffset décalage d'horizon en fraction de hauteur (+ = horizon plus bas)
 */
export function uvVersAngles(u, v, horizonOffset = 0) {
  const a = (u - 0.5) * 2 * Math.PI;
  const e = (0.5 - (v - horizonOffset)) * Math.PI;
  return { a, e };
}

export function anglesVersUV(a, e, horizonOffset = 0) {
  let u = a / (2 * Math.PI) + 0.5;
  u = ((u % 1) + 1) % 1;
  const v = 0.5 - e / Math.PI + horizonOffset;
  return { u, v };
}

export function anglesVersDirection(a, e) {
  const ce = Math.cos(e);
  return { x: ce * Math.sin(a), y: Math.sin(e), z: ce * Math.cos(a) };
}

export function directionVersAngles(d) {
  const a = Math.atan2(d.x, d.z);
  const e = Math.atan2(d.y, Math.hypot(d.x, d.z));
  return { a, e };
}

/* ---------- intersection avec le plan du sol ---------- */

/**
 * Point du sol visé par une direction d'image.
 * @returns {{x,y,z,distHoriz,fiabilite}|null} null si la visée ne descend pas
 */
export function pointSol(u, v, hc, horizonOffset = 0) {
  const { a, e } = uvVersAngles(u, v, horizonOffset);
  // il faut viser sous l'horizon
  if (e >= -0.0035) return null; // ~0,2° de garde
  const distHoriz = hc / Math.tan(-e);
  const p = {
    x: distHoriz * Math.sin(a),
    y: -hc,
    z: distHoriz * Math.cos(a),
    distHoriz,
    a, e
  };
  p.fiabilite = fiabiliteVisee(distHoriz, hc);
  return p;
}

/**
 * Qualité attendue d'une visée au sol, selon le rapport distance / hauteur.
 * Au-delà de 8, l'angle devient si rasant qu'un pixel vaut plusieurs cm.
 */
export function fiabiliteVisee(distHoriz, hc) {
  const r = distHoriz / hc;
  if (r <= 3) return { niveau: 'bonne', ratio: r };
  if (r <= 6) return { niveau: 'correcte', ratio: r };
  if (r <= 10) return { niveau: 'degradee', ratio: r };
  return { niveau: 'mauvaise', ratio: r };
}

/* ---------- mesures ---------- */

/**
 * Distance horizontale entre deux points posés au sol.
 * Usage : longueur de mur, largeur de terrasse, trame, emprise.
 */
export function mesureAuSol(p1uv, p2uv, hc, horizonOffset = 0) {
  const A = pointSol(p1uv.u, p1uv.v, hc, horizonOffset);
  const B = pointSol(p2uv.u, p2uv.v, hc, horizonOffset);
  if (!A || !B) {
    return { ok: false, erreur: "Les deux points doivent être posés au sol, visés sous l'horizon." };
  }
  const d = Math.hypot(A.x - B.x, A.z - B.z);
  const pire = A.fiabilite.ratio > B.fiabilite.ratio ? A.fiabilite : B.fiabilite;
  return {
    ok: true, type: 'sol', valeur: d,
    detail: { A, B, distA: A.distHoriz, distB: B.distHoriz },
    fiabilite: pire,
    incertitude: incertitudeSol(A, B, hc)
  };
}

/**
 * Hauteur d'un ouvrage : on vise son pied au sol puis son sommet à l'aplomb.
 * Usage : acrotère, hauteur de porte, allège et linteau de fenêtre, garde-corps.
 */
export function mesureHauteur(piedUV, sommetUV, hc, horizonOffset = 0) {
  const P = pointSol(piedUV.u, piedUV.v, hc, horizonOffset);
  if (!P) {
    return { ok: false, erreur: "Le pied de l'ouvrage doit être visé au sol, sous l'horizon." };
  }
  const { e: eS } = uvVersAngles(sommetUV.u, sommetUV.v, horizonOffset);
  // hauteur au-dessus du plan de l'objectif, puis au-dessus du sol
  const hauteurSurObjectif = P.distHoriz * Math.tan(eS);
  const hauteur = hc + hauteurSurObjectif;
  return {
    ok: true, type: 'hauteur', valeur: hauteur,
    detail: { pied: P, distance: P.distHoriz, siteSommet: eS * DEG, auDessusObjectif: hauteurSurObjectif },
    fiabilite: P.fiabilite,
    incertitude: incertitudeHauteur(P, eS, hc)
  };
}

/**
 * Dimension verticale entre deux points à l'aplomb l'un de l'autre, quand
 * aucun n'est au sol (ex. hauteur d'un bandeau, d'une costière en plein mur).
 * Nécessite une distance connue, prise sur une mesure au sol déjà faite.
 */
export function mesureVerticaleADistance(basUV, hautUV, distance, horizonOffset = 0) {
  const { e: eB } = uvVersAngles(basUV.u, basUV.v, horizonOffset);
  const { e: eH } = uvVersAngles(hautUV.u, hautUV.v, horizonOffset);
  const valeur = distance * (Math.tan(eH) - Math.tan(eB));
  return {
    ok: true, type: 'verticale', valeur: Math.abs(valeur),
    detail: { distance, siteBas: eB * DEG, siteHaut: eH * DEG },
    fiabilite: { niveau: 'correcte', ratio: 0 },
    incertitude: Math.abs(valeur) * 0.04
  };
}

/* ---------- incertitudes (estimation honnête) ---------- */
/* Deux sources dominantes : l'erreur sur la hauteur d'objectif (1 cm par
   défaut) et l'erreur de pointé à l'écran (environ 3 pixels sur une pano
   de 4096 px de large, soit ~0,26° de site). */

const ERR_HC = 0.01;           // m
const ERR_POINTE = 0.0045;     // rad (~0,26°)

function errDistanceSol(p, hc) {
  // d = hc / tan(-e)  ->  dd/dhc = d/hc ;  dd/de = d^2/hc (approx, |e| petit)
  const parHc = (p.distHoriz / hc) * ERR_HC;
  const parAngle = (p.distHoriz * p.distHoriz / hc) * ERR_POINTE;
  return Math.hypot(parHc, parAngle);
}

function incertitudeSol(A, B, hc) {
  return Math.hypot(errDistanceSol(A, hc), errDistanceSol(B, hc));
}

function incertitudeHauteur(P, eS, hc) {
  const errD = errDistanceSol(P, hc);
  const parDistance = Math.abs(Math.tan(eS)) * errD;
  const parAngleSommet = P.distHoriz * (1 + Math.tan(eS) ** 2) * ERR_POINTE;
  return Math.hypot(parDistance, parAngleSommet, ERR_HC);
}

/* ---------- calibration ---------- */

/**
 * Toutes les distances au sol sont proportionnelles à la hauteur d'objectif.
 * Si on mesure une longueur connue (dalle, porte, règle de maçon) et qu'on
 * lit L_mes au lieu de L_vrai, la hauteur corrigée est exacte :
 *     hc_corrige = hc * L_vrai / L_mes
 * C'est le moyen le plus fiable de caler une station : une seule référence
 * cotée au mètre ruban recale toute la panoramique.
 */
export function calibrerHauteur(hcActuelle, longueurMesuree, longueurReelle) {
  if (!(longueurMesuree > 0) || !(longueurReelle > 0)) return null;
  const hc = hcActuelle * (longueurReelle / longueurMesuree);
  return {
    hc,
    ecart: hc - hcActuelle,
    facteur: longueurReelle / longueurMesuree
  };
}

/**
 * Cale l'horizon à partir de deux points du sol dont on connaît la distance
 * réelle entre eux. Recherche le décalage d'horizon qui rend la mesure juste.
 * Utile pour une pano importée dont l'appareil n'était pas de niveau.
 */
export function calibrerHorizon(p1uv, p2uv, hc, longueurReelle) {
  let meilleur = null;
  for (let off = -0.08; off <= 0.08; off += 0.0005) {
    const m = mesureAuSol(p1uv, p2uv, hc, off);
    if (!m.ok) continue;
    const ecart = Math.abs(m.valeur - longueurReelle);
    if (!meilleur || ecart < meilleur.ecart) meilleur = { offset: off, ecart, valeur: m.valeur };
  }
  return meilleur;
}

/* ---------- mise en forme ---------- */

export function formaterLongueur(m) {
  if (m == null || !isFinite(m)) return '—';
  if (Math.abs(m) < 1) return (m * 100).toFixed(1).replace('.', ',') + ' cm';
  return m.toFixed(2).replace('.', ',') + ' m';
}

export function formaterIncertitude(m) {
  if (m == null || !isFinite(m)) return '';
  if (m < 1) return '± ' + Math.round(m * 100) + ' cm';
  return '± ' + m.toFixed(2).replace('.', ',') + ' m';
}

export const LIBELLE_FIABILITE = {
  bonne: 'Visée franche, cote fiable',
  correcte: 'Visée correcte',
  degradee: 'Visée rasante, cote à vérifier',
  mauvaise: 'Visée trop rasante, cote non exploitable'
};

/* ---------- surface d'un polygone au sol ---------- */

/**
 * Surface d'une zone délimitée par des points visés au sol.
 * Usage : surface de toiture-terrasse, zone de reprise d'étanchéité.
 */
export function surfacePolygoneSol(pointsUV, hc, horizonOffset = 0) {
  const pts = [];
  for (const p of pointsUV) {
    const s = pointSol(p.u, p.v, hc, horizonOffset);
    if (!s) return { ok: false, erreur: 'Tous les sommets doivent être visés au sol.' };
    pts.push(s);
  }
  if (pts.length < 3) return { ok: false, erreur: 'Il faut au moins trois sommets.' };
  let aire = 0, perim = 0;
  for (let i = 0; i < pts.length; i++) {
    const A = pts[i], B = pts[(i + 1) % pts.length];
    aire += A.x * B.z - B.x * A.z;
    perim += Math.hypot(A.x - B.x, A.z - B.z);
  }
  const pire = pts.reduce((m, p) => (p.fiabilite.ratio > m.ratio ? p.fiabilite : m), pts[0].fiabilite);
  return { ok: true, type: 'surface', valeur: Math.abs(aire) / 2, perimetre: perim, fiabilite: pire, detail: { pts } };
}

export function formaterSurface(m2) {
  if (m2 == null || !isFinite(m2)) return '—';
  return m2.toFixed(2).replace('.', ',') + ' m²';
}

/* ============================================================
   capture.js — Prise de vue 360° et normalisation des panoramiques
   ------------------------------------------------------------
   DEUX VOIES D'ENTREE

   1. IMPORT (voie recommandée pour coter)
      Une panoramique équirectangulaire 2:1 issue d'une caméra 360°
      (Insta360, Ricoh Theta, 4DKanKan...) couvre la sphère entière,
      sol compris. C'est la seule entrée qui donne des cotes justes
      sans réglage, parce que le sol sous l'appareil est visible.
      Une panoramique de smartphone (mode Pano) est cylindrique et
      ne montre pas le sol : elle sert d'archive visuelle, pas de
      relevé. On la normalise quand même pour la navigation.

   2. PRISE DE VUE GUIDEE DANS L'APP
      On tourne sur place, l'app déclenche automatiquement à chaque
      cible atteinte et projette chaque photo sur la sphère d'après
      l'orientation du téléphone. Assemblage géométrique, sans
      recalage par points d'intérêt : les raccords restent visibles
      et la parallaxe n'est pas corrigée. Suffisant pour garder la
      mémoire d'un état, à caler par référence cotée avant de mesurer.
   ============================================================ */

import { chargerImage } from './viewer.js?v=16';

/* ============================================================
   1. NORMALISATION D'UNE IMAGE IMPORTEE
   ============================================================ */

export const MODELE = { EQUIRECT: 'equirect', CYLINDRIQUE: 'cylindrique' };

/**
 * Analyse une image importée et devine sa nature.
 * @returns {{largeur,hauteur,ratio,type,fovVertical,sphereComplete,message}}
 */
export async function analyserImport(blob) {
  const img = await chargerImage(blob);
  const ratio = img.width / img.height;
  let type, fovVertical, sphereComplete, message;

  if (ratio > 1.85 && ratio < 2.15) {
    type = 'equirect-complet';
    fovVertical = 180;
    sphereComplete = true;
    message = 'Panoramique sphérique complète. Cotation possible directement : le sol est visible.';
  } else if (ratio >= 2.15) {
    type = 'panoramique-partielle';
    fovVertical = Math.min(170, 360 / ratio);
    sphereComplete = false;
    message = 'Panoramique 360° partielle (bande horizontale). Navigation complète, mais le sol au pied de l\'appareil manque : la cotation demandera un calage sur une longueur connue.';
  } else {
    type = 'photo';
    fovVertical = 0;
    sphereComplete = false;
    message = 'Photo simple. Conservée comme vue fixe, sans navigation 360° ni cotation.';
  }
  return { largeur: img.width, hauteur: img.height, ratio, type, fovVertical, sphereComplete, message, image: img };
}

/**
 * Replace une panoramique partielle dans un cadre équirectangulaire 2:1,
 * afin que les angles lus par la visionneuse et le module de mesure soient
 * cohérents. Gère les deux modèles de projection verticale.
 */
export async function normaliserEnEquirect(blob, options = {}) {
  const {
    fovVertical = 60,
    modele = MODELE.CYLINDRIQUE,
    largeurMax = 4096,
    centreVertical = 0      // décalage du centre de bande, en degrés
  } = options;

  const img = await chargerImage(blob);
  const ratio = img.width / img.height;
  if (ratio > 1.85 && ratio < 2.15) return { blob, deja: true };

  const W = Math.min(largeurMax, img.width);
  const H = Math.round(W / 2);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0f1115';
  ctx.fillRect(0, 0, W, H);

  // source redimensionnée à la largeur cible
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = Math.max(1, Math.round(img.height * W / img.width));
  tmp.getContext('2d').drawImage(img, 0, 0, tmp.width, tmp.height);
  const src = tmp.getContext('2d').getImageData(0, 0, tmp.width, tmp.height);
  const out = ctx.createImageData(W, H);

  const demiFov = (fovVertical / 2) * Math.PI / 180;
  const decal = centreVertical * Math.PI / 180;
  const tanDemi = Math.tan(demiFov);

  for (let y = 0; y < H; y++) {
    // site visé par cette ligne de l'équirectangulaire
    const e = (0.5 - y / H) * Math.PI - decal;
    let sy;
    if (Math.abs(e) > demiFov) { sy = -1; }
    else if (modele === MODELE.CYLINDRIQUE) {
      // projection cylindrique : la hauteur image est proportionnelle à tan(site)
      sy = (0.5 - Math.tan(e) / (2 * tanDemi)) * tmp.height;
    } else {
      // projection équirectangulaire : proportionnelle au site
      sy = (0.5 - e / (2 * demiFov)) * tmp.height;
    }
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (sy < 0 || sy >= tmp.height) { out.data[o + 3] = 0; continue; }
      const yi = Math.min(tmp.height - 1, Math.max(0, Math.round(sy)));
      const si = (yi * tmp.width + x) * 4;
      out.data[o] = src.data[si];
      out.data[o + 1] = src.data[si + 1];
      out.data[o + 2] = src.data[si + 2];
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const result = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.88));
  return { blob: result, deja: false, largeur: W, hauteur: H };
}

/** Réduit une panoramique trop lourde pour tenir en mémoire sur téléphone. */
export async function reduire(blob, largeurMax = 4096, qualite = 0.86) {
  const img = await chargerImage(blob);
  if (img.width <= largeurMax) return blob;
  const cv = document.createElement('canvas');
  cv.width = largeurMax;
  cv.height = Math.round(img.height * largeurMax / img.width);
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return await new Promise((r) => cv.toBlob(r, 'image/jpeg', qualite));
}

/* ============================================================
   2. PRISE DE VUE GUIDEE
   ============================================================ */

/**
 * Cibles de prise de vue.
 * mode 'rapide' : horizon, bas et sol. Pas de ciel ni de plafond : sur une
 *   terrasse c'est la moitié inutile de la sphère. Environ 15 à 20 photos.
 * mode 'complet' : toute la sphère. Environ 25 à 30 photos.
 * Le recalage par comparaison d'images tolère un recouvrement plus faible
 * qu'un placement au seul gyroscope : 28 % entre voisines suffisent.
 * L'angle de vue est borné pour qu'une calibration ratée ne réclame pas
 * 50 photos (une mesure à 40° au lieu de 55° en demandait 52).
 */
export function grilleCibles(fovH = 58, fovV = 74, mode = 'rapide') {
  const complet = mode !== 'rapide';
  const max = mode === 'fin' ? 64 : mode === 'complet' ? 30 : 20;
  const fh = Math.max(50, Math.min(80, fovH));
  const fv = Math.max(60, Math.min(100, fovV));
  for (let rec = mode === 'fin' ? 0.52 : 0.72; ; rec += 0.04) {
    const cibles = [];
    const pasRang = fv * rec;
    const rangs = [0];
    for (let e = pasRang; e <= 72; e += pasRang) { rangs.push(-e); if (complet) rangs.push(e); }
    rangs.sort((a, b) => b - a);
    for (const e of rangs) {
      const facteur = Math.max(0.35, Math.cos(e * Math.PI / 180));
      const n = Math.max(3, Math.round(360 / Math.max(20, fh * rec / facteur)));
      for (let i = 0; i < n; i++) cibles.push({ azimut: (i * 360 / n) - 180, site: e, fait: false });
    }
    if (complet) cibles.push({ azimut: 0, site: 88, fait: false, pole: 'zenith' });
    // le nadir est indispensable pour coter : sans le sol, pas de mesure
    cibles.push({ azimut: 0, site: -88, fait: false, pole: 'nadir', essentiel: true });
    if (cibles.length <= max || rec > 0.95) return cibles;
  }
}

/** Matrice de rotation appareil -> repère terrestre, d'après alpha/beta/gamma. */
export function matriceOrientation(alpha, beta, gamma) {
  const a = alpha * Math.PI / 180, b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);
  // R = Rz(alpha) . Rx(beta) . Ry(gamma)
  return [
    cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG,
    sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG,
    -cB * sG, sB, cB * cG
  ];
}

/** Direction visée par l'objectif arrière (-Z appareil), en azimut/site. */
export function viseeDepuisOrientation(alpha, beta, gamma) {
  const R = matriceOrientation(alpha, beta, gamma);
  // -Z appareil dans le repère terrestre (X est, Y nord, Z haut)
  const X = -R[2], Y = -R[5], Z = -R[8];
  const azimut = Math.atan2(X, Y) * 180 / Math.PI;   // 0 = nord, + vers l'est
  const site = Math.asin(Math.max(-1, Math.min(1, Z))) * 180 / Math.PI;
  return { azimut, site, R };
}

export function ecartAngulaire(az1, si1, az2, si2) {
  const d2r = Math.PI / 180;
  const d1 = dirDe(az1 * d2r, si1 * d2r), d2 = dirDe(az2 * d2r, si2 * d2r);
  const dot = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]));
  return Math.acos(dot) * 180 / Math.PI;
}
function dirDe(az, si) {
  const c = Math.cos(si);
  return [c * Math.sin(az), c * Math.cos(az), Math.sin(si)];
}

/* ---------- assembleur WebGL ----------
   NETTETE : deux choix décisifs.
   1. Pas de mélange aux raccords. Mélanger deux photos que le gyroscope a
      placées à un demi-degré l'une de l'autre donne des contours doublés,
      que l'oeil lit comme du flou. Ici chaque pixel de la sphère vient d'UNE
      seule photo : celle où il est le plus proche du centre de l'image
      (meilleure optique, moins de déformation). Le tampon de profondeur
      fait cette sélection : la profondeur écrite vaut 1 - centralité.
      Les raccords se voient un peu plus, mais l'image reste nette.
   2. Sphère de 4096 x 2048 px. Une version à 5760 px a été essayée : elle
      dépasse, avec son tampon de profondeur, la mémoire que Safari accorde
      aux images d'une page sur iPhone, et Safari coupe alors l'affichage
      sans prévenir (écran noir). Le gyroscope d'un téléphone se trompant
      d'environ un demi-degré, soit déjà 6 à 8 px à cette échelle, la
      résolution supérieure n'apportait de toute façon que peu de détail.
*/

export const LARGEUR_SPHERE = 4096;
/** Définition « fine » : au plus ce que les toiles de l'iPhone acceptent (16,7 M de pixels). */
export const LARGEUR_SPHERE_FINE = 5632;

const SRC_ASM = {
  vs100: `attribute vec2 aPos; varying vec2 vUV;
    void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`,
  vs300: `#version 300 es
    in vec2 aPos; out vec2 vUV;
    void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`,
  corps: `
    const float PI = 3.14159265359;
    vec4 calcul(out float profondeur, out bool garde) {
      float a = (vUV.x - 0.5) * 2.0 * PI;
      float e = (vUV.y - 0.5) * PI;
      float ce = cos(e);
      vec3 dPano = vec3(ce * sin(a), sin(e), ce * cos(a));
      vec3 dTerre = vec3(dPano.x, dPano.z, dPano.y);   // pano -> terre
      vec3 c = uR * dTerre;                             // terre -> appareil
      garde = false; profondeur = 1.0;
      float prof = -c.z;                                // l'objectif regarde vers -Z
      if (prof <= 0.02) return vec4(0.0);
      float ix = c.x / prof / uTanH;
      float iy = c.y / prof / uTanV;
      float cr = cos(uRotEcran), sr = sin(uRotEcran);
      vec2 p = vec2(ix * cr - iy * sr, ix * sr + iy * cr);
      if (abs(p.x) > 0.985 || abs(p.y) > 0.985) return vec4(0.0);
      float centralite = (1.0 - p.x * p.x) * (1.0 - p.y * p.y);
      profondeur = 1.0 - centralite;
      garde = true;
      vec2 t = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
      return vec4(clamp(LIRE(uFrame, t).rgb * uGain, 0.0, 1.0), centralite);
    }`,
  uniformes: `uniform sampler2D uFrame; uniform mat3 uR;
    uniform float uTanH; uniform float uTanV; uniform float uRotEcran; uniform float uGain;`
};

function sourceFragment(mode) {
  if (mode === 'webgl2') return `#version 300 es
    precision highp float;
    in vec2 vUV; out vec4 sortie;
    ${SRC_ASM.uniformes}
    #define LIRE texture
    ${SRC_ASM.corps}
    void main(){ float z; bool g; vec4 c = calcul(z, g);
      if (!g) discard; gl_FragDepth = z; sortie = vec4(c.rgb, 1.0); }`;
  if (mode === 'profondeur-ext') return `#extension GL_EXT_frag_depth : enable
    precision highp float;
    varying vec2 vUV;
    ${SRC_ASM.uniformes}
    #define LIRE texture2D
    ${SRC_ASM.corps}
    void main(){ float z; bool g; vec4 c = calcul(z, g);
      if (!g) discard; gl_FragDepthEXT = z; gl_FragColor = vec4(c.rgb, 1.0); }`;
  // dernier recours : fondu aux raccords (appareils sans profondeur programmable)
  return `precision highp float;
    varying vec2 vUV;
    ${SRC_ASM.uniformes}
    #define LIRE texture2D
    ${SRC_ASM.corps}
    void main(){ float z; bool g; vec4 c = calcul(z, g);
      if (!g) discard; gl_FragColor = vec4(c.rgb, smoothstep(0.0, 0.35, c.a)); }`;
}

export class Assembleur {
  /**
   * @param {number} largeur largeur de la sphère produite (hauteur = /2)
   * @param {{fovH:number, fovV:number}} champ champ de l'objectif en degrés
   */
  constructor(largeur = LARGEUR_SPHERE, champ = { fovH: 66, fovV: 50 }) {
    this.largeur = largeur;
    this.hauteur = Math.round(largeur / 2);
    this.champ = champ;
    this.nbPrises = 0;
    this.luminanceRef = null;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.largeur;
    this.canvas.height = this.hauteur;
    const opts = { preserveDrawingBuffer: true, alpha: false, antialias: false, depth: true };

    let gl = this.canvas.getContext('webgl2', opts), mode = 'webgl2';
    if (!gl) {
      gl = this.canvas.getContext('webgl', opts);
      mode = gl && gl.getExtension('EXT_frag_depth') ? 'profondeur-ext' : 'fondu';
    }
    if (!gl) { this.erreur = 'WebGL indisponible'; return; }
    this.gl = gl;
    this.mode = mode;
    this.perdu = false;
    // Safari retire le contexte graphique quand la mémoire manque : sans cette
    // surveillance, les prises suivantes s'ajouteraient à une image noire
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.perdu = true; });
    this.webgl2 = mode === 'webgl2';

    const comp = (t, src) => {
      const sh = gl.createShader(t); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, comp(gl.VERTEX_SHADER, mode === 'webgl2' ? SRC_ASM.vs300 : SRC_ASM.vs100));
    gl.attachShader(prog, comp(gl.FRAGMENT_SHADER, sourceFragment(mode)));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.u = {
      frame: gl.getUniformLocation(prog, 'uFrame'),
      R: gl.getUniformLocation(prog, 'uR'),
      tanH: gl.getUniformLocation(prog, 'uTanH'),
      tanV: gl.getUniformLocation(prog, 'uTanV'),
      rot: gl.getUniformLocation(prog, 'uRotEcran'),
      gain: gl.getUniformLocation(prog, 'uGain')
    };

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // en WebGL2 les mipmaps fonctionnent sur toute taille d'image :
    // la réduction de chaque photo vers la sphère reste alors sans crénelage
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.webgl2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);

    if (mode === 'fondu') {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.clearDepth(1.0);
    }
    gl.clearColor(0.06, 0.07, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.viewport(0, 0, this.largeur, this.hauteur);
  }

  /**
   * Projette une prise sur la sphère.
   * @param {HTMLCanvasElement} image
   * @param {{alpha:number,beta:number,gamma:number}} orientation
   * @param {number} rotEcran rotation écran en degrés (0 portrait)
   * @param {number} gain correction d'exposition (1 = aucune)
   */
  ajouter(image, orientation, rotEcran = 0, gain = 1) {
    return this.ajouterMatrice(image, matriceOrientation(orientation.alpha, orientation.beta, orientation.gamma), rotEcran, gain);
  }

  /** Projette une prise d'après une orientation déjà calculée (recalée). */
  ajouterMatrice(image, R, rotEcran = 0, gain = 1) {
    if (!this.gl || this.perdu || this.gl.isContextLost()) { this.perdu = true; return false; }
    const gl = this.gl;
    // R est écrite en lignes ; WebGL lit les mat3 en colonnes, donc le shader
    // reçoit automatiquement la transposée, c'est-à-dire terre -> appareil.

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      if (this.webgl2) gl.generateMipmap(gl.TEXTURE_2D);
    } catch (e) { return false; }

    gl.uniformMatrix3fv(this.u.R, false, new Float32Array(R));
    gl.uniform1f(this.u.tanH, Math.tan(this.champ.fovH / 2 * Math.PI / 180));
    gl.uniform1f(this.u.tanV, Math.tan(this.champ.fovV / 2 * Math.PI / 180));
    gl.uniform1f(this.u.rot, rotEcran * Math.PI / 180);
    gl.uniform1f(this.u.gain, Math.max(0.5, Math.min(2, gain)));
    gl.uniform1i(this.u.frame, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.nbPrises++;
    return true;
  }

  /**
   * Sphère assemblée, en JPEG de bonne qualité.
   * Refuse de produire une image noire : c'est le symptôme d'un contexte
   * graphique perdu, et l'enregistrer ferait une station inutilisable.
   */
  async produire(qualite = 0.92) {
    if (this.perdu || (this.gl && this.gl.isContextLost())) throw new Error('CONTEXTE_PERDU');
    if (estNoire(this.canvas)) throw new Error('SPHERE_NOIRE');
    return await new Promise((r) => this.canvas.toBlob(r, 'image/jpeg', qualite));
  }

  /** Rend immédiatement la mémoire graphique, sans attendre le ramasse-miettes. */
  liberer() {
    try { const ext = this.gl && this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) {}
    this.canvas.width = 1; this.canvas.height = 1;
    this.gl = null;
  }

  apercu() { return this.canvas; }

  reinitialiser() {
    if (!this.gl) return;
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
    this.nbPrises = 0;
    this.luminanceRef = null;
  }

  /**
   * Gain à appliquer pour que cette prise s'accorde à la première.
   * L'iPhone réajuste son exposition en permanence : en tournant du ciel
   * vers l'ombre d'une souche, deux prises voisines peuvent différer du
   * simple au double et la sphère finit en patchwork.
   */
  gainPour(image) {
    const L = moyenneLuminance(image);
    if (L == null) return 1;
    if (this.luminanceRef == null) { this.luminanceRef = L; return 1; }
    if (L < 0.02) return 1;
    return Math.max(0.6, Math.min(1.7, this.luminanceRef / L));
  }
}

/* ---------- assemblage avec fondu ----------
   Une fois les photos recalées sur leurs voisines, on peut à nouveau les
   fondre entre elles sans recréer d'images fantômes, à condition que le
   fondu reste étroit. Chaque photo contribue avec un poids
   centralité^6 : là où deux photos se recouvrent, celle dont le point
   est le plus central l'emporte nettement, et la transition ne s'étale
   que sur quelques degrés autour de la frontière. Les coupures franches
   disparaissent, les objets ne se dédoublent pas.
   Technique : on additionne couleur x poids et poids dans une texture en
   virgule flottante, puis on divise. Les zones que personne n'a
   photographiées sont comblées par les couleurs voisines, floutées, prises
   dans une version réduite de l'accumulation : plus le trou est grand,
   plus la couleur vient de loin et plus elle est floue.
   Il faut WebGL2 et des textures flottantes où l'on peut additionner :
   on le vérifie sur une image de 4 x 4 px avant de s'y fier. */

const PUISSANCE_FONDU = 40;   // quasi-sélection : une seule photo par point, plus de doublons dus à la parallaxe

const VS_FONDU = `#version 300 es
in vec2 aPos; out vec2 vUV;
void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS_ACCUMULE = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 sortie;
${SRC_ASM.uniformes}
uniform float uPuissance;
#define LIRE texture
${SRC_ASM.corps}
void main(){ float z; bool g; vec4 c = calcul(z, g);
  if (!g) discard;
  float w = 0.002 + pow(max(c.a, 0.0), uPuissance);
  sortie = vec4(c.rgb * w, w); }`;

const FS_REDUIT = `#version 300 es
precision highp float;
out vec4 sortie;
uniform sampler2D uAccu; uniform int uFacteur;
void main(){
  ivec2 base = ivec2(gl_FragCoord.xy) * uFacteur;
  vec4 s = vec4(0.0);
  for (int j = 0; j < 16; j++) { if (j >= uFacteur) break;
    for (int i = 0; i < 16; i++) { if (i >= uFacteur) break;
      s += texelFetch(uAccu, base + ivec2(i, j), 0); } }
  sortie = s / float(uFacteur * uFacteur); }`;

const FS_NORMALISE = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 sortie;
uniform sampler2D uAccu; uniform sampler2D uReduit; uniform float uNiveaux;
void main(){
  vec4 a = texelFetch(uAccu, ivec2(gl_FragCoord.xy), 0);
  if (a.a > 0.001) { sortie = vec4(a.rgb / a.a, 1.0); return; }
  for (float l = 0.0; l <= 12.0; l += 1.0) {
    if (l > uNiveaux) break;
    vec4 b = textureLod(uReduit, vUV, l);
    if (b.a > 0.0004) { sortie = vec4(b.rgb / b.a, 1.0); return; }
  }
  sortie = vec4(0.06, 0.07, 0.08, 1.0); }`;

const VS_TEST = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FS_TEST_ECRIT = `#version 300 es
precision highp float; out vec4 sortie; void main(){ sortie = vec4(0.2, 0.3, 0.1, 0.2); }`;
const FS_TEST_LIT = `#version 300 es
precision highp float; out vec4 sortie; uniform sampler2D uT;
void main(){ sortie = texelFetch(uT, ivec2(gl_FragCoord.xy), 0); }`;

function compilerProgramme(gl, vs, fs) {
  const comp = (t, src) => {
    const sh = gl.createShader(t); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'compilation');
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, comp(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, comp(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'liaison');
  return prog;
}

function quadPleinEcran(gl) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
}

function textureFlottante(gl, w, h, niveaux = 1) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, niveaux, gl.RGBA16F, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, niveaux > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, niveaux > 1 ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function cibleSur(gl, tex) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('cible flottante refusée');
  return fb;
}

let _fonduPossible = null;
/** L'appareil sait-il additionner des couleurs en virgule flottante ? Vérifié, pas supposé. */
export function fonduPossible() {
  if (_fonduPossible != null) return _fonduPossible;
  let gl = null;
  try {
    const c = document.createElement('canvas'); c.width = 4; c.height = 4;
    gl = c.getContext('webgl2', { preserveDrawingBuffer: true, depth: false, antialias: false });
    if (!gl) return (_fonduPossible = false);
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return (_fonduPossible = false);
    quadPleinEcran(gl);
    const tex = textureFlottante(gl, 4, 4);
    const fb = cibleSur(gl, tex);
    gl.viewport(0, 0, 4, 4);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(compilerProgramme(gl, VS_TEST, FS_TEST_ECRIT));
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);       // deux passages : 0,2 + 0,2 = 0,4
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const lit = compilerProgramme(gl, VS_TEST, FS_TEST_LIT);
    gl.useProgram(lit);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(lit, 'uT'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const px = new Uint8Array(4);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // attendu 0,4 / 0,6 / 0,2 soit 102 / 153 / 51
    _fonduPossible = Math.abs(px[0] - 102) <= 3 && Math.abs(px[1] - 153) <= 3 && Math.abs(px[2] - 51) <= 3;
  } catch (e) {
    _fonduPossible = false;
  } finally {
    try { const x = gl && gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); } catch (e) {}
  }
  return _fonduPossible;
}

export class AssembleurFondu {
  constructor(largeur = LARGEUR_SPHERE, champ = { fovH: 66, fovV: 50 }) {
    this.largeur = largeur;
    this.hauteur = Math.round(largeur / 2);
    this.champ = champ;
    this.nbPrises = 0;
    this.puissance = PUISSANCE_FONDU;
    this.mode = 'fondu-flottant';
    this.perdu = false;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.largeur;
    this.canvas.height = this.hauteur;
    // pas de tampon de profondeur ici : la mémoire ainsi économisée paie la
    // texture d'accumulation
    const gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false, depth: false });
    if (!gl) { this.erreur = 'WebGL2 indisponible'; return; }
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      this.erreur = 'textures flottantes indisponibles'; return;
    }
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.perdu = true; });

    quadPleinEcran(gl);
    this.progAccu = compilerProgramme(gl, VS_FONDU, FS_ACCUMULE);
    this.progReduit = compilerProgramme(gl, VS_FONDU, FS_REDUIT);
    this.progNorm = compilerProgramme(gl, VS_FONDU, FS_NORMALISE);
    const u = (p, n) => gl.getUniformLocation(p, n);
    this.u = {
      frame: u(this.progAccu, 'uFrame'), R: u(this.progAccu, 'uR'), tanH: u(this.progAccu, 'uTanH'),
      tanV: u(this.progAccu, 'uTanV'), rot: u(this.progAccu, 'uRotEcran'), gain: u(this.progAccu, 'uGain'),
      puissance: u(this.progAccu, 'uPuissance')
    };

    this.accu = textureFlottante(gl, this.largeur, this.hauteur);
    this.fbAccu = cibleSur(gl, this.accu);
    gl.viewport(0, 0, this.largeur, this.hauteur);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }

  ajouter(image, orientation, rotEcran = 0, gain = 1) {
    return this.ajouterMatrice(image, matriceOrientation(orientation.alpha, orientation.beta, orientation.gamma), rotEcran, gain);
  }

  ajouterMatrice(image, R, rotEcran = 0, gain = 1) {
    const gl = this.gl;
    if (!gl || this.perdu || gl.isContextLost()) { this.perdu = true; return false; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbAccu);
    gl.viewport(0, 0, this.largeur, this.hauteur);
    gl.useProgram(this.progAccu);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
    } catch (e) { return false; }
    gl.uniformMatrix3fv(this.u.R, false, new Float32Array(R));
    gl.uniform1f(this.u.tanH, Math.tan(this.champ.fovH / 2 * Math.PI / 180));
    gl.uniform1f(this.u.tanV, Math.tan(this.champ.fovV / 2 * Math.PI / 180));
    gl.uniform1f(this.u.rot, rotEcran * Math.PI / 180);
    gl.uniform1f(this.u.gain, Math.max(0.5, Math.min(2, gain)));
    gl.uniform1f(this.u.puissance, this.puissance);
    gl.uniform1i(this.u.frame, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    this.nbPrises++;
    return true;
  }

  async produire(qualite = 0.92) {
    const gl = this.gl;
    if (!gl || this.perdu || gl.isContextLost()) throw new Error('CONTEXTE_PERDU');

    // 1. version réduite de l'accumulation, avec sa pyramide : sert à combler les trous
    const facteur = 8;
    const lr = Math.max(1, Math.floor(this.largeur / facteur)), hr = Math.max(1, Math.floor(this.hauteur / facteur));
    const niveaux = Math.floor(Math.log2(Math.max(lr, hr))) + 1;
    const reduit = textureFlottante(gl, lr, hr, niveaux);
    const fbReduit = cibleSur(gl, reduit);
    gl.viewport(0, 0, lr, hr);
    gl.useProgram(this.progReduit);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.accu);
    gl.uniform1i(gl.getUniformLocation(this.progReduit, 'uAccu'), 0);
    gl.uniform1i(gl.getUniformLocation(this.progReduit, 'uFacteur'), facteur);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, reduit);
    gl.generateMipmap(gl.TEXTURE_2D);

    // 2. division couleur / poids, trous comblés, vers l'image finale
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.largeur, this.hauteur);
    gl.useProgram(this.progNorm);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.accu);
    gl.uniform1i(gl.getUniformLocation(this.progNorm, 'uAccu'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, reduit);
    gl.uniform1i(gl.getUniformLocation(this.progNorm, 'uReduit'), 1);
    gl.uniform1f(gl.getUniformLocation(this.progNorm, 'uNiveaux'), niveaux - 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
    gl.deleteFramebuffer(fbReduit); gl.deleteTexture(reduit);

    if (gl.isContextLost()) throw new Error('CONTEXTE_PERDU');
    if (estNoire(this.canvas)) throw new Error('SPHERE_NOIRE');
    return await new Promise((r) => this.canvas.toBlob(r, 'image/jpeg', qualite));
  }

  liberer() {
    try { const ext = this.gl && this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) {}
    this.canvas.width = 1; this.canvas.height = 1;
    this.gl = null;
  }
}

/** Le meilleur assembleur que l'appareil supporte réellement. */
export function creerAssembleur(largeur, champ, avecFondu = true) {
  if (avecFondu && fonduPossible()) {
    try {
      const a = new AssembleurFondu(largeur, champ);
      if (!a.erreur) return a;
      a.liberer();
    } catch (e) { console.warn('[assemblage] fondu indisponible', e); }
  }
  return new Assembleur(largeur, champ);
}

/* ---------- détection d'immobilité ----------
   Le flou de bougé vient de déclencher pendant la rotation. On mesure la
   vitesse angulaire sur une fenêtre glissante (le bruit du gyroscope, de
   l'ordre de 0,2° par mesure, rendrait une mesure image par image
   inutilisable) et on n'accepte une prise qu'une fois le téléphone
   stabilisé depuis un court instant. */
export class Stabilite {
  constructor(fenetreMs = 220, seuilDegParS = 7, tenueMs = 300) {
    this.fenetre = fenetreMs; this.seuil = seuilDegParS; this.tenue = tenueMs;
    this.historique = [];
    this.immobileDepuis = null;
    this.vitesse = 0;
  }
  ajouter(t, azimut, site) {
    this.historique.push({ t, azimut, site });
    while (this.historique.length > 2 && t - this.historique[0].t > this.fenetre) this.historique.shift();
    const a = this.historique[0];
    const dt = (t - a.t) / 1000;
    this.vitesse = dt > 0.04 ? ecartAngulaire(a.azimut, a.site, azimut, site) / dt : this.vitesse;
    if (this.vitesse < this.seuil) { if (this.immobileDepuis == null) this.immobileDepuis = t; }
    else this.immobileDepuis = null;
  }
  /** vrai si le téléphone est immobile depuis assez longtemps */
  stable(t) { return this.immobileDepuis != null && t - this.immobileDepuis >= this.tenue; }
}

/* ---------- vignettes ----------
   Une sphère de caméra 360° pèse jusqu'à 20 Mo : l'afficher en vignette
   dans une liste ferait décoder des dizaines de millions de pixels par
   station et saturerait la mémoire d'un iPhone. */
export async function apercusDe(blob) {
  const img = await chargerImage(blob);
  const vers = async (largeur, qualite) => {
    const l = Math.min(largeur, img.width);
    const cv = document.createElement('canvas');
    cv.width = l; cv.height = Math.round(img.height * l / img.width);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', qualite));
    cv.width = cv.height = 1;   // libère la toile tout de suite
    return b;
  };
  return { vignette: await vers(640, 0.82), apercu: await vers(2048, 0.86) };
}

export async function reduireVers(blob, largeur, qualite = 0.82) {
  const img = await chargerImage(blob);
  const l = Math.min(largeur, img.width);
  const cv = document.createElement('canvas');
  cv.width = l; cv.height = Math.round(img.height * l / img.width);
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return await new Promise((r) => cv.toBlob(r, 'image/jpeg', qualite));
}

/** Luminance moyenne d'une image, mesurée sur une version réduite. */
const _cvLum = document.createElement('canvas');
_cvLum.width = 32; _cvLum.height = 24;
export function moyenneLuminance(image) {
  try {
    const ctx = _cvLum.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, 32, 24);
    const d = ctx.getImageData(0, 0, 32, 24).data;
    let somme = 0;
    for (let i = 0; i < d.length; i += 4) {
      somme += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    }
    return somme / (d.length / 4) / 255;
  } catch (e) { return null; }
}

/* ---------- accès caméra ---------- */

/*
 * Trois niveaux de réglage, du plus fin au plus sûr. Le premier est celui qui
 * fonctionnait sur iPhone jusqu'à la version 5. Une demande en 4032 x 3024
 * (le format photo de l'iPhone) a été essayée en version 6 : Safari ne sait
 * pas toujours le diffuser en vidéo et l'image peut rester noire.
 */
const NIVEAUX_CAMERA = [
  { width: { ideal: 2560 }, height: { ideal: 1920 } },
  { width: { ideal: 1920 }, height: { ideal: 1440 } },
  {}
];

export async function ouvrirCamera(niveau = 0) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("CAMERA_INDISPONIBLE");
  }
  return await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, ...NIVEAUX_CAMERA[Math.min(niveau, NIVEAUX_CAMERA.length - 1)] },
    audio: false
  });
}

/**
 * Ouvre la caméra dans un élément vidéo et vérifie qu'elle donne vraiment une
 * image : flux noir ou vide -> on réessaie avec un réglage plus sûr.
 * Renvoie le flux, ou lève l'erreur de la dernière tentative.
 */
export async function demarrerCamera(video, surTentative = () => {}) {
  let derniere = null;
  for (let niveau = 0; niveau < NIVEAUX_CAMERA.length; niveau++) {
    let flux = null;
    try {
      surTentative(niveau);
      flux = await ouvrirCamera(niveau);
      video.srcObject = flux;
      await video.play();
      // laisser l'exposition s'établir, puis juger l'image
      const t0 = performance.now();
      while (performance.now() - t0 < 2500 && !(video.videoWidth > 0)) await attendre(100);
      await attendre(900);
      if (video.videoWidth > 0 && !estNoire(video)) return flux;
      derniere = new Error('FLUX_NOIR');
    } catch (e) {
      derniere = e;
      // un refus de l'utilisateur ne se règle pas en baissant la résolution
      if (e && (e.name === 'NotAllowedError' || e.message === 'CAMERA_INDISPONIBLE')) throw e;
    }
    if (flux) flux.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
  throw derniere || new Error('FLUX_NOIR');
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Image (vidéo, toile) pratiquement noire : capteur muet ou mémoire graphique perdue. */
export function estNoire(image) {
  const L = moyenneLuminance(image);
  return L != null && L < 0.004;
}

/**
 * Champ vertical déduit du champ horizontal et des proportions de l'image.
 * Les deux ne sont pas indépendants : une seule mesure suffit.
 */
export function champVertical(fovH, largeurImage, hauteurImage) {
  if (!largeurImage || !hauteurImage) return fovH * 0.75;
  const t = Math.tan(fovH / 2 * Math.PI / 180) * (hauteurImage / largeurImage);
  return 2 * Math.atan(t) * 180 / Math.PI;
}

export function rotationEcran() {
  const a = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  return -a;
}

/**
 * Capture l'image courante du flux vidéo.
 * largeurMax : au-delà, l'image est réduite avec un lissage de qualité.
 * Inutile d'envoyer plus de pixels que la sphère ne peut en recevoir.
 */
// Une seule toile pour toutes les prises : en créer une neuve à chaque photo
// accumulait des dizaines de Mo que Safari ne libère pas assez vite.
const _toilePrise = document.createElement('canvas');
export function saisirImage(video, largeurMax = 1920) {
  const k = Math.min(1, largeurMax / Math.max(video.videoWidth, video.videoHeight));
  const cv = _toilePrise;
  const w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, 0, 0, cv.width, cv.height);
  return cv;
}

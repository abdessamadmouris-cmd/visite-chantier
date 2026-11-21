/* ============================================================
   viewer.js — Visionneuse panoramique 360° (WebGL)
   ------------------------------------------------------------
   Rendu par lancer de rayon dans un quad plein écran : pour chaque
   pixel on calcule la direction visée, puis on échantillonne la
   panoramique équirectangulaire. Pas de maillage de sphère, donc
   aucune déformation aux pôles et une netteté constante.

   Commandes : glisser pour regarder, pincer pour zoomer, gyroscope
   en option (le téléphone devient la fenêtre).
   ============================================================ */

const VS = `
attribute vec2 aPos;
varying vec2 vNdc;
void main() {
  vNdc = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `
precision highp float;
varying vec2 vNdc;
uniform sampler2D uPano;
uniform float uYaw;
uniform float uPitch;
uniform float uTan;        // tan(fov vertical / 2)
uniform float uAspect;
uniform float uHorizon;    // décalage d'horizon, en fraction de hauteur
const float PI = 3.14159265359;

void main() {
  // direction dans le repère caméra (avant = +Z)
  vec3 d = normalize(vec3(vNdc.x * uTan * uAspect, vNdc.y * uTan, 1.0));

  // rotation site puis azimut
  float cp = cos(uPitch), sp = sin(uPitch);
  vec3 r1 = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  float cy = cos(uYaw), sy = sin(uYaw);
  vec3 w = vec3(r1.x * cy + r1.z * sy, r1.y, -r1.x * sy + r1.z * cy);

  // direction -> coordonnées équirectangulaires
  float a = atan(w.x, w.z);
  float e = asin(clamp(w.y, -1.0, 1.0));
  float u = a / (2.0 * PI) + 0.5;
  float v = 0.5 - e / PI + uHorizon;

  if (v < 0.0 || v > 1.0) { gl_FragColor = vec4(0.04, 0.05, 0.06, 1.0); return; }
  gl_FragColor = texture2D(uPano, vec2(u, v));
}`;

// Version WebGL2 : l'échantillonnage avec mipmaps évite le scintillement et
// le crénelage quand on regarde large. Le raccord à 0°/360° pose un problème
// particulier : u saute de 1 à 0, le GPU croit à une variation énorme et
// choisit le niveau de mipmap le plus flou, ce qui dessine une ligne floue
// verticale. On calcule donc les dérivées sur une version de u décalée d'un
// demi-tour, continue à cet endroit, et on garde la plus faible.
const VS2 = `#version 300 es
in vec2 aPos;
out vec2 vNdc;
void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS2 = `#version 300 es
precision highp float;
in vec2 vNdc;
out vec4 sortie;
uniform sampler2D uPano;
uniform float uYaw, uPitch, uTan, uAspect, uHorizon;
const float PI = 3.14159265359;
void main() {
  vec3 d = normalize(vec3(vNdc.x * uTan * uAspect, vNdc.y * uTan, 1.0));
  float cp = cos(uPitch), sp = sin(uPitch);
  vec3 r1 = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  float cy = cos(uYaw), sy = sin(uYaw);
  vec3 w = vec3(r1.x * cy + r1.z * sy, r1.y, -r1.x * sy + r1.z * cy);
  float u = atan(w.x, w.z) / (2.0 * PI) + 0.5;
  float v = 0.5 - asin(clamp(w.y, -1.0, 1.0)) / PI + uHorizon;
  if (v < 0.0 || v > 1.0) { sortie = vec4(0.04, 0.05, 0.06, 1.0); return; }
  vec2 uv = vec2(u, v);
  vec2 uvDecale = vec2(fract(u + 0.5), v);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec2 dxD = dFdx(uvDecale), dyD = dFdy(uvDecale);
  if (abs(dxD.x) + abs(dyD.x) < abs(dx.x) + abs(dy.x)) { dx = dxD; dy = dyD; }
  sortie = textureGrad(uPano, uv, dx, dy);
}`;

const OPTS_GL = { antialias: false, preserveDrawingBuffer: false, alpha: false };

export class VisionneusePano {
  constructor(canvas) {
    this.canvas = canvas;
    this.yaw = 0;
    this.pitch = 0;
    this.fov = 75 * Math.PI / 180;
    this.fovMin = 25 * Math.PI / 180;
    this.fovMax = 120 * Math.PI / 180;
    this.horizon = 0;
    this.gyroActif = false;
    this.pret = false;
    this.onChange = null;      // appelé à chaque rendu (pour repositionner les surcouches)
    this.onTap = null;         // (u, v, evt) sur un appui simple
    this._texture = null;
    this._raf = null;
    this._gyroBase = null;
    this._initGL();
    this._initGestes();
  }

  /* ---------- initialisation WebGL ---------- */

  _initGL() {
    // WebGL2 d'abord (meilleur filtrage). Si le pilote refuse le programme, on
    // ne peut pas demander WebGL1 sur la même toile : on la remplace par une neuve.
    try {
      this._initProgramme(this.canvas.getContext('webgl2', OPTS_GL), true);
      return;
    } catch (e) {
      if (this.gl) { console.warn('[visionneuse] WebGL2 refusé, repli WebGL1', e); this._remplacerToile(); }
    }
    try {
      this._initProgramme(this.canvas.getContext('webgl', OPTS_GL) || this.canvas.getContext('experimental-webgl', OPTS_GL), false);
    } catch (e) {
      this.gl = null;
      this.erreur = "L'affichage 3D n'a pas pu démarrer sur cet appareil (" + (e.message || e) + ").";
    }
  }

  _remplacerToile() {
    const neuve = this.canvas.cloneNode(false);
    this.canvas.replaceWith(neuve);
    this.canvas = neuve;
    this.gl = null;
  }

  _initProgramme(gl, webgl2) {
    if (!gl) throw new Error('contexte indisponible');
    this.gl = gl;
    this.webgl2 = webgl2;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'compilation');
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, webgl2 ? VS2 : VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, webgl2 ? FS2 : FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'liaison');
    gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.u = {
      pano: gl.getUniformLocation(prog, 'uPano'),
      yaw: gl.getUniformLocation(prog, 'uYaw'),
      pitch: gl.getUniformLocation(prog, 'uPitch'),
      tan: gl.getUniformLocation(prog, 'uTan'),
      aspect: gl.getUniformLocation(prog, 'uAspect'),
      horizon: gl.getUniformLocation(prog, 'uHorizon')
    };

    // Safari retire le contexte graphique quand la mémoire manque : la vue
    // deviendrait noire sans explication. On prévient, et on recharge seul
    // si le navigateur rend le contexte.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.pret = false;
      if (!this._detruit && this.onPerte) this.onPerte();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      if (this._detruit) return;
      this._initProgramme(this.canvas.getContext(webgl2 ? 'webgl2' : 'webgl', OPTS_GL), webgl2);
      if (this._source) this.charger(this._source).then(() => this.onRetablie && this.onRetablie());
    });
  }

  /** Charge une panoramique équirectangulaire (Blob, URL ou HTMLImageElement). */
  async charger(source) {
    if (!this.gl || this.gl.isContextLost()) return false;
    this._source = source;
    const gl = this.gl;
    // 8192 px suffisent largement à l'écran d'un téléphone ; au-delà, la
    // mémoire graphique d'un iPhone devient le facteur limitant
    const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    const src = await imageAuPlus(source, max);

    if (this._texture) gl.deleteTexture(this._texture);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);

    const puissanceDe2 = (n) => (n & (n - 1)) === 0;
    const mip = this.webgl2 || (puissanceDe2(src.width) && puissanceDe2(src.height));
    // WebGL1 refuse REPEAT sur une image dont la taille n'est pas une puissance de 2
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mip ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mip) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic') ||
                    gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
      if (aniso) {
        const m = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, m));
      }
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    if (src.close) try { src.close(); } catch (e) {}

    this._texture = tex;
    this.tailleImage = { w: src.width, h: src.height };
    this.pret = true;

    // en portrait, un champ vertical de 75° ne laisse que ~40° à l'horizontale :
    // l'image est alors fortement agrandie et paraît floue. On ouvre davantage.
    if (!this._fovInitialise) {
      const r = this.canvas.getBoundingClientRect();
      this.fov = (r.width < r.height ? 100 : 75) * Math.PI / 180;
      this._fovInitialise = true;
    }
    this.redimensionner();
    this.rendre();
    return true;
  }

  redimensionner() {
    if (!this.gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    this.rendre();
  }

  rendre() {
    if (!this.gl || !this.pret || this.gl.isContextLost()) return;
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      const gl = this.gl;
      this.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, this.pitch));
      gl.uniform1f(this.u.yaw, this.yaw);
      gl.uniform1f(this.u.pitch, this.pitch);
      gl.uniform1f(this.u.tan, Math.tan(this.fov / 2));
      gl.uniform1f(this.u.aspect, this.canvas.width / this.canvas.height);
      gl.uniform1f(this.u.horizon, this.horizon);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texture);
      gl.uniform1i(this.u.pano, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (this.onChange) this.onChange();
    });
  }

  /* ---------- correspondance écran <-> panoramique ---------- */

  /** Pixel écran (relatif au canvas, en CSS px) -> coordonnées u,v de la pano. */
  ecranVersUV(px, py) {
    const r = this.canvas.getBoundingClientRect();
    const sx = (px / r.width) * 2 - 1;
    const sy = 1 - (py / r.height) * 2;
    const t = Math.tan(this.fov / 2);
    const aspect = r.width / r.height;
    let d = { x: sx * t * aspect, y: sy * t, z: 1 };
    const n = Math.hypot(d.x, d.y, d.z); d = { x: d.x / n, y: d.y / n, z: d.z / n };

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const r1 = { x: d.x, y: d.y * cp + d.z * sp, z: -d.y * sp + d.z * cp };
    const cy = Math.cos(this.yaw), sy2 = Math.sin(this.yaw);
    const w = { x: r1.x * cy + r1.z * sy2, y: r1.y, z: -r1.x * sy2 + r1.z * cy };

    const a = Math.atan2(w.x, w.z);
    const e = Math.asin(Math.max(-1, Math.min(1, w.y)));
    let u = a / (2 * Math.PI) + 0.5;
    u = ((u % 1) + 1) % 1;
    const v = 0.5 - e / Math.PI + this.horizon;
    return { u, v, a, e };
  }

  /** Coordonnées u,v de la pano -> pixel écran. visible=false si hors champ. */
  uvVersEcran(u, v) {
    const a = (u - 0.5) * 2 * Math.PI;
    const e = (0.5 - (v - this.horizon)) * Math.PI;
    const ce = Math.cos(e);
    const w = { x: ce * Math.sin(a), y: Math.sin(e), z: ce * Math.cos(a) };

    // inverse de la rotation de rendu
    const cy = Math.cos(this.yaw), sy2 = Math.sin(this.yaw);
    const r1 = { x: w.x * cy - w.z * sy2, y: w.y, z: w.x * sy2 + w.z * cy };
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const d = { x: r1.x, y: r1.y * cp - r1.z * sp, z: r1.y * sp + r1.z * cp };

    const rect = this.canvas.getBoundingClientRect();
    if (d.z <= 0.001) return { visible: false, x: 0, y: 0 };
    const t = Math.tan(this.fov / 2);
    const aspect = rect.width / rect.height;
    const sx = d.x / d.z / (t * aspect);
    const sy = d.y / d.z / t;
    const x = (sx * 0.5 + 0.5) * rect.width;
    const y = (1 - (sy * 0.5 + 0.5)) * rect.height;
    const marge = 80;
    return {
      visible: x > -marge && x < rect.width + marge && y > -marge && y < rect.height + marge,
      x, y
    };
  }

  /** Oriente la vue vers un point de la pano. */
  viser(u, v, animer = true) {
    const a = (u - 0.5) * 2 * Math.PI;
    const e = (0.5 - (v - this.horizon)) * Math.PI;
    if (!animer) { this.yaw = a; this.pitch = e; this.rendre(); return; }
    const y0 = this.yaw, p0 = this.pitch;
    let dy = a - y0;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    const dp = e - p0;
    const t0 = performance.now(), duree = 420;
    const pas = () => {
      const k = Math.min(1, (performance.now() - t0) / duree);
      const f = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
      this.yaw = y0 + dy * f; this.pitch = p0 + dp * f;
      this.rendre();
      if (k < 1) requestAnimationFrame(pas);
    };
    requestAnimationFrame(pas);
  }

  /* ---------- gestes ---------- */

  _initGestes() {
    const c = this.canvas;
    let pointeurs = new Map();
    let dragDepart = null, pinceDepart = null, aBouge = false;

    const pos = (e) => ({ x: e.clientX, y: e.clientY });

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointeurs.set(e.pointerId, pos(e));
      aBouge = false;
      if (pointeurs.size === 1) {
        dragDepart = { ...pos(e), yaw: this.yaw, pitch: this.pitch };
      } else if (pointeurs.size === 2) {
        const [a, b] = [...pointeurs.values()];
        pinceDepart = { dist: Math.hypot(a.x - b.x, a.y - b.y), fov: this.fov };
        dragDepart = null;
      }
    });

    c.addEventListener('pointermove', (e) => {
      if (!pointeurs.has(e.pointerId)) return;
      pointeurs.set(e.pointerId, pos(e));

      if (pointeurs.size === 2 && pinceDepart) {
        const [a, b] = [...pointeurs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 4) {
          this.fov = Math.max(this.fovMin, Math.min(this.fovMax, pinceDepart.fov * pinceDepart.dist / d));
          this.rendre();
        }
        aBouge = true;
        return;
      }

      if (dragDepart && pointeurs.size === 1) {
        const r = c.getBoundingClientRect();
        const dx = e.clientX - dragDepart.x, dy = e.clientY - dragDepart.y;
        if (Math.hypot(dx, dy) > 6) aBouge = true;
        const parPx = this.fov / r.height;
        this.yaw = dragDepart.yaw - dx * parPx;
        this.pitch = dragDepart.pitch + dy * parPx;
        this.gyroActif = false;
        this.rendre();
      }
    });

    const fin = (e) => {
      const etait = pointeurs.size;
      pointeurs.delete(e.pointerId);
      if (pointeurs.size < 2) pinceDepart = null;
      if (pointeurs.size === 0) {
        if (!aBouge && etait === 1 && this.onTap) {
          const r = c.getBoundingClientRect();
          const uv = this.ecranVersUV(e.clientX - r.left, e.clientY - r.top);
          this.onTap(uv.u, uv.v, e);
        }
        dragDepart = null;
      } else if (pointeurs.size === 1) {
        const [p] = [...pointeurs.values()];
        dragDepart = { x: p.x, y: p.y, yaw: this.yaw, pitch: this.pitch };
      }
    };
    c.addEventListener('pointerup', fin);
    c.addEventListener('pointercancel', fin);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.fov = Math.max(this.fovMin, Math.min(this.fovMax, this.fov * (1 + e.deltaY * 0.0012)));
      this.rendre();
    }, { passive: false });
  }

  /* ---------- gyroscope ---------- */

  /** Active le pilotage par mouvement du téléphone. Renvoie false si refusé/indisponible. */
  async activerGyro() {
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const rep = await DeviceOrientationEvent.requestPermission();
        if (rep !== 'granted') return false;
      }
    } catch (e) { return false; }

    if (!this._gyroHandler) {
      this._gyroHandler = (ev) => {
        if (!this.gyroActif || ev.alpha == null) return;
        const alpha = ev.alpha * Math.PI / 180;
        const beta = ev.beta * Math.PI / 180;
        if (!this._gyroBase) this._gyroBase = { alpha, yaw: this.yaw };
        this.yaw = this._gyroBase.yaw - (alpha - this._gyroBase.alpha);
        this.pitch = Math.max(-1.5, Math.min(1.5, beta - Math.PI / 2));
        this.rendre();
      };
      window.addEventListener('deviceorientation', this._gyroHandler, true);
    }
    this._gyroBase = null;
    this.gyroActif = true;
    return true;
  }

  desactiverGyro() { this.gyroActif = false; this._gyroBase = null; }

  detruire() {
    this._detruit = true;
    if (this._gyroHandler) window.removeEventListener('deviceorientation', this._gyroHandler, true);
    if (this.gl && this._texture) this.gl.deleteTexture(this._texture);
    // Safari ne libère la mémoire d'un contexte que tardivement ; d'une vue à
    // l'autre, les contextes s'accumulaient jusqu'à saturation (écran noir)
    try { const ext = this.gl && this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) {}
    this.canvas.width = 1; this.canvas.height = 1;
    this.gl = null;
    this._source = null;
    this.pret = false;
  }
}

/* ---------- utilitaires ---------- */

/**
 * Renvoie une image d'au plus `max` px de large. createImageBitmap réduit
 * sans canvas intermédiaire (un canvas de plus de 16,7 millions de pixels
 * échoue sur iPhone) ; à défaut, on passe par un canvas de 5760 px au plus.
 */
async function imageAuPlus(source, max) {
  const img = await chargerImage(source);
  if (img.width <= max) return img;
  const h = Math.round(img.height * max / img.width);
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(img, { resizeWidth: max, resizeHeight: h, resizeQuality: 'high' }); }
    catch (e) { /* repli canvas */ }
  }
  const l = Math.min(max, 5760);
  const c = document.createElement('canvas');
  c.width = l; c.height = Math.round(img.height * l / img.width);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export function chargerImage(source) {
  return new Promise((resolve, reject) => {
    if (source instanceof HTMLImageElement && source.complete) return resolve(source);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (source instanceof Blob) URL.revokeObjectURL(img.src);
      resolve(img);
    };
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = source instanceof Blob ? URL.createObjectURL(source) : source;
  });
}

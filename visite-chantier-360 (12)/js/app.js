/* ============================================================
   app.js — Visite Chantier 360
   Application de relevé de visites de chantier en 360°
   ============================================================ */

import * as DB from './db.js?v=16';
import * as G from './geo.js?v=16';
import { VisionneusePano, chargerImage } from './viewer.js?v=16';
import * as CAP from './capture.js?v=16';
import * as AL from './alignement.js?v=16';
import * as C from './carte.js?v=16';

/* ============================================================
   ETAT ET UTILITAIRES
   ============================================================ */

export const VERSION = '16';

const S = {
  vue: 'accueil',
  chantierId: null,
  visiteId: null,
  stationId: null,
  onglet: 'stations',
  visionneuse: null,
  modeViseur: 'navigation',   // navigation | mesure | observation | lien
  mesureEnCours: null,
  typeMesure: 'sol',
  retour: []
};

const CAPACITES = {
  camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  mouvement: typeof DeviceOrientationEvent !== 'undefined',
  telechargement: (() => {
    try { const a = document.createElement('a'); return 'download' in a; } catch (e) { return false; }
  })(),
  serviceWorker: 'serviceWorker' in navigator
};

/**
 * Autorisation d'accès au mouvement.
 * iOS n'accorde cette autorisation que si requestPermission part directement
 * du geste de l'utilisateur. Le moindre await avant l'appel fait perdre le
 * contexte de geste et la demande est refusée sans même afficher de fenêtre.
 * Cette fonction doit donc être appelée en tête d'un gestionnaire de clic,
 * jamais après une navigation ou une lecture en base.
 */
let _mouvementAutorise = false;
function demanderMouvement() {
  if (_mouvementAutorise) return Promise.resolve(true);
  if (typeof DeviceOrientationEvent === 'undefined') return Promise.resolve(false);
  if (typeof DeviceOrientationEvent.requestPermission !== 'function') {
    _mouvementAutorise = true;
    return Promise.resolve(true);
  }
  return DeviceOrientationEvent.requestPermission()
    .then((r) => { _mouvementAutorise = (r === 'granted'); return _mouvementAutorise; })
    .catch(() => false);
}

const TYPES_OBS = [
  { cle: 'infiltration', nom: 'Infiltration', ico: '💧' },
  { cle: 'etancheite', nom: 'Défaut étanchéité', ico: '🛡' },
  { cle: 'fissure', nom: 'Fissure', ico: '⚡' },
  { cle: 'relevé', nom: 'Relevé / acrotère', ico: '📐' },
  { cle: 'evacuation', nom: 'Évacuation / EP', ico: '🕳' },
  { cle: 'securite', nom: 'Sécurité', ico: '⚠️' },
  { cle: 'avancement', nom: 'Avancement', ico: '📈' },
  { cle: 'reserve', nom: 'Réserve', ico: '📌' },
  { cle: 'autre', nom: 'Autre', ico: '•' }
];

const el = (sel) => document.querySelector(sel);
const app = () => el('#app');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dateFR(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}
function dateHeureFR(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function dateInput(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toISOString().slice(0, 10);
}

let _toastTimer = null;
function toast(msg, genre = '') {
  const vieux = el('.toast'); if (vieux) vieux.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + genre;
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.remove(), genre === 'err' ? 4200 : 2400);
}

/* ---------- modale ---------- */

function modale(titre, intro, corpsHTML, actions = []) {
  fermerModale();
  const voile = document.createElement('div');
  voile.className = 'voile';
  voile.innerHTML = `
    <div class="modale" role="dialog" aria-modal="true">
      <h2>${esc(titre)}</h2>
      ${intro ? `<p class="intro">${intro}</p>` : ''}
      <div id="modale-corps">${corpsHTML}</div>
      <div class="rangee-btn" id="modale-actions" style="margin-top:16px"></div>
    </div>`;
  voile.addEventListener('click', (e) => { if (e.target === voile) fermerModale(); });
  document.body.appendChild(voile);

  const zone = voile.querySelector('#modale-actions');
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.genre || '');
    b.textContent = a.libelle;
    b.onclick = () => a.action && a.action(voile);
    zone.appendChild(b);
  }
  return voile;
}
function fermerModale() { const v = el('.voile'); if (v) v.remove(); }

function confirmer(titre, texte, libelleOk = 'Confirmer') {
  return new Promise((resolve) => {
    modale(titre, texte, '', [
      { libelle: 'Annuler', action: () => { fermerModale(); resolve(false); } },
      { libelle: libelleOk, genre: 'danger', action: () => { fermerModale(); resolve(true); } }
    ]);
  });
}

/* ---------- choix de fichier ---------- */

function choisirFichier({ accept = 'image/*', capture = null, multiple = false } = {}) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    if (capture) inp.capture = capture;
    inp.multiple = multiple;
    inp.style.position = 'fixed';
    inp.style.left = '-9999px';
    document.body.appendChild(inp);
    inp.onchange = () => {
      const f = multiple ? [...inp.files] : inp.files[0];
      inp.remove();
      resolve(f || null);
    };
    inp.oncancel = () => { inp.remove(); resolve(null); };
    inp.click();
  });
}

function telecharger(nomFichier, contenu, type = 'application/json') {
  const blob = contenu instanceof Blob ? contenu : new Blob([contenu], { type });
  if (!CAPACITES.telechargement) {
    if (typeof contenu === 'string' && navigator.clipboard) {
      navigator.clipboard.writeText(contenu)
        .then(() => toast('Téléchargement bloqué ici — contenu copié', 'ok'))
        .catch(() => toast('Téléchargement impossible dans cet environnement', 'err'));
    } else {
      toast('Téléchargement impossible dans cet environnement', 'err');
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nomFichier;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ---------- navigation ---------- */

function aller(vue, params = {}, empiler = true) {
  if (empiler && S.vue) S.retour.push({ vue: S.vue, chantierId: S.chantierId, visiteId: S.visiteId, stationId: S.stationId, onglet: S.onglet });
  if (S.visionneuse) { S.visionneuse.detruire(); S.visionneuse = null; }
  if (S.visionneuseB) { S.visionneuseB.detruire(); S.visionneuseB = null; }
  S.vue = vue;
  Object.assign(S, params);
  rendre();
}

function revenir() {
  const p = S.retour.pop();
  if (!p) { aller('accueil', {}, false); return; }
  if (S.visionneuse) { S.visionneuse.detruire(); S.visionneuse = null; }
  if (S.visionneuseB) { S.visionneuseB.detruire(); S.visionneuseB = null; }
  Object.assign(S, p);
  rendre();
}

const VUES = {};

async function rendre() {
  fermerModale();
  if (S.mini) { S.mini.detruire(); S.mini = null; }
  if (S.carteOnglet) { S.carteOnglet.detruire(); S.carteOnglet = null; }
  const fn = VUES[S.vue] || VUES.accueil;
  app().innerHTML = `<div class="corps"><div class="vide"><div class="ico">⏳</div><p>Chargement…</p></div></div>`;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    app().innerHTML = `<div class="corps"><div class="note alerte"><strong>Erreur d'affichage.</strong><br>${esc(e.message || e)}</div>
      <button class="btn large" onclick="location.reload()">Recharger l'application</button></div>`;
  }
}

function entete(titre, sous, avecRetour = true, actionHTML = '') {
  return `<header class="entete">
    ${avecRetour ? `<button class="btn-retour" id="btn-retour" aria-label="Retour">‹</button>` : ''}
    <div class="titre-bloc">
      <h1>${esc(titre)}</h1>
      ${sous ? `<p class="sous">${esc(sous)}</p>` : ''}
    </div>
    ${actionHTML}
  </header>`;
}

function brancherRetour() {
  const b = el('#btn-retour');
  if (b) b.onclick = () => revenir();
}

/* ============================================================
   VUE : ACCUEIL — liste des chantiers
   ============================================================ */

VUES.accueil = async function () {
  const chantiers = await DB.tout('chantiers');
  chantiers.sort((a, b) => (b.modifieLe || '').localeCompare(a.modifieLe || ''));

  const lignes = [];
  for (const c of chantiers) {
    const visites = await DB.parIndex('visites', 'chantierId', c.id);
    visites.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const derniere = visites[0];
    let nbStations = 0;
    for (const v of visites) nbStations += (await DB.parIndex('stations', 'visiteId', v.id)).length;
    lignes.push(`
      <button class="item" data-chantier="${c.id}">
        <div class="vignette">🏗</div>
        <div class="corps-item">
          <div class="nom">${esc(c.nom)}</div>
          <div class="meta">${visites.length} visite${visites.length > 1 ? 's' : ''} · ${nbStations} vue${nbStations > 1 ? 's' : ''} 360°${derniere ? ' · dernière le ' + dateFR(derniere.date) : ''}</div>
        </div>
        <span class="chev">›</span>
      </button>`);
  }

  const espace = await DB.espaceDisque();

  app().innerHTML = `
    ${entete('Visite Chantier 360', 'Mémoire visuelle horodatée de vos chantiers', false,
      `<button class="btn-retour" id="btn-reglages" aria-label="Réglages">⚙</button>`)}
    <div class="corps">
      ${DB.stockageIndisponible() ? `<div class="note alerte"><strong>Stockage indisponible.</strong> Ce navigateur refuse l'enregistrement local. Rien ne sera conservé en quittant.</div>` : ''}
      ${avertissementEnvironnement()}
      ${chantiers.length === 0 ? `
        <div class="vide">
          <div class="ico">📷</div>
          <p><strong>Appuyez sur « Prendre une 360° ».</strong></p>
          <p>Donnez le nom du chantier, la caméra s'ouvre. La visite du jour est créée
          toute seule, et chaque vue y est rangée avec sa date.</p>
        </div>` : lignes.join('')}
      <p style="font-size:12px;color:var(--texte-3);text-align:center;margin-top:18px">
        Version ${VERSION}${espace && espace.utilise > 0 ? ` · ${(espace.utilise / 1048576).toFixed(0)} Mo utilisés` : ''}</p>
    </div>
    <div class="barre-bas">
      <button class="btn" id="btn-nouveau" style="flex:0 0 auto">+ Chantier</button>
      <button class="btn" id="btn-parcours-rapide">🚶 Parcours</button>
      <button class="btn principal" id="btn-prise-rapide">📷 360°</button>
    </div>`;

  for (const b of document.querySelectorAll('[data-chantier]')) {
    b.onclick = () => aller('chantier', { chantierId: b.dataset.chantier, onglet: 'visites' });
  }
  el('#btn-nouveau').onclick = () => formChantier();
  el('#btn-prise-rapide').onclick = () => lancerPrise(choisirChantierPourPrise);
  el('#btn-parcours-rapide').onclick = () => lancerParcours(choisirChantierPourPrise);
  el('#btn-reglages').onclick = () => vueReglages();
};

function avertissementEnvironnement() {
  const manques = [];
  if (!CAPACITES.camera) manques.push('la caméra');
  if (!CAPACITES.mouvement) manques.push('le gyroscope');
  if (!manques.length) return '';
  return `<div class="note attention">
    <strong>Environnement limité.</strong> Cette page n'a pas accès à ${manques.join(' ni ')}.
    L'import de panoramiques, la navigation 360° et la cotation fonctionnent normalement.
    Pour la prise de vue guidée, ouvrez l'application depuis son adresse web propre
    (déploiement Netlify) et installez-la sur l'écran d'accueil.</div>`;
}

function formChantier(existant = null) {
  const c = existant || {};
  modale(existant ? 'Modifier le chantier' : 'Nouveau chantier', '', `
    <div class="champ"><label>Nom du chantier *</label>
      <input id="f-nom" value="${esc(c.nom || '')}" placeholder="Résidence Les Lauriers — bât. B"></div>
    <div class="champ"><label>Adresse</label>
      <input id="f-adresse" value="${esc(c.adresse || '')}" placeholder="12 rue des Chantiers, Marseille"></div>
    <div class="champ"><label>Maître d'ouvrage / client</label>
      <input id="f-client" value="${esc(c.client || '')}" placeholder="Syndic Foncia / SDC"></div>
    <div class="champ"><label>Nature des travaux</label>
      <input id="f-nature" value="${esc(c.nature || '')}" placeholder="Réfection étanchéité toiture-terrasse"></div>
    <div class="champ"><label>Hauteur d'objectif par défaut</label>
      <input id="f-hc" type="number" step="0.01" min="0.2" max="3" value="${c.hcDefaut ?? 1.60}">
      <div class="aide">Hauteur du centre de l'objectif au-dessus du sol, en mètres. C'est la donnée dont dépend
      toute la cotation : sur trépied mesurez-la une fois, à main levée comptez la hauteur de vos yeux moins 10 cm.</div></div>
  `, [
    { libelle: 'Annuler', action: fermerModale },
    {
      libelle: existant ? 'Enregistrer' : 'Créer', genre: 'principal', action: async () => {
        const nom = el('#f-nom').value.trim();
        if (!nom) { toast('Le nom est obligatoire', 'err'); return; }
        const obj = {
          id: existant ? existant.id : DB.uid('ch'),
          nom,
          adresse: el('#f-adresse').value.trim(),
          client: el('#f-client').value.trim(),
          nature: el('#f-nature').value.trim(),
          hcDefaut: parseFloat(el('#f-hc').value) || 1.60,
          creeLe: existant ? existant.creeLe : new Date().toISOString(),
          modifieLe: new Date().toISOString()
        };
        await DB.enregistrer('chantiers', obj);
        fermerModale();
        if (existant) rendre(); else aller('chantier', { chantierId: obj.id, onglet: 'visites' });
      }
    }
  ]);
  setTimeout(() => el('#f-nom') && el('#f-nom').focus(), 120);
}

/* ============================================================
   VUE : CHANTIER — visites datées
   ============================================================ */

VUES.chantier = async function () {
  const c = await DB.lire('chantiers', S.chantierId);
  if (!c) return aller('accueil', {}, false);
  const visites = await DB.parIndex('visites', 'chantierId', c.id);
  visites.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const lignes = [];
  for (const v of visites) {
    const st = await DB.statsVisite(v.id);
    const stations = await DB.parIndex('stations', 'visiteId', v.id);
    let apercu = '';
    const avecPano = stations.find((s) => s.pano);
    if (avecPano) apercu = URL.createObjectURL(avecPano.vignette || avecPano.pano);
    lignes.push(`
      <button class="item" data-visite="${v.id}">
        <div class="vignette" ${apercu ? `style="background-image:url(${apercu})"` : ''}>${apercu ? '' : '📅'}</div>
        <div class="corps-item">
          <div class="nom">${dateFR(v.date)}${v.objet ? ' — ' + esc(v.objet) : ''}</div>
          <div class="meta">${st.nbStations} vue${st.nbStations > 1 ? 's' : ''} 360° · ${st.nbPins} observation${st.nbPins > 1 ? 's' : ''} · ${st.nbMesures} cote${st.nbMesures > 1 ? 's' : ''}</div>
        </div>
        <span class="chev">›</span>
      </button>`);
  }

  app().innerHTML = `
    ${entete(c.nom, [c.nature, c.adresse].filter(Boolean).join(' · '), true,
      `<button class="btn-retour" id="btn-menu" aria-label="Menu">⋯</button>`)}
    <div class="corps">
      ${visites.length > 1 ? `<button class="btn large" id="btn-comparer" style="margin-bottom:14px">⇄ Comparer deux visites</button>` : ''}
      ${visites.length === 0 ? `
        <div class="vide">
          <div class="ico">📅</div>
          <p><strong>Aucune visite.</strong></p>
          <p>Chaque passage sur le chantier est une visite datée. Refaites les mêmes
          stations d'une visite à l'autre pour suivre l'évolution.</p>
        </div>` : `<p class="carte-titre">Visites</p>` + lignes.join('')}
    </div>
    <div class="barre-bas">
      <button class="btn" id="btn-visite" style="flex:0 0 auto">+ Visite</button>
      <button class="btn" id="btn-parcours-chantier">🚶 Parcours</button>
      <button class="btn principal" id="btn-prise-chantier">📷 360°</button>
    </div>`;

  brancherRetour();
  for (const b of document.querySelectorAll('[data-visite]')) {
    b.onclick = () => aller('visite', { visiteId: b.dataset.visite, onglet: 'stations' });
  }
  el('#btn-visite').onclick = () => formVisite(c);
  el('#btn-prise-chantier').onclick = () => lancerPrise(() => visiteDuJour(c.id));
  el('#btn-parcours-chantier').onclick = () => lancerParcours(() => visiteDuJour(c.id));
  if (el('#btn-comparer')) el('#btn-comparer').onclick = () => aller('comparer', {});
  el('#btn-menu').onclick = () => {
    modale(c.nom, '', `
      <button class="btn large" id="m-modif" style="margin-bottom:9px">Modifier le chantier</button>
      <button class="btn large" id="m-export" style="margin-bottom:9px">Exporter (sauvegarde complète)</button>
      <button class="btn large" id="m-rapport" style="margin-bottom:9px">Rapport de toutes les visites</button>
      <button class="btn large danger" id="m-suppr">Supprimer le chantier</button>`, []);
    el('#m-modif').onclick = () => { fermerModale(); formChantier(c); };
    el('#m-export').onclick = () => { fermerModale(); exporterChantier(c); };
    el('#m-rapport').onclick = () => { fermerModale(); aller('rapport', { visiteId: null }); };
    el('#m-suppr').onclick = async () => {
      fermerModale();
      if (await confirmer('Supprimer ce chantier ?',
        `Toutes les visites, vues 360°, observations et cotes de <strong>${esc(c.nom)}</strong> seront effacées définitivement. Exportez une sauvegarde avant si besoin.`,
        'Supprimer')) {
        await DB.supprimerChantier(c.id);
        toast('Chantier supprimé');
        aller('accueil', {}, false);
      }
    };
  };
};

function formVisite(chantier, existant = null) {
  const v = existant || {};
  modale(existant ? 'Modifier la visite' : 'Nouvelle visite', '', `
    <div class="champ"><label>Date de la visite *</label>
      <input id="f-date" type="date" value="${dateInput(v.date)}"></div>
    <div class="champ"><label>Objet de la visite</label>
      <input id="f-objet" value="${esc(v.objet || '')}" placeholder="Réception support / constat infiltration">
      <div class="aide">Ce qui vous amène sur place ce jour-là.</div></div>
    <div class="deux-col">
      <div class="champ"><label>Météo</label>
        <select id="f-meteo">
          ${['', 'Ensoleillé', 'Couvert', 'Pluie', 'Vent', 'Après pluie', 'Chaleur'].map((m) =>
            `<option ${v.meteo === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select></div>
      <div class="champ"><label>Intervenants présents</label>
        <input id="f-presents" value="${esc(v.presents || '')}" placeholder="MOE, entreprise"></div>
    </div>
    <div class="champ"><label>Observations générales</label>
      <textarea id="f-notes" placeholder="Contexte, conditions, points traités…">${esc(v.notes || '')}</textarea></div>
  `, [
    { libelle: 'Annuler', action: fermerModale },
    {
      libelle: existant ? 'Enregistrer' : 'Créer', genre: 'principal', action: async () => {
        const obj = {
          id: existant ? existant.id : DB.uid('vi'),
          chantierId: chantier.id,
          date: el('#f-date').value || dateInput(),
          objet: el('#f-objet').value.trim(),
          meteo: el('#f-meteo').value,
          presents: el('#f-presents').value.trim(),
          notes: el('#f-notes').value.trim(),
          creeLe: existant ? existant.creeLe : new Date().toISOString()
        };
        await DB.enregistrer('visites', obj);
        await DB.enregistrer('chantiers', { ...chantier, modifieLe: new Date().toISOString() });
        fermerModale();
        if (existant) rendre(); else aller('visite', { visiteId: obj.id, onglet: 'stations' });
      }
    }
  ]);
}

/* ============================================================
   VUE : VISITE — stations, plan, observations, cotes
   ============================================================ */

VUES.visite = async function () {
  const v = await DB.lire('visites', S.visiteId);
  if (!v) return revenir();
  const c = await DB.lire('chantiers', v.chantierId);
  S.chantierId = v.chantierId;

  const onglets = [
    ['stations', 'Vues 360°'],
    ['carte', 'Carte'],
    ['plan', 'Plan'],
    ['observations', 'Observ.'],
    ['toiture', 'Toiture'],
    ['cotes', 'Cotes']
  ];

  app().innerHTML = `
    ${entete(dateFR(v.date) + (v.objet ? ' — ' + v.objet : ''), c ? c.nom : '', true,
      `<button class="btn-retour" id="btn-menu" aria-label="Menu">⋯</button>`)}
    <div class="corps">
      <div class="segments">
        ${onglets.map(([k, n]) => `<button data-onglet="${k}" class="${S.onglet === k ? 'actif' : ''}">${n}</button>`).join('')}
      </div>
      <div id="zone-onglet"></div>
    </div>
    <div class="barre-bas" id="barre"></div>`;

  brancherRetour();
  for (const b of document.querySelectorAll('[data-onglet]')) {
    b.onclick = () => { S.onglet = b.dataset.onglet; rendre(); };
  }
  el('#btn-menu').onclick = () => menuVisite(v, c);

  const zone = el('#zone-onglet'), barre = el('#barre');
  if (S.onglet === 'stations') await ongletStations(v, zone, barre);
  else if (S.onglet === 'carte') await ongletCarto(v, zone, barre, 'carte');
  else if (S.onglet === 'plan') await ongletCarto(v, zone, barre, 'plan');
  else if (S.onglet === 'observations') await ongletObservations(v, zone, barre);
  else if (S.onglet === 'toiture') await ongletToiture(v, zone, barre);
  else await ongletCotes(v, zone, barre);
};

function menuVisite(v, c) {
  modale('Visite du ' + dateFR(v.date), '', `
    <button class="btn large" id="m-modif" style="margin-bottom:9px">Modifier la visite</button>
    <button class="btn large" id="m-rapport" style="margin-bottom:9px">Rapport de visite</button>
    <button class="btn large danger" id="m-suppr">Supprimer la visite</button>`, []);
  el('#m-modif').onclick = () => { fermerModale(); formVisite(c, v); };
  el('#m-rapport').onclick = () => { fermerModale(); aller('rapport', {}); };
  el('#m-suppr').onclick = async () => {
    fermerModale();
    if (await confirmer('Supprimer cette visite ?',
      `Les ${(await DB.statsVisite(v.id)).nbStations} vues 360° de cette visite et tout ce qu'elles portent seront effacés.`, 'Supprimer')) {
      await DB.supprimerVisite(v.id);
      toast('Visite supprimée');
      aller('chantier', { visiteId: null, onglet: 'visites' }, false);
    }
  };
}

/* ---------- onglet : stations ---------- */

async function ongletStations(v, zone, barre) {
  const stations = await DB.parIndex('stations', 'visiteId', v.id);
  stations.sort((a, b) => (a.ordre || 0) - (b.ordre || 0));

  if (!stations.length) {
    zone.innerHTML = `
      <div class="note info">
        <strong>Une station = un point de prise de vue.</strong> Posez-vous à un endroit,
        faites la vue 360°, nommez-la (« terrasse nord », « local technique »), passez au
        point suivant. À la visite suivante, refaites les mêmes stations avec les mêmes noms :
        l'app pourra comparer les deux dates.
      </div>
      <div class="vide"><div class="ico">🎥</div>
        <p><strong>Aucune vue 360° dans cette visite.</strong></p>
        <p>Appuyez sur « Prendre une 360° » en bas de l'écran.</p></div>`;
  } else {
    const lignes = [];
    for (const s of stations) {
      const pins = await DB.parIndex('pins', 'stationId', s.id);
      const mes = await DB.parIndex('mesures', 'stationId', s.id);
      const url = s.pano ? URL.createObjectURL(s.vignette || s.pano) : null;
      const etiq = s.type === 'equirect-complet'
        ? '<span class="etiq ok">Sphère complète</span>'
        : s.type === 'photo'
          ? '<span class="etiq">Photo fixe</span>'
          : '<span class="etiq accent">360° partielle</span>';
      lignes.push(`
        <button class="item" data-station="${s.id}">
          <div class="vignette" ${url ? `style="background-image:url(${url})"` : ''}>${url ? '' : '🎥'}</div>
          <div class="corps-item">
            <div class="nom">${esc(s.nom)}</div>
            <div class="meta">${etiq} ${pins.length ? '· ' + pins.length + ' obs.' : ''} ${mes.length ? '· ' + mes.length + ' cote' + (mes.length > 1 ? 's' : '') : ''}</div>
          </div>
          <span class="chev">›</span>
        </button>`);
    }
    zone.innerHTML = `<p class="carte-titre">${stations.length} station${stations.length > 1 ? 's' : ''}</p>` + lignes.join('');
  }

  for (const b of document.querySelectorAll('[data-station]')) {
    b.onclick = () => aller('viseur', { stationId: b.dataset.station });
  }

  barre.innerHTML = `
    <button class="btn" id="b-import">Importer</button>
    <button class="btn" id="b-parcours">🚶 Parcours</button>
    <button class="btn principal" id="b-prise">📷 360°</button>`;
  el('#b-import').onclick = () => importerStation(v);
  el('#b-parcours').onclick = () => lancerParcours(async () => v);
  el('#b-prise').onclick = () => lancerPrise(async () => v);
}


/* ============================================================
   LANCEMENT DE LA PRISE DE VUE — depuis n'importe quel écran
   ------------------------------------------------------------
   A appeler DIRECTEMENT dans un gestionnaire de clic : la demande
   d'accès au gyroscope part en premier, avant tout await, sinon
   iOS la refuse sans même afficher sa fenêtre.
   obtenirVisite : fonction async qui renvoie la visite où ranger
   la vue (ou null si l'utilisateur annule).
   ============================================================ */

function lancerPrise(obtenirVisite) {
  const possible = CAPACITES.camera && CAPACITES.mouvement;
  const autorisation = possible ? demanderMouvement() : Promise.resolve(false);

  (async () => {
    const v = await obtenirVisite();
    if (!v) return;

    if (!possible) {
      return modale('Prise de vue indisponible ici',
        `Cette page n'a pas accès à la caméra du téléphone.`, `
        <div class="note attention">Vous êtes probablement sur le lien de l'aperçu Claude, où la
        caméra est bloquée. Ouvrez l'application depuis votre adresse <strong>.netlify.app</strong>
        dans Safari, puis Partager &gt; Sur l'écran d'accueil.</div>
        <div class="note info">En attendant : prenez la vue avec l'appareil photo de l'iPhone en
        mode <strong>Pano</strong>, puis importez-la ici.</div>`, [
        { libelle: 'Fermer', action: fermerModale },
        { libelle: 'Importer une 360°', genre: 'principal', action: () => { fermerModale(); importerStation(v); } }
      ]);
    }

    await autorisation;

    // l'écran de prise de vue doit revenir sur la visite, quel que soit le point de départ
    if (!(S.vue === 'visite' && S.visiteId === v.id)) {
      S.retour.push({ vue: S.vue, chantierId: S.chantierId, visiteId: S.visiteId, stationId: S.stationId, onglet: S.onglet });
      Object.assign(S, { vue: 'visite', chantierId: v.chantierId, visiteId: v.id, onglet: 'stations' });
    }

    // l'angle de vue est désormais mesuré sur les images à chaque prise :
    // plus de calibration manuelle à faire avant
    aller('prise', {});
  })().catch((e) => toast('Erreur : ' + (e.message || e), 'err'));
}

/** Visite datée du jour pour ce chantier : reprise si elle existe, créée sinon. */
async function visiteDuJour(chantierId) {
  const jour = dateInput();
  const visites = await DB.parIndex('visites', 'chantierId', chantierId);
  let v = visites.find((x) => x.date === jour);
  if (!v) {
    v = { id: DB.uid('vi'), chantierId, date: jour, objet: '', meteo: '', presents: '', notes: '', creeLe: new Date().toISOString() };
    await DB.enregistrer('visites', v);
  }
  const c = await DB.lire('chantiers', chantierId);
  if (c) await DB.enregistrer('chantiers', { ...c, modifieLe: new Date().toISOString() });
  return v;
}

/** Choix rapide du chantier depuis l'accueil. Renvoie la visite du jour ou null. */
async function choisirChantierPourPrise() {
  const chantiers = await DB.tout('chantiers');
  chantiers.sort((a, b) => (b.modifieLe || '').localeCompare(a.modifieLe || ''));

  return new Promise((resolve) => {
    const creer = async () => {
      const nom = el('#q-nom').value.trim();
      if (!nom) { toast('Donnez un nom au chantier', 'err'); return; }
      const c = { id: DB.uid('ch'), nom, adresse: '', client: '', nature: '', hcDefaut: 1.60,
        creeLe: new Date().toISOString(), modifieLe: new Date().toISOString() };
      await DB.enregistrer('chantiers', c);
      fermerModale();
      resolve(await visiteDuJour(c.id));
    };

    modale('Prendre une 360°', chantiers.length ? 'Sur quel chantier ?' : 'Quel chantier ?', `
      ${chantiers.slice(0, 6).map((c) => `
        <button class="item" data-q="${c.id}" style="margin-bottom:8px">
          <div class="vignette">🏗</div>
          <div class="corps-item"><div class="nom">${esc(c.nom)}</div>
          <div class="meta">${esc(c.adresse || c.nature || 'Visite du jour créée automatiquement')}</div></div>
          <span class="chev">›</span>
        </button>`).join('')}
      <div class="champ" style="margin-top:${chantiers.length ? 14 : 0}px">
        <label>${chantiers.length ? 'Ou un nouveau chantier' : 'Nom du chantier'}</label>
        <input id="q-nom" placeholder="Résidence Les Lauriers — terrasse B">
      </div>`, [
      { libelle: 'Annuler', action: () => { fermerModale(); resolve(null); } },
      { libelle: 'Créer et prendre', genre: 'principal', action: creer }
    ]);

    for (const b of document.querySelectorAll('[data-q]')) {
      b.onclick = async () => { fermerModale(); resolve(await visiteDuJour(b.dataset.q)); };
    }
    const champ = el('#q-nom');
    champ.addEventListener('keydown', (e) => { if (e.key === 'Enter') creer(); });
    if (!chantiers.length) setTimeout(() => champ.focus(), 150);
  });
}

/* ---------- import d'une station ---------- */

async function importerStation(v) {
  const fichier = await choisirFichier({ accept: 'image/*' });
  if (!fichier) return;

  toast('Analyse de l\'image…');
  let info;
  try { info = await CAP.analyserImport(fichier); }
  catch (e) { return toast('Image illisible', 'err'); }

  const chantier = await DB.lire('chantiers', v.chantierId);
  const hcDefaut = chantier ? (chantier.hcDefaut ?? 1.60) : 1.60;
  const stations = await DB.parIndex('stations', 'visiteId', v.id);

  const estPartielle = info.type === 'panoramique-partielle';
  const genre = info.type === 'equirect-complet' ? 'ok' : info.type === 'photo' ? 'attention' : 'info';

  modale('Nouvelle vue 360°', '', `
    <div class="note ${genre}">${info.message}</div>
    <div class="champ"><label>Nom de la station *</label>
      <input id="f-nom" placeholder="Terrasse nord, cage d'escalier, local technique…">
      <div class="aide">Reprenez exactement ce nom aux visites suivantes pour pouvoir comparer les dates.</div></div>
    <div class="champ"><label>Hauteur d'objectif (m)</label>
      <input id="f-hc" type="number" step="0.01" min="0.2" max="4" value="${hcDefaut}">
      <div class="aide">Toutes les cotes en découlent. Un cm d'erreur ici fait environ 0,6 % d'erreur sur les distances.</div></div>
    ${estPartielle ? `
      <div class="champ"><label>Champ vertical couvert (°)</label>
        <input id="f-fov" type="number" step="1" min="20" max="179" value="${Math.round(info.fovVertical)}">
        <div class="aide">Estimé d'après les proportions de l'image (${info.largeur}×${info.hauteur}).
        Le mode Pano d'un smartphone couvre en général 50 à 70°.</div></div>
      <div class="champ"><label>Modèle de projection</label>
        <select id="f-modele">
          <option value="cylindrique" selected>Cylindrique (panoramique de smartphone)</option>
          <option value="equirect">Équirectangulaire (caméra 360°)</option>
        </select></div>` : ''}
    <div class="champ"><label>Note de station</label>
      <input id="f-note" placeholder="Ce que montre cette vue"></div>
  `, [
    { libelle: 'Annuler', action: fermerModale },
    {
      libelle: 'Ajouter', genre: 'principal', action: async () => {
        const nom = el('#f-nom').value.trim();
        if (!nom) { toast('Nommez la station', 'err'); return; }
        const btns = document.querySelectorAll('.modale .btn');
        btns.forEach((b) => b.disabled = true);
        toast('Préparation de la panoramique…');

        let blob = fichier, type = info.type, fovV = info.fovVertical;
        try {
          if (estPartielle) {
            fovV = parseFloat(el('#f-fov').value) || info.fovVertical;
            const r = await CAP.normaliserEnEquirect(fichier, {
              fovVertical: fovV,
              modele: el('#f-modele').value
            });
            blob = r.blob;
          } else if (info.type === 'equirect-complet') {
            // photo de caméra 360° : on garde l'original jusqu'à 8192 px, c'est
            // tout l'intérêt de la caméra. Au-delà (72 Mpx), 5760 px : la limite
            // qu'un iPhone sait réduire et réencoder sans échec.
            blob = info.largeur <= 8192 ? fichier : await CAP.reduire(fichier, 5760, 0.92);
          } else {
            blob = await CAP.reduire(fichier, 2560);
          }
        } catch (e) {
          console.error(e);
          toast('Traitement impossible, image conservée telle quelle', 'err');
        }

        const st = {
          id: DB.uid('st'),
          visiteId: v.id,
          nom,
          note: el('#f-note').value.trim(),
          pano: blob,
          ...(await CAP.apercusDe(blob).catch(() => ({}))),
          type,
          fovVertical: fovV,
          sphereComplete: info.sphereComplete,
          hc: parseFloat(el('#f-hc').value) || hcDefaut,
          horizon: 0,
          calibre: false,
          origine: 'import',
          ordre: stations.length,
          creeLe: new Date().toISOString()
        };
        await DB.enregistrer('stations', st);
        fermerModale();
        toast('Station ajoutée', 'ok');
        aller('viseur', { stationId: st.id });
      }
    }
  ]);
  setTimeout(() => el('#f-nom') && el('#f-nom').focus(), 120);
}

/* ============================================================
   CARTE ET PLAN — placement des stations, mesures à la Géoportail,
   et positions servant à la balade (flèches, mini-carte).
   ------------------------------------------------------------
   Une station peut être placée :
     - sur la carte IGN  : st.geo = { lng, lat }
     - sur un plan image : st.planX, st.planY (fractions de l'image)
   st.nord = azimut (degrés) du nord de la carte/plan dans la vue 360°,
   c.-à-d. de combien la vue est tournée. Réglable via "Orienter".
   ============================================================ */

const RAD = Math.PI / 180;

function norm180(d) { return ((d + 180) % 360 + 360) % 360 - 180; }

/** Plan de la visite + hauteur monde (largeur = 256). */
async function infoPlan(visiteId) {
  S.cachePlan = S.cachePlan || {};
  if (S.cachePlan[visiteId] !== undefined) return S.cachePlan[visiteId];
  const plans = await DB.parIndex('plans', 'visiteId', visiteId);
  const plan = plans[0];
  let res = null;
  if (plan && plan.image) {
    let ratio = plan.ratio;
    if (!ratio) {
      try {
        const bmp = await createImageBitmap(plan.image);
        ratio = bmp.height / bmp.width;
        if (bmp.close) bmp.close();
      } catch (e) { ratio = 0.75; }
    }
    res = { plan, ratio, hauteur: 256 * ratio };
  }
  S.cachePlan[visiteId] = res;
  return res;
}

/** Position MONDE d'une station pour un genre ('carte' | 'plan'), ou null. */
function posStation(st, genre, ip) {
  if (genre === 'carte') return st.geo ? C.monde(st.geo.lng, st.geo.lat) : null;
  if (!ip || st.planX == null) return null;
  return { x: st.planX * 256, y: st.planY * ip.hauteur };
}

function genreCommun(a, b, ip) {
  if (ip && a.planX != null && b.planX != null) return 'plan';
  if (a.geo && b.geo) return 'carte';
  return null;
}

function distanceGenre(genre, ip, a, b) {
  return genre === 'carte' ? C.distanceCarte(a, b) : C.distancePlan(a, b, ip && ip.plan.echelle);
}

/** Flèches de balade vers les stations voisines (placées sur la même carte ou le même plan). */
function liensAuto(st, stations, ip) {
  const res = [];
  for (const b of stations) {
    if (b.id === st.id) continue;
    const g = genreCommun(st, b, ip);
    if (!g) continue;
    const pa = posStation(st, g, ip), pb = posStation(b, g, ip);
    const dist = distanceGenre(g, ip, pa, pb);
    const cap = C.capVers(pa, pb);
    res.push({ toId: b.id, cap, dist, rang: dist != null ? dist : Math.hypot(pb.x - pa.x, pb.y - pa.y) * 1e3, g });
  }
  res.sort((x, y) => x.rang - y.rang);
  return res.slice(0, 4).map((l) => {
    const az = (st.nord || 0) + l.cap;
    let u = norm180(az) / 360 + 0.5;
    let v = 0.62;
    if (l.dist != null && st.hc) {
      const e = -Math.min(1.2, Math.max(0.14, Math.atan(st.hc / Math.max(0.5, l.dist))));
      v = 0.5 - e / Math.PI + (st.horizon || 0);
    }
    return { id: 'auto-' + l.toId, toId: l.toId, u, v, auto: true, cap: l.cap, dist: l.dist };
  });
}

/* ---------- onglets Carte et Plan ---------- */

async function ongletCarto(v, zone, barre, genre) {
  const ip = await infoPlan(v.id);
  const stations = await DB.parIndex('stations', 'visiteId', v.id);
  stations.sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const cleMesures = `cm:${v.id}:${genre}`;
  let mesures = await DB.reglage(cleMesures, []);
  const toit = await lireToit(v.id);

  if (genre === 'plan' && !ip) {
    zone.innerHTML = `<div class="note info">Importez le plan du bâtiment ou de la toiture (image JPEG/PNG, ou
      capture d'écran d'un PDF). Vous placerez ensuite vos stations dessus, vous donnerez l'échelle
      une fois, puis vous mesurerez distances et surfaces comme sur Géoportail. Le plan est
      toujours orienté <strong>nord en haut</strong> : choisissez-le ainsi.</div>`;
    barre.innerHTML = `<button class="btn principal large" id="b-plan">Importer un plan</button>`;
    el('#b-plan').onclick = () => importerPlan(v, null);
    return;
  }

  zone.innerHTML = `
    <div class="carto">
      <div class="carto-outils" id="c-outils"></div>
      <div class="carto-scene">
        <div id="c-carte" class="carte-grande"></div>
        <div class="carto-zoom"><button id="c-plus" aria-label="Zoom avant">+</button><button id="c-moins" aria-label="Zoom arrière">−</button></div>
        <div class="carto-info" id="c-info"></div>
      </div>
    </div>
    <p class="carte-titre" style="margin-top:14px">Mesures enregistrées</p>
    <div id="c-mesures"></div>
    <p class="carte-titre" style="margin-top:14px">Stations</p>
    <div id="c-stations"></div>`;

  const etat = { outil: 'deplacer', pts: [], aPlacer: null, moi: null };
  const carte = new C.Carte(el('#c-carte'), { mode: genre, couche: (v.carte && v.carte.couche) || 'plan' });
  S.carteOnglet = carte;
  const mesure = (a, b) => distanceGenre(genre, ip, a, b);
  carte.metre = mesure;
  if (genre === 'plan') await carte.setImage(ip.plan.image);

  const valeurDe = (m) => m.type === 'surface'
    ? (genre === 'carte' ? C.surfaceCarte(m.pts) : C.surfacePlan(m.pts, ip.plan.echelle))
    : m.pts.slice(1).reduce((s, p, i) => {
      const d = mesure(m.pts[i], p); return d == null ? NaN : s + d;
    }, 0);
  const texteValeur = (m) => {
    const x = valeurDe(m);
    return m.type === 'surface' ? C.formaterM2(x) : C.formaterM(x);
  };

  const sansEchelle = genre === 'plan' && !ip.plan.echelle;

  function majFormes() {
    const f = [];
    for (const m of mesures) {
      f.push({
        pts: m.pts, ferme: m.type === 'surface', couleur: '#ff8f1f',
        etiquette: texteValeur(m), sansCotes: m.type === 'surface' && m.pts.length > 6
      });
    }
    if (genre === 'carte' && Array.isArray(v.trace) && v.trace.length > 1) {
      f.unshift({ pts: v.trace.map((q) => C.monde(q[0], q[1])), couleur: '#4aa3ff', sansCotes: true });
    }
    if (etat.pts.length) {
      const surf = etat.outil === 'surface';
      const m = { type: surf ? 'surface' : 'distance', pts: etat.pts };
      f.push({ pts: etat.pts, ferme: surf && etat.pts.length >= 3, couleur: '#2fd0b8', etiquette: etat.pts.length >= 2 ? texteValeur(m) : '' });
    }
    if (etat.outil === 'echelle' && etat.pts.length) f.push({ pts: etat.pts, couleur: '#ffd23f', sansCotes: true });
    carte.formes = f;
    carte.rendre();
  }

  function majMarqueurs() {
    const m = [];
    stations.forEach((s, i) => {
      const p = posStation(s, genre, ip);
      if (p) m.push({ id: s.id, x: p.x, y: p.y, texte: i + 1, courant: etat.aPlacer === s.id, cap: s.type === 'photo' && s.cap != null ? s.cap : null });
    });
    toit.sondages.forEach((so) => {
      const l = so.loc && so.loc[genre];
      if (!l) return;
      const p = genre === 'carte' ? C.monde(l.lng, l.lat) : { x: l.x * 256, y: l.y * ip.hauteur };
      m.push({ id: 'so:' + so.id, x: p.x, y: p.y, texte: 'S' + so.num, classe: 'sond', courant: etat.sondageAPlacer === so.id });
    });
    if (etat.moi) m.push({ id: 'moi', x: etat.moi.x, y: etat.moi.y, texte: '', moi: true });
    carte.marqueurs = m;
    carte.rendre();
  }

  function majInfo() {
    const b = el('#c-info');
    if (!b) return;
    const o = etat.outil;
    let html = '';
    if (o === 'distance' || o === 'surface') {
      const n = etat.pts.length;
      const m = { type: o, pts: etat.pts };
      const val = (o === 'distance' && n >= 2) || (o === 'surface' && n >= 3) ? texteValeur(m) : '—';
      html = `<div class="pastille mesure"><div class="gros num">${val}</div>
        <div style="color:var(--texte-2)">${o === 'distance' ? 'Touchez les points du tracé' : 'Touchez les sommets du contour'}${sansEchelle ? ' — donnez d\'abord l\'échelle' : ''}</div></div>
        <div class="rangee-btn" style="margin-top:8px">
          <button class="btn" id="m-annul">↶ Point</button>
          <button class="btn principal" id="m-ok">Enregistrer</button>
          <button class="btn" id="m-eff">✕</button></div>`;
    } else if (o === 'placer') {
      const s = stations.find((x) => x.id === etat.aPlacer);
      html = `<div class="pastille">${s ? `Touchez l'emplacement de <strong>${esc(s.nom)}</strong>` : 'Choisissez une station dans la liste, ou touchez un repère pour le déplacer'}</div>`;
    } else if (o === 'sondage') {
      html = `<div class="pastille">${etat.sondageAPlacer ? 'Touchez le nouvel emplacement du sondage' : 'Touchez l\'endroit du sondage sur ' + (genre === 'carte' ? 'la carte' : 'le plan') + '. Touchez un repère S… pour le modifier ou le déplacer.'}</div>`;
    } else if (o === 'echelle') {
      html = `<div class="pastille">Touchez les deux extrémités d'une longueur connue (${etat.pts.length}/2)</div>`;
    } else if (genre === 'plan' && sansEchelle) {
      html = `<div class="pastille attention">Plan sans échelle : touchez 📐 Échelle pour pouvoir mesurer.</div>`;
    }
    b.innerHTML = html;
    if (el('#m-annul')) el('#m-annul').onclick = () => { etat.pts.pop(); majFormes(); majInfo(); };
    if (el('#m-eff')) el('#m-eff').onclick = () => { etat.pts = []; majFormes(); majInfo(); };
    if (el('#m-ok')) el('#m-ok').onclick = () => enregistrerMesure();
  }

  function majOutils() {
    const o = etat.outil;
    const b = (k, ico, n, cls = 'actif') => `<button class="outil ${o === k ? cls : ''}" data-o="${k}"><span class="ico">${ico}</span>${n}</button>`;
    el('#c-outils').innerHTML =
      b('deplacer', '✋', 'Déplacer') +
      b('placer', '📍', 'Placer') +
      b('distance', '📏', 'Distance', 'actif-mesure') +
      b('surface', '⬠', 'Surface', 'actif-mesure') +
      b('sondage', '🕳', 'Sondage') +
      (genre === 'plan'
        ? b('echelle', '📐', 'Échelle')
        : `<button class="outil" data-o="couche"><span class="ico">🛰️</span>${carte.couche === 'plan' ? 'Photo' : 'Plan'}</button>
           <button class="outil" data-o="adresse"><span class="ico">🔎</span>Adresse</button>
           <button class="outil" data-o="moi"><span class="ico">◎</span>Ma position</button>`);
    for (const x of el('#c-outils').querySelectorAll('[data-o]')) x.onclick = () => choisirOutil(x.dataset.o);
  }

  async function choisirOutil(o) {
    if (o === 'couche') {
      carte.setCouche(carte.couche === 'plan' ? 'photo' : 'plan');
      sauverVue(); majOutils(); return;
    }
    if (o === 'adresse') return rechercheAdresse();
    if (o === 'moi') {
      toast('Recherche de votre position…');
      const g = await C.positionGPS(7000);
      if (!g) return toast('Position indisponible (GPS refusé ou signal faible)', 'err');
      const w = C.monde(g.lng, g.lat);
      etat.moi = w; majMarqueurs();
      carte.centrer(w.x, w.y, Math.max(carte.z, 18));
      toast(`Position trouvée (± ${Math.round(g.precision)} m)`, 'ok');
      return;
    }
    etat.outil = o; etat.pts = [];
    if (o !== 'placer') etat.aPlacer = null;
    etat.sondageAPlacer = null;
    majOutils(); majFormes(); majMarqueurs(); majInfo(); majStations();
    if (o === 'echelle') toast('Touchez deux points dont vous connaissez la distance');
  }

  function rechercheAdresse() {
    modale('Aller à une adresse', '', `<div class="champ"><label>Adresse, commune, lieu-dit</label>
      <input id="f-adr" placeholder="12 rue de Rome, Marseille" autocomplete="off"></div>
      <div id="adr-res"></div>`, [
      { libelle: 'Fermer', action: fermerModale },
      {
        libelle: 'Chercher', genre: 'principal', action: async () => {
          const q = el('#f-adr').value.trim();
          if (!q) return;
          el('#adr-res').innerHTML = '<div class="note">Recherche…</div>';
          try {
            const r = await C.chercherAdresse(q);
            el('#adr-res').innerHTML = r.length ? r.map((x, i) => `<button class="item" data-adr="${i}"><div class="corps-item"><div class="nom">${esc(x.libelle)}</div></div></button>`).join('')
              : '<div class="note">Aucun résultat.</div>';
            for (const b of el('#adr-res').querySelectorAll('[data-adr]')) {
              b.onclick = () => {
                const x = r[+b.dataset.adr], w = C.monde(x.lng, x.lat);
                fermerModale(); carte.centrer(w.x, w.y, 18); sauverVue();
              };
            }
          } catch (e) {
            el('#adr-res').innerHTML = `<div class="note alerte">Recherche impossible (${esc(e.message || 'réseau')}). Déplacez la carte à la main.</div>`;
          }
        }
      }
    ]);
    setTimeout(() => el('#f-adr') && el('#f-adr').focus(), 150);
  }

  async function enregistrerMesure() {
    const o = etat.outil, n = etat.pts.length;
    if ((o === 'distance' && n < 2) || (o === 'surface' && n < 3)) return toast('Tracé incomplet', 'err');
    const m = { id: DB.uid('cm'), type: o, pts: etat.pts.slice(), nom: '', le: new Date().toISOString() };
    modale('Enregistrer la mesure', `${o === 'surface' ? 'Surface' : 'Longueur'} : <strong class="num">${texteValeur(m)}</strong>`, `
      <div class="champ"><label>Nom</label><input id="f-mn" placeholder="${o === 'surface' ? 'Toiture-terrasse bât. A' : 'Façade nord'}"></div>`, [
      { libelle: 'Annuler', action: fermerModale },
      {
        libelle: 'Enregistrer', genre: 'principal', action: async () => {
          m.nom = el('#f-mn').value.trim() || (o === 'surface' ? 'Surface' : 'Longueur');
          mesures.push(m);
          await DB.setReglage(cleMesures, mesures);
          fermerModale(); etat.pts = [];
          majFormes(); majInfo(); majMesures();
        }
      }
    ]);
    setTimeout(() => el('#f-mn') && el('#f-mn').focus(), 150);
  }

  function majMesures() {
    const z = el('#c-mesures');
    if (!z) return;
    z.innerHTML = mesures.length ? mesures.map((m) => `
      <div class="item" style="gap:10px">
        <button class="corps-item" data-mv="${m.id}" style="text-align:left;background:none;border:0;color:inherit;flex:1">
          <div class="nom">${esc(m.nom)}</div>
          <div class="meta">${m.type === 'surface' ? 'Surface' : 'Longueur'} · <strong class="num">${texteValeur(m)}</strong></div>
        </button>
        <button class="btn danger" data-md="${m.id}" aria-label="Supprimer">🗑</button>
      </div>`).join('') : `<div class="note">Aucune mesure. Choisissez 📏 ou ⬠, touchez les points sur la carte, puis « Enregistrer ».</div>`;
    for (const b of z.querySelectorAll('[data-mv]')) b.onclick = () => {
      const m = mesures.find((x) => x.id === b.dataset.mv);
      if (m) { carte.cadrer(m.pts, 50); }
    };
    for (const b of z.querySelectorAll('[data-md]')) b.onclick = async () => {
      if (!(await confirmer('Supprimer cette mesure ?', '', 'Supprimer'))) return;
      mesures = mesures.filter((x) => x.id !== b.dataset.md);
      await DB.setReglage(cleMesures, mesures);
      majFormes(); majMesures();
    };
    majFormes();
  }

  function majStations() {
    const z = el('#c-stations');
    if (!z) return;
    z.innerHTML = stations.length ? stations.map((s, i) => {
      const placee = posStation(s, genre, ip) != null;
      return `<button class="item" data-placer="${s.id}" style="${etat.aPlacer === s.id ? 'border-color:var(--accent)' : ''}">
        <div class="vignette">${i + 1}</div>
        <div class="corps-item"><div class="nom">${esc(s.nom)}</div>
        <div class="meta">${placee ? 'Placée' : 'Non placée'} — touchez pour ${placee ? 'la déplacer' : 'la placer'}</div></div></button>`;
    }).join('') : `<div class="note">Aucune station pour l'instant.</div>`;
    for (const b of z.querySelectorAll('[data-placer]')) b.onclick = () => {
      etat.outil = 'placer'; etat.aPlacer = b.dataset.placer; etat.pts = [];
      majOutils(); majMarqueurs(); majInfo(); majStations();
      const p = posStation(stations.find((x) => x.id === etat.aPlacer), genre, ip);
      if (p) carte.centrer(p.x, p.y);
      el('#c-carte').scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast('Touchez l\'emplacement sur ' + (genre === 'carte' ? 'la carte' : 'le plan'));
    };
  }

  let minuteur = null;
  function sauverVue() {
    clearTimeout(minuteur);
    minuteur = setTimeout(async () => {
      if (genre !== 'carte') return;
      v.carte = { x: carte.cx, y: carte.cy, z: carte.z, couche: carte.couche };
      try { await DB.enregistrer('visites', v); } catch (e) { /* sans gravité */ }
    }, 900);
  }
  carte.onChange = () => { if (genre === 'carte') sauverVue(); };

  carte.onMarqueur = async (id) => {
    if (id === 'moi') return;
    if (id.startsWith('so:')) {
      const so = toit.sondages.find((x) => x.id === id.slice(3));
      if (!so) return;
      if (etat.outil === 'sondage') {
        modale('Sondage ' + so.num, esc(so.titre || ''), `<button class="btn large" id="so-fiche" style="margin-bottom:9px">Ouvrir la fiche</button>
          <button class="btn large" id="so-dep">Déplacer</button>`, [{ libelle: 'Fermer', action: fermerModale }]);
        el('#so-fiche').onclick = () => { fermerModale(); formSondage(v, toit, so, stations, ip); };
        el('#so-dep').onclick = () => { fermerModale(); etat.sondageAPlacer = so.id; majMarqueurs(); majInfo(); };
      } else formSondage(v, toit, so, stations, ip);
      return;
    }
    if (etat.outil === 'placer') { etat.aPlacer = id; majMarqueurs(); majInfo(); majStations(); return; }
    if (etat.outil === 'deplacer') aller('viseur', { stationId: id });
  };

  carte.onTap = async (w) => {
    const o = etat.outil;
    if (o === 'distance' || o === 'surface') {
      if (sansEchelle) { toast('Donnez d\'abord l\'échelle du plan (📐 Échelle)', 'err'); return; }
      etat.pts.push(w); majFormes(); majInfo();
    } else if (o === 'sondage') {
      const loc = genre === 'carte' ? (() => { const g = C.lngLat(w.x, w.y); return { lng: g.lng, lat: g.lat }; })() : { x: w.x / 256, y: w.y / ip.hauteur };
      if (etat.sondageAPlacer) {
        const so = toit.sondages.find((x) => x.id === etat.sondageAPlacer);
        etat.sondageAPlacer = null;
        if (so) { so.loc = so.loc || {}; so.loc[genre] = loc; await sauverToit(v.id, toit); toast('Sondage déplacé', 'ok'); }
        majMarqueurs(); majInfo();
      } else {
        setTimeout(() => formSondage(v, toit, null, stations, ip, { [genre]: loc }), 320);
      }
    } else if (o === 'placer') {
      if (!etat.aPlacer) return toast('Choisissez d\'abord une station dans la liste');
      const st = stations.find((x) => x.id === etat.aPlacer);
      if (genre === 'carte') { const g = C.lngLat(w.x, w.y); st.geo = { lng: g.lng, lat: g.lat, manuel: true }; }
      else { st.planX = w.x / 256; st.planY = w.y / ip.hauteur; }
      await DB.enregistrer('stations', st);
      etat.aPlacer = null;
      majMarqueurs(); majInfo(); majStations();
      toast('Station placée', 'ok');
    } else if (o === 'echelle') {
      etat.pts.push(w); majFormes();
      if (etat.pts.length === 2) {
        const [a, b] = etat.pts;
        const dMonde = Math.hypot(b.x - a.x, b.y - a.y);
        // léger délai : le « clic » qui suit le toucher ne doit pas tomber sur le voile et fermer la fenêtre
        setTimeout(() => modale('Échelle du plan', 'Quelle est la vraie longueur entre ces deux points ?', `
          <div class="champ"><label>Longueur réelle (m)</label>
          <input id="f-ech" type="number" inputmode="decimal" step="0.01" min="0.01" placeholder="ex. 12,50"></div>`, [
          { libelle: 'Annuler', action: () => { fermerModale(); etat.pts = []; majFormes(); majInfo(); } },
          {
            libelle: 'Valider', genre: 'principal', action: async () => {
              const L = parseFloat(String(el('#f-ech').value).replace(',', '.'));
              if (!(L > 0) || !(dMonde > 0)) return toast('Longueur invalide', 'err');
              ip.plan.echelle = L * 256 / dMonde;
              await DB.enregistrer('plans', ip.plan);
              S.cachePlan[v.id] = undefined;
              fermerModale(); toast('Échelle enregistrée', 'ok');
              rendre();
            }
          }
        ]), 320);
        setTimeout(() => el('#f-ech') && el('#f-ech').focus(), 600);
      }
    }
  };

  el('#c-plus').onclick = () => carte.zoomer(1);
  el('#c-moins').onclick = () => carte.zoomer(-1);

  // vue initiale
  const pts = stations.map((s) => posStation(s, genre, ip)).filter(Boolean);
  if (genre === 'plan') carte.ajuster();
  else if (pts.length) { carte.cadrer(pts, 60); if (carte.z > 18.5) carte.z = 18.5; carte.rendre(); }
  else if (v.carte) carte.centrer(v.carte.x, v.carte.y, v.carte.z);
  else { const m = C.monde(5.3698, 43.2965); carte.centrer(m.x, m.y, 12.5); }

  majOutils(); majMarqueurs(); majInfo(); majMesures(); majStations();
  if (genre === 'carte' && !pts.length && !v.carte) {
    toast('Cherchez l\'adresse du chantier avec 🔎, puis placez vos stations');
  }

  if (genre === 'plan') {
    barre.innerHTML = `<button class="btn large" id="b-plan">Remplacer le plan</button>`;
    el('#b-plan').onclick = () => importerPlan(v, ip.plan);
  } else {
    barre.innerHTML = `<div class="note" style="margin:0;font-size:12px">Fonds © IGN (Géoplateforme). Placez vos stations : la balade en 360° affichera les flèches vers les voisines et la mini-carte.</div>`;
  }
}

async function importerPlan(v, ancien) {
  const f = await choisirFichier({ accept: 'image/*,application/pdf' });
  if (!f) return;
  if (f.type === 'application/pdf') {
    return toast('Exportez la page du plan en image (JPEG/PNG) avant de l\'importer', 'err');
  }
  const img = await CAP.reduire(f, 2400, 0.9);
  let ratio = 0.75;
  try { const b = await createImageBitmap(img); ratio = b.height / b.width; if (b.close) b.close(); } catch (e) { /* ratio par défaut */ }
  await DB.enregistrer('plans', {
    id: ancien ? ancien.id : DB.uid('pl'), visiteId: v.id, image: img, ratio,
    echelle: null
  });
  S.cachePlan = {};
  toast('Plan importé — donnez maintenant l\'échelle (📐)', 'ok');
  rendre();
}

/* ---------- orientation d'une vue 360° sur la carte ---------- */

async function orienterStation(st) {
  const vis = S.visionneuse;
  const ip = await infoPlan(st.visiteId);
  const toutes = await DB.parIndex('stations', 'visiteId', st.visiteId);
  const voisines = toutes.filter((b) => b.id !== st.id && genreCommun(st, b, ip));
  if (!voisines.length) {
    return modale('Orienter la vue',
      'Placez d\'abord cette station et au moins une autre, sur la même carte ou le même plan (onglets Carte ou Plan de la visite).', '', [
      { libelle: 'Compris', genre: 'principal', action: fermerModale }]);
  }
  const b = el('#bandeau');
  S.orientation = true;
  b.innerHTML = `<div class="pastille" style="flex:1">
      <strong>Orienter la vue</strong><br>
      <span style="color:var(--texte-2)">Visez le centre sur cette station (ou un repère de la carte), puis validez</span>
      <select id="o-choix" style="width:100%;margin-top:8px;padding:9px;border-radius:8px;background:var(--surface-2);color:var(--texte);border:1px solid var(--bord-fort)">
        ${voisines.map((x) => `<option value="${x.id}">${esc(x.nom)}</option>`).join('')}
      </select>
      <div class="rangee-btn" style="margin-top:8px">
        <button class="btn" id="o-annul">Annuler</button>
        <button class="btn principal" id="o-ok">Valider ✓</button></div>
    </div>`;
  el('#reticule-zone').innerHTML = `<div class="reticule"><div class="centre"></div></div>`;
  const fin = () => { S.orientation = false; majBandeau(st); majReticule(); };
  el('#o-annul').onclick = fin;
  el('#o-ok').onclick = async () => {
    const cible = voisines.find((x) => x.id === el('#o-choix').value);
    const g = genreCommun(st, cible, ip);
    const cap = C.capVers(posStation(st, g, ip), posStation(cible, g, ip));
    st.nord = Math.round(norm180(vis.yaw / RAD - cap) * 10) / 10;
    await DB.enregistrer('stations', st);
    toast('Vue orientée', 'ok');
    fin();
    const couche = el('#couche');
    if (couche) { couche._pins = null; couche._chargement = false; }
    await positionnerSurcouches(st);
    majMinicarte(st);
  };
}

/* ---------- mini-carte dans la vue 360° ---------- */

async function monterMinicarte(st) {
  const zone = el('#mini');
  if (!zone) return;
  const ip = await infoPlan(st.visiteId);
  const genre = (ip && st.planX != null) ? 'plan' : (st.geo ? 'carte' : null);
  if (!genre) { zone.style.display = 'none'; return; }
  const stations = await DB.parIndex('stations', 'visiteId', st.visiteId);
  stations.sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const v = await DB.lire('visites', st.visiteId);

  zone.style.display = '';
  zone.innerHTML = `<div class="mini-carte" id="mini-carte"></div>
    <button class="mini-btn" id="mini-gd" aria-label="Agrandir la carte">⤢</button>`;
  const carte = new C.Carte(el('#mini-carte'), { mode: genre, couche: (v && v.carte && v.carte.couche) || 'plan', compact: true });
  S.mini = carte;
  S.miniInfo = { st, stations, ip, genre };
  if (genre === 'plan') await carte.setImage(ip.plan.image);

  const placees = stations.filter((s) => posStation(s, genre, ip));
  carte.marqueurs = placees.map((s) => {
    const p = posStation(s, genre, ip);
    return { id: s.id, x: p.x, y: p.y, texte: stations.indexOf(s) + 1, courant: s.id === st.id, cap: s.id === st.id ? (st.type === 'photo' ? (st.cap != null ? st.cap : null) : 0) : null };
  });
  const moi = posStation(st, genre, ip);
  const voisins = placees.filter((s) => s.id !== st.id)
    .map((s) => ({ p: posStation(s, genre, ip) }))
    .sort((a, b) => Math.hypot(a.p.x - moi.x, a.p.y - moi.y) - Math.hypot(b.p.x - moi.x, b.p.y - moi.y))
    .slice(0, 3).map((o) => o.p);
  if (genre === 'plan' && placees.length < 2) carte.ajuster();
  else { carte.cadrer([moi, ...voisins], 26); if (genre === 'carte' && carte.z > 18.5) carte.z = 18.5; if (genre === 'plan' && carte.z > carte.maxZ) carte.z = carte.maxZ; carte.rendre(); }

  carte.onMarqueur = (id) => {
    if (id === st.id) return;
    const b = stations.find((x) => x.id === id);
    const g = genreCommun(st, b, ip);
    S.arrivee = g ? { cap: C.capVers(posStation(st, g, ip), posStation(b, g, ip)) } : null;
    aller('viseur', { stationId: id });
  };
  el('#mini-gd').onclick = () => {
    zone.classList.toggle('grande');
    el('#mini-gd').textContent = zone.classList.contains('grande') ? '✕' : '⤢';
    setTimeout(() => {
      carte.redimensionner();
      const w = posStation(st, genre, ip);
      if (zone.classList.contains('grande')) carte.centrer(w.x, w.y, Math.max(genre === 'carte' ? 17 : carte.z, carte.z));
      else carte.cadrer([w, ...voisins], 26);
    }, 60);
  };
  majMinicarte(st);
}

/** Met à jour le cône de direction de la mini-carte. */
function majMinicarte(st) {
  const carte = S.mini, vis = S.visionneuse;
  if (!carte || !vis) return;
  const m = carte.marqueurs.find((x) => x.id === st.id);
  if (!m) return;
  m.cap = Math.round((vis.yaw / RAD - (st.nord || 0)) * 2) / 2;
  carte._rendreMarqueurs();
}

/* ---------- onglet : toiture (complexes et sondages) ---------- */

const COUCHES_TOIT = [
  { cle: 'support', nom: 'Support', couleur: '#8a8f98', choix: ['Dalle béton', 'Bac acier', 'Ossature bois / panneaux bois', 'Béton cellulaire', 'Maçonnerie / hourdis'] },
  { cle: 'pente', nom: 'Forme de pente', couleur: '#b9a98c', choix: ['Béton de pente', 'Mortier de pente', 'Pente isolant'] },
  { cle: 'ancienne', nom: 'Ancienne étanchéité', couleur: '#5a4a3a', choix: ['Asphalte', 'Multicouche bitume', 'Bicouche bitume', 'Monocouche bitume', 'Membrane synthétique'] },
  { cle: 'pare-vapeur', nom: 'Pare-vapeur', couleur: '#4aa3ff', choix: ['Écran pare-vapeur bitumineux', 'Bitume élastomère alu', 'Film polyéthylène', 'EIF + pare-vapeur'] },
  { cle: 'isolant', nom: 'Isolant', couleur: '#f2d86b', choix: ['PIR', 'Polystyrène EPS', 'Laine de roche', 'Verre cellulaire', 'Perlite / liège'] },
  { cle: 'etancheite', nom: 'Étanchéité', couleur: '#2b2b2f', choix: ['Bicouche bitume SBS', 'Monocouche bitume', 'Membrane PVC', 'Membrane TPO', 'EPDM', 'Asphalte'] },
  { cle: 'protection', nom: 'Protection', couleur: '#9bb08a', choix: ['Gravillons', 'Dalle sur plots', 'Autoprotection (ardoisée)', 'Protection lourde (dalle, carrelage)', 'Végétalisation', 'Aucune'] },
  { cle: 'autre', nom: 'Autre couche', couleur: '#777', choix: [] }
];
const typeCouche = (k) => COUCHES_TOIT.find((c) => c.cle === k) || COUCHES_TOIT.at(-1);
const cleToit = (visiteId) => `toit:${visiteId}`;
const toitVide = () => ({ complexes: [], sondages: [] });
async function lireToit(visiteId) {
  const t = await DB.reglage(cleToit(visiteId), null);
  return t && Array.isArray(t.complexes) ? t : toitVide();
}
const sauverToit = (visiteId, t) => DB.setReglage(cleToit(visiteId), t);

/** Coupe verticale : couches du bas (support) vers le haut (protection). */
function htmlCoupe(couches) {
  if (!couches || !couches.length) return '<div class="note" style="margin:0">Aucune couche.</div>';
  const haut = [...couches].reverse();
  const total = couches.reduce((s, c) => s + (+c.epaisseur || 0), 0);
  return `<div style="display:flex;flex-direction:column;border:1px solid var(--bord,#333);border-radius:8px;overflow:hidden">` +
    haut.map((c) => {
      const t = typeCouche(c.type);
      const h = Math.max(26, Math.min(60, 20 + (+c.epaisseur || 0) * 0.5));
      const clair = ['isolant', 'pente', 'protection'].includes(c.type);
      return `<div style="min-height:${h}px;background:${t.couleur};color:${clair ? '#1a1a1a' : '#fff'};padding:5px 10px;font-size:12.5px;display:flex;justify-content:space-between;gap:8px;align-items:center">
        <span><strong>${esc(t.nom)}</strong> — ${esc(c.nature || '—')}${c.note ? ` <em style="opacity:.8">(${esc(c.note)})</em>` : ''}</span>
        <span class="num">${c.epaisseur ? esc(String(c.epaisseur)) + ' mm' : ''}</span></div>`;
    }).join('') + `</div><div style="font-size:12px;color:var(--texte-3);margin-top:4px">Épaisseur totale relevée : <strong class="num">${total ? total + ' mm' : '—'}</strong> (de haut en bas : protection → support)</div>`;
}

function resumeComplexe(cx) {
  return (cx.couches || []).filter((c) => c.type !== 'autre' || c.nature).map((c) => c.nature || typeCouche(c.type).nom).reverse().join(' / ');
}

async function ongletToiture(v, zone, barre) {
  const t = await lireToit(v.id);
  const stations = await DB.parIndex('stations', 'visiteId', v.id);
  const nomCx = (id) => { const c = t.complexes.find((x) => x.id === id); return c ? c.nom : '—'; };
  const ip = await infoPlan(v.id);

  zone.innerHTML = `
    <p class="carte-titre">Complexes de toiture</p>
    <div id="t-cx">${t.complexes.length ? t.complexes.map((c) => `
      <div class="carte" style="margin-bottom:10px">
        <div class="ligne entre" style="margin-bottom:8px"><strong>${esc(c.nom)}</strong>
          <button class="btn" data-cx="${c.id}">Modifier</button></div>
        ${htmlCoupe(c.couches)}
      </div>`).join('') : `<div class="note">Aucun complexe. Ajoutez par exemple « Terrasse bât. A » : support béton, pare-vapeur, isolant, bicouche, gravillons…</div>`}</div>
    <p class="carte-titre" style="margin-top:16px">Sondages</p>
    <div id="t-so">${t.sondages.length ? t.sondages.map((s) => `
      <button class="item" data-so="${s.id}">
        <div class="vignette">S${s.num}</div>
        <div class="corps-item"><div class="nom">${esc(s.titre || 'Sondage ' + s.num)} — ${esc(nomCx(s.complexeId))}</div>
        <div class="meta">${dateFR(s.date)} · ${s.loc && (s.loc.carte || s.loc.plan) ? 'localisé' : 'non localisé'}${s.loc && s.loc.stationId ? ' · vue 360°' : ''}${s.humide ? ' · isolant humide' : ''}</div></div>
        <span class="chev">›</span></button>`).join('') : `<div class="note">Aucun sondage. Localisez-le sur la carte ou le plan (outil 🕳 Sondage), ou créez-le ici.</div>`}</div>`;

  barre.innerHTML = `<button class="btn large" id="b-cx">+ Complexe</button><button class="btn principal large" id="b-so">+ Sondage</button>`;
  el('#b-cx').onclick = () => formComplexe(v, t, null);
  el('#b-so').onclick = () => formSondage(v, t, null, stations, ip);
  for (const b of zone.querySelectorAll('[data-cx]')) b.onclick = () => formComplexe(v, t, t.complexes.find((x) => x.id === b.dataset.cx));
  for (const b of zone.querySelectorAll('[data-so]')) b.onclick = () => formSondage(v, t, t.sondages.find((x) => x.id === b.dataset.so), stations, ip);
}

function formComplexe(v, t, existant) {
  const cx = existant ? JSON.parse(JSON.stringify(existant)) : { id: DB.uid('cx'), nom: '', couches: [] };
  const rendreCouches = () => {
    el('#x-couches').innerHTML = cx.couches.map((c, i) => {
      const tc = typeCouche(c.type);
      return `<div class="carte" style="margin-bottom:8px;padding:9px">
        <div class="ligne entre"><strong style="font-size:13px">${i + 1}. ${esc(tc.nom)}</strong>
          <span><button class="btn" data-h="${i}" aria-label="Monter">↑</button> <button class="btn" data-b="${i}" aria-label="Descendre">↓</button> <button class="btn danger" data-s="${i}" aria-label="Supprimer">🗑</button></span></div>
        <div class="champ"><label>Nature</label>
          <input data-n="${i}" list="dl-${c.type}" value="${esc(c.nature || '')}" placeholder="${esc(tc.choix[0] || 'à préciser')}">
          <datalist id="dl-${c.type}">${tc.choix.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
        <div class="rangee-btn">
          <div class="champ" style="flex:1"><label>Épaisseur (mm)</label><input data-e="${i}" type="number" inputmode="decimal" value="${c.epaisseur || ''}"></div>
          <div class="champ" style="flex:2"><label>Remarque</label><input data-r="${i}" value="${esc(c.note || '')}" placeholder="état, fixation, référence…"></div>
        </div></div>`;
    }).join('') || '<div class="note">Ajoutez les couches <strong>en partant du support</strong> (bas) jusqu\'à la protection (haut).</div>';
    for (const k of ['n', 'e', 'r']) for (const inp of document.querySelectorAll(`[data-${k}]`)) {
      inp.oninput = () => { const c = cx.couches[+inp.dataset[k]]; if (k === 'n') c.nature = inp.value; else if (k === 'e') c.epaisseur = parseFloat(String(inp.value).replace(',', '.')) || 0; else c.note = inp.value; };
    }
    for (const b of document.querySelectorAll('[data-h]')) b.onclick = () => { const i = +b.dataset.h; if (i > 0) { [cx.couches[i - 1], cx.couches[i]] = [cx.couches[i], cx.couches[i - 1]]; rendreCouches(); } };
    for (const b of document.querySelectorAll('[data-b]')) b.onclick = () => { const i = +b.dataset.b; if (i < cx.couches.length - 1) { [cx.couches[i + 1], cx.couches[i]] = [cx.couches[i], cx.couches[i + 1]]; rendreCouches(); } };
    for (const b of document.querySelectorAll('[data-s]')) b.onclick = () => { cx.couches.splice(+b.dataset.s, 1); rendreCouches(); };
  };
  modale(existant ? 'Modifier le complexe' : 'Nouveau complexe', '', `
    <div class="champ"><label>Nom (zone, bâtiment)</label><input id="x-nom" value="${esc(cx.nom)}" placeholder="Terrasse bât. A"></div>
    <div id="x-couches"></div>
    <p class="carte-titre">Ajouter une couche</p>
    <div style="display:flex;flex-wrap:wrap;gap:6px">${COUCHES_TOIT.map((c) => `<button class="btn" data-add="${c.cle}">${esc(c.nom)}</button>`).join('')}</div>`, [
    ...(existant ? [{ libelle: 'Supprimer', genre: 'danger', action: async () => {
      if (!(await confirmer('Supprimer ce complexe ?', 'Les sondages qui y sont rattachés sont conservés.', 'Supprimer'))) return;
      t.complexes = t.complexes.filter((x) => x.id !== cx.id);
      await sauverToit(v.id, t); fermerModale(); rendre();
    } }] : []),
    { libelle: 'Annuler', action: fermerModale },
    { libelle: 'Enregistrer', genre: 'principal', action: async () => {
      cx.nom = el('#x-nom').value.trim() || 'Complexe ' + (t.complexes.length + (existant ? 0 : 1));
      const i = t.complexes.findIndex((x) => x.id === cx.id);
      if (i >= 0) t.complexes[i] = cx; else t.complexes.push(cx);
      await sauverToit(v.id, t); fermerModale(); rendre();
    } }
  ]);
  rendreCouches();
  for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => {
    cx.couches.push({ type: b.dataset.add, nature: '', epaisseur: 0, note: '' }); rendreCouches();
  };
}

/** Fiche sondage : s = existant ou null ; loc = emplacement déjà choisi (carte/plan) pour un nouveau sondage. */
function formSondage(v, t, s, stations, ip, loc = null) {
  const so = s ? JSON.parse(JSON.stringify(s)) : {
    id: DB.uid('so'), num: (t.sondages.reduce((m, x) => Math.max(m, x.num || 0), 0) + 1),
    titre: '', date: new Date().toISOString(), complexeId: t.complexes[0] ? t.complexes[0].id : '', note: '', humide: false, loc: loc || {}
  };
  const optionsCx = `<option value="">— à renseigner —</option>` + t.complexes.map((c) => `<option value="${c.id}" ${c.id === so.complexeId ? 'selected' : ''}>${esc(c.nom)}</option>`).join('');
  const optionsSt = `<option value="">— aucune —</option>` + stations.map((x) => `<option value="${x.id}" ${x.id === so.loc.stationId ? 'selected' : ''}>${esc(x.nom)}</option>`).join('');
  const cx = () => t.complexes.find((c) => c.id === so.complexeId);
  const url = so.photo ? URL.createObjectURL(so.photo) : null;
  modale((s ? 'Sondage ' : 'Nouveau sondage ') + so.num, '', `
    <div class="champ"><label>Repère / intitulé</label><input id="s-titre" value="${esc(so.titre)}" placeholder="Sondage S${so.num} — près de l'acrotère nord"></div>
    <div class="champ"><label>Complexe constaté</label><select id="s-cx">${optionsCx}</select></div>
    <div id="s-coupe" style="margin-bottom:10px">${cx() ? htmlCoupe(cx().couches) : ''}</div>
    <div class="champ"><label>Date</label><input id="s-date" type="date" value="${dateInput(so.date)}"></div>
    <div class="champ"><label>Vue 360° proche (facultatif)</label><select id="s-st">${optionsSt}</select></div>
    <label style="display:flex;gap:8px;align-items:center;margin:8px 0"><input type="checkbox" id="s-hum" ${so.humide ? 'checked' : ''}> Isolant ou support humide</label>
    <div class="champ"><label>Observations</label><textarea id="s-note" rows="3" placeholder="Pente, état du support, reprise d'humidité, trace de l'ancienne étanchéité…">${esc(so.note)}</textarea></div>
    <div class="champ"><label>Photo du sondage</label>
      <div id="s-photo">${url ? `<img src="${url}" style="width:100%;border-radius:8px;margin-bottom:6px">` : ''}</div>
      <button class="btn" id="s-prendre">${so.photo ? 'Remplacer la photo' : '📷 Ajouter une photo'}</button></div>
    <p style="font-size:12.5px;color:var(--texte-2);margin:10px 0 0">Position : <strong>${so.loc.carte ? 'sur la carte' : ''}${so.loc.carte && so.loc.plan ? ' et ' : ''}${so.loc.plan ? 'sur le plan' : ''}${!so.loc.carte && !so.loc.plan ? 'non localisé' : ''}</strong>.
    Pour la placer ou la déplacer : onglet Carte ou Plan, outil 🕳 Sondage.</p>`, [
    ...(s ? [{ libelle: 'Supprimer', genre: 'danger', action: async () => {
      if (!(await confirmer('Supprimer ce sondage ?', '', 'Supprimer'))) return;
      t.sondages = t.sondages.filter((x) => x.id !== so.id);
      await sauverToit(v.id, t); fermerModale(); rendre();
    } }] : []),
    { libelle: 'Annuler', action: fermerModale },
    { libelle: 'Enregistrer', genre: 'principal', action: async () => {
      so.titre = el('#s-titre').value.trim();
      so.complexeId = el('#s-cx').value;
      so.date = el('#s-date').value ? new Date(el('#s-date').value + 'T12:00:00').toISOString() : so.date;
      so.humide = el('#s-hum').checked;
      so.note = el('#s-note').value.trim();
      const sid = el('#s-st').value;
      if (sid) so.loc.stationId = sid; else delete so.loc.stationId;
      const i = t.sondages.findIndex((x) => x.id === so.id);
      if (i >= 0) t.sondages[i] = so; else t.sondages.push(so);
      await sauverToit(v.id, t); fermerModale(); rendre();
    } }
  ]);
  el('#s-cx').onchange = () => { so.complexeId = el('#s-cx').value; el('#s-coupe').innerHTML = cx() ? htmlCoupe(cx().couches) : ''; };
  el('#s-prendre').onclick = async () => {
    const f = await choisirFichier({ accept: 'image/*', capture: 'environment' });
    if (!f) return;
    so.photo = f;
    el('#s-photo').innerHTML = `<img src="${URL.createObjectURL(f)}" style="width:100%;border-radius:8px;margin-bottom:6px">`;
  };
}

/* ---------- onglet : observations ---------- */

async function ongletObservations(v, zone, barre) {
  const stations = await DB.parIndex('stations', 'visiteId', v.id);
  stations.sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const toutes = [];
  for (const s of stations) {
    for (const p of await DB.parIndex('pins', 'stationId', s.id)) toutes.push({ ...p, station: s });
  }
  toutes.sort((a, b) => (b.creeLe || '').localeCompare(a.creeLe || ''));

  if (!toutes.length) {
    zone.innerHTML = `<div class="vide"><div class="ico">📌</div>
      <p><strong>Aucune observation.</strong></p>
      <p>Ouvrez une vue 360°, visez un point et épinglez-le : le repère reste
      à sa place exacte dans la vue.</p></div>`;
  } else {
    zone.innerHTML = toutes.map((p) => {
      const t = TYPES_OBS.find((x) => x.cle === p.type) || TYPES_OBS.at(-1);
      const url = p.photo ? URL.createObjectURL(p.photo) : null;
      return `<button class="item" data-obs="${p.id}" data-st="${p.stationId}">
        <div class="vignette" ${url ? `style="background-image:url(${url})"` : ''}>${url ? '' : t.ico}</div>
        <div class="corps-item">
          <div class="nom">${esc(p.titre || t.nom)}</div>
          <div class="meta">${esc(t.nom)} · ${esc(p.station.nom)}${p.gravite ? ' · ' + esc(p.gravite) : ''}</div>
        </div>
        <span class="chev">›</span>
      </button>`;
    }).join('');
    for (const b of document.querySelectorAll('[data-obs]')) {
      b.onclick = () => aller('viseur', { stationId: b.dataset.st, cible: b.dataset.obs });
    }
  }
  barre.innerHTML = `<button class="btn principal large" id="b-rap">Rapport de visite</button>`;
  el('#b-rap').onclick = () => aller('rapport', {});
}

/* ---------- onglet : cotes ---------- */

async function ongletCotes(v, zone, barre) {
  const stations = await DB.parIndex('stations', 'visiteId', v.id);
  stations.sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const lignes = [];
  for (const s of stations) {
    const mes = await DB.parIndex('mesures', 'stationId', s.id);
    for (const m of mes) lignes.push({ ...m, station: s });
  }

  if (!lignes.length) {
    zone.innerHTML = `<div class="vide"><div class="ico">📐</div>
      <p><strong>Aucune cote relevée.</strong></p>
      <p>Dans une vue 360°, passez en mode Mesure : longueurs au sol,
      hauteurs d'acrotère, portes, fenêtres, surfaces de terrasse.</p></div>`;
  } else {
    zone.innerHTML = `<div class="carte"><table class="tableau">
      <thead><tr><th>Désignation</th><th>Station</th><th style="text-align:right">Cote</th></tr></thead>
      <tbody>${lignes.map((m) => `
        <tr data-mes="${m.id}" data-st="${m.stationId}">
          <td><strong>${esc(m.libelle || libelleTypeMesure(m.type))}</strong>
            <div style="font-size:12px;color:var(--texte-3);margin-top:2px">${libelleTypeMesure(m.type)}${m.fiabilite ? ' · ' + esc(m.fiabilite) : ''}</div></td>
          <td style="font-size:13px;color:var(--texte-2)">${esc(m.station.nom)}</td>
          <td class="val num" style="text-align:right">${m.type === 'surface' ? G.formaterSurface(m.valeur) : G.formaterLongueur(m.valeur)}
            <div style="font-size:11.5px;color:var(--texte-3);font-weight:400">${m.incertitude ? esc(G.formaterIncertitude(m.incertitude)) : ''}</div></td>
        </tr>`).join('')}</tbody></table></div>
      <div class="note attention"><strong>Portée des cotes.</strong> Elles proviennent de la géométrie
      de la panoramique, pas d'un télémètre. Elles servent au prédimensionnement, au chiffrage et au
      constat. Pour une commande de matériaux ou un métré contractuel, recoupez au mètre ou au laser.</div>`;
    for (const tr of document.querySelectorAll('[data-mes]')) {
      tr.style.cursor = 'pointer';
      tr.onclick = () => aller('viseur', { stationId: tr.dataset.st });
    }
  }

  barre.innerHTML = `<button class="btn" id="b-csv">Export CSV</button><button class="btn principal" id="b-rap">Rapport</button>`;
  el('#b-rap').onclick = () => aller('rapport', {});
  el('#b-csv').onclick = () => {
    const c = ['Désignation;Type;Station;Valeur;Unité;Incertitude;Fiabilité'];
    for (const m of lignes) {
      c.push([
        (m.libelle || libelleTypeMesure(m.type)).replace(/;/g, ','),
        libelleTypeMesure(m.type),
        m.station.nom.replace(/;/g, ','),
        (m.type === 'surface' ? m.valeur.toFixed(2) : m.valeur.toFixed(3)).replace('.', ','),
        m.type === 'surface' ? 'm2' : 'm',
        m.incertitude ? m.incertitude.toFixed(3).replace('.', ',') : '',
        m.fiabilite || ''
      ].join(';'));
    }
    telecharger(`cotes-${dateInput(v.date)}.csv`, '﻿' + c.join('\r\n'), 'text/csv');
  };
}

function libelleTypeMesure(t) {
  return { sol: 'Longueur au sol', hauteur: 'Hauteur', verticale: 'Dimension verticale', surface: 'Surface au sol' }[t] || t;
}

/* ============================================================
   VUE : VISEUR — navigation 360°, cotation, épinglage
   ============================================================ */

VUES.viseur = async function () {
  const st = await DB.lire('stations', S.stationId);
  if (!st) return revenir();
  const v = await DB.lire('visites', st.visiteId);
  S.visiteId = st.visiteId;

  if (st.type === 'photo') return viseurPhoto(st, v);

  app().innerHTML = `
    ${entete(st.nom, dateFR(v && v.date), true,
      `<button class="btn-retour" id="btn-menu" aria-label="Menu">⋯</button>`)}
    <div class="corps plein">
      <div class="scene" id="scene">
        <canvas id="pano"></canvas>
        <div class="couche" id="couche">
          <svg class="svg-mesure" id="svg"></svg>
        </div>
        <div class="bandeau-haut" id="bandeau"></div>
        <div class="voisins" id="voisins"></div>
        <div class="minicarte" id="mini" style="display:none"></div>
        <div id="reticule-zone"></div>
        <div class="outils" id="outils"></div>
      </div>
    </div>`;

  brancherRetour();
  el('#btn-menu').onclick = () => menuStation(st, v);

  const vis = new VisionneusePano(el('#pano'));
  S.visionneuse = vis;
  if (vis.erreur) {
    el('#scene').innerHTML = `<div class="consigne"><div class="boite">${esc(vis.erreur)}</div></div>`;
    return;
  }
  vis.horizon = st.horizon || 0;
  try {
    const ok = await vis.charger(st.pano);
    if (!ok) throw new Error('affichage indisponible');
  } catch (e) {
    el('#scene').insertAdjacentHTML('beforeend', `<div class="consigne"><div class="boite">
      <strong>Cette vue ne s'affiche pas.</strong><br>${esc(e.message || 'Image illisible')}.<br><br>
      Fermez complètement l'application et rouvrez-la. Si cette station reste noire, elle a
      été enregistrée noire : refaites-la.</div></div>`);
    return;
  }

  const ro = new ResizeObserver(() => vis.redimensionner());
  ro.observe(el('#scene'));

  S.modeViseur = 'navigation';
  S.mesureEnCours = null;

  vis.onChange = () => { positionnerSurcouches(st); majMinicarte(st); };
  vis.onTap = (u, v2) => surTap(st, u, v2);
  vis.onPerte = () => {
    const z = el('#scene'); if (!z) return;
    const d = document.createElement('div');
    d.className = 'consigne'; d.id = 'perte'; d.style.pointerEvents = 'auto';
    d.innerHTML = `<div class="boite"><strong>Affichage interrompu.</strong><br>
      Le téléphone a manqué de mémoire graphique et a coupé la vue.
      Vos données ne sont pas touchées.<br><br>
      <button class="btn principal large" id="b-recharger-vue">Recharger la vue</button></div>`;
    z.appendChild(d);
    el('#b-recharger-vue').onclick = () => rendre();
  };
  vis.onRetablie = () => { const d = el('#perte'); if (d) d.remove(); };

  await rafraichirViseur(st);

  // arrivée par une flèche ou la mini-carte : on regarde dans le sens de la marche
  if (S.arrivee) {
    vis.yaw = ((st.nord || 0) + S.arrivee.cap) * Math.PI / 180;
    vis.pitch = 0;
    vis.rendre();
    S.arrivee = null;
    el('#pano').classList.add('arrivee');
  }
  monterMinicarte(st).catch((e) => console.warn('mini-carte', e));

  // si on vient d'une observation, on vise dessus
  if (S.cible) {
    const p = await DB.lire('pins', S.cible);
    if (p) vis.viser(p.u, p.v);
    S.cible = null;
  }
};

/* ---------- barre d'outils ---------- */

async function rafraichirViseur(st) {
  const outils = el('#outils');
  if (!outils) return;
  const m = S.modeViseur;
  outils.innerHTML = `
    <button class="outil ${m === 'navigation' ? 'actif' : ''}" data-mode="navigation">
      <span class="ico">🧭</span>Naviguer</button>
    <button class="outil ${m === 'mesure' ? 'actif-mesure' : ''}" data-mode="mesure">
      <span class="ico">📐</span>Mesurer</button>
    <button class="outil ${m === 'observation' ? 'actif' : ''}" data-mode="observation">
      <span class="ico">📌</span>Épingler</button>
    <button class="outil ${m === 'lien' ? 'actif' : ''}" data-mode="lien">
      <span class="ico">🔗</span>Relier</button>
    <button class="outil" data-mode="stations"><span class="ico">🎥</span>Stations</button>`;

  for (const b of outils.querySelectorAll('[data-mode]')) {
    b.onclick = async () => {
      const mode = b.dataset.mode;
      if (mode === 'stations') return listeStationsRapide(st);
      if (mode === 'mesure') return demarrerMesure(st);
      S.modeViseur = mode;
      S.mesureEnCours = null;
      await rafraichirViseur(st);
      await positionnerSurcouches(st);
      if (mode === 'observation') toast('Visez le point et touchez l\'image');
      if (mode === 'lien') toast('Visez la direction de la station voisine');
    };
  }
  majBandeau(st);
  majReticule();
  await positionnerSurcouches(st);
}

function majReticule() {
  const z = el('#reticule-zone');
  if (!z) return;
  z.innerHTML = (S.modeViseur === 'mesure' && S.mesureEnCours)
    ? `<div class="reticule"><div class="centre"></div></div>`
    : '';
}

function majBandeau(st) {
  const b = el('#bandeau');
  if (!b) return;
  const me = S.mesureEnCours;

  if (S.modeViseur === 'mesure' && me) {
    const n = me.points.length;
    let consigne = '', valeur = '';
    if (me.type === 'sol') {
      consigne = n === 0 ? 'Visez le premier point, au sol' : n === 1 ? 'Visez le second point, au sol' : 'Cote relevée';
    } else if (me.type === 'hauteur') {
      consigne = n === 0 ? 'Visez le PIED de l\'ouvrage, au sol' : n === 1 ? 'Visez son SOMMET, à l\'aplomb' : 'Cote relevée';
    } else if (me.type === 'surface') {
      consigne = n < 3 ? `Visez les sommets au sol (${n}/3 minimum)` : `${n} sommets — fermez le contour`;
    }
    if (me.resultat && me.resultat.ok) {
      const r = me.resultat;
      valeur = `<div class="pastille mesure">
        <div class="gros num">${r.type === 'surface' ? G.formaterSurface(r.valeur) : G.formaterLongueur(r.valeur)}</div>
        <div style="color:var(--texte-2)">${esc(G.formaterIncertitude(r.incertitude))} · ${esc(G.LIBELLE_FIABILITE[r.fiabilite.niveau])}</div>
      </div>`;
    }
    b.innerHTML = `<div class="pastille" style="flex:1">
        <strong>${esc(libelleTypeMesure(me.type))}</strong><br>
        <span style="color:var(--texte-2)">${consigne}</span><br>
        <span style="color:var(--texte-3);font-size:11.5px">Objectif à ${st.hc.toFixed(2).replace('.', ',')} m${st.calibre ? ' · calé' : ' · non calé'}</span>
      </div>${valeur}`;
    return;
  }

  const etiq = !st.sphereComplete
    ? '<span class="etiq accent">360° partielle</span>'
    : st.mode === 'rapide'
      ? '<span class="etiq ok">Horizon et sol</span>'
      : '<span class="etiq ok">Sphère complète</span>';
  b.innerHTML = `<div class="pastille">${etiq}
    ${S.modeViseur === 'observation' ? '<br><span style="color:var(--texte-2)">Touchez le point à épingler</span>' : ''}
    ${S.modeViseur === 'lien' ? '<br><span style="color:var(--texte-2)">Touchez la direction de la station voisine</span>' : ''}
    ${S.modeViseur === 'navigation' ? `<br><span style="color:var(--texte-3);font-size:11.5px">Glissez pour regarder, pincez pour zoomer</span>` : ''}
  </div>`;
}

/* ---------- surcouches : épingles, liens, points de mesure ---------- */

async function positionnerSurcouches(st) {
  const vis = S.visionneuse, couche = el('#couche');
  if (!vis || !couche) return;

  if (!couche._pins && !couche._chargement) {
    couche._chargement = true;
    couche._pins = await DB.parIndex('pins', 'stationId', st.id);
    couche._liens = (await DB.tout('liens')).filter((l) => l.fromId === st.id);
    const toutes = await DB.parIndex('stations', 'visiteId', st.visiteId);
    const ip = await infoPlan(st.visiteId);
    const auto = liensAuto(st, toutes, ip).filter((a) => !couche._liens.some((m) => m.toId === a.toId));
    couche._liens = [...couche._liens, ...auto];
    const noms = {};
    for (const s2 of toutes) noms[s2.id] = s2.nom;
    for (const l of couche._liens) {
      if (!noms[l.toId]) { const s2 = await DB.lire('stations', l.toId); noms[l.toId] = s2 ? s2.nom : '?'; }
    }
    couche._noms = noms;
    couche._chargement = false;
    construireSurcouches(st, couche);
  }

  for (const n of couche.querySelectorAll('[data-u]')) {
    const p = vis.uvVersEcran(parseFloat(n.dataset.u), parseFloat(n.dataset.v));
    n.style.display = p.visible ? '' : 'none';
    if (p.visible) n.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, ${n.classList.contains('pin') ? '-100%' : '-50%'})`;
  }
  tracerTraitsMesure();
}

function construireSurcouches(st, couche) {
  for (const n of couche.querySelectorAll('.pin, .lien')) n.remove();

  for (const p of couche._pins || []) {
    const t = TYPES_OBS.find((x) => x.cle === p.type) || TYPES_OBS.at(-1);
    const d = document.createElement('div');
    d.className = 'pin obs';
    d.dataset.u = p.u; d.dataset.v = p.v;
    d.innerHTML = `<div class="legende">${esc(p.titre || t.nom)}</div>
      <div class="bulle">${t.ico}</div><div class="queue"></div>`;
    d.onclick = (e) => { e.stopPropagation(); fichePin(p, st); };
    couche.appendChild(d);
  }

  const zv = el('#voisins');
  if (zv) {
    zv.innerHTML = '';
    for (const l of couche._liens || []) {
      if (!l.auto) continue;
      const bt = document.createElement('button');
      bt.innerHTML = `<span class="fl">▲</span>${esc(couche._noms[l.toId] || 'Station')}${l.dist != null ? ' · ' + C.formaterM(l.dist) : ''}`;
      bt.onclick = () => { S.arrivee = { cap: l.cap }; aller('viseur', { stationId: l.toId }); };
      zv.appendChild(bt);
    }
  }

  for (const l of couche._liens || []) {
    const d = document.createElement('div');
    d.className = 'lien' + (l.auto ? ' auto' : '');
    d.dataset.u = l.u; d.dataset.v = l.v;
    const dist = l.dist != null ? ' · ' + C.formaterM(l.dist) : '';
    d.innerHTML = `<div class="disque">${l.auto ? '▲' : '→'}</div><div class="etiquette">${esc(couche._noms[l.toId] || 'Station')}${dist}</div>`;
    d.onclick = (e) => {
      e.stopPropagation();
      S.arrivee = l.cap != null ? { cap: l.cap } : null;
      aller('viseur', { stationId: l.toId });
    };
    couche.appendChild(d);
  }
}

function tracerTraitsMesure() {
  const svg = el('#svg'), vis = S.visionneuse;
  if (!svg || !vis) return;
  const me = S.mesureEnCours;
  svg.innerHTML = '';
  for (const n of document.querySelectorAll('.pt-mesure')) n.remove();
  if (!me || !me.points.length) return;

  const ecran = me.points.map((p) => vis.uvVersEcran(p.u, p.v));
  const couche = el('#couche');

  me.points.forEach((p, i) => {
    const e = ecran[i];
    if (!e.visible) return;
    const d = document.createElement('div');
    d.className = 'pt-mesure' + (me.type === 'hauteur' && i === 1 ? ' sommet' : '');
    d.style.left = e.x + 'px'; d.style.top = e.y + 'px';
    couche.appendChild(d);
  });

  const trait = (a, b, couleur, pointille = false) => {
    if (!a.visible || !b.visible) return;
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y);
    ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y);
    ln.setAttribute('stroke', couleur);
    ln.setAttribute('stroke-width', '2.5');
    if (pointille) ln.setAttribute('stroke-dasharray', '7 5');
    svg.appendChild(ln);
  };

  if (me.type === 'surface' && ecran.length >= 2) {
    for (let i = 0; i < ecran.length; i++) {
      trait(ecran[i], ecran[(i + 1) % ecran.length], '#2fd0b8', i === ecran.length - 1 && ecran.length < 3);
    }
  } else if (ecran.length >= 2) {
    trait(ecran[0], ecran[1], me.type === 'hauteur' ? '#ff8f1f' : '#2fd0b8');
  }
}

/* ---------- appui dans l'image ---------- */

async function surTap(st, u, v) {
  if (S.modeViseur === 'mesure' && S.mesureEnCours) return ajouterPointMesure(st, u, v);
  if (S.modeViseur === 'observation') return formPin(st, u, v);
  if (S.modeViseur === 'lien') return formLien(st, u, v);
}

/* ============================================================
   MESURE
   ============================================================ */

function demarrerMesure(st) {
  if (!st.sphereComplete) {
    modale('Cotation sur une 360° partielle',
      `Cette vue ne montre pas le sol au pied de l'appareil. La cotation repose justement sur
       l'intersection de la visée avec le plan du sol : sans sol visible, les points bas ne sont pas
       exploitables.`, `
      <div class="note attention">Vous pouvez quand même coter ce qui est visible au sol plus loin,
      mais <strong>calez d'abord la station sur une longueur connue</strong> (une dalle, une porte,
      une règle posée au sol), sinon l'échelle sera fausse.</div>
      <div class="note info">Pour coter sans réglage, importez une panoramique sphérique complète
      d'une caméra 360° : le sol y est visible, et la géométrie est alors exacte.</div>`, [
      { libelle: 'Retour', action: fermerModale },
      { libelle: 'Caler la station', action: () => { fermerModale(); assistantCalibration(st); } },
      { libelle: 'Mesurer quand même', genre: 'mesure', action: () => { fermerModale(); choixTypeMesure(st); } }
    ]);
    return;
  }
  choixTypeMesure(st);
}

function choixTypeMesure(st) {
  modale('Que mesurez-vous ?', '', `
    <button class="btn large" id="t-sol" style="margin-bottom:9px;justify-content:flex-start;text-align:left;height:auto;padding:13px 15px;flex-direction:column;align-items:flex-start">
      <strong>Longueur au sol</strong>
      <span style="font-size:12.5px;color:var(--texte-2);font-weight:400">Mur, trame, largeur de terrasse, emprise. Deux points posés au sol.</span>
    </button>
    <button class="btn large" id="t-haut" style="margin-bottom:9px;justify-content:flex-start;text-align:left;height:auto;padding:13px 15px;flex-direction:column;align-items:flex-start">
      <strong>Hauteur</strong>
      <span style="font-size:12.5px;color:var(--texte-2);font-weight:400">Acrotère, porte, fenêtre, garde-corps. Le pied au sol, puis le sommet.</span>
    </button>
    <button class="btn large" id="t-surf" style="margin-bottom:12px;justify-content:flex-start;text-align:left;height:auto;padding:13px 15px;flex-direction:column;align-items:flex-start">
      <strong>Surface au sol</strong>
      <span style="font-size:12.5px;color:var(--texte-2);font-weight:400">Toiture-terrasse, zone de reprise d'étanchéité. Contour point par point.</span>
    </button>
    <div class="note ${st.calibre ? 'ok' : 'attention'}" style="margin-bottom:0">
      ${st.calibre
        ? `Station calée sur une longueur connue. Hauteur d'objectif retenue : <strong>${st.hc.toFixed(2).replace('.', ',')} m</strong>.`
        : `Station non calée : les cotes reposent sur la hauteur d'objectif saisie (<strong>${st.hc.toFixed(2).replace('.', ',')} m</strong>). Un calage sur une longueur connue supprime cette incertitude.`}
    </div>`, [
    { libelle: 'Annuler', action: fermerModale },
    { libelle: st.calibre ? 'Recaler' : 'Caler la station', action: () => { fermerModale(); assistantCalibration(st); } }
  ]);

  const lancer = (type) => {
    fermerModale();
    S.modeViseur = 'mesure';
    S.mesureEnCours = { type, points: [], resultat: null };
    rafraichirViseur(st);
    ajouterBoutonsMesure(st);
  };
  el('#t-sol').onclick = () => lancer('sol');
  el('#t-haut').onclick = () => lancer('hauteur');
  el('#t-surf').onclick = () => lancer('surface');
}

function ajouterBoutonsMesure(st) {
  const outils = el('#outils');
  if (!outils) return;
  outils.innerHTML = `
    <button class="outil" id="m-annuler"><span class="ico">✕</span>Quitter</button>
    <button class="outil" id="m-defaire"><span class="ico">↶</span>Défaire</button>
    <button class="outil actif-mesure" id="m-point" style="flex:1.6"><span class="ico">⊕</span>Poser au viseur</button>
    <button class="outil" id="m-valider"><span class="ico">✓</span>Noter</button>`;

  el('#m-annuler').onclick = async () => {
    S.modeViseur = 'navigation'; S.mesureEnCours = null;
    await rafraichirViseur(st);
  };
  el('#m-defaire').onclick = () => {
    if (!S.mesureEnCours) return;
    S.mesureEnCours.points.pop();
    calculerMesure(st);
  };
  el('#m-point').onclick = () => {
    const vis = S.visionneuse;
    const r = vis.canvas.getBoundingClientRect();
    const uv = vis.ecranVersUV(r.width / 2, r.height / 2);
    ajouterPointMesure(st, uv.u, uv.v);
  };
  el('#m-valider').onclick = () => enregistrerMesure(st);
  majReticule();
}

function ajouterPointMesure(st, u, v) {
  const me = S.mesureEnCours;
  if (!me) return;
  const max = me.type === 'surface' ? 24 : 2;
  if (me.points.length >= max) {
    if (me.type !== 'surface') { toast('Deux points suffisent — « Défaire » pour reprendre'); return; }
  }
  me.points.push({ u, v });
  calculerMesure(st);
}

function calculerMesure(st) {
  const me = S.mesureEnCours;
  if (!me) return;
  const hc = st.hc, ho = st.horizon || 0;
  me.resultat = null;

  if (me.type === 'sol' && me.points.length === 2) {
    me.resultat = G.mesureAuSol(me.points[0], me.points[1], hc, ho);
  } else if (me.type === 'hauteur' && me.points.length === 2) {
    me.resultat = G.mesureHauteur(me.points[0], me.points[1], hc, ho);
  } else if (me.type === 'surface' && me.points.length >= 3) {
    me.resultat = G.surfacePolygoneSol(me.points, hc, ho);
  }

  if (me.resultat && !me.resultat.ok) {
    toast(me.resultat.erreur, 'err');
    me.points.pop();
    me.resultat = null;
  }
  if (me.resultat && me.resultat.ok && me.resultat.fiabilite.niveau === 'mauvaise') {
    toast('Visée trop rasante : cette cote n\'est pas exploitable', 'err');
  }
  majBandeau(st);
  tracerTraitsMesure();
}

function enregistrerMesure(st) {
  const me = S.mesureEnCours;
  if (!me || !me.resultat || !me.resultat.ok) {
    toast('Posez d\'abord les points de la cote', 'err');
    return;
  }
  const r = me.resultat;
  const suggestions = {
    sol: ['Longueur de mur', 'Largeur de terrasse', 'Longueur d\'acrotère', 'Entraxe', 'Largeur de porte'],
    hauteur: ['Hauteur d\'acrotère', 'Hauteur de relevé', 'Hauteur de porte', 'Allège de fenêtre', 'Linteau', 'Hauteur de garde-corps'],
    surface: ['Surface de terrasse', 'Zone de reprise d\'étanchéité', 'Surface de dallage']
  }[me.type] || [];

  modale('Noter la cote',
    `<strong class="num" style="font-size:19px;color:var(--mesure)">${r.type === 'surface' ? G.formaterSurface(r.valeur) : G.formaterLongueur(r.valeur)}</strong>
     &nbsp;${esc(G.formaterIncertitude(r.incertitude))}`, `
    <div class="champ"><label>Désignation</label>
      <input id="f-lib" list="l-sug" placeholder="${esc(suggestions[0] || 'Désignation')}">
      <datalist id="l-sug">${suggestions.map((s) => `<option>${esc(s)}</option>`).join('')}</datalist></div>
    ${r.type === 'surface' ? `<div class="note info">Périmètre du contour : <strong class="num">${G.formaterLongueur(r.perimetre)}</strong></div>` : ''}
    <div class="note ${r.fiabilite.niveau === 'bonne' ? 'ok' : r.fiabilite.niveau === 'mauvaise' ? 'alerte' : 'attention'}">
      ${esc(G.LIBELLE_FIABILITE[r.fiabilite.niveau])}${r.detail && r.detail.distance ? ` — ouvrage à ${G.formaterLongueur(r.detail.distance)} de l'appareil` : ''}
    </div>`, [
    { libelle: 'Annuler', action: fermerModale },
    {
      libelle: 'Enregistrer', genre: 'mesure', action: async () => {
        await DB.enregistrer('mesures', {
          id: DB.uid('me'),
          stationId: st.id,
          type: r.type,
          valeur: r.valeur,
          perimetre: r.perimetre || null,
          incertitude: r.incertitude || null,
          fiabilite: G.LIBELLE_FIABILITE[r.fiabilite.niveau],
          libelle: el('#f-lib').value.trim() || libelleTypeMesure(r.type),
          points: me.points,
          hc: st.hc,
          horizon: st.horizon || 0,
          calibre: !!st.calibre,
          creeLe: new Date().toISOString()
        });
        fermerModale();
        toast('Cote enregistrée', 'ok');
        S.mesureEnCours = { type: me.type, points: [], resultat: null };
        majBandeau(st);
        tracerTraitsMesure();
      }
    }
  ]);
  setTimeout(() => el('#f-lib') && el('#f-lib').focus(), 120);
}

/* ---------- calage de la station ---------- */

/* ---------- cotes de référence de la visite ----------
   Une cote relevée au mètre sur place (hauteur d'un acrotère, largeur d'un
   regard…) est saisie une fois ; elle sert ensuite à caler chaque photo et
   chaque vue 360° où cet élément apparaît. */

function htmlReferences(v, unite = 'm') {
  const refs = (v && v.references) || [];
  if (!refs.length) return '';
  return `<div class="champ"><label>Références de cette visite</label>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${refs.map((r) =>
      `<button type="button" class="btn" data-ref="${r.id}" style="min-height:40px;padding:6px 11px;font-size:13px">${esc(r.nom)} · ${String(r.valeur).replace('.', ',')} ${unite}</button>`).join('')}
    </div></div>`;
}
function brancherReferences(v, champValeur, champNom) {
  for (const b of document.querySelectorAll('[data-ref]')) {
    b.onclick = () => {
      const r = v.references.find((x) => x.id === b.dataset.ref);
      if (!r) return;
      el(champValeur).value = r.valeur;
      if (champNom) el(champNom).value = r.nom;
      toast('Cote ' + r.nom + ' reprise');
    };
  }
}
async function gardeReference(v, nom, valeur) {
  nom = (nom || '').trim();
  if (!v || !nom || !(valeur > 0)) return;
  v.references = v.references || [];
  const ex = v.references.find((r) => r.nom.toLowerCase() === nom.toLowerCase());
  if (ex) ex.valeur = valeur; else v.references.push({ id: DB.uid('rf'), nom, valeur });
  try { await DB.enregistrer('visites', v); } catch (e) { /* sans gravité */ }
}

function assistantCalibration(st) {
  modale('Caler la station',
    `Mesurez dans la vue une longueur <strong>dont vous connaissez la cote réelle</strong> : une dalle,
     une largeur de porte, une règle de maçon posée au sol. L'application en déduit la hauteur
     d'objectif exacte, et toutes les cotes de la station deviennent justes.`, `
    <div class="note info">Le calage corrige l'échelle de <em>toute</em> la panoramique d'un coup.
    C'est l'opération la plus rentable : une minute au mètre ruban et la station est fiable.</div>
    <button class="btn large" id="c-haut" style="margin-bottom:9px">Une hauteur connue (acrotère, porte…)</button>
    <button class="btn large mesure" id="c-mesurer">Une longueur au sol</button>
    <div class="note" style="margin-top:12px;font-size:12.5px">Sur une toiture : mesurez l'acrotère au mètre,
    choisissez « hauteur connue », visez son pied puis son sommet, et saisissez votre cote.</div>`, [
    { libelle: 'Plus tard', action: fermerModale }
  ]);
  el('#c-haut').onclick = () => lancerCalibration(st, 'hauteur');
  el('#c-mesurer').onclick = () => lancerCalibration(st, 'sol');
}

function lancerCalibration(st, type) {
  {
    fermerModale();
    S.modeViseur = 'mesure';
    S.mesureEnCours = { type, points: [], resultat: null, calibration: true };
    rafraichirViseur(st);
    ajouterBoutonsMesure(st);
    el('#m-valider').innerHTML = '<span class="ico">✓</span>Caler';
    el('#m-valider').onclick = () => finirCalibration(st);
    toast(type === 'hauteur' ? 'Visez le PIED puis le SOMMET de la référence' : 'Visez les deux extrémités de la référence, au sol');
  }
}

function finirCalibration(st) {
  const me = S.mesureEnCours;
  if (!me || !me.resultat || !me.resultat.ok) { toast('Posez les deux points de la référence', 'err'); return; }
  const lu = me.resultat.valeur;
  const haut = me.type === 'hauteur';
  DB.lire('visites', st.visiteId).then((vis) => { /* pour les références */ S._visCal = vis; });

  modale(haut ? 'Hauteur réelle de la référence' : 'Cote réelle de la référence',
    `L'application lit <strong class="num">${G.formaterLongueur(lu)}</strong> avec la hauteur
     d'objectif actuelle (${st.hc.toFixed(2).replace('.', ',')} m). Saisissez la cote vraie.`, `
    ${htmlReferences(S._visCal)}
    <div class="champ"><label>${haut ? 'Hauteur' : 'Longueur'} réelle (m) *</label>
      <input id="f-vrai" type="number" step="0.001" inputmode="decimal" placeholder="ex. ${haut ? '0,420' : '3,200'}">
      <div class="aide">Au mètre ruban ou au télémètre, le plus précisément possible.</div></div>
    <div class="champ"><label>Garder comme référence de la visite (facultatif)</label>
      <input id="f-refnom" placeholder="ex. acrotère nord"></div>`, [
    { libelle: 'Annuler', action: fermerModale },
    {
      libelle: 'Appliquer', genre: 'principal', action: async () => {
        const vrai = parseFloat(String(el('#f-vrai').value).replace(',', '.'));
        if (!(vrai > 0)) { toast('Saisissez la cote réelle', 'err'); return; }
        const cal = G.calibrerHauteur(st.hc, lu, vrai);
        if (!cal) { toast('Calage impossible', 'err'); return; }
        if (cal.hc < 0.2 || cal.hc > 4) {
          toast('Résultat invraisemblable — vérifiez que les deux points sont bien au sol', 'err');
          return;
        }
        st.hc = cal.hc;
        st.calibre = true;
        st.calibreLe = new Date().toISOString();
        st.calibreRef = { lu, vrai, type: me.type };
        await DB.enregistrer('stations', st);
        await gardeReference(S._visCal, el('#f-refnom').value, vrai);
        fermerModale();
        S.mesureEnCours = null;
        S.modeViseur = 'navigation';
        await rafraichirViseur(st);
        modale('Station calée',
          `Hauteur d'objectif corrigée : <strong class="num">${cal.hc.toFixed(3).replace('.', ',')} m</strong>
           (${cal.ecart >= 0 ? '+' : ''}${(cal.ecart * 100).toFixed(1).replace('.', ',')} cm).`, `
          <div class="note ok">Les cotes prises désormais dans cette station tiennent compte du calage.
          Les cotes relevées <em>avant</em> gardent l'ancienne hauteur : reprenez-les si elles comptent.</div>
          ${Math.abs(cal.facteur - 1) > 0.25 ? `<div class="note alerte">L'écart dépasse 25 %.
          Vérifiez que les deux points visés étaient bien posés au sol et que l'horizon de la
          panoramique est correct.</div>` : ''}`, [
          { libelle: 'Terminé', genre: 'principal', action: fermerModale }
        ]);
      }
    }
  ]);
  setTimeout(() => { brancherReferences(S._visCal || {}, '#f-vrai', '#f-refnom'); el('#f-vrai') && el('#f-vrai').focus(); }, 250);
}

/* ---------- épingles d'observation ---------- */

function formPin(st, u, v, existant = null) {
  const p = existant || {};
  modale(existant ? 'Modifier l\'observation' : 'Nouvelle observation', '', `
    <div class="champ"><label>Nature</label>
      <select id="f-type">${TYPES_OBS.map((t) =>
        `<option value="${t.cle}" ${p.type === t.cle ? 'selected' : ''}>${t.ico} ${t.nom}</option>`).join('')}</select></div>
    <div class="champ"><label>Intitulé</label>
      <input id="f-titre" value="${esc(p.titre || '')}" placeholder="Décollement de relevé en angle"></div>
    <div class="champ"><label>Gravité</label>
      <select id="f-grav">${['', 'À surveiller', 'À reprendre', 'Urgent'].map((g) =>
        `<option ${p.gravite === g ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
    <div class="champ"><label>Constat</label>
      <textarea id="f-note" placeholder="Ce que vous constatez, ce qu'il faut faire…">${esc(p.note || '')}</textarea></div>
    <div class="champ"><label>Photo de détail</label>
      <button class="btn large" id="f-photo">${p.photo ? 'Remplacer la photo' : '📷 Ajouter une photo'}</button>
      <div id="f-apercu" style="margin-top:9px">${p.photo ? `<img src="${URL.createObjectURL(p.photo)}" style="width:100%;border-radius:8px">` : ''}</div>
      <div class="aide">Un gros plan vaut mieux qu'un zoom dans la panoramique.</div></div>`, [
    { libelle: 'Annuler', action: fermerModale },
    {
      libelle: existant ? 'Enregistrer' : 'Épingler', genre: 'principal', action: async () => {
        const obj = {
          id: existant ? existant.id : DB.uid('pn'),
          stationId: st.id,
          u: existant ? existant.u : u,
          v: existant ? existant.v : v,
          type: el('#f-type').value,
          titre: el('#f-titre').value.trim(),
          gravite: el('#f-grav').value,
          note: el('#f-note').value.trim(),
          photo: _photoTemp !== undefined ? _photoTemp : p.photo || null,
          creeLe: existant ? existant.creeLe : new Date().toISOString()
        };
        await DB.enregistrer('pins', obj);
        _photoTemp = undefined;
        fermerModale();
        toast('Observation épinglée', 'ok');
        const couche = el('#couche');
        if (couche) { couche._pins = null; couche._chargement = false; await positionnerSurcouches(st); }
      }
    }
  ]);

  _photoTemp = undefined;
  el('#f-photo').onclick = async () => {
    const f = await choisirFichier({ accept: 'image/*', capture: 'environment' });
    if (!f) return;
    _photoTemp = await CAP.reduire(f, 1600, 0.82);
    el('#f-apercu').innerHTML = `<img src="${URL.createObjectURL(_photoTemp)}" style="width:100%;border-radius:8px">`;
    el('#f-photo').textContent = 'Remplacer la photo';
  };
}
let _photoTemp;

function fichePin(p, st) {
  const t = TYPES_OBS.find((x) => x.cle === p.type) || TYPES_OBS.at(-1);
  modale(p.titre || t.nom, `${t.ico} ${esc(t.nom)}${p.gravite ? ' · ' + esc(p.gravite) : ''} · ${dateHeureFR(p.creeLe)}`, `
    ${p.photo ? `<img src="${URL.createObjectURL(p.photo)}" style="width:100%;border-radius:10px;margin-bottom:13px">` : ''}
    ${p.note ? `<div class="note">${esc(p.note).replace(/\n/g, '<br>')}</div>` : '<div class="note">Aucun constat saisi.</div>'}
    <div class="rangee-btn" style="margin-top:4px">
      <button class="btn petit" id="p-modif">Modifier</button>
      <button class="btn petit danger" id="p-suppr">Supprimer</button>
    </div>`, [
    { libelle: 'Fermer', action: fermerModale }
  ]);
  el('#p-modif').onclick = () => { fermerModale(); formPin(st, p.u, p.v, p); };
  el('#p-suppr').onclick = async () => {
    fermerModale();
    if (await confirmer('Supprimer l\'observation ?', esc(p.titre || t.nom), 'Supprimer')) {
      await DB.supprimer('pins', p.id);
      const couche = el('#couche');
      if (couche) { couche._pins = null; couche._chargement = false; await positionnerSurcouches(st); }
      toast('Observation supprimée');
    }
  };
}

/* ---------- liens entre stations ---------- */

async function formLien(st, u, v) {
  const stations = (await DB.parIndex('stations', 'visiteId', st.visiteId)).filter((s) => s.id !== st.id);
  if (!stations.length) {
    return modale('Aucune autre station', 'Ajoutez au moins une deuxième vue 360° à cette visite pour pouvoir circuler de l\'une à l\'autre.', '', [
      { libelle: 'Fermer', action: fermerModale }
    ]);
  }
  modale('Relier à une station',
    'Un passage apparaîtra à cet endroit de la vue. Posez-le dans la direction réelle où se trouve la station voisine.', `
    <div class="champ"><label>Station de destination</label>
      <select id="f-dest">${stations.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}</select></div>
    <div class="champ"><label><input type="checkbox" id="f-retour" checked style="width:auto;min-height:auto;margin-right:7px">
      Créer aussi le passage en sens inverse</label>
      <div class="aide">Placé automatiquement à l'opposé dans la station d'arrivée, à ajuster si besoin.</div></div>`, [
    { libelle: 'Annuler', action: fermerModale },
    {
      libelle: 'Créer le passage', genre: 'principal', action: async () => {
        const dest = el('#f-dest').value;
        await DB.enregistrer('liens', { id: DB.uid('ln'), fromId: st.id, toId: dest, u, v });
        if (el('#f-retour').checked) {
          await DB.enregistrer('liens', {
            id: DB.uid('ln'), fromId: dest, toId: st.id,
            u: (u + 0.5) % 1, v: Math.min(0.72, Math.max(0.5, v))
          });
        }
        fermerModale();
        toast('Passage créé', 'ok');
        S.modeViseur = 'navigation';
        const couche = el('#couche');
        if (couche) { couche._pins = null; couche._chargement = false; }
        await rafraichirViseur(st);
      }
    }
  ]);
}

/* ---------- liste rapide des stations ---------- */

async function listeStationsRapide(st) {
  const stations = await DB.parIndex('stations', 'visiteId', st.visiteId);
  stations.sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  modale('Stations de la visite', '', stations.map((s, i) => `
    <button class="item" data-go="${s.id}" style="margin-bottom:8px">
      <div class="vignette" ${s.pano ? `style="background-image:url(${URL.createObjectURL(s.vignette || s.pano)})"` : ''}></div>
      <div class="corps-item"><div class="nom">${esc(s.nom)}${s.id === st.id ? ' — vue actuelle' : ''}</div>
      <div class="meta">${s.calibre ? 'Calée' : 'Non calée'} · objectif à ${s.hc.toFixed(2).replace('.', ',')} m</div></div>
    </button>`).join(''), [{ libelle: 'Fermer', action: fermerModale }]);
  for (const b of document.querySelectorAll('[data-go]')) {
    b.onclick = () => {
      fermerModale();
      if (b.dataset.go !== st.id) aller('viseur', { stationId: b.dataset.go });
    };
  }
}

/* ---------- menu de station ---------- */

function menuStation(st, v) {
  modale(st.nom, '', `
    <button class="btn large" id="s-renommer" style="margin-bottom:9px">Renommer la station</button>
    <button class="btn large" id="s-caler" style="margin-bottom:9px">${st.calibre ? 'Recaler' : 'Caler'} la station</button>
    <button class="btn large" id="s-horizon" style="margin-bottom:9px">Régler l'horizon</button>
    <button class="btn large" id="s-gyro" style="margin-bottom:9px">Piloter au gyroscope</button>
    <button class="btn large" id="s-orienter" style="margin-bottom:9px">Orienter sur la carte / le plan</button>
    <button class="btn large danger" id="s-suppr">Supprimer la station</button>
    <div class="note" style="margin:13px 0 0">Objectif à <strong>${st.hc.toFixed(2).replace('.', ',')} m</strong>
    ${st.calibre ? `· calée le ${dateFR(st.calibreLe)} sur une référence de ${G.formaterLongueur(st.calibreRef.vrai)}` : '· non calée'}
    <br>Ajoutée le ${dateHeureFR(st.creeLe)} · ${st.origine === 'import' ? 'importée' : 'prise dans l\'application'}
    ${st.assemblage ? `<br>Assemblage : ${st.assemblage === 'fondu-flottant' ? 'fondu' : 'sans fondu (' + esc(st.assemblage) + ')'}${st.champMesure ? ' · angle de vue ' + String(st.champMesure).replace('.', ',') + '°' : ''}` : ''}</div>`, []);

  el('#s-renommer').onclick = () => {
    fermerModale();
    modale('Renommer', '', `<div class="champ"><label>Nom de la station</label>
      <input id="f-n" value="${esc(st.nom)}"></div>
      <div class="champ"><label>Note</label><input id="f-no" value="${esc(st.note || '')}"></div>`, [
      { libelle: 'Annuler', action: fermerModale },
      {
        libelle: 'Enregistrer', genre: 'principal', action: async () => {
          st.nom = el('#f-n').value.trim() || st.nom;
          st.note = el('#f-no').value.trim();
          await DB.enregistrer('stations', st);
          fermerModale(); rendre();
        }
      }
    ]);
  };
  el('#s-caler').onclick = () => { fermerModale(); assistantCalibration(st); };
  el('#s-horizon').onclick = () => { fermerModale(); reglerHorizon(st); };
  el('#s-orienter').onclick = () => { fermerModale(); orienterStation(st); };
  el('#s-gyro').onclick = async () => {
    fermerModale();
    const ok = await S.visionneuse.activerGyro();
    toast(ok ? 'Gyroscope actif — bougez le téléphone' : 'Gyroscope indisponible ou refusé', ok ? 'ok' : 'err');
  };
  el('#s-suppr').onclick = async () => {
    fermerModale();
    if (await confirmer('Supprimer cette station ?',
      `La vue 360° « ${esc(st.nom)} », ses observations et ses cotes seront effacées.`, 'Supprimer')) {
      await DB.supprimerStation(st.id);
      toast('Station supprimée');
      aller('visite', { stationId: null, onglet: 'stations' }, false);
    }
  };
}

function reglerHorizon(st) {
  const vis = S.visionneuse;
  const depart = st.horizon || 0;
  modale('Régler l\'horizon',
    `L'horizon doit tomber au milieu de la vue, sinon les angles de site sont faussés et
     les cotes avec. Faites coïncider la ligne turquoise avec un horizon réel.`, `
    <div class="champ"><label>Décalage : <span id="val-h" class="num">${(depart * 100).toFixed(1)}</span> %</label>
      <input id="f-h" type="range" min="-8" max="8" step="0.1" value="${depart * 100}" style="min-height:auto"></div>
    <div class="note info">Après ce réglage, recalez la station sur une longueur connue.</div>`, [
    {
      libelle: 'Annuler', action: () => {
        vis.horizon = depart; vis.rendre(); fermerModale();
      }
    },
    {
      libelle: 'Enregistrer', genre: 'principal', action: async () => {
        st.horizon = vis.horizon;
        await DB.enregistrer('stations', st);
        fermerModale();
        toast('Horizon enregistré', 'ok');
      }
    }
  ]);
  const inp = el('#f-h');
  inp.oninput = () => {
    vis.horizon = parseFloat(inp.value) / 100;
    el('#val-h').textContent = parseFloat(inp.value).toFixed(1);
    vis.rendre();
  };
}

/* ---------- station de type photo simple ---------- */

/* ============================================================
   VUE : PARCOURS — photos automatiques en marchant
   ------------------------------------------------------------
   Chaque photo est enregistrée tout de suite (rien ne se perd si
   l'appli se ferme) avec : l'heure, la position GPS et la direction
   de la boussole. Au bureau, la visite se rejoue sur la carte et
   l'on mesure dans les photos.
   ============================================================ */

const MODES_PARCOURS = {
  t4: { nom: 'Toutes les 4 s', temps: 4 },
  d3: { nom: 'Tous les 3 m (GPS)', dist: 3 },
  d6: { nom: 'Tous les 6 m (GPS)', dist: 6 },
  m: { nom: 'À la main' }
};

function lancerParcours(obtenirVisite) {
  const autorisation = CAPACITES.mouvement ? demanderMouvement() : Promise.resolve(false);
  (async () => {
    const v = await obtenirVisite();
    if (!v) return;
    if (!CAPACITES.camera) {
      return modale('Caméra indisponible ici', '', `<div class="note attention">Ouvrez l'application depuis votre
        adresse <strong>.netlify.app</strong> dans Safari (pas depuis l'aperçu Claude).</div>`,
        [{ libelle: 'Fermer', genre: 'principal', action: fermerModale }]);
    }
    await autorisation;
    if (!(S.vue === 'visite' && S.visiteId === v.id)) {
      S.retour.push({ vue: S.vue, chantierId: S.chantierId, visiteId: S.visiteId, stationId: S.stationId, onglet: S.onglet });
      Object.assign(S, { vue: 'visite', chantierId: v.chantierId, visiteId: v.id, onglet: 'stations' });
    }
    aller('parcours', {});
  })().catch((e) => toast('Erreur : ' + (e.message || e), 'err'));
}

VUES.parcours = async function () {
  const v = await DB.lire('visites', S.visiteId);
  const chantier = await DB.lire('chantiers', S.chantierId);
  const hc = chantier ? (chantier.hcDefaut ?? 1.6) : 1.6;
  let mode = await DB.reglage('parcoursMode', 't4');
  if (!MODES_PARCOURS[mode]) mode = 't4';

  const deja = await DB.parIndex('stations', 'visiteId', v.id);
  let ordre = deja.reduce((m, s) => Math.max(m, (s.ordre || 0) + 1), 0);
  let compteur = deja.filter((s) => s.origine === 'parcours').length;
  let nouvelles = 0;

  app().innerHTML = `
    ${entete('Parcours', dateFR(v.date) + (chantier ? ' — ' + chantier.nom : ''), true)}
    <div class="corps plein">
      <div class="scene" id="scene">
        <video id="flux" playsinline autoplay muted
               style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
        <div class="flash" id="flash"></div>
        <div class="bandeau-haut">
          <div class="pastille" style="flex:1">
            <div class="ligne entre"><strong id="compte">0 photo</strong>
              <span id="etat-gps" style="color:var(--texte-2);font-size:12px">GPS…</span></div>
            <div class="segments" id="choix-mode" style="margin:9px 0 0;overflow-x:auto">
              ${Object.entries(MODES_PARCOURS).map(([k, m]) => `<button data-mode="${k}" class="${k === mode ? 'actif' : ''}">${m.nom}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="consigne" id="consigne" style="pointer-events:auto"><div class="boite">
          <strong>Parcours en marchant</strong><br>
          Tenez le téléphone devant vous, objectif vers l'avant. Les photos se prennent
          toutes seules avec leur position et leur direction.<br><br>
          <strong>Sur une toiture, ne regardez pas l'écran en marchant.</strong><br><br>
          <button class="btn principal large" id="b-demarrer">Démarrer</button></div></div>
        <div class="outils" id="outils">
          <button class="outil" id="b-pause"><span class="ico">⏸</span>Pause</button>
          <button class="outil" id="b-photo" style="flex:1.4"><span class="ico">📷</span>Photo</button>
          <button class="outil" id="b-fin"><span class="ico">✓</span>Terminer</button>
        </div>
      </div>
    </div>`;

  const video = el('#flux');
  const consigne = (html) => { const c = el('#consigne'); if (c) c.innerHTML = html ? `<div class="boite">${html}</div>` : ''; };
  let flux = null, actif = true, enPause = true, occupe = false;
  let geo = null, cap = null, capSrc = null, derniereT = 0, dernierePos = null, verrou = null, boucle = null, idGPS = null;
  const trace = Array.isArray(v.trace) ? v.trace.slice() : [];
  let tracePasEnreg = 0;

  const majCompte = () => {
    const n = el('#compte'); if (n) n.textContent = `${nouvelles} photo${nouvelles > 1 ? 's' : ''}`;
  };
  const majGPS = () => {
    const z = el('#etat-gps'); if (!z) return;
    const g = geo && Date.now() - geo.t < 8000 ? `GPS ± ${Math.round(geo.acc)} m` : 'GPS : pas de signal';
    z.textContent = `${g}${cap != null ? ' · cap ' + Math.round(cap) + '°' : ''}`;
  };

  for (const b of document.querySelectorAll('#choix-mode [data-mode]')) {
    b.onclick = async () => {
      mode = b.dataset.mode; await DB.setReglage('parcoursMode', mode);
      document.querySelectorAll('#choix-mode [data-mode]').forEach((x) => x.classList.toggle('actif', x === b));
    };
  }

  const surOri = (ev) => {
    if (typeof ev.webkitCompassHeading === 'number') { cap = ev.webkitCompassHeading; capSrc = 'boussole'; }
    else if (ev.absolute && ev.alpha != null) {
      const vu = CAP.viseeDepuisOrientation(ev.alpha, ev.beta, ev.gamma);
      cap = (vu.azimut + 360) % 360; capSrc = 'absolu';
    }
  };

  const enregTrace = async () => {
    if (!tracePasEnreg) return;
    v.trace = trace; tracePasEnreg = 0;
    try { await DB.enregistrer('visites', v); } catch (e) { /* sans gravité */ }
  };

  const arreter = () => {
    actif = false; clearInterval(boucle);
    window.removeEventListener('deviceorientation', surOri, true);
    window.removeEventListener('deviceorientationabsolute', surOri, true);
    if (idGPS != null && navigator.geolocation) navigator.geolocation.clearWatch(idGPS);
    if (flux) flux.getTracks().forEach((t) => t.stop());
    if (verrou && verrou.release) verrou.release().catch(() => {});
  };

  const prendre = async () => {
    if (occupe || !flux) return;
    occupe = true;
    try {
      const cv = CAP.saisirImage(video, 2400);
      if (CAP.estNoire(cv)) throw new Error('image noire');
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.88));
      if (!blob) throw new Error('encodage impossible');
      const gOk = geo && Date.now() - geo.t < 8000 ? geo : null;
      const num = ++compteur;
      const st = {
        id: DB.uid('st'), visiteId: v.id,
        nom: 'Parcours ' + String(num).padStart(2, '0'),
        note: '', pano: blob, type: 'photo', origine: 'parcours',
        ...(gOk ? { geo: { lng: gOk.lng, lat: gOk.lat, precision: Math.round(gOk.acc) } } : {}),
        ...(cap != null ? { cap: Math.round(cap), capSource: capSrc } : {}),
        hc, ordre: ordre++, creeLe: new Date().toISOString()
      };
      Object.assign(st, await CAP.apercusDe(blob).catch(() => ({})));
      await DB.enregistrer('stations', st);
      nouvelles++;
      if (gOk) dernierePos = { lng: gOk.lng, lat: gOk.lat };
      derniereT = performance.now();
      majCompte();
      const f = el('#flash'); if (f) { f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
      if (navigator.vibrate) navigator.vibrate(25);
    } catch (e) {
      toast('Photo non enregistrée : ' + (e.message || e), 'err');
    } finally { occupe = false; }
  };

  const fin = async () => {
    arreter();
    await enregTrace();
    const t = S.retour[S.retour.length - 1];
    const placees = nouvelles > 0 && (await DB.parIndex('stations', 'visiteId', v.id)).some((s) => s.origine === 'parcours' && s.geo);
    if (t && t.vue === 'visite') t.onglet = placees ? 'carte' : 'stations';
    if (nouvelles) toast(`${nouvelles} photo${nouvelles > 1 ? 's' : ''} enregistrée${nouvelles > 1 ? 's' : ''}`, 'ok');
    revenir();
  };
  el('#btn-retour').onclick = fin;
  el('#b-fin').onclick = fin;

  el('#b-pause').onclick = () => {
    enPause = !enPause;
    el('#b-pause').innerHTML = enPause ? '<span class="ico">▶</span>Reprendre' : '<span class="ico">⏸</span>Pause';
  };
  el('#b-photo').onclick = () => prendre();

  el('#b-demarrer').onclick = async () => {
    consigne('Ouverture de la caméra…');
    await demanderMouvement();
    try {
      flux = await CAP.demarrerCamera(video, (n) => { if (n > 0) consigne(`Image noire, essai d'un réglage plus sûr (${n + 1}/3)…`); });
    } catch (e) {
      consigne(messageErreurCamera(e) + `<br><br><button class="btn large" id="b-retry">Réessayer</button>`);
      el('#consigne').style.pointerEvents = 'auto';
      el('#b-retry').onclick = () => rendre();
      return;
    }
    consigne('');
    el('#consigne').style.pointerEvents = 'none';

    window.addEventListener('deviceorientation', surOri, true);
    window.addEventListener('deviceorientationabsolute', surOri, true);
    if (navigator.geolocation) {
      idGPS = navigator.geolocation.watchPosition((p) => {
        geo = { lng: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy, t: Date.now() };
        const w = C.monde(geo.lng, geo.lat);
        const dernier = trace[trace.length - 1];
        if (!dernier || C.distanceCarte(w, C.monde(dernier[0], dernier[1])) >= 1.5) {
          trace.push([+geo.lng.toFixed(7), +geo.lat.toFixed(7)]);
          if (++tracePasEnreg >= 15) enregTrace();
        }
      }, () => { /* pas de signal : on continue sans */ }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    }
    try { if (navigator.wakeLock) verrou = await navigator.wakeLock.request('screen'); } catch (e) { /* facultatif */ }

    enPause = false;
    el('#b-pause').innerHTML = '<span class="ico">⏸</span>Pause';
    boucle = setInterval(() => {
      majGPS();
      if (!actif || enPause || occupe) return;
      const t = performance.now();
      if (t - derniereT < 1800) return;
      const cfg = MODES_PARCOURS[mode];
      if (cfg.temps) { if (t - derniereT >= cfg.temps * 1000) prendre(); }
      else if (cfg.dist) {
        const gOk = geo && Date.now() - geo.t < 6000 && geo.acc <= 30;
        if (gOk) {
          if (!dernierePos || C.distanceCarte(C.monde(geo.lng, geo.lat), C.monde(dernierePos.lng, dernierePos.lat)) >= cfg.dist) prendre();
        } else if (t - derniereT > 6000) prendre();   // pas de GPS exploitable : on ne perd pas la visite
      }
    }, 500);
  };
};

/* ============================================================
   VUE : PHOTO DE PARCOURS — relecture, mini-carte, mesure
   ------------------------------------------------------------
   La photo s'affiche sur le même moteur que les plans : on zoome,
   on déplace, et on mesure après avoir donné une échelle (une
   longueur connue dans la photo : mètre pliant, joint, regard…).
   La mesure n'est juste que dans le plan de cette référence, vu
   à peu près de face.
   ============================================================ */

async function viseurPhoto(st, v) {
  S.arrivee = null;
  const toutes = await DB.parIndex('stations', 'visiteId', st.visiteId);
  toutes.sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const idx = toutes.findIndex((x) => x.id === st.id);
  const prec = toutes[idx - 1], suiv = toutes[idx + 1];
  const pins = await DB.parIndex('pins', 'stationId', st.id);
  st.mesuresPhoto = st.mesuresPhoto || [];

  app().innerHTML = `
    ${entete(st.nom, `${dateFR(v && v.date)} · ${idx + 1}/${toutes.length}`, true,
      `<button class="btn-retour" id="btn-menu" aria-label="Menu">⋯</button>`)}
    <div class="corps plein">
      <div class="scene" id="scene">
        <div id="photo-carte" class="carte-photo"></div>
        <div class="bandeau-haut" id="bandeau"></div>
        <div class="minicarte" id="mini" style="display:none"></div>
        <div class="outils" id="outils"></div>
      </div>
    </div>`;
  brancherRetour();

  const carte = new C.Carte(el('#photo-carte'), { mode: 'plan' });
  S.carteOnglet = carte;
  await carte.setImage(st.pano);
  carte.ajuster();
  const etat = { outil: 'deplacer', pts: [], echelle: st.echelleCourante || null };
  carte.metre = (a, b) => C.distancePlan(a, b, etat.echelle);

  const valeur = (pts, ech) => pts.slice(1).reduce((s, p, i) => s + (C.distancePlan(pts[i], p, ech) || 0), 0);
  const majFormes = () => {
    const f = [];
    for (const m of st.mesuresPhoto) {
      f.push({ pts: m.pts, couleur: '#ff8f1f', etiquette: C.formaterM(valeur(m.pts, m.echelle)), sansCotes: true });
    }
    if (etat.pts.length) {
      const ech = etat.outil === 'echelle';
      f.push({ pts: etat.pts, couleur: ech ? '#ffd23f' : '#2fd0b8', sansCotes: ech,
        etiquette: !ech && etat.pts.length >= 2 && etat.echelle ? C.formaterM(valeur(etat.pts, etat.echelle)) : '' });
    }
    carte.formes = f; carte.rendre();
  };

  const majBandeau = () => {
    const b = el('#bandeau'); if (!b) return;
    const o = etat.outil;
    let txt;
    if (o === 'echelle') txt = `Touchez les deux extrémités d'une longueur connue (${etat.pts.length}/2)`;
    else if (o === 'longueur') txt = etat.echelle ? 'Touchez les points à mesurer (plusieurs possibles)' : 'Donnez d\'abord une échelle (📐)';
    else txt = `${st.cap != null ? 'Cap ' + st.cap + '° · ' : ''}${st.geo ? 'GPS ± ' + st.geo.precision + ' m · ' : ''}${dateHeureFR(st.creeLe)}`;
    const val = o === 'longueur' && etat.pts.length >= 2 && etat.echelle
      ? `<div class="pastille mesure"><div class="gros num">${C.formaterM(valeur(etat.pts, etat.echelle))}</div></div>` : '';
    const act = o === 'longueur' && etat.pts.length
      ? `<div class="pastille"><div class="rangee-btn"><button class="btn" id="m-annul">↶</button>
         <button class="btn principal" id="m-ok">Enregistrer</button><button class="btn" id="m-eff">✕</button></div></div>` : '';
    b.innerHTML = `<div class="pastille" style="flex:1"><span style="color:var(--texte-2)">${esc(txt)}</span>
      ${etat.echelle ? '<br><span style="font-size:11.5px;color:var(--texte-3)">Échelle active · valable dans le plan de la référence</span>' : ''}</div>${val}${act}`;
    if (el('#m-annul')) el('#m-annul').onclick = () => { etat.pts.pop(); majFormes(); majBandeau(); };
    if (el('#m-eff')) el('#m-eff').onclick = () => { etat.pts = []; majFormes(); majBandeau(); };
    if (el('#m-ok')) el('#m-ok').onclick = () => {
      if (etat.pts.length < 2) return toast('Deux points au minimum', 'err');
      const m = { id: DB.uid('mp'), pts: etat.pts.slice(), echelle: etat.echelle, nom: '' };
      modale('Enregistrer la cote', `<strong class="num">${C.formaterM(valeur(m.pts, m.echelle))}</strong>`, `
        <div class="champ"><label>Nom</label><input id="f-mn" placeholder="Hauteur acrotère, joint de dilatation, remontée…">
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${['Hauteur acrotère', 'Joint de dilatation', 'Remontée d\'eau', 'Relevé', 'Largeur'].map((n) =>
            `<button type="button" class="btn" data-nom="${esc(n)}" style="min-height:38px;padding:5px 10px;font-size:12.5px">${esc(n)}</button>`).join('')}</div></div>`, [
        { libelle: 'Annuler', action: fermerModale },
        {
          libelle: 'Enregistrer', genre: 'principal', action: async () => {
            m.nom = el('#f-mn').value.trim() || 'Cote';
            st.mesuresPhoto.push(m);
            await DB.enregistrer('stations', st);
            fermerModale(); etat.pts = []; majFormes(); majBandeau(); majListe();
          }
        }]);
      setTimeout(() => {
        for (const b of document.querySelectorAll('[data-nom]')) b.onclick = () => { el('#f-mn').value = b.dataset.nom; };
        el('#f-mn') && el('#f-mn').focus();
      }, 400);
    };
  };

  const majOutils = () => {
    const o = etat.outil;
    el('#outils').innerHTML = `
      <button class="outil" id="o-prec" ${prec ? '' : 'disabled style="opacity:.35"'}><span class="ico">◀</span>Préc.</button>
      <button class="outil ${o === 'deplacer' ? 'actif' : ''}" data-o="deplacer"><span class="ico">✋</span>Zoom</button>
      <button class="outil ${o === 'echelle' ? 'actif' : ''}" data-o="echelle"><span class="ico">📐</span>Échelle</button>
      <button class="outil ${o === 'longueur' ? 'actif-mesure' : ''}" data-o="longueur"><span class="ico">📏</span>Mesurer</button>
      <button class="outil" id="o-suiv" ${suiv ? '' : 'disabled style="opacity:.35"'}><span class="ico">▶</span>Suiv.</button>`;
    for (const b of document.querySelectorAll('#outils [data-o]')) b.onclick = () => {
      etat.outil = b.dataset.o; etat.pts = []; majOutils(); majFormes(); majBandeau();
    };
    const va = (cible) => { S.arrivee = null; aller('viseur', { stationId: cible.id }, false); };
    if (prec) el('#o-prec').onclick = () => va(prec);
    if (suiv) el('#o-suiv').onclick = () => va(suiv);
  };

  carte.onTap = (w) => {
    if (etat.outil === 'echelle') {
      etat.pts.push(w); majFormes(); majBandeau();
      if (etat.pts.length === 2) {
        const [a, b] = etat.pts, d = Math.hypot(b.x - a.x, b.y - a.y);
        setTimeout(() => modale('Échelle', 'Quelle est la vraie longueur entre ces deux points ?', `
          ${htmlReferences(v)}
          <div class="champ"><label>Longueur réelle (m)</label>
          <input id="f-ech" type="number" inputmode="decimal" step="0.001" min="0.001" placeholder="ex. 0,42"></div>
          <div class="champ"><label>Garder comme référence de la visite (facultatif)</label>
          <input id="f-refnom" placeholder="ex. acrotère nord"></div>
          <div class="note info">Mesurez l'ouvrage au mètre sur place (hauteur d'acrotère, largeur d'un regard), puis
          visez ses deux extrémités dans la photo. Les autres cotes de la photo en sont déduites.</div>`, [
          { libelle: 'Annuler', action: () => { fermerModale(); etat.pts = []; majFormes(); majBandeau(); } },
          {
            libelle: 'Valider', genre: 'principal', action: async () => {
              const L = parseFloat(String(el('#f-ech').value).replace(',', '.'));
              if (!(L > 0) || !(d > 0)) return toast('Longueur invalide', 'err');
              etat.echelle = L * 256 / d;
              st.echelleCourante = etat.echelle;
              st.echelleRef = { m: L, nom: el('#f-refnom').value.trim() };
              await DB.enregistrer('stations', st);
              await gardeReference(v, el('#f-refnom').value, L);
              fermerModale(); etat.pts = []; etat.outil = 'longueur';
              majOutils(); majFormes(); majBandeau();
              toast('Échelle prise — mesurez', 'ok');
            }
          }]), 320);
        setTimeout(() => { brancherReferences(v || {}, '#f-ech', '#f-refnom'); el('#f-ech') && el('#f-ech').focus(); }, 700);
      }
    } else if (etat.outil === 'longueur') {
      if (!etat.echelle) return toast('Donnez d\'abord une échelle (📐)', 'err');
      etat.pts.push(w); majFormes(); majBandeau();
    }
  };

  /* menu : renommer, supprimer, lister les cotes */
  el('#btn-menu').onclick = () => {
    modale(st.nom, '', `
      <div id="liste-cotes"></div>
      <button class="btn large" id="s-renommer" style="margin-bottom:9px">Renommer / ajouter une note</button>
      <button class="btn large danger" id="s-suppr">Supprimer cette photo</button>`, []);
    majListe();
    el('#s-renommer').onclick = () => {
      fermerModale();
      modale('Renommer', '', `<div class="champ"><label>Nom</label><input id="f-n" value="${esc(st.nom)}"></div>
        <div class="champ"><label>Note</label><input id="f-no" value="${esc(st.note || '')}"></div>`, [
        { libelle: 'Annuler', action: fermerModale },
        { libelle: 'Enregistrer', genre: 'principal', action: async () => {
          st.nom = el('#f-n').value.trim() || st.nom; st.note = el('#f-no').value.trim();
          await DB.enregistrer('stations', st); fermerModale(); rendre();
        } }]);
    };
    el('#s-suppr').onclick = async () => {
      fermerModale();
      if (await confirmer('Supprimer cette photo ?', esc(st.nom), 'Supprimer')) {
        await DB.supprimerStation(st.id);
        aller('visite', { stationId: null, onglet: 'stations' }, false);
      }
    };
  };
  function majListe() {
    const z = el('#liste-cotes'); if (!z) return;
    z.innerHTML = st.mesuresPhoto.length ? `<p class="carte-titre">Cotes de cette photo</p>` + st.mesuresPhoto.map((m) => `
      <div class="item" style="gap:10px"><div class="corps-item"><div class="nom">${esc(m.nom)}</div>
      <div class="meta num">${C.formaterM(valeur(m.pts, m.echelle))}</div></div>
      <button class="btn danger" data-md="${m.id}" aria-label="Supprimer">🗑</button></div>`).join('') : '';
    for (const b of z.querySelectorAll('[data-md]')) b.onclick = async () => {
      st.mesuresPhoto = st.mesuresPhoto.filter((x) => x.id !== b.dataset.md);
      await DB.enregistrer('stations', st); majListe(); majFormes();
    };
  }

  majOutils(); majFormes(); majBandeau();
  monterMinicarte(st).catch((e) => console.warn('mini-carte', e));
}


/* ============================================================
   VUE : PRISE DE VUE 360° GUIDEE
   ============================================================ */

VUES.prise = async function () {
  const v = await DB.lire('visites', S.visiteId);
  const chantier = await DB.lire('chantiers', S.chantierId);
  const champReg = await DB.reglage('champObjectif', null);
  let mode = await DB.reglage('modePrise', 'rapide');

  app().innerHTML = `
    ${entete('Prise de vue 360°', 'Tournez sur place', true)}
    <div class="corps plein">
      <div class="scene" id="scene">
        <video id="flux" playsinline autoplay muted
               style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
        <div class="couche" id="cibles"></div>
        <div class="bandeau-haut">
          <div class="pastille" style="flex:1">
            <div class="ligne entre"><strong id="compte">0 / 0 photos</strong>
              <span id="etat" style="color:var(--texte-2);font-size:12px"></span></div>
            <div class="jauge" style="margin-top:7px"><div id="jauge" style="width:0%"></div></div>
            <div class="segments" id="choix-mode" style="margin:9px 0 0">
              <button data-mode="rapide">Rapide</button>
              <button data-mode="complet">Complète</button>
              <button data-mode="fin">Fine · +photos</button>
            </div>
          </div>
        </div>
        <div class="consigne" id="consigne"><div class="boite">Préparation de la caméra…</div></div>
        <div class="outils" id="outils">
          <button class="outil" id="b-stop"><span class="ico">✕</span>Abandonner</button>
          <button class="outil" id="b-manuel" style="flex:1.4"><span class="ico">⊕</span>Déclencher</button>
          <button class="outil" id="b-fin"><span class="ico">✓</span>Terminer</button>
        </div>
      </div>
    </div>`;
  brancherRetour();

  const video = el('#flux');
  const consigne = (html) => { const c = el('#consigne'); if (c) c.innerHTML = html ? `<div class="boite">${html}</div>` : ''; };
  let flux = null, cibles = null, orientation = null, actif = true, derniereSaisie = 0;
  let largeurPrise = 0, hauteurPrise = 0, luminanceRef = null;
  /* Chaque prise est gardée (JPEG + orientation du gyroscope + vignette grise)
     et l'assemblage n'a lieu qu'à la fin : il faut toutes les photos pour
     mesurer l'angle de vue réel et recaler chacune sur ses voisines. */
  const prises = [];

  /* 1. CAMERA — vérifiée : un flux noir déclenche un réglage plus sûr */
  try {
    flux = await CAP.demarrerCamera(video, (niveau) => {
      if (niveau > 0) consigne(`Image noire avec le réglage précédent.<br>Essai d'un réglage plus sûr (${niveau + 1}/3)…`);
    });
  } catch (e) {
    consigne(messageErreurCamera(e));
    el('#b-manuel').disabled = true;
    return;
  }

  /* 2. GYROSCOPE — redemandé sur un appui s'il manque (condition iOS) */
  const surOrientation = (ev) => { if (ev.alpha != null) orientation = { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma }; };
  window.addEventListener('deviceorientation', surOrientation, true);
  if (!_mouvementAutorise) {
    const ok = await new Promise((resolve) => {
      const c = el('#consigne');
      c.style.pointerEvents = 'auto';
      c.innerHTML = `<div class="boite"><strong>Encore une autorisation.</strong><br>
        La caméra est ouverte. Il faut maintenant le gyroscope, pour savoir où pointe
        l'objectif à chaque photo.<br><br>
        <button class="btn principal large" id="b-gyro">Activer le gyroscope</button></div>`;
      el('#b-gyro').onclick = function () {
        demanderMouvement().then((r) => { c.style.pointerEvents = 'none'; resolve(r); });
      };
    });
    if (!ok) {
      consigne(`<strong>Gyroscope refusé.</strong><br>Sur iPhone : <strong>Réglages &gt; Apps &gt;
        Safari &gt; Avancé &gt; Accès au mouvement et à l'orientation</strong> doit être activé,
        puis fermez complètement l'application et rouvrez-la.
        <strong>Ne la désinstallez pas</strong> : vos visites seraient effacées.`);
      el('#b-manuel').disabled = true;
      return;
    }
  }
  await new Promise((r) => setTimeout(r, 600));
  if (!orientation) {
    consigne(`<strong>Le gyroscope ne répond pas.</strong><br>Fermez complètement l'application et relancez-la.`);
    el('#b-manuel').disabled = true;
    return;
  }

  /* 3. CIBLES — angle mesuré lors d'une prise précédente, sinon valeur prudente */
  const fovGrille = champReg && champReg.fovH ? champReg.fovH : 52;
  const construireCibles = () => {
    cibles = CAP.grilleCibles(fovGrille, CAP.champVertical(fovGrille, video.videoWidth, video.videoHeight), mode);
  };
  construireCibles();
  const majChoixMode = () => {
    for (const b of document.querySelectorAll('#choix-mode button')) b.classList.toggle('actif', b.dataset.mode === mode);
  };
  majChoixMode();
  for (const b of document.querySelectorAll('#choix-mode button')) {
    b.onclick = async () => {
      if (prises.length) return toast('Choix possible avant la première photo seulement');
      mode = b.dataset.mode; await DB.setReglage('modePrise', mode);
      construireCibles(); majChoixMode();
    };
  }

  consigne(`<strong>Tenez le téléphone vertical, devant vous.</strong><br>
    Faites pivoter <strong>le téléphone sur lui-même</strong> : c'est vous qui tournez autour
    de lui, pas lui autour de vous. Arrivé sur une cible, <strong>arrêtez-vous une
    demi-seconde</strong>.<br>
    <span style="color:var(--accent)">N'oubliez pas la cible du bas</span> — sans le sol, pas de mesure.`);
  setTimeout(() => actif && !prises.length && consigne(''), 7000);

  /* prise d'une photo */
  const prendre = () => {
    const cv = CAP.saisirImage(video, 2400);
    largeurPrise = cv.width; hauteurPrise = cv.height;
    const L = CAP.moyenneLuminance(cv);
    if (luminanceRef == null && L != null) luminanceRef = L;
    const gain = (L == null || L < 0.02 || luminanceRef == null) ? 1 : Math.max(0.6, Math.min(1.7, luminanceRef / L));
    prises.push({
      R: CAP.matriceOrientation(orientation.alpha, orientation.beta, orientation.gamma),
      gain,
      vignette: AL.vignetteGrise(cv),
      // la toile est réutilisée à la prise suivante : toBlob en copie l'image tout de suite
      blob: new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9))
    });
    const choix = el('#choix-mode'); if (choix) choix.style.display = 'none';
    if (navigator.vibrate) { try { navigator.vibrate(28); } catch (e) {} }
  };

  const stabilite = new CAP.Stabilite();
  const boucle = () => {
    if (!actif) return;
    requestAnimationFrame(boucle);
    if (!orientation || !cibles) return;
    const vu = CAP.viseeDepuisOrientation(orientation.alpha, orientation.beta, orientation.gamma);
    const maintenant = performance.now();
    stabilite.ajouter(maintenant, vu.azimut, vu.site);
    const restantes = cibles.filter((c) => !c.fait);
    const faites = cibles.length - restantes.length;
    el('#compte').textContent = `${faites} / ${cibles.length} photos`;
    el('#jauge').style.width = (100 * faites / cibles.length) + '%';

    let proche = null, dMin = 1e9;
    for (const c of restantes) {
      const d = CAP.ecartAngulaire(vu.azimut, vu.site, c.azimut, c.site);
      if (d < dMin) { dMin = d; proche = c; }
    }
    dessinerCibles(el('#cibles'), cibles, vu, { fovH: fovGrille, fovV: CAP.champVertical(fovGrille, video.videoWidth, video.videoHeight) }, proche);

    // le recalage suppose le téléphone en portrait
    const portrait = CAP.rotationEcran() === 0;
    const surCible = proche && dMin < 6;
    const stable = stabilite.stable(maintenant);
    const etat = el('#etat');
    etat.textContent = !portrait ? 'tenez le téléphone vertical'
      : !proche ? 'terminé : appuyez sur ✓'
      : surCible ? (stable ? 'déclenchement' : 'ne bougez plus…')
      : dMin < 20 ? 'presque' : 'cherchez une cible';
    etat.style.color = (!portrait || (surCible && !stable)) ? 'var(--accent)' : '';

    if (portrait && surCible && stable && maintenant - derniereSaisie > 450 && video.videoWidth) {
      prendre(); proche.fait = true; derniereSaisie = maintenant;
    }
  };
  requestAnimationFrame(boucle);

  el('#b-manuel').onclick = () => {
    if (!orientation || !video.videoWidth) return toast('Capteurs pas encore prêts', 'err');
    prendre();
    const vu = CAP.viseeDepuisOrientation(orientation.alpha, orientation.beta, orientation.gamma);
    let proche = null, dMin = 1e9;
    for (const c of cibles.filter((x) => !x.fait)) {
      const d = CAP.ecartAngulaire(vu.azimut, vu.site, c.azimut, c.site);
      if (d < dMin) { dMin = d; proche = c; }
    }
    if (proche && dMin < 25) proche.fait = true;
    toast('Photo ajoutée');
  };

  const arreter = () => {
    actif = false;
    window.removeEventListener('deviceorientation', surOrientation, true);
    if (flux) flux.getTracks().forEach((t) => t.stop());
  };
  const abandonner = async () => {
    if (prises.length &&
        !(await confirmer('Abandonner la prise de vue ?', `${prises.length} photos seront perdues.`, 'Abandonner'))) return;
    arreter();
    revenir();
  };
  el('#b-stop').onclick = abandonner;
  el('#btn-retour').onclick = abandonner;

  /* 4. FIN — mesure de l'angle de vue, recalage, assemblage */
  el('#b-fin').onclick = async () => {
    if (prises.length < 6) return toast('Il faut au moins 6 photos', 'err');
    const nadirFait = cibles.find((c) => c.pole === 'nadir' && c.fait);
    const couverture = cibles.filter((c) => c.fait).length / cibles.length;
    arreter();
    finaliserPrise(v, chantier, await assemblerPrises(prises, largeurPrise, hauteurPrise, champReg), {
      nbPrises: prises.length, couverture, solVisible: !!nadirFait, mode
    });
  };
};

/**
 * Recale puis assemble les prises. Renvoie { blob, alignement } ou { erreur }.
 * Affiche sa propre progression : sur iPhone le traitement prend quelques secondes.
 */
async function assemblerPrises(prises, largeur, hauteur, champReg) {
  modale('Assemblage de la vue 360°', '', `
    <p id="a-etape" style="margin:0 0 10px;font-weight:600">Préparation…</p>
    <div class="jauge"><div id="a-jauge" style="width:0%"></div></div>
    <p style="font-size:12.5px;color:var(--texte-2);margin:12px 0 0">L'application mesure l'angle de vue
    réel de la caméra puis recale chaque photo sur ses voisines. Gardez l'application ouverte.</p>`, []);
  const etape = (texte, f) => {
    const t = el('#a-etape'), j = el('#a-jauge');
    if (t) t.textContent = texte;
    if (j) j.style.width = Math.round(f * 100) + '%';
  };

  let alignement, assembleur;
  try {
    for (const p of prises) p.blob = await p.blob;
    alignement = await AL.traiter(prises, {
      fovDefaut: champReg && champReg.fovH ? champReg.fovH : 52,
      surEtape: (texte, f) => etape(texte, f * 0.8)
    });
    // l'angle mesuré sert aux prises suivantes : cibles mieux réparties
    if (alignement.champFiable) {
      await DB.setReglage('champObjectif', { fovH: alignement.fovH, calibre: true, mesureAuto: true, calibreLe: new Date().toISOString() });
    }

    // fondu si l'appareil le supporte réellement, sinon sélection nette
    const assembler = async (avecFondu, largeurSphere = CAP.LARGEUR_SPHERE) => {
      assembleur = CAP.creerAssembleur(largeurSphere, {
        fovH: alignement.fovH, fovV: CAP.champVertical(alignement.fovH, largeur, hauteur)
      }, avecFondu);
      if (assembleur.erreur) throw new Error(assembleur.erreur);
      for (let i = 0; i < prises.length; i++) {
        const img = await chargerImage(prises[i].blob);
        if (!assembleur.ajouterMatrice(img, alignement.orientations[i], 0, alignement.gains[i])) throw new Error('CONTEXTE_PERDU');
        etape('Assemblage des photos', 0.8 + 0.18 * (i + 1) / prises.length);
      }
      const res = await assembleur.produire(0.92);
      // une sphère trop grande pour le téléphone sort noire : on le détecte
      if (largeurSphere > CAP.LARGEUR_SPHERE) {
        const test = await chargerImage(res);
        if (CAP.estNoire(test)) throw new Error('SPHERE_NOIRE');
      }
      return res;
    };
    etape('Assemblage des photos', 0.8);
    // sélection nette (une seule photo par point : plus de fantômes), en définition fine si le téléphone l'accepte
    let blob;
    try {
      blob = await assembler(false, CAP.LARGEUR_SPHERE_FINE);
      alignement.largeurSphere = CAP.LARGEUR_SPHERE_FINE;
    } catch (e) {
      console.warn('[assemblage] définition fine impossible, repli standard', e);
      if (assembleur) assembleur.liberer();
      alignement.repliDefinition = true;
      blob = await assembler(false);
    }
    alignement.modeAssemblage = assembleur.mode;
    etape('Enregistrement', 0.99);
    assembleur.liberer();
    fermerModale();
    return { blob, alignement };
  } catch (e) {
    if (assembleur) assembleur.liberer();
    console.error(e);
    return { erreur: e };
  }
}

/** Explique précisément pourquoi la caméra ne s'ouvre pas. */
function messageErreurCamera(e) {
  const nom = (e && e.name) || 'Erreur';
  const https = window.isSecureContext !== false;
  const dansClaude = /claude\.ai|claudeusercontent|anthropic/.test(location.hostname) || window.self !== window.top;
  let cause;
  if (dansClaude) {
    cause = `Vous êtes sur l'aperçu de Claude, où la caméra est bloquée. Ouvrez l'application
      depuis votre adresse Netlify, dans Safari, puis installez-la sur l'écran d'accueil.`;
  } else if (!https) {
    cause = `La page n'est pas en HTTPS : les navigateurs y bloquent la caméra.`;
  } else if (nom === 'NotAllowedError') {
    cause = `L'accès à la caméra a été refusé. Sur iPhone : <strong>Réglages &gt; Apps &gt; Safari
      &gt; Caméra</strong> sur « Autoriser », puis fermez complètement l'application et
      rouvrez-la. <strong>Ne la désinstallez pas</strong> : vos visites seraient effacées.`;
  } else if (nom === 'NotReadableError') {
    cause = `La caméra est occupée par une autre application. Fermez-la (appareil photo, visio)
      et réessayez.`;
  } else if (nom === 'NotFoundError' || nom === 'OverconstrainedError') {
    cause = `Aucune caméra arrière compatible trouvée.`;
  } else if (e && e.message === 'FLUX_NOIR') {
    cause = `La caméra s'ouvre mais l'image reste noire, même avec les réglages les plus sûrs.
      Vérifiez que rien ne masque l'objectif, fermez l'appareil photo et toute application de
      visio, puis fermez complètement cette application et rouvrez-la.`;
  } else if (e && e.message === 'CAMERA_INDISPONIBLE') {
    cause = `Ce navigateur ne donne pas accès à la caméra. Sur iPhone, utilisez Safari.`;
  } else {
    cause = `Erreur inattendue.`;
  }
  return `<strong>La caméra ne s'ouvre pas.</strong><br>${cause}
    <div style="margin-top:9px;font-size:11.5px;color:var(--texte-3)">Code : ${esc(nom)}${e && e.message ? ' — ' + esc(e.message) : ''}</div>`;
}

function dessinerCibles(couche, cibles, vu, champ, proche) {
  if (!couche) return;
  const r = couche.getBoundingClientRect();
  const tanH = Math.tan(champ.fovH / 2 * Math.PI / 180);
  const tanV = Math.tan(champ.fovV / 2 * Math.PI / 180);
  const R = vu.R;
  let html = '';

  for (const c of cibles) {
    const az = c.azimut * Math.PI / 180, si = c.site * Math.PI / 180;
    const cs = Math.cos(si);
    // direction terrestre (X est, Y nord, Z haut)
    const e = [cs * Math.sin(az), cs * Math.cos(az), Math.sin(si)];
    // terre -> appareil (transposée de R)
    const d = [
      R[0] * e[0] + R[3] * e[1] + R[6] * e[2],
      R[1] * e[0] + R[4] * e[1] + R[7] * e[2],
      R[2] * e[0] + R[5] * e[1] + R[8] * e[2]
    ];
    const prof = -d[2];
    if (prof <= 0.05) continue;
    const ix = d[0] / prof / tanH, iy = d[1] / prof / tanV;
    if (Math.abs(ix) > 1.6 || Math.abs(iy) > 1.6) continue;
    const x = (ix * 0.5 + 0.5) * r.width;
    const y = (1 - (iy * 0.5 + 0.5)) * r.height;

    const estProche = proche === c;
    const taille = estProche ? 58 : 30;
    const couleur = c.fait ? 'rgba(82,210,115,.9)' : estProche ? 'var(--accent)' : 'rgba(255,255,255,.4)';
    const fond = c.fait ? 'rgba(82,210,115,.18)' : estProche ? 'rgba(255,143,31,.22)' : 'rgba(255,255,255,.06)';
    html += `<div style="position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);
      width:${taille}px;height:${taille}px;border-radius:50%;border:2.5px solid ${couleur};
      background:${fond};display:grid;place-items:center;font-size:12px;color:${couleur};font-weight:700">
      ${c.fait ? '✓' : c.essentiel ? '↓' : ''}</div>`;
  }
  couche.innerHTML = html;
}

function finaliserPrise(v, chantier, resultat, infos) {
  if (resultat.erreur) {
    const e = resultat.erreur;
    return modale('Assemblage impossible',
      `La sphère n'a pas pu être assemblée. Rien n'a été enregistré.`, `
      <div class="note attention">Le plus souvent, le téléphone a manqué de mémoire graphique.
      Fermez les autres applications, fermez complètement celle-ci puis rouvrez-la, et refaites
      la station. Vos autres visites ne sont pas touchées.</div>
      <div class="note" style="font-size:12px">Code : ${esc(e.message || String(e))}</div>`, [
      { libelle: 'Retour', genre: 'principal', action: () => { fermerModale(); revenir(); } }
    ]);
  }
  const { blob, alignement: al } = resultat;
  const url = URL.createObjectURL(blob);
  const hcDefaut = chantier ? (chantier.hcDefaut ?? 1.60) : 1.60;
  const tauxRecale = al.recalees / Math.max(1, al.total - 1);

  modale('Enregistrer la vue 360°',
    `${infos.nbPrises} photos · ${infos.mode === 'fin' ? 'sphère complète, définition fine' : infos.mode === 'complet' ? 'sphère complète' : 'prise rapide, sans ciel'}`, `
    <img src="${url}" style="width:100%;border-radius:10px;margin-bottom:13px;background:#000">
    <div class="note ${tauxRecale >= 0.7 ? 'ok' : 'attention'}">
      ${al.recalees} photo${al.recalees > 1 ? 's' : ''} sur ${al.total - 1} recalée${al.recalees > 1 ? 's' : ''} sur leurs voisines.
      Angle de vue ${al.champFiable ? 'mesuré' : 'retenu'} : <strong class="num">${String(al.fovH).replace('.', ',')}°</strong>.
      ${tauxRecale < 0.7 ? `<br>Peu de repères pour recaler (murs unis, ciel, faible lumière) : ces photos
        restent placées au gyroscope, les raccords peuvent se voir.` : ''}
    </div>
    ${infos.solVisible
      ? `<div class="note ok">Le sol a été photographié : la mesure est possible.</div>`
      : `<div class="note alerte"><strong>Sol non photographié.</strong> Pas de mesure possible sur
         cette station. Pour les prochaines, visez aussi le sol à vos pieds.</div>`}
    <div class="note info">Si des objets proches apparaissent dédoublés : à la prochaine prise, faites
    pivoter le téléphone <strong>sur lui-même</strong>, au même point, plutôt qu'à bout de bras
    autour de vous.</div>
    <div class="champ"><label>Nom de la station *</label>
      <input id="f-nom" placeholder="Terrasse nord, souche, local technique…"></div>
    <div class="champ"><label>Hauteur d'objectif (m)</label>
      <input id="f-hc" type="number" step="0.01" min="0.2" max="4" value="${hcDefaut}">
      <div class="aide">Hauteur où vous teniez le téléphone pendant la prise de vue.</div></div>
    <div class="champ"><label>Note de station</label>
      <input id="f-note" placeholder="Ce que montre cette vue"></div>
    <label style="display:flex;gap:10px;align-items:center;font-size:13.5px;margin-top:4px">
      <input id="f-gps" type="checkbox" checked style="width:20px;height:20px">
      Enregistrer la position GPS (pour la placer sur la carte)</label>`, [
    { libelle: 'Jeter', genre: 'danger', action: () => { fermerModale(); revenir(); } },
    {
      libelle: 'Enregistrer', genre: 'principal', action: async () => {
        const nom = el('#f-nom').value.trim();
        if (!nom) { toast('Nommez la station', 'err'); return; }
        const stations = await DB.parIndex('stations', 'visiteId', v.id);
        let geo = null;
        if (el('#f-gps') && el('#f-gps').checked) {
          toast('Relevé de la position GPS…');
          geo = await C.positionGPS(4500);
        }
        const st = {
          id: DB.uid('st'),
          visiteId: v.id,
          nom,
          ...(geo ? { geo: { lng: geo.lng, lat: geo.lat, precision: Math.round(geo.precision) } } : {}),
          note: el('#f-note').value.trim(),
          pano: blob,
          ...(await CAP.apercusDe(blob).catch(() => ({}))),
          type: 'equirect-complet',
          fovVertical: 180,
          sphereComplete: infos.solVisible,
          mode: infos.mode,
          champMesure: resultat.alignement.fovH,
          assemblage: resultat.alignement.modeAssemblage || null,
          hc: parseFloat(el('#f-hc').value) || hcDefaut,
          horizon: 0,
          calibre: false,
          origine: 'prise',
          couverture: infos.couverture,
          nbPrises: infos.nbPrises,
          ordre: stations.length,
          creeLe: new Date().toISOString()
        };
        await DB.enregistrer('stations', st);
        fermerModale();
        toast('Station enregistrée', 'ok');
        aller('viseur', { stationId: st.id }, false);
      }
    }
  ]);
  setTimeout(() => el('#f-nom') && el('#f-nom').focus(), 150);
}


/* ============================================================
   VUE : CALIBRATION DU CHAMP DE L'OBJECTIF
   ------------------------------------------------------------
   L'assemblage projette chaque photo sur la sphère d'après
   l'orientation du téléphone. Pour savoir quelle portion de
   sphère couvre une photo, il faut connaître l'angle que voit
   l'objectif. Les navigateurs ne le communiquent pas, et il
   varie d'un modèle à l'autre, voire d'un recadrage à l'autre.
   Plutôt que de le supposer, on le mesure : on repère un point
   au centre de l'image, on tourne jusqu'à ce qu'il atteigne le
   bord, et le gyroscope donne l'angle parcouru. Cet angle est
   exactement la moitié du champ horizontal.
   ============================================================ */

VUES.calibrerObjectif = async function () {
  app().innerHTML = `
    ${entete('Calibrer l\'objectif', 'Mesure du champ de vision', true)}
    <div class="corps plein">
      <div class="scene" id="scene">
        <video id="flux" playsinline autoplay muted
               style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000"></video>
        <div class="couche" id="reperes"></div>
        <div class="bandeau-haut">
          <div class="pastille" style="flex:1" id="pas">Préparation de la caméra…</div>
        </div>
        <div class="outils">
          <button class="outil" id="b-annuler"><span class="ico">✕</span>Annuler</button>
          <button class="outil actif" id="b-action" style="flex:2"><span class="ico">⊙</span>Départ</button>
        </div>
      </div>
    </div>`;
  brancherRetour();

  const video = el('#flux');
  let flux = null, orientation = null, depart = null, etape = 0;

  const surOrientation = (ev) => { if (ev.alpha != null) orientation = { alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma }; };
  window.addEventListener('deviceorientation', surOrientation, true);

  const arreter = () => {
    window.removeEventListener('deviceorientation', surOrientation, true);
    if (flux) flux.getTracks().forEach((t) => t.stop());
  };

  try {
    flux = await CAP.demarrerCamera(video);
  } catch (e) {
    el('#pas').innerHTML = messageErreurCamera(e);
    return;
  }

  // repères : trait au centre, trait au bord droit de l'image réelle
  el('#reperes').innerHTML = `
    <div style="position:absolute;left:50%;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--mesure)"></div>
    <div style="position:absolute;left:50%;top:50%;width:54px;height:54px;margin:-27px 0 0 -27px;
                border:2px solid var(--mesure);border-radius:50%"></div>
    <div style="position:absolute;right:0;top:0;bottom:0;width:4px;background:var(--accent)"></div>
    <div style="position:absolute;right:12px;top:50%;transform:translateY(-50%);
                background:rgba(10,11,13,.88);border:1px solid var(--accent);border-radius:6px;
                padding:6px 9px;font-size:11.5px;font-weight:650;writing-mode:vertical-rl">BORD</div>`;

  el('#pas').innerHTML = `<strong>1 / 2 — Choisissez un repère.</strong><br>
    <span style="color:var(--texte-2)">Un angle de mur, un poteau, un panneau, à quelques mètres.
    Placez-le dans le cercle turquoise, téléphone bien vertical, puis Départ.</span>`;

  el('#b-annuler').onclick = () => { arreter(); revenir(); };
  el('#btn-retour').onclick = () => { arreter(); revenir(); };

  el('#b-action').onclick = async () => {
    if (!orientation) return toast('Gyroscope pas encore prêt', 'err');

    if (etape === 0) {
      depart = CAP.viseeDepuisOrientation(orientation.alpha, orientation.beta, orientation.gamma);
      etape = 1;
      el('#b-action').innerHTML = '<span class="ico">✓</span>Valider';
      el('#pas').innerHTML = `<strong>2 / 2 — Tournez sur place.</strong><br>
        <span style="color:var(--texte-2)">Sans avancer ni reculer, pivotez jusqu'à ce que
        ce même repère touche la <span style="color:var(--accent)">barre orange du bord</span>.
        Gardez le téléphone à la même hauteur et bien vertical. Puis Valider.</span>`;
      return;
    }

    const fin = CAP.viseeDepuisOrientation(orientation.alpha, orientation.beta, orientation.gamma);
    const angle = CAP.ecartAngulaire(depart.azimut, depart.site, fin.azimut, fin.site);
    const derive = Math.abs(fin.site - depart.site);
    const fovH = angle * 2;

    if (fovH < 40 || fovH > 130) {
      return modale('Mesure invraisemblable',
        `Champ mesuré : ${fovH.toFixed(0)}°, hors de tout objectif de téléphone (45 à 120°).`, `
        <div class="note attention">Le plus souvent : le repère n'a pas été amené jusqu'au bord,
        ou bien vous vous êtes déplacé au lieu de pivoter sur place.</div>`, [
        { libelle: 'Recommencer', genre: 'principal', action: () => { fermerModale(); etape = 0;
          el('#b-action').innerHTML = '<span class="ico">⊙</span>Départ';
          el('#pas').innerHTML = `<strong>1 / 2 — Choisissez un repère.</strong>`; } }
      ]);
    }

    arreter();
    await DB.setReglage('champObjectif', { fovH, calibre: true, calibreLe: new Date().toISOString() });

    modale('Objectif calibré',
      `Champ horizontal mesuré : <strong class="num">${fovH.toFixed(1).replace('.', ',')}°</strong>`, `
      ${derive > 9 ? `<div class="note attention">Le téléphone a basculé de ${derive.toFixed(0)}° en hauteur
      pendant la rotation, ce qui gonfle un peu la mesure. Si les raccords se chevauchent,
      refaites la calibration en gardant mieux le niveau.</div>` : ''}
      <div class="note ok">C'est enregistré pour cet appareil, une fois pour toutes.
      Le champ vertical s'en déduit automatiquement d'après les proportions de l'image.</div>`, [
      { libelle: 'Terminé', genre: 'principal', action: () => { fermerModale(); aller('prise', {}, false); } }
    ]);
  };
};

/* ============================================================
   VUE : COMPARER DEUX VISITES
   ============================================================ */

VUES.comparer = async function () {
  const c = await DB.lire('chantiers', S.chantierId);
  const visites = await DB.parIndex('visites', 'chantierId', S.chantierId);
  visites.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // stations appariées par nom
  const parNom = new Map();
  for (const v of visites) {
    for (const s of await DB.parIndex('stations', 'visiteId', v.id)) {
      const cle = s.nom.trim().toLowerCase();
      if (!parNom.has(cle)) parNom.set(cle, []);
      parNom.get(cle).push({ station: s, visite: v });
    }
  }
  const comparables = [...parNom.entries()].filter(([, l]) => l.length > 1);

  app().innerHTML = `
    ${entete('Comparer deux visites', c ? c.nom : '', true)}
    <div class="corps">
      ${comparables.length === 0 ? `
        <div class="note info"><strong>Rien à comparer pour l'instant.</strong>
        La comparaison apparie les stations <em>portant le même nom</em> dans des visites différentes.
        Refaites la station « terrasse nord » à votre prochain passage, en gardant exactement ce nom,
        et les deux dates se superposeront ici.</div>
        <div class="vide"><div class="ico">⇄</div><p>Aucune station présente dans deux visites.</p></div>`
        : `<p class="carte-titre">${comparables.length} station${comparables.length > 1 ? 's' : ''} suivie${comparables.length > 1 ? 's' : ''} dans le temps</p>
          ${comparables.map(([cle, liste]) => `
            <button class="item" data-cmp="${esc(cle)}">
              <div class="vignette" ${liste[0].station.pano ? `style="background-image:url(${URL.createObjectURL(liste[0].station.vignette || liste[0].station.pano)})"` : ''}></div>
              <div class="corps-item">
                <div class="nom">${esc(liste[0].station.nom)}</div>
                <div class="meta">${liste.length} dates : ${liste.map((x) => dateFR(x.visite.date)).join(' · ')}</div>
              </div><span class="chev">›</span>
            </button>`).join('')}`}
    </div>`;
  brancherRetour();

  for (const b of document.querySelectorAll('[data-cmp]')) {
    b.onclick = () => {
      const liste = parNom.get(b.dataset.cmp);
      liste.sort((a, b2) => (a.visite.date || '').localeCompare(b2.visite.date || ''));
      ouvrirComparateur(liste);
    };
  }
};

async function ouvrirComparateur(liste) {
  const avant = liste[0], apres = liste[liste.length - 1];

  app().innerHTML = `
    ${entete(avant.station.nom, 'Comparaison ' + dateFR(avant.visite.date) + ' → ' + dateFR(apres.visite.date), true)}
    <div class="corps">
      <div class="note info">Faites glisser la poignée pour passer d'une date à l'autre.
      Les deux vues sont orientées ensemble : glissez dans l'image pour regarder ailleurs.</div>
      <div class="compare" id="cmp">
        <canvas id="cv-avant"></canvas>
        <div class="volet" id="volet"><canvas id="cv-apres"></canvas></div>
        <div class="poignee" id="poignee" style="left:50%"></div>
        <div class="date-etiq" style="left:10px">${dateFR(avant.visite.date)}</div>
        <div class="date-etiq" style="right:10px">${dateFR(apres.visite.date)}</div>
      </div>
      ${liste.length > 2 ? `<div class="champ" style="margin-top:14px"><label>Dates comparées</label>
        <div class="deux-col">
          <select id="sel-a">${liste.map((x, i) => `<option value="${i}" ${i === 0 ? 'selected' : ''}>${dateFR(x.visite.date)}</option>`).join('')}</select>
          <select id="sel-b">${liste.map((x, i) => `<option value="${i}" ${i === liste.length - 1 ? 'selected' : ''}>${dateFR(x.visite.date)}</option>`).join('')}</select>
        </div></div>` : ''}
      <div class="carte" style="margin-top:14px">
        <p class="carte-titre">Ce qui a changé sur cette station</p>
        <div id="diff"></div>
      </div>
    </div>`;
  brancherRetour();

  const vA = new VisionneusePano(el('#cv-avant'));
  const vB = new VisionneusePano(el('#cv-apres'));
  S.visionneuse = vA;
  S.visionneuseB = vB;

  const charger = async (a, b) => {
    vA.horizon = a.station.horizon || 0;
    vB.horizon = b.station.horizon || 0;
    await vA.charger(a.station.pano);
    await vB.charger(b.station.pano);
    vA.redimensionner(); vB.redimensionner();
    await majDiff(a, b);
  };

  // les deux vues regardent toujours dans la même direction
  vA.onChange = () => { if (vB.yaw !== vA.yaw || vB.pitch !== vA.pitch || vB.fov !== vA.fov) { vB.yaw = vA.yaw; vB.pitch = vA.pitch; vB.fov = vA.fov; vB.rendre(); } };
  vB.onChange = () => { if (vA.yaw !== vB.yaw || vA.pitch !== vB.pitch || vA.fov !== vB.fov) { vA.yaw = vB.yaw; vA.pitch = vB.pitch; vA.fov = vB.fov; vA.rendre(); } };

  await charger(avant, apres);

  // poignée de volet
  const zone = el('#cmp'), volet = el('#volet'), poignee = el('#poignee');
  let glisse = false;
  const place = (clientX) => {
    const r = zone.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    volet.style.clipPath = `inset(0 0 0 ${p * 100}%)`;
    poignee.style.left = (p * 100) + '%';
  };
  place(zone.getBoundingClientRect().left + zone.getBoundingClientRect().width / 2);
  poignee.addEventListener('pointerdown', (e) => { glisse = true; poignee.setPointerCapture(e.pointerId); e.stopPropagation(); });
  poignee.addEventListener('pointermove', (e) => { if (glisse) { place(e.clientX); e.stopPropagation(); } });
  poignee.addEventListener('pointerup', () => { glisse = false; });

  if (el('#sel-a')) {
    const relire = async () => {
      const a = liste[parseInt(el('#sel-a').value)], b = liste[parseInt(el('#sel-b').value)];
      await charger(a, b);
      document.querySelectorAll('.date-etiq')[0].textContent = dateFR(a.visite.date);
      document.querySelectorAll('.date-etiq')[1].textContent = dateFR(b.visite.date);
    };
    el('#sel-a').onchange = relire;
    el('#sel-b').onchange = relire;
  }

  new ResizeObserver(() => { vA.redimensionner(); vB.redimensionner(); }).observe(zone);
}

async function majDiff(a, b) {
  const pinsA = await DB.parIndex('pins', 'stationId', a.station.id);
  const pinsB = await DB.parIndex('pins', 'stationId', b.station.id);
  const mesA = await DB.parIndex('mesures', 'stationId', a.station.id);
  const mesB = await DB.parIndex('mesures', 'stationId', b.station.id);

  const titres = (l) => new Set(l.map((p) => (p.titre || p.type).trim().toLowerCase()));
  const tA = titres(pinsA), tB = titres(pinsB);
  const apparues = pinsB.filter((p) => !tA.has((p.titre || p.type).trim().toLowerCase()));
  const levees = pinsA.filter((p) => !tB.has((p.titre || p.type).trim().toLowerCase()));

  const lignes = [];
  if (apparues.length) lignes.push(`<div class="note alerte"><strong>${apparues.length} observation${apparues.length > 1 ? 's' : ''} apparue${apparues.length > 1 ? 's' : ''}</strong><br>${apparues.map((p) => esc(p.titre || p.type)).join(', ')}</div>`);
  if (levees.length) lignes.push(`<div class="note ok"><strong>${levees.length} observation${levees.length > 1 ? 's' : ''} plus présente${levees.length > 1 ? 's' : ''}</strong><br>${levees.map((p) => esc(p.titre || p.type)).join(', ')}</div>`);

  // cotes de même désignation
  for (const m of mesB) {
    const jumelle = mesA.find((x) => (x.libelle || '').trim().toLowerCase() === (m.libelle || '').trim().toLowerCase() && x.type === m.type);
    if (jumelle) {
      const ecart = m.valeur - jumelle.valeur;
      if (Math.abs(ecart) > 0.02) {
        lignes.push(`<div class="note attention"><strong>${esc(m.libelle)}</strong> :
          ${G.formaterLongueur(jumelle.valeur)} → ${G.formaterLongueur(m.valeur)}
          (${ecart > 0 ? '+' : ''}${(ecart * 100).toFixed(0)} cm)</div>`);
      }
    }
  }
  if (!lignes.length) lignes.push(`<div class="note">Aucun écart détecté sur les observations et les cotes saisies. La comparaison visuelle reste la plus parlante.</div>`);
  el('#diff').innerHTML = lignes.join('');
}

/* ============================================================
   VUE : RAPPORT
   ============================================================ */

VUES.rapport = async function () {
  const chantier = await DB.lire('chantiers', S.chantierId);
  let visites = await DB.parIndex('visites', 'chantierId', S.chantierId);
  if (S.visiteId) visites = visites.filter((v) => v.id === S.visiteId);
  visites.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const blocs = [];
  for (const v of visites) {
    const stations = await DB.parIndex('stations', 'visiteId', v.id);
    stations.sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
    const sBlocs = [];
    for (const s of stations) {
      const pins = await DB.parIndex('pins', 'stationId', s.id);
      const mes = await DB.parIndex('mesures', 'stationId', s.id);
      sBlocs.push(`
        <div class="carte">
          <div class="ligne entre" style="margin-bottom:10px">
            <strong style="font-size:15.5px">${esc(s.nom)}</strong>
            ${s.calibre ? '<span class="etiq ok">cotes calées</span>' : '<span class="etiq">cotes non calées</span>'}
          </div>
          ${s.pano ? `<img src="${URL.createObjectURL(s.apercu || s.pano)}" style="width:100%;border-radius:8px;margin-bottom:11px;background:#000">` : ''}
          ${s.note ? `<p style="font-size:13.5px;color:var(--texte-2);margin:0 0 11px">${esc(s.note)}</p>` : ''}
          ${pins.length ? `<p class="carte-titre">Observations</p><ul style="margin:0 0 11px;padding-left:19px;font-size:14px;line-height:1.6">
            ${pins.map((p) => {
              const t = TYPES_OBS.find((x) => x.cle === p.type) || TYPES_OBS.at(-1);
              return `<li><strong>${esc(p.titre || t.nom)}</strong>${p.gravite ? ` — <em>${esc(p.gravite)}</em>` : ''}
                ${p.note ? `<br><span style="color:var(--texte-2)">${esc(p.note)}</span>` : ''}</li>`;
            }).join('')}</ul>` : ''}
          ${mes.length ? `<p class="carte-titre">Cotes relevées</p><table class="tableau">
            ${mes.map((m) => `<tr><td>${esc(m.libelle || libelleTypeMesure(m.type))}</td>
              <td class="val num" style="text-align:right">${m.type === 'surface' ? G.formaterSurface(m.valeur) : G.formaterLongueur(m.valeur)}
              <span style="color:var(--texte-3);font-weight:400;font-size:12px">${m.incertitude ? ' ' + esc(G.formaterIncertitude(m.incertitude)) : ''}</span></td></tr>`).join('')}
          </table>` : ''}
        </div>`);
    }
    const toit = await lireToit(v.id);
    const nomCx = (id) => { const c = toit.complexes.find((x) => x.id === id); return c ? c.nom : '—'; };
    const bToit = (toit.complexes.length || toit.sondages.length) ? `
        <div class="carte"><p class="carte-titre">Complexes de toiture</p>
          ${toit.complexes.map((c) => `<div style="margin-bottom:12px"><strong>${esc(c.nom)}</strong><div style="margin-top:6px">${htmlCoupe(c.couches)}</div></div>`).join('') || '<div class="note">Aucun complexe saisi.</div>'}
          ${toit.sondages.length ? `<p class="carte-titre">Sondages</p><table class="tableau">${toit.sondages.map((so) => `<tr>
            <td><strong>S${so.num}</strong> ${esc(so.titre || '')}<br><span style="font-size:12px;color:var(--texte-3)">${dateFR(so.date)} · ${so.loc && (so.loc.carte || so.loc.plan) ? 'localisé' : 'non localisé'}</span>
              ${so.note ? `<br><span style="font-size:12.5px">${esc(so.note)}</span>` : ''}
              ${so.photo ? `<br><img src="${URL.createObjectURL(so.photo)}" style="width:100%;max-width:340px;border-radius:6px;margin-top:5px">` : ''}</td>
            <td style="text-align:right">${esc(nomCx(so.complexeId))}${so.humide ? '<br><em>isolant humide</em>' : ''}</td></tr>`).join('')}</table>` : ''}
        </div>` : '';
    blocs.push(`
      <div style="margin-bottom:22px">
        <div class="carte" style="border-left:3px solid var(--accent)">
          <strong style="font-size:16px">Visite du ${dateFR(v.date)}</strong>
          ${v.objet ? `<div style="color:var(--texte-2);font-size:14px;margin-top:3px">${esc(v.objet)}</div>` : ''}
          <div style="font-size:13px;color:var(--texte-3);margin-top:7px">
            ${[v.meteo && 'Météo : ' + v.meteo, v.presents && 'Présents : ' + v.presents].filter(Boolean).map(esc).join(' · ')}
          </div>
          ${v.notes ? `<p style="font-size:14px;margin:11px 0 0;line-height:1.55">${esc(v.notes).replace(/\n/g, '<br>')}</p>` : ''}
        </div>
        ${bToit}
        ${sBlocs.join('') || '<div class="note">Aucune vue 360° dans cette visite.</div>'}
      </div>`);
  }

  app().innerHTML = `
    ${entete('Rapport', chantier ? chantier.nom : '', true)}
    <div class="corps">
      <div class="carte">
        <p class="carte-titre">Chantier</p>
        <strong style="font-size:17px">${esc(chantier ? chantier.nom : '')}</strong>
        ${chantier && chantier.nature ? `<div style="color:var(--texte-2);margin-top:3px">${esc(chantier.nature)}</div>` : ''}
        <div style="font-size:13.5px;color:var(--texte-3);margin-top:9px;line-height:1.6">
          ${chantier && chantier.adresse ? esc(chantier.adresse) + '<br>' : ''}
          ${chantier && chantier.client ? 'Maître d\'ouvrage : ' + esc(chantier.client) + '<br>' : ''}
          Rapport établi le ${dateFR(new Date().toISOString())}
        </div>
      </div>
      ${blocs.join('')}
      <div class="note attention"><strong>Portée des cotes.</strong> Elles sont obtenues par
      géométrie sur panoramique 360° (visée au sol depuis une hauteur d'objectif connue), avec
      l'incertitude indiquée pour chacune. Elles valent constat et prédimensionnement, non métré
      contractuel.</div>
    </div>
    <div class="barre-bas">
      <button class="btn" id="b-html">Exporter en HTML</button>
      <button class="btn principal" id="b-imprimer">Imprimer / PDF</button>
    </div>`;
  brancherRetour();

  el('#b-imprimer').onclick = () => {
    try { window.print(); }
    catch (e) { toast('Impression bloquée ici — utilisez l\'export HTML', 'err'); }
  };
  el('#b-html').onclick = async () => {
    const css = await (await fetch('css/app.css?v=16')).text().catch(() => '');
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<title>Rapport — ${esc(chantier ? chantier.nom : 'chantier')}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}
body{display:block;overflow:auto}.corps{padding:20px;max-width:900px;margin:0 auto}</style>
</head><body><div class="corps">${el('.corps').innerHTML.replace(/<div class="barre-bas"[\s\S]*?<\/div>/, '')}</div></body></html>`;
    telecharger(`rapport-${(chantier ? chantier.nom : 'chantier').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.html`, html, 'text/html');
  };
};

/* ============================================================
   REGLAGES
   ============================================================ */

async function vueReglages() {
  const champ = await DB.reglage('champObjectif', { fovH: 66, calibre: false });
  const espace = await DB.espaceDisque();
  const persistant = (navigator.storage && navigator.storage.persisted) ? await navigator.storage.persisted().catch(() => false) : false;

  modale('Réglages', '', `
    <p class="carte-titre">Champ de l'objectif</p>
    <div class="note ${champ.calibre ? 'ok' : 'attention'}">
      ${champ.calibre
        ? `Mesuré au gyroscope : <strong class="num">${champ.fovH.toFixed(1).replace('.', ',')}°</strong>
           à l'horizontale${champ.calibreLe ? ', le ' + dateFR(champ.calibreLe) : ''}.`
        : `Non mesuré : l'application suppose ${champ.fovH}°, valeur courante mais approximative.
           Une mesure réelle fait tomber les raccords juste.`}
    </div>
    <button class="btn large" id="r-calibrer" style="margin-bottom:12px">
      ${champ.calibre ? 'Refaire la mesure' : 'Mesurer le champ de l\'objectif'}</button>
    <div class="champ"><label>Ou saisir à la main (°)</label>
      <input id="r-h" type="number" min="40" max="130" step="0.5" value="${champ.fovH}">
      <div class="aide">Si les raccords se chevauchent, diminuez ; s'ils s'écartent, augmentez.
      Le champ vertical se déduit tout seul des proportions de l'image.</div></div>

    <p class="carte-titre" style="margin-top:18px">Sauvegardes</p>
    <button class="btn large" id="r-importer" style="margin-bottom:12px">Importer une sauvegarde de chantier</button>

    <p class="carte-titre" style="margin-top:18px">Stockage</p>
    <div class="note ${persistant ? 'ok' : 'attention'}">
      ${espace ? `${(espace.utilise / 1048576).toFixed(0)} Mo utilisés.<br>` : ''}
      ${persistant
        ? 'Les données sont marquées persistantes : le navigateur ne les purgera pas.'
        : 'Les données ne sont <strong>pas</strong> marquées persistantes. Un navigateur peut les effacer s\'il manque de place. Exportez régulièrement vos chantiers.'}
    </div>
    ${!persistant ? `<button class="btn large" id="r-persist" style="margin-bottom:9px">Demander la persistance</button>` : ''}

    <p class="carte-titre" style="margin-top:18px">Diagnostic caméra</p>
    <button class="btn large" id="r-test" style="margin-bottom:9px">Tester la caméra</button>
    <div id="r-resultat"></div>

    <p class="carte-titre" style="margin-top:18px">Environnement — version ${VERSION}</p>
    <div class="note">
      Adresse : <strong>${esc(location.host || 'fichier local')}</strong><br>
      Connexion sécurisée (HTTPS) : <strong>${location.protocol === 'https:' ? 'oui' : 'NON'}</strong><br>
      Installée sur l'écran d'accueil : <strong>${(navigator.standalone || matchMedia('(display-mode: standalone)').matches) ? 'oui' : 'non'}</strong><br>
      Caméra : <strong>${CAPACITES.camera ? 'disponible' : 'indisponible'}</strong><br>
      Gyroscope : <strong>${CAPACITES.mouvement ? 'disponible' : 'indisponible'}</strong><br>
      Mode hors-ligne : <strong>${CAPACITES.serviceWorker ? 'disponible' : 'indisponible'}</strong><br>
      Téléchargement : <strong>${CAPACITES.telechargement ? 'disponible' : 'bloqué'}</strong>
    </div>`, [
    { libelle: 'Fermer', action: fermerModale },
    {
      libelle: 'Enregistrer', genre: 'principal', action: async () => {
        const saisi = parseFloat(el('#r-h').value) || 66;
        await DB.setReglage('champObjectif', {
          fovH: saisi,
          calibre: champ.calibre && Math.abs(saisi - champ.fovH) < 0.05,
          calibreLe: champ.calibreLe || null
        });
        fermerModale();
        toast('Réglages enregistrés', 'ok');
      }
    }
  ]);
  el('#r-importer').onclick = () => { fermerModale(); importerFichier(); };
  el('#r-test').onclick = async () => {
    const zone = el('#r-resultat');
    zone.innerHTML = `<div class="note">Ouverture de la caméra…</div>
      <video id="v-test" playsinline autoplay muted style="width:100%;border-radius:8px;background:#000;margin-top:6px"></video>`;
    let niveauUtilise = 0;
    try {
      const f = await CAP.demarrerCamera(el('#v-test'), (n) => { niveauUtilise = n; });
      const t = f.getVideoTracks()[0];
      const reg = t.getSettings ? t.getSettings() : {};
      zone.querySelector('.note').outerHTML = `<div class="note ok"><strong>La caméra fonctionne et donne une image.</strong><br>
        ${reg.width || '?'} × ${reg.height || '?'} px · réglage ${niveauUtilise + 1}/3</div>`;
      setTimeout(() => f.getTracks().forEach((x) => x.stop()), 4000);
    } catch (e) {
      zone.innerHTML = `<div class="note alerte">${messageErreurCamera(e)}</div>`;
    }
  };
  el('#r-calibrer').onclick = () => {
    if (!CAPACITES.camera) { toast('Caméra indisponible dans cet environnement', 'err'); return; }
    demanderMouvement().then((ok) => {
      if (!ok) return toast('Accès au mouvement refusé', 'err');
      fermerModale();
      aller('calibrerObjectif', {});
    });
  };
  if (el('#r-persist')) {
    el('#r-persist').onclick = async () => {
      const ok = await DB.demanderPersistance();
      toast(ok ? 'Persistance accordée' : 'Persistance refusée par le navigateur', ok ? 'ok' : 'err');
    };
  }
}

/* ============================================================
   EXPORT / IMPORT
   ============================================================ */

async function exporterChantier(chantier) {
  modale('Exporter le chantier', `<strong>${esc(chantier.nom)}</strong>`, `
    <div class="note info">La sauvegarde complète contient les panoramiques : le fichier est
    lourd (plusieurs dizaines de Mo) mais se réimporte à l'identique, sur un autre téléphone
    ou après réinstallation. La version allégée ne garde que les données, observations et cotes.</div>
    <button class="btn large principal" id="e-complet" style="margin-bottom:9px">Sauvegarde complète (avec images)</button>
    <button class="btn large" id="e-leger">Données seules (léger)</button>`, [
    { libelle: 'Annuler', action: fermerModale }
  ]);

  const faire = async (avecImages) => {
    fermerModale();
    toast('Préparation de l\'export…');
    const paquet = await DB.exporterChantier(chantier.id, avecImages);
    if (!paquet) return toast('Export impossible', 'err');
    const nom = chantier.nom.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    telecharger(`${nom}-${dateInput()}${avecImages ? '-complet' : '-donnees'}.json`,
      JSON.stringify(paquet), 'application/json');
    if (CAPACITES.telechargement) toast('Export terminé', 'ok');
  };
  el('#e-complet').onclick = () => faire(true);
  el('#e-leger').onclick = () => faire(false);
}

async function importerFichier() {
  const f = await choisirFichier({ accept: 'application/json,.json' });
  if (!f) return;
  toast('Lecture du fichier…');
  try {
    const paquet = JSON.parse(await f.text());
    const id = await DB.importerChantier(paquet);
    toast('Chantier importé', 'ok');
    aller('chantier', { chantierId: id, onglet: 'visites' });
  } catch (e) {
    console.error(e);
    modale('Import impossible', '', `<div class="note alerte">${esc(e.message || 'Fichier illisible')}</div>
      <div class="note">Attendu : un fichier JSON produit par l'export de cette application.</div>`, [
      { libelle: 'Fermer', action: fermerModale }
    ]);
  }
}

/* ============================================================
   DEMARRAGE
   ============================================================ */

/* ============================================================
   MISE A JOUR SANS DESINSTALLER
   ------------------------------------------------------------
   Sur iPhone, une app web rouverte depuis l'écran d'accueil est
   souvent reprise telle qu'elle était en mémoire, sans être
   rechargée : la nouvelle version déposée sur Netlify n'arrive
   alors qu'au prochain vrai démarrage. On interroge donc
   version.json à chaque retour au premier plan, et on propose la
   mise à jour d'un appui.
   La mise à jour ne touche jamais aux données : chantiers, visites
   et vues 360° restent dans la base locale du téléphone.
   On ne recharge jamais de soi-même pendant une prise de vue.
   ============================================================ */

const VUES_A_NE_PAS_INTERROMPRE = ['prise', 'calibrerObjectif'];

async function verifierMiseAJour() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = await r.json();
    if (version && String(version) !== VERSION) afficherBandeauMiseAJour(String(version));
  } catch (e) { /* hors réseau : on réessaiera au prochain retour */ }
}

function afficherBandeauMiseAJour(version) {
  if (el('#bandeau-maj')) return;
  const b = document.createElement('div');
  b.id = 'bandeau-maj';
  b.style.cssText = `position:fixed;left:10px;right:10px;top:calc(env(safe-area-inset-top,0px) + 8px);
    z-index:90;display:flex;align-items:center;gap:10px;padding:10px 10px 10px 14px;
    background:var(--surface-2);border:1.5px solid var(--accent);border-radius:12px;
    box-shadow:var(--ombre);font-size:14px;font-weight:600`;
  b.innerHTML = `<span style="flex:1">Nouvelle version ${esc(version)} disponible.
      <span style="display:block;font-weight:400;font-size:12px;color:var(--texte-2)">Vos visites sont conservées.</span></span>
    <button class="btn principal petit" id="b-maj">Mettre à jour</button>
    <button class="btn plat petit" id="b-maj-plus-tard" aria-label="Plus tard" style="padding:0 8px">✕</button>`;
  document.body.appendChild(b);
  el('#b-maj').onclick = async () => {
    if (VUES_A_NE_PAS_INTERROMPRE.includes(S.vue)) {
      return toast('Terminez d\'abord la prise de vue en cours', 'err');
    }
    el('#b-maj').disabled = true;
    el('#b-maj').textContent = 'Mise à jour…';
    try {
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    } catch (e) {}
    location.reload();
  };
  el('#b-maj-plus-tard').onclick = () => b.remove();
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast('Erreur : ' + ((e.reason && e.reason.message) || e.reason), 'err');
});
window.addEventListener('error', (e) => {
  if (e.message) toast('Erreur : ' + e.message, 'err');
});

async function demarrer() {
  // empêche le zoom involontaire à deux doigts hors de la visionneuse
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  if (CAPACITES.serviceWorker) {
    try {
      const avaitControleur = !!navigator.serviceWorker.controller;
      let recharge = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // une nouvelle version vient de s'installer : on recharge une fois pour l'utiliser,
        // sauf en pleine prise de vue, où l'on se contente de la proposer
        if (!avaitControleur || recharge) return;
        if (VUES_A_NE_PAS_INTERROMPRE.includes(S.vue) || el('.voile')) {
          afficherBandeauMiseAJour('nouvelle');
          return;
        }
        recharge = true;
        location.reload();
      });
      const reg = await navigator.serviceWorker.register('sw.js?v=' + VERSION);
      reg.update().catch(() => {});
    } catch (e) { /* hors ligne non disponible */ }
  }
  try { await DB.demanderPersistance(); } catch (e) {}

  window.addEventListener('resize', () => {
    if (S.visionneuse) S.visionneuse.redimensionner();
  });

  // retour au premier plan (app reprise depuis l'écran d'accueil) ou retour du réseau
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') verifierMiseAJour();
  });
  window.addEventListener('online', verifierMiseAJour);
  window.addEventListener('pageshow', (e) => { if (e.persisted) verifierMiseAJour(); });
  verifierMiseAJour();
  window.addEventListener('orientationchange', () => {
    setTimeout(() => { if (S.visionneuse) S.visionneuse.redimensionner(); }, 220);
  });

  await rendre();
}

demarrer();

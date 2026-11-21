/* ============================================================
   db.js — Couche de stockage local (IndexedDB)
   Visite Chantier 360
   Structure : chantier -> visite (datée) -> station (pano 360)
               station -> pins (observations) / mesures / liens
   ============================================================ */

const DB_NAME = 'visite360';
const DB_VERSION = 1;

const STORES = {
  chantiers: { keyPath: 'id', indexes: [] },
  visites:   { keyPath: 'id', indexes: [['chantierId', 'chantierId']] },
  stations:  { keyPath: 'id', indexes: [['visiteId', 'visiteId']] },
  pins:      { keyPath: 'id', indexes: [['stationId', 'stationId']] },
  mesures:   { keyPath: 'id', indexes: [['stationId', 'stationId']] },
  liens:     { keyPath: 'id', indexes: [['fromId', 'fromId']] },
  plans:     { keyPath: 'id', indexes: [['visiteId', 'visiteId']] },
  reglages:  { keyPath: 'cle', indexes: [] }
};

let _db = null;
let _indisponible = false;

export function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export function stockageIndisponible() {
  return _indisponible;
}

function ouvrir() {
  if (_db) return Promise.resolve(_db);
  if (_indisponible) return Promise.reject(new Error('stockage indisponible'));

  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      _indisponible = true;
      return reject(e);
    }

    req.onupgradeneeded = (ev) => {
      const db = req.result;
      for (const [nom, def] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(nom)) {
          const store = db.createObjectStore(nom, { keyPath: def.keyPath });
          for (const [idxNom, idxCle] of def.indexes) {
            store.createIndex(idxNom, idxCle, { unique: false });
          }
        }
      }
    };

    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => { _indisponible = true; reject(req.error); };
    req.onblocked = () => { _indisponible = true; reject(new Error('base bloquée')); };
  });
}

function tx(nomStore, mode = 'readonly') {
  return ouvrir().then((db) => db.transaction(nomStore, mode).objectStore(nomStore));
}

function prom(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- opérations génériques ---------- */

export async function enregistrer(store, objet) {
  try {
    const s = await tx(store, 'readwrite');
    await prom(s.put(objet));
    return objet;
  } catch (e) {
    console.warn('[db] écriture impossible', store, e);
    throw new Error("Enregistrement impossible (" + store + ") : " + (e.message || e));
  }
}

export async function lire(store, id) {
  try {
    const s = await tx(store);
    return await prom(s.get(id));
  } catch (e) { return null; }
}

export async function tout(store) {
  try {
    const s = await tx(store);
    return (await prom(s.getAll())) || [];
  } catch (e) { return []; }
}

export async function parIndex(store, index, valeur) {
  try {
    const s = await tx(store);
    return (await prom(s.index(index).getAll(valeur))) || [];
  } catch (e) { return []; }
}

export async function supprimer(store, id) {
  try {
    const s = await tx(store, 'readwrite');
    await prom(s.delete(id));
    return true;
  } catch (e) { return false; }
}

/* ---------- réglages ---------- */

export async function reglage(cle, valeurDefaut = null) {
  const r = await lire('reglages', cle);
  return r ? r.valeur : valeurDefaut;
}

export async function setReglage(cle, valeur) {
  return enregistrer('reglages', { cle, valeur });
}

/* ---------- suppressions en cascade ---------- */

export async function supprimerStation(stationId) {
  for (const p of await parIndex('pins', 'stationId', stationId)) await supprimer('pins', p.id);
  for (const m of await parIndex('mesures', 'stationId', stationId)) await supprimer('mesures', m.id);
  const liens = await tout('liens');
  for (const l of liens) {
    if (l.fromId === stationId || l.toId === stationId) await supprimer('liens', l.id);
  }
  await supprimer('stations', stationId);
}

export async function supprimerVisite(visiteId) {
  for (const s of await parIndex('stations', 'visiteId', visiteId)) await supprimerStation(s.id);
  for (const p of await parIndex('plans', 'visiteId', visiteId)) await supprimer('plans', p.id);
  await supprimer('visites', visiteId);
}

export async function supprimerChantier(chantierId) {
  for (const v of await parIndex('visites', 'chantierId', chantierId)) await supprimerVisite(v.id);
  await supprimer('chantiers', chantierId);
}

/* ---------- statistiques ---------- */

export async function statsVisite(visiteId) {
  const stations = await parIndex('stations', 'visiteId', visiteId);
  let nbPins = 0, nbMesures = 0;
  for (const s of stations) {
    nbPins += (await parIndex('pins', 'stationId', s.id)).length;
    nbMesures += (await parIndex('mesures', 'stationId', s.id)).length;
  }
  return { nbStations: stations.length, nbPins, nbMesures };
}

/* ---------- export / import JSON ---------- */

function blobVersDataURL(blob) {
  return new Promise((resolve) => {
    if (!blob) return resolve(null);
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}

function dataURLVersBlob(dataURL) {
  if (!dataURL || typeof dataURL !== 'string') return null;
  try {
    const [entete, donnees] = dataURL.split(',');
    const mime = (entete.match(/:(.*?);/) || [, 'image/jpeg'])[1];
    const bin = atob(donnees);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  } catch (e) { return null; }
}

/**
 * Export complet d'un chantier. avecImages=false produit un fichier léger
 * (données, cotes, observations) sans les panoramiques.
 */
export async function exporterChantier(chantierId, avecImages = true) {
  const chantier = await lire('chantiers', chantierId);
  if (!chantier) return null;
  const visites = await parIndex('visites', 'chantierId', chantierId);
  const paquet = { format: 'visite-chantier-360', version: 1, exporteLe: new Date().toISOString(), avecImages, chantier, visites: [] };

  for (const v of visites) {
    const stations = await parIndex('stations', 'visiteId', v.id);
    const plans = await parIndex('plans', 'visiteId', v.id);
    const vOut = { ...v, plans: [], stations: [] };
    for (const p of plans) {
      vOut.plans.push({ ...p, image: avecImages ? await blobVersDataURL(p.image) : null });
    }
    for (const s of stations) {
      const pins = await parIndex('pins', 'stationId', s.id);
      const mesures = await parIndex('mesures', 'stationId', s.id);
      const pinsOut = [];
      for (const pin of pins) {
        pinsOut.push({ ...pin, photo: avecImages ? await blobVersDataURL(pin.photo) : null });
      }
      vOut.stations.push({
        ...s,
        // vignettes et aperçus se régénèrent à partir de la sphère : inutile de les exporter
        vignette: undefined,
        apercu: undefined,
        pano: avecImages ? await blobVersDataURL(s.pano) : null,
        pins: pinsOut,
        mesures
      });
    }
    const toit = await reglage('toit:' + v.id, null);
    if (toit && toit.complexes) {
      vOut.toiture = { ...toit, sondages: [] };
      for (const so of toit.sondages || []) vOut.toiture.sondages.push({ ...so, photo: avecImages && so.photo ? await blobVersDataURL(so.photo) : null });
    }
    paquet.visites.push(vOut);
  }
  return paquet;
}

export async function importerChantier(paquet, nouveauxIds = true) {
  if (!paquet || paquet.format !== 'visite-chantier-360') throw new Error('Fichier non reconnu');
  const mapId = new Map();
  const nid = (ancien, prefix) => {
    if (!nouveauxIds) return ancien;
    if (!mapId.has(ancien)) mapId.set(ancien, uid(prefix));
    return mapId.get(ancien);
  };

  const ch = { ...paquet.chantier, id: nid(paquet.chantier.id, 'ch') };
  await enregistrer('chantiers', ch);

  for (const v of paquet.visites || []) {
    const visite = { ...v, id: nid(v.id, 'vi'), chantierId: ch.id };
    delete visite.stations; delete visite.plans; delete visite.toiture;
    await enregistrer('visites', visite);

    for (const p of v.plans || []) {
      await enregistrer('plans', { ...p, id: nid(p.id, 'pl'), visiteId: visite.id, image: dataURLVersBlob(p.image) });
    }

    for (const s of v.stations || []) {
      const station = { ...s, id: nid(s.id, 'st'), visiteId: visite.id, pano: dataURLVersBlob(s.pano) };
      delete station.pins; delete station.mesures;
      await enregistrer('stations', station);

      for (const pin of s.pins || []) {
        await enregistrer('pins', { ...pin, id: nid(pin.id, 'pn'), stationId: station.id, photo: dataURLVersBlob(pin.photo) });
      }
      for (const m of s.mesures || []) {
        await enregistrer('mesures', { ...m, id: nid(m.id, 'me'), stationId: station.id });
      }
    }
  }

  // complexes de toiture et sondages
  for (const v of paquet.visites || []) {
    if (!v.toiture) continue;
    const t = { ...v.toiture, sondages: (v.toiture.sondages || []).map((so) => {
      const o = { ...so, photo: so.photo ? dataURLVersBlob(so.photo) : null };
      if (o.loc && o.loc.stationId) o.loc = { ...o.loc, stationId: mapId.get(o.loc.stationId) || o.loc.stationId };
      return o;
    }) };
    await setReglage('toit:' + nid(v.id, 'vi'), t);
  }

  // liens entre stations (réécrits avec les nouveaux identifiants)
  for (const v of paquet.visites || []) {
    for (const s of v.stations || []) {
      for (const l of s.liens || []) {
        const from = mapId.get(l.fromId) || l.fromId;
        const to = mapId.get(l.toId) || l.toId;
        await enregistrer('liens', { ...l, id: uid('ln'), fromId: from, toId: to });
      }
    }
  }
  return ch.id;
}

/** Estimation de l'espace occupé / disponible (navigateurs compatibles). */
export async function espaceDisque() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { utilise: e.usage || 0, quota: e.quota || 0 };
    }
  } catch (e) {}
  return null;
}

/** Demande au navigateur de ne pas purger les données (important sur iOS). */
export async function demanderPersistance() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) {}
  return false;
}

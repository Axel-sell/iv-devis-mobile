/* IV Devis — « paquet de données » pour un téléphone ou une tablette (07/10/2026).
   Commun au PC (qui le prépare) et à la version mobile (qui l'importe) : un seul code,
   sur le modèle d'IV Clients.

   Le paquet contient data.json TEL QUEL (clients, devis, factures, catalogue, packs,
   réglages, verrou), chiffré avec un code choisi à l'instant :
   AES-GCM 256 bits, clé tirée du code par PBKDF2-SHA-256 (250 000 tours), sel et IV
   tirés au hasard à chaque paquet. Sans le code, le fichier ne livre rien ; un octet
   modifié et le déchiffrement est refusé (GCM authentifie le contenu).
   Le jeton du site n'y entre jamais : il est retiré avant le chiffrement.

   Numérotation : chaque poste a son code (le PC d'Alex « A », la secrétaire « 2 ») et
   ses numéros portent ce suffixe (DEV-2026-021-2). Un appareil reçoit SON code, proposé
   par le PC qui prépare le paquet (T1, T2…) : sans lui, il répéterait les numéros du PC. */
'use strict';

const PAQUET = (() => {
  const FORMAT = 'iv-devis-paquet';
  const TOURS = 250000;
  const CODE_MIN = 6;
  // codes jamais donnés à un appareil : ceux des postes installés par l'installateur
  // (outils/preparer-poste.js, preparerPublic)
  const RESERVES = ['1', '2'];

  const enB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const deB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  /* ---------- codes de poste ---------- */
  const codeDe = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);

  /* Les codes que ces données montrent déjà pris : celui du poste, ceux donnés aux
     appareils, les suffixes des numéros existants (DEV-2026-021-S → S), les réservés. */
  function postesPris(db) {
    const s = (db && db.settings) || {};
    const pris = new Set(RESERVES);
    if (codeDe(s.poste)) pris.add(codeDe(s.poste));
    for (const c of [].concat(s.postesAppareils || [], s.postesPris || [])) if (codeDe(c)) pris.add(codeDe(c));
    for (const d of (db && db.documents) || []) {
      const m = String(d.number || '').match(/^(?:DEV|FAC)-\d{4}-\d+-([A-Z0-9]{1,3})$/);
      if (m) pris.add(m[1]);
    }
    return pris;
  }

  /* Le code proposé au prochain appareil : T1, T2… le premier libre. */
  function codeAppareilPropose(db) {
    const pris = postesPris(db);
    for (let n = 1; n < 100; n++) if (!pris.has('T' + n)) return 'T' + n;
    return '';
  }

  /* Refus d'un code d'appareil, ou '' s'il convient. `propres` : le code que le paquet
     destine à cet appareil, et celui qu'il porte déjà (remplacement des données). */
  function refusCodeAppareil(code, db, propres) {
    const c = codeDe(code);
    if (!c) return 'Donnez un code à cet appareil (1 à 3 lettres ou chiffres).';
    if (c !== String(code || '').trim().toUpperCase()) return 'Le code ne peut contenir que des lettres et des chiffres (3 au plus).';
    if ([].concat(propres || []).some((p) => codeDe(p) === c)) return '';
    const s = (db && db.settings) || {};
    if (c === codeDe(s.poste)) return `« ${c} » est le code de l'ordinateur qui a préparé ce paquet : les deux produiraient les mêmes numéros.`;
    if (postesPris(db).has(c)) return `« ${c} » est déjà pris par un autre poste : les deux produiraient les mêmes numéros.`;
    return '';
  }

  /* ---------- chiffrement ---------- */
  async function cle(code, sel, tours) {
    const brut = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: sel, iterations: tours, hash: 'SHA-256' },
      brut, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /* db → texte du fichier .ivpaquet ; `appareil` = { code } proposé par le PC. */
  async function chiffrer(db, code, version, appareil) {
    if (String(code || '').length < CODE_MIN) throw new Error(`le code doit compter au moins ${CODE_MIN} caractères`);
    const copie = JSON.parse(JSON.stringify(db));
    if (copie.settings && 'syncRefreshToken' in copie.settings) copie.settings.syncRefreshToken = '';
    const sel = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await cle(String(code), sel, TOURS);
    const contenu = { db: copie, appareil: { code: codeDe(appareil && appareil.code) } };
    const clair = new TextEncoder().encode(JSON.stringify(contenu));
    const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, clair));
    return JSON.stringify({
      format: FORMAT, version: 1, logiciel: version || '', cree: new Date().toISOString(),
      tours: TOURS, sel: enB64(sel), iv: enB64(iv), donnees: enB64(chiffre)
    });
  }

  /* texte du fichier → { db, appareil, cree }. Deux refus distincts, chacun avec sa phrase. */
  async function dechiffrer(texte, code) {
    let p;
    try {
      p = JSON.parse(texte);
      if (!p || p.format !== FORMAT || p.version !== 1 || !p.sel || !p.iv || !p.donnees) throw 0;
      p = { tours: Number(p.tours), sel: deB64(p.sel), iv: deB64(p.iv), donnees: deB64(p.donnees), cree: p.cree };
      if (!(p.tours >= 100000) || p.sel.length !== 16 || p.iv.length !== 12 || p.donnees.length < 17) throw 0;
    } catch (_) {
      throw new Error('Ce fichier n\'est pas un paquet de données IV Devis, ou il est abîmé.');
    }
    let clair;
    try {
      const k = await cle(String(code || ''), p.sel, p.tours);
      clair = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.iv }, k, p.donnees);
    } catch (_) {
      throw new Error('Code incorrect — ou le fichier a été modifié en route. Rien n\'a été changé.');
    }
    const contenu = JSON.parse(new TextDecoder().decode(clair));
    const db = contenu && contenu.db;
    if (!db || !Array.isArray(db.clients) || !Array.isArray(db.documents) || !db.settings) {
      throw new Error('Le paquet ne contient pas de données IV Devis.');
    }
    return { db, appareil: { code: codeDe(contenu.appareil && contenu.appareil.code) }, cree: p.cree };
  }

  return { chiffrer, dechiffrer, postesPris, codeAppareilPropose, refusCodeAppareil, codeDe, CODE_MIN, EXTENSION: '.ivpaquet' };
})();

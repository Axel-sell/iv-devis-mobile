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
  // 12 lettres ou chiffres au moins (2.13.0) : à 6, un code se devinait hors ligne en quelques minutes à quelques
  // heures si le fichier fuyait (il contient tous les clients et documents)
  const CODE_MIN = 12;
  // code proposé : 12 signes parmi 32 (ni I, O, 0, 1, qui se confondent) = 60 bits, hors de portée
  const SIGNES = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  /* Le code tel qu'il chiffre : sans espaces ni tirets, en majuscules (« k7pm 3qxd-r9tw » = « K7PM3QXDR9TW »). */
  const codeCanonique = (c) => String(c || '').toUpperCase().replace(/[\s-]/g, '');

  /* Un code tiré au hasard, affiché par groupes de 4 : K7PM-3QXD-R9TW. */
  function codePropose() {
    const octets = crypto.getRandomValues(new Uint8Array(CODE_MIN));
    const brut = [...octets].map((o) => SIGNES[o % SIGNES.length]).join(''); // 256 = 8 × 32 : aucun biais
    return brut.match(/.{4}/g).join('-');
  }
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
    if (c === codeDe(s.poste)) return `« ${c} » est le code de l'ordinateur de l'agence : les deux produiraient les mêmes numéros.`;
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
    const canon = codeCanonique(code);
    if (canon.length < CODE_MIN) throw new Error(`le code doit compter au moins ${CODE_MIN} lettres ou chiffres`);
    const copie = JSON.parse(JSON.stringify(db));
    // ni jeton du site, ni empreinte du verrou du PC, ni e-mail du compte, ni dossiers du PC : l'appareil choisit
    // son propre verrou (renderer.js, exigerVerrou)
    if (copie.settings) for (const k of ['syncRefreshToken', 'lockHash', 'lock', 'syncEmail', 'cloudBackupDir', 'exportsDir']) delete copie.settings[k];
    const sel = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await cle(canon, sel, TOURS);
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
    // le code tel qu'il chiffre depuis la 2.13.0 (majuscules, sans espaces ni tirets), puis tel que tapé (paquets
    // plus anciens, chiffrés avec le code brut)
    let clair = null;
    const essais = [...new Set([codeCanonique(code), String(code || ''), String(code || '').trim()])];
    for (const essai of essais) {
      try {
        const k = await cle(essai, p.sel, p.tours);
        clair = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.iv }, k, p.donnees);
        break;
      } catch (_) { /* code suivant */ }
    }
    if (!clair) throw new Error('Code incorrect — ou le fichier a été modifié en route. Rien n\'a été changé.');
    const contenu = JSON.parse(new TextDecoder().decode(clair));
    const db = contenu && contenu.db;
    if (!db || !Array.isArray(db.clients) || !Array.isArray(db.documents) || !db.settings) {
      throw new Error('Le paquet ne contient pas de données IV Devis.');
    }
    return { db, appareil: { code: codeDe(contenu.appareil && contenu.appareil.code) }, cree: p.cree };
  }

  return { chiffrer, dechiffrer, postesPris, codeAppareilPropose, refusCodeAppareil, codeDe, codeCanonique, codePropose, CODE_MIN, EXTENSION: '.ivpaquet' };
})();

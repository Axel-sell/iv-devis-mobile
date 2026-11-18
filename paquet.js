/* IV Devis — codes de poste des appareils (07/10/2026), commun au PC et à la version mobile.

   Numérotation : chaque poste a son code (le PC d'Alex « A », la secrétaire « 2 ») et
   ses numéros portent ce suffixe (DEV-2026-021-2). Un téléphone ou une tablette reçoit SON code
   (T1, T2…) à son premier lancement : sans lui, il répéterait les numéros du PC.

   Le nom du fichier vient du « paquet de données » chiffré que le PC préparait pour un appareil
   (2.10.0 à 2.13.x). La 2.14.0 l'a retiré : un appareil se remplit en se connectant au site
   (mobile.js). Seuls restent ici les codes de poste, utilisés par mobile.js (premier lancement)
   et par renderer.js (Paramètres › Numérotation, réglages de l'agence envoyés au site). */
'use strict';

const PAQUET = (() => {
  // codes jamais donnés à un appareil : ceux des postes installés par l'installateur
  // (outils/preparer-poste.js, preparerPublic)
  const RESERVES = ['1', '2'];

  /* Le code tel qu'il s'écrit : lettres et chiffres en majuscules, 3 au plus. */
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

  /* Refus d'un code d'appareil, ou '' s'il convient. `propres` : les codes que cet appareil
     peut garder (celui qu'il porte déjà, quand on le change dans les Paramètres). */
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

  return { postesPris, codeAppareilPropose, refusCodeAppareil, codeDe };
})();

'use strict';
/* Les réglages de l'agence embarqués dans l'installateur (2.8.0) : fiche entreprise, apparence et catalogue
   (prestations et prix, phrases, textes des packs) du PC qui publie — le « poste source ».

   Le fichier embarqué (reglages-initiaux.json, outils/preparer-poste.js) porte reglagesSource :
     { posteSource : le code de poste du PC source à la publication,
       ordinateur  : l'empreinte du nom de ce PC (rien de lisible ne part dans le dépôt public),
       empreinte   : le SHA-256 de la partie partagée, date }.

   Règle (Alex, 04/10/2026) : à chaque nouvelle version, les réglages de l'agence REMPLACENT ceux du poste ; les
   clients, devis, factures, la numérotation, le code de poste, la synchronisation, le verrou et les dossiers du
   poste ne sont jamais touchés ; le PC source n'est jamais écrasé (son code de poste, ou son nom d'ordinateur, est
   celui du fichier). L'empreinte appliquée est notée (settings.reglagesAppliques) : une même version ne
   réapplique rien.

   Téléphones et tablettes (2.11.0, décision d'Alex du 09/10/2026) : le PC source écrit ces mêmes réglages, au
   format du fichier embarqué, sur le site (table catalog, clé CLE_SITE, réservée à l'équipe) — pourLeSite ; la
   version mobile les relit à chaque ouverture et les applique avec ces mêmes fonctions. Elle charge ce fichier tel
   quel dans sa page : sans Node, il n'y calcule aucune empreinte (celle du PC fait foi), il applique. */
(function (racine, fabrique) {
  if (typeof module === 'object' && module.exports) {
    module.exports = fabrique(require('crypto'), require('os'), require('./mise-a-jour.js').canonique);
  } else {
    racine.REGLAGES_AGENCE = fabrique(null, null, null);
  }
})(this, function (crypto, os, canonique) {
  const CLE_SITE = 'ivDevisReglagesAgence';

  const sha256 = (texte) => {
    if (!crypto) throw new Error('empreinte calculée sur le PC seulement');
    return crypto.createHash('sha256').update(String(texte), 'utf8').digest('hex');
  };
  const nomDuPC = () => (os ? os.hostname() : '');
  const codePoste = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  const copie = (v) => JSON.parse(JSON.stringify(v));

  /** La partie partagée : ce que le PC source impose aux autres postes. */
  function partagee(d) {
    const s = (d && d.settings) || {};
    const c = (d && d.catalog) || {};
    return {
      company: s.company || {},
      theme: s.theme || 'clair',
      catalog: { equivalences: c.equivalences || [], services: c.services || [], phrases: c.phrases || [], packTexts: c.packTexts || {} }
    };
  }

  const empreinte = (d) => sha256(canonique(partagee(d)));
  // sans Node (version mobile) : pas d'empreinte d'ordinateur, un appareil n'est jamais le PC source
  const empreinteOrdinateur = (nom = nomDuPC()) => (crypto ? sha256('iv-devis:' + String(nom || '').toUpperCase()).slice(0, 32) : '');

  /** reglagesSource, au moment de préparer le fichier sur le PC source. */
  function source(donnees, nomOrdinateur) {
    return {
      posteSource: codePoste(donnees && donnees.settings && donnees.settings.poste),
      ordinateur: empreinteOrdinateur(nomOrdinateur),
      empreinte: empreinte(donnees),
      date: new Date().toISOString().slice(0, 10)
    };
  }

  /** Ce poste est-il le PC source ? Alors le fichier ne lui est jamais imposé. */
  function estPosteSource(settings, src, nomOrdinateur = nomDuPC()) {
    if (codePoste(settings && settings.poste) === codePoste(src.posteSource)) return true;
    return !!src.ordinateur && src.ordinateur === empreinteOrdinateur(nomOrdinateur);
  }

  const sourceValide = (fichier) => {
    const src = fichier && fichier.reglagesSource;
    return !!src && /^[0-9a-f]{64}$/.test(String(src.empreinte || ''));
  };

  /** Faut-il imposer ce fichier à ce poste ? Non s'il n'y a pas de fichier (ou d'un format ancien, ou sans fiche
      entreprise ni catalogue), sur le PC source, ou si cette empreinte est déjà appliquée. */
  function doitImposer(donnees, fichier, nomOrdinateur = nomDuPC()) {
    if (!sourceValide(fichier)) return false;
    if (!fichier.settings || !fichier.settings.company || typeof fichier.settings.company !== 'object'
      || !fichier.catalog || typeof fichier.catalog !== 'object') return false;
    const s = (donnees && donnees.settings) || {};
    if (estPosteSource(s, fichier.reglagesSource, nomOrdinateur)) return false;
    return s.reglagesAppliques !== fichier.reglagesSource.empreinte;
  }

  /** Impose la partie partagée du fichier à ces données, sur place : fiche entreprise, apparence, catalogue, et note
      l'empreinte. Rien d'autre n'est touché (clients, documents, numérotation, code de poste, synchronisation…). */
  function imposer(d, fichier) {
    const p = copie(partagee(fichier));
    d.settings.company = p.company;
    d.settings.theme = p.theme;
    d.catalog = { ...(d.catalog || {}), ...p.catalog };
    d.settings.reglagesAppliques = fichier.reglagesSource.empreinte;
    return d;
  }

  /** Les données de ce poste avec les réglages de l'agence imposés, ou null s'il n'y a rien à faire. */
  function aImposer(donnees, fichier, nomOrdinateur = nomDuPC()) {
    return doitImposer(donnees, fichier, nomOrdinateur) ? imposer(copie(donnees), fichier) : null;
  }

  // Garde-fou avant toute publication : aucune clé de compte, aucun client, aucun document, aucun code de poste.
  function verifierPublic(r) {
    const fautives = [];
    const parcourir = (v, chemin) => {
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        if (/^(sync|lock)|token|password|motdepasse|secret|jeton|refresh/i.test(k)) fautives.push(chemin + k);
        parcourir(x, chemin + k + '.');
      }
    };
    parcourir(r && r.settings, 'settings.');
    if (fautives.length) throw new Error('réglages publics refusés (compte) : ' + fautives.join(', '));
    if ((r.clients || []).length || (r.documents || []).length) throw new Error('réglages publics refusés : clients ou documents');
    if (codePoste(r.settings.poste)) throw new Error('réglages publics refusés : un code de poste est fixé');
    return true;
  }

  /** Ce que le PC écrit sur le site pour les téléphones et tablettes (2.11.0) : la partie partagée avec son
      reglagesSource, au format du fichier embarqué. null sur un poste qui reçoit lui-même ses réglages d'un autre PC
      (fichier embarqué d'un autre poste source) : le PC source reste la seule source. */
  function pourLeSite(donnees, fichier, nomOrdinateur = nomDuPC()) {
    if (sourceValide(fichier) && !estPosteSource((donnees && donnees.settings) || {}, fichier.reglagesSource, nomOrdinateur)) return null;
    const p = copie(partagee(donnees));
    const r = { reglagesSource: source(donnees, nomOrdinateur), settings: { company: p.company, theme: p.theme }, catalog: p.catalog };
    verifierPublic(r);
    return r;
  }

  return { CLE_SITE, partagee, empreinte, empreinteOrdinateur, source, estPosteSource, doitImposer, imposer, aImposer,
    verifierPublic, pourLeSite, codePoste };
});

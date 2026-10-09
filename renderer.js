/* IV Devis — logique de l'interface */

/* Version téléphone / tablette (2.10.0) : mobile.js remplace le pont Windows (preload.js)
   et se charge avant cette page ; c'est la seule différence, l'interface est la même. */
const MOBILE = !!(window.api && window.api.mobile);

let db = null;
let appInfo = { version: '', updated: '' };
let currentView = 'dashboard';
let editing = null;      // copie de travail du document en cours d'édition
let editingDirty = false; // des modifications non enregistrées existent dans l'éditeur
let editingClient = null;
let listFilters = {
  devis: { search: '', status: '', sort: 'recent' },
  facture: { search: '', status: '', sort: 'recent' },
  clients: { search: '', sort: 'ajout' }
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const main = $('#main');

const STATUSES = {
  devis: [
    ['brouillon', 'Brouillon'],
    ['envoye', 'Envoyé'],
    ['accepte', 'Accepté'],
    ['refuse', 'Refusé']
  ],
  facture: [
    ['brouillon', 'Brouillon'],
    ['envoyee', 'Envoyée'],
    ['payee', 'Payée']
  ]
};

const TRIS_DOC = [
  ['recent', 'Plus récents'],
  ['ancien', 'Plus anciens'],
  ['client', 'Client A → Z'],
  ['montant-desc', 'Montant ↓'],
  ['montant-asc', 'Montant ↑'],
  ['statut', 'Statut']
];

const TRIS_CLIENT = [
  ['ajout', 'Ordre d\'ajout'],
  ['nom', 'Nom A → Z'],
  ['nom-desc', 'Nom Z → A'],
  ['docs', 'Nb de documents']
];

function statusLabel(doc) {
  const list = STATUSES[doc.type] || [];
  const found = list.find(([k]) => k === doc.status);
  return found ? found[1] : doc.status;
}

/* ---------- Statut des devis ----------
   Convertir un devis en facture n'est PAS l'accepter. Jusqu'à la 2.1.0 la
   conversion basculait le devis en « Accepté » toute seule : tous les devis
   finissaient donc acceptés, y compris ceux dont la facture n'était jamais
   sortie du brouillon. Un seul enchaînement change encore un statut sans que
   tu l'aies demandé explicitement : quand TU marques une facture « Envoyée »
   ou « Payée », son devis d'origine passe en « Accepté » — la facture est
   partie chez le client, le devis a donc bien été accepté. Et jamais si tu as
   déjà choisi toi-même le statut de ce devis (statutManuel). */
function repercuterSurDevis(facture) {
  if (!facture || facture.type !== 'facture' || !facture.sourceId) return null;
  if (facture.status !== 'envoyee' && facture.status !== 'payee') return null;
  const devis = db.documents.find((x) => x.id === facture.sourceId && x.type === 'devis');
  if (!devis || devis.statutManuel) return null;
  if (devis.status !== 'envoye' && devis.status !== 'brouillon') return null;
  devis.status = 'accepte';
  return devis.number;
}

/* Rattrapage proposé UNE SEULE FOIS : les devis passés en « Accepté » par
   l'ancienne conversion automatique alors que leur facture est restée un
   brouillon n'ont été acceptés par personne. On propose de les remettre en
   « Envoyé » — c'est toi qui décides, rien n'est corrigé d'office. */
async function corrigerStatutsAutomatiques() {
  if (db.settings.statutsRattrapes) return;
  const suspects = db.documents.filter((d) => {
    if (d.type !== 'devis' || d.status !== 'accepte' || d.statutManuel) return false;
    const liees = db.documents.filter((f) => f.type === 'facture' && f.sourceId === d.id);
    return liees.length > 0 && liees.every((f) => f.status === 'brouillon');
  });
  db.settings.statutsRattrapes = true;
  if (!suspects.length) { await persist(); return; }
  const ok = await window.api.confirmDialog({
    title: 'Statut des devis',
    message: suspects.length + ' devis ont été marqués « Accepté » par le logiciel.',
    detail: "Jusqu'à cette version, convertir un devis en facture le faisait passer en "
      + "« Accepté » tout seul.\n\nCes " + suspects.length + " devis ont une facture encore à "
      + "l'état de brouillon : le client n'a donc rien accepté.\n\nLes remettre en « Envoyé » ? "
      + "Tu pourras toujours en marquer un « Accepté » toi-même.",
    ok: 'Remettre en « Envoyé »',
    cancel: 'Laisser tel quel'
  });
  if (ok) for (const d of suspects) d.status = 'envoye';
  await persist();
  if (ok) {
    if (currentView === 'dashboard') renderDashboard();
    toast('✅ ' + suspects.length + ' devis remis en « Envoyé »');
  }
}

/* ---------- Utilitaires ---------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const nf = new Intl.NumberFormat('fr-FR');
const fmtMoney = (n) => nf.format(Math.round(n || 0)) + ' FCFA';

// Champ de saisie monétaire : insère les espaces de milliers en direct,
// garde le curseur au bon endroit, et renvoie la valeur numérique.
function formatMoneyInput(el) {
  // un montant collé depuis Excel (« 1 234,56 », « 1.234,00 », « 1e6 ») est
  // ramené à sa partie entière au lieu d'être recollé chiffre à chiffre
  const brut = el.value.trim();
  if (/[.,eE]/.test(brut) && /^[\d\s.,eE+-]+$/.test(brut)) {
    const normalise = brut.replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    const n = Number(normalise);
    if (isFinite(n) && n >= 0) {
      const entier = Math.round(n);
      el.value = entier ? nf.format(entier) : '';
      el.setSelectionRange(el.value.length, el.value.length);
      return entier;
    }
  }
  const digits = el.value.replace(/\D/g, '').slice(0, 15);
  const caret = el.selectionStart || 0;
  const digitsBefore = el.value.slice(0, caret).replace(/\D/g, '').length;
  const formatted = digits ? nf.format(Number(digits)) : '';
  el.value = formatted;
  let pos = 0, count = 0;
  while (pos < formatted.length && count < digitsBefore) {
    if (/\d/.test(formatted[pos])) count++;
    pos++;
  }
  el.setSelectionRange(pos, pos);
  return Number(digits) || 0;
}

function fmtDate(iso, lang = 'fr') {
  if (!dateValide(iso)) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(lang === 'en' ? 'en-CA' : 'fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

// Date locale AAAA-MM-JJ : toISOString() donnerait la date UTC, soit la veille
// entre minuit et 1 h à Douala (UTC+1).
function isoLocal(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const todayIso = () => isoLocal(new Date());
const dateValide = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) && !isNaN(new Date(iso + 'T00:00:00').getTime());

// Seule une image encodée par l'application (data:image/…) peut servir de logo :
// une valeur bricolée dans data.json ne peut donc pas s'exécuter dans la page.
const logoSur = (v) => typeof v === 'string' && /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(v);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// « PAUL DONATIEN » → « Paul Donatien » : majuscule initiale sur chaque mot,
// le reste en minuscules (gère les tirets et apostrophes : Jean-Paul, N'Guessan)
// Majuscule à chaque mot — sans jamais défigurer ce que l'utilisateur a voulu :
//  · un nom saisi entièrement en capitales est laissé tel quel (choix délibéré) ;
//  · un sigle isolé (SARL, SA, CNPS, IV) garde ses capitales ;
//  · le reste passe en « Prénom Nom ».
function toTitleCase(s) {
  const t = String(s || '');
  if (!/\p{Ll}/u.test(t) && /\p{Lu}/u.test(t)) return t.trim();   // tout en capitales : on respecte
  return t
    .split(/(\s+|[\-'’.])/)
    .map((mot) => {
      if (!mot || /^(\s+|[\-'’.])$/.test(mot)) return mot;
      if (/^\p{Lu}{2,5}$/u.test(mot)) return mot;                  // sigle : on ne touche pas
      return mot.charAt(0).toUpperCase() + mot.slice(1).toLowerCase();
    })
    .join('');
}

// Empreinte SHA-256 (verrou d'ouverture)
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Empreinte du mot de passe du verrou.
   Une simple empreinte SHA-256 se casse à des centaines de milliers d'essais
   par seconde : on passe par PBKDF2 avec un sel tiré au hasard et 200 000
   tours, ce qui rend l'essai systématique inexploitable. Les anciens verrous
   (empreinte simple) restent acceptés puis sont convertis à la volée. */
const hexDe = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function empreinteMdp(mdp, selHex, tours = 200000) {
  const sel = selHex
    ? Uint8Array.from(selHex.match(/../g).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const cle = await crypto.subtle.importKey('raw', new TextEncoder().encode(mdp), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: sel, iterations: tours, hash: 'SHA-256' }, cle, 256);
  return { algo: 'pbkdf2', sel: hexDe(sel.buffer || sel), tours, cle: hexDe(bits) };
}

// Vérifie un mot de passe contre le verrou enregistré, quel que soit son format.
async function verifierMdp(mdp) {
  const v = db.settings.lock;
  if (v && v.algo === 'pbkdf2') {
    const essai = await empreinteMdp(mdp, v.sel, v.tours);
    return essai.cle === v.cle;
  }
  if (db.settings.lockHash) return (await sha256(mdp)) === db.settings.lockHash; // ancien format
  return false;
}

// Enregistre un nouveau verrou au format salé (et efface l'ancien).
async function poserVerrou(mdp) {
  db.settings.lock = await empreinteMdp(mdp);
  delete db.settings.lockHash;
}

const verrouActif = () => !!(db.settings.lock || db.settings.lockHash);

// Champ mot de passe avec son œil : un clic montre la saisie, un second la masque.
function champMotDePasse(attributs) {
  return `<span class="champ-mdp"><input type="password" ${attributs} /><button type="button" class="oeil" aria-pressed="false" aria-label="Afficher le mot de passe" title="Afficher le mot de passe">${ico('oeil', 18)}</button></span>`;
}
document.addEventListener('click', (e) => {
  const bouton = e.target.closest ? e.target.closest('.champ-mdp .oeil') : null;
  if (!bouton) return;
  const champ = bouton.parentElement.querySelector('input');
  const montre = champ.type === 'password';
  champ.type = montre ? 'text' : 'password';
  const libelle = montre ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
  bouton.setAttribute('aria-pressed', String(montre));
  bouton.setAttribute('aria-label', libelle);
  bouton.title = libelle;
  bouton.innerHTML = ico(montre ? 'oeilBarre' : 'oeil', 18);
  champ.focus();
});

// Petite boîte de saisie maison (window.prompt n'est pas supporté par Electron)
function askText(message, type = 'text') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-title">${esc(message)}</div>
        ${type === 'password' ? champMotDePasse('class="modal-input"') : '<input type="text" class="modal-input" />'}
        <div class="btn-row" style="justify-content:flex-end; margin-top:14px">
          <button type="button" class="btn" data-act="cancel">Annuler</button>
          <button type="button" class="btn primary" data-act="ok">Valider</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.modal-input');
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('[data-act="ok"]').onclick = () => done(input.value);
    overlay.querySelector('[data-act="cancel"]').onclick = () => done(null);
    // On ne ferme que si le clic COMMENCE et FINIT sur le fond : sinon une
    // sélection de texte relâchée hors du champ fermerait la fenêtre.
    let surFond = false;
    overlay.onmousedown = (e) => { surFond = e.target === overlay; };
    overlay.onclick = (e) => { if (e.target === overlay && surFond) done(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    };
    input.focus();
  });
}

// Écran de verrouillage (uniquement si un mot de passe est défini dans Paramètres)
function showLockScreen() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'lock-screen';
    overlay.innerHTML = `
      <div class="lock-box">
        <img src="assets/logo-256.png" alt="" class="lock-logo" />
        <div class="lock-title">IV Devis</div>
        <div class="lock-sub">Entre ton mot de passe pour ouvrir</div>
        ${champMotDePasse('class="modal-input" id="lock-pass"')}
        <div class="lock-err" id="lock-err"></div>
        <button type="button" class="btn primary" id="lock-btn" style="width:100%">Déverrouiller</button>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#lock-pass');
    const tryUnlock = async () => {
      if (await verifierMdp(input.value)) {
        // ancien verrou : on le convertit au format salé à la première ouverture
        if (db.settings.lockHash && !db.settings.lock) { await poserVerrou(input.value); await enregistrer(); }
        overlay.remove();
        resolve();
      } else {
        overlay.querySelector('#lock-err').textContent = 'Mot de passe incorrect';
        input.value = '';
        input.focus();
      }
    };
    overlay.querySelector('#lock-btn').onclick = tryUnlock;
    input.onkeydown = (e) => { if (e.key === 'Enter') tryUnlock(); };
    input.focus();
  });
}

// Écran « Nouveautés » affiché une fois après chaque mise à jour
const CHANGELOG = {
  '2.11.0': [
    'Téléphone et tablette : le catalogue, les prix, les packs, leurs textes, les phrases, la fiche entreprise, le logo et l\'apparence se mettent à jour tout seuls depuis l\'ordinateur, à chaque ouverture et à chaque « Récupérer depuis le site » ; l\'ordinateur reste le seul à les changer, et les devis déjà faits gardent leurs montants'
  ],
  '2.10.1': [
    'Les cases « Déjà obtenu par le client » sont retirées : elles faisaient doublon avec « Client déjà équipé » et avec l\'adaptation automatique des textes des packs'
  ],
  '2.10.0': [
    'Version téléphone et tablette (Android, iPhone, iPad) : la même application, installée depuis le navigateur, qui marche aussi sans internet ; les PDF partent par le menu Partager (WhatsApp, Telegram…)',
    'Paramètres › Données pour un appareil : prépare un fichier chiffré par un code, qui ouvre sur le téléphone ou la tablette tes clients, devis, factures, catalogue et réglages tels qu\'ils sont sur l\'ordinateur',
    'Chaque appareil reçoit son propre code de poste (T1, T2…) : ses devis et factures ne reprennent jamais les numéros de l\'ordinateur'
  ],
  '2.9.1': [
    'Formulaires : quand un libellé passe sur deux lignes, son champ reste aligné avec ceux d\'à côté (Paramètres › Conditions, packs de la facture…)'
  ],
  '2.9.0': [
    'Synchronisation avec le site dans les deux sens : le nouveau bouton « Récupérer depuis le site » (Paramètres) ramène ici les clients, devis et factures créés sur un autre poste ou sur /gestion, avec leur numéro',
    'Avec la synchronisation automatique, IV Devis récupère aussi tout seul, à l\'ouverture puis toutes les 10 minutes',
    'Un document modifié des deux côtés : la version la plus récente gagne, l\'autre est gardée dans l\'historique ; le statut posé sur le site reste prioritaire et une suppression ne passe jamais de l\'autre côté'
  ],
  '2.8.0': [
    'Mises à jour par Internet : à chaque ouverture, IV Devis regarde s\'il existe une nouvelle version et la propose dans une bulle, avec ses nouveautés (« Mettre à jour » ou « Plus tard »), sans interrompre le travail',
    'Paramètres › Mises à jour : la case « Installer les mises à jour automatiquement » (téléchargement pendant le travail, installation à la fermeture) et le bouton « Vérifier maintenant »',
    'Chaque version publiée est signée : IV Devis refuse un fichier dont la signature ou l\'empreinte ne correspond pas, et un téléchargement coupé reprend là où il s\'était arrêté',
    'L\'installation ne fait rien perdre : refusée tant qu\'un document n\'est pas enregistré, elle ne touche pas aux données et rouvre IV Devis ; si elle échoue, IV Devis le dit et propose de réessayer',
    'Installé sur un nouvel ordinateur, IV Devis reprend les réglages de l\'agence (fiche entreprise, logo, catalogue, packs) et se donne un code de poste, modifiable dans Paramètres › Numérotation',
    'À chaque nouvelle version, les réglages de l\'agence remplacent ceux du poste ; les clients, devis, factures et la numérotation du poste ne sont jamais touchés, et le poste d\'où viennent les réglages n\'est jamais écrasé'
  ],
  '2.7.0': [
    'L\'onglet Statistiques est retiré, ainsi que les tuiles « Factures impayées », « Encaissé » et « Taux d\'acceptation » du tableau de bord : les montants encaissés se suivent dans IV Clients',
    'Le tableau de bord garde les devis en attente de réponse, le nombre de clients et les documents récents'
  ],
  '2.6.0': [
    'Un œil dans chaque champ de mot de passe (verrou d\'ouverture, connexion au site) : un clic montre ce que tu tapes, un second le masque',
    'Installateur « poste supplémentaire » : il porte les réglages de l\'agence (fiche entreprise, logo, catalogue, packs, apparence) et les installe au premier lancement sur un poste neuf, sans rien copier à la main'
  ],
  '2.5.0': [
    '« Preuves d\'union » rejoint les cases « Déjà obtenu par le client » : cochée, elle sort des textes des 3 packs et s\'ajoute à la ligne « Déjà réuni de votre côté »',
    '« Client déjà équipé » ne la coche pas : l\'équipement reste le test de langue, l\'équivalence et l\'expérience professionnelle'
  ],
  '2.4.0': [
    'Trois cases « Déjà obtenu par le client » dans le devis et la facture : test de langue, équivalence de diplôme, expérience professionnelle. Cochées, ces prestations sortent des textes des 3 packs, et une ligne « ✔️ Déjà réuni de votre côté » les nomme au client',
    '« Client déjà équipé » coche les trois d\'office',
    'Alerte si le devis facture encore une prestation cochée « déjà obtenue »',
    'Sur la facture, une ligne dit ce que les textes des packs ont retiré et pourquoi ; elle prévient dès qu\'un texte est retouché, avec un bouton pour l\'adapter de nouveau',
    'Sur une facture, cocher une case adapte aussitôt les textes s\'ils n\'ont pas été retouchés ; sinon le logiciel demande avant de remplacer tes retouches'
  ],
  '2.3.1': [
    'Fenêtre « Nouveau client » et boîtes de saisie : copier un texte à la souris ne referme plus la fenêtre par mégarde (quand la sélection se relâchait sur le fond)'
  ],
  '2.3.0': [
    'Numérotation par poste (Paramètres → Numérotation) : donne une lettre au PC de ta secrétaire et ses documents deviennent DEV-2026-021-S — plus aucun risque que deux devis différents portent le même numéro',
    'Les numéros déjà émis ne changent pas, et la suite reste continue d\'un poste à l\'autre',
    'Fiche client allégée : les champs Email et Adresse disparaissent du formulaire, du tableau et de l\'export CSV (ils n\'étaient jamais remplis)'
  ],
  '2.2.0': [
    'Convertir un devis en facture ne le fait plus passer en « Accepté » tout seul : le statut reste celui que tu as choisi',
    'Un devis passe en « Accepté » quand tu marques sa facture « Envoyée » ou « Payée » — la facture est partie, le client a donc accepté',
    'Dès que tu choisis un statut à la main, plus aucune règle automatique n\'y touche',
    'Proposition au démarrage, une seule fois : remettre en « Envoyé » les devis marqués « Accepté » par l\'ancienne conversion et dont la facture est restée un brouillon'
  ],
  '2.1.0': [
    "Politique de securite du contenu : meme si du code etranger arrivait dans la fenetre, il ne pourrait ni se lancer ni envoyer quoi que ce soit dehors",
    "Mot de passe du verrou : empreinte salee a 200 000 tours au lieu d'une simple empreinte (ton ancien mot de passe continue de fonctionner, il est converti a la premiere ouverture)",
    "Les appels vers le site abandonnent au bout de 20 s au lieu de rester bloques, et « Se deconnecter » ferme vraiment la session cote site",
    "Un montant colle depuis Excel (« 1 234,56 ») est repris correctement au lieu d'etre recolle chiffre a chiffre",
    "Numeros de telephone : le 0 initial est retire et les numeros impossibles sont refuses avant l'envoi WhatsApp",
    "Un document passe en anglais signale que les textes des packs et les notes sont encore en francais",
    "Onglet Packs : le filtre de recherche n'est plus efface a chaque case cochee",
    "Logiciel allege : les images inutilisees ne sont plus embarquees dans l'installateur"
  ],
  '2.0.0': [
    '🎨 Interface entièrement redessinée : nouvelle palette, cartes en relief, tableaux plus aérés, menu latéral repensé — clair et sombre revus de fond en comble',
    '📝 Textes des packs adaptés au dossier : une prestation absente n\'est plus citée dans le texte, et ce qui manque à un pack apparaît dans « Vous perdez » (bouton « ↻ Régénérer les textes » sur chaque facture)',
    '👤 Bouton « + Nouveau » sorti de la liste déroulante des clients : il a sa place à côté du champ, dans le devis',
    '🛡️ Tes données protégées : refus d\'enregistrer une base vidée, restauration automatique depuis la dernière sauvegarde si le fichier est illisible, alerte visible si l\'enregistrement échoue, et une seule fenêtre IV Devis à la fois',
    '🔐 Le jeton de connexion au site est désormais chiffré par Windows, hors du fichier de données : il ne part plus dans les sauvegardes ni dans le cloud',
    '🔢 Un numéro de devis ou de facture n\'est plus jamais réattribué, même après une suppression',
    '💰 Échéanciers corrigés : plus aucune tranche négative avec une forte remise, forfait « client déjà équipé » plafonné dans le pack ACCESS',
    '📅 Dates du PDF corrigées : la validité ne recule plus d\'un jour (fuseau de Douala)',
    '💾 Avertissement avant de quitter un document non enregistré, et enregistrement des dernières frappes à la fermeture',
    '🧾 La composition des packs est figée sur une facture émise : renommer une prestation ne change plus son prix',
    '📊 Statistiques calculées sur la date d\'encaissement, plus sur la date de la facture',
    '📤 Export CSV : téléphones intacts dans Excel et formules neutralisées'
  ],
  '1.18.0': [
    'Saisie réparée dans la barre de recherche des devis et des factures : les lettres s\'inscrivaient à l\'envers',
    'Nouvelle barre de recherche dans l\'onglet Clients — nom, personne de contact, téléphone ou email',
    'Tri des listes : devis et factures par date, client, montant ou statut ; clients par ordre d\'ajout, nom ou nombre de documents',
    'Les recherches ignorent les accents (« eric » trouve « Éric »), et un numéro de téléphone se cherche sans les espaces',
    'Un nouveau devis est créé avec le statut « Envoyé » ; si tu le changes, le nouveau statut est gardé aussitôt, sans passer par Enregistrer',
    'Le filtre en cours ne masque plus le document ou le client que tu viens d\'enregistrer',
    'Les filtres des devis et ceux des factures sont désormais indépendants'
  ],
  '1.17.0': [
    'Les nouvelles entrées apparaissent désormais en haut de liste : prestation du catalogue, phrase pré-enregistrée et client',
    'Le curseur se place directement dans la nouvelle ligne, prête à être remplie'
  ],
  '1.16.0': [
    'Mode sombre : Paramètres → Apparence, ton choix est mémorisé',
    'Les PDF envoyés aux clients restent toujours sur fond blanc'
  ],
  '1.15.0': [
    'Barre de titre intégrée : plus de cadre Windows, la fenêtre ne fait plus qu\'un avec le menu',
    'Recherche globale avec Ctrl+K (clients, devis, factures, prestations), plus Ctrl+N, Ctrl+S et Échap',
    'Montants alignés en colonnes, textes gris plus lisibles, repère clavier visible, survols adoucis',
    'Icônes vectorielles à la place des emojis dans les titres de sections'
  ],
  '1.14.0': [
    'Correction automatique des coquilles dans les textes des packs et les phrases : doubles virgules, énumération répétée, espaces en trop',
    'Le nettoyage s\'applique aussi aux textes que tu saisiras à l\'avenir'
  ],
  '1.13.0': [
    'Le catalogue du site est maintenant tenu à jour automatiquement : prestations, prix, composition des packs et textes des packs sont recopiés à chaque synchronisation',
    'Le catalogue du logiciel fait référence — celui du site ne peut plus diverger'
  ],
  '1.12.0': [
    'Sauvegarde complète sur le site : catalogue, textes des packs, phrases, fiche entreprise et logo sont désormais copiés eux aussi (la synchronisation n\'envoyait que les clients et les documents)',
    'Elle part automatiquement une fois par jour, et un bouton permet de retélécharger la dernière sauvegarde',
    'Alerte si une remise dépasse le montant de tes honoraires'
  ],
  '1.11.0': [
    'La remise fonctionne à nouveau sur les factures : elle s\'applique aux packs Premium et Access, s\'impute à 30 % sur la 1re tranche et 70 % sur la 2e',
    'Case « Client déjà équipé » sur le devis : 1re tranche forfaitaire de 200 000 FCFA au lieu de la part d\'honoraires',
    'La section 1 du catalogue s\'appelle désormais EQUIVALENCE ET TEST DE LANGUE'
  ],
  '1.10.0': [
    'Nouvel onglet « Packs » : la liste de ce que contient chaque pack, avec des cases à cocher pour faire basculer une prestation d\'un pack à l\'autre',
    'La date de « dernière mise à jour » se met désormais à jour toute seule'
  ],
  '1.9.2': [
    'Les zones de texte des packs s\'agrandissent toutes seules pour afficher tout le texte — fini le petit cadre à faire défiler',
    'Texte des packs et liste « Inclut » légèrement agrandis pour une lecture plus confortable'
  ],
  '1.8.0': [
    'Création rapide d\'un client depuis un devis : le téléphone se renseigne en même temps que le nom (prêt pour l\'envoi WhatsApp)'
  ],
  '1.7.0': [
    'En-tête des PDF : le site internet s\'affiche sous le nom de l\'entreprise, et l\'email sur sa propre ligne sous les téléphones',
    'Nouveau champ « Site internet » dans les Paramètres'
  ],
  '1.6.1': [
    'Mise en page PDF : vraies marges haut et bas sur chaque page — les packs qui passent sur la page suivante ne se collent plus au bord'
  ],
  '1.6.0': [
    'Dossier des PDF exportés configurable (Paramètres) : place-le dans un dossier MEGA partagé pour retrouver automatiquement les devis et factures générés sur un autre poste'
  ],
  '1.5.0': [
    'Nouvel onglet Statistiques : encaissements des 12 derniers mois, répartition par pack, meilleurs clients',
    'Taux d\'acceptation des devis sur le tableau de bord',
    'Bouton « Dupliquer » sur les devis : repartir d\'un dossier similaire en un clic',
    'Champ de recherche dans le catalogue'
  ],
  '1.4.0': [
    'Verrou d\'ouverture optionnel : protège l\'accès au logiciel par mot de passe (Paramètres)',
    'Export CSV de la liste des clients (onglet Clients)',
    'Cet écran « Nouveautés », affiché une fois après chaque mise à jour'
  ]
};

function showWhatsNew(version) {
  const items = CHANGELOG[version];
  if (!items) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-title">✨ Nouveautés de la version ${esc(version)}</div>
      <ul class="whatsnew-list">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      <div class="btn-row" style="justify-content:flex-end; margin-top:14px">
        <button type="button" class="btn primary" id="wn-ok">Compris</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#wn-ok').onclick = () => overlay.remove();
}

// Boîte de création rapide d'un client depuis un devis : nom + téléphone
function askNewClient() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-title">Nouveau client</div>
        <div class="field" style="margin-bottom:10px">
          <label>Nom *</label>
          <input type="text" class="modal-input" id="nc-name" />
        </div>
        <div class="field">
          <label>Téléphone (pour l'envoi WhatsApp/Telegram)</label>
          <input type="text" class="modal-input" id="nc-phone" placeholder="+237 6XX XX XX XX" />
        </div>
        <div class="btn-row" style="justify-content:flex-end; margin-top:14px">
          <button type="button" class="btn" data-act="cancel">Annuler</button>
          <button type="button" class="btn primary" data-act="ok">Créer le client</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const nom = overlay.querySelector('#nc-name');
    const tel = overlay.querySelector('#nc-phone');
    const done = (val) => { overlay.remove(); resolve(val); };
    const valider = () => {
      if (!nom.value.trim()) { nom.focus(); return; }
      done({ name: nom.value.trim(), phone: tel.value.trim() });
    };
    overlay.querySelector('[data-act="ok"]').onclick = valider;
    overlay.querySelector('[data-act="cancel"]').onclick = () => done(null);
    // On ne ferme que si le clic COMMENCE et FINIT sur le fond : sinon copier
    // un numéro (sélection relâchée hors du champ) fermerait la fenêtre.
    let surFond = false;
    overlay.onmousedown = (e) => { surFond = e.target === overlay; };
    overlay.onclick = (e) => { if (e.target === overlay && surFond) done(null); };
    [nom, tel].forEach((el) => {
      el.onkeydown = (e) => {
        if (e.key === 'Enter') valider();
        if (e.key === 'Escape') done(null);
      };
    });
    nom.focus();
  });
}

// Les zones de texte s'agrandissent d'elles-mêmes pour montrer tout le
// contenu : plus de petite fenêtre à faire défiler à la molette.
function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = (el.scrollHeight + 2) + 'px';
}

function bindAutoGrow(selecteur) {
  $$(selecteur).forEach((el) => {
    autoGrow(el);
    el.addEventListener('input', () => autoGrow(el));
  });
}

function toast(msg, duree = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), duree);
}

// Bandeau d'alerte persistant (enregistrement impossible…) : reste affiché
// tant que le problème n'est pas résolu, contrairement au toast.
function bandeau(message) {
  let b = $('#bandeau');
  if (!message) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('div'); b.id = 'bandeau'; document.body.appendChild(b); }
  b.textContent = message;
}

let enregistrementEnErreur = false;

/* Horodatage des modifications (synchronisation avec le site : le plus récent gagne).
   À chaque enregistrement, chaque client et document est comparé à son empreinte
   connue : ce qui a changé reçoit updatedAt = maintenant. Aucun écran n'a à y penser.
   Les champs de liaison avec le site ne comptent pas comme une modification. */
const CHAMPS_HORS_EMPREINTE = new Set(['updatedAt', 'siteId', 'statutSite', '_new']);
const empreinteLocale = (o) => JSON.stringify(o, (k, v) => (CHAMPS_HORS_EMPREINTE.has(k) ? undefined : v));
let empreintesConnues = null;
function memoriserEmpreinte(genre, o) {
  if (empreintesConnues && o) empreintesConnues.set(genre + ':' + o.id, empreinteLocale(o));
}
function horodaterModifs() {
  if (!db) return;
  const premiere = !empreintesConnues;
  if (premiere) empreintesConnues = new Map();
  const maintenant = new Date().toISOString();
  for (const [genre, liste] of [['c', db.clients || []], ['d', db.documents || []]]) {
    for (const o of liste) {
      const cle = genre + ':' + o.id, e = empreinteLocale(o);
      if (empreintesConnues.get(cle) === e) continue;
      // au premier passage (ouverture) on mémorise sans dater : l'ancien reste « ancien »
      if (!premiere && (empreintesConnues.has(cle) || !o.updatedAt)) o.updatedAt = maintenant;
      empreintesConnues.set(cle, e);
    }
  }
}

// Une suppression ici n'est jamais propagée au site ; on la note pour que la
// récupération ne fasse pas revenir ce qui a été supprimé exprès.
function noterSuppression(genre, o) {
  db.supprimes = db.supprimes || { clients: [], documents: [] };
  db.supprimes[genre] = db.supprimes[genre] || [];
  for (const id of [o.id, o.siteId]) {
    if (id && !db.supprimes[genre].includes(String(id))) db.supprimes[genre].push(String(id));
  }
}

// Écrit data.json et DIT quand ça échoue : un échec silencieux, c'est une
// saisie qui disparaît au prochain démarrage.
async function enregistrer() {
  try { horodaterModifs(); } catch (e) { /* l'horodatage ne bloque jamais l'enregistrement */ }
  let res;
  try {
    res = await window.api.saveData(db);
  } catch (e) {
    res = { ok: false, error: (e && e.message) || String(e) };
  }
  const ok = res === true || (res && res.ok);
  if (ok) {
    if (enregistrementEnErreur) { enregistrementEnErreur = false; bandeau(''); toast('✅ Enregistrement rétabli'); }
    return true;
  }
  const erreur = (res && res.error) || 'erreur inconnue';
  enregistrementEnErreur = true;
  bandeau('⚠️ ENREGISTREMENT IMPOSSIBLE — ' + erreur);
  if (res && res.gardeFou && window.api.alertDialog) {
    await window.api.alertDialog({ message: 'Enregistrement refusé par le garde-fou', detail: erreur + '\n\nFerme et rouvre IV Devis : tes données sur le disque sont intactes. Si le problème persiste, contacte Alex.' });
  }
  return false;
}

async function persist() {
  const ok = await enregistrer();
  if (ok) scheduleAutoPush(); // synchronisation site (silencieuse, seulement si activée)
  return ok;
}

function clientOf(doc) {
  return db.clients.find((c) => c.id === doc.clientId) || null;
}

const ROUND_STEP = 50000; // arrondi commercial : au multiple de 50 000 FCFA supérieur
const round50 = (n) => Math.ceil(n / ROUND_STEP) * ROUND_STEP;

/* ---------- Packs de la facture ---------- */

const PACKS = [
  ['premium', 'PACK PREMIUM'],
  ['access', 'PACK ACCESS'],
  ['standard', 'PACK STANDARD']
];

// identité visuelle des packs : haut de gamme → entrée de gamme
const PACK_META = {
  premium: { symbol: '👑', color: '#BA7517', clair: '#E9A94A', soft: '#FAEEDA' },
  access: { symbol: '✈️', color: '#0C447C', clair: '#7CB8F0', soft: '#E6F1FB' },
  standard: { symbol: '🧳', color: '#0F6E56', clair: '#5FD3AA', soft: '#E1F5EE' }
};

// comparaison tolérante : sans accents ni majuscules, apostrophes unifiées,
// et sans les marques de pluriel « (s) » — « TEST(S) DE LANGUE » = « test de langue »
// ⚠️ DOIT rester STRICTEMENT IDENTIQUE au normDesc de gestion.js (site) :
// toute divergence = deux échéanciers différents pour la même facture.
function normDesc(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`]/g, "'")
    .replace(/\(s\)/g, '')
    .replace(/\s+/g, ' ').trim();
}
function isHonoraires(it) {
  return normDesc(it.desc).includes('honorair');
}
// éléments retirés du pack ACCESS (payés directement par le client)
const ACCESS_EXCLUDE = ['visite medicale', 'residence permanente', 'biometrie'];
// éléments retirés du pack STANDARD (honoraires + frais payés directement par le client)
const STANDARD_EXCLUDE = ['honorair', 'visite medicale', 'residence permanente', 'biometrie'];
function matchAny(it, keywords) {
  const d = normDesc(it.desc);
  return keywords.some((k) => d.includes(k));
}

// Appartenance aux packs : réglable par prestation dans l'onglet « Packs »
// (`item.packs`). Une ligne libre, absente du catalogue, retombe sur les
// règles par mots-clés d'origine.
function packsParDefaut(it) {
  return {
    premium: true,
    access: !matchAny(it, ACCESS_EXCLUDE),
    standard: !matchAny(it, STANDARD_EXCLUDE)
  };
}

function packFlagsFor(it) {
  // une facture émise garde sa propre composition : renommer ou décocher une
  // prestation du catalogue ne doit pas changer le prix d'une facture déjà remise
  if (it.packs && typeof it.packs === 'object') return it.packs;
  const cible = normDesc(it.desc);
  const fiche = [...db.catalog.equivalences, ...db.catalog.services]
    .find((s) => normDesc(s.desc) === cible);
  return (fiche && fiche.packs) ? fiche.packs : packsParDefaut(it);
}

// PREMIUM : tout le devis.
// ACCESS : honoraires à 62,5 %, sans visites médicales / résidences permanentes / biométrie.
// STANDARD : la documentation seule — sans honoraires, ni visites médicales / RP / biométrie.
// Tout nouvel élément non reconnu entre par défaut dans les 3 packs.
function packTotals(doc) {
  const includes = { premium: [], access: [], standard: [] };
  let premium = 0, access = 0, standard = 0;
  for (const it of (doc.items || [])) {
    const qty = Number(it.qty) || 0;
    const amount = qty * (Number(it.unitPrice) || 0);
    const label = it.desc + (qty > 1 ? ` (×${nf.format(qty)})` : '');
    const f = packFlagsFor(it);
    if (f.premium) {
      premium += amount;
      includes.premium.push(label);
    }
    if (f.access) {
      access += isHonoraires(it) ? amount * 0.625 : amount; // −37,5 % sur les honoraires
      includes.access.push(label);
    }
    if (f.standard) {
      standard += amount;
      includes.standard.push(label);
    }
  }
  return {
    premium: round50(premium),
    access: round50(access),
    standard: round50(standard),
    includes
  };
}

/* ---------- Échéancier de paiement ---------- */

// désignations payées à l'ouverture de dossier (étape 1)
const STAGE1_KEYS = ['diplome', 'commission', 'demarcheur', 'wes', 'test de langue', 'preuves professionnelles', 'cours de prepa'];

const PACK_STAGES = {
  premium: [
    { fr: 'Ouverture de dossier et mise dans le bassin', en: 'File opening and entry into the pool' },
    { fr: "Réception de l'invitation et soumission de la demande", en: 'Invitation received and application submitted' },
    { fr: "Réception de l'invitation à la biométrie", en: 'Biometrics invitation received' },
    { fr: 'Obtention du visa', en: 'Visa obtained' }
  ],
  access: [
    { fr: 'Ouverture de dossier', en: 'File opening' },
    { fr: "Réception de l'invitation", en: 'Invitation received' }
  ],
  standard: [
    { fr: 'Ouverture de dossier', en: 'File opening' },
    { fr: "Réception de l'invitation", en: 'Invitation received' }
  ]
};

// Remise et forfait ne concernent que les packs qui portent des honoraires.
const PACKS_AVEC_HONORAIRES = ['premium', 'access'];
const FORFAIT_EQUIPE = 200000; // 1re tranche forfaitaire si le client est déjà équipé

// Remise réellement appliquée à un pack (jamais plus que son prix).
function remisePack(doc, packKey) {
  if (doc.type !== 'facture' || !PACKS_AVEC_HONORAIRES.includes(packKey)) return 0;
  const brut = packTotals(doc)[packKey];
  return Math.min(Math.max(0, Number(doc.discount) || 0), brut);
}

// Prix affiché d'un pack, remise déduite.
function prixPack(doc, packKey) {
  return packTotals(doc)[packKey] - remisePack(doc, packKey);
}

// Montants des étapes de paiement d'un pack. La somme des étapes tombe
// toujours exactement sur le prix affiché du pack (remise comprise).
// PREMIUM : étape 1 = documentation + 37,5 % des honoraires (ou le forfait
//           de 200 000 si le client est déjà équipé) ;
//           étapes 3 et 4 FIXES (150 000 puis 200 000) ;
//           étape 2 = tout le reste (prix − étape 1 − 350 000).
// La remise ampute la 1re tranche de 30 % ; les 70 % restants tombent
// mécaniquement sur la 2e tranche.
function packSchedule(doc, packKey, packPrice) {
  const amt = (it) => (Number(it.qty) || 0) * (Number(it.unitPrice) || 0);
  const dansLePack = (it) => packFlagsFor(it)[packKey];
  let s1 = 0;
  for (const it of (doc.items || [])) {
    if (isHonoraires(it) || !dansLePack(it)) continue;
    if (matchAny(it, STAGE1_KEYS)) s1 += amt(it);
  }
  const hono = (doc.items || []).filter((it) => isHonoraires(it) && dansLePack(it))
    .reduce((s, it) => s + amt(it), 0);
  // forfait « client déjà équipé » : remplace la part d'honoraires de la 1re tranche
  const forfait = (doc.forfaitEquipe && hono > 0 && PACKS_AVEC_HONORAIRES.includes(packKey))
    ? Math.min(FORFAIT_EQUIPE, hono) : 0;
  if (packKey === 'premium') s1 += forfait || hono * 0.375;
  // ACCESS : les honoraires y sont allégés (× 0,625) — le forfait ne peut pas dépasser cette part
  if (packKey === 'access') s1 += (forfait ? Math.min(forfait, hono * 0.625) : hono * 0.625 * 0.4);
  s1 = Math.round(Math.max(0, s1 - 0.3 * remisePack(doc, packKey)));
  // aucune tranche ne peut dépasser le prix du pack ni passer sous zéro
  s1 = Math.min(s1, packPrice);

  if (packKey === 'premium') {
    const s2 = Math.max(0, packPrice - s1 - 350000);
    // garde-fou petits dossiers : si le solde après étapes 1-2 est < 350 000,
    // on le répartit entre les étapes 3 et 4 dans la proportion 150/200
    const rest34 = Math.max(0, packPrice - s1 - s2);
    const s3 = Math.round(rest34 * 150000 / 350000);
    return [s1, s2, s3, rest34 - s3];
  }
  return [s1, Math.max(0, packPrice - s1)];
}

function docTotals(doc) {
  if (doc.type === 'facture') {
    const packs = packTotals(doc);
    const total = prixPack(doc, doc.chosenPack || 'premium') || 0;
    return { subtotal: total, rounded: total, discount: remisePack(doc, doc.chosenPack || 'premium'), total, packs };
  }
  const subtotal = (doc.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);
  const rounded = round50(subtotal);
  const discount = Math.min(Math.max(0, Number(doc.discount) || 0), rounded); // jamais négative
  return { subtotal, rounded, discount, total: rounded - discount };
}

// Un numéro attribué ne l'est jamais une seconde fois, même si le document
// est supprimé : le compteur ne redescend pas (un numéro réutilisé après un
// envoi au client ou au site, c'est deux documents différents sous le même nom).
/* ---------- Code de ce poste ----------
   Deux PC qui travaillent en même temps créent chacun un DEV-2026-021 : deux
   documents différents portant le même numéro, impossibles à démêler ensuite.
   Une lettre propre au poste secondaire les sépare définitivement
   (DEV-2026-021 ici, DEV-2026-021-S chez ta secrétaire). Vide = aucun suffixe,
   exactement comme avant : les numéros déjà émis ne bougent pas. */
const NUMERO_MOTIF = /^(DEV|FAC)-(\d{4})-(\d+)(?:-[A-Z0-9]{1,3})?$/;
const codePoste = () => String((db.settings && db.settings.poste) || '')
  .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
const suffixePoste = () => (codePoste() ? '-' + codePoste() : '');
// numéro suivant sans son suffixe, pour l'aperçu des Paramètres
const baseNumero = (type) => {
  const m = nextNumber(type, todayIso()).match(NUMERO_MOTIF);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

function nextNumber(type, dateIso) {
  const year = (dateIso || todayIso()).slice(0, 4);
  const prefix = type === 'devis' ? 'DEV' : 'FAC';
  db.compteurs = db.compteurs || {};
  const cle = prefix + '-' + year;
  let max = Number(db.compteurs[cle]) || 0;
  for (const d of db.documents) {
    // le suffixe de poste ne rompt pas la suite : 020, 021-S, 022…
    const m = (d.number || '').match(new RegExp(`^${prefix}-${year}-(\\d+)(?:-[A-Z0-9]{1,3})?$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${year}-${String(max + 1).padStart(3, '0')}${suffixePoste()}`;
}

// À appeler quand un document est enregistré : fige son numéro dans le compteur.
function reserverNumero(number) {
  const m = String(number || '').match(NUMERO_MOTIF);
  if (!m) return;
  db.compteurs = db.compteurs || {};
  const cle = m[1] + '-' + m[2];
  db.compteurs[cle] = Math.max(Number(db.compteurs[cle]) || 0, parseInt(m[3], 10));
}

/* ---------- Navigation ---------- */

// Quitter l'éditeur avec des modifications non enregistrées demande confirmation.
async function peutQuitterEditeur() {
  if (!editing || !editingDirty) return true;
  const quitter = await window.api.confirmDialog({
    message: `${editing.number} a des modifications non enregistrées.`,
    detail: 'Quitter sans enregistrer ? Les changements seront perdus.',
    ok: 'Quitter sans enregistrer', cancel: 'Rester'
  });
  return !!quitter;
}

async function setView(view) {
  if (!(await peutQuitterEditeur())) return;
  currentView = view;
  editingClient = null;
  editingDirty = false;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  render();
}

$$('.nav-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// toute saisie dans l'éditeur marque le document comme modifié
main.addEventListener('input', () => { if (editing) editingDirty = true; });
main.addEventListener('change', () => { if (editing) editingDirty = true; });

function render() {
  editing = null;
  const sendbar = $('#sendbar');
  if (sendbar) sendbar.classList.remove('show');
  if (currentView === 'dashboard') renderDashboard();
  else if (currentView === 'devis') renderDocList('devis');
  else if (currentView === 'factures') renderDocList('facture');
  else if (currentView === 'clients') renderClients();
  else if (currentView === 'catalogue') renderCatalogue();
  else if (currentView === 'packs') renderPacks();
  else if (currentView === 'settings') renderSettings();
}

/* ---------- Tableau de bord ---------- */

function renderDashboard() {
  // les montants encaissés et impayés se suivent dans IV Clients
  const devisEnCours = db.documents.filter((d) => d.type === 'devis' && d.status === 'envoye');

  const recent = [...db.documents]
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 8);

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1>Tableau de bord</h1>
        <div class="sub">${esc(db.settings.company.name || 'Renseigne ta fiche entreprise dans Paramètres')}</div>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="new-devis">+ Nouveau devis</button>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="label">Devis en attente de réponse</div>
        <div class="value">${devisEnCours.length}</div>
      </div>
      <div class="stat-card">
        <div class="label">Clients</div>
        <div class="value">${db.clients.length}</div>
      </div>
    </div>
    <div class="panel">
      <h2>Documents récents</h2>
      ${docTable(recent)}
    </div>`;

  $('#new-devis').onclick = () => openEditor(newDoc('devis'));
  bindDocRows();
}

/* ---------- Listes devis / factures ---------- */

const rangStatut = (d) => {
  const i = (STATUSES[d.type] || []).findIndex(([k]) => k === d.status);
  return i < 0 ? 99 : i;
};

function comparerDocs(mode) {
  const recent = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.number || '').localeCompare(a.number || '');
  const nomDe = (d) => { const c = clientOf(d); return c ? normDesc(c.name) : 'zzz'; };
  if (mode === 'ancien') return (a, b) => -recent(a, b);
  if (mode === 'client') return (a, b) => nomDe(a).localeCompare(nomDe(b)) || recent(a, b);
  if (mode === 'montant-desc') return (a, b) => docTotals(b).total - docTotals(a).total || recent(a, b);
  if (mode === 'montant-asc') return (a, b) => docTotals(a).total - docTotals(b).total || recent(a, b);
  if (mode === 'statut') return (a, b) => rangStatut(a) - rangStatut(b) || recent(a, b);
  return recent;
}

function docsFiltres(type) {
  const f = listFilters[type];
  const q = normDesc(f.search);
  return db.documents
    .filter((d) => d.type === type)
    .filter((d) => !f.status || d.status === f.status)
    .filter((d) => {
      if (!q) return true;
      const c = clientOf(d);
      return normDesc(`${d.number} ${c ? c.name : ''}`).includes(q);
    })
    .sort(comparerDocs(f.sort));
}

// Après un enregistrement, on lève le filtre qui masquerait le document :
// sinon il « disparaît » de la liste sans explication.
function assurerVisible(type, id) {
  const f = listFilters[type];
  if ((!f.search && !f.status) || docsFiltres(type).some((d) => d.id === id)) return;
  f.search = '';
  f.status = '';
}

function renderDocList(type) {
  const label = type === 'devis' ? 'Devis' : 'Factures';
  const f = listFilters[type];

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1>${label}</h1>
        ${type === 'facture' ? `<div class="sub">Une facture se crée depuis un devis, avec le bouton « Convertir en facture ».</div>` : ''}
      </div>
      ${type === 'devis' ? `<button class="btn primary" id="new-doc">+ Nouveau devis</button>` : ''}
    </div>
    <div class="filters">
      <input type="search" id="f-search" placeholder="🔍 Rechercher un numéro ou un client…" value="${esc(f.search)}" />
      <select id="f-status">
        <option value="">Tous les statuts</option>
        ${STATUSES[type].map(([k, l]) => `<option value="${k}" ${f.status === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <select id="f-sort">
        ${TRIS_DOC.map(([k, l]) => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>Tri : ${l}</option>`).join('')}
      </select>
      <span class="filters-info" id="f-count"></span>
    </div>
    <div class="panel" id="doc-zone"></div>`;

  // Le tableau seul est redessiné : le champ de recherche n'est jamais détruit,
  // donc le curseur reste où il est pendant la frappe.
  const rafraichir = () => {
    const docs = docsFiltres(type);
    const total = db.documents.filter((d) => d.type === type).length;
    $('#doc-zone').innerHTML = docTable(docs, !!(f.search || f.status));
    $('#f-count').textContent = (f.search || f.status)
      ? `${docs.length} résultat${docs.length > 1 ? 's' : ''} sur ${total}`
      : `${total} ${label.toLowerCase()}`;
    bindDocRows();
  };

  const newDocBtn = $('#new-doc');
  if (newDocBtn) newDocBtn.onclick = () => openEditor(newDoc(type));
  $('#f-search').oninput = (e) => { f.search = e.target.value; rafraichir(); };
  $('#f-status').onchange = (e) => { f.status = e.target.value; rafraichir(); };
  $('#f-sort').onchange = (e) => { f.sort = e.target.value; rafraichir(); };
  rafraichir();
}

function docTable(docs, filtre) {
  if (!docs.length) return `<div class="empty">${filtre ? 'Aucun résultat pour cette recherche.' : 'Aucun document pour le moment.'}</div>`;
  return `<table>
    <thead><tr><th>Numéro</th><th>Type</th><th>Client</th><th>Date</th><th>Statut</th><th class="num">Total</th></tr></thead>
    <tbody>
      ${docs.map((d) => {
        const c = clientOf(d);
        return `<tr class="clickable" data-doc="${d.id}">
          <td><strong>${esc(d.number)}</strong></td>
          <td><span class="badge type-${d.type}">${d.type === 'devis' ? 'Devis' : 'Facture'}</span></td>
          <td>${esc(c ? c.name : '—')}</td>
          <td>${fmtDate(d.date)}</td>
          <td><span class="badge ${esc(d.status)}">${esc(statusLabel(d))}</span></td>
          <td class="num">${fmtMoney(docTotals(d).total)}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function bindDocRows() {
  $$('tr[data-doc]').forEach((tr) => {
    const ouvrir = () => {
      const doc = db.documents.find((d) => d.id === tr.dataset.doc);
      if (doc) openEditor(structuredClone(doc));
    };
    tr.tabIndex = 0;
    tr.onclick = ouvrir;
    tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ouvrir(); } };
  });
}

/* ---------- Éditeur de document ---------- */

function newDoc(type) {
  return {
    id: uid(),
    type,
    number: nextNumber(type, todayIso()),
    date: todayIso(),
    lang: 'fr',
    clientId: '',
    items: [{ desc: '', qty: 1, unitPrice: 0 }],
    discount: 0,
    status: type === 'devis' ? 'envoye' : 'brouillon',
    notes: '',
    sourceId: null,
    createdAt: Date.now(),
    _new: true
  };
}

async function openEditor(doc) {
  if (editing && editing !== doc && !(await peutQuitterEditeur())) return;
  editing = doc;
  editingDirty = !!doc._new && false;
  renderEditor();
}

/* Sections du catalogue : 'eq' = EQUIVALENCE, 'pr' = PROCEDURE */
function catalogItem(src, i) {
  return src === 'eq' ? db.catalog.equivalences[i] : db.catalog.services[i];
}

function pickerGroupRows(list, src, label) {
  if (!list.length) return '';
  return `<tr class="pk-group"><td colspan="5">${label}</td></tr>` + list.map((s, i) => `<tr>
    <td><input type="checkbox" class="pk-check" data-src="${src}" data-i="${i}" id="pk-${src}-${i}" /></td>
    <td><label for="pk-${src}-${i}">${esc(s.desc)}</label></td>
    <td class="num">${fmtMoney(s.unitPrice)}</td>
    <td><input type="number" class="pk-qty" data-src="${src}" data-i="${i}" value="1" min="0" step="1" /></td>
    <td class="num pk-line" data-src="${src}" data-i="${i}">—</td>
  </tr>`).join('');
}

/* ---------- Client déjà équipé : ce que le client a déjà ----------
   Une prestation absente du devis peut manquer pour deux raisons : le dossier
   n'en a pas besoin, ou le client l'a déjà. Seule la seconde se dit au client.
   La case « Client déjà équipé » le dit au logiciel pour ces trois prestations :
   elles sortent des textes des packs (même si une ligne les facture encore) et
   une ligne « Déjà réuni de votre côté » s'ajoute. Les cases « Déjà obtenu par
   le client » (2.4.0 à 2.10.0) sont retirées en 2.10.1, elles faisaient doublon :
   `doc.dejaObtenu`, resté dans les anciennes données, n'a plus d'effet. */
const DEJA_OBTENU = [
  { nom: 'test de langue', cles: ['test de langue', 'cours de prepa'] },
  { nom: 'équivalence de diplôme', cles: ['diplome', 'commission', 'demarcheur', 'wes'] },
  { nom: 'expérience professionnelle', cles: ['preuves professionnelles'] }
];

function dejaObtenuDe(doc) {
  return doc && doc.forfaitEquipe ? DEJA_OBTENU : [];
}

// « a », « a et b », « a, b et c »
function enumerer(liste) {
  if (liste.length < 2) return liste[0] || '';
  return liste.slice(0, -1).join(', ') + ' et ' + liste[liste.length - 1];
}

// La ligne se place sous « ✅ Vous gagnez », sinon avant l'appel « 👉 », sinon à la fin.
function ajouterLigneDejaObtenu(texte, noms) {
  if (!texte || !noms.length) return texte;
  const ligne = '✔️ Déjà réuni de votre côté : ' + enumerer(noms) + '.';
  const lignes = texte.split('\n');
  let i = lignes.findIndex((l) => /✅|vous gagnez/i.test(l));
  if (i < 0) {
    const appel = lignes.findIndex((l) => /👉/.test(l));
    i = appel < 0 ? lignes.length - 1 : appel - 1;
  }
  lignes.splice(i + 1, 0, ligne);
  return lignes.join('\n');
}

// Textes des trois packs, adaptés aux prestations que le document contient.
// `journal` (facultatif) reçoit les mots-clés des mentions retirées.
function textesPacksPour(doc, journal) {
  const inc = packTotals(doc).includes;
  // tout ce que le dossier contient, packs confondus : sert aux propositions
  // « vous perdez », qui citent ce qui existe mais n'est pas dans ce pack-là
  const dossier = (doc.items || []).map((it) => it.desc);
  const deja = dejaObtenuDe(doc);
  const exclus = deja.flatMap((c) => c.cles);
  const out = {};
  for (const [k] of PACKS) {
    const texte = adapterTextePack(db.catalog.packTexts[k] || '', inc[k], dossier, { exclus, journal });
    out[k] = ajouterLigneDejaObtenu(texte, deja.map((c) => c.nom));
  }
  return out;
}

// Rubriques des textes, pour dire en clair ce qui en a été retiré.
const RUBRIQUES_TEXTE = [
  { nom: 'test de langue', cles: ['test de langue'] },
  { nom: 'cours de préparation', cles: ['cours de prepa'] },
  { nom: 'équivalence de diplôme', cles: ['diplome', 'commission', 'demarcheur', 'wes'] },
  { nom: 'expérience professionnelle', cles: ['preuves professionnelles'] },
  { nom: 'preuves de fond', cles: ['preuves de fond'] },
  { nom: "preuves d'union", cles: ["preuves d'union"] },
  { nom: 'CNPS', cles: ['cnps'] },
  { nom: 'certificat de police', cles: ['certificat de police'] },
  { nom: 'visite médicale', cles: ['visite medicale'] },
  { nom: 'biométrie', cles: ['biometrie'] },
  { nom: 'résidence permanente', cles: ['residence permanente'] }
];

// Ce que l'adaptation fait des textes du Catalogue pour ce dossier. Une mention
// retirée parce qu'elle n'appartient pas à un pack (visite médicale hors
// ACCESS…) n'est pas une adaptation au dossier : elle n'est pas comptée.
function resumeAdaptation(doc) {
  const journal = [];
  const genere = textesPacksPour(doc, journal);
  const deja = dejaObtenuDe(doc);
  const exclus = new Set(deja.flatMap((c) => c.cles.map(normDesc)));
  const auDossier = (doc.items || []).map((it) => normDesc(it.desc));
  const absents = new Set();
  for (const cle of journal) {
    const n = normDesc(cle);
    if (exclus.has(n) || auDossier.some((d) => d.includes(n))) continue;
    const rubrique = RUBRIQUES_TEXTE.find((r) => r.cles.includes(cle));
    if (rubrique) absents.add(rubrique.nom);
  }
  return {
    genere,
    deja: deja.map((c) => c.nom),
    absents: RUBRIQUES_TEXTE.map((r) => r.nom).filter((nom) => absents.has(nom))
  };
}

// Lignes encore facturées pour une prestation que le client a déjà.
function facturesMalgreDeja(doc) {
  const lignes = [];
  for (const c of dejaObtenuDe(doc)) {
    for (const it of (doc.items || [])) {
      const montant = (Number(it.qty) || 0) * (Number(it.unitPrice) || 0);
      if (montant > 0 && c.cles.some((k) => normDesc(it.desc).includes(normDesc(k)))) lignes.push(it.desc);
    }
  }
  return [...new Set(lignes)];
}

// Zone sous la case « Client déjà équipé » : l'alerte quand une ligne facture
// encore une prestation que le client a déjà, sinon '' exactement (la zone
// vide est masquée par `.deja-obtenu:empty`, sans trou dans la grille).
function htmlDejaObtenu(d) {
  const facturees = facturesMalgreDeja(d);
  if (!facturees.length) return '';
  return `<div class="deja-alerte" role="alert">${ico('alerte', 15)}<span>Toujours facturé alors que « Client déjà équipé » est coché : ${facturees.map((x) => `<strong>${esc(x)}</strong>`).join(', ')}</span></div>`;
}

function htmlResumeTextes(d, resume) {
  const aJour = PACKS.every(([k]) => ((d.packNotes && d.packNotes[k]) || '').trim() === (resume.genere[k] || '').trim());
  const faits = [];
  if (resume.deja.length) faits.push(`déjà obtenu par le client : <strong>${esc(enumerer(resume.deja))}</strong> (signalé au client dans chaque texte)`);
  if (resume.absents.length) faits.push(`absent du devis : <strong>${esc(enumerer(resume.absents))}</strong>`);
  const detail = faits.length ? 'Retiré des textes — ' + faits.join(' · ') : 'Rien à retirer : le devis contient toutes les prestations que citent les textes du Catalogue.';
  if (aJour) return `<div class="packs-resume">${ico('coche', 16)}<span><strong>Textes adaptés à ce dossier.</strong> ${detail}</span></div>`;
  return `<div class="packs-resume a-revoir">${ico('info', 16)}<span><strong>Ces textes ne sont plus ceux que le logiciel écrirait pour ce dossier</strong> (retouchés à la main, ou écrits avant un changement). En les adaptant : ${faits.length ? faits.join(' · ') : 'aucun retrait'}.</span><button type="button" class="btn small" data-regenerer>↻ Adapter</button></div>`;
}

function buildPacksPanel(d) {
  const brut = packTotals(d);
  const p = {};
  for (const [k] of PACKS) p[k] = prixPack(d, k);
  // garde-fou : au-delà des honoraires, la remise entame les frais officiels avancés
  const honoraires = (d.items || []).filter(isHonoraires)
    .reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);
  const remise = Math.max(0, Number(d.discount) || 0);
  const alerteRemise = honoraires > 0 && remise > honoraires;
  return `
    <div class="panel">
      <h2>Les 3 packs proposés au client</h2>
      <div class="form-grid" style="margin-bottom:16px">
        <div class="field">
          <label>Pack choisi par le client — son prix fait le total de la facture (modifiable à tout moment)</label>
          <select id="e-pack">
            ${PACKS.map(([k, l]) => `<option value="${k}" ${d.chosenPack === k ? 'selected' : ''}>${PACK_META[k].symbol} ${l} — ${fmtMoney(p[k])}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Remise (FCFA) — appliquée aux packs Premium et Access</label>
          <input type="text" inputmode="numeric" id="e-discount" placeholder="0" value="${Number(d.discount) ? nf.format(Number(d.discount)) : ''}" />
        </div>
      </div>
      ${alerteRemise ? `<div class="alerte-remise">⚠️ La remise (${fmtMoney(remise)}) dépasse tes honoraires (${fmtMoney(honoraires)}) : au-delà, tu entames les frais officiels que tu avances pour le client.</div>` : ''}
      <div id="packs-resume" aria-live="polite">${htmlResumeTextes(d, resumeAdaptation(d))}</div>
      ${PACKS.map(([k, l]) => `
      <div class="pack-card" style="border-color:${packTeinte(k)}; border-left-width:5px; background:${packFond(k)}">
        <div class="pack-head"><strong style="color:${packTeinte(k)}">${PACK_META[k].symbol} ${l}</strong><span class="pack-price" style="color:${packTeinte(k)}">${fmtMoney(p[k])}</span></div>
        ${remisePack(d, k) > 0 ? `<div class="pack-remise">Prix initial ${fmtMoney(packTotals(d)[k])} — remise ${fmtMoney(remisePack(d, k))}</div>` : ''}
        <div class="pack-inc">${brut.includes[k].length ? 'Inclut : ' + brut.includes[k].map(esc).join(' · ') : 'Aucun élément'}</div>
        <div class="pack-sched">
          <div class="ps-title">Échéancier de paiement</div>
          ${packSchedule(d, k, p[k]).map((m, i) => `<div class="ps-row"><span>${i + 1}. ${PACK_STAGES[k][i].fr}</span><strong>${fmtMoney(m)}</strong></div>`).join('')}
        </div>
        ${db.catalog.phrases.length ? `
        <select class="pack-phrase" data-pack="${k}">
          <option value="">— Insérer une phrase pré-enregistrée —</option>
          ${db.catalog.phrases.map((ph, i) => `<option value="${i}">${esc(ph.text.length > 95 ? ph.text.slice(0, 95) + '…' : ph.text)}</option>`).join('')}
        </select>` : `
        <div class="pack-inc">💡 Enregistre tes phrases types dans <strong>Catalogue → Phrases pré-enregistrées</strong> : elles apparaîtront ici dans un menu déroulant.</div>`}
        <textarea class="pack-note" data-pack="${k}" placeholder="Texte affiché sous ce pack sur la facture…">${esc((d.packNotes && d.packNotes[k]) || '')}</textarea>
      </div>`).join('')}
      <div class="btn-row" style="margin-top:4px">
        <button type="button" class="btn small" id="pack-textes-reset" title="Reprendre les textes du Catalogue en retirant les prestations absentes de ce dossier">↻ Régénérer les textes des packs</button>
      </div>
      <p class="hint" style="margin-top:12px">Les montants viennent du devis d'origine (arrondis à 50 000 près, à la hausse). Pour les changer, modifie le devis puis reconvertis-le. La remise s'impute à 30 % sur la 1<sup>re</sup> tranche et à 70 % sur la 2<sup>e</sup>.</p>
    </div>`;
}

function renderEditor() {
  const d = editing;
  const isDevis = d.type === 'devis';
  if (!isDevis) {
    d.packNotes = d.packNotes || { premium: '', access: '', standard: '' };
    d.chosenPack = d.chosenPack || 'premium';
  }
  const title = (d._new ? 'Nouveau ' : '') + (isDevis ? 'devis' : 'facture');
  const source = d.sourceId ? db.documents.find((x) => x.id === d.sourceId) : null;

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1>${isDevis ? ico('fichier', 20) : ico('facture', 20)} ${esc(d.number)} <span class="badge ${esc(d.status)}" id="e-badge" style="vertical-align:middle">${esc(statusLabel(d))}</span></h1>
        <div class="sub">${title[0].toUpperCase() + title.slice(1)}${source ? ` — issu du devis ${esc(source.number)}` : ''}</div>
      </div>
      <div class="btn-row">
        <button class="btn" id="back">← Retour</button>
        <button class="btn primary" id="save">💾 Enregistrer</button>
        <button class="btn success" id="export">⬇️ Exporter en PDF</button>
        <button class="btn" id="send-wa" title="Ouvre la conversation WhatsApp du client, PDF prêt à coller">🟢 WhatsApp</button>
        <button class="btn" id="send-tg" title="Ouvre la conversation Telegram du client, PDF prêt à coller">✈️ Telegram</button>
        ${isDevis ? `<button class="btn" id="convert">→ Convertir en facture</button>` : ''}
        ${isDevis && !d._new ? `<button class="btn" id="duplicate" title="Créer un nouveau devis à partir de celui-ci">⧉ Dupliquer</button>` : ''}
        ${d._new ? '' : `<button class="btn danger" id="delete">Supprimer</button>`}
      </div>
    </div>

    <div class="panel">
      <div class="form-grid">
        <div class="field champ-large">
          <label>Client</label>
          <div class="champ-avec-bouton">
            <select id="e-client">
              <option value="">— Choisir un client —</option>
              ${db.clients.map((c) => `<option value="${c.id}" ${d.clientId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
            <button type="button" class="btn" id="e-client-new" title="Créer un client sans quitter ce devis">+ Nouveau</button>
          </div>
        </div>
        <div class="field">
          <label>Date</label>
          <input type="date" id="e-date" value="${d.date}" />
        </div>
        <div class="field">
          <label>Statut</label>
          <select id="e-status">
            ${STATUSES[d.type].map(([k, l]) => `<option value="${k}" ${d.status === k ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Langue du document</label>
          <div class="lang-toggle">
            <button type="button" data-lang="fr" class="${d.lang === 'fr' ? 'active' : ''}">Français</button>
            <button type="button" data-lang="en" class="${d.lang === 'en' ? 'active' : ''}">English</button>
          </div>
        </div>
        <div class="field full">
          <label class="check-line">
            <input type="checkbox" id="e-forfait" ${d.forfaitEquipe ? 'checked' : ''} />
            <span>Client déjà équipé (test de langue, équivalence, preuves professionnelles) —
            1<sup>re</sup>&nbsp;tranche forfaitaire de ${fmtMoney(FORFAIT_EQUIPE)} au lieu de la part d'honoraires (packs Premium et Access)</span>
          </label>
        </div>
        <div class="field full deja-obtenu" id="e-deja">${htmlDejaObtenu(d)}</div>
      </div>
    </div>

    ${isDevis ? `
    <div class="panel">
      <h2>Prestations</h2>
      ${(db.catalog.equivalences.length + db.catalog.services.length) ? `
      <div class="picker">
        <button type="button" class="btn small" id="picker-toggle">🧰 Ajouter depuis le catalogue (${db.catalog.equivalences.length + db.catalog.services.length})</button>
        <div id="picker-body" style="display:none">
          <table class="picker-table">
            <thead><tr><th></th><th>Prestation</th><th class="num">Prix unitaire</th><th style="width:90px">Qté</th><th class="num">Montant</th></tr></thead>
            <tbody>
              ${pickerGroupRows(db.catalog.equivalences, 'eq', 'EQUIVALENCE ET TEST DE LANGUE')}
              ${pickerGroupRows(db.catalog.services, 'pr', 'PROCEDURE')}
            </tbody>
          </table>
          <div class="picker-footer">
            <span>Sélection : <strong id="pk-total">${fmtMoney(0)}</strong></span>
            <button type="button" class="btn primary small" id="pk-add">➕ Ajouter au document</button>
          </div>
        </div>
      </div>` : `
      <div class="hint">💡 Astuce : enregistre tes prestations à prix fixes dans l'onglet <strong>Catalogue</strong> (sections EQUIVALENCE et PROCEDURE) pour les insérer ici en un clic.</div>`}
      <table class="items-table">
        <thead><tr><th style="width:50%">Désignation</th><th style="width:12%">Qté</th><th style="width:18%">Prix unitaire</th><th style="width:16%" class="num">Montant</th><th></th></tr></thead>
        <tbody id="items-body"></tbody>
      </table>
      <button class="btn small" id="add-line" style="margin-top:10px">+ Ajouter une ligne</button>

      <div class="totals-box">
        <div class="row"><span>Sous-total</span><strong id="t-subtotal"></strong></div>
        <div class="row round-hint"><span>Arrondi à 50 000 près (à la hausse)</span><strong id="t-round"></strong></div>
        <div class="row"><span>Remise (FCFA)</span><input type="text" inputmode="numeric" id="e-discount" placeholder="0" value="${Number(d.discount) ? nf.format(Number(d.discount)) : ''}" /></div>
        <div class="row grand"><span>TOTAL</span><span id="t-total"></span></div>
      </div>
    </div>` : buildPacksPanel(d)}

    <div class="panel">
      <h2>Notes (visibles en bas du PDF)</h2>
      ${db.catalog.phrases.length ? `
      <div class="field full" style="margin-bottom:10px">
        <label>Insérer une phrase pré-enregistrée</label>
        <select id="phrase-select">
          <option value="">— Choisir une phrase à ajouter —</option>
          ${db.catalog.phrases.map((p, i) => `<option value="${i}">${esc(p.text.length > 95 ? p.text.slice(0, 95) + '…' : p.text)}</option>`).join('')}
        </select>
      </div>` : `
      <div class="hint" style="margin-bottom:10px">💡 Astuce : enregistre tes phrases types dans l'onglet <strong>Catalogue</strong> pour les insérer ici via un menu déroulant.</div>`}
      <div class="field full">
        <textarea id="e-notes" placeholder="Ex. : conditions particulières, délai de livraison…">${esc(d.notes)}</textarea>
      </div>
    </div>`;

  if (isDevis) {
    renderItems();
    updateTotals();
  } else {
    $('#e-pack').onchange = (e) => { d.chosenPack = e.target.value; };
    // le résumé suit la frappe : il dit dès la première retouche que le texte
    // n'est plus celui que le logiciel aurait écrit
    const resume = resumeAdaptation(d);
    const zoneResume = $('#packs-resume');
    $$('.pack-note').forEach((ta) => {
      ta.oninput = () => {
        d.packNotes[ta.dataset.pack] = ta.value;
        if (zoneResume) zoneResume.innerHTML = htmlResumeTextes(d, resume);
      };
    });
    const regenerer = async () => {
      const ok = await window.api.confirmDialog({
        message: 'Régénérer les textes des trois packs ?',
        detail: 'Les textes du Catalogue sont repris, en retirant les prestations que ce dossier ne contient pas et celles que le client a déjà. Tes retouches sur cette facture seront remplacées.',
        ok: 'Régénérer', cancel: 'Annuler'
      });
      if (!ok) return;
      d.packNotes = textesPacksPour(d);
      editingDirty = true;
      const pos = main.scrollTop;
      renderEditor();
      main.scrollTop = pos;
      toast('✅ Textes régénérés d\'après le contenu du dossier');
    };
    const resetTextes = $('#pack-textes-reset');
    if (resetTextes) resetTextes.onclick = regenerer;
    if (zoneResume) zoneResume.onclick = (e) => { if (e.target.closest('[data-regenerer]')) regenerer(); };
    $$('.pack-phrase').forEach((sel) => {
      sel.onchange = () => {
        if (sel.value === '') return;
        const ph = db.catalog.phrases[Number(sel.value)];
        const k = sel.dataset.pack;
        if (ph) {
          if ((d.packNotes[k] || '').includes(ph.text.trim())) {
            toast('⚠️ Cette phrase est déjà sous ce pack — pas besoin de la réinsérer');
          } else {
            d.packNotes[k] = d.packNotes[k] ? d.packNotes[k].replace(/\s+$/, '') + '\n' + ph.text : ph.text;
            const zone = $(`.pack-note[data-pack="${k}"]`);
            zone.value = d.packNotes[k];
            autoGrow(zone);
          }
        }
        sel.value = '';
      };
    });
    bindAutoGrow('.pack-note');
  }
  bindAutoGrow('#e-notes');

  // Case « client déjà équipé ». Sur un devis, rien d'autre à refaire que la
  // zone de l'alerte (les textes naîtront à la conversion). Sur une facture,
  // les textes des packs suivent aussitôt s'ils n'ont pas été retouchés ;
  // sinon on demande avant de remplacer les retouches.
  const changerDejaObtenu = async (modifier) => {
    if (isDevis) {
      modifier();
      updateTotals();
      return;
    }
    const avant = textesPacksPour(d);
    const intacts = PACKS.every(([k]) => ((d.packNotes && d.packNotes[k]) || '').trim() === (avant[k] || '').trim());
    modifier();
    let adapte = intacts;
    if (!intacts) {
      adapte = await window.api.confirmDialog({
        message: 'Adapter aussi les textes des trois packs ?',
        detail: 'Tu as retouché ces textes à la main : les adapter les remplace par ceux du Catalogue, ajustés à ce dossier.',
        ok: 'Adapter les textes', cancel: 'Garder mes textes'
      });
    }
    if (adapte) d.packNotes = textesPacksPour(d);
    const pos = main.scrollTop;
    renderEditor();
    main.scrollTop = pos;
    if (adapte) toast('✅ Textes des packs adaptés à ce dossier');
  };
  // case « client déjà équipé » : recalcule tout de suite les packs
  $('#e-forfait').onchange = (e) => {
    const coche = e.target.checked;
    changerDejaObtenu(() => { d.forfaitEquipe = coche; });
  };

  $('#back').onclick = () => setView(isDevis ? 'devis' : 'factures');
  $('#save').onclick = saveEditing;
  $('#export').onclick = exportEditingPdf;
  $('#send-wa').onclick = () => sendDocument('whatsapp');
  $('#send-tg').onclick = () => sendDocument('telegram');
  if (isDevis) $('#convert').onclick = convertToInvoice;
  const dup = $('#duplicate');
  if (dup) dup.onclick = () => {
    const copie = Object.assign(newDoc('devis'), {
      clientId: '',
      items: structuredClone(d.items),
      discount: d.discount,
      forfaitEquipe: !!d.forfaitEquipe,
      lang: d.lang,
      notes: d.notes
    });
    openEditor(copie);
    toast(`⧉ Copie de ${d.number} créée — choisis le client puis enregistre`);
  };
  const del = $('#delete');
  if (del) del.onclick = deleteEditing;

  $('#e-client').onchange = (e) => { d.clientId = e.target.value; };
  $('#e-client-new').onclick = async () => {
    const infos = await askNewClient();
    if (!infos) return;
    const c = { id: uid(), name: toTitleCase(infos.name), contact: '', address: '', phone: infos.phone, email: '' };
    db.clients.unshift(c);
    d.clientId = c.id;
    await persist();
    toast(`✅ Client « ${c.name} » créé${c.phone ? ' avec son numéro' : ''} — complète sa fiche dans Clients si besoin`);
    const pos = main.scrollTop;
    renderEditor();
    main.scrollTop = pos;
  };
  $('#e-date').onchange = (e) => { d.date = e.target.value; };
  $('#e-status').onchange = async (e) => {
    d.status = e.target.value;
    // ton choix fait loi : plus aucune règle automatique ne touchera ce statut
    d.statutManuel = true;
    // date d'encaissement : les statistiques s'appuient dessus, pas sur la date de la facture
    if (d.status === 'payee') d.paidAt = d.paidAt || todayIso();
    const badge = $('#e-badge');
    if (badge) { badge.className = 'badge ' + d.status; badge.textContent = statusLabel(d); }
    // le choix est conservé tout de suite, sans attendre le bouton « Enregistrer »
    const idx = db.documents.findIndex((x) => x.id === d.id);
    if (idx >= 0) {
      db.documents[idx].status = d.status;
      db.documents[idx].statutManuel = true;
      if (d.paidAt) db.documents[idx].paidAt = d.paidAt;
    }
    // une facture qui part prouve que le devis a bien été accepté
    const suivi = repercuterSurDevis(idx >= 0 ? db.documents[idx] : d);
    await persist();
    if (suivi) toast(`✅ Devis ${suivi} marqué « Accepté » — sa facture est partie`);
  };
  const discountInput = $('#e-discount');
  if (discountInput) {
    if (isDevis) {
      discountInput.oninput = (e) => { d.discount = formatMoneyInput(e.target); updateTotals(); };
    } else {
      // sur une facture, la remise change les prix des packs et l'échéancier :
      // on redessine le panneau une fois la saisie terminée
      // on redessine seulement quand la valeur a réellement changé, et jamais
      // sur un simple blur : sinon le premier clic sur Enregistrer/Exporter se
      // perdait dans le redessin.
      discountInput.oninput = (e) => { d.discount = formatMoneyInput(e.target); };
      discountInput.onchange = () => { const p = main.scrollTop; renderEditor(); main.scrollTop = p; };
    }
  }
  $('#e-notes').oninput = (e) => { d.notes = e.target.value; };
  $$('.lang-toggle button').forEach((b) => {
    b.onclick = () => {
      d.lang = b.dataset.lang;
      $$('.lang-toggle button').forEach((x) => x.classList.toggle('active', x === b));
      // les textes des packs et les notes restent ceux que tu as écrits : en
      // anglais, on le signale plutôt que de livrer un PDF à moitié traduit
      if (d.lang === 'en') {
        const francais = [d.notes, ...(d.packNotes ? Object.values(d.packNotes) : [])]
          .some((t) => t && /[éèêàçùôûî]|vous |votre |dossier/i.test(t));
        if (francais) toast('⚠️ Document en anglais : les textes des packs et les notes sont encore en français — pense à les traduire');
      }
    };
  });
  const addLine = $('#add-line');
  if (addLine) addLine.onclick = () => {
    d.items.push({ desc: '', qty: 1, unitPrice: 0 });
    renderItems();
    updateTotals();
    const rows = $$('#items-body tr');
    const last = rows[rows.length - 1];
    if (last) $('input.desc', last).focus();
  };

  // --- Sélecteur du catalogue (cases à cocher + quantités) ---
  const pickerToggle = $('#picker-toggle');
  if (pickerToggle) {
    const body = $('#picker-body');
    pickerToggle.onclick = () => {
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    };
    const refreshPicker = () => {
      let total = 0;
      $$('.pk-check').forEach((chk) => {
        const { src, i } = chk.dataset;
        const s = catalogItem(src, Number(i));
        const qty = Number($(`.pk-qty[data-src="${src}"][data-i="${i}"]`).value) || 0;
        const line = $(`.pk-line[data-src="${src}"][data-i="${i}"]`);
        if (chk.checked && qty > 0) {
          const amount = qty * (Number(s.unitPrice) || 0);
          line.textContent = fmtMoney(amount);
          total += amount;
        } else {
          line.textContent = '—';
        }
      });
      $('#pk-total').textContent = fmtMoney(total);
    };
    $$('.pk-check').forEach((chk) => { chk.onchange = refreshPicker; });
    $$('.pk-qty').forEach((q) => {
      q.oninput = () => {
        // quantités entières uniquement
        const v = Math.max(0, Math.trunc(Number(q.value) || 0));
        if (q.value !== '' && Number(q.value) !== v) q.value = v;
        // saisir une quantité coche automatiquement la ligne
        const chk = $(`.pk-check[data-src="${q.dataset.src}"][data-i="${q.dataset.i}"]`);
        if (!chk.checked && v > 0) chk.checked = true;
        refreshPicker();
      };
    });
    $('#pk-add').onclick = () => {
      const added = [];
      $$('.pk-check').forEach((chk) => {
        const { src, i } = chk.dataset;
        const qty = Number($(`.pk-qty[data-src="${src}"][data-i="${i}"]`).value) || 0;
        if (chk.checked && qty > 0) {
          const s = catalogItem(src, Number(i));
          added.push({ desc: s.desc, qty, unitPrice: Number(s.unitPrice) || 0 });
        }
      });
      if (!added.length) { toast('⚠️ Coche au moins une prestation'); return; }
      // remplace la ligne vide de départ au lieu de la laisser traîner
      d.items = d.items.filter((it) => it.desc.trim() || (Number(it.qty) || 0) * (Number(it.unitPrice) || 0) > 0);
      d.items.push(...added);
      renderItems();
      updateTotals();
      $('#picker-body').style.display = 'none';
      toast(`✅ ${added.length} prestation(s) ajoutée(s)`);
    };
  }

  // --- Menu déroulant des phrases pré-enregistrées ---
  const phraseSel = $('#phrase-select');
  if (phraseSel) {
    phraseSel.onchange = () => {
      if (phraseSel.value === '') return;
      const p = db.catalog.phrases[Number(phraseSel.value)];
      if (p) {
        if ((d.notes || '').includes(p.text.trim())) {
          toast('⚠️ Cette phrase est déjà dans les notes — pas besoin de la réinsérer');
        } else {
          d.notes = d.notes ? d.notes.replace(/\s+$/, '') + '\n' + p.text : p.text;
          $('#e-notes').value = d.notes;
          autoGrow($('#e-notes'));
        }
      }
      phraseSel.value = '';
    };
  }
}

function renderItems() {
  const body = $('#items-body');
  body.innerHTML = editing.items.map((it, i) => `
    <tr data-i="${i}">
      <td><input class="desc" value="${esc(it.desc)}" placeholder="Description de la prestation" /></td>
      <td><input class="qty" type="number" min="0" step="1" value="${Math.trunc(Number(it.qty) || 0)}" /></td>
      <td><input class="price" type="text" inputmode="numeric" placeholder="0" value="${Number(it.unitPrice) ? nf.format(Number(it.unitPrice)) : ''}" /></td>
      <td class="line-total"></td>
      <td><button class="del-line" title="Supprimer la ligne">✕</button></td>
    </tr>`).join('');

  $$('#items-body tr').forEach((tr) => {
    const i = Number(tr.dataset.i);
    const it = editing.items[i];
    // une désignation tapée à la main peut faire naître ou disparaître l'alerte « Toujours facturé »
    $('input.desc', tr).oninput = (e) => { it.desc = e.target.value; majZoneDeja(); };
    $('input.qty', tr).oninput = (e) => {
      const v = Math.max(0, Math.trunc(Number(e.target.value) || 0));
      if (e.target.value !== '' && Number(e.target.value) !== v) e.target.value = v;
      it.qty = v;
      updateTotals();
    };
    $('input.price', tr).oninput = (e) => { it.unitPrice = formatMoneyInput(e.target); updateTotals(); };
    $('.del-line', tr).onclick = () => {
      editing.items.splice(i, 1);
      if (!editing.items.length) editing.items.push({ desc: '', qty: 1, unitPrice: 0 });
      renderItems();
      updateTotals();
    };
  });
}

function updateTotals() {
  const { subtotal, total } = docTotals(editing);
  $$('#items-body tr').forEach((tr) => {
    const it = editing.items[Number(tr.dataset.i)];
    $('.line-total', tr).textContent = fmtMoney((Number(it.qty) || 0) * (Number(it.unitPrice) || 0));
  });
  $('#t-subtotal').textContent = fmtMoney(subtotal);
  $('#t-round').textContent = fmtMoney(docTotals(editing).rounded);
  $('#t-total').textContent = fmtMoney(total);
  majZoneDeja();
}

// La zone de l'alerte suit la case « Client déjà équipé » et les lignes du devis.
function majZoneDeja() {
  const zone = $('#e-deja');
  if (zone && editing) zone.innerHTML = htmlDejaObtenu(editing);
}

async function saveEditing(silent) {
  const d = editing;
  if (!d.clientId || !clientOf(d)) { toast('⚠️ Choisis un client avant d\'enregistrer'); return false; }
  if (!dateValide(d.date)) { toast('⚠️ La date du document est vide ou invalide'); const di = $('#e-date'); if (di) di.focus(); return false; }
  d.items = (d.items || []).map((it) => ({ ...it, desc: String(it.desc || ''), qty: Number(it.qty) || 0, unitPrice: Number(it.unitPrice) || 0 }));
  if (d.type === 'devis') {
    d.items = d.items.filter((it) => it.desc.trim() || it.qty * it.unitPrice > 0);
    if (!d.items.length) { toast('⚠️ Ajoute au moins une prestation'); d.items.push({ desc: '', qty: 1, unitPrice: 0 }); renderItems(); return false; }
  }
  const etaitNouveau = !!d._new;
  delete d._new;
  const idx = db.documents.findIndex((x) => x.id === d.id);
  if (idx >= 0) db.documents[idx] = structuredClone(d);
  else db.documents.push(structuredClone(d));
  reserverNumero(d.number);
  if (!(await persist())) {
    // l'écriture a échoué : on ne fait pas croire que c'est enregistré
    if (etaitNouveau) { d._new = true; db.documents = db.documents.filter((x) => x.id !== d.id); }
    return false;
  }
  editingDirty = false;
  assurerVisible(d.type, d.id);
  if (silent !== true) {
    toast('✅ Document enregistré');
    // on redessine (bouton Supprimer, en-tête…) sans perdre le champ en cours
    const actif = document.activeElement;
    const repere = actif && actif.id ? '#' + actif.id : null;
    const defilement = main.scrollTop;
    renderEditor();
    main.scrollTop = defilement;
    if (repere) { const el = $(repere); if (el && el.focus) el.focus(); }
  }
  return true;
}

async function deleteEditing() {
  const d = editing;
  if (!(await window.api.confirmDialog(`Supprimer définitivement ${d.number} ?`))) return;
  db.documents = db.documents.filter((x) => x.id !== d.id);
  noterSuppression('documents', d);
  await persist();
  toast('Document supprimé');
  setView(d.type === 'devis' ? 'devis' : 'factures');
}

async function convertToInvoice() {
  if (!(await saveEditing(true))) return;
  const src = editing;
  const deja = db.documents.find((x) => x.type === 'facture' && x.sourceId === src.id);
  if (deja) {
    const encore = await window.api.confirmDialog({
      message: `Ce devis a déjà été converti : facture ${deja.number}.`,
      detail: 'Ouvrir cette facture, ou en créer une deuxième à partir du même devis ?',
      ok: 'Créer une 2e facture', cancel: 'Ouvrir ' + deja.number
    });
    if (!encore) { openEditor(structuredClone(deja)); return; }
  }
  if (src.status === 'refuse') {
    const ok = await window.api.confirmDialog({ message: 'Ce devis est marqué « Refusé ».', detail: 'Le convertir quand même en facture ?', ok: 'Convertir', cancel: 'Annuler' });
    if (!ok) return;
  }
  const inv = {
    ...structuredClone(src),
    // la composition des packs est figée au moment de la conversion
    items: structuredClone(src.items).map((it) => ({ ...it, packs: { ...packFlagsFor(it) } })),
    id: uid(),
    type: 'facture',
    number: nextNumber('facture', todayIso()),
    date: todayIso(),
    status: 'brouillon',
    statutManuel: false, // la facture repart d'un statut neuf, sans hériter du choix fait sur le devis
    sourceId: src.id,
    createdAt: Date.now(),
    discount: Number(src.discount) || 0, // la remise du devis suit sur la facture
    chosenPack: 'premium',
    // les textes des packs du Catalogue s'insèrent automatiquement, ajustés
    // au contenu réel du dossier (une prestation absente n'est plus citée)
    packNotes: textesPacksPour(src)
  };
  // le statut du devis ne bouge pas : convertir n'est pas accepter
  db.documents.push(inv);
  reserverNumero(inv.number);
  if (!(await persist())) { db.documents = db.documents.filter((x) => x.id !== inv.id); return; }
  toast(`✅ Facture ${inv.number} créée — le devis reste « ${statusLabel(src)} »`);
  openEditor(structuredClone(inv));
}

// Barre d'aide après ouverture de Telegram : message prêt à copier pour la légende
function showSendBar(text) {
  const bar = $('#sendbar');
  bar.innerHTML = `
    <div>
      <div class="sb-steps">1. Colle le PDF (Ctrl+V) &nbsp;→&nbsp; 2. Copie ce texte pour la légende :</div>
      <div class="sb-text" title="${esc(text)}">${esc(text)}</div>
    </div>
    <button type="button" class="btn primary small" id="sb-copy">📋 Copier le texte</button>
    <button type="button" class="sb-close" title="Fermer">✕</button>`;
  bar.classList.add('show');
  $('#sb-copy', bar).onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('✅ Texte copié — colle-le en légende du PDF');
    bar.classList.remove('show');
  };
  $('.sb-close', bar).onclick = () => bar.classList.remove('show');
}

// Numéro au format international sans « + » (WhatsApp/Telegram)
function phoneIntl(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  const international = p.startsWith('+') || p.startsWith('00');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('00')) p = p.slice(2);
  if (!international) {
    if (p.startsWith('0')) p = p.slice(1);                  // 0 de la numérotation nationale
    if (p.length === 9 && p.startsWith('6')) p = '237' + p; // mobile camerounais sans indicatif
  }
  // un numéro international tient en 8 à 15 chiffres (norme E.164)
  return /^[1-9]\d{7,14}$/.test(p) ? p : '';
}

async function sendDocument(channel) {
  if (!(await saveEditing(true))) return;
  const d = editing;
  const client = clientOf(d);
  if (!client) { toast('⚠️ Le client de ce document n\'existe plus — choisis-en un autre'); return; }
  let phone = phoneIntl(client && client.phone);
  let versDefaut = false;
  if (!phone) {
    // pas de numéro client : on envoie vers le numéro par défaut (à transférer ensuite)
    phone = phoneIntl(db.settings.company.fallbackPhone);
    versDefaut = true;
    if (!phone) {
      toast('⚠️ Pas de numéro client ni de numéro par défaut (à définir dans Paramètres)');
      return;
    }
  }
  const { total } = docTotals(d);
  const isDevis = d.type === 'devis';
  const text = d.lang === 'en'
    ? `${client.name}, attached is your ${isDevis ? 'quote' : 'invoice'}`
    : `${client.name}, ci-joint votre ${isDevis ? 'devis' : 'facture'}`;
  const cname = client.name.replace(/[^\wÀ-ſ -]/g, '').trim().replace(/ +/g, '-') || 'client';
  const html = buildPdfHtml(d, client, db.settings.company);
  toast('⏳ Préparation de l\'envoi…');
  const res = await window.api.sendVia({ html, fileName: `${d.number}-${cname}.pdf`, channel, phone, text });
  if (MOBILE) {
    // téléphone : le menu Partager remplace le copier-coller (mobile.js)
    const appli = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
    if (res.partage) toast('✅ PDF partagé');
    else if (res.impression) toast(`Fenêtre d'impression : touche « Partager » puis ${appli}, ou « Enregistrer en PDF »`, 9000);
    else if (res.telecharge) toast(`✅ PDF enregistré (${res.path}) — joins-le dans la conversation ${appli} qui s'ouvre`, 9000);
    else if (!res.canceled) toast('❌ Erreur : ' + (res.error || 'inconnue'));
    return;
  }
  if (res.ok) {
    if (res.presse === false) toast('⚠️ Le PDF n\'a pas pu être copié — il est enregistré ici : ' + res.path);
    else toast(versDefaut
      ? '✅ Client sans numéro — envoi vers ton numéro par défaut, PDF prêt à coller (Ctrl+V)'
      : '✅ PDF copié — colle-le avec Ctrl+V dans la conversation qui s\'ouvre');
    if (channel === 'telegram') showSendBar(text);
  } else if (!res.canceled) {
    toast('❌ Erreur : ' + (res.error || 'inconnue'));
  }
}

async function exportEditingPdf() {
  if (!(await saveEditing(true))) return;
  const d = editing;
  const client = clientOf(d);
  const html = buildPdfHtml(d, client, db.settings.company);
  const cname = client ? client.name.replace(/[^\wÀ-ſ -]/g, '').trim().replace(/ +/g, '-') : 'client';
  const res = await window.api.exportPdf(html, `${d.number}-${cname}.pdf`);
  if (res.ok && res.impression) toast('Fenêtre d\'impression : choisis « Enregistrer en PDF » (ou « Partager »)', 9000);
  else if (res.ok) toast(`✅ PDF exporté : ${res.path}`);
  else if (!res.canceled) toast('❌ Erreur export : ' + (res.error || 'inconnue'));
  renderEditor();
}

/* ---------- Gabarit PDF ---------- */

const L = {
  fr: {
    devis: 'DEVIS', facture: 'FACTURE',
    number: 'N°', date: 'Date', validUntil: 'Valable jusqu\'au',
    billTo: 'Client', desc: 'Désignation', qty: 'Qté', unit: 'Prix unitaire', amount: 'Montant',
    subtotal: 'Sous-total', rounded: 'Sous-total arrondi', discount: 'Remise', total: 'TOTAL',
    included: 'Inclut',
    schedule: 'Échéancier de paiement',
    notes: 'Notes', terms: 'Conditions de paiement',
    ref: 'Réf. devis'
  },
  en: {
    devis: 'QUOTE', facture: 'INVOICE',
    number: 'No.', date: 'Date', validUntil: 'Valid until',
    billTo: 'Bill to', desc: 'Description', qty: 'Qty', unit: 'Unit price', amount: 'Amount',
    subtotal: 'Subtotal', rounded: 'Rounded subtotal', discount: 'Discount', total: 'TOTAL',
    included: 'Includes',
    schedule: 'Payment schedule',
    notes: 'Notes', terms: 'Payment terms',
    ref: 'Quote ref.'
  }
};

function buildPdfHtml(d, client, co) {
  const t = L[d.lang] || L.fr;
  const { subtotal, rounded, discount, total } = docTotals(d);
  const isDevis = d.type === 'devis';
  const source = d.sourceId ? db.documents.find((x) => x.id === d.sourceId) : null;

  let validUntil = '';
  if (isDevis && co.validityDays > 0) {
    const v = new Date(d.date + 'T00:00:00');
    v.setDate(v.getDate() + Number(co.validityDays));
    validUntil = isoLocal(v); // et non toISOString() : la date reculait d'un jour
  }

  const terms = d.lang === 'en' ? co.paymentTermsEn : co.paymentTermsFr;
  const legal = [co.rccm ? 'RCCM : ' + co.rccm : '', co.niu ? 'NIU : ' + co.niu : ''].filter(Boolean).join(' — ');
  const contact = [co.phone, co.email].filter(Boolean).join(' — ');

  return `<!DOCTYPE html><html lang="${d.lang}"><head><meta charset="UTF-8"><style>
    @page { size: A4; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: "Segoe UI", Arial, sans-serif; color: #1c2333; font-size: 13px; padding: 10px 48px 40px; }
    .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 34px; }
    .co-logo { max-height: 72px; max-width: 240px; margin-bottom: 10px; }
    .co-name { font-size: 19px; font-weight: 700; }
    .co-line { color: #555f73; font-size: 12px; margin-top: 2px; }
    .co-site { color: #0C447C; font-weight: 600; }
    .doc-box { text-align: right; }
    .doc-title { font-size: 27px; font-weight: 800; letter-spacing: 2px; color: #0C447C; }
    .doc-num { font-size: 15px; font-weight: 600; margin-top: 4px; }
    .doc-meta { color: #555f73; font-size: 12px; margin-top: 8px; line-height: 1.6; }
    .client-box { background: #f4f6fa; border-radius: 8px; padding: 14px 18px; margin-bottom: 26px; width: 46%; }
    .client-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 1px; color: #6b7487; margin-bottom: 5px; }
    .client-name { font-weight: 700; font-size: 14.5px; }
    .client-line { color: #555f73; font-size: 12px; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th { background: #0C447C; color: #fff; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; padding: 9px 12px; text-align: left; }
    th.num, td.num { text-align: right; }
    td { padding: 10px 12px; border-bottom: 1px solid #e3e8f0; vertical-align: top; }
    .totals { margin-left: auto; width: 46%; margin-top: 10px; }
    .totals .row { display: flex; justify-content: space-between; padding: 5px 12px; font-size: 13px; }
    .totals .grand { background: #0C447C; color: #fff; font-weight: 700; font-size: 15.5px; border-radius: 7px; padding: 11px 12px; margin-top: 7px; }
    .section { margin-top: 26px; }
    .section h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b7487; margin-bottom: 5px; }
    .section p { font-size: 12.5px; color: #333c50; white-space: pre-wrap; line-height: 1.55; }
    .pack { border: 1.5px solid #0C447C; border-radius: 10px; margin-bottom: 14px; overflow: hidden; page-break-inside: avoid; }
    .pack-h { display: flex; justify-content: space-between; align-items: center; background: #0C447C; color: #fff; padding: 11px 16px; font-weight: 700; font-size: 14.5px; letter-spacing: 1px; }
    .pack-b { padding: 11px 16px; }
    .pack-n { font-size: 12.5px; color: #1c2333; white-space: pre-wrap; line-height: 1.55; }
    .pack-rem { font-size: 12px; font-weight: 700; color: #A32D2D; margin-bottom: 6px; }
    .pack-rem s { font-weight: 400; color: #6b7487; }
    .ps { margin-top: 9px; border-top: 1px dashed #e3e8f0; padding-top: 8px; }
    .ps-t { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 4px; }
    .ps-r { display: flex; justify-content: space-between; gap: 14px; font-size: 12px; padding: 2px 0; color: #1c2333; }
    .ps-m { font-weight: 700; white-space: nowrap; }
    .footer { position: fixed; bottom: 4px; left: 48px; right: 48px; border-top: 1px solid #e3e8f0; padding-top: 8px; font-size: 10.5px; color: #6b7487; text-align: center; }
    .watermark {
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%) rotate(-28deg);
      text-align: center; opacity: 0.08; z-index: -1;
      width: 130%; pointer-events: none;
    }
    .watermark img { max-width: 400px; max-height: 280px; display: block; margin: 0 auto 14px; }
    .watermark .wm-name { font-size: 40px; font-weight: 800; color: #1c2333; letter-spacing: 1px; }
    .watermark .wm-line { font-size: 20px; font-weight: 600; color: #1c2333; margin-top: 6px; }
  </style></head><body>
    <div class="watermark">
      ${co.logo ? `<img src="${co.logo}" />` : ''}
      <div class="wm-name">${esc(co.name)}</div>
      ${co.address ? `<div class="wm-line">${esc(co.address)}</div>` : ''}
      ${contact ? `<div class="wm-line">${esc(contact)}</div>` : ''}
    </div>
    <div class="top">
      <div>
        ${logoSur(co.logo) ? `<div><img class="co-logo" src="${esc(co.logo)}" /></div>` : ''}
        <div class="co-name">${esc(co.name)}</div>
        ${co.website ? `<div class="co-line co-site">${esc(co.website)}</div>` : ''}
        ${co.tagline ? `<div class="co-line">${esc(co.tagline)}</div>` : ''}
        ${co.address ? `<div class="co-line">${esc(co.address)}</div>` : ''}
        ${co.phone ? `<div class="co-line">${esc(co.phone)}</div>` : ''}
        ${co.email ? `<div class="co-line">${esc(co.email)}</div>` : ''}
      </div>
      <div class="doc-box">
        <div class="doc-title">${isDevis ? t.devis : t.facture}</div>
        <div class="doc-num">${t.number} ${esc(d.number)}</div>
        <div class="doc-meta">
          ${t.date} : ${fmtDate(d.date, d.lang)}<br/>
          ${validUntil ? `${t.validUntil} : ${fmtDate(validUntil, d.lang)}<br/>` : ''}
          ${source ? `${t.ref} : ${esc(source.number)}` : ''}
        </div>
      </div>
    </div>

    <div class="client-box">
      <div class="client-label">${t.billTo}</div>
      <div class="client-name">${esc(client ? client.name : '—')}</div>
      ${client && client.contact ? `<div class="client-line">${esc(client.contact)}</div>` : ''}
      ${client && client.address ? `<div class="client-line">${esc(client.address)}</div>` : ''}
      ${client && (client.phone || client.email) ? `<div class="client-line">${esc([client.phone, client.email].filter(Boolean).join(' — '))}</div>` : ''}
    </div>

    ${isDevis ? `
    <table>
      <thead><tr>
        <th style="width:52%">${t.desc}</th>
        <th class="num" style="width:10%">${t.qty}</th>
        <th class="num" style="width:19%">${t.unit}</th>
        <th class="num" style="width:19%">${t.amount}</th>
      </tr></thead>
      <tbody>
        ${d.items.map((it) => `<tr>
          <td>${esc(it.desc)}</td>
          <td class="num">${nf.format(Number(it.qty) || 0)}</td>
          <td class="num">${fmtMoney(it.unitPrice)}</td>
          <td class="num">${fmtMoney((Number(it.qty) || 0) * (Number(it.unitPrice) || 0))}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <div class="totals">
      ${(discount > 0 || rounded !== subtotal) ? `
        <div class="row"><span>${t.subtotal}</span><span>${fmtMoney(subtotal)}</span></div>
        ${rounded !== subtotal ? `<div class="row"><span>${t.rounded}</span><span>${fmtMoney(rounded)}</span></div>` : ''}
        ${discount > 0 ? `<div class="row"><span>${t.discount}</span><span>− ${fmtMoney(discount)}</span></div>` : ''}` : ''}
      <div class="row grand"><span>${t.total}</span><span>${fmtMoney(total)}</span></div>
    </div>` : (() => {
      const brut = packTotals(d);
      const lang = d.lang === 'en' ? 'en' : 'fr';
      return PACKS.map(([k, l]) => {
        const note = (d.packNotes && d.packNotes[k]) || '';
        const meta = PACK_META[k];
        const prix = prixPack(d, k);
        const remise = remisePack(d, k);
        const sched = packSchedule(d, k, prix);
        return `
    <div class="pack" style="border-color:${meta.color}">
      <div class="pack-h" style="background:${meta.color}"><span>${meta.symbol} ${l}</span><span>${fmtMoney(prix)}</span></div>
      <div class="pack-b">
        ${remise > 0 ? `<div class="pack-rem">${t.discount} : <s>${fmtMoney(brut[k])}</s> − ${fmtMoney(remise)}</div>` : ''}
        ${note ? `<div class="pack-n">${esc(note)}</div>` : ''}
        <div class="ps">
          <div class="ps-t" style="color:${meta.color}">${t.schedule}</div>
          ${sched.map((m, i) => `<div class="ps-r"><span>${i + 1}. ${PACK_STAGES[k][i][lang]}</span><span class="ps-m">${fmtMoney(m)}</span></div>`).join('')}
        </div>
      </div>
    </div>`;
      }).join('');
    })()}

    ${d.notes ? `<div class="section"><h3>${t.notes}</h3><p>${esc(d.notes)}</p></div>` : ''}
    ${terms ? `<div class="section"><h3>${t.terms}</h3><p>${esc(terms)}</p></div>` : ''}

    <div class="footer">${esc(co.name)}${legal ? ' — ' + esc(legal) : ''}</div>
  </body></html>`;
}

/* ---------- Clients ---------- */

function nbDocsClient(cl) {
  return db.documents.filter((d) => d.clientId === cl.id).length;
}

function clientsFiltres() {
  const f = listFilters.clients;
  const q = normDesc(f.search);
  const chiffres = (v) => String(v || '').replace(/\D+/g, '');
  const num = chiffres(q);
  const liste = db.clients.filter((cl) => {
    if (!q) return true;
    if (num.length >= 3 && chiffres(cl.phone).includes(num)) return true;
    return normDesc(`${cl.name} ${cl.contact} ${cl.phone} ${cl.email}`).includes(q);
  });
  const parNom = (a, b) => normDesc(a.name).localeCompare(normDesc(b.name));
  // « ajout » = l'ordre du tableau, les nouveaux clients restent en haut
  if (f.sort === 'nom') liste.sort(parNom);
  else if (f.sort === 'nom-desc') liste.sort((a, b) => -parNom(a, b));
  else if (f.sort === 'docs') liste.sort((a, b) => nbDocsClient(b) - nbDocsClient(a) || parNom(a, b));
  return liste;
}

function renderClients() {
  const c = editingClient;
  const fc = listFilters.clients;
  main.innerHTML = `
    <div class="view-header">
      <h1>Clients</h1>
      <div class="btn-row">
        ${db.clients.length ? `<button class="btn" id="export-csv">⬇️ Exporter (CSV)</button>` : ''}
        <button class="btn primary" id="new-client">+ Nouveau client</button>
      </div>
    </div>
    ${c ? `
    <div class="panel">
      <h2>${c._new ? 'Nouveau client' : 'Modifier « ' + esc(c.name) + ' »'}</h2>
      <div class="form-grid">
        <div class="field"><label>Nom / Raison sociale *</label><input id="c-name" value="${esc(c.name)}" /></div>
        <div class="field"><label>Personne de contact</label><input id="c-contact" value="${esc(c.contact)}" /></div>
        <div class="field"><label>Téléphone</label><input id="c-phone" value="${esc(c.phone)}" /></div>
      </div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn primary" id="c-save">💾 Enregistrer</button>
        <button class="btn" id="c-cancel">Annuler</button>
        ${c._new ? '' : `<button class="btn danger" id="c-delete">Supprimer</button>`}
      </div>
    </div>` : ''}
    ${db.clients.length ? `<div class="filters">
      <input type="search" id="cl-search" placeholder="🔍 Rechercher un nom, une personne de contact, un téléphone…" value="${esc(fc.search)}" />
      <select id="cl-sort">
        ${TRIS_CLIENT.map(([k, l]) => `<option value="${k}" ${fc.sort === k ? 'selected' : ''}>Tri : ${l}</option>`).join('')}
      </select>
      <span class="filters-info" id="cl-count"></span>
    </div>` : ''}
    <div class="panel" id="clients-zone"></div>`;

  const exportCsv = $('#export-csv');
  if (exportCsv) exportCsv.onclick = async () => {
    // Excel : un texte qui commence par = + - @ serait exécuté comme une formule
    // (on le neutralise) ; un numéro de téléphone serait converti en nombre
    // (« + » et zéros perdus) : on le force en texte avec la forme ="…".
    const csvEsc = (v) => {
      let t = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return '"' + t.replace(/"/g, '""') + '"';
    };
    const csvTexte = (v) => '="' + String(v ?? '').replace(/"/g, '""') + '"';
    const lignes = [
      ['Nom', 'Contact', 'Téléphone'].map(csvEsc),
      ...db.clients.map((cl) => [csvEsc(cl.name), csvEsc(cl.contact), csvTexte(cl.phone)])
    ];
    const csv = '﻿' + lignes.map((l) => l.join(';')).join('\r\n'); // BOM pour Excel
    const res = await window.api.saveTextFile({ defaultName: `clients-iv-devis-${todayIso()}.csv`, content: csv });
    if (res.ok) toast(`✅ ${db.clients.length} clients exportés : ${res.path}`);
    else if (!res.canceled) toast('❌ Erreur export : ' + (res.error || 'inconnue'));
  };

  $('#new-client').onclick = () => {
    editingClient = { id: uid(), name: '', contact: '', address: '', phone: '', email: '', _new: true };
    renderClients();
    $('#c-name').focus();
  };
  // Comme pour les devis, seul le tableau est redessiné pendant la frappe.
  const rafraichirClients = () => {
    const liste = clientsFiltres();
    $('#clients-zone').innerHTML = !db.clients.length
      ? `<div class="empty">Aucun client. Crée ton premier client pour commencer.</div>`
      : (liste.length ? `<table>
        <thead><tr><th>Nom</th><th>Contact</th><th>Téléphone</th><th class="num">Documents</th></tr></thead>
        <tbody>
          ${liste.map((cl) => `<tr class="clickable" data-client="${cl.id}">
            <td><strong>${esc(cl.name)}</strong></td>
            <td>${esc(cl.contact)}</td>
            <td>${esc(cl.phone)}</td>
            <td class="num">${nbDocsClient(cl)}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty">Aucun client ne correspond à cette recherche.</div>`);

    const cpt = $('#cl-count');
    if (cpt) cpt.textContent = fc.search
      ? `${liste.length} résultat${liste.length > 1 ? 's' : ''} sur ${db.clients.length}`
      : `${db.clients.length} client${db.clients.length > 1 ? 's' : ''}`;

    $$('tr[data-client]').forEach((tr) => {
      const ouvrir = () => {
        editingClient = structuredClone(db.clients.find((x) => x.id === tr.dataset.client));
        renderClients();
      };
      tr.tabIndex = 0;
      tr.onclick = ouvrir;
      tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ouvrir(); } };
    });
  };

  const champCl = $('#cl-search');
  if (champCl) champCl.oninput = (e) => { fc.search = e.target.value; rafraichirClients(); };
  const triCl = $('#cl-sort');
  if (triCl) triCl.onchange = (e) => { fc.sort = e.target.value; rafraichirClients(); };
  rafraichirClients();
  if (c) {
    $('#c-save').onclick = async () => {
      c.name = toTitleCase($('#c-name').value.trim());
      if (!c.name) { toast('⚠️ Le nom du client est obligatoire'); return; }
      c.contact = toTitleCase($('#c-contact').value.trim());
      c.phone = $('#c-phone').value.trim();
      delete c._new;
      const idx = db.clients.findIndex((x) => x.id === c.id);
      if (idx >= 0) db.clients[idx] = structuredClone(c);
      else db.clients.unshift(structuredClone(c));
      await persist();
      editingClient = null;
      if (fc.search && !clientsFiltres().some((x) => x.id === c.id)) fc.search = '';
      toast('✅ Client enregistré');
      renderClients();
    };
    $('#c-cancel').onclick = () => { editingClient = null; renderClients(); };
    const del = $('#c-delete');
    if (del) del.onclick = async () => {
      const used = db.documents.filter((d) => d.clientId === c.id).length;
      if (used > 0) { toast(`⚠️ Impossible : ${used} document(s) utilisent ce client`); return; }
      if (!(await window.api.confirmDialog(`Supprimer le client « ${c.name} » ?`))) return;
      db.clients = db.clients.filter((x) => x.id !== c.id);
      noterSuppression('clients', c);
      await persist();
      editingClient = null;
      toast('Client supprimé');
      renderClients();
    };
  }
}

/* ---------- Catalogue (prestations à prix fixes + phrases types) ---------- */

let persistTimer = null;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 500);
}

// Avant de fermer : enregistre ce qui attend encore (catalogue, textes des packs…)
async function viderAttente() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; await enregistrer(); }
}

function renderCatalogue() {
  const sections = [
    { src: 'eq', title: ico('diplome') + 'Section 1 — EQUIVALENCE ET TEST DE LANGUE', list: db.catalog.equivalences },
    { src: 'pr', title: ico('tampon') + 'Section 2 — PROCEDURE', list: db.catalog.services }
  ];
  const phrases = db.catalog.phrases;

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1>Catalogue</h1>
        <div class="sub">Tes prestations à prix fixes (EQUIVALENCE ET TEST DE LANGUE, PROCEDURE) et tes phrases types. Tout est modifiable à tout moment — enregistrement automatique.</div>
      </div>
    </div>
    <div class="filters">
      <input type="search" id="cat-search" placeholder="🔍 Filtrer les prestations…" />
    </div>

    ${sections.map((sec) => `
    <div class="panel cat-panel" data-src="${sec.src}">
      <h2>${sec.title}</h2>
      <p class="hint" style="margin-bottom:12px">Glisse la poignée ⠿ pour réordonner une ligne ou l'envoyer dans l'autre section. Dans un devis, tu pourras cocher ces prestations avec leur quantité.</p>
      ${sec.list.length ? `
      <table class="items-table catalog-table" data-src="${sec.src}">
        <thead><tr><th style="width:30px"></th><th style="width:56%">Désignation</th><th style="width:24%">Prix unitaire (FCFA)</th><th></th></tr></thead>
        <tbody>
          ${sec.list.map((s, i) => `<tr data-i="${i}">
            <td class="grip-cell"><span class="grip" draggable="true" title="Glisser pour déplacer">⠿</span></td>
            <td><input class="cat-desc" value="${esc(s.desc)}" placeholder="Ex. : Évaluation comparative des diplômes" /></td>
            <td><input class="cat-price price" type="text" inputmode="numeric" placeholder="0" value="${Number(s.unitPrice) ? nf.format(Number(s.unitPrice)) : ''}" /></td>
            <td class="cat-actions"><button class="del-line cat-del" title="Supprimer">✕</button></td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty">Aucune prestation — glisse une ligne ici ou clique sur « Ajouter ».</div>`}
      <button class="btn small add-cat" data-src="${sec.src}" style="margin-top:10px">+ Ajouter une prestation</button>
    </div>`).join('')}

    <div class="panel">
      <h2>${ico('texte')}Textes des packs (facture)</h2>
      <p class="hint" style="margin-bottom:12px">Ces textes s'affichent <strong>automatiquement</strong> sous chaque pack à la création d'une facture. Modifie-les ici à tout moment — chaque facture déjà créée garde sa propre copie, retouchable au cas par cas.</p>
      ${PACKS.map(([k, l]) => `
      <div class="pack-card" style="border-color:${packTeinte(k)}; border-left-width:5px; background:${packFond(k)}">
        <div class="pack-head"><strong style="color:${packTeinte(k)}">${PACK_META[k].symbol} ${l}</strong></div>
        <textarea class="packtext" data-pack="${k}" placeholder="Texte automatique sous ce pack sur la facture…">${esc(db.catalog.packTexts[k])}</textarea>
      </div>`).join('')}
    </div>

    <div class="panel">
      <h2>${ico('message')}Phrases pré-enregistrées</h2>
      <p class="hint" style="margin-bottom:12px">Elles apparaissent dans un menu déroulant à la création d'un devis ou d'une facture, pour être ajoutées en bas du document.</p>
      <div id="phrases-list">
        ${phrases.length ? phrases.map((p, i) => `
        <div class="phrase-row" data-i="${i}">
          <textarea class="phrase-text" placeholder="Ex. : Acompte de 50 % à la commande, solde à la livraison.">${esc(p.text)}</textarea>
          <button class="del-line ph-del" title="Supprimer">✕</button>
        </div>`).join('') : `<div class="empty">Aucune phrase enregistrée pour le moment.</div>`}
      </div>
      <button class="btn small" id="add-phrase" style="margin-top:10px">+ Ajouter une phrase</button>
    </div>`;

  sections.forEach((sec) => {
    $$(`.catalog-table[data-src="${sec.src}"] tr[data-i]`).forEach((tr) => {
      const s = sec.list[Number(tr.dataset.i)];
      $('.cat-desc', tr).oninput = (e) => { s.desc = e.target.value; schedulePersist(); };
      $('.cat-price', tr).oninput = (e) => { s.unitPrice = formatMoneyInput(e.target); schedulePersist(); };
      $('.cat-del', tr).onclick = async () => {
        if (s.desc.trim() && !(await window.api.confirmDialog(`Supprimer « ${s.desc} » du catalogue ?`))) return;
        sec.list.splice(Number(tr.dataset.i), 1);
        await persist();
        renderCatalogue();
      };
    });
  });
  // Filtre de recherche : masque les lignes sans toucher aux données ni aux index
  $('#cat-search').oninput = (e) => {
    const q = normDesc(e.target.value);
    $$('.catalog-table tr[data-i]').forEach((tr) => {
      tr.style.display = !q || normDesc($('.cat-desc', tr).value).includes(q) ? '' : 'none';
    });
  };

  // Glisser-déposer : réordonner dans une section ou basculer vers l'autre
  const lists = { eq: db.catalog.equivalences, pr: db.catalog.services };
  let dragFrom = null;
  let dropAt = null;

  const clearMarks = () => {
    $$('.catalog-table tr').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    $$('.cat-panel').forEach((pn) => pn.classList.remove('drag-over'));
  };

  $$('.catalog-table .grip').forEach((g) => {
    g.ondragstart = (e) => {
      const tr = g.closest('tr');
      dragFrom = { src: tr.closest('table').dataset.src, i: Number(tr.dataset.i) };
      e.dataTransfer.setData('text/plain', 'move');
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => tr.classList.add('dragging'), 0);
    };
    g.ondragend = () => {
      clearMarks();
      $$('.catalog-table tr').forEach((r) => r.classList.remove('dragging'));
      dragFrom = null;
      dropAt = null;
    };
  });

  $$('.cat-panel').forEach((panel) => {
    const src = panel.dataset.src;
    panel.ondragover = (e) => {
      if (!dragFrom) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearMarks();
      const tr = e.target.closest ? e.target.closest('tr[data-i]') : null;
      if (tr && tr.closest('table').dataset.src === src) {
        const rect = tr.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        tr.classList.add(before ? 'drop-before' : 'drop-after');
        dropAt = { src, index: Number(tr.dataset.i) + (before ? 0 : 1) };
      } else {
        panel.classList.add('drag-over');
        dropAt = { src, index: lists[src].length };
      }
    };
    panel.ondrop = async (e) => {
      e.preventDefault();
      if (!dragFrom || !dropAt) return;
      const item = lists[dragFrom.src].splice(dragFrom.i, 1)[0];
      let idx = dropAt.index;
      if (dropAt.src === dragFrom.src && dragFrom.i < idx) idx--;
      lists[dropAt.src].splice(idx, 0, item);
      dragFrom = null;
      dropAt = null;
      await persist();
      renderCatalogue();
    };
  });

  $$('.add-cat').forEach((btn) => {
    btn.onclick = async () => {
      const sec = sections.find((x) => x.src === btn.dataset.src);
      // une nouvelle prestation entre par défaut dans les trois packs
      sec.list.unshift({ id: uid(), desc: '', unitPrice: 0, packs: { premium: true, access: true, standard: true } });
      await persist();
      renderCatalogue();
      const premiere = $(`.catalog-table[data-src="${sec.src}"] tr[data-i="0"] .cat-desc`);
      if (premiere) { premiere.focus(); premiere.scrollIntoView({ block: 'center' }); }
    };
  });

  $$('.packtext').forEach((ta) => {
    ta.oninput = () => {
      db.catalog.packTexts[ta.dataset.pack] = ta.value;
      schedulePersist();
    };
  });
  bindAutoGrow('.packtext');
  bindAutoGrow('.phrase-text');

  $$('.phrase-row').forEach((row) => {
    const p = phrases[Number(row.dataset.i)];
    $('.phrase-text', row).oninput = (e) => { p.text = e.target.value; schedulePersist(); };
    $('.ph-del', row).onclick = async () => {
      if (p.text.trim() && !(await window.api.confirmDialog('Supprimer cette phrase ?'))) return;
      phrases.splice(Number(row.dataset.i), 1);
      await persist();
      renderCatalogue();
    };
  });
  $('#add-phrase').onclick = async () => {
    phrases.unshift({ id: uid(), text: '' });
    await persist();
    renderCatalogue();
    const premiere = $('.phrase-row[data-i="0"] .phrase-text');
    if (premiere) { premiere.focus(); premiere.scrollIntoView({ block: 'center' }); }
  };
}

/* ---------- Packs : composition de chaque offre ---------- */

function renderPacks() {
  const sections = [
    { src: 'eq', titre: ico('diplome') + 'EQUIVALENCE ET TEST DE LANGUE', liste: db.catalog.equivalences },
    { src: 'pr', titre: ico('tampon') + 'PROCEDURE', liste: db.catalog.services }
  ];
  const toutes = [...db.catalog.equivalences, ...db.catalog.services];
  const drapeaux = (s) => s.packs || packsParDefaut(s);
  const compte = (k) => toutes.filter((s) => drapeaux(s)[k]).length;

  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1>Composition des packs</h1>
        <div class="sub">Coche les prestations que chaque pack doit couvrir. Les prix des devis et des factures se recalculent aussitôt.</div>
      </div>
    </div>

    <div class="stat-grid">
      ${PACKS.map(([k, l]) => `
      <div class="stat-card" style="border-left:5px solid ${packTeinte(k)}">
        <div class="label">${PACK_META[k].symbol} ${l}</div>
        <div class="value">${compte(k)} <span style="font-size:13px; font-weight:400; color:var(--muted)">prestation${compte(k) > 1 ? 's' : ''} sur ${toutes.length}</span></div>
      </div>`).join('')}
    </div>

    <div class="filters">
      <input type="search" id="packs-search" placeholder="🔍 Filtrer les prestations…" />
    </div>

    <div class="panel">
      <table class="packs-table">
        <thead>
          <tr>
            <th style="width:46%">Désignation</th>
            <th class="num" style="width:16%">Prix unitaire</th>
            ${PACKS.map(([k, l]) => `<th class="pk-col" style="color:${packTeinte(k)}">${PACK_META[k].symbol}<br/>${l.replace('PACK ', '')}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${sections.map((sec) => sec.liste.length ? `
            <tr class="pk-group"><td colspan="5">${sec.titre}</td></tr>
            ${sec.liste.map((s, i) => `
            <tr data-src="${sec.src}" data-i="${i}">
              <td class="pk-desc">${esc(s.desc)}</td>
              <td class="num">${fmtMoney(s.unitPrice)}</td>
              ${PACKS.map(([k]) => `<td class="pk-col"><input type="checkbox" class="pk-flag" data-pack="${k}" ${drapeaux(s)[k] ? 'checked' : ''} /></td>`).join('')}
            </tr>`).join('')}` : '').join('')}
        </tbody>
      </table>
      ${toutes.length ? '' : `<div class="empty">Ton catalogue est vide — ajoute des prestations dans l'onglet Catalogue.</div>`}
    </div>

    <div class="panel">
      <p class="hint" style="margin:0">
        💡 Les honoraires restent réduits de 37,5 % dans le PACK ACCESS, où qu'ils soient cochés.
        Une prestation ajoutée directement dans un devis (hors catalogue) entre par défaut dans les trois packs.
        <strong>Attention :</strong> une modification ici change aussi le montant des factures déjà créées si tu les rouvres.
      </p>
    </div>`;

  $$('.packs-table tr[data-src]').forEach((tr) => {
    const liste = tr.dataset.src === 'eq' ? db.catalog.equivalences : db.catalog.services;
    const s = liste[Number(tr.dataset.i)];
    $$('.pk-flag', tr).forEach((chk) => {
      chk.onchange = async () => {
        s.packs = s.packs || packsParDefaut(s);
        s.packs[chk.dataset.pack] = chk.checked;
        const filtre = ($('#packs-search') || {}).value || '';
        await persist();
        renderPacks();
        // on remet le filtre en place : le décocher une ligne ne doit pas
        // renvoyer l'utilisateur au début d'une longue liste
        const champ = $('#packs-search');
        if (champ && filtre) { champ.value = filtre; champ.oninput({ target: champ }); }
      };
    });
  });

  $('#packs-search').oninput = (e) => {
    const q = normDesc(e.target.value);
    $$('.packs-table tr[data-src]').forEach((tr) => {
      tr.style.display = !q || normDesc($('.pk-desc', tr).textContent).includes(q) ? '' : 'none';
    });
  };
}

/* ---------- Paramètres ---------- */

function renderSettings() {
  const co = db.settings.company;
  main.innerHTML = `
    <div class="view-header">
      <div>
        <h1>Paramètres</h1>
        <div class="sub">Ces informations apparaissent sur tous tes devis et factures.</div>
      </div>
      <button class="btn primary" id="s-save">💾 Enregistrer</button>
    </div>
    <div class="panel">
      <h2>Identité de l'entreprise</h2>
      <div class="form-grid">
        <div class="field"><label>Nom / Raison sociale</label><input id="s-name" value="${esc(co.name)}" /></div>
        <div class="field"><label>Slogan / Activité</label><input id="s-tagline" value="${esc(co.tagline)}" placeholder="Ex. : Immigrer autrement" /></div>
        <div class="field"><label>Site internet</label><input id="s-website" value="${esc(co.website)}" placeholder="Ex. : immigration-voyages.com" /></div>
        <div class="field"><label>Téléphone</label><input id="s-phone" value="${esc(co.phone)}" /></div>
        <div class="field"><label>Email</label><input id="s-email" value="${esc(co.email)}" /></div>
        <div class="field full"><label>Adresse</label><input id="s-address" value="${esc(co.address)}" /></div>
        <div class="field"><label>RCCM</label><input id="s-rccm" value="${esc(co.rccm)}" /></div>
        <div class="field"><label>NIU (n° contribuable)</label><input id="s-niu" value="${esc(co.niu)}" /></div>
      </div>
    </div>
    <div class="panel">
      <h2>Logo</h2>
      ${co.logo ? `<img class="logo-preview" src="${co.logo}" />` : `<div class="logo-placeholder">Aucun logo — il apparaîtra en haut de tes PDF</div>`}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" id="s-logo">📁 Choisir un logo…</button>
        ${co.logo ? `<button class="btn danger" id="s-logo-del">Retirer le logo</button>` : ''}
      </div>
    </div>
    ${MOBILE ? '' : `<div class="panel">
      <h2>${ico('sauvegarde')}Sauvegardes</h2>
      <p class="hint" style="margin-bottom:12px">À chaque lancement, une copie datée de tes données est gardée dans le dossier local <strong>sauvegardes</strong> (les 30 dernières). Indique ci-dessous un dossier synchronisé (MEGA, Google Drive, OneDrive…) pour avoir en plus une copie hors du PC.</p>
      <div class="field full">
        <label>Dossier de sauvegarde cloud</label>
        <input id="s-clouddir" value="${esc(db.settings.cloudBackupDir || '')}" placeholder="Ex. : C:\\Users\\Alex NG\\Documents\\MEGA\\IV Devis" />
      </div>
      <div class="field full" style="margin-top:12px">
        <label>Dossier des PDF exportés (devis et factures envoyés)</label>
        <input id="s-exportsdir" value="${esc(db.settings.exportsDir || '')}" placeholder="Vide = dossier interne. Mets un dossier MEGA partagé pour que les PDF soient visibles sur un autre poste." />
      </div>
    </div>`}
    ${panneauAppareilHtml()}

    <div class="panel">
      <h2>${ico('site')}Site Immigration Voyages <span class="hint">devis &amp; factures partagés avec /gestion</span></h2>
      ${syncOn() ? `
        <p class="hint" style="margin-bottom:12px">Connecté en tant que <strong>${esc(db.settings.syncEmail || '')}</strong>.${db.settings.syncLastAt ? ' Dernière synchronisation : ' + new Date(db.settings.syncLastAt).toLocaleString('fr-FR') + '.' : ''}<br>
        Dans les deux sens : <strong>Envoyer</strong> copie ici → site, <strong>Récupérer</strong> copie site → ici ce qui manque. Un document modifié des deux côtés : la version la plus récente gagne, l'autre est gardée dans l'historique${(db.historique || []).length ? ' (' + db.historique.length + ' ancienne(s) version(s) gardée(s))' : ''}. Le statut posé sur le site reste prioritaire. Une suppression ne passe jamais de l'autre côté.</p>
        <div class="btn-row">
          <button class="btn primary" id="s-sync-push">⬆ Envoyer maintenant vers le site</button>
          <button class="btn" id="s-sync-pull">⬇ Récupérer depuis le site</button>
          <button class="btn danger" id="s-sync-logout">Se déconnecter</button>
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:13px" class="hint">
          <input type="checkbox" id="s-sync-auto" style="width:17px;height:17px" ${db.settings.syncAuto ? 'checked' : ''} />
          Synchroniser automatiquement (envoi après chaque modification, récupération à l'ouverture puis toutes les 10 minutes)
        </label>` : `
        <p class="hint" style="margin-bottom:12px">Connecte-toi avec ton compte de l'<strong>espace de gestion du site</strong> (même email/mot de passe que sur immigration-voyages.com/gestion) : tes devis et factures seront copiés dans /gestion et visibles par toute l'équipe.</p>
        <div class="form-grid">
          <div class="field"><label>Email</label><input type="email" id="s-sync-email" value="${esc(db.settings.syncEmail || '')}" autocomplete="off" /></div>
          <div class="field"><label for="s-sync-pass">Mot de passe</label>${champMotDePasse('id="s-sync-pass" autocomplete="off"')}</div>
        </div>
        <p class="hint" id="s-sync-err" style="color:#c00;font-weight:600"></p>
        <button class="btn primary" id="s-sync-login">Se connecter au site</button>`}
    </div>

    ${MOBILE ? '' : `<div class="panel">
      <h2>${ico('archive')}Sauvegarde complète sur le site</h2>
      <p class="hint" style="margin-bottom:12px">La synchronisation ci-dessus n'envoie que les <strong>clients et les documents</strong>. Cette sauvegarde-ci envoie <strong>tout</strong> : catalogue et prix, composition des packs, textes des packs, phrases, fiche entreprise et logo. Elle est réservée à l'administrateur et les ${SAUVEGARDES_GARDEES} dernières sont conservées.${db.settings.backupLastAt ? `<br>Dernière sauvegarde complète : <strong>${new Date(db.settings.backupLastAt).toLocaleString('fr-FR')}</strong>.` : '<br><strong>Aucune sauvegarde complète pour le moment.</strong>'}</p>
      ${syncOn() ? `
      <div class="btn-row">
        <button class="btn primary" id="s-backup-push">⬆ Sauvegarder tout maintenant</button>
        <button class="btn" id="s-backup-get">⬇ Télécharger la dernière sauvegarde</button>
      </div>` : `<p class="hint">Connecte-toi au site (encadré ci-dessus) pour activer la sauvegarde complète.</p>`}
    </div>`}

    <div class="panel">
      <h2>Conditions</h2>
      <div class="form-grid">
        <div class="field"><label>Validité des devis (jours)</label><input type="number" min="0" id="s-validity" value="${co.validityDays}" /></div>
        <div class="field"><label>Numéro d'envoi par défaut (si client sans numéro)</label><input id="s-fallback" value="${esc(co.fallbackPhone)}" placeholder="+237 6XX XX XX XX" /></div>
        <div class="field full"><label>Conditions de paiement (français)</label><textarea id="s-terms-fr">${esc(co.paymentTermsFr)}</textarea></div>
        <div class="field full"><label>Conditions de paiement (anglais)</label><textarea id="s-terms-en">${esc(co.paymentTermsEn)}</textarea></div>
      </div>
    </div>

    <div class="panel">
      <h2>${ico('fichier')}Numérotation</h2>
      ${MOBILE ? `<p class="hint" style="margin-bottom:12px">Le code de cet appareil termine le numéro de chaque devis et facture créés ici (<strong>DEV-2026-021-${esc(codePoste() || 'T1')}</strong>) : ils ne reprennent jamais ceux de l'ordinateur ni des autres postes. Ne le change que pour un code libre ; les numéros déjà émis ne changent pas.</p>` : `<p class="hint" style="margin-bottom:12px">Deux PC qui travaillent en même temps créent chacun un <strong>DEV-2026-021</strong> : deux documents différents portant le même numéro. Donne une lettre au poste secondaire, ses documents deviendront <strong>DEV-2026-021-S</strong>. Laisse vide sur le poste principal. Les numéros déjà émis ne changent pas.</p>`}
      <div class="form-grid">
        <div class="field"><label>Code de ce poste (1 à 3 caractères)</label><input id="s-poste" maxlength="3" value="${esc(db.settings.poste || '')}" placeholder="vide = poste principal" /></div>
        <div class="field"><label>Prochain devis créé ici</label><input id="s-poste-apercu" value="" disabled /></div>
      </div>
    </div>

    <div class="panel">
      <h2>${ico('verrou')}Verrou d'ouverture (optionnel)</h2>
      <p class="hint" style="margin-bottom:12px">${db.settings.lockHash
        ? 'Le verrou est <strong>activé</strong> : le mot de passe est demandé à chaque ouverture du logiciel.'
        : 'Aucun verrou : le logiciel s\'ouvre librement. Active un mot de passe si d\'autres personnes utilisent ce PC.'} Tu peux l'activer, le changer ou le retirer à tout moment.</p>
      <div class="btn-row">
        ${verrouActif() ? `
        <button class="btn" id="lock-change">Changer le mot de passe</button>
        <button class="btn danger" id="lock-off">Désactiver le verrou</button>` : `
        <button class="btn primary" id="lock-on">Activer un mot de passe</button>`}
      </div>
    </div>

    <div class="panel">
      <h2>${ico('apparence')}Apparence</h2>
      <p class="hint" style="margin-bottom:12px">Le mode sombre repose les yeux en soirée. Ton choix est mémorisé ; les PDF envoyés aux clients restent toujours sur fond blanc.</p>
      <div class="theme-choix">
        <button type="button" class="theme-btn ${modeSombre() ? '' : 'actif'}" data-theme="clair"><span class="theme-apercu clair"></span>Clair</button>
        <button type="button" class="theme-btn ${modeSombre() ? 'actif' : ''}" data-theme="sombre"><span class="theme-apercu sombre"></span>Sombre</button>
      </div>
    </div>
    ${panneauMajHtml()}
    <div class="panel about-panel">
      <h2>${ico('info')}À propos</h2>
      <div class="about-flex">
        <img src="assets/logo-256.png" alt="" class="about-logo" />
        <div>
          <p class="about-name">IV Devis</p>
          <p class="about-line">Version ${esc(appInfo.version || '—')} · dernière mise à jour : ${esc(appInfo.updated || '—')}</p>
          <p class="about-line">Conçu par <strong>Alex NGASSA</strong> pour Immigration Voyages</p>
          <p class="about-line">© ${new Date().getFullYear()} Immigration Voyages — Tous droits réservés</p>
        </div>
      </div>
    </div>`;

  brancherPanneauMaj();
  brancherPanneauAppareil();
  $('#s-save').onclick = async () => {
    co.name = $('#s-name').value.trim();
    co.tagline = $('#s-tagline').value.trim();
    co.website = $('#s-website').value.trim();
    co.phone = $('#s-phone').value.trim();
    co.email = $('#s-email').value.trim();
    co.address = $('#s-address').value.trim();
    co.rccm = $('#s-rccm').value.trim();
    co.niu = $('#s-niu').value.trim();
    co.validityDays = Number($('#s-validity').value) || 0;
    co.fallbackPhone = $('#s-fallback').value.trim();
    co.paymentTermsFr = $('#s-terms-fr').value;
    co.paymentTermsEn = $('#s-terms-en').value;
    if ($('#s-clouddir')) db.settings.cloudBackupDir = $('#s-clouddir').value.trim();
    if ($('#s-exportsdir')) db.settings.exportsDir = $('#s-exportsdir').value.trim();
    const poste = ($('#s-poste').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    // un appareil ne prend jamais un code vide ni celui d'un autre poste (paquet.js)
    const refusPoste = MOBILE && typeof PAQUET !== 'undefined' ? PAQUET.refusCodeAppareil(poste, db, [db.settings.poste]) : '';
    if (refusPoste) { toast('⚠️ ' + refusPoste, 6000); return; }
    db.settings.poste = poste;
    await persist();
    toast('✅ Paramètres enregistrés');
  };
  // aperçu du prochain numéro, mis à jour pendant la frappe
  const champPoste = $('#s-poste');
  if (champPoste) {
    const majApercu = () => {
      const code = champPoste.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
      if (champPoste.value !== code) champPoste.value = code;
      const cible = $('#s-poste-apercu');
      if (cible) cible.value = baseNumero('devis') + (code ? '-' + code : '');
    };
    champPoste.oninput = majApercu;
    majApercu();
  }

  const syncLogin = $('#s-sync-login');
  if (syncLogin) syncLogin.onclick = async () => {
    const email = ($('#s-sync-email').value || '').trim();
    const pass = $('#s-sync-pass').value;
    const err = $('#s-sync-err');
    if (!email || !pass) { if (err) err.textContent = 'Saisis ton email et ton mot de passe.'; return; }
    try {
      await sbAuth({ email, password: pass }, 'password');
      db.settings.syncEmail = email;
      await enregistrer();
      renderSettings();
      toast('✅ Connecté au site — tu peux envoyer tes documents');
    } catch (e) {
      if (err) err.textContent = /invalid/i.test(e.message) ? 'Email ou mot de passe incorrect.' : 'Connexion impossible : ' + e.message;
    }
  };
  const syncPush = $('#s-sync-push');
  if (syncPush) syncPush.onclick = async () => {
    syncPush.disabled = true;
    syncPush.textContent = '⏳ Envoi en cours…';
    try { await pushVersSite(false); }
    catch (e) { toast('Envoi impossible : ' + e.message); }
    syncPush.disabled = false;
    syncPush.textContent = '⬆ Envoyer maintenant vers le site';
  };
  const syncPull = $('#s-sync-pull');
  if (syncPull) syncPull.onclick = async () => {
    syncPull.disabled = true;
    syncPull.textContent = '⏳ Récupération en cours…';
    try { await recupererDuSite(false); }
    catch (e) { toast('Récupération impossible : ' + e.message); }
    syncPull.disabled = false;
    syncPull.textContent = '⬇ Récupérer depuis le site';
  };
  const syncLogout = $('#s-sync-logout');
  if (syncLogout) syncLogout.onclick = async () => {
    // on prévient le serveur : la session est réellement fermée, pas seulement oubliée ici
    try {
      if (sbToken) await fetchDelai(`${SB_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: SB_KEY, Authorization: 'Bearer ' + sbToken }
      }, 8000);
    } catch (e) { /* hors ligne : on se déconnecte quand même localement */ }
    await memoriserJeton(''); sbToken = null;
    renderSettings();
    toast('Déconnecté du site (tes données locales sont conservées).');
  };
  const syncAuto = $('#s-sync-auto');
  if (syncAuto) syncAuto.onchange = async () => {
    db.settings.syncAuto = syncAuto.checked;
    await enregistrer();
    if (syncAuto.checked) { demarrerSynchroAuto(); synchroniser(true).catch(() => {}); }
  };

  $$('.theme-btn').forEach((b) => {
    b.onclick = async () => {
      db.settings.theme = b.dataset.theme;
      appliquerTheme();
      await enregistrer();
      renderSettings();
    };
  });

  const backupPush = $('#s-backup-push');
  if (backupPush) backupPush.onclick = async () => {
    backupPush.disabled = true;
    backupPush.textContent = '⏳ Sauvegarde en cours…';
    try { await sbBackupPush(); }
    catch (e) { toast('Sauvegarde impossible : ' + e.message); }
    backupPush.disabled = false;
    backupPush.textContent = '⬆ Sauvegarder tout maintenant';
  };
  const backupGet = $('#s-backup-get');
  if (backupGet) backupGet.onclick = async () => {
    try { await sbBackupDownload(); }
    catch (e) { toast('Téléchargement impossible : ' + e.message); }
  };

  const lockOn = $('#lock-on');
  if (lockOn) lockOn.onclick = async () => {
    const p1 = await askText('Choisis un mot de passe :', 'password');
    if (!p1) return;
    const p2 = await askText('Confirme le mot de passe :', 'password');
    if (p1 !== p2) { toast('⚠️ Les deux saisies ne correspondent pas'); return; }
    await poserVerrou(p1);
    await persist();
    renderSettings();
    toast('🔒 Verrou activé — il sera demandé à la prochaine ouverture');
  };
  const lockChange = $('#lock-change');
  if (lockChange) lockChange.onclick = async () => {
    const cur = await askText('Mot de passe actuel :', 'password');
    if (cur === null) return;
    if (!(await verifierMdp(cur))) { toast('⚠️ Mot de passe actuel incorrect'); return; }
    const p1 = await askText('Nouveau mot de passe :', 'password');
    if (!p1) return;
    const p2 = await askText('Confirme le nouveau mot de passe :', 'password');
    if (p1 !== p2) { toast('⚠️ Les deux saisies ne correspondent pas'); return; }
    await poserVerrou(p1);
    await persist();
    toast('🔒 Mot de passe changé');
  };
  const lockOff = $('#lock-off');
  if (lockOff) lockOff.onclick = async () => {
    const cur = await askText('Mot de passe actuel :', 'password');
    if (cur === null) return;
    if (!(await verifierMdp(cur))) { toast('⚠️ Mot de passe incorrect'); return; }
    delete db.settings.lockHash;
    delete db.settings.lock;
    await persist();
    renderSettings();
    toast('🔓 Verrou désactivé');
  };

  $('#s-logo').onclick = async () => {
    const logo = await window.api.pickLogo();
    if (logo && logo.error) { toast('⚠️ ' + logo.error); return; }
    if (logo) {
      co.logo = logo;
      await persist();
      renderSettings();
      toast('✅ Logo mis à jour');
    }
  };
  const logoDel = $('#s-logo-del');
  if (logoDel) logoDel.onclick = async () => {
    co.logo = '';
    await persist();
    renderSettings();
  };
}

/* ================= Synchronisation avec le site (/gestion — Supabase) =================
   Même mécanisme que IV Clients : connexion avec le compte de /gestion, envoi
   incrémental vers les tables clients/documents du site — avec les MÊMES règles
   que l'outil d'import de /gestion (clients dédupliqués par nom, empreintes
   anti-doublon, numéros en conflit renumérotés avec trace ancienNumero).
   Dans les deux sens : l'envoi (IV Devis → site) et la récupération
   (site → IV Devis) ajoutent ce qui manque de l'autre côté. Un document modifié
   des deux côtés : le plus récent gagne, l'autre version est gardée dans
   db.historique. Le statut posé sur le site reste prioritaire. Aucune
   suppression n'est propagée, dans aucun sens. */
const SB_URL = 'https://uhfjegbrodjlcmgjicfo.supabase.co';
const SB_KEY = 'sb_publishable_HtJiHb8I9Bl8YlUmQnIzEw_2haEckGz';

let sbToken = null, sbTokenExp = 0, autoPushTimer = null;
// Jeton de rafraîchissement : en mémoire + chiffré par Windows dans secrets\,
// jamais dans data.json (donc jamais dans les sauvegardes, le cloud ou le site).
let sbRefresh = '';

const syncOn = () => !!sbRefresh;

async function memoriserJeton(jeton) {
  sbRefresh = jeton || '';
  try { await window.api.setSecret('sync', sbRefresh); } catch (e) { /* mode navigateur */ }
}

// Un appel réseau qui n'aboutit pas doit rendre la main : sans délai d'attente,
// une coupure laisse le bouton « Envoi en cours… » bloqué indéfiniment.
async function fetchDelai(url, options = {}, ms = 20000) {
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('le site ne répond pas (délai dépassé)');
    throw e;
  } finally {
    clearTimeout(minuteur);
  }
}

async function sbAuth(body, grant) {
  const r = await fetchDelai(`${SB_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SB_KEY },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description || j.msg || j.error || ('HTTP ' + r.status));
    e.authRefusee = r.status === 400 || r.status === 401 || r.status === 403;
    throw e;
  }
  sbToken = j.access_token;
  sbTokenExp = Date.now() + ((j.expires_in || 3600) - 120) * 1000;
  if (j.refresh_token) await memoriserJeton(j.refresh_token);
  return j;
}

async function sbSession() {
  if (sbToken && Date.now() < sbTokenExp) return;
  if (!sbRefresh) throw new Error('connectez-vous dans Paramètres → Site Immigration Voyages');
  try {
    await sbAuth({ refresh_token: sbRefresh }, 'refresh_token');
  } catch (e) {
    // On ne jette le jeton QUE si le serveur l'a explicitement refusé.
    // Une coupure internet (fetch qui échoue) ne déconnecte JAMAIS : on
    // réessaiera au prochain cycle — indispensable avec un réseau instable.
    if (e && e.authRefusee) {
      await memoriserJeton(''); sbToken = null;
      throw new Error('session expirée — reconnectez-vous dans les Paramètres');
    }
    throw new Error('connexion internet indisponible — nouvel essai à la prochaine synchronisation');
  }
}

async function sbRest(path, opts = {}) {
  await sbSession();
  const r = await fetchDelai(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + sbToken, ...(opts.headers || {}) }
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.message || ('HTTP ' + r.status));
  }
  // « Prefer: return=minimal » répond 201 avec un corps vide : pas de JSON à lire
  const texte = await r.text();
  return texte.trim() ? JSON.parse(texte) : null;
}

// Une seule synchronisation à la fois (auto + manuel + récupération + sauvegarde 12 h se chevauchaient)
let syncEnCours = false;
let syncAutoTimer = null;

function scheduleAutoPush() {
  if (!db || !db.settings.syncAuto || !syncOn()) return;
  clearTimeout(autoPushTimer);
  autoPushTimer = setTimeout(() => { pushVersSite(true).catch(() => {}); }, 8000);
}

// Récupération automatique : au démarrage (après 15 s) puis toutes les 10 minutes,
// seulement quand la synchronisation automatique est cochée et la session ouverte.
const SYNCHRO_PERIODE = 10 * 60 * 1000;
function demarrerSynchroAuto() {
  if (syncAutoTimer) return;
  const tour = () => { if (db && db.settings.syncAuto && syncOn()) synchroniser(true).catch(() => {}); };
  setTimeout(tour, 15000);
  syncAutoTimer = setInterval(tour, SYNCHRO_PERIODE);
}

async function pushVersSite(silencieux) {
  if (!db.clients.length && !db.documents.length) { if (!silencieux) toast('Rien à envoyer.'); return; }
  if (syncEnCours) { if (!silencieux) toast('Un envoi est déjà en cours…'); return; }
  syncEnCours = true;
  try {
    await pushVersSiteInterne(silencieux);
  } finally {
    syncEnCours = false;
  }
}

// Bouton « Récupérer depuis le site »
async function recupererDuSite(silencieux) {
  if (syncEnCours) { if (!silencieux) toast('Une synchronisation est déjà en cours…'); return null; }
  syncEnCours = true;
  try {
    const bilan = await recupererDuSiteInterne();
    annoncerRecuperation(bilan, silencieux);
    return bilan;
  } finally {
    syncEnCours = false;
  }
}

// Synchronisation complète (automatique) : on récupère d'abord, puis on envoie.
async function synchroniser(silencieux) {
  if (syncEnCours) return null;
  syncEnCours = true;
  try {
    const bilan = await recupererDuSiteInterne();
    if (db.clients.length || db.documents.length) await pushVersSiteInterne(true);
    annoncerRecuperation(bilan, silencieux);
    return bilan;
  } finally {
    syncEnCours = false;
  }
}

/* ---------- Outils communs à l'envoi et à la récupération ---------- */

// clé d'identité d'un client : nom, complété du téléphone quand il existe (deux
// homonymes avec des numéros différents ne sont pas fusionnés)
const chiffres = (v) => String(v || '').replace(/\D/g, '');
const cleClient = (nom, tel) => normDesc(nom) + (chiffres(tel) ? '|' + chiffres(tel) : '');
const empreinteDoc = (type, data) => [type, normDesc(data.clientName), data.date || '',
  String(data.total ?? ''), JSON.stringify(data.lignes || [])].join('|');

// Fiche client telle que le site la range (clients.data)
const ficheClientSite = (cl) => ({
  name: toTitleCase(cl.name || ''),
  phone: cl.phone || '',
  email: cl.email || '',
  city: cl.address || '',
  notes: cl.contact ? 'Contact : ' + cl.contact : (cl.notes || ''),
});
// …et en sens inverse, au format de l'application
function clientDepuisSite(d) {
  const notes = String(d.notes || '');
  const contact = /^Contact : /.test(notes) ? notes.slice(10) : '';
  return { name: String(d.name || '').trim(), phone: d.phone || '', email: d.email || '',
    address: d.city || '', contact, notes: contact ? '' : notes };
}
const vueClient = (f) => JSON.stringify([normDesc(f.name), chiffres(f.phone),
  String(f.email || '').trim().toLowerCase(), String(f.city || '').trim(), String(f.notes || '').trim()]);

// Contenu d'un document tel que le site le range (documents.data)
function contenuSite(doc, sourceNumero) {
  const type = doc.type === 'facture' ? 'facture' : 'devis';
  const tot = docTotals(doc);
  // les quantités partent telles quelles (entières) ; une ligne à 0 ne compte
  // pas dans le total local, elle ne part donc pas non plus
  const lgs = (doc.items || [])
    .map((it) => ({ designation: it.desc || '', qte: Math.max(0, Math.trunc(+it.qty || 0)), pu: +it.unitPrice || 0 }))
    .filter((l) => l.qte > 0 || l.designation.trim());
  const client = clientOf(doc);
  const contenu = {
    desktopId: String(doc.id),
    clientName: client ? toTitleCase(client.name || '') : '',
    date: (doc.date || '').slice(0, 10),
    statut: doc.status || 'brouillon',
    lignes: lgs,
    remise: +doc.discount || 0,
    sousTotal: tot.subtotal,
    arrondi: tot.rounded,
    total: tot.total,
    notes: doc.notes || '',
    lang: doc.lang || 'fr',
    syncLe: new Date().toISOString().slice(0, 10),
  };
  if (type === 'facture') {
    contenu.sourceNumero = sourceNumero || '';
    contenu.chosenPack = doc.chosenPack || 'premium';
    contenu.packNotes = doc.packNotes || (db.catalog && db.catalog.packTexts) || {};
    // l'application fait foi : le site affiche CES montants, il ne les recalcule pas
    contenu.forfaitEquipe = !!doc.forfaitEquipe;
    contenu.packs = {};
    for (const [k] of PACKS) {
      contenu.packs[k] = { prix: prixPack(doc, k), remise: remisePack(doc, k), tranches: packSchedule(doc, k, prixPack(doc, k)) };
    }
  }
  return contenu;
}

// Ce qui fait qu'un document a « changé » (le statut est traité à part ; les
// montants des packs et les textes des packs se déduisent du reste)
function vueDoc(type, d) {
  const v = [normDesc(d.clientName), String(d.date || ''),
    (d.lignes || []).map((l) => [String(l.designation || ''), Number(l.qte) || 0, Number(l.pu) || 0]),
    Number(d.remise) || 0, String(d.notes || ''), d.lang || 'fr'];
  if (type === 'facture') v.push(d.chosenPack || 'premium', !!d.forfaitEquipe);
  return JSON.stringify(v);
}

// Date de la version du site : la plus tardive entre sa date de modification
// (posée par le serveur à chaque changement) et celle transmise par l'application.
const dateSite = (ligne) => Math.max(Date.parse(ligne.updated_at || '') || 0, Date.parse((ligne.data || {}).modifieLe || '') || 0);

// 1 = la version d'ici est la plus récente, -1 = celle du site, 0 = égalité.
// Fiche d'avant l'horodatage (pas d'updatedAt) : celle d'ici gagne seulement si
// le site n'a pas été retouché depuis notre dernier envoi (data.syncLe).
function localPlusRecent(o, ligne) {
  if (o.updatedAt) {
    const l = Date.parse(o.updatedAt) || 0, s = dateSite(ligne);
    return l > s ? 1 : l < s ? -1 : 0;
  }
  const syncLe = ligne.data && ligne.data.syncLe;
  if (syncLe && String(ligne.updated_at || '').slice(0, 10) <= syncLe) return 1;
  return -1;
}

// Historique local : la version écartée lors d'un conflit n'est jamais perdue.
const HISTORIQUE_MAX = 300;
function historiser(genre, o, libelle, raison, version) {
  db.historique = db.historique || [];
  const copie = JSON.parse(JSON.stringify(version || {}));
  let dernier = null;
  for (let i = db.historique.length - 1; i >= 0; i--) {
    const h = db.historique[i];
    if (h.genre === genre && h.id === String(o.id)) { dernier = h; break; }
  }
  if (dernier && JSON.stringify(dernier.version) === JSON.stringify(copie)) return false;
  db.historique.push({ le: new Date().toISOString(), genre, id: String(o.id), libelle: libelle || '', raison, version: copie });
  if (db.historique.length > HISTORIQUE_MAX) db.historique.splice(0, db.historique.length - HISTORIQUE_MAX);
  return true;
}

/* ---------- Récupération : site → IV Devis ----------
   Ce qui manque ici est ajouté (au format de l'application, avec son numéro du site).
   Un document présent des deux côtés et différent : le plus récent gagne, l'autre
   version part dans db.historique. Le statut posé sur le site reste prioritaire.
   Rien n'est jamais supprimé, ni ici ni sur le site. */
async function recupererDuSiteInterne() {
  try { horodaterModifs(); } catch (e) { /* jamais bloquant */ }
  const clientsSite = await sbRest('clients?select=id,data,created_at,updated_at') || [];
  const docsSite = await sbRest('documents?select=id,doc_type,numero,client_id,data,created_at,updated_at&order=created_at.asc') || [];
  // tout est lu : la suite ne touche plus au réseau et s'applique d'un seul bloc

  const b = { clients: 0, clientsMaj: 0, devis: 0, factures: 0, docsMaj: 0, statuts: 0, gardees: 0, doubles: [] };
  const supp = db.supprimes || {};
  const supprime = (genre, ...ids) => ids.some((id) => id && (supp[genre] || []).includes(String(id)));
  const touches = [];
  let liens = 0;
  const iso = (ms) => new Date(ms || Date.now()).toISOString();
  const enEdition = (genre, o) => (genre === 'd'
    ? !!(editing && editing.id === o.id)
    : !!(editingClient && editingClient.id === o.id));

  // --- 1. Clients ---
  const clientParSite = new Map();
  db.clients.forEach((c) => { if (c.siteId && !clientParSite.has(c.siteId)) clientParSite.set(c.siteId, c); });
  for (const ligne of clientsSite) {
    const d = ligne.data || {};
    if (supprime('clients', ligne.id)) continue;
    let c = clientParSite.get(ligne.id);
    if (!c) {
      const cle = cleClient(d.name, d.phone);
      c = db.clients.find((x) => !x.siteId && cleClient(x.name, x.phone) === cle)
        || db.clients.find((x) => !x.siteId && normDesc(x.name) && normDesc(x.name) === normDesc(d.name)
          && (!chiffres(x.phone) || !chiffres(d.phone) || chiffres(x.phone).slice(-9) === chiffres(d.phone).slice(-9)));
      if (c) { c.siteId = ligne.id; clientParSite.set(ligne.id, c); liens++; }
    }
    if (!c) {
      if (!normDesc(d.name)) continue; // fiche sans nom : rien d'exploitable
      c = { id: uid(), ...clientDepuisSite(d), siteId: ligne.id,
        createdAt: Date.parse(ligne.created_at) || Date.now(), updatedAt: iso(dateSite(ligne)) };
      db.clients.push(c); clientParSite.set(ligne.id, c); touches.push(['c', c]); b.clients++;
      continue;
    }
    if (enEdition('c', c) || vueClient(ficheClientSite(c)) === vueClient(d)) continue;
    const site = clientDepuisSite(d);
    if (!c.updatedAt) {
      // fiche d'avant l'horodatage : on complète les cases vides, sans rien remplacer
      let complete = false;
      for (const k of Object.keys(site)) {
        if (!String(c[k] || '').trim() && String(site[k] || '').trim()) { c[k] = site[k]; complete = true; }
      }
      if (complete) { touches.push(['c', c]); b.clientsMaj++; }
      continue;
    }
    if (localPlusRecent(c, ligne) >= 0) continue; // la version d'ici partira au prochain envoi
    if (historiser('client', c, c.name, 'remplacée par la version du site', c)) b.gardees++;
    Object.assign(c, site);
    c.updatedAt = iso(dateSite(ligne));
    touches.push(['c', c]); b.clientsMaj++;
  }

  // client d'un document du site : par son identifiant, sinon par son nom, sinon créé
  const clientDuDocSite = (ligne) => {
    const d = ligne.data || {};
    if (ligne.client_id && clientParSite.has(ligne.client_id)) return clientParSite.get(ligne.client_id);
    if (!normDesc(d.clientName)) return null;
    let c = db.clients.find((x) => normDesc(x.name) === normDesc(d.clientName));
    if (!c) {
      c = { id: uid(), name: String(d.clientName).trim(), contact: '', address: '', phone: '', email: '',
        createdAt: Date.now(), updatedAt: iso(dateSite(ligne)) };
      db.clients.push(c); touches.push(['c', c]); b.clients++;
    }
    return c;
  };

  const appliquerDocSite = (doc, ligne) => {
    const d = ligne.data || {};
    doc.date = String(d.date || ligne.created_at || doc.date || '').slice(0, 10);
    // les réglages propres à chaque ligne (appartenance aux packs) sont gardés quand la ligne est la même
    doc.items = (d.lignes || []).map((l, i) => {
      const avant = (doc.items || [])[i];
      const garde = avant && normDesc(avant.desc) === normDesc(l.designation) ? avant : {};
      return { ...garde, desc: String(l.designation || ''), qty: Number(l.qte) || 0, unitPrice: Number(l.pu) || 0 };
    });
    doc.discount = Number(d.remise) || 0;
    doc.notes = d.notes || '';
    doc.lang = d.lang || 'fr';
    if (doc.type === 'facture') {
      doc.chosenPack = d.chosenPack || doc.chosenPack || 'premium';
      doc.forfaitEquipe = !!d.forfaitEquipe;
      if (d.packNotes && typeof d.packNotes === 'object') doc.packNotes = d.packNotes;
    }
    const actuel = clientOf(doc);
    if (!actuel || normDesc(actuel.name) !== normDesc(d.clientName)) {
      const c = clientDuDocSite(ligne);
      if (c) doc.clientId = c.id;
    }
  };

  // --- 2. Documents ---
  const docParSite = new Map(), docParId = new Map();
  db.documents.forEach((x) => { docParId.set(String(x.id), x); if (x.siteId) docParSite.set(x.siteId, x); });
  // anciens envois sans lien : reconnus par leur contenu (même anti-doublon que l'envoi)
  const parEmpreinte = new Map();
  db.documents.forEach((x) => {
    if (!x.siteId) parEmpreinte.set(empreinteDoc(x.type === 'facture' ? 'facture' : 'devis', contenuSite(x)), x);
  });
  const nouveaux = [];
  for (const ligne of docsSite) {
    const d = ligne.data || {};
    const type = ligne.doc_type === 'facture' ? 'facture' : 'devis';
    if (supprime('documents', ligne.id, d.desktopId)) continue;
    let doc = docParSite.get(ligne.id);
    if (!doc && d.desktopId) {
      doc = docParId.get(String(d.desktopId));
      if (doc && doc.siteId && doc.siteId !== ligne.id) continue; // doublon sur le site d'un document déjà relié
    }
    if (!doc) {
      const e = parEmpreinte.get(empreinteDoc(type, d));
      if (e && !e.siteId) doc = e;
    }
    if (doc && !doc.siteId) { doc.siteId = ligne.id; docParSite.set(ligne.id, doc); liens++; }

    if (!doc) {
      // absent d'ici : ajouté, avec SON numéro du site
      const numero = ligne.numero || nextNumber(type, d.date);
      if (db.documents.some((x) => x.number === numero)) b.doubles.push(numero);
      doc = { id: uid(), type, number: numero, date: '', lang: 'fr', clientId: '', items: [], discount: 0,
        status: d.statut || 'brouillon', notes: '', sourceId: null,
        createdAt: Date.parse(ligne.created_at) || Date.now(), siteId: ligne.id, statutSite: d.statut, origine: 'site' };
      appliquerDocSite(doc, ligne);
      doc.updatedAt = iso(dateSite(ligne));
      db.documents.push(doc); docParSite.set(ligne.id, doc); reserverNumero(numero);
      touches.push(['d', doc]); nouveaux.push([doc, d]);
      if (type === 'facture') b.factures++; else b.devis++;
      continue;
    }
    if (enEdition('d', doc)) continue;

    let change = false;
    // contenu différent : le plus récent gagne, l'autre version est gardée
    if (vueDoc(type, contenuSite(doc)) !== vueDoc(type, d) && localPlusRecent(doc, ligne) < 0) {
      if (historiser('document', doc, doc.number, 'remplacée par la version du site', doc)) b.gardees++;
      appliquerDocSite(doc, ligne);
      doc.updatedAt = iso(dateSite(ligne));
      b.docsMaj++; change = true;
    }
    // statut : celui posé sur le site est prioritaire
    // (première rencontre, avant ce suivi : le site l'emporte, comme avant, et l'ancien statut est gardé)
    if (d.statut && d.statut !== doc.status) {
      const premiere = doc.statutSite === undefined;
      if (premiere || d.statut !== doc.statutSite) {
        if (premiere && historiser('document', doc, doc.number, 'statut remplacé par celui du site', doc)) b.gardees++;
        doc.status = d.statut; b.statuts++; change = true;
      }
    }
    if (d.statut && doc.statutSite !== d.statut) { doc.statutSite = d.statut; liens++; }
    if (change) touches.push(['d', doc]);
  }

  // factures récupérées : on relie leur devis d'origine quand il est ici
  const parNumeroSite = new Map();
  docsSite.forEach((l) => { if (l.numero && docParSite.has(l.id)) parNumeroSite.set(l.numero, docParSite.get(l.id)); });
  for (const [doc, d] of nouveaux) {
    if (!d.sourceNumero) continue;
    const source = parNumeroSite.get(d.sourceNumero) || db.documents.find((x) => x !== doc && x.number === d.sourceNumero);
    if (source) doc.sourceId = source.id;
  }

  if (touches.length || liens) {
    for (const [genre, o] of touches) memoriserEmpreinte(genre, o);
    await enregistrer();
    if (touches.length && !editing && !editingClient && ['dashboard', 'devis', 'factures', 'clients'].includes(currentView)) render();
  }
  // téléphone ou tablette : les réglages de l'agence du PC suivent chaque récupération
  if (MOBILE) b.reglages = await majReglagesAgence();
  return b;
}

function phraseRecuperation(b) {
  if (!b) return '';
  const pl = (n, un, plusieurs) => n + ' ' + (n > 1 ? plusieurs : un);
  const m = [];
  if (b.devis) m.push(pl(b.devis, 'devis récupéré', 'devis récupérés'));
  if (b.factures) m.push(pl(b.factures, 'facture récupérée', 'factures récupérées'));
  if (b.clients) m.push(pl(b.clients, 'client récupéré', 'clients récupérés'));
  if (b.docsMaj) m.push(pl(b.docsMaj, 'document mis à jour', 'documents mis à jour'));
  if (b.clientsMaj) m.push(pl(b.clientsMaj, 'fiche client mise à jour', 'fiches clients mises à jour'));
  if (b.statuts) m.push(pl(b.statuts, 'statut repris du site', 'statuts repris du site'));
  if (b.gardees) m.push(pl(b.gardees, 'ancienne version gardée dans l\'historique', 'anciennes versions gardées dans l\'historique'));
  let t = m.length ? 'Site ✓ ' + m.join(', ') : '';
  if (b.doubles.length) t += (t ? ' · ' : '') + '⚠️ numéro déjà porté ici par un autre document : ' + b.doubles.join(', ');
  if (b.reglages) t = MESSAGE_REGLAGES + (t ? ' · ' + t : '');
  return t;
}

function annoncerRecuperation(b, silencieux) {
  const t = phraseRecuperation(b);
  if (t) toast(t, 8000);
  else if (!silencieux) toast('Site ✓ rien de nouveau à récupérer');
  if (!silencieux && currentView === 'settings') renderSettings();
}

/* ---------- Envoi : IV Devis → site ---------- */
async function pushVersSiteInterne(silencieux) {

  const clientsExistants = await sbRest('clients?select=id,data,updated_at') || [];
  const docsExistants = await sbRest('documents?select=id,numero,doc_type,client_id,data,updated_at') || [];
  const empreinte = empreinteDoc;

  const nomVersId = {};
  const clientSiteParId = new Map(clientsExistants.map((c) => [c.id, c]));
  clientsExistants.forEach((c) => {
    const d = c.data || {};
    nomVersId[cleClient(d.name, d.phone)] = c.id;
    if (!nomVersId[normDesc(d.name)]) nomVersId[normDesc(d.name)] = c.id; // repli : nom seul
  });
  const numerosPris = new Set(docsExistants.map((d) => d.numero));
  const empreintesExistantes = new Map(); // empreinte -> ligne du site
  const desktopVersSite = {}; // desktopId -> ligne du site des docs déjà envoyés
  const docSiteParId = new Map(docsExistants.map((d) => [d.id, d]));
  docsExistants.forEach((d) => {
    if (!d.data) return;
    empreintesExistantes.set(empreinte(d.doc_type, d.data), d);
    if (d.data.desktopId) desktopVersSite[d.data.desktopId] = d;
  });
  const siteIdsPris = new Set(db.clients.map((c) => c.siteId).filter(Boolean));

  // --- 1. Clients (dédupliqués par nom, comme l'import /gestion) ---
  const ancienVersNouveau = {};
  let cCrees = 0, cMaj = 0;
  for (const cl of db.clients) {
    const fiche = ficheClientSite(cl);
    if (cl.siteId) {
      const ligne = clientSiteParId.get(cl.siteId);
      if (!ligne) continue; // supprimé sur le site : jamais recréé (les suppressions ne se propagent pas)
      ancienVersNouveau[cl.id] = ligne.id;
      // modifié ici après le site : la fiche du site est mise à jour (champs du site conservés)
      if (cl.updatedAt && vueClient(fiche) !== vueClient(ligne.data || {}) && localPlusRecent(cl, ligne) > 0) {
        historiser('client', cl, cl.name, 'version du site remplacée par celle de cet ordinateur', ligne.data || {});
        await sbRest('clients?id=eq.' + encodeURIComponent(ligne.id), {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ data: { ...(ligne.data || {}), ...fiche, modifieLe: cl.updatedAt } })
        });
        cMaj++;
      }
      continue;
    }
    const cle = cleClient(cl.name, cl.phone);
    const existant = nomVersId[cle] || (!chiffres(cl.phone) ? nomVersId[normDesc(cl.name)] : null);
    if (existant) {
      ancienVersNouveau[cl.id] = existant;
      if (!siteIdsPris.has(existant)) { cl.siteId = existant; siteIdsPris.add(existant); }
      continue;
    }
    const inser = await sbRest('clients', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ data: fiche })
    });
    const id = inser && inser[0] && inser[0].id;
    if (id) { ancienVersNouveau[cl.id] = id; nomVersId[cle] = id; cl.siteId = id; siteIdsPris.add(id); cCrees++; }
  }

  // --- 2. Documents (mêmes règles que l'import : anti-doublon + renumérotation) ---
  const numeroLibre = (type, annee) => {
    const prefixe = (type === 'devis' ? 'DEV-' : 'FAC-') + annee + '-';
    let n = 1;
    for (const num of numerosPris) {
      // le numéro peut porter un suffixe de poste (DEV-2026-021-S)
      if (num && num.startsWith(prefixe)) {
        const rang = (String(num).slice(prefixe.length).match(/^(\d+)/) || [])[1];
        if (rang) n = Math.max(n, parseInt(rang, 10) + 1);
      }
    }
    return prefixe + String(n).padStart(3, '0');
  };
  const idVersNumeroFinal = {};
  let dCrees = 0, dMaj = 0, dInchanges = 0, dSupprimesSite = 0;
  const renumerotes = [];
  const docsTries = [...db.documents].sort((a, b) => {
    const ka = a.createdAt || 0, kb = b.createdAt || 0;
    return ka > kb ? 1 : ka < kb ? -1 : 0;
  });

  for (const doc of docsTries) {
    const type = doc.type === 'facture' ? 'facture' : 'devis';
    const sourceNumero = doc.sourceId ? (idVersNumeroFinal[doc.sourceId] ||
      (desktopVersSite[String(doc.sourceId)] ? desktopVersSite[String(doc.sourceId)].numero : '')) : '';
    const contenu = contenuSite(doc, sourceNumero);

    let ligne = doc.siteId ? docSiteParId.get(doc.siteId) : null;
    if (!ligne && !doc.siteId) ligne = desktopVersSite[String(doc.id)] || null;
    if (!ligne && doc.siteId) { dSupprimesSite++; continue; } // supprimé sur le site : gardé ici, jamais recréé
    const sig = empreinte(type, contenu);

    if (ligne) {
      if (!doc.siteId) doc.siteId = ligne.id;
      idVersNumeroFinal[doc.id] = ligne.numero;
      const site = ligne.data || {};
      // STATUT : celui posé sur le site (ex. « payée » par l'assistante) n'est JAMAIS
      // écrasé ; celui changé ici part s'il n'a pas bougé sur le site entre-temps.
      if (site.statut && site.statut !== contenu.statut) {
        if (doc.statutSite === undefined || site.statut !== doc.statutSite) contenu.statut = site.statut;
      }
      const contenuDiffere = sig !== empreinte(type, site) || vueDoc(type, contenu) !== vueDoc(type, site);
      const statutDiffere = contenu.statut !== site.statut;
      let data;
      if (contenuDiffere && localPlusRecent(doc, ligne) > 0) {
        // modifié ici après le site → la copie du site est mise à jour (même numéro, champs du site conservés)
        historiser('document', doc, ligne.numero, 'version du site remplacée par celle de cet ordinateur', site);
        if (doc.updatedAt) contenu.modifieLe = doc.updatedAt;
        data = { ...site, ...contenu };
      } else if (statutDiffere) {
        data = { ...site, statut: contenu.statut };
      } else {
        // identique, ou la version du site est la plus récente (elle sera récupérée)
        dInchanges++;
        continue;
      }
      // relecture juste avant d'écrire : un statut posé entre-temps sur le site reste prioritaire
      const [fraiche] = await sbRest('documents?id=eq.' + encodeURIComponent(ligne.id) + '&select=data') || [];
      if (fraiche && fraiche.data && fraiche.data.statut && fraiche.data.statut !== site.statut) data.statut = fraiche.data.statut;
      await sbRest('documents?id=eq.' + encodeURIComponent(ligne.id), {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ data, client_id: ancienVersNouveau[doc.clientId] || ligne.client_id || null })
      });
      // statut envoyé d'ici : c'est désormais celui « vu » sur le site ; statut du site gardé :
      // on ne le note pas, la récupération le reprendra ici
      if (data.statut === doc.status) doc.statutSite = data.statut;
      dMaj++;
      continue;
    }

    // jamais envoyé : anti-doublon par contenu (couvre les anciens imports manuels)
    if (empreintesExistantes.has(sig)) {
      const deja = empreintesExistantes.get(sig);
      idVersNumeroFinal[doc.id] = deja.numero;
      if (deja.id && !db.documents.some((x) => x.siteId === deja.id)) doc.siteId = deja.id;
      dInchanges++;
      continue;
    }

    let numero = doc.number;
    const annee = (numero && numero.match(/-(\d{4})-/)) ? numero.match(/-(\d{4})-/)[1] : new Date().getFullYear();
    let ancien = null;
    if (!numero || numerosPris.has(numero)) {
      ancien = numero;
      numero = numeroLibre(type, annee);
      renumerotes.push((ancien || '(sans numéro)') + ' → ' + numero);
    }
    numerosPris.add(numero);
    idVersNumeroFinal[doc.id] = numero;
    if (ancien) contenu.ancienNumero = ancien;
    if (doc.updatedAt) contenu.modifieLe = doc.updatedAt;

    const inser = await sbRest('documents', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ doc_type: type, numero, client_id: ancienVersNouveau[doc.clientId] || null, data: contenu })
    });
    const ligneCreee = inser && inser[0];
    if (ligneCreee && ligneCreee.id) doc.siteId = ligneCreee.id;
    doc.statutSite = contenu.statut;
    empreintesExistantes.set(sig, ligneCreee || { numero });
    desktopVersSite[String(doc.id)] = ligneCreee || { numero };
    dCrees++;
  }

  // le catalogue de l'application fait foi : on le recopie sur le site. Pas depuis un
  // téléphone : sa copie du catalogue date de son paquet et remettrait d'anciens prix en ligne.
  if (!MOBILE) try { await sbCatalogPush(); } catch (e) { /* n'empêche jamais l'envoi des documents */ }

  db.settings.syncLastAt = new Date().toISOString();
  // sauvegarde complète en arrière-plan, au plus une fois toutes les 12 h (celle des ordinateurs
  // seulement : un téléphone pousserait leurs sauvegardes hors de la rotation)
  if (!MOBILE) try {
    const derniere = db.settings.backupLastAt ? Date.parse(db.settings.backupLastAt) : 0;
    if (Date.now() - derniere > 12 * 3600 * 1000) await sbBackupPush(true);
  } catch (e) { /* une sauvegarde qui échoue ne doit jamais bloquer la synchronisation */ }
  // les liens avec le site (siteId, statut vu) sont enregistrés à chaque envoi
  await enregistrer();
  if (!silencieux) {
    toast(`Site ✓ ${cCrees} client(s) créé(s)` + (cMaj ? ` · ${cMaj} fiche(s) client mise(s) à jour` : '') +
      ` · ${dCrees} document(s) envoyé(s) · ${dMaj} mis à jour · ${dInchanges} inchangé(s)` +
      (dSupprimesSite ? ` · ${dSupprimesSite} supprimé(s) sur le site, gardé(s) ici` : '') +
      (renumerotes.length ? ` · renumérotés : ${renumerotes.join(', ')}` : ''));
    if (currentView === 'settings') renderSettings();
  }
  return { cCrees, cMaj, dCrees, dMaj, dInchanges, dSupprimesSite, renumerotes };
}

/* ---------- Apparence (clair / sombre) ---------- */
const modeSombre = () => document.documentElement.getAttribute('data-theme') === 'sombre';

function appliquerTheme(theme) {
  const t = theme || (db && db.settings && db.settings.theme) || 'clair';
  document.documentElement.setAttribute('data-theme', t === 'sombre' ? 'sombre' : 'clair');
}

// Fond des cartes de pack : teinte douce en clair, translucide en sombre
const packTeinte = (k) => modeSombre() ? PACK_META[k].clair : PACK_META[k].color;
const packFond = (k) => modeSombre() ? PACK_META[k].color + '2E' : PACK_META[k].soft;

/* ---------- Icônes de l'interface ---------- */
// Mêmes traits que les icônes du menu, pour une interface homogène.
const ICONES = {
  fichier: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  facture: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/><line x1="5" y1="15" x2="9" y2="15"/>',
  texte: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="16" y2="12"/><line x1="4" y1="18" x2="12" y2="18"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  sauvegarde: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  site: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  archive: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  verrou: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  apparence: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>',
  diplome: '<path d="M22 10v6"/><path d="M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 2.5 9 2.5 12 0v-5"/>',
  tampon: '<path d="M5 22h14"/><path d="M5 18h14v-1.5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2z"/><path d="M9 14.5V9a3 3 0 0 1 6 0v5.5"/>',
  coche: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><polyline points="22 4 12 14 9 11"/>',
  alerte: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  oeil: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  oeilBarre: '<path d="M17.9 17.9A10.1 10.1 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2m-6.7-1.1a3 3 0 1 1-4.2-4.2"/><line x1="1" y1="1" x2="23" y2="23"/>',
  maj: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  actualiser: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  croix: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  appareil: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>'
};

function ico(nom, taille = 16) {
  return `<svg class="ico" viewBox="0 0 24 24" width="${taille}" height="${taille}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONES[nom] || ''}</svg> `;
}

/* ---------- Barre de titre intégrée ---------- */
function initBarreTitre() {
  const barre = $('#titlebar');
  if (!barre) return;
  if (!window.api || !window.api.windowAction) { barre.style.display = 'none'; document.documentElement.style.setProperty('--barre-titre', '0px'); return; }
  const agir = (a) => window.api.windowAction(a);
  $('#tb-min').onclick = () => agir('minimize');
  $('#tb-max').onclick = () => agir('maximize');
  $('#tb-close').onclick = async () => { await viderAttente(); agir('close'); };
  // fermeture par Alt+F4 ou par Windows : le processus principal nous prévient
  if (window.api.onBeforeClose) window.api.onBeforeClose(async () => { await viderAttente(); agir('close-now'); });
  barre.ondblclick = (e) => { if (!e.target.closest('.tb-btns')) agir('maximize'); };
}

/* ---------- Raccourcis clavier et recherche globale ---------- */
function resultatsRecherche(q) {
  const n = normDesc(q);
  if (!n) return [];
  const res = [];
  for (const c of db.clients) {
    if (normDesc(c.name).includes(n) || normDesc(c.phone).includes(n)) {
      res.push({ type: 'Client', libelle: c.name, detail: c.phone || '', action: () => { setView('clients'); editingClient = structuredClone(c); renderClients(); } });
    }
  }
  for (const d of db.documents) {
    const cl = clientOf(d);
    if (normDesc(d.number).includes(n) || (cl && normDesc(cl.name).includes(n))) {
      res.push({
        type: d.type === 'devis' ? 'Devis' : 'Facture',
        libelle: d.number + (cl ? ' · ' + cl.name : ''),
        detail: fmtMoney(docTotals(d).total),
        action: () => openEditor(structuredClone(d))
      });
    }
  }
  for (const s of [...db.catalog.equivalences, ...db.catalog.services]) {
    if (normDesc(s.desc).includes(n)) {
      res.push({ type: 'Prestation', libelle: s.desc, detail: fmtMoney(s.unitPrice), action: () => setView('catalogue') });
    }
  }
  return res.slice(0, 12);
}

function ouvrirRecherche() {
  if ($('.recherche-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay recherche-overlay';
  overlay.innerHTML = `
    <div class="recherche-box">
      <input type="text" class="recherche-input" id="rg-input" placeholder="Rechercher un client, un devis, une facture, une prestation…" />
      <div class="recherche-res" id="rg-res"><div class="recherche-vide">Tape au moins une lettre…</div></div>
      <div class="recherche-aide">↑ ↓ pour naviguer · Entrée pour ouvrir · Échap pour fermer</div>
    </div>`;
  document.body.appendChild(overlay);
  const champ = $('#rg-input', overlay);
  const zone = $('#rg-res', overlay);
  let liste = [], choisi = 0;
  const fermer = () => overlay.remove();
  const dessiner = () => {
    zone.innerHTML = liste.length
      ? liste.map((r, i) => `<div class="recherche-item ${i === choisi ? 'actif' : ''}" data-i="${i}">
          <span class="rg-type">${r.type}</span>
          <span class="rg-lib">${esc(r.libelle)}</span>
          <span class="rg-det">${esc(r.detail)}</span>
        </div>`).join('')
      : `<div class="recherche-vide">Aucun résultat</div>`;
    $$('.recherche-item', zone).forEach((el) => {
      el.onclick = () => {
        // une sélection de texte en cours = l'utilisateur copie, il n'ouvre pas
        if (String(window.getSelection && window.getSelection()).trim()) return;
        const r = liste[Number(el.dataset.i)]; fermer(); r.action();
      };
    });
  };
  champ.oninput = () => { liste = resultatsRecherche(champ.value); choisi = 0; dessiner(); };
  champ.onkeydown = (e) => {
    if (e.key === 'Escape') { fermer(); return; }
    if (e.key === 'ArrowDown') { choisi = Math.min(choisi + 1, liste.length - 1); dessiner(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { choisi = Math.max(choisi - 1, 0); dessiner(); e.preventDefault(); }
    if (e.key === 'Enter' && liste[choisi]) { const r = liste[choisi]; fermer(); r.action(); }
  };
  // on ne ferme que si le clic a commencé ET fini sur le fond (pas une sélection
  // qui déborde de la boîte)
  let presseSurFond = false;
  overlay.onmousedown = (e) => { presseSurFond = e.target === overlay; };
  overlay.onclick = (e) => { if (e.target === overlay && presseSurFond) fermer(); };
  champ.focus();
}

function initRaccourcis() {
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'k') { e.preventDefault(); ouvrirRecherche(); return; }
    if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (editing) saveEditing();
      else if (currentView === 'settings') { const b = $('#s-save'); if (b) b.click(); }
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!$('.modal-overlay')) openEditor(newDoc('devis')); return; }
    if (e.key === 'Escape') {
      // une modale gère elle-même Échap ; si elle vient d'être retirée par son
      // propre gestionnaire, l'événement ne doit pas fermer l'éditeur derrière
      if (e.target && e.target.closest && e.target.closest('.modal-overlay, .lock-screen')) return;
      const modales = $$('.modal-overlay');
      if (modales.length) modales[modales.length - 1].remove();
      else if (editing) setView(editing.type === 'devis' ? 'devis' : 'factures');
    }
  });
}

/* ---------- Correction des coquilles de frappe ---------- */
// Nettoyage typographique des textes saisis (textes des packs, phrases).
// Appliqué au démarrage : c'est l'application qui écrit dans ses données,
// jamais un outil extérieur.
function nettoyerTexte(s) {
  return String(s)
    .replace(/,[ \t]*,/g, ',')                                              // « , , » et « ,, »
    .replace(/, équivalences de diplômes, test\(s\) de langue,/g, ', équivalences de diplômes,') // énumération en double
    .replace(/([^\s])[ \t]{2,}([^\s])/g, '$1 $2')                           // espaces doubles
    .replace(/[ \t]+([;:!?»])/g, ' $1')                                     // un seul espace avant ; : ! ? »
    .replace(/([«])[ \t]+/g, '$1 ')
    .replace(/[ \t]+\n/g, '\n')                                             // espaces en fin de ligne
    .replace(/\n{3,}/g, '\n\n')                                             // lignes vides en trop
    .trim();
}

function corrigerCoquilles() {
  let corrige = false;
  const textes = db.catalog.packTexts || {};
  for (const k of Object.keys(textes)) {
    if (typeof textes[k] !== 'string' || !textes[k]) continue;
    const propre = nettoyerTexte(textes[k]);
    if (propre !== textes[k]) { textes[k] = propre; corrige = true; }
  }
  for (const p of (db.catalog.phrases || [])) {
    if (typeof p.text !== 'string' || !p.text) continue;
    const propre = nettoyerTexte(p.text);
    if (propre !== p.text) { p.text = propre; corrige = true; }
  }
  return corrige;
}

/* ---------- Textes des packs : on ne cite que ce que le dossier contient ---------- */
// Chaque règle relie une tournure des textes (« test(s) de langue », « la
// biométrie »…) à des mots-clés de prestations.
//
// Deux sens de lecture, selon la proposition :
//   « ✅ Vous gagnez : … »  → la mention reste si la prestation est DANS ce pack ;
//   « ❌ Vous perdez : … »  → la mention reste si la prestation est au dossier
//                              mais PAS dans ce pack (c'est ce que le client perd).
// Dans les deux cas, une prestation absente du dossier n'est jamais citée.
const MENTIONS_PACK = [
  { motif: "preuve professionnelle, de fond et d'union", variantes: [
    { cles: ['preuves professionnelles', 'preuves de fond', "preuves d'union"] },
    { cles: ['preuves professionnelles', 'preuves de fond'], texte: 'preuves professionnelles et de fond' },
    { cles: ['preuves professionnelles', "preuves d'union"], texte: "preuves professionnelles et d'union" },
    { cles: ['preuves de fond', "preuves d'union"], texte: "preuves de fond et d'union" },
    { cles: ['preuves professionnelles'], texte: 'preuves professionnelles' },
    { cles: ['preuves de fond'], texte: 'preuves de fond' },
    { cles: ["preuves d'union"], texte: "preuves d'union" }
  ] },
  { motif: "preuve de fond et d'union", variantes: [
    { cles: ['preuves de fond', "preuves d'union"] },
    { cles: ['preuves de fond'], texte: 'preuves de fond' },
    { cles: ["preuves d'union"], texte: "preuves d'union" }
  ] },
  { motif: 'preuve de fond', cles: ['preuves de fond'] },
  { motif: "preuve d'union", cles: ["preuves d'union"] },
  { motif: 'preuve professionnelle', cles: ['preuves professionnelles'] },
  { motif: 'expérience professionnelle', cles: ['preuves professionnelles'] },
  { motif: 'test de langue', cles: ['test de langue'] },
  { motif: 'cours de préparation', cles: ['cours de prepa'] },
  { motif: 'cours de prépa', cles: ['cours de prepa'] },
  { motif: 'équivalence de diplôme', cles: ['diplome', 'commission', 'demarcheur', 'wes'] },
  { motif: 'équivalence', cles: ['diplome', 'commission', 'demarcheur', 'wes'] },
  { motif: 'cnps', cles: ['cnps'] },
  { motif: 'certificat de police', cles: ['certificat de police'] },
  { motif: 'visite médicale', cles: ['visite medicale'] },
  { motif: 'biométrie', cles: ['biometrie'] },
  { motif: 'résidence permanente', cles: ['residence permanente'] }
];

// Expression tolérante : majuscules, accents, pluriels et « (s) » facultatifs,
// article éventuel devant (la, le, les, l', des, d', du).
function motifVersRegex(motif) {
  const classes = { a: '[aàâä]', e: '[eéèêë]', i: '[iîï]', o: '[oôö]', u: '[uùûü]', c: '[cç]' };
  const lettre = (ch) => {
    if (ch === "'") return "['’]";
    const base = ch.normalize('NFD')[0];
    return classes[base] || base;
  };
  const mots = motif.toLowerCase().split(/\s+/).map((m) => {
    const virgule = m.endsWith(',');
    const corps = (virgule ? m.slice(0, -1) : m).split('').map(lettre).join('') + '(?:\\(s\\)|s)?';
    return corps + (virgule ? '\\s*,' : '');
  });
  return new RegExp("(?<![\\p{L}])(?:(?:la|le|les|des|du)\\s+|l['’]|d['’])?" + mots.join('\\s+') + "(?![\\p{L}])", 'iu');
}

// Retire une mention de son énumération sans laisser de virgule ou de « et » orphelin.
function retirerMention(texte, debut, fin) {
  let avant = texte.slice(0, debut);
  const apres = texte.slice(fin);
  let m;
  if ((m = apres.match(/^\s*,\s*/))) return avant + apres.slice(m[0].length);      // « [a, ]b » → « b »
  if ((m = apres.match(/^\s+et\s+/))) {                                            // « a, [b] et c » / « [b] et c »
    const virg = avant.match(/\s*,\s*$/);
    if (virg) return avant.slice(0, -virg[0].length) + apres;
    return avant + apres.slice(m[0].length);
  }
  if ((m = avant.match(/\s+et\s+$/))) {                                            // « a, b [et c] » → « a et b »
    avant = avant.slice(0, -m[0].length);
    const borne = Math.max(avant.lastIndexOf('('), avant.lastIndexOf(';'), avant.lastIndexOf(':'),
      avant.lastIndexOf('—'), avant.lastIndexOf('\n'));
    const derniereVirgule = avant.lastIndexOf(',');
    if (derniereVirgule > borne) {
      avant = avant.slice(0, derniereVirgule) + ' et' + avant.slice(derniereVirgule + 1).replace(/^\s*/, ' ');
    }
    return avant + apres;
  }
  if ((m = avant.match(/\s*,\s*$/))) return avant.slice(0, -m[0].length) + apres;   // « a, [b] » → « a »
  return avant + apres;                                                             // mention isolée
}

// Applique les règles à UNE proposition. `garder(cles)` dit si la mention reste.
// `journal` (facultatif) reçoit les mots-clés de ce qui a été retiré.
function filtrerProposition(texte, garder, journal) {
  let gardees = 0, retirees = 0;
  for (const regle of MENTIONS_PACK) {
    const re = motifVersRegex(regle.motif);
    const toutes = regle.variantes ? regle.variantes[0].cles : regle.cles;
    let depuis = 0;
    for (let tour = 0; tour < 20; tour++) {
      const m = texte.slice(depuis).match(re);
      if (!m) break;
      const debut = depuis + m.index, fin = debut + m[0].length;
      let decision = null; // null = retirer ; '' = garder tel quel ; 'texte' = remplacer
      let variante = null;
      if (regle.variantes) {
        variante = regle.variantes.find((x) => x.cles.every((c) => garder(c)));
        if (variante) decision = variante.texte || '';
      } else if (regle.cles.some((c) => garder(c))) {
        decision = '';
      }
      if (decision === '') { gardees++; depuis = fin; continue; }
      if (decision) {
        const article = (m[0].match(/^(?:(?:la|le|les|des|du)\s+|l['’]|d['’])/i) || [''])[0];
        texte = texte.slice(0, debut) + article + decision + texte.slice(fin);
        if (journal) journal.push(...toutes.filter((c) => !variante.cles.includes(c)));
        gardees++; depuis = debut + article.length + decision.length; continue;
      }
      texte = retirerMention(texte, debut, fin);
      if (journal) journal.push(...toutes);
      retirees++;
      depuis = Math.max(0, debut - 1);
    }
  }
  return { texte, gardees, retirees };
}

// Polarité d'un morceau de texte : 1 = « vous gagnez », -1 = « vous perdez », 0 = inconnue.
function polariteDe(texte) {
  const t = String(texte).toLowerCase();
  if (/✅|vous gagnez|inclus|compris|géré|gere/.test(t)) return 1;
  if (/❌|vous perdez|par vos soins|à organiser|a organiser|pas de |aucun|vous-même|vous meme/.test(t)) return -1;
  if (/👉/.test(t)) return 0;
  return 0;
}

// Texte d'un pack adapté au document.
//   inclus  = désignations présentes dans CE pack
//   dossier = désignations présentes dans le document (tous packs confondus)
//   options.exclus  = mots-clés à retirer quoi qu'il arrive (déjà obtenus par le client)
//   options.journal = reçoit les mots-clés des mentions retirées
function adapterTextePack(texte, inclus, dossier, options = {}) {
  if (!texte) return '';
  const norme = (l) => (l || []).map((x) => normDesc(x));
  const dansPack = norme(inclus);
  const auDossier = norme(dossier && dossier.length ? dossier : inclus);
  const exclus = norme(options.exclus);
  const contient = (liste, cle) => !exclus.includes(normDesc(cle)) && liste.some((n) => n.includes(normDesc(cle)));

  // découpe en propositions, séparateurs conservés pour tout recoller
  const morceaux = String(texte).split(/(\s*;\s*|\.(?=\s|$)|\n)/);
  const sortie = [];
  let polarite = 1;
  for (let i = 0; i < morceaux.length; i += 2) {
    const brut = morceaux[i];
    const sep = morceaux[i + 1] || '';
    if (!brut.trim()) { sortie.push({ t: brut, sep }); continue; }

    // une nouvelle ligne redonne la polarité de son propre marqueur ; sinon on hérite
    const propre = polariteDe(brut);
    if (propre !== 0) polarite = propre;

    const garder = polarite >= 0
      ? (cle) => contient(dansPack, cle)                                     // ce que le pack apporte
      : (cle) => contient(auDossier, cle) && !contient(dansPack, cle);       // ce que le pack n'apporte pas
    const r = filtrerProposition(brut, garder, options.journal);
    const entete = /:/.test(brut);   // « ✅ Vous gagnez : … » ne disparaît jamais
    if (r.retirees > 0 && r.gardees === 0 && !entete) continue; // proposition vidée de son sens

    let t = r.texte;
    if (r.gardees === 1 && r.retirees > 0) t = t.replace(/\bsont\b/, 'est').replace(/\bincluses\b/, 'incluse');
    sortie.push({ t, sep });
  }

  return sortie.map((x) => x.t + x.sep).join('')
    .replace(/\(\s*\)/g, '')                       // parenthèses vides
    .replace(/\(\s+/g, '(')
    .replace(/\s+([,.)])/g, '$1')                  // espace avant , . )
    .replace(/,\s*([;.)])/g, '$1')                 // virgule orpheline avant ; . )
    .replace(/\s*;\s*/g, ' ; ')                    // typographie française : espace avant ET après le ;
    .replace(/\s*;\s*(\n|$)/g, '$1')               // ; en fin de ligne
    .replace(/—\s*(?=[.;,\n]|$)/g, '')             // tiret qui n'annonce plus rien
    .replace(/:\s*,/g, ' :')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\s+\./g, '.')
    .replace(/\.\s*\./g, '.')
    .trim();
}

/* ---------- Catalogue : maintien à l'identique sur le site ---------- */
// Le site range le catalogue dans sa table `catalog` avec ses propres noms
// de champs (designation / pu). L'application reste la référence : à chaque
// synchronisation, son catalogue remplace celui du site.

const versFormatSite = (liste) => (liste || []).map((s) => ({
  designation: (s.desc || '').trim(),
  pu: Number(s.unitPrice) || 0,
  packs: s.packs || null
}));

async function sbCatalogPush() {
  // une installation vide ne doit pas effacer le catalogue du site
  if (!db.catalog.equivalences.length && !db.catalog.services.length) return;
  const lignes = [
    { key: 'equivalences', data: versFormatSite(db.catalog.equivalences) },
    { key: 'services', data: versFormatSite(db.catalog.services) },
    { key: 'phrases', data: db.catalog.phrases || [] },
    { key: 'packTexts', data: db.catalog.packTexts || {} }
  ];
  const reglages = await reglagesPourLeSite();
  if (reglages) lignes.push({ key: reglages.cle, data: reglages.data });
  await sbRest('catalog?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(lignes.map((l) => ({ ...l, updated_at: new Date().toISOString() })))
  });
  if (reglages) reglagesEnvoyes = reglages.data.reglagesSource.empreinte;
}

/* ---------- Réglages de l'agence pour les téléphones et tablettes (2.11.0) ----------
   Le PC source écrit sur le site (table catalog, réservée à l'équipe) ses réglages de l'agence : fiche entreprise,
   logo, apparence, catalogue et prix, packs, textes des packs, phrases — exactement ceux de reglages-agence.js,
   jamais un compte, un client, un document, la numérotation ni un code de poste. Ils partent avec chaque envoi vers
   le site (donc après chaque modification, la synchronisation automatique étant cochée), et seulement quand ils ont
   changé. Un téléphone ne les écrit jamais : il les relit à chaque ouverture et à chaque récupération, et les
   applique avec les fonctions de reglages-agence.js quand leur empreinte change. */
const MESSAGE_REGLAGES = '✅ Réglages de l\'agence mis à jour (catalogue, prix, packs, fiche entreprise)';
let reglagesEnvoyes = '';   // empreinte des réglages déjà écrits sur le site depuis l'ouverture de ce PC

async function reglagesPourLeSite() {
  if (MOBILE || !window.api.reglagesPourSite) return null;
  try {
    const r = await window.api.reglagesPourSite(db);   // processus principal : reglages-agence.js, { cle, data }
    if (!r || !r.cle || !r.data || !r.data.reglagesSource || r.data.reglagesSource.empreinte === reglagesEnvoyes) return null;
    return r;
  } catch (e) {
    return null;   // refusés par le garde-fou : le reste du catalogue part quand même
  }
}

// Téléphone ou tablette : relit les réglages de l'agence sur le site et les applique s'ils ont changé.
// true si appliqués. Hors connexion ou site injoignable : rien ne change. Les clients, documents, la
// numérotation et le code de l'appareil ne sont jamais touchés ; un document ouvert dans l'éditeur non plus
// (c'est une copie), et les devis déjà faits gardent leurs montants (chaque ligne porte son prix).
async function majReglagesAgence() {
  if (!MOBILE || typeof REGLAGES_AGENCE === 'undefined' || !syncOn()) return false;
  let fichier = null;
  try {
    const lignes = await sbRest(`catalog?key=eq.${REGLAGES_AGENCE.CLE_SITE}&select=data`);
    fichier = lignes && lignes[0] && lignes[0].data;
  } catch (e) {
    return false;
  }
  if (!fichier || !REGLAGES_AGENCE.doitImposer(db, fichier)) return false;
  await viderAttente();
  try { await window.api.miseDeCote('-avant-reglages'); } catch (e) { return false; }   // sans copie, rien ne change
  REGLAGES_AGENCE.imposer(db, fichier);
  if (!logoSur(db.settings.company.logo)) db.settings.company.logo = '';
  db.catalog.packTexts = Object.assign({ premium: '', access: '', standard: '' }, db.catalog.packTexts || {});
  db.settings.reglagesRecusLe = new Date().toISOString();
  await enregistrer();
  appliquerTheme();
  if (!editing && !editingClient && ['dashboard', 'catalogue', 'packs'].includes(currentView)) render();
  return true;
}

// À l'ouverture de l'appareil (connecté au site) : une seule synchronisation à la fois
async function reglagesAgenceAOuverture() {
  if (!MOBILE || !syncOn() || syncEnCours) return;
  syncEnCours = true;
  let appliques = false;
  try { appliques = await majReglagesAgence(); } finally { syncEnCours = false; }
  if (appliques) {
    toast(MESSAGE_REGLAGES, 7000);
    if (currentView === 'settings' && !editing) renderSettings();
  }
}

/* ---------- Sauvegarde complète sur le site ---------- */
// Envoie TOUT le fichier de données (catalogue, textes des packs, phrases,
// fiche entreprise, logo, clients, documents) dans la table sauvegardes_app,
// réservée aux administrateurs. Complète la synchronisation des documents,
// qui n'envoie que les clients et les devis/factures.

const SAUVEGARDES_GARDEES = 20;

async function sbBackupPush(silencieux) {
  if (!syncOn()) { if (!silencieux) toast('⚠️ Connecte-toi au site dans les Paramètres'); return; }
  // jamais de sauvegarde vide sur le site : elle finirait par pousser les vraies hors de la rotation
  if (!db.documents.length && !db.clients.length) { if (!silencieux) toast('Rien à sauvegarder : aucun client ni document.'); return; }
  const contenu = JSON.parse(JSON.stringify(db));
  // ne partent jamais : jeton de session (déjà hors de data.json), empreinte du
  // mot de passe, identifiant de connexion et chemins propres à ce PC
  for (const k of ['syncRefreshToken', 'lockHash', 'lock', 'syncEmail', 'cloudBackupDir', 'exportsDir']) delete contenu.settings[k];
  const taille = JSON.stringify(contenu).length;
  await sbRest('sauvegardes_app', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ app: 'iv-devis', version: appInfo.version || '', taille, data: contenu })
  });
  // rotation : on ne garde que les N plus récentes
  const anciennes = await sbRest(`sauvegardes_app?app=eq.iv-devis&select=id&order=created_at.desc&offset=${SAUVEGARDES_GARDEES}`) || [];
  for (const a of anciennes) await sbRest('sauvegardes_app?id=eq.' + encodeURIComponent(a.id), { method: 'DELETE' });
  db.settings.backupLastAt = new Date().toISOString();
  await enregistrer();
  if (!silencieux) {
    toast(`✅ Sauvegarde complète envoyée sur le site (${Math.round(taille / 1024)} Ko)`);
    if (currentView === 'settings') renderSettings();
  }
}

// Récupère la dernière sauvegarde du site et la propose en téléchargement.
async function sbBackupDownload() {
  if (!syncOn()) { toast('⚠️ Connecte-toi au site dans les Paramètres'); return; }
  const [derniere] = await sbRest('sauvegardes_app?app=eq.iv-devis&select=data,created_at,taille&order=created_at.desc&limit=1') || [];
  if (!derniere) { toast('Aucune sauvegarde sur le site pour le moment'); return; }
  const date = new Date(derniere.created_at).toISOString().slice(0, 10);
  const res = await window.api.saveTextFile({
    defaultName: `sauvegarde-iv-devis-${date}.json`,
    content: JSON.stringify(derniere.data, null, 2),
    filterName: 'Sauvegarde JSON',
    filterExt: 'json'
  });
  if (res.ok) toast(`✅ Sauvegarde du ${fmtDate(date)} téléchargée`);
}

/* ---------- Mises à jour (2.8.0) ----------
   La veille vit dans le processus principal (mise-a-jour.js) : cette page ne parle jamais au réseau. À l'ouverture,
   une seule question part (« y a-t-il une nouvelle version ? ») ; si oui, une bulle la propose en bas à droite,
   sans bloquer le travail. Case « automatiquement » (Paramètres › Mises à jour) : téléchargement pendant le
   travail, installation à la fermeture. « Installer maintenant » ferme IV Devis : refusé tant qu'un document a des
   modifications non enregistrées. */
let majEtat = null;          // le dernier état connu (mise-a-jour.js → etat())
let majBulle = null;         // ce que montre la bulle : proposition, telechargement, pret, programme, echec
let majMessage = '';         // une phrase d'avertissement ou d'erreur, dans la bulle
let majPlusTard = false;     // « Plus tard » : plus de proposition pendant cette séance

const majMo = (o) => (Number(o) / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: Number(o) < 10485760 ? 1 : 0 }) + ' Mo';
const travailNonEnregistre = () => !!(editing && editingDirty);

function majBouton(id, texte, classe = '') {
  return `<button type="button" class="btn ${classe}" data-maj="${id}">${texte}</button>`;
}

function majNouveautesHtml(blocs) {
  const liste = Array.isArray(blocs) ? blocs.filter((b) => b.entrees && b.entrees.length) : [];
  if (!liste.length) return '';
  const plusieurs = liste.length > 1;
  return `<div class="maj-nouveautes" tabindex="0" aria-label="Nouveautés">${liste.map((b) => `
      ${plusieurs ? `<h3>Version ${esc(b.version)}</h3>` : ''}
      <ul>${b.entrees.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`).join('')}
    </div>`;
}

function dessinerBulleMaj() {
  let b = $('#maj');
  if (!b) {
    b = document.createElement('section');
    b.id = 'maj';
    b.setAttribute('aria-live', 'polite');
    b.setAttribute('aria-label', 'Mise à jour d\'IV Devis');
    b.addEventListener('click', actionBulleMaj);
    b.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); fermerBulleMaj(majBulle !== 'telechargement'); } });
    document.body.appendChild(b);
  }
  const e = majEtat;
  if (!majBulle || !e) { b.classList.remove('show'); return; }
  const v = esc(e.version || e.echec || '');
  let titre = '';
  let corps = '';
  let boutons = '';
  if (majBulle === 'proposition') {
    titre = `IV Devis ${v} est disponible`;
    const poids = e.mode === 'installer' && e.taille ? ` · ${majMo(e.taille)} à télécharger` : '';
    corps = `<p class="maj-meta">Tu as la version ${esc(e.locale)}${poids}</p>${majNouveautesHtml(e.nouveautes)}`
      + (e.mode === 'telecharger' ? '<p class="maj-texte">Version portable : la nouvelle version se télécharge depuis sa page, dans ton navigateur.</p>' : '');
    boutons = e.mode === 'installer'
      ? majBouton('telecharger', 'Mettre à jour', 'primary') + majBouton('plus-tard', 'Plus tard')
      : majBouton('page', 'Ouvrir la page de téléchargement', 'primary') + majBouton('plus-tard', 'Plus tard');
  } else if (majBulle === 'telechargement') {
    const t = e.telechargement || { fait: 0, total: e.taille || 0 };
    const pc = t.total ? Math.min(100, Math.floor((t.fait / t.total) * 100)) : 0;
    titre = `Téléchargement de la version ${v}`;
    corps = `<div class="maj-barre" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pc}"><span style="transform:scaleX(${pc / 100})"></span></div>
      <p class="maj-chiffres"><span>${pc} %</span><span>${majMo(t.fait)} sur ${majMo(t.total)}</span></p>
      <p class="maj-texte">Tu peux continuer à travailler : rien ne s'installe sans toi.</p>`;
    boutons = majBouton('masquer', 'Masquer');
  } else if (majBulle === 'pret') {
    titre = `La version ${v} est prête`;
    corps = '<p class="maj-texte">IV Devis se ferme quelques secondes pour l\'installer, puis se rouvre tout seul. Tes données restent telles quelles.</p>';
    // un document attend d'être enregistré : « À la fermeture » devient le choix mis en avant
    boutons = majMessage && travailNonEnregistre()
      ? majBouton('fermeture', 'À la fermeture', 'primary') + majBouton('installer', 'Installer maintenant')
      : majBouton('installer', 'Installer maintenant', 'primary') + majBouton('fermeture', 'À la fermeture');
  } else if (majBulle === 'programme') {
    titre = 'Mise à jour prévue à la fermeture';
    corps = `<p class="maj-texte">La version ${v} s'installera quand tu fermeras IV Devis. À la prochaine ouverture, tout sera prêt.</p>`;
    boutons = majBouton('installer', 'Installer maintenant') + majBouton('ok', 'Compris', 'primary');
  } else if (majBulle === 'echec') {
    titre = 'La mise à jour n\'a pas abouti';
    corps = `<p class="maj-texte">IV Devis est resté en version ${esc(e.locale)} : la ${v} ne s'est pas installée. Réessaie ; cette fois, la fenêtre de l'installation s'affiche et dit ce qui bloque.</p>`;
    boutons = majBouton('reessayer', 'Réessayer', 'primary') + majBouton('plus-tard', 'Plus tard');
  }
  b.innerHTML = `
    <div class="maj-tete">
      ${ico(majBulle === 'echec' ? 'alerte' : 'maj', 18)}
      <h2 class="maj-titre">${titre}</h2>
      <button type="button" class="maj-croix" data-maj="${majBulle === 'telechargement' ? 'masquer' : 'plus-tard'}" title="Fermer" aria-label="Fermer">${ico('croix', 15)}</button>
    </div>
    ${corps}
    ${majMessage ? `<p class="maj-alerte" role="alert">${ico('alerte', 15)}<span>${esc(majMessage)}</span></p>` : ''}
    <div class="btn-row">${boutons}</div>`;
  b.classList.toggle('echec', majBulle === 'echec');
  b.classList.add('show');
}

function montrerBulleMaj(quoi) {
  majBulle = quoi;
  majMessage = '';
  dessinerBulleMaj();
}

function fermerBulleMaj(plusTard) {
  if (plusTard) majPlusTard = true;
  majBulle = null;
  majMessage = '';
  dessinerBulleMaj();
}

async function actionBulleMaj(ev) {
  const bouton = ev.target.closest('[data-maj]');
  if (!bouton || bouton.disabled) return;
  const quoi = bouton.dataset.maj;
  if (quoi === 'plus-tard') return fermerBulleMaj(true);
  if (quoi === 'masquer' || quoi === 'ok') return fermerBulleMaj(false);
  if (quoi === 'page') { await window.api.maj.ouvrirPage(); return fermerBulleMaj(false); }
  if (quoi === 'telecharger') return majTelecharger(true);
  if ((quoi === 'installer' || quoi === 'reessayer') && travailNonEnregistre()) {
    majMessage = quoi === 'installer'
      ? `${editing.number || 'Le document ouvert'} a des modifications non enregistrées. Enregistre-le d'abord, ou choisis « À la fermeture ».`
      : `${editing.number || 'Le document ouvert'} a des modifications non enregistrées. Enregistre-le d'abord, puis réessaie.`;
    if (quoi === 'installer' && majBulle === 'programme') majMessage = `${editing.number || 'Le document ouvert'} a des modifications non enregistrées. Enregistre-le d'abord ; sinon, la mise à jour attendra la fermeture.`;
    return dessinerBulleMaj();
  }
  $$('#maj [data-maj]').forEach((x) => { x.disabled = true; });
  let r;
  if (quoi === 'installer') r = await window.api.maj.installer();
  else if (quoi === 'reessayer') r = await window.api.maj.installer({ reessayer: true });
  else if (quoi === 'fermeture') r = await window.api.maj.programmer(true);
  if (!r) return;
  majEtat = r.etat || majEtat;
  if (!r.ok) {
    majMessage = r.erreur;
    if (quoi === 'reessayer' && majEtat.etat === 'disponible' && !majEtat.pret) majBulle = 'proposition';
    return dessinerBulleMaj();
  }
  if (quoi === 'fermeture') return montrerBulleMaj('programme');
  // installer / réessayer : IV Devis se ferme (ce qui attend s'enregistre), l'installateur prend la suite
  const t = $('#maj .maj-titre');
  if (t) t.textContent = 'Fermeture pour la mise à jour…';
}

// Télécharger la version proposée ; `montrer` : la bulle suit la progression.
async function majTelecharger(montrer) {
  if (montrer) montrerBulleMaj('telechargement');
  const r = await window.api.maj.telecharger();
  majEtat = r.etat || majEtat;
  delete majEtat.telechargement;
  majPanneau();
  if (!r.ok) {
    if (montrer || majBulle) { majBulle = 'proposition'; majMessage = r.erreur; dessinerBulleMaj(); }
    return false;
  }
  if (montrer || majBulle === 'telechargement') montrerBulleMaj('pret');
  return true;
}

// Mode automatique : télécharger sans rien demander, puis programmer l'installation à la fermeture.
async function majAutomatique() {
  if (!(await majTelecharger(false))) return;
  const p = await window.api.maj.programmer(true);
  majEtat = p.etat || majEtat;
  majPanneau();
  if (p.ok) montrerBulleMaj('programme');
}

// Que faire de l'état reçu : proposer, ou (case cochée) télécharger et programmer.
function majSuite() {
  const e = majEtat;
  if (!e) return;
  if (e.echec) return montrerBulleMaj('echec');
  if (e.etat !== 'disponible') return;
  if (e.programme) return;
  if (e.mode === 'installer' && db.settings.majAuto) return majAutomatique();
  if (majPlusTard) return;
  montrerBulleMaj(e.pret ? 'pret' : 'proposition');
}

async function lancerVeilleMaj() {
  if (!window.api.maj) return;
  window.api.maj.onProgression((p) => {
    if (!majEtat) return;
    majEtat.telechargement = p;
    if (majBulle === 'telechargement') dessinerBulleMaj();
  });
  majEtat = await window.api.maj.etat(15);
  majPanneau();
  majSuite();
}

/* Paramètres › Mises à jour */
function majStatut() {
  const e = majEtat;
  const heure = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (!window.api.maj) return { ton: '', texte: 'Les mises à jour se vérifient dans le logiciel installé.' };
  if (!e || e.etat === 'inconnu') return { ton: '', texte: 'Vérification en cours…' };
  if (e.echec) return { ton: 'attention', texte: `La mise à jour vers la version ${esc(e.echec)} n'a pas abouti : IV Devis est resté en ${esc(e.locale)}.` };
  if (e.programme) return { ton: 'ok', texte: `La version ${esc(e.version)} est téléchargée : elle s'installera à la fermeture d'IV Devis.` };
  const quand = e.verifieLe ? ` Vérifié à ${heure(e.verifieLe)}.` : '';
  switch (e.etat) {
    case 'aucun': return { ton: '', texte: 'Copie de développement : les mises à jour ne sont pas vérifiées.' };
    case 'a-jour': return { ton: 'ok', texte: `Tu as la version ${esc(e.locale)} : c'est la plus récente.${quand}` };
    case 'disponible': return { ton: 'nouveau', texte: `La version ${esc(e.version)} est disponible (tu as la ${esc(e.locale)}).${e.pret ? ' Elle est déjà téléchargée.' : ''}` };
    case 'introuvable': return { ton: '', texte: `Aucune version n'est encore publiée.${quand}` };
    case 'refusee': return { ton: 'attention', texte: 'La fiche de la dernière version a été refusée : sa signature ne correspond pas. Rien n\'a été téléchargé.' };
    default: return { ton: 'attention', texte: 'Le serveur des mises à jour ne répond pas (pas de connexion ?). IV Devis réessaiera à la prochaine ouverture.' };
  }
}

function majStatutHtml() {
  const s = majStatut();
  const icone = s.ton === 'ok' ? 'coche' : s.ton === 'attention' ? 'alerte' : 'info';
  const voir = majEtat && majEtat.etat === 'disponible' && !majEtat.programme ? ' <button type="button" class="lien-maj" id="s-maj-voir">Voir</button>' : '';
  return `<p class="maj-statut ${s.ton}" id="maj-statut">${ico(icone)}<span>${s.texte}${voir}</span></p>`;
}

function panneauMajHtml() {
  if (MOBILE) return `
    <div class="panel" id="maj-panneau">
      <h2>${ico('maj')}Mises à jour</h2>
      <p class="maj-statut ok">${ico('coche')}<span>Version ${esc(appInfo.version || '—')}. Cet appareil se met à jour tout seul : à chaque ouverture avec internet, il cherche la nouvelle version, la télécharge en arrière-plan et l'applique à l'ouverture suivante.</span></p>
      <p class="maj-note">Rien d'autre ne part avec cette question : tes clients, devis et factures restent dans l'appareil.</p>
    </div>`;
  const portable = majEtat && majEtat.mode === 'telecharger';
  return `
    <div class="panel" id="maj-panneau">
      <h2>${ico('maj')}Mises à jour</h2>
      <div id="maj-statut-zone">${majStatutHtml()}</div>
      <label class="maj-case">
        <input type="checkbox" id="s-maj-auto" ${db.settings.majAuto ? 'checked' : ''} ${portable || !window.api.maj ? 'disabled' : ''} />
        <span>Installer les mises à jour automatiquement
          <span class="maj-note">${portable ? 'Version portable : elle ne s\'installe pas, la page de téléchargement s\'ouvre à la place.' : 'La nouvelle version se télécharge pendant que tu travailles et s\'installe à la fermeture d\'IV Devis.'}</span>
        </span>
      </label>
      <div class="btn-row"><button type="button" class="btn" id="s-maj-verifier" ${window.api.maj ? '' : 'disabled'}>${ico('actualiser')}Vérifier maintenant</button></div>
      <p class="maj-note maj-confidence">Pour vérifier, IV Devis demande seulement s'il existe une nouvelle version : aucun devis, facture ou client ne part avec cette question. Chaque version publiée est signée, et un fichier qui ne correspond pas à sa signature est refusé.</p>
    </div>`;
}

// Le statut se met à jour en place quand l'état change (Paramètres ouverts).
function majPanneau() {
  const zone = $('#maj-statut-zone');
  if (!zone) return;
  zone.innerHTML = majStatutHtml();
  const voir = $('#s-maj-voir');
  if (voir) voir.onclick = () => { majPlusTard = false; montrerBulleMaj(majEtat.pret ? 'pret' : 'proposition'); };
}

function brancherPanneauMaj() {
  majPanneau();
  const auto = $('#s-maj-auto');
  if (auto) auto.onchange = async () => {
    db.settings.majAuto = auto.checked;
    await persist();
    toast(auto.checked ? '✅ Les mises à jour s\'installeront à la fermeture' : 'Les mises à jour seront proposées, sans s\'installer seules');
    if (auto.checked) majSuite();
  };
  const verifier = $('#s-maj-verifier');
  if (verifier) verifier.onclick = async () => {
    verifier.disabled = true;
    verifier.innerHTML = ico('actualiser') + 'Vérification…';
    majEtat = await window.api.maj.verifier();
    verifier.disabled = false;
    verifier.innerHTML = ico('actualiser') + 'Vérifier maintenant';
    majPanneau();
    majPlusTard = false;
    majSuite();
  };
}

/* ---------- Données pour un téléphone ou une tablette (2.10.0) ----------
   Le PC prépare un « paquet » : toutes les données telles quelles (clients, devis, factures,
   catalogue, packs, réglages, verrou), chiffrées avec un code choisi à l'instant (paquet.js).
   L'appareil l'importe, reçoit son propre code de poste (T1, T2…, noté ici dans
   settings.postesAppareils) et s'ouvre comme le PC. Le jeton du site n'y entre jamais.
   Sur l'appareil, la même carte devient « Données de cet appareil » (mobile.js). */
function panneauAppareilHtml() {
  if (MOBILE) return `
    <div class="panel" id="p-appareil">
      <h2>${ico('appareil')}Données de cet appareil</h2>
      <p class="hint" style="margin-bottom:12px">Ces données viennent du paquet préparé sur l'ordinateur. Ce qui est saisi ensuite d'un côté n'arrive de l'autre que par la <strong>synchronisation avec le site</strong> ou par un nouveau paquet. Une copie de sécurité est gardée à chaque ouverture, puis toutes les 10 minutes de travail (les 10 dernières).</p>
      <p class="hint" style="margin-bottom:12px">Le catalogue, les prix, les packs et la fiche entreprise viennent de l'ordinateur : ils se mettent à jour tout seuls à chaque ouverture, une fois l'appareil connecté au site (${db.settings.reglagesRecusLe
        ? `dernière mise à jour : <strong>${esc(new Date(db.settings.reglagesRecusLe).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }))}</strong>`
        : 'aucune mise à jour reçue pour le moment'}).</p>
      <div class="btn-row">
        <button type="button" class="btn primary" id="s-appareil-remplacer">Remplacer les données…</button>
        <button type="button" class="btn" id="s-appareil-copies">Copies de sécurité…</button>
        <button type="button" class="btn" id="s-appareil-exporter">Exporter mes données</button>
      </div>
    </div>`;
  if (typeof PAQUET === 'undefined' || !window.api.saveTextFile) return '';
  return `
    <div class="panel" id="p-appareil">
      <h2>${ico('appareil')}Données pour un appareil</h2>
      <p class="hint" style="margin-bottom:12px">Pour un téléphone ou une tablette de l'entreprise : prépare un fichier qui contient <strong>toutes</strong> tes données telles qu'elles sont maintenant (clients, devis, factures, catalogue, packs, réglages, verrou), chiffré avec un code que tu choisis. Fais passer le fichier sur l'appareil (câble, clé USB, WhatsApp) et donne le code de vive voix : sans lui, le fichier est illisible. L'appareil reçoit son propre code de poste (le prochain : <strong id="s-paquet-prochain">${esc(PAQUET.codeAppareilPropose(db))}</strong>) : ses documents ne reprennent jamais les numéros de ce PC. Ta connexion au site ne part jamais dans le fichier.</p>
      <div class="btn-row"><button type="button" class="btn primary" id="s-paquet">Préparer les données pour un appareil…</button></div>
    </div>`;
}

async function preparerPaquet() {
  const code = await askText(`Choisis le code du paquet (${PAQUET.CODE_MIN} caractères au moins) : l'appareil le demandera`, 'text');
  if (code === null) return;
  if (code.length < PAQUET.CODE_MIN) { toast(`⚠️ Code trop court : ${PAQUET.CODE_MIN} caractères au moins`); return; }
  const appareil = PAQUET.codeAppareilPropose(db);
  if (!appareil) { toast('⚠️ Plus aucun code d\'appareil libre (T1 à T99)'); return; }
  await viderAttente();
  const avant = (db.settings.postesAppareils || []).slice();
  db.settings.postesAppareils = [...avant, appareil];
  try {
    const texte = await PAQUET.chiffrer(db, code, appInfo.version, { code: appareil });
    const res = await window.api.saveTextFile({
      defaultName: `IV-Devis-donnees-${todayIso()}${PAQUET.EXTENSION}`, content: texte,
      filterName: 'Paquet de données IV Devis', filterExt: 'ivpaquet'
    });
    if (!res || !res.ok) {
      db.settings.postesAppareils = avant;
      if (res && !res.canceled) toast('❌ Paquet non enregistré : ' + (res.error || 'erreur inconnue'));
      return;
    }
    await persist();
    const prochain = $('#s-paquet-prochain');
    if (prochain) prochain.textContent = PAQUET.codeAppareilPropose(db);
    toast(`✅ Paquet prêt : ${db.clients.length} clients, ${db.documents.length} documents · code de l'appareil : ${appareil}. Donne le code du paquet à part.`, 9000);
  } catch (e) {
    db.settings.postesAppareils = avant;
    toast('❌ Paquet impossible : ' + e.message);
  }
}

function brancherPanneauAppareil() {
  const lier = (id, action) => { const b = $(id); if (b) b.onclick = action; };
  lier('#s-paquet', preparerPaquet);
  lier('#s-appareil-remplacer', async () => {
    await viderAttente();
    try { await window.api.remplacerDonnees(); } catch (e) { toast('❌ Remplacement impossible : ' + e.message); }
  });
  lier('#s-appareil-copies', async () => {
    await viderAttente();
    try { await window.api.revenirACopie(); } catch (e) { toast('❌ Retour impossible : ' + e.message); }
  });
  lier('#s-appareil-exporter', async () => {
    await viderAttente();
    try { if (await window.api.exporterDonnees()) toast('✅ Données exportées'); } catch (e) { toast('❌ Export impossible : ' + e.message); }
  });
}

/* ---------- Démarrage ---------- */

// Mode navigateur (essais hors Electron) : stockage localStorage, pas d'export PDF.
// La version téléphone / tablette n'y passe jamais : mobile.js, chargé avant, fournit
// le pont complet (IndexedDB, PDF, partage, paquet de données).
if (!window.api) {
  window.api = {
    loadData: async () => JSON.parse(localStorage.getItem('devispro') || 'null') || { settings: {}, clients: [], documents: [] },
    saveData: async (data) => { localStorage.setItem('devispro', JSON.stringify(data)); return true; },
    pickLogo: async () => { toast('Disponible uniquement dans l\'application'); return null; },
    exportPdf: async () => { toast('Export PDF disponible uniquement dans l\'application'); return { ok: false, canceled: true }; },
    sendVia: async () => { toast('Envoi disponible uniquement dans l\'application'); return { ok: false, canceled: true }; },
    confirmDialog: async (o) => window.confirm(typeof o === 'string' ? o : (o.message + (o.detail ? '\n' + o.detail : ''))),
    alertDialog: async (o) => { window.alert(o.message + (o.detail ? '\n' + o.detail : '')); return true; },
    appInfo: async () => ({ version: 'dev', updated: '—', dossier: '(navigateur)' }),
    dataState: async () => ({ etat: 'ok' }),
    listBackups: async () => [],
    setSecret: async (nom, valeur) => { if (valeur) localStorage.setItem('secret-' + nom, valeur); else localStorage.removeItem('secret-' + nom); return true; },
    getSecret: async (nom) => localStorage.getItem('secret-' + nom) || '',
    saveTextFile: async ({ defaultName, content }) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
      a.download = defaultName;
      a.click();
      return { ok: true, path: defaultName };
    }
  };
}

(async function init() {
  db = await window.api.loadData();
  if (window.api.appInfo) {
    appInfo = await window.api.appInfo();
    const footer = $('.sidebar-footer');
    if (footer && appInfo.version) footer.textContent = `Données sur cet ${MOBILE ? 'appareil' : 'ordinateur'} · v${appInfo.version}`;
  }
  // garanties de structure pour les anciennes versions du fichier
  db.settings = db.settings || {};
  db.settings.company = Object.assign({
    name: '', tagline: '', website: '', address: '', phone: '', email: '', rccm: '', niu: '',
    logo: '', validityDays: 30, fallbackPhone: '+237696737218',
    paymentTermsFr: 'Paiement à réception de la facture.',
    paymentTermsEn: 'Payment due upon receipt of invoice.'
  }, db.settings.company || {});
  db.clients = db.clients || [];
  // (plus de réécriture des noms à chaque lancement : la forme saisie fait foi)
  db.documents = db.documents || [];
  horodaterModifs(); // mémorise l'état d'ouverture : seules les modifications à venir seront datées
  if (!logoSur(db.settings.company.logo)) db.settings.company.logo = '';
  db.settings.cloudBackupDir = db.settings.cloudBackupDir || '';
  db.settings.exportsDir = db.settings.exportsDir || '';
  db.catalog = db.catalog || {};
  db.catalog.equivalences = db.catalog.equivalences || [];
  db.catalog.services = db.catalog.services || [];
  db.catalog.phrases = db.catalog.phrases || [];
  db.catalog.packTexts = Object.assign({ premium: '', access: '', standard: '' }, db.catalog.packTexts || {});

  // Appartenance aux packs : à la première ouverture, on reprend exactement
  // les règles d'origine — aucun prix ne change.
  let migre = false;
  for (const s of [...db.catalog.equivalences, ...db.catalog.services]) {
    if (!s.packs) { s.packs = packsParDefaut(s); migre = true; }
  }
  if (corrigerCoquilles()) migre = true;

  // le jeton de session quitte data.json pour le coffre chiffré de Windows
  if (window.api.getSecret) {
    sbRefresh = (await window.api.getSecret('sync')) || '';
    if (db.settings.syncRefreshToken) {
      if (!sbRefresh) await memoriserJeton(db.settings.syncRefreshToken);
      delete db.settings.syncRefreshToken;
      migre = true;
    }
  }
  // compteurs de numérotation : figés sur l'existant
  if (!db.compteurs) { db.compteurs = {}; db.documents.forEach((d) => reserverNumero(d.number)); migre = true; }
  if (migre) await persist();

  appliquerTheme();
  initBarreTitre();
  initRaccourcis();

  // verrou optionnel : uniquement si un mot de passe a été défini
  if (verrouActif()) await showLockScreen();

  setView('dashboard');

  // rattrapage unique des devis passés en « Accepté » tout seuls avant la 2.2.0
  await corrigerStatutsAutomatiques();

  // poste neuf installé avec les réglages de l'agence : on le dit une fois
  if (window.api.dataState) {
    const lecture = await window.api.dataState();
    if (lecture && lecture.etat === 'regles') {
      toast('✅ Réglages de l\'agence installés sur ce poste'
        + (lecture.poste ? ` · code de poste ${lecture.poste} (modifiable dans Paramètres › Numérotation)` : ''), lecture.poste ? 9000 : 2600);
    } else if (lecture && lecture.etat === 'importe') {
      // téléphone ou tablette : premier lancement, paquet de l'ordinateur importé (mobile.js)
      toast(`✅ Données de l'ordinateur ouvertes · code de cet appareil : ${lecture.poste} (Réglages › Numérotation)`, 9000);
    } else if (lecture && lecture.reglages === 'mis-a-jour') {
      // nouvelle version : les réglages de l'agence ont remplacé ceux du poste (main.js)
      toast('✅ Réglages de l\'agence mis à jour (fiche entreprise, catalogue, packs)', 7000);
    }
  }

  // écran « Nouveautés » une seule fois après une mise à jour (pas à la première installation)
  if (appInfo.version && appInfo.version !== 'dev' && db.settings.lastSeenVersion !== appInfo.version) {
    const premiereInstallation = !db.settings.lastSeenVersion && !db.documents.length && !db.clients.length;
    db.settings.lastSeenVersion = appInfo.version;
    await persist();
    if (!premiereInstallation) showWhatsNew(appInfo.version);
  }

  // téléphone ou tablette : les réglages de l'agence du PC (catalogue, prix, packs…) relus sur le site
  reglagesAgenceAOuverture().catch(() => {});

  // synchronisation automatique : récupération puis envoi au démarrage, puis toutes les 10 minutes
  demarrerSynchroAuto();

  // une seule question part à l'ouverture : « y a-t-il une nouvelle version ? »
  lancerVeilleMaj();
})();

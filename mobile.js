/* IV Devis — pont MOBILE (téléphone et tablette), 07/10/2026, sur le modèle d'IV Clients.
   Chargé AVANT renderer.js dans la version mobile seulement. Il fournit le même
   `window.api` que preload.js sur Windows, avec les moyens du navigateur :
   l'interface (index.html, renderer.js, styles.css) reste UNE seule et même copie.

   - Données : IndexedDB de l'appareil (stockage demandé « persistant »).
   - Premier lancement : écran d'import du paquet chiffré préparé par le PC, puis le
     code de poste de l'appareil (ses numéros ne rejoignent jamais ceux du PC).
   - Copies de sécurité : 10 copies gardées dans l'appareil (ouverture + 10 min).
   - Le jeton du site est rangé à part (setSecret), jamais dans les données, les copies
     ni l'export.
   - PDF : fabriqué dans l'appareil (pdf-mobile.js) puis donné au menu Partager
     (WhatsApp, Telegram, Fichiers…) ; à défaut, la fenêtre d'impression du système. */
'use strict';

(() => {
  const VERSION = '2.11.0';          // posée par fabriquer-mobile.py
  const MISE_A_JOUR = '10/10/2026';
  const COPIES_GARDEES = 10;
  const ECART_COPIES = 10 * 60 * 1000;
  const SEUIL_DISPARITION = 5;            // le garde-fou du PC (main.js)

  document.documentElement.classList.add('mobile');

  /* ---------- IndexedDB : une table clé → valeur ---------- */
  let base = null;
  function ouvrirBase() {
    if (base) return base;
    base = new Promise((ok, ko) => {
      const r = indexedDB.open('iv-devis', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
    return base;
  }
  async function lire(cle) {
    const b = await ouvrirBase();
    return new Promise((ok, ko) => {
      const r = b.transaction('kv').objectStore('kv').get(cle);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
    });
  }
  async function ecrire(cle, valeur) {
    const b = await ouvrirBase();
    return new Promise((ok, ko) => {
      const t = b.transaction('kv', 'readwrite');
      t.objectStore('kv').put(valeur, cle);
      t.oncomplete = () => ok(true);
      t.onerror = () => ko(t.error);
      t.onabort = () => ko(t.error || new Error('écriture interrompue'));
    });
  }

  const copie = (v) => JSON.parse(JSON.stringify(v));
  const sansJeton = (obj) => {
    const c = copie(obj);
    if (c && c.settings) delete c.settings.syncRefreshToken;
    return c;
  };
  const valides = (d) => !!d && typeof d === 'object' && Array.isArray(d.clients)
    && Array.isArray(d.documents) && !!d.settings && typeof d.settings === 'object';
  const horodate = (d = new Date()) => {
    const z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}h${z(d.getMinutes())}`;
  };
  const echapper = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- copies de sécurité dans l'appareil ---------- */
  let derniereCopie = 0;                 // en mémoire : un enregistrement ne relit pas les copies
  async function copier(db, suffixe) {
    if (!valides(db)) return;
    derniereCopie = Date.now();
    const liste = (await lire('copies')) || [];
    liste.unshift({ nom: `donnees-${horodate()}${suffixe || ''}.json`, t: Date.now(), db: sansJeton(db) });
    await ecrire('copies', liste.slice(0, COPIES_GARDEES));
  }
  async function copieSiEcart(db) {
    if (Date.now() - derniereCopie > ECART_COPIES) await copier(db);
  }

  /* ---------- fenêtres de l'application (jamais confirm() ni alert() bruts) ---------- */
  function fenetre({ message, detail, boutons }) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay mobile-dialogue';
      ov.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true"><div class="modal-title"></div><p class="mobile-detail"></p><div class="btn-row mobile-actions"></div></div>';
      ov.querySelector('.modal-title').textContent = message || 'IV Devis';
      const p = ov.querySelector('.mobile-detail');
      if (detail) p.textContent = detail; else p.remove();
      const zone = ov.querySelector('.mobile-actions');
      boutons.forEach(([libelle, valeur, classe]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + (classe || '');
        b.textContent = libelle;
        b.onclick = () => { ov.remove(); resolve(valeur); };
        zone.appendChild(b);
      });
      document.body.appendChild(ov);
      zone.lastChild.focus();
    });
  }

  /* ---------- donner un fichier : partage du système, sinon téléchargement ---------- */
  function telecharger(fichier) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(fichier);
    a.download = fichier.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  const peutPartager = (fichier) => !!(navigator.canShare && navigator.share && navigator.canShare({ files: [fichier] }));

  /* Appli Android (APK, 09/10/2026) : son module natif IVEnvoi (android-app/) remplace le
     menu Partager du navigateur, absent d'une appli. Dans un navigateur il n'existe pas,
     et rien ne change. envoyerNatif rend 'ouvert' ou 'absente' ; une erreur remonte. */
  const envoiNatif = () => {
    const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.IVEnvoi;
    return p && typeof p.envoyer === 'function' ? p : null;
  };
  const base64De = (fichier) => new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => ko(r.error);
    r.readAsDataURL(fichier);
  });
  async function envoyerNatif(fichier, canal, numero, texte) {
    const r = await envoiNatif().envoyer({
      base64: await base64De(fichier), nom: fichier.name, type: fichier.type || 'application/octet-stream',
      canal: canal || '', numero: String(numero || ''), texte: String(texte || '')
    });
    return r && r.etat;
  }

  /* 'partage', 'annule' ou 'impossible'. Le partage exige un geste récent : si la
     préparation a été longue, un bouton « Partager » redonne ce geste. */
  async function partager(donnees, invitation) {
    try {
      await navigator.share(donnees);
      return 'partage';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'annule';
      if (!(e && e.name === 'NotAllowedError')) return 'impossible';
    }
    const oui = await fenetre({ message: 'Le fichier est prêt', detail: invitation, boutons: [['Annuler', false, ''], ['Partager…', true, 'primary']] });
    if (!oui) return 'annule';
    try {
      await navigator.share(donnees);
      return 'partage';
    } catch (e) {
      return e && e.name === 'AbortError' ? 'annule' : 'impossible';
    }
  }

  async function donnerFichier(fichier, invitation) {
    if (envoiNatif()) {
      try { return (await envoyerNatif(fichier)) === 'ouvert'; } catch (e) { console.warn('Partage de l\'appli impossible :', e); }
    }
    if (peutPartager(fichier)) {
      const r = await partager({ files: [fichier] }, invitation || 'Choisis où l\'enregistrer ou l\'envoyer.');
      if (r === 'partage') return true;
      if (r === 'annule') return false;
    }
    telecharger(fichier);
    return true;
  }

  function choisirFichier(accept) {
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'file';
      i.accept = accept;
      i.onchange = () => resolve(i.files && i.files[0] ? i.files[0] : null);
      i.click();
    });
  }

  /* ---------- écran d'import du paquet, puis code de l'appareil ---------- */
  /* Écran plein (premier lancement) ou fenêtre (Paramètres → Remplacer). Résout avec
     { db, code } ou null si l'on renonce. Rien n'est écrit ici. `codeActuel` : le code
     que cet appareil porte déjà (remplacement). */
  function ecranImport(premier, codeActuel) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = premier ? 'lock-screen mobile-import' : 'modal-overlay mobile-import';
      ov.innerHTML = `<div class="${premier ? 'lock-box' : 'modal-box'}" role="dialog" aria-modal="true">
        ${premier ? '<img src="assets/logo-256.png" alt="" class="lock-logo"><div class="lock-title">IV Devis</div>' : '<div class="modal-title">Remplacer les données</div>'}
        <div class="mobile-etape mobile-etape-paquet">
          <p class="mobile-import-texte">${premier
            ? 'Pour ouvrir IV Devis sur cet appareil, choisis le <strong>paquet de données</strong> préparé sur l\'ordinateur (Paramètres › Données pour un appareil), puis saisis son code.'
            : 'Choisis le nouveau paquet préparé sur l\'ordinateur. Les données actuelles de cet appareil sont d\'abord mises de côté dans ses copies de sécurité.'}</p>
          <button type="button" class="btn mobile-choisir">Choisir le fichier…</button>
          <p class="mobile-nom-fichier" hidden></p>
          <input type="password" class="modal-input mobile-code" placeholder="Code du paquet" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Code du paquet">
          <p class="lock-err mobile-err" role="alert"></p>
          <button type="button" class="btn primary mobile-ouvrir">Ouvrir les données</button>
        </div>
        <div class="mobile-etape mobile-etape-poste" hidden>
          <p class="mobile-import-texte">Chaque poste numérote ses documents avec son propre code. Ceux créés sur cet appareil s'appelleront <strong class="mobile-exemple"></strong> : jamais les mêmes numéros que l'ordinateur.</p>
          <label class="mobile-label" for="mobile-code-poste">Code de cet appareil</label>
          <input type="text" id="mobile-code-poste" class="modal-input mobile-code-poste" maxlength="3" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <p class="mobile-pris"></p>
          <p class="lock-err mobile-err-poste" role="alert"></p>
          <button type="button" class="btn primary mobile-valider">${premier ? 'Ouvrir IV Devis' : 'Remplacer les données'}</button>
        </div>
        ${premier ? '' : '<button type="button" class="btn mobile-annuler">Annuler</button>'}
      </div>`;
      document.body.appendChild(ov);
      const $ = (s) => ov.querySelector(s);
      let fichier = null;
      let paquet = null;
      const erreur = (sel, m) => { $(sel).textContent = m || ''; };

      $('.mobile-choisir').onclick = async () => {
        const f = await choisirFichier('.ivpaquet,application/json,text/plain,*/*');
        if (!f) return;
        fichier = f;
        erreur('.mobile-err', '');
        const n = $('.mobile-nom-fichier');
        n.textContent = f.name;
        n.hidden = false;
        $('.mobile-code').focus();
      };

      const annee = new Date().getFullYear();
      const champPoste = $('.mobile-code-poste');
      const exemple = () => {
        const c = PAQUET.codeDe(champPoste.value);
        if (champPoste.value !== c) champPoste.value = c;
        $('.mobile-exemple').textContent = `DEV-${annee}-…-${c || '?'}`;
      };
      champPoste.oninput = () => { exemple(); erreur('.mobile-err-poste', ''); };

      const ouvrir = async () => {
        if (!fichier) { erreur('.mobile-err', 'Choisis d\'abord le fichier du paquet.'); return; }
        const b = $('.mobile-ouvrir');
        b.disabled = true;
        b.textContent = 'Ouverture…';
        try {
          paquet = await PAQUET.dechiffrer(await fichier.text(), $('.mobile-code').value);
        } catch (e) {
          erreur('.mobile-err', e.message);
          b.disabled = false;
          b.textContent = 'Ouvrir les données';
          return;
        }
        // étape 2 : le code de poste de l'appareil
        const propres = [paquet.appareil.code, codeActuel].filter(Boolean);
        const pc = PAQUET.codeDe(paquet.db.settings.poste);
        const pris = [...PAQUET.postesPris(paquet.db)].filter((c) => !propres.includes(c)).sort();
        champPoste.value = PAQUET.codeDe(codeActuel) || paquet.appareil.code || PAQUET.codeAppareilPropose(paquet.db);
        $('.mobile-pris').innerHTML = pris.length
          ? 'Déjà pris : ' + pris.map((c) => `<strong>${echapper(c)}</strong>${c === pc ? ' (l\'ordinateur)' : ''}`).join(', ') + '.'
          : '';
        exemple();
        $('.mobile-etape-paquet').hidden = true;
        $('.mobile-etape-poste').hidden = false;
        champPoste.focus();
      };
      const valider = () => {
        const refus = PAQUET.refusCodeAppareil(champPoste.value, paquet.db, [paquet.appareil.code, codeActuel]);
        if (refus) { erreur('.mobile-err-poste', refus); champPoste.focus(); return; }
        ov.remove();
        resolve({ db: paquet.db, code: PAQUET.codeDe(champPoste.value) });
      };
      $('.mobile-ouvrir').onclick = ouvrir;
      $('.mobile-code').onkeydown = (e) => { if (e.key === 'Enter') ouvrir(); };
      $('.mobile-valider').onclick = valider;
      champPoste.onkeydown = (e) => { if (e.key === 'Enter') valider(); };
      if (!premier) $('.mobile-annuler').onclick = () => { ov.remove(); resolve(null); };
    });
  }

  /* ---------- copies de sécurité : revenir en arrière ---------- */
  function ecranCopies(liste) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay mobile-copies';
      ov.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true">
        <div class="modal-title">Copies de cet appareil</div>
        <p class="mobile-detail">Une copie à chaque ouverture, puis toutes les 10 minutes de travail ; les ${COPIES_GARDEES} plus récentes sont gardées. Revenir à une copie met d'abord les données actuelles de côté.</p>
        <div class="mobile-liste-copies">${liste.length ? liste.map((x, i) => `
          <button type="button" class="mobile-copie" data-i="${i}">
            <span class="mobile-copie-date">${echapper(new Date(x.t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }))}</span>
            <span class="mobile-copie-det">${x.db.documents.length} documents · ${x.db.clients.length} clients${x.nom.includes('-avant-') ? ' · mise de côté' : ''}</span>
          </button>`).join('') : '<p class="mobile-detail">Aucune copie pour le moment.</p>'}</div>
        <div class="btn-row mobile-actions"><button type="button" class="btn mobile-fermer">Fermer</button></div>
      </div>`;
      document.body.appendChild(ov);
      ov.querySelector('.mobile-fermer').onclick = () => { ov.remove(); resolve(null); };
      ov.querySelectorAll('.mobile-copie').forEach((b) => {
        b.onclick = () => { ov.remove(); resolve(liste[Number(b.dataset.i)]); };
      });
    });
  }

  /* ---------- logo : une image de l'appareil, ramenée à 900 px de large (comme le PC) ---------- */
  async function logoDepuis(fichier) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(fichier.type)) return { error: 'Choisis une image PNG, JPG, GIF ou WebP.' };
    try {
      // une adresse data: (la règle de sécurité de la page refuse les adresses blob: pour les images)
      const url = await new Promise((ok, ko) => {
        const r = new FileReader();
        r.onload = () => ok(r.result);
        r.onerror = () => ko(r.error);
        r.readAsDataURL(fichier);
      });
      const img = new Image();
      img.src = url;
      await img.decode();
      const k = Math.min(1, 900 / img.naturalWidth);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.naturalWidth * k));
      cv.height = Math.max(1, Math.round(img.naturalHeight * k));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/png');
    } catch (_) {
      return { error: 'Cette image ne s\'ouvre pas. Choisis un PNG ou un JPG.' };
    }
  }

  /* ---------- PDF ---------- */
  const nomPdf = (nom) => (String(nom || 'document').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\.pdf$/i, '').trim().slice(0, 120) || 'document') + '.pdf';
  async function pdfDe(html, nom) {
    try { return await PDF_MOBILE.fabriquer(html, nom); }
    catch (e) { console.warn('PDF dans l\'appareil impossible, passage par l\'impression :', e); return null; }
  }
  function ouvrirConversation(canal, tel, texte) {
    const n = String(tel || '').replace(/\D/g, '');
    if (!n) return;
    window.open(canal === 'telegram' ? `https://t.me/+${n}` : `https://wa.me/${n}?text=${encodeURIComponent(texte || '')}`, '_blank', 'noopener');
  }

  /* ---------- le pont ---------- */
  let etatLecture = { etat: 'ok' };
  let compte = null;                     // clients et documents enregistrés, pour le garde-fou
  const compter = (d) => ({ documents: d.documents.length, clients: d.clients.length });

  window.api = {
    mobile: true,

    async loadData() {
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
      let db = await lire('db');
      if (!valides(db)) {
        const r = await ecranImport(true, '');
        db = sansJeton(r.db);
        db.settings.poste = r.code;
        await ecrire('db', db);
        etatLecture = { etat: 'importe', poste: r.code };
      }
      await copier(db);                                    // copie d'ouverture, comme sur le PC
      compte = compter(db);
      return copie(db);
    },
    async saveData(obj) {
      if (!valides(obj)) return { ok: false, error: 'Données de forme inattendue : enregistrement refusé.' };
      if (compte) {
        const perteDocs = compte.documents - obj.documents.length;
        const perteClients = compte.clients - obj.clients.length;
        if (perteDocs > SEUIL_DISPARITION || perteClients > SEUIL_DISPARITION) {
          return { ok: false, gardeFou: true, error: `Enregistrement refusé : ${Math.max(perteDocs, 0)} document(s) et ${Math.max(perteClients, 0)} client(s) disparaîtraient d'un coup. Les données de l'appareil sont conservées.` };
        }
      }
      await ecrire('db', sansJeton(obj));
      compte = compter(obj);
      copieSiEcart(obj).catch(() => {});
      return { ok: true };
    },
    dataState: async () => etatLecture,
    async listBackups() {
      return ((await lire('copies')) || []).map((x) => x.nom);
    },
    setSecret: (nom, valeur) => ecrire('secret-' + nom, String(valeur || '')),
    getSecret: async (nom) => (await lire('secret-' + nom)) || '',

    appInfo: async () => ({ version: VERSION, updated: MISE_A_JOUR, dossier: 'cet appareil' }),

    async pickLogo() {
      const f = await choisirFichier('image/png,image/jpeg,image/gif,image/webp');
      return f ? logoDepuis(f) : null;
    },

    confirmDialog: (options) => {
      const o = typeof options === 'string' ? { message: options } : (options || {});
      const ok = o.ok || 'Supprimer';
      return fenetre({ message: o.message, detail: o.detail, boutons: [[o.cancel || 'Annuler', false, ''], [ok, true, /supprimer|retirer|effacer/i.test(ok) ? 'danger' : 'primary']] });
    },
    alertDialog: (o) => fenetre({ message: (o && o.message) || '', detail: o && o.detail, boutons: [['OK', true, 'primary']] }),

    /* Exporter en PDF : le fichier part au menu Partager (Fichiers, Drive, WhatsApp…),
       ou se télécharge ; sur iPhone/iPad, la fenêtre d'impression propose le PDF. */
    async exportPdf(html, defaultName) {
      const nom = nomPdf(defaultName);
      const f = await pdfDe(String(html), nom);
      if (!f) { PDF_MOBILE.imprimer(String(html)); return { ok: true, impression: true, path: nom }; }
      return (await donnerFichier(f, 'Le PDF est prêt : choisis où l\'enregistrer ou l\'envoyer.'))
        ? { ok: true, path: nom } : { ok: false, canceled: true };
    },

    /* WhatsApp / Telegram : le PDF part par le menu Partager (on y choisit l'application,
       puis le client). Sans partage de fichier, il se télécharge et la conversation s'ouvre.
       Dans l'appli Android : WhatsApp (Business) s'ouvre sur la conversation du client, le PDF
       déjà joint ; Telegram reçoit le PDF ; l'appli absente, c'est le menu Partager d'Android. */
    async sendVia({ html, fileName, channel, phone, text }) {
      const nom = nomPdf(fileName);
      const appli = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
      const f = await pdfDe(String(html), nom);
      if (!f) { PDF_MOBILE.imprimer(String(html)); return { ok: true, impression: true, path: nom }; }
      if (envoiNatif()) {
        try {
          if ((await envoyerNatif(f, channel, phone, text)) === 'absente') await envoyerNatif(f, '', '', text);
          return { ok: true, partage: true, path: nom };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      }
      if (peutPartager(f)) {
        const r = await partager({ files: [f], text: String(text || '') }, `Touche « Partager », puis choisis ${appli} et le client.`);
        if (r === 'partage') return { ok: true, partage: true, path: nom };
        if (r === 'annule') return { ok: false, canceled: true };
      }
      telecharger(f);
      ouvrirConversation(channel, phone, text);
      return { ok: true, telecharge: true, path: nom };
    },

    async saveTextFile({ defaultName, content }) {
      const nom = String(defaultName || 'export.txt');
      const type = /\.json$/i.test(nom) ? 'application/json' : /\.csv$/i.test(nom) ? 'text/csv' : 'text/plain';
      return (await donnerFichier(new File([String(content)], nom, { type })))
        ? { ok: true, path: nom } : { ok: false, canceled: true };
    },

    /* propres à la version mobile (Paramètres › Données de cet appareil) */
    async remplacerDonnees() {
      const actuelle = await lire('db');
      const r = await ecranImport(false, actuelle && actuelle.settings && actuelle.settings.poste);
      if (!r) return false;
      await copier(actuelle, '-avant-remplacement');
      const db = sansJeton(r.db);
      db.settings.poste = r.code;
      await ecrire('db', db);
      location.reload();
      return true;
    },
    /* copie de sécurité avant que les réglages de l'agence venus du site remplacent ceux de l'appareil (2.11.0) */
    async miseDeCote(suffixe) {
      await copier(await lire('db'), suffixe || '-avant-reglages');
      return true;
    },
    async exporterDonnees() {
      const db = sansJeton(await lire('db'));
      return donnerFichier(new File([JSON.stringify(db, null, 1)], `IV-Devis-donnees-${horodate()}.json`, { type: 'application/json' }));
    },
    async revenirACopie() {
      const choix = await ecranCopies((await lire('copies')) || []);
      if (!choix) return false;
      const date = new Date(choix.t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
      const oui = await fenetre({ message: `Revenir à la copie du ${date} ?`, detail: 'Les données actuelles de l\'appareil sont d\'abord mises de côté : tu pourras y revenir de la même façon.', boutons: [['Annuler', false, ''], ['Revenir à cette copie', true, 'primary']] });
      if (!oui) return false;
      await copier(await lire('db'), '-avant-retour');
      await ecrire('db', choix.db);
      location.reload();
      return true;
    }
  };

  /* le travail en attente (catalogue) est enregistré quand l'application passe en arrière-plan */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && typeof viderAttente === 'function') viderAttente();
  });

  /* hors ligne : les fichiers de l'application restent dans l'appareil ; une nouvelle
     version se télécharge en arrière-plan et s'applique à l'ouverture suivante */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
  }
})();

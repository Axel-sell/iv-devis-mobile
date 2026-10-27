/* IV Devis — pont MOBILE (téléphone et tablette), 07/10/2026, sur le modèle d'IV Clients.
   Chargé AVANT renderer.js dans la version mobile seulement. Il fournit le même
   `window.api` que preload.js sur Windows, avec les moyens du navigateur :
   l'interface (index.html, renderer.js, styles.css) reste UNE seule et même copie.

   - Données : IndexedDB de l'appareil (stockage demandé « persistant »).
   - Premier lancement (2.12.0) : connexion au site avec le compte de /gestion, SANS fichier ;
     le paquet chiffré préparé par le PC reste possible, en second. Puis le code de poste de
     l'appareil (ses numéros ne rejoignent jamais ceux du PC).
   - Copies de sécurité : 10 copies gardées dans l'appareil (ouverture + 10 min).
   - Le jeton du site est rangé à part (setSecret), jamais dans les données, les copies
     ni l'export.
   - PDF : fabriqué dans l'appareil (pdf-mobile.js) puis donné au menu Partager
     (WhatsApp, Telegram, Fichiers…) ; à défaut, la fenêtre d'impression du système. */
'use strict';

(() => {
  const VERSION = '2.13.0';          // posée par fabriquer-mobile.py
  const MISE_A_JOUR = '27/10/2026';
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
  // données reçues d'un paquet : un paquet d'avant la 2.13.0 porte encore le verrou et l'e-mail du PC ; l'appareil
  // choisit son propre verrou (renderer.js, exigerVerrou). Ouvert par le site, l'e-mail est celui de son propre compte.
  const recues = (obj) => {
    const c = sansJeton(obj);
    if (c && c.settings) for (const k of ['lockHash', 'lock', 'syncEmail']) delete c.settings[k];
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

  /* Appli Android (16/10/2026) : la page lisait mal certains fichiers reçus par WhatsApp ou rangés
     dans Téléchargements (NotReadableError). Le module natif les lit lui-même et rend leurs octets,
     remis ici en File. Un APK plus ancien n'a pas cette méthode : choix du navigateur, comme avant.
     Rend null si l'on renonce ; un fichier illisible rejette avec un message en français. */
  const choixNatif = () => {
    const p = envoiNatif();
    return p && typeof p.choisirFichier === 'function' ? p : null;
  };
  async function choisirFichier(accept) {
    const natif = choixNatif();
    if (natif) {
      const types = accept.split(',').map((t) => t.trim());
      const r = await natif.choisirFichier(types.every((t) => /^[\w.+-]+\/[\w.+-]+$/.test(t)) ? { types } : {});
      if (!r || !r.base64) return null;
      return new File([Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0))], r.nom || 'fichier', { type: r.type || '' });
    }
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'file';
      i.accept = accept;
      i.onchange = () => resolve(i.files && i.files[0] ? i.files[0] : null);
      i.click();
    });
  }

  /* ---------- premier lancement : le site (ou un paquet), puis le code de l'appareil ---------- */
  /* Écran plein (premier lancement) ou fenêtre (Paramètres → Remplacer). Résout avec
     { db, code, site } ou null si l'on renonce. Rien n'est écrit ici. `codeActuel` : le code
     que cet appareil porte déjà (remplacement).
     Premier lancement (2.12.0, demande d'Alex du 26/10/2026) : plus de fichier obligatoire. L'appareil se
     connecte au site avec le compte de /gestion (sbAuth / sbRest de renderer.js, jeton rangé par setSecret),
     y lit les réglages de l'agence et les numéros déjà faits (codes de poste pris), puis s'ouvre ; ses
     clients, devis et factures arrivent juste après (renderer.js, récupération). Le paquet reste en second. */
  const HORS_LIGNE = 'Pas de connexion internet sur cet appareil. La toute première ouverture en a besoin une fois : allume le Wi-Fi ou les données mobiles, puis touche « Se connecter au site ». Ensuite, IV Devis s\'ouvre même sans connexion.';

  /* Données de départ d'un appareil ouvert par le site : les réglages de l'agence du PC appliqués avec
     reglages-agence.js (comme à chaque ouverture), aucun client ni document — la récupération les
     apporte. renderer.js complète le reste (fiche entreprise par défaut, compteurs…). */
  function baseDuSite(site, code) {
    const d = { settings: { poste: code, syncEmail: site.email, syncAuto: true }, clients: [], documents: [], catalog: {} };
    if (site.fichier && REGLAGES_AGENCE.doitImposer(d, site.fichier)) {
      REGLAGES_AGENCE.imposer(d, site.fichier);
      d.settings.reglagesRecusLe = new Date().toISOString();
    }
    return d;
  }

  function ecranImport(premier, codeActuel) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = premier ? 'lock-screen mobile-import' : 'modal-overlay mobile-import';
      ov.innerHTML = `<div class="${premier ? 'lock-box' : 'modal-box'}" role="dialog" aria-modal="true">
        ${premier ? '<img src="assets/logo-256.png" alt="" class="lock-logo"><div class="lock-title">IV Devis</div>' : '<div class="modal-title">Remplacer les données</div>'}
        ${premier ? `<div class="mobile-etape mobile-etape-site">
          <p class="mobile-import-texte">Connecte-toi avec ton <strong>compte du site</strong> Immigration Voyages, le même que pour /gestion. Les clients, devis, factures et le catalogue de l'agence arrivent tout seuls.</p>
          <label class="mobile-label" for="mobile-email">E-mail</label>
          <input type="email" id="mobile-email" class="modal-input mobile-email" autocomplete="username" autocapitalize="off" spellcheck="false" inputmode="email">
          <label class="mobile-label" for="mobile-mdp">Mot de passe</label>
          ${champMotDePasse('id="mobile-mdp" class="modal-input mobile-mdp" autocomplete="current-password"')}
          <div class="mobile-bloc-code" hidden>
            <p class="mobile-import-texte">Ton compte demande aussi le code affiché par ton <strong>application d'authentification</strong>, comme sur /gestion.</p>
            <label class="mobile-label" for="mobile-code-site">Code à 6 chiffres</label>
            <input type="text" id="mobile-code-site" class="modal-input mobile-code-site" inputmode="numeric" autocomplete="one-time-code" maxlength="9">
          </div>
          <p class="lock-err mobile-err-site" role="alert"></p>
          <button type="button" class="btn primary mobile-connecter">Se connecter au site</button>
          <p class="mobile-progres" aria-live="polite" hidden></p>
          <button type="button" class="btn mobile-lien mobile-vers-paquet">J'ai un fichier de données</button>
        </div>` : ''}
        <div class="mobile-etape mobile-etape-paquet"${premier ? ' hidden' : ''}>
          <p class="mobile-import-texte">${premier
            ? 'Choisis le <strong>fichier de données</strong> préparé sur l\'ordinateur (Paramètres › Données pour un appareil), puis saisis son code.'
            : 'Choisis le nouveau paquet préparé sur l\'ordinateur. Les données actuelles de cet appareil sont d\'abord mises de côté dans ses copies de sécurité.'}</p>
          <button type="button" class="btn mobile-choisir">Choisir le fichier…</button>
          <p class="mobile-nom-fichier" hidden></p>
          ${champMotDePasse('class="modal-input mobile-code" placeholder="Code du paquet" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Code du paquet"')}
          <p class="lock-err mobile-err" role="alert"></p>
          <button type="button" class="btn primary mobile-ouvrir">Ouvrir les données</button>
          ${premier ? '<button type="button" class="btn mobile-lien mobile-vers-site">Me connecter au site plutôt</button>' : ''}
        </div>
        <div class="mobile-etape mobile-etape-poste" hidden>
          <p class="mobile-import-texte">Chaque poste numérote ses documents avec son propre code. Ceux créés sur cet appareil s'appelleront <strong class="mobile-exemple"></strong> : jamais les mêmes numéros que l'ordinateur.</p>
          <label class="mobile-label" for="mobile-code-poste">Code de cet appareil</label>
          <input type="text" id="mobile-code-poste" class="modal-input mobile-code-poste" maxlength="3" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <p class="mobile-pris"></p>
          <p class="mobile-note" hidden></p>
          <p class="lock-err mobile-err-poste" role="alert"></p>
          <button type="button" class="btn primary mobile-valider">${premier ? 'Ouvrir IV Devis' : 'Remplacer les données'}</button>
        </div>
        ${premier ? '' : '<button type="button" class="btn mobile-annuler">Annuler</button>'}
      </div>`;
      document.body.appendChild(ov);
      const $ = (s) => ov.querySelector(s);
      let texte = null;
      let lecture = null;
      let paquet = null;
      let site = null;                       // { email, fichier } : appareil ouvert par le site
      let choix = null;                      // { repere, propres } : de quoi juger le code de l'appareil
      const erreur = (sel, m) => { $(sel).textContent = m || ''; };
      const etape = (nom) => ov.querySelectorAll('.mobile-etape').forEach((e) => { e.hidden = !e.classList.contains('mobile-etape-' + nom); });

      // Le fichier est lu dès qu'il est choisi : lu plus tard, au clic sur « Ouvrir », le navigateur
      // refuse (NotReadableError) si un antivirus ou une synchronisation l'a touché entre-temps.
      $('.mobile-choisir').onclick = async () => {
        let f;
        try {
          f = await choisirFichier('.ivpaquet,application/json,text/plain,*/*');
        } catch (e) {
          erreur('.mobile-err', (e && e.message) || 'Ce fichier n\'a pas pu être lu. Copie-le dans le dossier Téléchargements, puis choisis-le de nouveau.');
          return;
        }
        if (!f) return;
        const n = $('.mobile-nom-fichier');
        texte = null;
        n.hidden = true;
        lecture = f.text().then((t) => { texte = t; }, () => {});
        await lecture;
        if (!texte) {
          erreur('.mobile-err', 'Ce fichier n\'a pas pu être lu (souvent un antivirus ou une synchronisation qui le bloque un instant). Copie-le dans le dossier Téléchargements, puis choisis-le de nouveau.');
          return;
        }
        erreur('.mobile-err', '');
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

      // étape 2 : le code de poste de l'appareil. `repere` : des données qui montrent les codes pris
      // (le paquet, ou ce que le site en dit) ; `propres` : les codes que cet appareil peut garder.
      const allerAuCode = (repere, propres, propose) => {
        choix = { repere, propres };
        const pc = PAQUET.codeDe(repere.settings.poste);
        const pris = [...PAQUET.postesPris(repere)].filter((c) => !propres.includes(c)).sort();
        champPoste.value = propose;
        $('.mobile-pris').innerHTML = pris.length
          ? 'Déjà pris : ' + pris.map((c) => `<strong>${echapper(c)}</strong>${c === pc ? ' (l\'ordinateur)' : ''}`).join(', ') + '.'
          : '';
        exemple();
        etape('poste');
        champPoste.focus();
      };

      const ouvrir = async () => {
        if (lecture) await lecture;
        if (!texte) { erreur('.mobile-err', 'Choisis d\'abord le fichier du paquet.'); return; }
        const b = $('.mobile-ouvrir');
        b.disabled = true;
        b.textContent = 'Ouverture…';
        const code = $('.mobile-code').value;
        try {
          // espaces, tirets et majuscules : paquet.js essaie lui-même les écritures possibles du code
          paquet = await PAQUET.dechiffrer(texte, code);
        } catch (e) {
          erreur('.mobile-err', /^Code incorrect/.test(e.message)
            ? e.message + ' Le code est celui choisi sur l\'ordinateur en préparant ce fichier (pas le mot de passe du site). Les espaces, les tirets et les majuscules ne comptent pas.'
            : (typeof enFrancais === 'function' ? enFrancais(e.message) : e.message));
          b.disabled = false;
          b.textContent = 'Ouvrir les données';
          return;
        }
        site = null;
        allerAuCode(paquet.db, [paquet.appareil.code, codeActuel].filter(Boolean),
          PAQUET.codeDe(codeActuel) || paquet.appareil.code || PAQUET.codeAppareilPropose(paquet.db));
      };

      // Connexion au site : le compte, puis les réglages de l'agence et les numéros déjà faits
      const progres = (m) => { const p = $('.mobile-progres'); if (p) { p.textContent = m || ''; p.hidden = !m; } };
      // compte à double authentification (2.12.1) : après le mot de passe, le code à 6 chiffres
      let facteur = null;
      const sansCode = () => { facteur = null; $('.mobile-bloc-code').hidden = true; $('.mobile-code-site').value = ''; };
      const connecter = async () => {
        const email = $('.mobile-email').value.trim();
        const mdp = $('.mobile-mdp').value;
        if (!email || !mdp) { erreur('.mobile-err-site', 'Saisis l\'e-mail et le mot de passe de ton compte du site.'); return; }
        if (navigator.onLine === false) { erreur('.mobile-err-site', HORS_LIGNE); return; }
        const b = $('.mobile-connecter');
        b.disabled = true;
        b.textContent = facteur ? 'Vérification…' : 'Connexion…';
        erreur('.mobile-err-site', '');
        let fichier = null;
        let docs = [];
        try {
          if (!facteur) {
            facteur = await sbMotDePasse(email, mdp);
            if (facteur) {
              $('.mobile-bloc-code').hidden = false;
              b.disabled = false;
              b.textContent = 'Valider le code';
              $('.mobile-code-site').focus();
              return;
            }
          } else {
            await sbCode(facteur, $('.mobile-code-site').value);
            sansCode();
          }
          progres('Lecture des réglages de l\'agence…');
          const lignes = await sbRest(`catalog?key=eq.${REGLAGES_AGENCE.CLE_SITE}&select=data`);
          fichier = (lignes && lignes[0] && lignes[0].data) || null;
          progres('Lecture des devis et factures déjà faits…');
          docs = (await sbRest('documents?select=numero')) || [];
          // un compte qui ne voit rien de l'agence (pas un compte de l'équipe) : on ne s'ouvre pas à vide
          if (!fichier && !docs.length && !((await sbRest('clients?select=id&limit=1')) || []).length) {
            const e = new Error('Ce compte ne voit ni le catalogue ni les documents de l\'agence. Connecte-toi avec un compte de l\'équipe, celui de /gestion.');
            e.lu = true;
            throw e;
          }
        } catch (e) {
          if (facteur && e && e.codeRefuse) {
            erreur('.mobile-err-site', e.message);
            b.disabled = false;
            b.textContent = 'Valider le code';
            $('.mobile-code-site').select();
            return;
          }
          sansCode();
          try { await memoriserJeton(''); } catch (_) { /* rien à oublier */ }
          const m = String((e && e.message) || e);
          erreur('.mobile-err-site', e && e.authRefusee
            ? 'E-mail ou mot de passe incorrect. Ce sont ceux de ton compte du site Immigration Voyages (le même que pour /gestion).'
            : e && e.lu ? m
              : navigator.onLine === false ? HORS_LIGNE
                : e instanceof TypeError || /fetch|network|load failed|ne répond pas|internet/i.test(m)
                  ? 'Le site ne répond pas. Vérifie la connexion internet de cet appareil (Wi-Fi ou données mobiles), puis réessaie.'
                  : 'Connexion impossible : ' + (typeof enFrancais === 'function' ? enFrancais(m) : m));
          progres('');
          b.disabled = false;
          b.textContent = 'Se connecter au site';
          return;
        }
        progres('');
        b.disabled = false;
        b.textContent = 'Se connecter au site';
        site = { email, fichier };
        paquet = null;
        const src = (fichier && fichier.reglagesSource) || {};
        const repere = { settings: { poste: src.posteSource || '', postesPris: (fichier && fichier.postesPris) || [] },
          documents: docs.map((l) => ({ number: l.numero })) };
        const note = $('.mobile-note');
        note.textContent = fichier ? '' : 'Le catalogue et les prix de l\'agence ne sont pas encore sur le site. Sur l\'ordinateur : Paramètres › « ⬆ Envoyer maintenant vers le site ». Ils arriveront ici tout seuls à l\'ouverture suivante.';
        note.hidden = !!fichier;
        allerAuCode(repere, [], PAQUET.codeAppareilPropose(repere));
      };

      const valider = () => {
        const refus = PAQUET.refusCodeAppareil(champPoste.value, choix.repere, choix.propres);
        if (refus) { erreur('.mobile-err-poste', refus); champPoste.focus(); return; }
        const code = PAQUET.codeDe(champPoste.value);
        ov.remove();
        resolve(site ? { db: baseDuSite(site, code), code, site: true } : { db: paquet.db, code });
      };
      $('.mobile-ouvrir').onclick = ouvrir;
      $('.mobile-code').onkeydown = (e) => { if (e.key === 'Enter') ouvrir(); };
      $('.mobile-valider').onclick = valider;
      champPoste.onkeydown = (e) => { if (e.key === 'Enter') valider(); };
      if (premier) {
        $('.mobile-connecter').onclick = connecter;
        $('.mobile-email').onkeydown = (e) => { if (e.key === 'Enter') $('.mobile-mdp').focus(); };
        $('.mobile-mdp').onkeydown = (e) => { if (e.key === 'Enter') connecter(); };
        $('.mobile-code-site').onkeydown = (e) => { if (e.key === 'Enter') connecter(); };
        // un autre compte ou un autre mot de passe : on repart du mot de passe
        $('.mobile-email').oninput = $('.mobile-mdp').oninput = () => {
          if (facteur) { sansCode(); $('.mobile-connecter').textContent = 'Se connecter au site'; erreur('.mobile-err-site', ''); }
        };
        $('.mobile-vers-paquet').onclick = () => { etape('paquet'); $('.mobile-choisir').focus(); };
        $('.mobile-vers-site').onclick = () => { etape('site'); $('.mobile-email').focus(); };
      } else {
        $('.mobile-annuler').onclick = () => { ov.remove(); resolve(null); };
      }
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
        db = r.site ? sansJeton(r.db) : recues(r.db);
        db.settings.poste = r.code;
        await ecrire('db', db);
        etatLecture = { etat: r.site ? 'connecte' : 'importe', poste: r.code };
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
      let f;
      try {
        f = await choisirFichier('image/png,image/jpeg,image/gif,image/webp');
      } catch (e) {
        return { error: (e && e.message) || 'Cette image ne s\'ouvre pas. Choisis un PNG ou un JPG.' };
      }
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
      const db = r.site ? sansJeton(r.db) : recues(r.db);
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
      // un fichier qui sort de l'appareil ne porte ni l'empreinte du verrou ni l'e-mail du compte du site
      if (db && db.settings) for (const k of ['lockHash', 'lock', 'syncEmail']) delete db.settings[k];
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
     version se télécharge en arrière-plan, puis le service worker recharge la page */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
    /* Une application seulement remise au premier plan ne cherche pas de nouvelle version
       (le navigateur ne le fait qu'à l'ouverture) : on le demande au retour après 10 minutes
       d'absence (2.12.0, comme IV Clients 1.38.1). */
    let cachee = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { cachee = Date.now(); return; }
      if (cachee && Date.now() - cachee > 10 * 60 * 1000) {
        navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
      }
    });
  }
})();

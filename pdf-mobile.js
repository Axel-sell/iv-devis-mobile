/* IV Devis mobile — le PDF d'un devis ou d'une facture, fabriqué DANS l'appareil (07/10/2026).
   Sans bibliothèque ni internet. La page est celle du PC (buildPdfHtml, une seule copie) :
   - découpée en pages A4 aux marges de printToPDF (haut 0,45 po, bas 0,5 po ; côtés : le CSS) ;
   - pied de page et filigrane répétés sur chaque page, comme à l'impression ;
   - coupures placées entre deux lignes : jamais au milieu d'une ligne, d'un pack ou d'une rangée ;
   - chaque page devient une image JPEG (2 pixels par point), assemblées dans un PDF minimal.
   Safari (iPhone, iPad) refuse de dessiner ce genre d'image : fabriquer() échoue alors, et
   l'appelant passe par la fenêtre d'impression du système (imprimer()). */
'use strict';

const PDF_MOBILE = (() => {
  const LARGEUR = 794;                 // A4 : 210 mm à 96 px par pouce
  const HAUTEUR = 1123;                // 297 mm
  const MARGE_HAUT = 43;               // 0,45 pouce, comme main.js (printToPDF)
  const MARGE_BAS = 48;                // 0,5 pouce
  const ZONE = HAUTEUR - MARGE_HAUT - MARGE_BAS;
  const ECHELLE = 2;
  const XHTML = 'http://www.w3.org/1999/xhtml';

  // la page du PC hors de <body> : pied et filigrane posés sur chaque feuille (chacun dans un
  // .ivd-corps sans marge, pour hériter de la police du corps comme sous <body>)
  const SURCHARGE = `
    .ivd-feuille { position: relative; width: ${LARGEUR}px; height: ${HAUTEUR}px; background: #fff; overflow: hidden; isolation: isolate; }
    .ivd-zone { position: absolute; left: 0; top: ${MARGE_HAUT}px; width: ${LARGEUR}px; }
    .ivd-zone .watermark, .ivd-zone .footer { position: absolute; }`;

  /* buildPdfHtml → ses styles (body devient .ivd-corps), son corps, son pied, son filigrane */
  function lirePage(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n')
      .replace(/(^|[}\s,])body(?=[\s{,])/g, '$1.ivd-corps');
    const prendre = (classe) => {
      const e = [...doc.body.children].find((x) => x.classList.contains(classe));
      if (!e) return '';
      e.remove();
      return e.outerHTML;
    };
    const filigrane = prendre('watermark');
    const pied = prendre('footer');
    return { css: css + SURCHARGE, filigrane, pied, corps: doc.body.innerHTML };
  }

  /* les morceaux qu'une coupure ne doit pas traverser, en px depuis le haut du corps */
  function blocs(corps) {
    const o = corps.getBoundingClientRect().top;
    const liste = [];
    const ajouter = (r) => { if (r.height > 0) liste.push([r.top - o, r.bottom - o]); };
    const plage = document.createRange();
    const parcours = document.createTreeWalker(corps, NodeFilter.SHOW_TEXT);
    for (let n = parcours.nextNode(); n; n = parcours.nextNode()) {
      if (!n.textContent.trim()) continue;
      plage.selectNodeContents(n);
      for (const r of plage.getClientRects()) ajouter(r);
    }
    corps.querySelectorAll('img, tr, .pack, .totals, .client-box, .ps-r, .row')
      .forEach((e) => ajouter(e.getBoundingClientRect()));
    return liste;
  }

  /* [début, fin, en-tête] de chaque page : la coupure la plus basse qui ne traverse aucun
     bloc ; une page qui commence au milieu d'un tableau répète son en-tête, comme à
     l'impression sur le PC. */
  function coupures(total, liste, utile, tableaux = []) {
    const pages = [];
    const solides = liste.filter(([t, b]) => b - t < utile * 0.95);
    let debut = 0;
    for (;;) {
      const entete = tableaux.find((t) => debut > t.corpsHaut + 1 && debut < t.bas - 1) || null;
      const place = utile - (entete ? entete.hauteur : 0);
      if (total - debut <= place) {
        pages.push([debut, Math.ceil(total), entete]);
        return pages;
      }
      const limite = debut + place;
      const candidats = new Set([limite]);
      for (const [t, b] of solides) {
        if (t > debut && t <= limite) candidats.add(t);
        if (b > debut && b <= limite) candidats.add(b);
      }
      let coupe = limite;
      for (const y of [...candidats].sort((a, b) => b - a)) {
        if (y < debut + place * 0.35) break;
        if (!solides.some(([t, b]) => t < y - 0.5 && b > y + 0.5)) { coupe = y; break; }
      }
      coupe = Math.floor(coupe);
      if (coupe <= debut) coupe = Math.floor(limite);
      pages.push([debut, coupe, entete]);
      debut = coupe;
    }
  }

  async function imagesPretes(racine) {
    await Promise.all([...racine.querySelectorAll('img')].map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
  }

  /* mesure dans la page (ombre isolée, hors de l'écran), au même gabarit que la feuille */
  async function mesurer(m) {
    const hote = document.createElement('div');
    hote.style.cssText = `position:fixed;left:-30000px;top:0;width:${LARGEUR}px;pointer-events:none`;
    document.body.appendChild(hote);
    try {
      const ombre = hote.attachShadow({ mode: 'open' });
      // :host repart des valeurs initiales, comme la page vierge de l'imprimante du PC et
      // l'image dessinée ensuite (sinon l'interligne de l'application change les coupures)
      ombre.innerHTML = `<style>:host { all: initial; }${m.css}</style>
        <div class="ivd-zone" style="position:relative;top:0;height:${ZONE}px"><div class="ivd-corps" style="padding:0">${m.pied}</div></div>
        <div class="ivd-corps ivd-principal">${m.corps}</div>`;
      await imagesPretes(ombre);
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const corps = ombre.querySelector('.ivd-principal');
      const pied = ombre.querySelector('.footer');
      const utile = ZONE - (pied ? Math.ceil(pied.getBoundingClientRect().height) + 10 : 0);
      const o = corps.getBoundingClientRect().top;
      // l'en-tête de chaque tableau, avec la largeur de ses colonnes, pour le répéter
      const tableaux = [...corps.querySelectorAll('table')].filter((t) => t.tHead && t.tHead.rows.length).map((t) => {
        const rt = t.getBoundingClientRect();
        const rh = t.tHead.getBoundingClientRect();
        const tete = t.tHead.cloneNode(true);
        [...t.tHead.rows[0].cells].forEach((c, i) => { tete.rows[0].cells[i].style.width = c.getBoundingClientRect().width + 'px'; });
        return { corpsHaut: rh.bottom - o, bas: rt.bottom - o, hauteur: Math.ceil(rh.height), largeur: rt.width, html: tete.outerHTML };
      });
      return coupures(corps.getBoundingClientRect().height, blocs(corps), utile, tableaux);
    } finally {
      hote.remove();
    }
  }

  /* une feuille A4 → image JPEG */
  async function dessiner(m, debut, fin, entete) {
    const h = entete ? entete.hauteur : 0;
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = `<div class="ivd-feuille">
      <div class="ivd-zone" style="height:${ZONE}px"><div class="ivd-corps" style="padding:0">${m.filigrane}</div></div>
      ${entete ? `<div class="ivd-zone" style="height:${h}px;overflow:hidden"><div class="ivd-corps" style="padding-top:0;padding-bottom:0"><table style="table-layout:fixed;width:${entete.largeur}px;margin:0">${entete.html}</table></div></div>` : ''}
      <div class="ivd-zone" style="top:${MARGE_HAUT + h}px;height:${fin - debut}px;overflow:hidden"><div class="ivd-corps" style="margin-top:${-debut}px">${m.corps}</div></div>
      <div class="ivd-zone" style="height:${ZONE}px"><div class="ivd-corps" style="padding:0">${m.pied}</div></div>
    </div>`;
    const xml = new XMLSerializer();
    const style = doc.createElementNS(XHTML, 'style');
    style.textContent = m.css;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${LARGEUR}" height="${HAUTEUR}">`
      + `<foreignObject x="0" y="0" width="${LARGEUR}" height="${HAUTEUR}"><div xmlns="${XHTML}">`
      + xml.serializeToString(style) + xml.serializeToString(doc.body.firstElementChild)
      + '</div></foreignObject></svg>';
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = LARGEUR * ECHELLE;
    cv.height = HAUTEUR * ECHELLE;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    // Safari lève ici une erreur de sécurité : l'appelant passe par l'impression
    const blob = await new Promise((ok, ko) => {
      try { cv.toBlob((b) => (b ? ok(b) : ko(new Error('image de page impossible'))), 'image/jpeg', 0.9); }
      catch (e) { ko(e); }
    });
    return { jpeg: new Uint8Array(await blob.arrayBuffer()), l: cv.width, h: cv.height };
  }

  /* texte d'un PDF en UTF-16 (accents, apostrophes) */
  const texteHex = (t) => '<FEFF' + [...String(t)].map((c) => {
    const n = c.codePointAt(0);
    const u = n > 0xFFFF ? [0xD800 + ((n - 0x10000) >> 10), 0xDC00 + ((n - 0x10000) & 0x3FF)] : [n];
    return u.map((x) => x.toString(16).toUpperCase().padStart(4, '0')).join('');
  }).join('') + '>';

  /* les images de page → un PDF 1.4 : une image JPEG pleine page par feuille A4 */
  function assembler(pages, titre) {
    const enc = new TextEncoder();
    const morceaux = [];
    const positions = [];
    let pos = 0;
    const ajouter = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; morceaux.push(b); pos += b.length; };
    const objet = (n, dico, flux) => {
      positions[n] = pos;
      ajouter(`${n} 0 obj\n${dico}\n`);
      if (flux) { ajouter('stream\n'); ajouter(flux); ajouter('\nendstream\n'); }
      ajouter('endobj\n');
    };
    ajouter('%PDF-1.4\n%âãÏÓ\n');
    const z = (n) => String(n).padStart(2, '0');
    const d = new Date();
    objet(1, '<< /Type /Catalog /Pages 2 0 R >>');
    objet(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 3 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`);
    objet(3, `<< /Title ${texteHex(titre)} /Producer (IV Devis) /CreationDate (D:${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}) >>`);
    pages.forEach((p, i) => {
      const o = 4 + 3 * i;
      objet(o, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /P${i} ${o + 1} 0 R >> >> /Contents ${o + 2} 0 R >>`);
      objet(o + 1, `<< /Type /XObject /Subtype /Image /Width ${p.l} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
      const dessin = enc.encode(`q 595.28 0 0 841.89 0 0 cm /P${i} Do Q`);
      objet(o + 2, `<< /Length ${dessin.length} >>`, dessin);
    });
    const total = 4 + 3 * pages.length;
    const xref = pos;
    let table = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let n = 1; n < total; n++) table += String(positions[n]).padStart(10, '0') + ' 00000 n \n';
    ajouter(`${table}trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(morceaux, { type: 'application/pdf' });
  }

  /* html de buildPdfHtml → File PDF (rejette si l'appareil refuse de dessiner) */
  async function fabriquer(html, nom) {
    const m = lirePage(html);
    const decoupe = await mesurer(m);
    const pages = [];
    for (const [debut, fin, entete] of decoupe) pages.push(await dessiner(m, debut, fin, entete));
    return new File([assembler(pages, String(nom || 'document').replace(/\.pdf$/i, ''))], nom, { type: 'application/pdf' });
  }

  /* Secours (Safari) : la fenêtre d'impression du système, qui propose « Enregistrer en PDF »
     ou Partager. La page s'imprime seule ; l'application est masquée le temps de l'impression. */
  function imprimer(html) {
    document.querySelectorAll('#ivd-impression, #ivd-impression-regle').forEach((e) => e.remove());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const css = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n')
      .replace(/(^|[}\s,])body(?=[\s{,])/g, '$1.ivd-corps');
    const zone = document.createElement('div');
    zone.id = 'ivd-impression';
    zone.attachShadow({ mode: 'open' }).innerHTML = `<style>:host { all: initial; }${css}
      .ivd-corps, .ivd-corps * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }</style>
      <div class="ivd-corps">${doc.body.innerHTML}</div>`;
    const regle = document.createElement('style');
    regle.id = 'ivd-impression-regle';
    regle.textContent = `#ivd-impression { display: none; }
      @media print {
        @page { size: A4; margin: 0.45in 0 0.5in; }
        html, body { background: #fff !important; height: auto !important; overflow: visible !important; }
        body > :not(#ivd-impression) { display: none !important; }
        #ivd-impression { display: block !important; }
      }`;
    document.head.appendChild(regle);
    document.body.appendChild(zone);
    const fin = () => { zone.remove(); regle.remove(); };
    addEventListener('afterprint', fin, { once: true });
    setTimeout(() => window.print(), 60);
  }

  return { fabriquer, imprimer, coupures };
})();

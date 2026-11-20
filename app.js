/* ============================================================
   Pointage des garderies occasionnelles et des retards
   Logique applicative
   ============================================================ */

(function () {
  /* ============================================================
     CONSTANTES ET VARIABLES GLOBALES
     ============================================================ */
  const MOIS_ORDER = [8, 9, 10, 11, 12, 2, 3, 4, 5, 6, 7];
  const MOIS_NOMS = { 1: 'Janvier', 2: 'Février', 3: 'Mars', 4: 'Avril', 5: 'Mai', 6: 'Juin', 7: 'Juillet', 8: 'Août', 9: 'Septembre', 10: 'Octobre', 11: 'Novembre', 12: 'Décembre' };
  const STORAGE = 'garderie_v9';
  const MAX_QUARTS = 5;

  let state = { 
    params: { prixQuart: 10.00, prixOccasionnel: 10.00 }, 
    tarification: { coutAnnuel: 6500, nbMois: 11 }, 
    enfants: [], 
    facturation: {}, 
    lastExport: null, 
    anneeReference: null 
  };
  
   // On récupère les mois déjà traités dans la mémoire du navigateur
  let moisTraites = JSON.parse(localStorage.getItem('garderie_mois_traites')) || [];
  // On cherche le premier mois qui n'est pas encore traité
  let premierMoisNonTraite = MOIS_ORDER.find(m => !moisTraites.includes(m));
  // On ouvre l'application sur ce mois, ou sur Août si tout est traité
  let moisActif = premierMoisNonTraite !== undefined ? premierMoisNonTraite : 8;

  let sousTabActif = 'inscrit';
  let selection = new Set();
  let idsEnEdition = new Set(); // Enfants actuellement modifiables (via bouton « Modifier »)
  let importPreview = null;
  let dragContext = null;
  let dragOverInfo = null;
  let filtreCreneau = 'tous';

  /* ============================================================
     FENÊTRES DE CONFIRMATION (MODALES)
     ============================================================ */
  let confirmResolve = null;
  function showConfirm(message, opts) {
    opts = opts || {};
    return new Promise(resolve => {
      confirmResolve = resolve;
      let overlay = document.getElementById('modalConfirm');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'modalConfirm';
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div class="modal" style="max-width:480px;"><h3 id="confirmTitle"></h3><p id="confirmMessage" style="color:#2d4a60; font-size:.92rem; line-height:1.6; white-space:pre-line;"></p><div class="modal-actions"><button class="btn btn-ghost" id="confirmAnnuler">Annuler</button><button class="btn btn-danger" id="confirmOk">Confirmer</button></div></div>`;
        document.body.appendChild(overlay);
      }
      const okBtn = document.getElementById('confirmOk');
      const cancelBtn = document.getElementById('confirmAnnuler');
      if (opts.infoOnly) { 
        okBtn.textContent = 'OK'; 
        okBtn.className = 'btn btn-primary'; 
        cancelBtn.style.display = 'none'; 
      } else { 
        okBtn.textContent = opts.okLabel || 'Confirmer'; 
        okBtn.className = opts.dangerous === false ? 'btn btn-primary' : 'btn btn-danger'; 
        cancelBtn.style.display = ''; 
      }
      document.getElementById('confirmTitle').innerHTML = opts.title ? `<i class="fas fa-${opts.icon || 'question-circle'}" style="color:#2c6e9c; margin-right:.4rem;"></i> ${opts.title}` : `<i class="fas fa-question-circle" style="color:#2c6e9c; margin-right:.4rem;"></i> Confirmation`;
      document.getElementById('confirmMessage').textContent = message;
      overlay.classList.add('visible');
      const fermer = (val) => { 
        overlay.classList.remove('visible'); 
        okBtn.onclick = null; 
        cancelBtn.onclick = null; 
        if (confirmResolve) { 
          const r = confirmResolve; 
          confirmResolve = null; 
          r(val); 
        } 
      };
      okBtn.onclick = () => fermer(true);
      cancelBtn.onclick = () => fermer(false);
      overlay.onclick = (e) => { if (e.target === overlay) fermer(!!opts.infoOnly); };
    });
  }

  /* ============================================================
     GESTION DES DATES ET DE L'ANNÉE SCOLAIRE
     ============================================================ */
  function determinerAnneeReference() {
    if (state.anneeReference) return state.anneeReference;
    let dateMax = null;
    Object.values(state.facturation).forEach(moisData => { 
      Object.values(moisData || {}).forEach(item => { 
        (item.lignes || []).forEach(l => { 
          if (l.date) { 
            const d = new Date(l.date + 'T12:00:00'); 
            if (!dateMax || d > dateMax) dateMax = d; 
          } 
        }); 
      }); 
    });
    if (dateMax) { 
      const mois = dateMax.getMonth() + 1; 
      const annee = dateMax.getFullYear(); 
      state.anneeReference = (mois >= 8) ? annee : annee - 1; 
    } else { 
      const now = new Date(); 
      const moisCourant = now.getMonth() + 1; 
      state.anneeReference = (moisCourant >= 8) ? now.getFullYear() : now.getFullYear() - 1; 
    }
    return state.anneeReference;
  }

  function getAnneeMois(moisNum) { 
    const ref = determinerAnneeReference(); 
    return (moisNum >= 8) ? ref : ref + 1; 
  }

  function getBornesMois(moisNum) { 
    const annee = getAnneeMois(moisNum); 
    const lastDay = new Date(annee, moisNum, 0).getDate(); 
    const pad = n => String(n).padStart(2, '0'); 
    return { min: `${annee}-${pad(moisNum)}-01`, max: `${annee}-${pad(moisNum)}-${pad(lastDay)}` }; 
  }

  function estDansMois(dateStr, moisNum) { 
    if (!dateStr) return true; 
    const bornes = getBornesMois(moisNum); 
    return dateStr >= bornes.min && dateStr <= bornes.max; 
  }

  function formatDateFR(iso) { 
    if (!iso) return ''; 
    const [y, m, d] = iso.split('-'); 
    return `${d}/${m}/${y}`; 
  }

  /* ============================================================
     CALCUL DES TARIFS
     ============================================================ */
  function calcTarif(enfant, ligne) {
    const moment = ligne.moment || ''; 
    const quarts = ligne.quarts || 0; 
    const prixOcc = state.params.prixOccasionnel || 0; 
    const prixQ = state.params.prixQuart || 0;
    let nbMoments = 0;
    if (enfant) {
      if (enfant.statut === 'non_inscrit') { 
        if (moment === 'matin' || moment === 'soir') nbMoments = 1; 
        else if (moment === 'matin_soir') nbMoments = 2; 
      } else {
        if (moment === 'matin') { 
          if (enfant.inscription !== 'matin' && enfant.inscription !== 'matin_soir') nbMoments = 1; 
        } else if (moment === 'soir') { 
          if (enfant.inscription !== 'soir' && enfant.inscription !== 'matin_soir') nbMoments = 1; 
        } else if (moment === 'matin_soir') { 
          if (enfant.inscription !== 'matin' && enfant.inscription !== 'matin_soir') nbMoments++; 
          if (enfant.inscription !== 'soir' && enfant.inscription !== 'matin_soir') nbMoments++; 
        }
      }
    }
    return nbMoments * prixOcc + quarts * prixQ;
  }

  /* ============================================================
     SAUVEGARDE LOCALE (LOCALSTORAGE)
     ============================================================ */
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) { 
        const p = JSON.parse(raw); 
        if (p.params) state.params = Object.assign(state.params, p.params); 
        if (p.tarification) state.tarification = Object.assign(state.tarification, p.tarification); 
        if (p.enfants) state.enfants = p.enfants; 
        if (p.facturation) state.facturation = p.facturation; 
        if (p.lastExport) state.lastExport = p.lastExport; 
        if (p.anneeReference) state.anneeReference = p.anneeReference; 
      }
    } catch (e) { console.warn(e); }
    if (state.enfants.length === 0) {
      try { 
        const old = localStorage.getItem('garderie_v8') || localStorage.getItem('garderie_v7'); 
        if (old) { 
          const p = JSON.parse(old); 
          if (p.enfants) state.enfants = p.enfants; 
          if (p.facturation) state.facturation = p.facturation; 
          if (p.params) state.params = Object.assign(state.params, p.params); 
          if (p.tarification) state.tarification = Object.assign(state.tarification, p.tarification); 
          if (p.anneeReference) state.anneeReference = p.anneeReference; 
          save(); 
        } 
      } catch (e) { }
    }
    Object.values(state.facturation).forEach(moisData => { 
      Object.values(moisData || {}).forEach(item => { 
        (item.lignes || []).forEach(l => { 
          if (l.moment === 'aprem') l.moment = 'soir'; 
          delete l.type; 
          delete l.montant; 
        }); 
      }); 
    });
  }
  
  function save() { localStorage.setItem(STORAGE, JSON.stringify(state)); }
  function initMois() { MOIS_ORDER.forEach(m => { if (!state.facturation[m]) state.facturation[m] = {}; }); }
  function genId() { return Date.now() + '-' + Math.random().toString(36).substr(2, 9); }
  function euro(v) { return (v || 0).toFixed(2).replace('.', ',') + ' €'; }
  function enfantById(id) { return state.enfants.find(e => e.id === id); }
  function nomComplet(e) { return e ? (e.nom + ' ' + e.prenom).trim() : '—'; }
  function keyEnfant(e) { return ((e.nom || '') + '|' + (e.prenom || '')).trim().toLowerCase(); }
  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function normalizeStr(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

  /* ============================================================
     CALCULS D'AFFICHAGE
     ============================================================ */
  function totalEnfantMois(enfantId) { 
    const m = state.facturation[moisActif]?.[enfantId]; 
    if (!m) return 0; 
    const enfant = enfantById(enfantId); 
    return m.lignes.reduce((s, l) => s + calcTarif(enfant, l), 0); 
  }

  function totalMois() { 
    let t = 0; 
    Object.entries(state.facturation[moisActif] || {}).forEach(([enfantId, m]) => { 
      const enfant = enfantById(enfantId); 
      m.lignes.forEach(l => t += calcTarif(enfant, l)); 
    }); 
    return t; 
  }

  /* ============================================================
     AFFICHAGE DU POINTAGE (ONGLET 1)
     ============================================================ */
  const moisGrid = document.getElementById('moisGrid');
  const facturationContent = document.getElementById('facturationContent');
  const totalMoisSpan = document.getElementById('totalMois');
  const resteDuMontant = document.getElementById('resteDuMontant');

    function renderMois() { 
    if (!moisGrid) return; 
    moisGrid.innerHTML = ''; 
    MOIS_ORDER.forEach(m => { 
      const btn = document.createElement('button'); 
      const estTraite = moisTraites.includes(m);
      btn.className = 'mois-btn' + (m === moisActif ? ' active' : '') + (estTraite ? ' traite' : ''); 
      btn.innerHTML = MOIS_NOMS[m] + (estTraite ? ' <i class="fas fa-check"></i>' : ''); 
      
      btn.addEventListener('click', () => { 
        moisActif = m; 
        renderMois(); 
        renderFacturation(); 
        majBoutonTraite(); // <-- On met à jour le bouton quand on change de mois
      }); 
      moisGrid.appendChild(btn); 
    }); 
  }
  
     function majBoutonTraite() {
    const btn = document.getElementById('btnMarquerTraite');
    if (!btn) return;
    if (moisTraites.includes(moisActif)) {
      btn.innerHTML = '<i class="fas fa-undo"></i> Marquer comme non traité';
      btn.className = 'btn btn-ghost';
    } else {
      btn.innerHTML = '<i class="fas fa-check"></i> Marquer comme traité';
      btn.className = 'btn btn-primary';
    }
  }

     function toggleMoisTraite() {
    if (moisTraites.includes(moisActif)) {
      moisTraites = moisTraites.filter(m => m !== moisActif);
    } else {
      moisTraites.push(moisActif);
      // On affiche le message SEULEMENT si on vient de marquer le mois comme traité
      showConfirm(
        "Le mois a bien été marqué comme traité.\n\nN'oubliez pas de faire une sauvegarde de vos données au format JSON dans l'onglet Données.", 
        { infoOnly: true, title: 'Mois clôturé', icon: 'check-circle' }
      );
    }
    localStorage.setItem('garderie_mois_traites', JSON.stringify(moisTraites));
    renderMois();
    majBoutonTraite();
  }

  function renderFacturation() {
    if (!facturationContent) return;
    const moisData = state.facturation[moisActif] || {};
    facturationContent.innerHTML = '';
    
    const enfantIds = Object.keys(moisData).sort((a, b) => {
      const enfantA = enfantById(a);
      const enfantB = enfantById(b);
      const nomA = enfantA ? (enfantA.nom + ' ' + enfantA.prenom).toLowerCase() : '';
      const nomB = enfantB ? (enfantB.nom + ' ' + enfantB.prenom).toLowerCase() : '';
      return nomA.localeCompare(nomB, 'fr');
    });
    
    const bornes = getBornesMois(moisActif);
    const nomMois = MOIS_NOMS[moisActif];
    const annee = getAnneeMois(moisActif);

    if (enfantIds.length === 0) {
      facturationContent.innerHTML = `<div class="empty-state"><i class="fas fa-inbox"></i>Aucun enfant enregistré pour ${nomMois} ${annee}.<br>Cliquez sur « Ajouter un enfant au mois » pour commencer.</div>`;
      if (totalMoisSpan) totalMoisSpan.textContent = euro(0);
      return;
    }

    enfantIds.forEach(enfantId => {
      const item = moisData[enfantId];
      const enfant = enfantById(enfantId);
      if (!enfant) return;

      const group = document.createElement('div');
      group.className = 'enfant-group';

      const header = document.createElement('div');
      header.className = 'enfant-group-header';
      const total = totalEnfantMois(enfantId);
      const badgeClass = enfant.statut === 'inscrit' ? 'inscrit' : 'noninscrit';
      const badgeLabel = enfant.statut === 'inscrit' ? 'Inscrit' : 'Non inscrit';
      let badgeInscr = '';
      if (enfant.statut === 'inscrit' && enfant.inscription) {
        const map = { matin: 'Matin', soir: 'Soir', matin_soir: 'Matin+Soir' };
        const cls = { matin: 'matins', soir: 'soirs', matin_soir: 'matinssoirs' };
        badgeInscr = `<span class="badge ${cls[enfant.inscription]}"><i class="fas fa-clock"></i> ${map[enfant.inscription]}</span>`;
      }
      
      header.innerHTML = `
        <div class="enfant-info">
          <span class="enfant-name">${nomComplet(enfant)}</span>
          <span class="badge ${badgeClass}">${badgeLabel}</span>
          ${badgeInscr}
        </div>
        
        <div class="enfant-montant">
          <span class="enfant-montant-label">Montant à régler :</span>
          <span class="enfant-total">${euro(total)}</span>
          <button class="btn-icon btn-capture" data-id="${enfantId}" title="Télécharger la capture d'écran"><i class="fas fa-camera"></i></button>
        </div>
      `;
      group.appendChild(header);

      const lignesWrap = document.createElement('div');
      lignesWrap.className = 'enfant-lignes';
      lignesWrap.dataset.enfantId = enfantId;

      const entete = document.createElement('div');
      entete.className = 'ligne-entete';
      entete.innerHTML = `<span></span><span>Date</span><span>Présence</span><span>Retard</span><span style="text-align:right; padding-right:.3rem;">Tarif</span><span></span>`;
      lignesWrap.appendChild(entete);

      if (item.lignes.length === 0) {
        const vide = document.createElement('div');
        vide.style.cssText = 'padding:.8rem; color:#8aa0b0; font-size:.85rem; font-style:italic;';
        vide.textContent = 'Aucune date pour cet enfant.';
        lignesWrap.appendChild(vide);
      }

      item.lignes.forEach(ligne => {
        const tarif = calcTarif(enfant, ligne);
        const row = document.createElement('div');
        row.className = 'ligne-date';
        row.dataset.ligneId = ligne.id;
        row.dataset.enfantId = enfantId;
        row.draggable = false;

        // Poignée drag
        const handle = document.createElement('div');
        handle.className = 'drag-handle';
        handle.innerHTML = '<i class="fas fa-grip-vertical"></i>';
        handle.title = 'Glisser pour réordonner';
        handle.addEventListener('mousedown', () => { row.draggable = true; });
        handle.addEventListener('mouseup', () => { row.draggable = false; });
        row.appendChild(handle);

        // Date
        const inputDate = document.createElement('input');
        inputDate.type = 'date';
        inputDate.className = 'input-field';
        inputDate.min = bornes.min;
        inputDate.max = bornes.max;
        inputDate.value = ligne.date || '';
        inputDate.title = `Date entre le ${formatDateFR(bornes.min)} et le ${formatDateFR(bornes.max)}`;
        inputDate.addEventListener('change', e => {
          const val = e.target.value;
          if (val && !estDansMois(val, moisActif)) {
            inputDate.classList.add('invalid-date');
            const b = getBornesMois(moisActif);
            showConfirm(`La date saisie (${formatDateFR(val)}) n'appartient pas au mois de ${MOIS_NOMS[moisActif]} ${getAnneeMois(moisActif)}.\n\nDates autorisées : du ${formatDateFR(b.min)} au ${formatDateFR(b.max)}.\n\nLa valeur a été effacée.`, { infoOnly: true, title: 'Date refusée', icon: 'calendar-times' });
            inputDate.value = '';
            ligne.date = '';
            save();
            setTimeout(() => inputDate.classList.remove('invalid-date'), 1500);
            return;
          }
          inputDate.classList.remove('invalid-date');
          ligne.date = val;
          save();
        });
        row.appendChild(inputDate);

        // Présence
        const selPresence = document.createElement('select');
        selPresence.className = 'input-field';
        selPresence.innerHTML = `<option value="">— Choisir —</option><option value="matin">Matin</option><option value="matin_soir">Matin et soir</option><option value="soir">Soir</option>`;
        selPresence.value = ligne.moment || '';
        selPresence.addEventListener('change', e => {
          ligne.moment = e.target.value || null;
          save();
          renderFacturation();
        });
        row.appendChild(selPresence);

        // Retard
        const quartWrap = document.createElement('div');
        quartWrap.className = 'quart-arrows';
        const q = ligne.quarts || 0;

        const btnDown = document.createElement('button');
        btnDown.className = 'arrow-btn';
        btnDown.innerHTML = '<i class="fas fa-minus"></i>';
        btnDown.title = '− 15 min';
        btnDown.disabled = q <= 0;
        btnDown.addEventListener('click', () => { ligne.quarts = Math.max(0, (ligne.quarts || 0) - 1); save(); renderFacturation(); });

        const nb = document.createElement('span');
        nb.className = 'nb';
        if (q === 0) nb.innerHTML = '<span class="quart-none">aucun</span>';
        else nb.textContent = '+ ' + (q * 15) + ' min';

        const btnUp = document.createElement('button');
        btnUp.className = 'arrow-btn';
        btnUp.innerHTML = '<i class="fas fa-plus"></i>';
        btnUp.title = '+15 min (max ' + (MAX_QUARTS * 15) + ' min)';
        btnUp.disabled = q >= MAX_QUARTS;
        btnUp.addEventListener('click', () => { ligne.quarts = Math.min(MAX_QUARTS, (ligne.quarts || 0) + 1); save(); renderFacturation(); });

        quartWrap.appendChild(btnDown);
        quartWrap.appendChild(nb);
        quartWrap.appendChild(btnUp);
        row.appendChild(quartWrap);

        // Tarif
        const tarifEl = document.createElement('div');
        tarifEl.className = 'tarif-affiche';
        tarifEl.textContent = euro(tarif);
        row.appendChild(tarifEl);

        // Supprimer
        const btnDel = document.createElement('button');
        btnDel.className = 'btn-icon danger';
        btnDel.innerHTML = '<i class="fas fa-trash-alt"></i>';
        btnDel.title = 'Supprimer cette ligne';
        btnDel.addEventListener('click', async () => {
          const ok = await showConfirm('Supprimer cette ligne ?');
          if (!ok) return;
          item.lignes = item.lignes.filter(l => l !== ligne);
          save(); renderFacturation();
        });
        row.appendChild(btnDel);

        // Drag & drop
        row.addEventListener('dragstart', e => {
          dragContext = { enfantId, ligneId: ligne.id };
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', ligne.id);
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          row.draggable = false;
          dragContext = null; dragOverInfo = null;
          document.querySelectorAll('.ligne-date').forEach(el => { el.classList.remove('drag-over-top', 'drag-over-bottom'); });
        });
        row.addEventListener('dragover', e => {
          if (!dragContext || dragContext.enfantId !== enfantId) return;
          if (dragContext.ligneId === ligne.id) return;
          e.preventDefault();
          const rect = row.getBoundingClientRect();
          const pos = (e.clientY - rect.top) < rect.height / 2 ? 'top' : 'bottom';
          document.querySelectorAll('.ligne-date').forEach(el => { el.classList.remove('drag-over-top', 'drag-over-bottom'); });
          row.classList.add(pos === 'top' ? 'drag-over-top' : 'drag-over-bottom');
          dragOverInfo = { enfantId, ligneId: ligne.id, position: pos };
        });
        row.addEventListener('dragleave', e => {
          if (!row.contains(e.relatedTarget)) { row.classList.remove('drag-over-top', 'drag-over-bottom'); }
        });
        row.addEventListener('drop', e => {
          e.preventDefault();
          if (!dragContext || !dragOverInfo) return;
          if (dragContext.enfantId !== enfantId) return;
          if (dragContext.ligneId === ligne.id) return;
          const arr = state.facturation[moisActif][enfantId].lignes;
          const fromIdx = arr.findIndex(l => l.id === dragContext.ligneId);
          const toIdx = arr.findIndex(l => l.id === dragOverInfo.ligneId);
          if (fromIdx === -1 || toIdx === -1) return;
          const [moved] = arr.splice(fromIdx, 1);
          let insertIdx = toIdx;
          if (dragOverInfo.position === 'bottom') insertIdx = toIdx > fromIdx ? toIdx : toIdx + 1;
          else insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
          arr.splice(insertIdx, 0, moved);
          save(); renderFacturation();
        });

        lignesWrap.appendChild(row);
      });

      const actionsRow = document.createElement('div');
      actionsRow.style.marginTop = '.6rem';
      actionsRow.style.display = 'flex';
      actionsRow.style.gap = '.3rem';
      actionsRow.style.flexWrap = 'wrap';

      const btnAddDate = document.createElement('button');
      btnAddDate.className = 'btn-icon';
      btnAddDate.style.fontSize = '.85rem';
      btnAddDate.innerHTML = '<i class="fas fa-plus-circle"></i> Ajouter une date';
      btnAddDate.addEventListener('click', () => {
        item.lignes.push({ id: genId(), date: '', moment: '', quarts: 0 });
        save(); renderFacturation();
      });
      actionsRow.appendChild(btnAddDate);

      const btnRemoveEnfant = document.createElement('button');
      btnRemoveEnfant.className = 'btn-icon danger';
      btnRemoveEnfant.style.fontSize = '.85rem';
      btnRemoveEnfant.innerHTML = '<i class="fas fa-user-minus"></i> Retirer du mois';
      btnRemoveEnfant.addEventListener('click', async () => {
        const ok = await showConfirm('Retirer ' + nomComplet(enfant) + ' du pointage de ' + MOIS_NOMS[moisActif] + ' ' + annee + ' ?');
        if (!ok) return;
        delete state.facturation[moisActif][enfantId];
        save(); renderFacturation();
      });
      actionsRow.appendChild(btnRemoveEnfant);

      lignesWrap.appendChild(actionsRow);
      group.appendChild(lignesWrap);
      facturationContent.appendChild(group);
    });

    facturationContent.querySelectorAll('.check-paye').forEach(cb => {
      cb.addEventListener('change', e => {
        const enfantId = e.target.dataset.enfant;
        state.facturation[moisActif][enfantId].paye = e.target.checked;
        save(); majTotaux();
      });
    });

    // Capture d'écran
    facturationContent.querySelectorAll('.btn-capture').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const enfantId = e.currentTarget.dataset.id;
        const enfant = enfantById(enfantId);
        const group = e.currentTarget.closest('.enfant-group');
        
        const icon = e.currentTarget.querySelector('i');
        icon.className = 'fas fa-spinner fa-spin';

        const nomFichier = `Pointage_${enfant.nom}_${enfant.prenom}_${MOIS_NOMS[moisActif]}_${getAnneeMois(moisActif)}.jpg`;
        
        const canvas = await html2canvas(group, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
        
        const lien = document.createElement('a');
        lien.download = nomFichier;
        lien.href = canvas.toDataURL('image/jpeg', 0.9);
        lien.click();
        
        icon.className = 'fas fa-camera';
      });
    });

    majTotaux();
  }

  function majTotaux() { 
    if (totalMoisSpan) totalMoisSpan.textContent = euro(totalMois()); 
  }

  /* ============================================================
     AFFICHAGE DES ENFANTS (ONGLET 2)
     ============================================================ */
   function matchCreneau(enfant) { 
    if (filtreCreneau === 'tous') return true; 
    
    // Si on clique sur "Matin", on ne veut QUE ceux qui font uniquement le matin
    if (filtreCreneau === 'matin') return enfant.inscription === 'matin'; 
    
    // Si on clique sur "Soir", on ne veut QUE ceux qui font uniquement le soir
    if (filtreCreneau === 'soir') return enfant.inscription === 'soir'; 
    
    // Si on clique sur "Matin & Soir", on ne veut QUE ceux qui font les deux
    if (filtreCreneau === 'matin_soir_seul') return enfant.inscription === 'matin_soir'; 
    
    return true; 
  }

  function updateCompteurSelection() { 
    const el = document.getElementById('compteurSelection'); 
    if (!el) return; 
    
    if (selection.size === 0) { 
      el.textContent = '0 sélectionné(s)'; 
      el.style.background = '#8aa0b0'; // Gris clair
    } else { 
      el.textContent = selection.size + ' sélectionné(s)'; 
      el.style.background = '#1b4a6b'; // Bleu foncé
    } 

    const hint = document.getElementById('hintSelection');
    const btnMod = document.getElementById('btnModifierSelection');
    const btnSup = document.getElementById('btnSupprimerSelection');
    if (hint) hint.style.display = selection.size === 0 ? '' : 'none';
    if (btnMod) btnMod.hidden = selection.size === 0;
    if (btnSup) btnSup.hidden = selection.size === 0;
  }

  function renderEnfants() {
    const nbIns = state.enfants.filter(e => e.statut === 'inscrit').length;
    const nbNon = state.enfants.filter(e => e.statut === 'non_inscrit').length;
    if (document.getElementById('countInscrits')) document.getElementById('countInscrits').textContent = nbIns;
    if (document.getElementById('countNonInscrits')) document.getElementById('countNonInscrits').textContent = nbNon;

    const inscrits = state.enfants.filter(e => e.statut === 'inscrit');
    const statMatin = inscrits.filter(e => e.inscription === 'matin' || e.inscription === 'matin_soir').length;
    const statSoir = inscrits.filter(e => e.inscription === 'soir' || e.inscription === 'matin_soir').length;
    const statEquiv = inscrits.reduce((s, e) => { 
      if (e.inscription === 'matin_soir') return s + 2; 
      if (e.inscription === 'matin' || e.inscription === 'soir') return s + 1; 
      return s; 
    }, 0);
    
    const countM = document.getElementById('countFiltreMatin');
    const countS = document.getElementById('countFiltreSoir');
    const countMS = document.getElementById('countFiltreMs');
    
    if (countM) countM.textContent = inscrits.filter(e => e.inscription === 'matin').length;
    if (countS) countS.textContent = inscrits.filter(e => e.inscription === 'soir').length;
    if (countMS) countMS.textContent = inscrits.filter(e => e.inscription === 'matin_soir').length;
    
    if (document.getElementById('statMatin')) document.getElementById('statMatin').textContent = statMatin;
    if (document.getElementById('statSoir')) document.getElementById('statSoir').textContent = statSoir;
    if (document.getElementById('statEquiv')) document.getElementById('statEquiv').textContent = statEquiv;

    const zoneCreneau = document.getElementById('filtresCreneau'); 
    if (zoneCreneau) zoneCreneau.parentElement.style.display = (sousTabActif === 'inscrit') ? '' : 'none';

    const filtreInput = document.getElementById('filtreEnfants');
    const query = normalizeStr((filtreInput?.value || '').trim());
    const filtreTexte = (e) => { if (!query) return true; return normalizeStr(e.nom + ' ' + e.prenom).includes(query); };
    const filtreComplet = (e) => { 
      if (!filtreTexte(e)) return false; 
      if (sousTabActif === 'inscrit') return matchCreneau(e); 
      return true; 
    };

    const tousFiltres = state.enfants.filter(e => e.statut === sousTabActif).filter(filtreComplet);
    const totalGlobalFiltre = state.enfants.filter(filtreComplet).length;
    const totalGlobal = state.enfants.length;
    
    const compteur = document.getElementById('filtreCompteur');
    if (compteur) { 
      if (query) { 
        compteur.innerHTML = `<i class="fas fa-filter" style="margin-right:.3rem;"></i> <strong>${totalGlobalFiltre}</strong> résultat(s) sur ${totalGlobal} enfant(s) — filtre : « ${escapeHtml(filtreInput.value.trim())} »`; 
      } else { 
        compteur.innerHTML = ''; 
      } 
    }

    const collator = new Intl.Collator('fr', { sensitivity: 'base' });
    let liste = tousFiltres.slice().sort((a, b) => collator.compare((a.nom + ' ' + a.prenom).trim(), (b.nom + ' ' + b.prenom).trim()));
    
    const wrap = document.getElementById('listeEnfantsContent'); 
    if (!wrap) return;
    
    if (liste.length === 0) {
      if (query) wrap.innerHTML = `<div class="empty-state"><i class="fas fa-filter"></i>Aucun enfant ne correspond à « ${escapeHtml(filtreInput.value.trim())} » dans cette liste.</div>`;
      else if (sousTabActif === 'inscrit' && filtreCreneau !== 'tous') wrap.innerHTML = `<div class="empty-state"><i class="fas fa-filter"></i>Aucun enfant dans ce créneau.</div>`;
      else { 
        const label = sousTabActif === 'inscrit' ? 'inscrits' : 'non inscrits'; 
        wrap.innerHTML = `<div class="empty-state"><i class="fas fa-users"></i>Aucun enfant ${label}.<br>Cliquez sur « Ajouter » pour commencer.</div>`; 
      }
      updateBulkBar(); updateCompteurSelection(); return;
    }

    const table = document.createElement('table'); 
    table.className = 'enfant-table';
    table.innerHTML = `<thead><tr>
      <th class="check-col"></th>
      <th style="text-align: center;">Nom</th>
      <th style="text-align: center;">Prénom</th>
      ${sousTabActif === 'inscrit' ? '<th style="text-align: center;">Type d\'inscription</th>' : ''}
    </tr></thead><tbody></tbody>`;
    
    const tb = table.querySelector('tbody');
    
    liste.forEach(e => {
      const enEdition = idsEnEdition.has(e.id);
      const tr = document.createElement('tr'); 
      if (selection.has(e.id)) tr.classList.add('selected'); 
      if (enEdition) tr.classList.add('editing');
      tr.dataset.rowId = e.id;
      tr.innerHTML = `<td class="check-col"><input type="checkbox" class="check-select row-check" data-id="${e.id}" ${selection.has(e.id) ? 'checked' : ''}></td>
        <td class="col-nom">${enEdition ? `<input type="text" class="input-field" value="${escapeHtml(e.nom)}" data-id="${e.id}" data-field="nom" style="text-align: center;">` : `<span class="enfant-valeur">${escapeHtml(e.nom)}</span>`}</td>
        <td class="col-prenom">${enEdition ? `<input type="text" class="input-field" value="${escapeHtml(e.prenom)}" data-id="${e.id}" data-field="prenom" style="text-align: center;">` : `<span class="enfant-valeur">${escapeHtml(e.prenom)}</span>`}</td>
        ${sousTabActif === 'inscrit' ? `<td class="col-statut"><select class="input-field" data-id="${e.id}" data-field="inscription" style="text-align: center;"><option value="matin" ${e.inscription === 'matin' ? 'selected' : ''}>Matin uniquement</option><option value="soir" ${e.inscription === 'soir' ? 'selected' : ''}>Soir uniquement</option><option value="matin_soir" ${e.inscription === 'matin_soir' ? 'selected' : ''}>Matin et soir</option></select></td>` : ''}
        ${enEdition ? `<td class="col-valider"><button class="btn-icon btn-valider" data-valider="${e.id}" title="Valider et revenir en lecture seule"><i class="fas fa-check-circle"></i></button></td>` : ''}`;
      tb.appendChild(tr);
    });

    wrap.innerHTML = ''; wrap.appendChild(table);

    if (!wrap.dataset.delegated) {
      wrap.dataset.delegated = '1';
      wrap.addEventListener('change', ev => { 
        const el = ev.target; 
        if (el.matches('input[data-field], select[data-field]')) { 
          const id = el.dataset.id; 
          const field = el.dataset.field; 
          const enfant = enfantById(id); 
          if (!enfant) return; 
          enfant[field] = el.value; 
          save(); 
          if (field === 'nom' || field === 'prenom') { renderEnfants(); return; }
          if (field === 'inscription' && sousTabActif === 'inscrit') { renderEnfants(); renderTarification(); renderFacturation(); } 
        } 
      });
      wrap.addEventListener('click', async ev => { 
        const validerBtn = ev.target.closest('[data-valider]'); 
        if (validerBtn) { 
          idsEnEdition.delete(validerBtn.dataset.valider); 
          renderEnfants(); 
        } 
      });
      wrap.addEventListener('change', ev => { 
        const cb = ev.target; 
        if (cb.matches('.row-check')) { 
          const id = cb.dataset.id; 
          if (cb.checked) selection.add(id); 
          else { selection.delete(id); if (idsEnEdition.delete(id)) { renderEnfants(); return; } } 
          const tr = cb.closest('tr'); 
          if (tr) tr.classList.toggle('selected', cb.checked); 
          updateCheckAll(); // Met à jour la case du haut
          updateCompteurSelection(); 
        } 
      });
    }

        // Initialisation de la case "Sélectionner tous" (la nouvelle barre)
    const checkAllVisible = document.getElementById('checkAllVisible');
    const labelCheckAll = document.getElementById('labelCheckAll'); // On récupère le texte
    
    if (checkAllVisible) {
      const visibles = getEnfantsVisibles();
      // La case se coche si TOUS les enfants visibles sont déjà sélectionnés
      checkAllVisible.checked = visibles.length > 0 && visibles.every(e => selection.has(e.id));
      
      // On met à jour le texte en fonction de l'état de la case
      if (labelCheckAll) {
        labelCheckAll.textContent = checkAllVisible.checked ? 'Tout désélectionner' : 'Tout sélectionner';
      }
      
      // L'action quand on clique sur la case
      checkAllVisible.onchange = (e) => {
        const liste = getEnfantsVisibles();
        if (e.target.checked) {
          liste.forEach(en => selection.add(en.id));
        } else {
          liste.forEach(en => selection.delete(en.id));
        }
        // On change le texte immédiatement au clic
        if (labelCheckAll) {
          labelCheckAll.textContent = e.target.checked ? 'Tout désélectionner' : 'Tout sélectionner';
        }
        renderEnfants(); // On redessine le tableau
      };
    }

    updateBulkBar(); 
    updateCompteurSelection();
  } 

  function getEnfantsVisibles() { 
    const q = normalizeStr((document.getElementById('filtreEnfants')?.value || '').trim()); 
    return state.enfants.filter(e => e.statut === sousTabActif)
      .filter(e => !q || normalizeStr(e.nom + ' ' + e.prenom).includes(q))
      .filter(e => sousTabActif !== 'inscrit' || matchCreneau(e)); 
  }
  
  function updateCheckAll() { 
    const checkAll = document.getElementById('checkAll'); 
    if (!checkAll) return; 
    const liste = getEnfantsVisibles(); 
    const allSelected = liste.length > 0 && liste.every(e => selection.has(e.id)); 
    checkAll.checked = allSelected; 
    checkAll.indeterminate = !allSelected && liste.some(e => selection.has(e.id)); 
  }
  
  function updateBulkBar() { 
    const bar = document.getElementById('bulkBar'); 
    if (!bar) return; 
    const liste = state.enfants.filter(e => e.statut === sousTabActif); 
    const idsCourants = new Set(liste.map(e => e.id)); 
    Array.from(selection).forEach(id => { if (!idsCourants.has(id)) selection.delete(id); }); 
    if (selection.size > 0) { 
      bar.classList.add('visible'); 
      if (document.getElementById('bulkCount')) document.getElementById('bulkCount').textContent = selection.size; 
      const btnBasculer = document.getElementById('btnBasculer'); 
      if (btnBasculer) { 
        btnBasculer.innerHTML = sousTabActif === 'inscrit' ? '<i class="fas fa-user-clock"></i> Basculer en non inscrit' : '<i class="fas fa-check-circle"></i> Basculer en inscrit'; 
      } 
    } else { 
      bar.classList.remove('visible'); 
    } 
  }
  

  const btnModifierSelection = document.getElementById('btnModifierSelection'); 
  if (btnModifierSelection) { 
    btnModifierSelection.addEventListener('click', () => { 
      if (selection.size === 0) return; 
      idsEnEdition = new Set(selection); 
      renderEnfants(); 
      const premier = document.querySelector('.enfant-table tr.editing input[data-field="nom"]'); 
      if (premier) { premier.focus(); if (premier.select) premier.select(); } 
    }); 
  }

  const btnSupprimerSelection = document.getElementById('btnSupprimerSelection'); 
  if (btnSupprimerSelection) { 
    btnSupprimerSelection.addEventListener('click', async () => { 
      if (selection.size === 0) return; 
      const ok = await showConfirm(`Supprimer définitivement ${selection.size} enfant(s) ?`); 
      if (!ok) return; 
      state.enfants = state.enfants.filter(e => !selection.has(e.id)); 
      selection.clear(); 
      idsEnEdition.clear();
      save(); renderEnfants(); renderFacturation(); renderTarification(); 
    }); 
  }

  document.querySelectorAll('.sous-tab').forEach(btn => { 
    btn.addEventListener('click', () => { 
      document.querySelectorAll('.sous-tab').forEach(b => b.classList.remove('active')); 
      btn.classList.add('active'); 
      sousTabActif = btn.dataset.soustab; 
      selection.clear(); 
      idsEnEdition.clear(); 
      renderEnfants(); 
    }); 
  });

  document.querySelectorAll('[data-soustarif]').forEach(btn => { 
    btn.addEventListener('click', () => { 
      const cible = btn.dataset.soustarif; 
      document.querySelectorAll('[data-soustarif]').forEach(b => b.classList.remove('active')); 
      btn.classList.add('active'); 
      document.querySelectorAll('.soustarif-panneau').forEach(p => p.classList.remove('active')); 
      const panneau = document.getElementById('soustarif-' + cible); 
      if (panneau) panneau.classList.add('active'); 
    }); 
  });

   document.querySelectorAll('.creneau-btn').forEach(btn => { 
    btn.addEventListener('click', () => { 
      document.querySelectorAll('.creneau-btn').forEach(b => b.classList.remove('active')); 
      btn.classList.add('active'); 
      filtreCreneau = btn.dataset.creneau; 
      selection.clear(); 
      renderEnfants(); 
    }); 
  });


  const filtreEnfants = document.getElementById('filtreEnfants'); 
  let filtreTimer = null;
  if (filtreEnfants) { 
    filtreEnfants.addEventListener('input', () => { 
      clearTimeout(filtreTimer); 
      filtreTimer = setTimeout(() => renderEnfants(), 80); 
    }); 
    filtreEnfants.addEventListener('keydown', e => { 
      if (e.key === 'Escape') { 
        filtreEnfants.value = ''; 
        renderEnfants(); 
      } 
    }); 
  }

  /* ============================================================
     ONGLET TARIFICATION (ONGLET 3)
     ============================================================ */
  const tarifCoutAnnuel = document.getElementById('tarifCoutAnnuel'); 
  const tarifNbMois = document.getElementById('tarifNbMois');

  function renderTarification() {
    if (!tarifCoutAnnuel || !tarifNbMois) return;
    tarifCoutAnnuel.value = state.tarification.coutAnnuel; 
    tarifNbMois.value = state.tarification.nbMois;
    const inscrits = state.enfants.filter(e => e.statut === 'inscrit');
    const srvMatin = inscrits.filter(e => e.inscription === 'matin' || e.inscription === 'matin_soir').length;
    const srvSoir = inscrits.filter(e => e.inscription === 'soir' || e.inscription === 'matin_soir').length;
    const equiv = inscrits.reduce((s, e) => { 
      if (e.inscription === 'matin_soir') return s + 2; 
      if (e.inscription === 'matin' || e.inscription === 'soir') return s + 1; 
      return s; 
    }, 0);
    
    if (document.getElementById('tarifSrvMatin')) document.getElementById('tarifSrvMatin').textContent = srvMatin;
    if (document.getElementById('tarifSrvSoir')) document.getElementById('tarifSrvSoir').textContent = srvSoir;
    if (document.getElementById('tarifEquiv')) document.getElementById('tarifEquiv').textContent = equiv;
    
    const coutAnnuel = parseFloat(tarifCoutAnnuel.value) || 0; 
    const nbMois = parseInt(tarifNbMois.value) || 1;
    const mensualite = (equiv > 0 && nbMois > 0) ? (coutAnnuel / (nbMois * equiv)) : 0;
    
    const formuleEl = document.getElementById('tarifFormule'); 
    if (formuleEl) formuleEl.textContent = equiv > 0 ? `Formule : ${euro(coutAnnuel)} / (${nbMois} × ${equiv})` : '';
    if (document.getElementById('tarifMenSimple')) document.getElementById('tarifMenSimple').textContent = equiv > 0 ? euro(mensualite) : '—';
    if (document.getElementById('tarifMenDouble')) document.getElementById('tarifMenDouble').textContent = equiv > 0 ? euro(mensualite * 2) : '—';
    
    const anneeSimple = mensualite * nbMois; 
    const anneeDouble = mensualite * 2 * nbMois;
    
    if (document.getElementById('tarifAnneeSimple')) document.getElementById('tarifAnneeSimple').textContent = equiv > 0 ? euro(anneeSimple) : '—';
    if (document.getElementById('tarifAnneeSimpleFormule')) document.getElementById('tarifAnneeSimpleFormule').textContent = equiv > 0 ? `${euro(mensualite)} × ${nbMois} mois` : '—';
    if (document.getElementById('tarifAnneeDouble')) document.getElementById('tarifAnneeDouble').textContent = equiv > 0 ? euro(anneeDouble) : '—';
    if (document.getElementById('tarifAnneeDoubleFormule')) document.getElementById('tarifAnneeDoubleFormule').textContent = equiv > 0 ? `${euro(mensualite * 2)} × ${nbMois} mois` : '—';
    
    const comparaison = document.getElementById('tarifComparaisonNonInscrit');
    if (comparaison) {
      if (equiv === 0 || mensualite === 0) comparaison.innerHTML = '<div class="info-note">Renseignez le coût annuel pour activer la comparaison.</div>';
      else {
        const prixOcc = state.params.prixOccasionnel || 0;
        if (prixOcc <= 0) comparaison.innerHTML = '<div class="info-note">Renseignez le prix occasionnel pour activer la comparaison.</div>';
        else {
          const seuilSimple = mensualite / prixOcc; 
          const seuilArrondi = Math.ceil(seuilSimple);
          comparaison.innerHTML = `<h4><i class="fas fa-balance-scale"></i> Seuil de bascule</h4><div class="comparaison-line"><span>Mensualité d'un service</span><strong>${euro(mensualite)}</strong></div><div class="comparaison-line"><span>Prix d'un passage occasionnel</span><strong>${euro(prixOcc)}</strong></div><div class="comparaison-line" style="border-top:1px solid #fdeec5; margin-top:.5rem; padding-top:.5rem;"><span>À partir de combien de passages/mois l'inscription est plus avantageuse</span><strong>${seuilArrondi} passage${seuilArrondi > 1 ? 's' : ''}</strong></div><div class="comparaison-line" style="font-size:.82rem; color:#8a6314;"><span><i class="fas fa-info-circle"></i> Calcul : ${euro(mensualite)} ÷ ${euro(prixOcc)} = ${seuilSimple.toFixed(2)}</span></div>`;
        }
      }
    }
  }
  
  if (tarifCoutAnnuel) tarifCoutAnnuel.addEventListener('input', () => { state.tarification.coutAnnuel = parseFloat(tarifCoutAnnuel.value) || 0; save(); renderTarification(); });
  if (tarifNbMois) tarifNbMois.addEventListener('input', () => { state.tarification.nbMois = parseInt(tarifNbMois.value) || 1; save(); renderTarification(); });

  const prixQuartInput = document.getElementById('prixQuart'); 
  const prixOccasionnelInput = document.getElementById('prixOccasionnel');
  
  const btnSauvegarderParams = document.getElementById('btnSauvegarderParams'); 
  if (btnSauvegarderParams) { 
    btnSauvegarderParams.addEventListener('click', () => { 
      state.params.prixOccasionnel = Math.round(parseFloat(prixOccasionnelInput.value) || 0); 
      prixOccasionnelInput.value = state.params.prixOccasionnel; 
      save(); renderFacturation(); renderTarification(); 
      const btn = document.getElementById('btnSauvegarderParams'); 
      btn.innerHTML = '<i class="fas fa-check-circle"></i> Enregistré !'; 
      setTimeout(() => { btn.innerHTML = '<i class="fas fa-save"></i> Mise à jour des tarifs'; }, 1500); 
    }); 
  }
  
  const btnSauvegarderParamsRetards = document.getElementById('btnSauvegarderParamsRetards'); 
  if (btnSauvegarderParamsRetards) { 
    btnSauvegarderParamsRetards.addEventListener('click', () => { 
      state.params.prixQuart = Math.round(parseFloat(prixQuartInput.value) || 0); 
      prixQuartInput.value = state.params.prixQuart; 
      save(); renderFacturation(); renderTarification(); 
      const btn = document.getElementById('btnSauvegarderParamsRetards'); 
      btn.innerHTML = '<i class="fas fa-check-circle"></i> Enregistré !'; 
      setTimeout(() => { btn.innerHTML = '<i class="fas fa-save"></i> Mise à jour des tarifs'; }, 1500); 
    }); 
  }

  /* ============================================================
     MODALES (CRÉATION / RECHERCHE D'ENFANT)
     ============================================================ */
  const modalCreation = document.getElementById('modalCreation'); 
  const creationNom = document.getElementById('creationNom'); 
  const creationPrenom = document.getElementById('creationPrenom'); 
  const creationTypeWrap = document.getElementById('creationTypeWrap'); 
  const creationType = document.getElementById('creationType'); 
  const creationErreur = document.getElementById('creationErreur');

  function getCreationStatut() { 
    const r = document.querySelector('input[name="creationStatut"]:checked'); 
    return r ? r.value : 'inscrit'; 
  }
  
  function majCreationTypeVisibility() { 
    if (creationTypeWrap) creationTypeWrap.style.display = (getCreationStatut() === 'inscrit') ? '' : 'none'; 
  }
  
  function ouvrirCreation() { 
    if (!modalCreation) return; 
    creationNom.value = ''; 
    creationPrenom.value = ''; 
    document.querySelector('input[name="creationStatut"][value="inscrit"]').checked = true; 
    creationType.value = 'matin_soir'; 
    if (creationErreur) creationErreur.style.display = 'none'; 
    majCreationTypeVisibility(); 
    modalCreation.classList.add('visible'); 
    setTimeout(() => creationNom.focus(), 50); 
  }
  
  function fermerCreation() { 
    if (modalCreation) modalCreation.classList.remove('visible'); 
  }
  
  document.querySelectorAll('input[name="creationStatut"]').forEach(r => { 
    r.addEventListener('change', majCreationTypeVisibility); 
  });
  
  const btnAnnulerCreation = document.getElementById('btnAnnulerCreation'); 
  if (btnAnnulerCreation) btnAnnulerCreation.addEventListener('click', fermerCreation);
  
  if (modalCreation) modalCreation.addEventListener('click', e => { if (e.target === modalCreation) fermerCreation(); });
  
  const btnValiderCreation = document.getElementById('btnValiderCreation'); 
  if (btnValiderCreation) {
    btnValiderCreation.addEventListener('click', () => {
      const nom = creationNom.value.trim(); 
      const prenom = creationPrenom.value.trim(); 
      const statut = getCreationStatut(); 
      const inscription = statut === 'inscrit' ? creationType.value : '';
      if (creationErreur) creationErreur.style.display = 'none';
      if (!nom || !prenom) { 
        if (creationErreur) { 
          creationErreur.textContent = 'Le nom et le prénom sont obligatoires.'; 
          creationErreur.style.display = 'block'; 
        } 
        return; 
      }
      const k = (nom + '|' + prenom).toLowerCase();
      if (state.enfants.some(e => keyEnfant(e) === k)) { 
        if (creationErreur) { 
          creationErreur.textContent = nom + ' ' + prenom + ' existe déjà.'; 
          creationErreur.style.display = 'block'; 
        } 
        return; 
      }
      const nouvel = { id: genId(), nom, prenom, statut, inscription }; 
      state.enfants.push(nouvel); 
      save(); 
      fermerCreation();
      sousTabActif = statut; 
      document.querySelectorAll('.sous-tab').forEach(b => b.classList.toggle('active', b.dataset.soustab === statut)); 
      if (filtreEnfants) filtreEnfants.value = ''; 
      filtreCreneau = 'tous'; 
      document.querySelectorAll('.creneau-btn').forEach(b => b.classList.toggle('active', b.dataset.creneau === 'tous')); 
      idsEnEdition = new Set([nouvel.id]); 
      renderEnfants(); 
      renderTarification();
      setTimeout(() => { 
        const input = document.querySelector(`input[data-id="${nouvel.id}"][data-field="nom"]`); 
        if (input) { 
          if (input.scrollIntoView) input.scrollIntoView({ behavior: 'smooth', block: 'center' }); 
          input.focus(); 
        } 
      }, 100);
    });
  }
  
  [creationNom, creationPrenom].forEach(inp => { 
    if (inp) { 
      inp.addEventListener('keydown', e => { 
        if (e.key === 'Enter') { 
          e.preventDefault(); 
          if (btnValiderCreation) btnValiderCreation.click(); 
        } 
      }); 
    } 
  });
  
  const btnAjouterEnfant = document.getElementById('btnAjouterEnfant'); 
  if (btnAjouterEnfant) btnAjouterEnfant.addEventListener('click', ouvrirCreation);

  const modalRecherche = document.getElementById('modalRecherche'); 
  const searchInput = document.getElementById('searchInput'); 
  const resultList = document.getElementById('resultList');

  function ouvrirRecherche() { 
    if (!modalRecherche) return; 
    modalRecherche.classList.add('visible'); 
    searchInput.value = ''; 
    afficherResultats(); 
    setTimeout(() => searchInput.focus(), 50); 
  }
  
  function fermerRecherche() { 
    if (modalRecherche) modalRecherche.classList.remove('visible'); 
  }
  
  function afficherResultats() {
    if (!resultList) return; 
    const query = normalizeStr(searchInput.value.trim());
    const filtres = query === '' ? state.enfants : state.enfants.filter(e => normalizeStr(e.nom + ' ' + e.prenom).includes(query));
    if (filtres.length === 0) { 
      resultList.innerHTML = `<div class="result-empty"><i class="fas fa-info-circle"></i> Aucun enfant ne correspond.<br><span style="font-size:.82rem;">Créez-le d'abord.</span></div>`; 
      return; 
    }
    resultList.innerHTML = '';
    filtres.forEach(e => { 
      const item = document.createElement('div'); 
      item.className = 'result-item'; 
      let meta = ''; 
      if (e.statut === 'inscrit') { 
        const map = { matin: 'Matin', soir: 'Soir', matin_soir: 'Matin+Soir' }; 
        meta = 'Inscrit · ' + (map[e.inscription] || ''); 
      } else meta = 'Non inscrit'; 
      if (state.facturation[moisActif]?.[e.id]) meta += ' · déjà dans ce mois'; 
      item.innerHTML = `<div><div class="result-name">${escapeHtml(e.nom)} ${escapeHtml(e.prenom)}</div><div class="result-meta">${meta}</div></div><i class="fas fa-chevron-right" style="color:#b8c7d4; font-size:.8rem;"></i>`; 
      item.addEventListener('click', () => selectionnerEnfant(e)); 
      resultList.appendChild(item); 
    });
  }
  
  function selectionnerEnfant(e) { 
    if (!state.facturation[moisActif]) state.facturation[moisActif] = {}; 
    if (state.facturation[moisActif][e.id]) { 
      showConfirm(nomComplet(e) + ' est déjà dans ce mois.', { infoOnly: true, title: 'Déjà présent', icon: 'info-circle' }); 
      fermerRecherche(); 
      return; 
    } 
    state.facturation[moisActif][e.id] = { paye: false, lignes: [{ id: genId(), date: '', moment: '', quarts: 0 }] }; 
    save(); 
    fermerRecherche(); 
    renderFacturation(); 
  }
  
  if (searchInput) searchInput.addEventListener('input', () => afficherResultats());
  
  const btnFermerRecherche = document.getElementById('btnFermerRecherche'); 
  if (btnFermerRecherche) btnFermerRecherche.addEventListener('click', fermerRecherche);
  
  const btnAjouterEnfantMois = document.getElementById('btnAjouterEnfantMois'); 
  if (btnAjouterEnfantMois) btnAjouterEnfantMois.addEventListener('click', ouvrirRecherche);

  /* ============================================================
     IMPORT / EXPORT CSV
     ============================================================ */
  const modalImport = document.getElementById('modalImport'); 
  const inputCSV = document.getElementById('inputCSV'); 
  const previewZone = document.getElementById('previewZone'); 
  const btnConfirmerImport = document.getElementById('btnConfirmerImport');
  
  const btnImportCSV = document.getElementById('btnImportCSV'); 
  if (btnImportCSV) { 
    btnImportCSV.addEventListener('click', () => { 
      if (!modalImport) return; 
      modalImport.classList.add('visible'); 
      if (previewZone) previewZone.innerHTML = ''; 
      if (btnConfirmerImport) btnConfirmerImport.style.display = 'none'; 
      importPreview = null; 
      if (inputCSV) inputCSV.value = ''; 
    }); 
  }
  
  const btnAnnulerImport = document.getElementById('btnAnnulerImport'); 
  if (btnAnnulerImport) btnAnnulerImport.addEventListener('click', () => { if (modalImport) modalImport.classList.remove('visible'); });
  
  const btnChoisirFichier = document.getElementById('btnChoisirFichier'); 
  if (btnChoisirFichier) btnChoisirFichier.addEventListener('click', () => { if (inputCSV) inputCSV.click(); });
  
  if (inputCSV) {
    inputCSV.addEventListener('change', () => {
      const file = inputCSV.files[0]; 
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => { 
        try { preparerApercu(ev.target.result); } 
        catch (err) { 
          if (previewZone) previewZone.innerHTML = `<div class="import-summary" style="background:#fef6f6; color:#a52c2c;">Erreur : ${err.message}</div>`; 
        } 
      };
      reader.readAsText(file, 'UTF-8');
    });
  }

  function estStatutExplicite(s) { 
    const v = String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); 
    if (!v) return false; 
    return ['inscrit', 'inscrite', 'non-inscrit', 'non inscrit', 'noninscrit', 'non_inscrit', 'noninscrite', 'non inscrite', 'occasionnel', 'occasionnelle', 'oui', 'non', 'true', 'false', '1', '0'].includes(v); 
  }
  
  function normaliserStatutExplicite(s) { 
    const v = String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); 
    if (!v) return null; 
    if (['inscrit', 'inscrite', 'oui', '1', 'true'].includes(v)) return 'inscrit'; 
    if (['non-inscrit', 'non inscrit', 'noninscrit', 'non_inscrit', 'noninscrite', 'non inscrite', 'no', '0', 'false', 'occasionnel', 'occasionnelle'].includes(v)) return 'non_inscrit'; 
    return null; 
  }
  
  function interpreterType(valeur) { 
    const raw = (valeur || '').toString().trim(); 
    const v = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s+_\-]+/g, '_').replace(/^_|_$/g, ''); 
    if (!v) return { type: null, ambigu: false }; 
    if (['non_inscrit', 'noninscrit', 'non_inscrite', 'noninscrite', 'occasionnel', 'occasionnelle', 'garderie_occasionnelle'].includes(v)) return { type: 'non_inscrit', ambigu: false }; 
    if (['matin', 'matin_uniquement', 'matin_seul', 'matin_simplement', 'matin_sco'].includes(v)) return { type: 'matin', ambigu: false }; 
    if (['soir', 'soir_uniquement', 'soir_seul', 'soir_simplement', 'soir_sco'].includes(v)) return { type: 'soir', ambigu: false }; 
    if (['matin_et_soir', 'matin_soir', 'matinsoir', 'matin_plus_soir', 'journee_complete', 'journee', 'complete', 'complet'].includes(v)) return { type: 'matin_soir', ambigu: false }; 
    return { type: null, ambigu: true }; 
  }
  
  function detecterSeparateur(ligne) { 
    const c = (ligne.match(/,/g) || []).length; 
    const p = (ligne.match(/;/g) || []).length; 
    return p > c ? ';' : ','; 
  }

  function preparerApercu(texte) {
    texte = texte.replace(/^\uFEFF/, '');
    const lignes = texte.split(/\r?\n/);
    const lignesValides = lignes.map((l, i) => ({ l, i })).filter(({ l }) => l.trim() !== '' && !l.trim().startsWith('#'));
    if (lignesValides.length === 0) throw new Error('Fichier vide.');
    const sep = detecterSeparateur(lignesValides[0].l);
    let start = 0; 
    const firstLow = lignesValides[0].l.toLowerCase();
    if (firstLow.includes('nom') || firstLow.includes('prenom') || firstLow.includes('prénom') || firstLow.includes('statut') || firstLow.includes('type')) start = 1;
    const existants = new Map(); 
    state.enfants.forEach(e => existants.set(keyEnfant(e), e));
    const traitees = []; let colonnesDetectees = 0; let formatDetecte = null;

    for (let idx = start; idx < lignesValides.length; idx++) {
      const { l, i } = lignesValides[idx];
      const parts = []; 
      let current = '', inQuotes = false;
      for (let k = 0; k < l.length; k++) { 
        const ch = l[k]; 
        if (ch === '"') { 
          if (inQuotes && l[k + 1] === '"') { current += '"'; k++; } 
          else inQuotes = !inQuotes; 
        } else if (ch === sep && !inQuotes) { parts.push(current); current = ''; } 
        else current += ch; 
      }
      parts.push(current);
      const cells = parts.map(p => p.trim());
      if (cells.length < 2) continue;
      if (cells.length > colonnesDetectees) colonnesDetectees = cells.length;
      const nom = cells[0] || ''; 
      const prenom = cells[1] || ''; 
      const col3 = cells[2] || ''; 
      const col4 = cells[3] || '';
      let statut = null, inscription = '', raison = '';
      if (estStatutExplicite(col3)) {
        formatDetecte = formatDetecte || 'B';
        statut = normaliserStatutExplicite(col3);
        if (statut === null) raison = `Statut « ${col3} » non reconnu`;
        else if (statut === 'inscrit') { 
          const t = interpreterType(col4); 
          if (t.ambigu || !t.type || t.type === 'non_inscrit') raison = `Type « ${col4} » manquant ou invalide`; 
          else inscription = t.type; 
        }
      } else {
        formatDetecte = formatDetecte || 'A';
        const t = interpreterType(col3);
        if (t.ambigu) raison = `Type « ${col3} » non reconnu`;
        else if (t.type === 'non_inscrit') { statut = 'non_inscrit'; inscription = ''; }
        else if (t.type) { statut = 'inscrit'; inscription = t.type; }
      }
      let etat = 'new';
      if (!nom || !prenom) { etat = 'err'; raison = 'Nom ou prénom manquant'; }
      else if (raison) { etat = 'err'; }
      else { 
        const k = (nom + '|' + prenom).trim().toLowerCase(); 
        if (existants.has(k)) { etat = 'dup'; raison = 'Déjà existant'; } 
      }
      traitees.push({ index: i + 1, nom, prenom, statut: statut || 'inscrit', inscription: inscription || '', col3Brut: col3, col4Brut: col4, etat, raison });
    }
    importPreview = { lignes: traitees, colonnesDetectees, formatDetecte: formatDetecte || 'A' };
    afficherApercu();
  }

  function afficherApercu() {
    if (!importPreview || !previewZone) return;
    const { lignes, colonnesDetectees, formatDetecte } = importPreview;
    const nNew = lignes.filter(l => l.etat === 'new').length; 
    const nDup = lignes.filter(l => l.etat === 'dup').length; 
    const nErr = lignes.filter(l => l.etat === 'err').length;
    const fmtLabel = formatDetecte === 'B' ? 'B (statut + type, 4 colonnes)' : 'A (type de garderie, 3 colonnes)';
    let html = `<div class="import-summary"><strong>${lignes.length}</strong> ligne(s) détectée(s) — <span style="color:#1f7a4a;">${nNew} nouvelle(s)</span>, <span style="color:#7a5e1c;">${nDup} doublon(s)</span>, <span style="color:#a52c2c;">${nErr} invalide(s)</span><br><span style="font-size:.8rem; color:#2c6e9c;"><i class="fas fa-info-circle"></i> Format détecté : <strong>${fmtLabel}</strong></span></div>`;
    if (nDup > 0) html += `<label class="radio-line"><input type="radio" name="dupMode" value="ignorer" checked> Ignorer les doublons</label><label class="radio-line"><input type="radio" name="dupMode" value="maj"> Mettre à jour les doublons</label>`;
    html += `<table class="preview-table"><thead><tr><th>Ligne</th><th>Nom</th><th>Prénom</th><th>Col. 3</th><th>Col. 4</th><th>Statut</th><th>Type</th><th>État</th></tr></thead><tbody>`;
    lignes.forEach(l => {
      const tag = l.etat === 'new' ? '<span class="preview-tag new">Nouveau</span>' : l.etat === 'dup' ? '<span class="preview-tag dup">Doublon</span>' : `<span class="preview-tag err">Invalide</span> <span style="font-size:.72rem;color:#a52c2c;">${l.raison}</span>`;
      const cls = l.etat === 'err' ? 'invalid' : l.etat === 'dup' ? 'duplicate' : '';
      const statutLabel = l.statut === 'inscrit' ? 'Inscrit' : 'Non inscrit';
      const typeLabel = l.statut === 'non_inscrit' ? '—' : ({ matin: 'Matin', soir: 'Soir', matin_soir: 'Matin+Soir' }[l.inscription] || '—');
      html += `<tr class="${cls}"><td>${l.index}</td><td>${escapeHtml(l.nom)}</td><td>${escapeHtml(l.prenom)}</td><td style="font-size:.75rem;color:#6f8698;">${escapeHtml(l.col3Brut)}</td><td style="font-size:.75rem;color:#6f8698;">${escapeHtml(l.col4Brut) || '—'}</td><td>${statutLabel}</td><td>${typeLabel}</td><td>${tag}</td></tr>`;
    });
    html += `</tbody></table>`; 
    previewZone.innerHTML = html;
    if (btnConfirmerImport) { 
      btnConfirmerImport.style.display = (nNew + nDup) > 0 ? 'inline-flex' : 'none'; 
      btnConfirmerImport.disabled = (nNew + nDup) === 0; 
    }
  }

  if (btnConfirmerImport) {
    btnConfirmerImport.addEventListener('click', () => {
      if (!importPreview) return;
      const modeDup = document.querySelector('input[name="dupMode"]:checked'); 
      const mode = modeDup ? modeDup.value : 'ignorer';
      let ajoutes = 0, majs = 0, ignores = 0;
      importPreview.lignes.forEach(l => {
        if (l.etat === 'err') { ignores++; return; }
        if (l.etat === 'new') { 
          state.enfants.push({ id: genId(), nom: l.nom, prenom: l.prenom, statut: l.statut, inscription: l.statut === 'inscrit' ? (l.inscription || 'matin_soir') : '' }); 
          ajoutes++; 
        }
        else if (l.etat === 'dup' && mode === 'maj') { 
          const k = (l.nom + '|' + l.prenom).trim().toLowerCase(); 
          const existant = state.enfants.find(e => keyEnfant(e) === k); 
          if (existant) { 
            existant.statut = l.statut; 
            existant.inscription = l.statut === 'inscrit' ? (l.inscription || 'matin_soir') : ''; 
            majs++; 
          } 
        }
        else ignores++;
      });
      save(); 
      if (modalImport) modalImport.classList.remove('visible'); 
      renderEnfants(); 
      renderFacturation(); 
      renderTarification(); 
      showConfirm(`Import terminé : ${ajoutes} ajouté(s), ${majs} mis à jour, ${ignores} ignoré(s).`, { infoOnly: true, title: 'Import terminé', icon: 'check-circle' });
    });
  }

  const btnExportCSV = document.getElementById('btnExportCSV'); 
  if (btnExportCSV) {
    btnExportCSV.addEventListener('click', () => {
      if (state.enfants.length === 0) { 
        showConfirm('Aucun enfant à exporter.', { infoOnly: true, title: 'Rien à exporter', icon: 'info-circle' }); 
        return; 
      }
      const lignes = ['nom;prenom;statut;type'];
      state.enfants.forEach(e => { 
        const statut = e.statut === 'inscrit' ? 'inscrit' : 'non-inscrit'; 
        const type = e.statut === 'inscrit' ? (e.inscription || 'matin_soir') : ''; 
        lignes.push([e.nom, e.prenom, statut, type].map(v => `"${(v || '').replace(/"/g, '""')}"`).join(';')); 
      });
      const blob = new Blob([lignes.join('\r\n')], { type: 'text/csv;charset=utf-8;' }); 
      const url = URL.createObjectURL(blob); 
      const a = document.createElement('a'); 
      a.href = url; 
      a.download = 'enfants_garderie.csv'; 
      a.click(); 
      URL.revokeObjectURL(url);
    });
  }

  /* ============================================================
     SAUVEGARDE JSON (ONGLET 4)
     ============================================================ */
  function exporterJSON() {
        const payload = { 
              app: 'garderie-occasionnelle', 
              version: 5, 
              exportDate: new Date().toISOString(), 
              data: { 
                params: state.params, 
                tarification: state.tarification, 
                enfants: state.enfants, 
                facturation: state.facturation, 
                anneeReference: state.anneeReference,
                moisTraites: moisTraites // <-- C'est la ligne à ajouter
              } 
            };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); 
    const url = URL.createObjectURL(blob); 
    const a = document.createElement('a'); 
    const maintenant = new Date();
    const dateStr = maintenant.getFullYear() + '-' + String(maintenant.getMonth() + 1).padStart(2, '0') + '-' + String(maintenant.getDate()).padStart(2, '0');
    const heureStr = String(maintenant.getHours()).padStart(2, '0') + 'h' + String(maintenant.getMinutes()).padStart(2, '0');
    a.href = url; 
    a.download = `sauvegarde-garderie-${dateStr}-${heureStr}.json`; 
    a.click(); 
    URL.revokeObjectURL(url); 
    state.lastExport = new Date().toISOString(); 
    save(); 
  }

  async function restaurerJSON(texte) {
    let payload; 
    try { payload = JSON.parse(texte); } 
    catch (e) { 
      showConfirm('Le fichier n\'est pas un JSON valide.\n\nDétail : ' + e.message, { infoOnly: true, title: 'Fichier invalide', icon: 'times-circle' }); 
      return; 
    }
    if (!payload || payload.app !== 'garderie-occasionnelle') { 
      showConfirm('Ce fichier ne provient pas de l\'application.', { infoOnly: true, title: 'Fichier invalide', icon: 'times-circle' }); 
      return; 
    }
    if (!payload.data || !Array.isArray(payload.data.enfants) || typeof payload.data.facturation !== 'object') { 
      showConfirm('Le fichier est incomplet.', { infoOnly: true, title: 'Fichier invalide', icon: 'times-circle' }); 
      return; 
    }
    const d = payload.data; 
    const nbEnfants = d.enfants.length; 
    let nbLignes = 0, nbMoisRemplis = 0;
    Object.values(d.facturation).forEach(m => { 
      let lignesMois = 0; 
      Object.values(m || {}).forEach(item => { lignesMois += (item.lignes || []).length; }); 
      if (lignesMois > 0) nbMoisRemplis++; 
      nbLignes += lignesMois; 
    });
    const dateExport = payload.exportDate ? new Date(payload.exportDate).toLocaleString('fr-FR') : 'non renseignée';
    const message = `Cette sauvegarde contient :\n\n• ${nbEnfants} enfant(s)\n• ${nbMoisRemplis} mois de pointage rempli(s)\n• ${nbLignes} ligne(s) au total\n\nDate de la sauvegarde : ${dateExport}\n\n⚠️ ATTENTION : toutes les données actuelles seront REMPLACÉES.\nCette action est irréversible.`;
    const ok = await showConfirm(message, { title: 'Restaurer cette sauvegarde ?', icon: 'exclamation-triangle', okLabel: 'Restaurer et remplacer' }); 
    if (!ok) return;
    const lastExportBackup = state.lastExport;
    state.params = d.params || state.params; 
    state.tarification = d.tarification || state.tarification; 
    state.enfants = d.enfants; 
    state.facturation = d.facturation; 
    state.anneeReference = d.anneeReference || null; 
    
    /*Gestion de la sauvegarde des mois traités*/
    if (d.moisTraites) {
      moisTraites = d.moisTraites;
      localStorage.setItem('garderie_mois_traites', JSON.stringify(moisTraites));
    }
    
    state.lastExport = lastExportBackup;
    Object.values(state.facturation).forEach(moisData => { 
      Object.values(moisData || {}).forEach(item => { 
        (item.lignes || []).forEach(l => { 
          if (l.moment === 'aprem') l.moment = 'soir'; 
          delete l.type; 
          delete l.montant; 
        }); 
      }); 
    });
    initMois(); 
    save(); 
    moisActif = 8; 
    sousTabActif = 'inscrit'; 
    selection.clear(); 
    if (filtreEnfants) filtreEnfants.value = ''; 
    filtreCreneau = 'tous'; 
    document.querySelectorAll('.creneau-btn').forEach(b => b.classList.toggle('active', b.dataset.creneau === 'tous')); 
    document.querySelectorAll('.sous-tab').forEach(b => b.classList.toggle('active', b.dataset.soustab === 'inscrit'));
    renderMois(); 
    renderFacturation(); 
    renderEnfants(); 
    renderTarification(); 
    if (prixQuartInput) prixQuartInput.value = state.params.prixQuart; 
    if (prixOccasionnelInput) prixOccasionnelInput.value = state.params.prixOccasionnel; 
    showConfirm('Restauration terminée avec succès.', { infoOnly: true, title: 'Restauration réussie', icon: 'check-circle' });
  }
  
  const btnExportJSON = document.getElementById('btnExportJSON'); 
  if (btnExportJSON) btnExportJSON.addEventListener('click', exporterJSON);
  
  const inputJSON = document.getElementById('inputJSON'); 
  const btnImportJSON = document.getElementById('btnImportJSON'); 
  if (btnImportJSON) btnImportJSON.addEventListener('click', () => { if (inputJSON) inputJSON.click(); });
  
  if (inputJSON) { 
    inputJSON.addEventListener('change', () => { 
      const f = inputJSON.files[0]; 
      if (!f) return; 
      const reader = new FileReader(); 
      reader.onload = ev => { 
        try { restaurerJSON(ev.target.result); } 
        catch (err) { 
          showConfirm('Erreur lors de la lecture : ' + err.message, { infoOnly: true, title: 'Erreur', icon: 'times-circle' }); 
        } 
      }; 
      reader.readAsText(f, 'UTF-8'); 
      inputJSON.value = ''; 
    }); 
  }

  /* ============================================================
     NAVIGATION DES ONGLETS PRINCIPAUX
     ============================================================ */
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active')); 
      btn.classList.add('active');
      if (btn.scrollIntoView) btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      document.querySelectorAll('.panneau').forEach(p => p.classList.remove('active'));
      const panneau = document.getElementById('panneau-' + tab); 
      if (panneau) panneau.classList.add('active');
      if (tab === 'enfants') renderEnfants();
      if (tab === 'facturation') renderFacturation();
      if (tab === 'tarification') renderTarification();
      if (tab === 'impression') renderFiche();
    });
  });


    /* ============================================================
     NAVIGATION DEPUIS L'ONGLET ACCUEIL
     (chaque bouton renvoie vers l'onglet correspondant)
     ============================================================ */
  document.querySelectorAll('.accueil-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cible = document.querySelector('.tab-btn[data-tab="' + btn.dataset.aller + '"]'); 
      if (cible) cible.click(); 
      window.scrollTo({ top: 0, behavior: 'smooth' }); 
    });
  });

  /* ============================================================
     GÉNÉRATION DE LA FICHE DE PRÉSENCE ET DU PDF (ONGLET 5)
     ============================================================ */
  const btnImprimerFiche = document.getElementById('btnTelechargerPdf');

  // 1. On garde la fonction renderFiche pour l'affichage à l'écran (l'aperçu)
   function classeTailleNom(texte) { 
    const len = (texte || '').length; 
    if (len > 22) return 'nom-mini';      // Réduit seulement si > 22 caractères
    if (len > 20) return 'nom-tres-long'; // Réduit si > 18 caractères
    if (len > 18) return 'nom-long';      // Réduit si > 14 caractères
    return '';                            // Taille normale jusqu'à 14 caractères
  }
  
  function repartirDeux(liste) { 
    if (liste.length === 0) return [[], []]; 
    const milieu = Math.ceil(liste.length / 2); 
    return [liste.slice(0, milieu), liste.slice(milieu)]; 
  }

  function construireTableau(matin, ms, soir, occ, estGauche) {
    const celluleDate = estGauche ? `<th class="cell-date" colspan="2">Date :</th>` : `<th class="cell-date" colspan="2"></th>`;
    const ligneDate = `<tr class="ligne-date-zone">${celluleDate}<th class="cell-matin" colspan="2">Matin</th><th class="cell-soir" colspan="3">Soir</th></tr>`;
    const sections = [ 
      { type: 'matin', titre: 'Garderie du Matin', liste: matin }, 
      { type: 'matin_soir', titre: 'Garderie du Matin & du Soir', liste: ms }, 
      { type: 'soir', titre: 'Garderie du Soir', liste: soir }, 
      { type: 'occasionnel', titre: 'Garderie occasionnelle', liste: occ } 
    ];
    let lignesHtml = ligneDate;
    
    sections.forEach(sec => {
      if (sec.liste.length === 0) return;
           // Ligne de séparation de 1mm (4px)
      if (lignesHtml !== ligneDate) {
        lignesHtml += `<tr><td colspan="7" style="border: none; height: 1mm; padding: 0;"></td></tr>`;
      }

      lignesHtml += `<tr class="ligne-entete-section type-${sec.type}"><th class="cell-titre" colspan="2">${sec.titre}</th><th class="col-arrivee">Arrivée</th><th class="col-sign1">Signature</th><th class="col-pres"><i class="fas fa-user-check" style="font-size: 9pt;"></i></th><th class="col-depart">Départ</th><th class="col-sign2">Signature</th></tr>`;
      let compteur = 0;
      
      sec.liste.forEach((e, idx) => {
        if (e._vide) { 
                  if (e._vide) { 
          lignesHtml += `<tr class="ligne-enfant ligne-vide type-${sec.type}">
            <td class="cell-nom"></td>
            <td class="cell-prenom"></td>
            <td class="col-arrivee"></td>
            <td class="col-sign1"></td>
            <td class="col-pres"></td>
            <td class="col-depart"></td>
            <td class="col-sign2"></td>
          </tr>`; 
        }
        } else {
          const tailleNom = classeTailleNom(e.nom); 
          const taillePrenom = classeTailleNom(e.prenom);
          compteur++; 
          const classeRepere = (compteur === 4 && sec.liste.length > 3) ? ' ligne-repere' : '';
          lignesHtml += `<tr class="ligne-enfant type-${sec.type} ${classeRepere}"><td class="cell-nom ${tailleNom}">${escapeHtml(e.nom)}</td><td class="cell-prenom ${taillePrenom}">${escapeHtml(e.prenom)}</td><td class="col-arrivee"></td><td class="col-sign1"></td><td class="col-pres"></td><td class="col-depart"></td><td class="col-sign2"></td></tr>`;
        }
        if (compteur === 4) compteur = 0;
      });
    });
    return `<table class="fiche-tableau"><colgroup><col class="col-nom"><col class="col-prenom"><col class="col-arrivee"><col class="col-sign1"><col class="col-pres"><col class="col-depart"><col class="col-sign2"></colgroup>${lignesHtml}</table>`;
  }

  function renderFiche() {
    const ficheContent = document.getElementById('ficheContent');
    if (!ficheContent) return;
    const inscrits = state.enfants.filter(e => e.statut === 'inscrit'); 
    const nonInscrits = state.enfants.filter(e => e.statut === 'non_inscrit');
    const triAlpha = (a, b) => (a.nom + ' ' + a.prenom).localeCompare(b.nom + ' ' + b.prenom, 'fr');
    const matin = inscrits.filter(e => e.inscription === 'matin').sort(triAlpha); 
    const ms = inscrits.filter(e => e.inscription === 'matin_soir').sort(triAlpha); 
    const soir = inscrits.filter(e => e.inscription === 'soir').sort(triAlpha); 
    const occ = nonInscrits.slice().sort(triAlpha);
    const [matinG, matinD] = repartirDeux(matin); 
    const [msG, msD] = repartirDeux(ms); 
    const [soirG, soirD] = repartirDeux(soir); 
    const [occG, occD] = repartirDeux(occ);
    
    function completer(g, d) { 
      const max = Math.max(g.length, d.length); 
      const gC = g.slice(); 
      const dC = d.slice(); 
      while (gC.length < max) gC.push({ _vide: true }); 
      while (dC.length < max) dC.push({ _vide: true }); 
      return [gC, dC]; 
    }
    
    const [matinG2, matinD2] = completer(matinG, matinD); 
    const [msG2, msD2] = completer(msG, msD); 
    const [soirG2, soirD2] = completer(soirG, soirD); 
    const [occG2, occD2] = completer(occG, occD);
    
    ficheContent.innerHTML = `<div class="fiche-entete"><div class="fiche-titre">- Fiche des présences quotidiennes en Garderie -</div><div class="fiche-mention">Les horaires et les signatures sont apposés pour un transfert de responsabilité en bonne et due forme</div></div><div class="fiche-corps">${construireTableau(matinG2, msG2, soirG2, occG2, true)}${construireTableau(matinD2, msD2, soirD2, occD2, false)}</div>`;
    ajusterApercuFiche(); 
  }

  // Réajuste l'aperçu quand l'écran change (rotation du téléphone, redimensionnement de fenêtre)
  let resizeFicheTimer = null; 
  window.addEventListener('resize', () => { 
    clearTimeout(resizeFicheTimer); 
    resizeFicheTimer = setTimeout(ajusterApercuFiche, 150); 
  });

  /* Ajuste l'aperçu de la fiche à la largeur de l'écran sans jamais la déformer.
     Dimensions A4 en CONSTANTES (297x210mm = 1122.5x793.7px à 96dpi) : aucune mesure
     récursive, donc pas de boucle de rétroaction (le rognage progressif en rotation). */
  function ajusterApercuFiche() { 
    const fiche = document.getElementById('ficheContent'); 
    if (!fiche || !fiche.offsetWidth) return; 
    let box = fiche.parentElement; 
    if (!box || box.className !== 'fiche-scale-box') { 
      box = document.createElement('div'); 
      box.className = 'fiche-scale-box'; 
      fiche.parentNode.insertBefore(box, fiche); 
      box.appendChild(fiche); 
    } 
    const LARGEUR_A4 = 1122.5, HAUTEUR_A4 = 793.7;  // 297mm x 210mm 
    const dispo = box.parentElement.clientWidth - 32; 
    const scale = Math.min(1, dispo / LARGEUR_A4); 
    box.style.width = Math.round(LARGEUR_A4 * scale) + 'px'; 
    box.style.height = Math.round(HAUTEUR_A4 * scale) + 'px'; 
    // Largeur/hauteur imposées en inline : prime sur la règle CSS height:100%
    fiche.style.width = '297mm'; 
    fiche.style.height = '210mm'; 
    fiche.style.transform = 'scale(' + scale + ')'; 
    fiche.style.transformOrigin = 'top left'; 
  }

  // 2. La génération du PDF (LA VRAIE SOLUTION PROPRE)
  if (btnImprimerFiche) {
    btnImprimerFiche.addEventListener('click', () => {
      const element = document.getElementById('ficheContent');
      
      const originalText = btnImprimerFiche.innerHTML;
      btnImprimerFiche.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Génération...';
      btnImprimerFiche.disabled = true;

      // On capture un CLONE hors-écran aux vraies dimensions A4, 
      // pour que le PDF soit identique quel que soit l'appareil (téléphone, tablette, PC).
      const capture = element.cloneNode(true); 
      capture.removeAttribute('id'); 
      capture.style.transform = 'none'; 
      capture.style.margin = '0'; 
      capture.style.position = 'fixed'; 
      capture.style.left = '-20000px'; 
      capture.style.top = '0'; 
      // Dimensions A4 imposées en inline + font boosting neutralisé (sinon Chrome mobile
      // grossit les textes du clone en portrait et déforme le PDF)
      capture.style.width = '297mm'; 
      capture.style.height = '210mm'; 
      capture.style.webkitTextSizeAdjust = '100%'; 
      capture.style.textSizeAdjust = '100%'; 
      document.body.appendChild(capture); 

      // Utilisation de html2canvas pour capturer l'élément
      html2canvas(capture, {
        scale: 2, // Haute résolution
        useCORS: true,
        backgroundColor: '#ffffff',
        windowWidth: capture.scrollWidth, // Empêche le recadrage
        windowHeight: capture.scrollHeight
      }).then(canvas => {
        document.body.removeChild(capture); 
        const imgData = canvas.toDataURL('image/jpeg', 1.0);
        
        // Initialisation de jsPDF en A4 paysage
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('l', 'mm', 'a4');
        
        // Calcul des dimensions pour centrer parfaitement
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = pdf.internal.pageSize.getHeight();
        
        // On utilise toute la largeur et la hauteur de la page
        const availableWidth = pdfWidth;
        const availableHeight = pdfHeight;
        
        // On calcule les proportions de l'image
        const imgRatio = canvas.width / canvas.height;
        let finalWidth = availableWidth;
        let finalHeight = finalWidth / imgRatio;
        
        // Si l'image est trop haute, on la réduit par la hauteur
        if (finalHeight > availableHeight) {
          finalHeight = availableHeight;
          finalWidth = finalHeight * imgRatio;
        }
        
        // On centre l'image : (largeur_page - largeur_image) / 2
        const x = (pdfWidth - finalWidth) / 2;
        const y = (pdfHeight - finalHeight) / 2;
        
        pdf.addImage(imgData, 'JPEG', x, y, finalWidth, finalHeight);
        
        pdf.save('Fiche_presence_' + new Date().toISOString().slice(0, 10) + '.pdf');
        
        btnImprimerFiche.innerHTML = originalText;
        btnImprimerFiche.disabled = false;
      }).catch(err => {
        if (capture.parentNode) document.body.removeChild(capture); 
        console.error(err);
        btnImprimerFiche.innerHTML = originalText;
        btnImprimerFiche.disabled = false;
      });
    });
  }

  /* ============================================================
     INITIALISATION DE L'APPLICATION
     ============================================================ */
  load();
  initMois();
  
  if (prixQuartInput) prixQuartInput.value = state.params.prixQuart;
  if (prixOccasionnelInput) prixOccasionnelInput.value = state.params.prixOccasionnel;
    const btnMarquerTraite = document.getElementById('btnMarquerTraite');
  if (btnMarquerTraite) {
    btnMarquerTraite.addEventListener('click', toggleMoisTraite);
  }
  renderMois();
  majBoutonTraite();
  renderFacturation();
  renderEnfants();
  renderTarification();
  renderFiche();
})();

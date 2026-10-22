/* =====================================================================
   IdeaVault — application controller (app.js)
   ---------------------------------------------------------------------
   Rendering and interaction only. Every database operation goes
   through the Db facade (db.js); every dynamic string is escaped.
   ===================================================================== */
(function () {
  'use strict';

  var U = window.IVUtils;
  var CONFIG = window.IDEAVAULT_CONFIG || {};

  /* ------------------------------------------------------------------
     State
  ------------------------------------------------------------------ */
  var state = {
    view: 'library',          // library | bookmarks | ingest
    search: '',
    category: 'all',
    sort: 'newest',
    user: null,
    mode: 'demo',             // demo | supabase
    categories: [],
    booted: false
  };

  /* ------------------------------------------------------------------
     Elements
  ------------------------------------------------------------------ */
  var el = {};

  function grab() {
    var ids = ['login-view', 'login-form', 'login-email', 'login-password',
      'login-error', 'login-submit', 'login-ig-link', 'app-view', 'ig-handle-link',
      'user-chip', 'user-avatar', 'user-name', 'logout-btn', 'demo-banner',
      'tab-library', 'tab-bookmarks', 'tab-ingest', 'count-meta', 'toolbar',
      'search-input', 'category-select', 'sort-select', 'refresh-btn', 'add-btn',
      'grid', 'empty-state', 'empty-eyebrow', 'empty-title', 'empty-body',
      'empty-steps', 'empty-add-btn', 'empty-clear-btn', 'ingest-panel',
      'ingest-body', 'ingest-empty', 'modal-root', 'toast-root'];
    ids.forEach(function (id) {
      /* ids are dash-case; the references below are camelCase */
      var key = id.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
      el[key] = document.getElementById(id);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    grab();
    boot();
  });

  /* ------------------------------------------------------------------
     Boot
  ------------------------------------------------------------------ */
  async function boot() {
    applyConfig();

    try {
      state.mode = await window.Db.init();
    } catch (err) {
      showFatal('IdeaVault could not start: ' + (err && err.message ? err.message : err));
      return;
    }

    state.categories = window.Db.categories();
    wireStaticEvents();
    window.Db.onChange(function () { render(); });

    if (state.mode === 'supabase') {
      var session = await window.Db.auth.session();
      if (session && session.user) {
        await enterApp(session.user);
      } else {
        showLogin();
      }
      window.Db.auth.onChange(function (event, session) {
        if (event === 'SIGNED_OUT') {
          state.user = null;
          showLogin();
        } else if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') &&
                   session && session.user &&
                   (!state.user || state.user.id !== session.user.id)) {
          enterApp(session.user);
        }
      });
    } else {
      var demoSession = await window.Db.auth.session();
      if (demoSession && demoSession.user) {
        await enterApp(demoSession.user);
      } else {
        showLogin();
      }
    }
    state.booted = true;
  }

  function applyConfig() {
    var handle = CONFIG.instagramHandle || 'IdeaVault-IG';
    var url = CONFIG.instagramUrl || ('https://www.instagram.com/');
    ['igHandleLink', 'loginIgLink'].forEach(function (key) {
      if (el[key]) {
        el[key].textContent = '@' + handle;
        el[key].setAttribute('href', url);
      }
    });
    var footerIg = document.querySelector('.site-footer .footer-nav a');
    if (footerIg) footerIg.setAttribute('href', url);
  }

  function showFatal(message) {
    if (el.modalRoot) {
      el.modalRoot.hidden = false;
      el.modalRoot.classList.add('is-open');
      el.modalRoot.innerHTML =
        '<div class="modal-overlay"><div class="modal modal--narrow" role="alertdialog" aria-modal="true">' +
        '<div class="modal-head"><h2 class="modal-title">Something went wrong</h2></div>' +
        '<div class="modal-body"><p>' + U.escapeHtml(message) + '</p></div></div></div>';
    }
  }

  /* ------------------------------------------------------------------
     Auth surface
  ------------------------------------------------------------------ */
  function showLogin() {
    el.appView.hidden = true;
    el.loginView.hidden = false;
    el.loginEmail.value = '';
    el.loginPassword.value = '';
    el.loginError.hidden = true;
    el.loginEmail.focus();
  }

  async function enterApp(user) {
    state.user = user;
    el.loginView.hidden = true;
    el.appView.hidden = false;
    el.logoutBtn.hidden = false;
    el.userChip.hidden = false;

    var name = user.email ? user.email.split('@')[0] : 'Team member';
    try {
      var profileName = await window.Db.auth.profileName(user);
      if (profileName) name = profileName;
    } catch (e) { /* profile lookup is cosmetic */ }
    el.userName.textContent = name;
    el.userAvatar.textContent = (name.replace(/[^a-z]/gi, '')[0] || 'T').toUpperCase();

    el.demoBanner.hidden = (state.mode !== 'demo');
    state.categories = window.Db.categories();
    renderCategorySelects();
    render();
  }

  function renderCategorySelects() {
    var optionsHtml = '<option value="all">All categories</option>' +
      state.categories.map(function (c) {
        return '<option value="' + U.escapeHtml(c.slug) + '">' + U.escapeHtml(c.name) + '</option>';
      }).join('');
    el.categorySelect.innerHTML = optionsHtml;
    el.categorySelect.value = state.category;
  }

  /* ------------------------------------------------------------------
     Static event wiring
  ------------------------------------------------------------------ */
  function wireStaticEvents() {
    /* Tabs + footer navigation */
    [el.tabLibrary, el.tabBookmarks, el.tabIngest].forEach(function (tab) {
      tab.addEventListener('click', function () { switchView(tab.dataset.view); });
    });
    document.querySelectorAll('.footer-nav button[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () { switchView(btn.dataset.view); });
    });

    /* Toolbar */
    el.searchInput.addEventListener('input', U.debounce(function () {
      state.search = el.searchInput.value.trim();
      renderGrid();
    }, 160));
    el.categorySelect.addEventListener('change', function () {
      state.category = el.categorySelect.value;
      renderGrid();
    });
    el.sortSelect.addEventListener('change', function () {
      state.sort = el.sortSelect.value;
      renderGrid();
    });
    el.refreshBtn.addEventListener('click', async function () {
      setBusy(el.refreshBtn, true, 'Refreshing…');
      try {
        await window.Db.refresh('manual');
        showToast('Library refreshed');
      } catch (err) {
        showToast(err.message || 'Refresh failed', 'error');
      } finally {
        setBusy(el.refreshBtn, false, 'Refresh');
      }
    });
    el.addBtn.addEventListener('click', openAddModal);
    el.emptyAddBtn.addEventListener('click', openAddModal);
    el.emptyClearBtn.addEventListener('click', function () {
      state.search = '';
      state.category = 'all';
      el.searchInput.value = '';
      el.categorySelect.value = 'all';
      renderGrid();
    });

    /* Grid delegation: open details / toggle bookmarks (mouse + keyboard) */
    el.grid.addEventListener('click', function (ev) {
      var bmBtn = ev.target.closest('.card-bookmark');
      if (bmBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var card = ev.target.closest('.card');
        if (card) toggleBookmark(card.dataset.id, bmBtn);
        return;
      }
      var body = ev.target.closest('.card-body');
      if (body) {
        var cardEl = ev.target.closest('.card');
        if (cardEl) openDetailModal(cardEl.dataset.id);
      }
    });
    el.grid.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var body = ev.target.closest('.card-body');
      if (body) {
        ev.preventDefault();
        var cardEl = ev.target.closest('.card');
        if (cardEl) openDetailModal(cardEl.dataset.id);
      }
    });

    /* Login */
    el.loginForm.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      el.loginError.hidden = true;
      var email = el.loginEmail.value.trim();
      var password = el.loginPassword.value;
      if (!email || !password) {
        el.loginError.textContent = 'Enter your email and password.';
        el.loginError.hidden = false;
        return;
      }
      setBusy(el.loginSubmit, true, 'Signing in…');
      try {
        var session = await window.Db.auth.signIn(email, password);
        await enterApp(session.user);
      } catch (err) {
        el.loginError.textContent = err.message || 'Sign-in failed.';
        el.loginError.hidden = false;
      } finally {
        setBusy(el.loginSubmit, false, 'Sign in');
      }
    });

    el.logoutBtn.addEventListener('click', async function () {
      try { await window.Db.auth.signOut(); } catch (e) {}
      state.user = null;
      showLogin();
    });

    /* Modal root delegation: close / copy / delete / bookmark */
    el.modalRoot.addEventListener('click', function (ev) {
      if (ev.target.classList && ev.target.classList.contains('modal-overlay')) {
        closeModal();
        return;
      }
      var t = ev.target.closest('[data-action]');
      if (!t) return;
      var action = t.dataset.action;
      if (action === 'close') closeModal();
      if (action === 'copy') copyCurrentReelUrl(t);
      if (action === 'delete') revealDeleteConfirm();
      if (action === 'delete-cancel') hideDeleteConfirm();
      if (action === 'delete-confirm') performDelete();
      if (action === 'toggle-bookmark') toggleBookmarkFromModal(t);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && el.modalRoot.classList.contains('is-open')) closeModal();
    });
  }

  function switchView(view) {
    state.view = view;
    render();
  }

  /* ------------------------------------------------------------------
     Rendering
  ------------------------------------------------------------------ */
  function render() {
    if (!state.user) return;
    el.tabLibrary.classList.toggle('is-active', state.view === 'library');
    el.tabBookmarks.classList.toggle('is-active', state.view === 'bookmarks');
    el.tabIngest.classList.toggle('is-active', state.view === 'ingest');
    el.tabLibrary.setAttribute('aria-selected', String(state.view === 'library'));
    el.tabBookmarks.setAttribute('aria-selected', String(state.view === 'bookmarks'));
    el.tabIngest.setAttribute('aria-selected', String(state.view === 'ingest'));

    var isGrid = state.view === 'library' || state.view === 'bookmarks';
    el.toolbar.hidden = !isGrid;
    el.grid.hidden = !isGrid;
    el.emptyState.hidden = true;
    el.ingestPanel.hidden = state.view !== 'ingest';

    if (state.view === 'ingest') renderIngest();
    else renderGrid();
  }

  function categoryName(slug) {
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].slug === slug) return state.categories[i].name;
    }
    return slug || 'Uncategorized';
  }

  function kindLabel(normalizedUrl) {
    if (/\/share\//i.test(normalizedUrl || '')) return 'Shared reel';
    if (/\/p\//i.test(normalizedUrl || '')) return 'Instagram post';
    if (/\/tv\//i.test(normalizedUrl || '')) return 'IGTV video';
    return 'Instagram reel';
  }

  function placeholderHtml(reel) {
    var cat = reel.category || 'uncategorized';
    var code = U.shortcodeOf(reel.normalized_url || reel.instagram_url) || 'reel';
    return '<div class="ph" data-category="' + U.escapeHtml(cat) + '" aria-hidden="true">' +
      '<span class="ph-kind">' + U.escapeHtml(kindLabel(reel.normalized_url)) + '</span>' +
      '<span class="ph-letter">' + U.plateLetter(code) + '</span>' +
      '<span class="ph-code">' + U.escapeHtml(U.truncate(code, 16)) + '</span>' +
      '</div>';
  }

  function cardHtml(reel, bookmarked) {
    var esc = U.escapeHtml;
    var title = reel.title
      ? '<h3 class="card-title">' + esc(reel.title) + '</h3>'
      : '<h3 class="card-title card-title--untitled">Untitled reference</h3>';

    var creator;
    if (reel.creator_username) {
      var at = reel.creator_username.charAt(0) === '@' ? esc(reel.creator_username) : '@' + esc(reel.creator_username);
      creator = '<p class="card-creator">' + at + '</p>';
    } else {
      creator = '<p class="card-creator card-creator--unknown">Creator unknown</p>';
    }

    var shares = reel.reel_shares || [];
    var via = shares.length ? shares[0].sender_label : 'Instagram DM';
    var meta = 'Received ' + U.formatDate(reel.received_at) + ' · via ' + esc(via);
    if (reel.share_count > 1) meta += ' · shared by ' + reel.share_count;

    var tags = (reel.tags || []).length
      ? '<p class="card-tags">' + reel.tags.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</p>'
      : '';

    var notesPreview = reel.notes
      ? '<p class="card-notes-preview">“' + esc(reel.notes) + '”</p>'
      : '';

    var media = reel.thumbnail_url
      ? '<img class="card-img" src="' + esc(reel.thumbnail_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />'
      : placeholderHtml(reel);

    return '' +
      '<article class="card" data-id="' + esc(reel.id) + '">' +
        '<div class="card-media">' +
          '<a class="card-media-link" href="' + esc(reel.instagram_url) + '" target="_blank" rel="noopener" ' +
             'aria-label="Open the original on Instagram">' + media + '</a>' +
          '<span class="pill pill--' + esc(reel.category || 'uncategorized') + '">' + esc(categoryName(reel.category)) + '</span>' +
          '<button class="card-bookmark" type="button" data-bookmark="' + (bookmarked ? '1' : '0') + '" ' +
            'aria-pressed="' + (bookmarked ? 'true' : 'false') + '" ' +
            'title="' + (bookmarked ? 'Remove bookmark' : 'Bookmark this reference') + '">' +
            starSvg(bookmarked) + '</button>' +
        '</div>' +
        '<div class="card-body" data-action="detail" role="button" tabindex="0" ' +
             'aria-label="View details of ' + esc(reel.title || 'untitled reference') + '">' +
          title + creator +
          '<p class="card-meta">' + meta + '</p>' +
          tags + notesPreview +
        '</div>' +
      '</article>';
  }

  function starSvg(on) {
    return on
      ? '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z" stroke-linejoin="round"/></svg>';
  }

  function renderGrid() {
    var all = window.Db.reels.list({ view: 'library' });
    var filtered = window.Db.reels.list({
      view: state.view,
      search: state.search,
      category: state.category,
      sort: state.sort
    });
    var bookmarkedIds = window.Db.bookmarks.ids();

    var bookmarkedCount = all.filter(function (r) { return bookmarkedIds.has(r.id); }).length;
    el.countMeta.textContent =
      state.view === 'bookmarks'
        ? filtered.length + ' of ' + all.length + ' bookmarked'
        : all.length + ' references · ' + bookmarkedCount + ' bookmarked';

    if (filtered.length === 0) {
      el.grid.innerHTML = '';
      showEmptyState(all.length);
      return;
    }

    el.emptyState.hidden = true;
    el.grid.innerHTML = filtered.map(function (r) {
      return cardHtml(r, bookmarkedIds.has(r.id));
    }).join('');

    /* Broken thumbnails fall back to the clean placeholder — never a
       broken-image glyph. */
    el.grid.querySelectorAll('img.card-img').forEach(function (img) {
      img.addEventListener('error', function () {
        var card = img.closest('.card');
        var reel = card ? window.Db.reels.get(card.dataset.id) : null;
        var wrapper = document.createElement('div');
        wrapper.innerHTML = reel ? placeholderHtml(reel) : '';
        if (wrapper.firstChild) img.replaceWith(wrapper.firstChild);
      });
    });
  }

  function showEmptyState(totalCount) {
    var filtersActive = state.search !== '' || state.category !== 'all';
    el.emptyState.hidden = false;

    if (state.view === 'bookmarks') {
      el.emptyEyebrow.textContent = 'Bookmarked';
      el.emptyTitle.textContent = 'Nothing bookmarked yet';
      el.emptyBody.textContent =
        'Bookmark references from the library to keep the ones you keep coming back to within reach.';
      el.emptySteps.hidden = true;
      el.emptyAddBtn.hidden = true;
      el.emptyClearBtn.hidden = true;
      return;
    }

    if (totalCount === 0 && !filtersActive) {
      el.emptyEyebrow.textContent = 'The library is empty';
      el.emptyTitle.textContent = 'Share your first Reel';
      el.emptyBody.textContent =
        'No references have arrived yet. The primary workflow needs no forms at all — send Reels straight to the team account on Instagram.';
      el.emptySteps.hidden = false;
      el.emptyAddBtn.hidden = false;
      el.emptyClearBtn.hidden = true;
      return;
    }

    el.emptyEyebrow.textContent = 'No matches';
    el.emptyTitle.textContent = 'Nothing matches this view';
    el.emptyBody.textContent = filtersActive
      ? 'No references match the current search and filters.'
      : 'All clear here.';
    el.emptySteps.hidden = true;
    el.emptyAddBtn.hidden = true;
    el.emptyClearBtn.hidden = !filtersActive;
  }

  /* ------------------------------------------------------------------
     Ingest log
  ------------------------------------------------------------------ */
  var INGEST_STATUS_LABELS = {
    processed: ['pill--status-processed', 'Saved'],
    duplicate_reel: ['pill--status-duplicate-reel', 'Duplicate reel'],
    duplicate_event: ['pill--status-duplicate-event', 'Redelivery'],
    skipped_no_reel_url: ['pill--status-skipped', 'Skipped — no link'],
    skipped_invalid_url: ['pill--status-skipped', 'Skipped — invalid link'],
    skipped_not_message: ['pill--status-skipped', 'Skipped'],
    error: ['pill--status-error', 'Error'],
    received: ['pill--status-received', 'Received']
  };

  async function renderIngest() {
    el.countMeta.textContent = 'Ingest log';
    el.ingestBody.innerHTML =
      '<tr><td colspan="5" class="ingest-detail">Loading events…</td></tr>';
    el.ingestEmpty.hidden = true;
    try {
      var events = await window.Db.events.recent(60);
      if (!events.length) {
        el.ingestBody.innerHTML = '';
        el.ingestEmpty.hidden = false;
        return;
      }
      el.ingestBody.innerHTML = events.map(function (ev) {
        var esc = U.escapeHtml;
        var label = INGEST_STATUS_LABELS[ev.status] || ['pill--status-received', ev.status];
        var urlCell = ev.extracted_url
          ? '<a href="' + esc(ev.extracted_url) + '" target="_blank" rel="noopener" class="ingest-url">' +
            esc(U.truncate(ev.extracted_url.replace(/^https?:\/\/(www\.)?/, ''), 42)) + '</a>'
          : '<span class="ingest-detail">—</span>';
        return '<tr>' +
          '<td class="ingest-when">' + U.formatDate(ev.received_at) + ' ' + U.formatTime(ev.received_at) + '</td>' +
          '<td><span class="pill ' + label[0] + '">' + label[1] + '</span></td>' +
          '<td class="ingest-from">' + esc(ev.sender_label || 'unknown') + '</td>' +
          '<td>' + urlCell + '</td>' +
          '<td class="ingest-detail">' + esc(ev.detail || '') + '</td>' +
        '</tr>';
      }).join('');
    } catch (err) {
      el.ingestBody.innerHTML =
        '<tr><td colspan="5" class="ingest-detail">Could not load the ingest log — ' +
        U.escapeHtml(err.message || 'unknown error') + '</td></tr>';
    }
  }

  /* ------------------------------------------------------------------
     Bookmarks
  ------------------------------------------------------------------ */
  async function toggleBookmark(reelId, btn) {
    var has = window.Db.bookmarks.has(reelId);
    /* optimistic */
    btn.setAttribute('aria-pressed', String(!has));
    btn.dataset.bookmark = has ? '0' : '1';
    btn.innerHTML = starSvg(!has);
    btn.title = !has ? 'Remove bookmark' : 'Bookmark this reference';
    try {
      await window.Db.bookmarks.set(reelId, !has);
      /* db.js notifies listeners -> grid re-renders (removes the card
         from the Bookmarked view when un-bookmarking there) */
    } catch (err) {
      btn.setAttribute('aria-pressed', String(has));
      btn.dataset.bookmark = has ? '1' : '0';
      btn.innerHTML = starSvg(has);
      showToast(err.message || 'Could not update the bookmark', 'error');
    }
  }

  async function toggleBookmarkFromModal(btn) {
    var id = btn.dataset.reelId;
    if (!id) return;
    var has = window.Db.bookmarks.has(id);
    try {
      await window.Db.bookmarks.set(id, !has);
      btn.innerHTML = starSvg(!has) + (window.Db.bookmarks.has(id) ? ' Bookmarked' : ' Bookmark');
    } catch (err) {
      showToast(err.message || 'Could not update the bookmark', 'error');
    }
  }

  /* ------------------------------------------------------------------
     Modals — generic shell
  ------------------------------------------------------------------ */
  function openModal(html) {
    el.modalRoot.innerHTML = html;
    el.modalRoot.hidden = false;
    el.modalRoot.classList.add('is-open');
    var first = el.modalRoot.querySelector('input:not([readonly]):not([type=hidden]), select, textarea');
    if (first) first.focus();
    else {
      var fb = el.modalRoot.querySelector('button');
      if (fb) fb.focus();
    }
  }

  function closeModal() {
    el.modalRoot.classList.remove('is-open');
    el.modalRoot.innerHTML = '';
    el.modalRoot.hidden = true;
  }

  var CLOSE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';
  var EXTERNAL_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>';

  function categoryOptionsHtml(selected) {
    return state.categories.map(function (c) {
      return '<option value="' + U.escapeHtml(c.slug) + '"' +
        (c.slug === selected ? ' selected' : '') + '>' + U.escapeHtml(c.name) + '</option>';
    }).join('');
  }

  /* ------------------------------------------------------------------
     Detail modal
  ------------------------------------------------------------------ */
  function openDetailModal(reelId) {
    var reel = window.Db.reels.get(reelId);
    if (!reel) return;
    var esc = U.escapeHtml;
    var bookmarked = window.Db.bookmarks.has(reel.id);

    var media = reel.thumbnail_url
      ? '<img src="' + esc(reel.thumbnail_url) + '" alt="" referrerpolicy="no-referrer" />'
      : placeholderHtml(reel);

    var sharesHtml = (reel.reel_shares || []).map(function (s) {
      return '<li><span class="share-who">' + esc(s.sender_label) + '</span>' +
        '<span class="share-src">' + (s.source === 'manual' ? 'Added manually' : 'Instagram DM') + '</span>' +
        '<span>' + U.formatDate(s.shared_at) + '</span></li>';
    }).join('');

    var metaMissing = [];
    if (!reel.title) metaMissing.push('title');
    if (!reel.creator_username) metaMissing.push('creator');
    var metaHint = metaMissing.length
      ? '<p class="field-hint">Instagram did not attach ' + metaMissing.join(' and ') +
        ' to this share — the fields above are editable so you can complete them by hand.</p>'
      : '';

    openModal(
      '<div class="modal-overlay">' +
      '<div class="modal modal--wide" role="dialog" aria-modal="true" aria-labelledby="detail-title-elem">' +
        '<div class="modal-head">' +
          '<div>' +
            '<h2 class="modal-title" id="detail-title-elem">Reference details</h2>' +
            '<p class="modal-sub">Received ' + U.formatDate(reel.received_at) +
              ' · ' + esc(kindLabel(reel.normalized_url)) +
              (reel.share_count > 1 ? ' · shared by ' + reel.share_count : '') + '</p>' +
          '</div>' +
          '<button class="modal-close" type="button" data-action="close" aria-label="Close">' + CLOSE_SVG + '</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<form id="detail-form" novalidate>' +
          '<div class="detail-grid">' +
            '<div class="detail-media">' + media + '</div>' +
            '<div class="detail-meta">' +
              '<div class="field"><label for="d-category">Category</label>' +
                '<select id="d-category" name="category">' + categoryOptionsHtml(reel.category) + '</select></div>' +
              '<div class="field"><label for="d-title">Title</label>' +
                '<input id="d-title" name="title" type="text" value="' + esc(reel.title || '') + '" ' +
                'placeholder="No title provided by Instagram — add one" /></div>' +
              '<div class="field"><label for="d-creator">Creator</label>' +
                '<input id="d-creator" name="creator" type="text" value="' + esc(reel.creator_username || '') + '" ' +
                'placeholder="Creator unknown — add the @handle" /></div>' +
              '<div class="field"><label>Original Instagram URL</label>' +
                '<div class="detail-url-row">' +
                  '<input type="text" readonly value="' + esc(reel.instagram_url) + '" aria-label="Original Instagram URL" />' +
                  '<button class="btn btn--ghost btn--small" type="button" data-action="copy">Copy</button>' +
                  '<a class="btn btn--ghost btn--small" href="' + esc(reel.instagram_url) + '" target="_blank" rel="noopener">Open ' + EXTERNAL_SVG + '</a>' +
                '</div>' +
                '<p class="field-hint">Normalised identity: <span class="ingest-url">' + esc(reel.normalized_url) + '</span></p>' +
              '</div>' +
              '<div class="field"><label for="d-tags">Tags</label>' +
                '<input id="d-tags" name="tags" type="text" value="' + esc((reel.tags || []).join(', ')) + '" ' +
                'placeholder="comma, separated, tags" /></div>' +
              '<div class="field"><label for="d-notes">Notes</label>' +
                '<textarea id="d-notes" name="notes" placeholder="Why this reference matters…">' + esc(reel.notes || '') + '</textarea></div>' +
              '<div class="shares-block">' +
                '<p class="shares-title">Shared by</p>' +
                '<ul class="shares-list">' + (sharesHtml || '<li>Unknown sender</li>') + '</ul>' +
              '</div>' +
              '<div class="modal-actions">' +
                '<button class="btn btn--solid" type="submit" id="detail-save">Save changes</button>' +
                '<button class="btn btn--ghost" type="button" data-action="delete" id="detail-delete">Remove…</button>' +
                '<span class="spacer"></span>' +
                '<button class="btn btn--ghost" type="button" data-action="toggle-bookmark" data-reel-id="' + esc(reel.id) + '" id="detail-bookmark">' +
                  starSvg(bookmarked) + (bookmarked ? ' Bookmarked' : ' Bookmark') + '</button>' +
              '</div>' +
              '<div class="delete-confirm" id="delete-confirm" hidden>' +
                '<p class="confirm-note">Remove this reference from the shared library? The original Reel stays on Instagram — this only removes it for the whole team.</p>' +
                '<div class="modal-actions">' +
                  '<button class="btn btn--danger" type="button" data-action="delete-confirm">Yes, remove it</button>' +
                  '<button class="btn btn--ghost" type="button" data-action="delete-cancel">Keep it</button>' +
                '</div>' +
              '</div>' +
              metaHint +
            '</div>' +
          '</div>' +
          '</form>' +
        '</div>' +
      '</div>' +
      '</div>'
    );

    var form = document.getElementById('detail-form');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var saveBtn = document.getElementById('detail-save');
      setBusy(saveBtn, true, 'Saving…');
      try {
        /* Read fields by id — never form.title etc., which collide with
           native HTMLFormElement properties. */
        await window.Db.reels.update(reel.id, {
          title: document.getElementById('d-title').value.trim() || null,
          creator_username: document.getElementById('d-creator').value.trim().replace(/^@/, '') || null,
          category: document.getElementById('d-category').value,
          tags: U.parseTags(document.getElementById('d-tags').value),
          notes: document.getElementById('d-notes').value.trim()
        });
        closeModal();
        showToast('Changes saved to the shared library');
      } catch (err) {
        showToast(err.message || 'Could not save changes', 'error');
      } finally {
        setBusy(saveBtn, false, 'Save changes');
      }
    });
  }

  function revealDeleteConfirm() {
    var area = document.getElementById('delete-confirm');
    if (area) area.hidden = false;
    var delBtn = document.getElementById('detail-delete');
    if (delBtn) delBtn.disabled = true;
  }

  function hideDeleteConfirm() {
    var area = document.getElementById('delete-confirm');
    if (area) area.hidden = true;
    var delBtn = document.getElementById('detail-delete');
    if (delBtn) delBtn.disabled = false;
  }

  async function performDelete() {
    var form = document.getElementById('detail-form');
    var reel = form ? window.Db.reels.get(currentDetailId()) : null;
    if (!reel) return;
    var confirmBtn = el.modalRoot.querySelector('[data-action="delete-confirm"]');
    if (confirmBtn) setBusy(confirmBtn, true, 'Removing…');
    try {
      await window.Db.reels.remove(reel.id);
      closeModal();
      showToast('Reference removed from the shared library');
    } catch (err) {
      showToast(err.message || 'Could not remove the reference', 'error');
      hideDeleteConfirm();
    }
  }

  function currentDetailId() {
    var btn = el.modalRoot.querySelector('[data-action="toggle-bookmark"]');
    return btn ? btn.dataset.reelId : null;
  }

  function copyCurrentReelUrl() {
    var input = el.modalRoot.querySelector('.detail-url-row input');
    if (!input) return;
    U.copyText(input.value).then(function (ok) {
      showToast(ok ? 'Reel URL copied to clipboard' : 'Could not copy — select the URL manually', ok ? '' : 'error');
    });
  }

  /* ------------------------------------------------------------------
     Add modal (manual fallback)
  ------------------------------------------------------------------ */
  function openAddModal() {
    openModal(
      '<div class="modal-overlay">' +
      '<div class="modal modal--narrow" role="dialog" aria-modal="true" aria-labelledby="add-title-elem">' +
        '<div class="modal-head">' +
          '<div>' +
            '<h2 class="modal-title" id="add-title-elem">Add a reference</h2>' +
            '<p class="modal-sub">Manual fallback</p>' +
          '</div>' +
          '<button class="modal-close" type="button" data-action="close" aria-label="Close">' + CLOSE_SVG + '</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="field-hint" style="margin-top:0">The primary workflow is sharing by DM to ' +
            '<strong>@' + U.escapeHtml(CONFIG.instagramHandle || 'IdeaVault-IG') + '</strong> — ' +
            'it fills the library automatically. Use this form only when DM sharing is not an option.</p>' +
          '<form id="add-form" novalidate>' +
            '<div class="field"><label for="a-url">Instagram Reel URL</label>' +
              '<input id="a-url" name="url" type="text" placeholder="https://www.instagram.com/reel/…" spellcheck="false" />' +
              '<p class="field-hint" id="a-url-preview">&nbsp;</p></div>' +
            '<div class="field"><label for="a-category">Category</label>' +
              '<select id="a-category" name="category">' + categoryOptionsHtml('uncategorized') + '</select></div>' +
            '<div class="field"><label for="a-creator">Creator <span style="text-transform:none;letter-spacing:0">(optional)</span></label>' +
              '<input id="a-creator" name="creator" type="text" placeholder="@handle" /></div>' +
            '<div class="field"><label for="a-tags">Tags <span style="text-transform:none;letter-spacing:0">(optional)</span></label>' +
              '<input id="a-tags" name="tags" type="text" placeholder="motion, reference, pitch" /></div>' +
            '<div class="field"><label for="a-notes">Notes <span style="text-transform:none;letter-spacing:0">(optional)</span></label>' +
              '<textarea id="a-notes" name="notes" placeholder="Why this reference matters…"></textarea></div>' +
            '<p class="form-error" id="a-error" hidden></p>' +
            '<div class="modal-actions">' +
              '<button class="btn btn--solid" type="submit" id="a-save">Add to library</button>' +
              '<button class="btn btn--ghost" type="button" data-action="close">Cancel</button>' +
            '</div>' +
          '</form>' +
        '</div>' +
      '</div>' +
      '</div>'
    );

    var urlInput = document.getElementById('a-url');
    var preview = document.getElementById('a-url-preview');
    urlInput.addEventListener('input', function () {
      var v = urlInput.value.trim();
      if (!v) { preview.innerHTML = '&nbsp;'; return; }
      var n = U.normalizeInstagramUrl(v);
      preview.textContent = n
        ? 'Will be saved as ' + n + ' — duplicates are merged automatically.'
        : 'Not an Instagram Reel/post link yet…';
    });
    urlInput.focus();

    var form = document.getElementById('add-form');
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var errEl = document.getElementById('a-error');
      errEl.hidden = true;
      var saveBtn = document.getElementById('a-save');
      setBusy(saveBtn, true, 'Adding…');
      try {
        await window.Db.reels.add({
          instagram_url: document.getElementById('a-url').value.trim(),
          title: null,
          creator_username: document.getElementById('a-creator').value.trim().replace(/^@/, '') || null,
          category: document.getElementById('a-category').value,
          tags: U.parseTags(document.getElementById('a-tags').value),
          notes: document.getElementById('a-notes').value.trim()
        }, state.user);
        closeModal();
        showToast('Reference added to the shared library');
        switchView('library');
      } catch (err) {
        errEl.textContent = err.message || 'Could not add the reference.';
        errEl.hidden = false;
        setBusy(saveBtn, false, 'Add to library');
      }
    });
  }

  /* ------------------------------------------------------------------
     Toasts & small helpers
  ------------------------------------------------------------------ */
  function showToast(message, type) {
    var t = document.createElement('div');
    t.className = 'toast' + (type === 'error' ? ' toast--error' : '');
    t.textContent = message;
    el.toastRoot.appendChild(t);
    setTimeout(function () {
      t.classList.add('is-leaving');
      setTimeout(function () { t.remove(); }, 300);
    }, 3200);
  }

  function setBusy(btn, busy, busyLabel) {
    if (!btn) return;
    if (busy) {
      btn.dataset.originalLabel = btn.innerHTML;
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = busyLabel || 'Working…';
    } else {
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
      if (btn.dataset.originalLabel) btn.innerHTML = btn.dataset.originalLabel;
    }
  }
})();

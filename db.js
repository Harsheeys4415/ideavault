/* =====================================================================
   IdeaVault — data-access layer (db.js)
   ---------------------------------------------------------------------
   ALL database operations live here. app.js (the UI) never talks to
   Supabase directly — it calls Db.* and renders the results. Two
   adapters implement the same interface:

     supabase  – the real shared library (Postgres + RLS + realtime)
     demo      – local sample data so the interface can be explored
                 before Supabase is configured (clearly labelled)

   Security note: this file only ever uses the PUBLIC anon key from
   config.js. Every privileged operation (webhook ingestion, metadata
   enrichment) happens server-side in the Edge Function with the
   service-role key, which is never present in the frontend.
   ===================================================================== */
(function () {
  'use strict';

  var CONFIG = window.IDEAVAULT_CONFIG || {};
  var U = window.IVUtils;

  function AppError(code, message) {
    var e = new Error(message);
    e.name = 'AppError';
    e.code = code;
    return e;
  }

  function userLabel(user) {
    if (!user) return 'unknown';
    var meta = user.user_metadata || {};
    return meta.full_name || meta.display_name ||
      (user.email ? user.email.split('@')[0] : 'team member');
  }

  /* ------------------------------------------------------------------
     Shared filter/sort — same row shape from both adapters
  ------------------------------------------------------------------ */
  function applyFilters(rows, opts, bookmarkedIds) {
    var terms = String(opts.search || '').toLowerCase().split(/\s+/).filter(Boolean);
    var view = opts.view || 'library';
    var out = rows.filter(function (r) {
      if (opts.category && opts.category !== 'all' && r.category !== opts.category) return false;
      if (view === 'bookmarks' && !bookmarkedIds.has(r.id)) return false;
      if (terms.length) {
        var hay = [r.title, r.creator_username, r.instagram_url, r.notes, (r.tags || []).join(' ')]
          .filter(Boolean).join(' ').toLowerCase();
        for (var i = 0; i < terms.length; i++) {
          if (hay.indexOf(terms[i]) === -1) return false;
        }
      }
      return true;
    });
    out.sort(function (a, b) {
      var da = new Date(a.received_at).getTime() || 0;
      var dbb = new Date(b.received_at).getTime() || 0;
      return opts.sort === 'oldest' ? da - dbb : dbb - da;
    });
    return out;
  }

  /* ==================================================================
     SUPABASE ADAPTER
  ================================================================== */
  function createSupabaseAdapter(client) {
    var cache = { reels: [], bookmarkIds: new Set(), categories: [] };
    var listeners = [];
    var refreshTimer = null;
    var ready = false;

    function notify(reason) {
      listeners.forEach(function (fn) {
        try { fn(reason); } catch (e) { /* listener errors must not break the data layer */ }
      });
    }

    function scheduleRefresh(reason, delayMs) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () {
        refreshTimer = null;
        refresh(reason);
      }, delayMs == null ? 500 : delayMs);
    }

    async function refresh(reason) {
      var reelsQ = client
        .from('reels')
        .select('id, instagram_url, normalized_url, media_id, title, creator_username, ' +
                'thumbnail_url, category, tags, notes, received_at, last_shared_at, ' +
                'share_count, created_at, updated_at, ' +
                'reel_shares(id, sender_label, source, shared_at)')
        .order('received_at', { ascending: false })
        .limit(1000);
      var bmQ = client.from('bookmarks').select('reel_id');
      var catQ = client.from('categories').select('slug, name, accent, sort_order').order('sort_order');

      var results = await Promise.all([reelsQ, bmQ, catQ]);

      if (results[0].error) throw AppError('network', 'Could not load the library — ' + results[0].error.message);
      if (results[1].error) throw AppError('network', 'Could not load bookmarks — ' + results[1].error.message);
      if (results[2].error) throw AppError('network', 'Could not load categories — ' + results[2].error.message);

      cache.reels = results[0].data || [];
      cache.bookmarkIds = new Set((results[1].data || []).map(function (b) { return b.reel_id; }));
      cache.categories = results[2].data || [];
      ready = true;
      notify(reason || 'refresh');
    }

    /* Realtime: new rows land live; polling is the safety net. */
    function watchRealtime() {
      try {
        client
          .channel('ideavault-library')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'reels' },
            function () { scheduleRefresh('realtime:reels'); })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'reel_shares' },
            function () { scheduleRefresh('realtime:shares'); })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'bookmarks' },
            function () { scheduleRefresh('realtime:bookmarks', 150); })
          .subscribe();
      } catch (e) {
        /* realtime is an enhancement, never a dependency */
      }
    }

    function startPolling() {
      var sec = Number(CONFIG.pollSeconds || 0);
      if (!sec || sec < 10) return;
      setInterval(function () {
        if (document.visibilityState === 'visible') {
          refresh('poll').catch(function () { /* transient network issue; next tick retries */ });
        }
      }, sec * 1000);
    }

    return {
      ready: async function () {
  var sessionResult = await client.auth.getSession();
  var session = sessionResult.data && sessionResult.data.session;

  if (session) {
    await refresh('init');
    watchRealtime();
    startPolling();
  }
},
      refresh: refresh,
      onChange: function (fn) { listeners.push(fn); },
      categories: function () { return cache.categories.slice(); },
      reels: {
        list: function (opts) {
          return applyFilters(cache.reels, opts || {}, cache.bookmarkIds);
        },
        get: function (id) {
          for (var i = 0; i < cache.reels.length; i++) {
            if (cache.reels[i].id === id) return cache.reels[i];
          }
          return null;
        },
        add: async function (input, user) {
          var normalized = U.normalizeInstagramUrl(input.instagram_url);
          if (!normalized) {
            throw AppError('invalid_url',
              'That does not look like an Instagram Reel or post link. ' +
              'Paste the full instagram.com/reel/… URL.');
          }
          var dup = await client.from('reels').select('id').eq('normalized_url', normalized).maybeSingle();
          if (dup.error) throw AppError('network', 'Could not check for duplicates — ' + dup.error.message);
          if (dup.data) {
            throw AppError('duplicate',
              'This Reel is already in the library. Duplicates are merged, not re-added.');
          }
          var row = {
            instagram_url: String(input.instagram_url).trim(),
            normalized_url: normalized,
            title: input.title || null,
            creator_username: input.creator_username || null,
            category: input.category || 'uncategorized',
            tags: input.tags || [],
            notes: input.notes || ''
          };
          var ins = await client.from('reels').insert(row).select('id').single();
          if (ins.error) {
            if (/duplicate key|unique constraint/i.test(ins.error.message || '')) {
              throw AppError('duplicate', 'This Reel is already in the library.');
            }
            throw AppError('network', 'Could not save the reference — ' + ins.error.message);
          }
          try {
            await client.from('reel_shares').insert({
              reel_id: ins.data.id,
              sender_label: userLabel(user),
              source: 'manual'
            });
          } catch (e) { /* a failed share log must not lose the reference */ }
          await refresh('add');
          return ins.data.id;
        },
        update: async function (id, patch) {
          var clean = {};
          ['title', 'creator_username', 'category', 'tags', 'notes'].forEach(function (k) {
            if (k in patch) clean[k] = patch[k];
          });
          var upd = await client.from('reels').update(clean).eq('id', id)
            .select('id, updated_at').single();
          if (upd.error) throw AppError('network', 'Could not save changes — ' + upd.error.message);
          await refresh('update');
          return upd.data;
        },
        remove: async function (id) {
          var del = await client.from('reels').delete().eq('id', id);
          if (del.error) throw AppError('network', 'Could not remove the reference — ' + del.error.message);
          await refresh('remove');
        }
      },
      bookmarks: {
        ids: function () { return new Set(cache.bookmarkIds); },
        has: function (id) { return cache.bookmarkIds.has(id); },
        set: async function (reelId, on) {
          if (on) {
            var ins = await client.from('bookmarks').insert({ reel_id: reelId });
            if (ins.error && !/duplicate key/i.test(ins.error.message || '')) {
              throw AppError('network', 'Could not bookmark — ' + ins.error.message);
            }
            cache.bookmarkIds.add(reelId);
          } else {
            var del = await client.from('bookmarks').delete().eq('reel_id', reelId);
            if (del.error) throw AppError('network', 'Could not update bookmark — ' + del.error.message);
            cache.bookmarkIds.delete(reelId);
          }
          notify('bookmark');
        }
      },
      events: {
        recent: async function (limit) {
          var q = client.from('webhook_events')
            .select('message_id, received_at, status, sender_label, extracted_url, reel_id, detail')
            .order('received_at', { ascending: false })
            .limit(limit || 50);
          var res = await q;
          if (res.error) throw AppError('network', 'Could not load the ingest log — ' + res.error.message);
          return res.data || [];
        }
      },
      auth: {
        session: async function () {
          var res = await client.auth.getSession();
          return (res.data && res.data.session) || null;
        },
        signIn: async function (email, password) {
          var res = await client.auth.signInWithPassword({ email: email, password: password });
          if (res.error) {
            var msg = res.error.message || 'Sign-in failed.';
            if (/invalid login credentials/i.test(msg)) msg = 'Invalid email or password.';
            else if (/email not confirmed/i.test(msg)) msg = 'This account has not confirmed its email address yet.';
            else if (/rate limit/i.test(msg)) msg = 'Too many attempts — wait a moment and try again.';
            throw AppError('auth', msg);
          }
          return res.data.session;
        },
        signOut: async function () { await client.auth.signOut(); },
        onChange: function (cb) {
          client.auth.onAuthStateChange(function (event, session) { cb(event, session); });
        },
        profileName: async function (user) {
          if (!user) return null;
          var res = await client.from('profiles').select('display_name').eq('id', user.id).maybeSingle();
          return (res.data && res.data.display_name) || null;
        }
      }
    };
  }

  /* ==================================================================
     DEMO ADAPTER — sample data, persisted to localStorage only.
     Used when config.js has no Supabase project configured, so the
     interface can be explored before deployment. Nothing here is
     shared with the team; the real workflow needs Supabase + the
     webhook (see README.md).
  ================================================================== */
  function createDemoAdapter() {
    var KEY = 'ideavault-demo-v1';
    var store = null;
    var listeners = [];

    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms || 90); }); }

    function isoDaysAgo(days, minutes) {
      return new Date(Date.now() - days * 86400000 - (minutes || 0) * 60000).toISOString();
    }

    function mk(code, opts) {
      opts = opts || {};
      var shares = (opts.shares || ['@maya.k']).map(function (who, i) {
        return {
          id: code + '-sh' + i,
          sender_label: who,
          source: who.indexOf('IGSID:') === 0 ? 'instagram_dm' : (opts.source || 'instagram_dm'),
          shared_at: isoDaysAgo(opts.days == null ? 1 : opts.days, i * 40)
        };
      });
      return {
        id: 'demo-' + code,
        instagram_url: 'https://www.instagram.com/reel/' + code + '/?igsh=' + (opts.igsh || 'MXdEMm' + code.slice(0, 3)) + '&utm_source=ig_share',
        normalized_url: 'https://www.instagram.com/reel/' + code + '/',
        media_id: null,
        title: opts.title == null ? null : opts.title,
        creator_username: opts.creator == null ? null : opts.creator,
        thumbnail_url: null, /* Instagram does not provide thumbnails for shared Reels — see README */
        category: opts.category || 'uncategorized',
        tags: opts.tags || [],
        notes: opts.notes || '',
        received_at: isoDaysAgo(opts.days == null ? 1 : opts.days),
        last_shared_at: shares.length > 1 ? shares[shares.length - 1].shared_at : null,
        share_count: shares.length,
        created_at: isoDaysAgo(opts.days == null ? 1 : opts.days),
        updated_at: isoDaysAgo(opts.days == null ? 1 : opts.days, -30),
        reel_shares: shares
      };
    }

    function seed() {
      return {
        categories: [
          { slug: 'advertising', name: 'Advertising', accent: '#191713', sort_order: 10 },
          { slug: 'motion', name: 'Motion Graphics', accent: '#2f5a4c', sort_order: 20 },
          { slug: 'cgi', name: '3D / CGI', accent: '#40406b', sort_order: 30 },
          { slug: 'editing', name: 'Editing', accent: '#8c3a2b', sort_order: 40 },
          { slug: 'typography', name: 'Typography', accent: '#a07d2c', sort_order: 50 },
          { slug: 'uncategorized', name: 'Uncategorized', accent: '#6b6455', sort_order: 90 }
        ],
        reels: [
          mk('DKxQ2fBv1aH', { title: 'Nothing Beats a Dreamer', creator: 'nike', category: 'advertising', tags: ['hero film', 'sport', 'VO'], notes: 'Great pacing on the VO cutdowns — reference for the Q3 brand pitch.', days: 1, shares: ['@maya.k', '@jules'] }),
          mk('C2mR8tLp4xZ', { title: 'Vision Pro — Macro Worlds', creator: 'apple', category: 'cgi', tags: ['product', 'macro', 'render'], days: 2, shares: ['@priya'] }),
          mk('DA9fKw2nQrT', { title: 'Wrapped — Kinetic Type System', creator: 'spotify', category: 'motion', tags: ['kinetic type', 'colour'], days: 3, shares: ['@tomas'] }),
          mk('DB71hLz6vBc', { title: null, creator: null, category: 'editing', tags: [], notes: 'Arrived with no title or creator. Instagram does not always attach metadata to shares — open the original to see the Reel.', days: 4, shares: ['IGSID:17841400000000000'] }),
          mk('Cw3nFq8sYhK', { title: 'Silk in Motion', creator: 'hermes', category: 'cgi', tags: ['fabric sim', 'cloth'], days: 6, shares: ['@jules', '@maya.k', '@priya'] }),
          mk('DG4kTp9wXmN', { title: 'Cheap Tricks, Big Feelings', creator: 'oatly', category: 'advertising', tags: ['lo-fi', 'humour'], notes: 'Tone reference for self-aware copy and jump cuts.', days: 7, shares: ['@tomas'] }),
          mk('Cx8rHb2mVfQ', { title: 'Dynamic Identity Reel', creator: 'studiodumbar', category: 'motion', tags: ['identity', 'generative'], days: 9, shares: ['@maya.k'] }),
          mk('DF6sNk4jWpL', { title: 'Stratos — Anniversary Edit', creator: 'redbull', category: 'editing', tags: ['sound design', 'archival'], days: 12, shares: ['@jules'] }),
          mk('Dg2vYt7cRmB', { title: 'Typography in Space', creator: 'pentagram', category: 'typography', tags: ['3d type', 'grid'], days: 14, shares: ['@priya'] }),
          mk('Dk9wZq3fHnV', { title: 'Teaser Cut — Cinematic Worldbuilding', creator: 'a24', category: 'cgi', tags: ['cinematic', 'vfx', 'grade'], days: 16, shares: ['@maya.k'] }),
          mk('Cv5tMs8kYdG', { title: 'Craft in Motion', creator: 'loewe', category: 'advertising', tags: ['craft', 'texture'], days: 21, shares: ['@tomas'] })
        ],
        bookmarked: ['demo-C2mR8tLp4xZ', 'demo-Cx8rHb2mVfQ', 'demo-Cv5tMs8kYdG'],
        user: null,
        events: [
          { message_id: 'm_mid.1944.demo01', received_at: isoDaysAgo(1, 2), status: 'processed', sender_label: '@maya.k', extracted_url: 'https://www.instagram.com/reel/DKxQ2fBv1aH/', reel_id: 'demo-DKxQ2fBv1aH', detail: 'New reference saved (via attachment:share).' },
          { message_id: 'm_mid.1944.demo02', received_at: isoDaysAgo(1, 6), status: 'duplicate_reel', sender_label: '@jules', extracted_url: 'https://www.instagram.com/reel/Cw3nFq8sYhK/?igsh=demo', reel_id: 'demo-Cw3nFq8sYhK', detail: 'Already in the library — share recorded on the existing entry.' },
          { message_id: 'm_mid.1944.demo03', received_at: isoDaysAgo(2, 30), status: 'processed', sender_label: '@priya', extracted_url: 'https://www.instagram.com/reel/C2mR8tLp4xZ/', reel_id: 'demo-C2mR8tLp4xZ', detail: 'New reference saved (via text link).' },
          { message_id: 'm_mid.1944.demo04', received_at: isoDaysAgo(3, 55), status: 'skipped_no_reel_url', sender_label: '@tomas', extracted_url: null, reel_id: null, detail: 'No Instagram media URL in payload. Attachment types: [sticker] — Instagram only includes a URL for supported share types.' },
          { message_id: 'm_mid.1944.demo05', received_at: isoDaysAgo(4, 15), status: 'processed', sender_label: 'IGSID:17841400000000000', extracted_url: 'https://www.instagram.com/reel/DB71hLz6vBc/', reel_id: 'demo-DB71hLz6vBc', detail: 'New reference saved (via attachment:media_share). Sender username could not be resolved.' },
          { message_id: 'm_mid.1944.demo06', received_at: isoDaysAgo(6, 90), status: 'duplicate_event', sender_label: '@jules', extracted_url: 'https://www.instagram.com/reel/Cw3nFq8sYhK/', reel_id: 'demo-Cw3nFq8sYhK', detail: 'Meta redelivery of a processed message — ignored.' }
        ]
      };
    }

    function load() {
      try {
        var raw = localStorage.getItem(KEY);
        if (raw) { var s = JSON.parse(raw); if (s && s.reels) return s; }
      } catch (e) { /* fall through to seed */ }
      return seed();
    }

    function persist() {
      try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* private mode etc. */ }
    }

    function notify(reason) {
      listeners.forEach(function (fn) {
        try { fn(reason); } catch (e) {}
      });
    }

    var DEMO_USER = { id: 'demo-user', email: 'demo@ideavault.team', user_metadata: { full_name: 'Demo Member' } };

    return {
      ready: async function () {
        store = load();
        if (!store.user) store.user = DEMO_USER;
        await delay(120);
      },
      refresh: async function (reason) { await delay(90); notify(reason || 'refresh'); },
      onChange: function (fn) { listeners.push(fn); },
      categories: function () { return store.categories.slice(); },
      reels: {
        list: function (opts) {
          var ids = new Set(store.bookmarked || []);
          return applyFilters(store.reels, opts || {}, ids);
        },
        get: function (id) {
          for (var i = 0; i < store.reels.length; i++) if (store.reels[i].id === id) return store.reels[i];
          return null;
        },
        add: async function (input, user) {
          var normalized = U.normalizeInstagramUrl(input.instagram_url);
          if (!normalized) throw AppError('invalid_url', 'That does not look like an Instagram Reel or post link.');
          for (var i = 0; i < store.reels.length; i++) {
            if (store.reels[i].normalized_url === normalized) {
              throw AppError('duplicate', 'This Reel is already in the library. Duplicates are merged, not re-added.');
            }
          }
          var code = (normalized.match(/instagram\.com\/(?:reel|p|tv|share)\/([A-Za-z0-9_-]+)/) || [null, 'new' + Date.now()])[1];
          var now = new Date().toISOString();
          var row = {
            id: 'demo-' + code,
            instagram_url: String(input.instagram_url).trim(),
            normalized_url: normalized,
            media_id: null,
            title: input.title || null,
            creator_username: input.creator_username || null,
            thumbnail_url: null,
            category: input.category || 'uncategorized',
            tags: input.tags || [],
            notes: input.notes || '',
            received_at: now,
            last_shared_at: null,
            share_count: 1,
            created_at: now,
            updated_at: now,
            reel_shares: [{ id: 'sh-' + Date.now(), sender_label: userLabel(user), source: 'manual', shared_at: now }]
          };
          store.reels.unshift(row);
          store.events.unshift({
            message_id: 'manual-' + Date.now(),
            received_at: now,
            status: 'processed',
            sender_label: userLabel(user),
            extracted_url: normalized,
            reel_id: row.id,
            detail: 'Added manually through the fallback form (demo mode).'
          });
          persist();
          await delay(140);
          notify('add');
          return row.id;
        },
        update: async function (id, patch) {
          var row = null;
          for (var i = 0; i < store.reels.length; i++) if (store.reels[i].id === id) row = store.reels[i];
          if (!row) throw AppError('not_found', 'That reference no longer exists.');
          ['title', 'creator_username', 'category', 'tags', 'notes'].forEach(function (k) {
            if (k in patch) row[k] = patch[k];
          });
          row.updated_at = new Date().toISOString();
          persist();
          await delay(120);
          notify('update');
          return row;
        },
        remove: async function (id) {
          store.reels = store.reels.filter(function (r) { return r.id !== id; });
          store.bookmarked = (store.bookmarked || []).filter(function (bid) { return bid !== id; });
          persist();
          await delay(140);
          notify('remove');
        }
      },
      bookmarks: {
        ids: function () { return new Set(store.bookmarked || []); },
        has: function (id) { return (store.bookmarked || []).indexOf(id) !== -1; },
        set: async function (reelId, on) {
          store.bookmarked = store.bookmarked || [];
          var i = store.bookmarked.indexOf(reelId);
          if (on && i === -1) store.bookmarked.push(reelId);
          if (!on && i !== -1) store.bookmarked.splice(i, 1);
          persist();
          await delay(60);
          notify('bookmark');
        }
      },
      events: {
        recent: async function (limit) {
          await delay(90);
          return store.events.slice(0, limit || 50);
        }
      },
      auth: {
        session: async function () { return store.user ? { user: store.user } : null; },
        signIn: async function (email, password) {
          if (!email || !password || password.length < 4) {
            throw AppError('auth', 'Demo mode: any email and a password of 4+ characters will do.');
          }
          store.user = { id: 'demo-user', email: email, user_metadata: { full_name: email.split('@')[0] } };
          persist();
          await delay(200);
          return { user: store.user };
        },
        signOut: async function () { store.user = null; persist(); },
        onChange: function () { /* demo has no external auth events */ },
        profileName: async function () { return null; }
      }
    };
  }

  /* ==================================================================
     FACADE — the single object the UI talks to
  ================================================================== */
  var adapter = null;
  var mode = 'demo';

  async function init() {
    var hasConfig = !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
    var hasSdk = typeof window.supabase !== 'undefined' &&
                 typeof window.supabase.createClient === 'function';

    if (hasConfig && hasSdk) {
      var client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);
      adapter = createSupabaseAdapter(client);
      mode = 'supabase';
    } else {
      if (hasConfig && !hasSdk) {
        console.warn('[IdeaVault] Supabase config is present but the supabase-js CDN script ' +
                     'did not load. Running in demo mode.');
      }
      adapter = createDemoAdapter();
      mode = 'demo';
    }
    await adapter.ready();
    return mode;
  }

  window.Db = {
    init: init,
    get mode() { return mode; },

    refresh: function (reason) { return adapter.refresh(reason); },
    onChange: function (fn) { adapter.onChange(fn); },
    categories: function () { return adapter.categories(); },

    auth: {
      session: function () { return adapter.auth.session(); },
      signIn: function (email, password) { return adapter.auth.signIn(email, password); },
      signOut: function () { return adapter.auth.signOut(); },
      onChange: function (cb) { adapter.auth.onChange(cb); },
      profileName: function (user) { return adapter.auth.profileName(user); }
    },

    reels: {
      list: function (opts) { return adapter.reels.list(opts); },
      get: function (id) { return adapter.reels.get(id); },
      add: function (input, user) { return adapter.reels.add(input, user); },
      update: function (id, patch) { return adapter.reels.update(id, patch); },
      remove: function (id) { return adapter.reels.remove(id); }
    },

    bookmarks: {
      ids: function () { return adapter.bookmarks.ids(); },
      has: function (id) { return adapter.bookmarks.has(id); },
      set: function (reelId, on) { return adapter.bookmarks.set(reelId, on); }
    },

    events: {
      recent: function (limit) { return adapter.events.recent(limit); }
    }
  };
})();

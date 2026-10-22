/* =====================================================================
   IdeaVault — shared utilities
   ---------------------------------------------------------------------
   URL normalisation lives here because the SAME rules are implemented
   server-side in supabase/functions/instagram-webhook/index.ts. The
   normalised URL is the canonical identity of a Reel and is what the
   database's unique constraint uses to prevent duplicates.
   ===================================================================== */
(function () {
  'use strict';

  /* Matches Instagram media permalinks:
     /reel/<code>, /reels/<code>, /p/<code>, /tv/<code>, /share/<code> */
  var IG_MEDIA_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*instagram\.com\/(reel|reels|p|tv|share)\/([A-Za-z0-9_-]+)/i;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------------
     normalizeInstagramUrl(raw) -> canonical URL or null
     - accepts with or without scheme, www or bare host
     - strips ALL query parameters and fragments (igsh, utm_*, share
       trackers, ...) while preserving the content identifier
     - canonicalises /reels/ to /reel/
     - returns null for anything that is not an Instagram media URL
  ------------------------------------------------------------------ */
  function normalizeInstagramUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
    var m = u.pathname.match(/^\/(reel|reels|p|tv|share)\/([A-Za-z0-9_-]+)/i);
    if (!m) return null;
    var kind = m[1].toLowerCase();
    if (kind === 'reels') kind = 'reel';
    return 'https://www.instagram.com/' + kind + '/' + m[2] + '/';
  }

  /* Extract every Instagram media permalink found in a blob of text
     (e.g. a DM message body). Returns array of raw URL strings. */
  function extractInstagramUrls(text) {
    if (!text || typeof text !== 'string') return [];
    var out = [];
    var re = new RegExp(IG_MEDIA_URL_RE.source, 'gi');
    var m;
    while ((m = re.exec(text)) !== null) {
      if (out.indexOf(m[0]) === -1) out.push(m[0]);
    }
    return out;
  }

  /* The content identifier (shortcode) of a normalised URL. */
  function shortcodeOf(url) {
    var m = String(url || '').match(/instagram\.com\/(?:reel|p|tv|share)\/([A-Za-z0-9_-]+)/i);
    return m ? m[1] : '';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms || 200);
    };
  }

  /* Clipboard with a textarea fallback for older browsers / insecure
     contexts (GitHub Pages is HTTPS, so the fast path is the norm). */
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; });
    }
    return new Promise(function (resolve) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        resolve(!!ok);
      } catch (e) { resolve(false); }
    });
  }

  /* "motion graphics, type   , Colour" -> ['motion graphics','type','colour'] */
  function parseTags(input, maxTags) {
    var limit = maxTags || 12;
    var seen = {};
    var out = [];
    String(input || '')
      .split(',')
      .map(function (t) { return t.trim().replace(/^#/, ''); })
      .filter(function (t) { return t.length > 0 && t.length <= 32; })
      .forEach(function (t) {
        var key = t.toLowerCase();
        if (!seen[key] && out.length < limit) { seen[key] = true; out.push(t); }
      });
    return out;
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    if (s.length <= n) return s;
    return s.slice(0, Math.max(0, n - 1)) + '…';
  }

  /* A deterministic 1-char "plate letter" for placeholder artwork. */
  function plateLetter(str) {
    var s = String(str || '');
    var c = (s.match(/[A-Za-z]/) || ['R'])[0];
    return c.toUpperCase();
  }

  window.IVUtils = {
    escapeHtml: escapeHtml,
    normalizeInstagramUrl: normalizeInstagramUrl,
    extractInstagramUrls: extractInstagramUrls,
    shortcodeOf: shortcodeOf,
    formatDate: formatDate,
    formatTime: formatTime,
    debounce: debounce,
    copyText: copyText,
    parseTags: parseTags,
    truncate: truncate,
    plateLetter: plateLetter
  };
})();

// =====================================================================
// IdeaVault — Instagram DM ingestion webhook (Supabase Edge Function)
// ---------------------------------------------------------------------
// Deploy:   supabase functions deploy instagram-webhook --no-verify-jwt
// Secrets:  supabase secrets set \
//             INSTAGRAM_VERIFY_TOKEN=...   (any string you invent; also
//                                           typed into Meta's webhook config)
//             INSTAGRAM_APP_SECRET=...     (Meta App → Settings → App secret)
//             INSTAGRAM_ACCESS_TOKEN=...   (optional: Instagram User token
//                                           from account authorization — used
//                                           only for best-effort enrichment)
//             INSTAGRAM_API_VERSION=v21.0  (optional override)
//
// Endpoints:
//   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…
//        → Meta webhook verification handshake (echoes the challenge)
//   POST (X-Hub-Signature-256) → signed event delivery
//
// Processing contract (per incoming Instagram messaging event):
//   1. Verify the HMAC-SHA256 signature of the raw body with the app
//      secret (timing-safe compare).
//   2. Claim the event in public.webhook_events keyed by Meta's message
//      ID — redeliveries of an already-finalised event are no-ops.
//   3. Extract Reel URLs from the structured attachments
//      (type share / media_share / ig_reel / reel, payload.url) and,
//      failing that, from the message text.
//      If Instagram provides no resolvable URL (e.g. sticker shares,
//      disappearing media, or a bare media id) the event is recorded
//      with status skipped_no_reel_url — never a fabricated URL.
//   4. Normalise the URL (strip tracking params, keep the shortcode)
//      and dedupe against reels.normalized_url. Duplicates record an
//      extra reel_shares row on the existing reference instead of a
//      second library entry.
//   5. Insert new references, then return 200 promptly. A database
//      failure returns 500 so Meta retries; the ledger + unique
//      constraints make retries safe.
//   6. Slow enrichment (sender username lookup, oEmbed title) runs
//      AFTER the acknowledgement via EdgeRuntime.waitUntil when the
//      runtime supports it, so the webhook is never slow-acked.
//
// Reference: Meta "Webhooks for Instagram Messaging" — attachments of
// type "share, story_mention, ig_reel or reel" carry payload.url; only
// the URL of the shared media is included in the notification.
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------
// Environment / secrets
// ---------------------------------------------------------------------
const ENV = {
  verifyToken: Deno.env.get('INSTAGRAM_VERIFY_TOKEN') ?? '',
  appSecret: Deno.env.get('INSTAGRAM_APP_SECRET') ?? '',
  accessToken: Deno.env.get('INSTAGRAM_ACCESS_TOKEN') ?? '',
  apiVersion: Deno.env.get('INSTAGRAM_API_VERSION') ?? 'v21.0',
};

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
// into every Edge Function by the platform. The service-role key NEVER
// appears in the frontend.
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

const JSON_HEADERS = { 'content-type': 'application/json' };

// Statuses that mean "this event is fully handled" — a redelivery with
// one of these is skipped without side effects.
const FINAL_STATUSES = new Set([
  'processed', 'duplicate_reel', 'duplicate_event',
  'skipped_no_reel_url', 'skipped_invalid_url', 'skipped_not_message'
]);

interface ReelCandidate {
  raw: string;          // URL exactly as Instagram delivered it
  normalized: string;   // canonical identity (dedupe key)
  via: string;          // how it was found, for the ingest log
  mediaId: string | null;
}

interface EnrichmentJob {
  reelId: string;
  reelUrl: string;
  senderId: string | null;
}

// ---------------------------------------------------------------------
// Logging — informative, never secret-bearing
// ---------------------------------------------------------------------
function log(...args: unknown[]) {
  console.log('[ideavault-webhook]', ...args);
}

// ---------------------------------------------------------------------
// URL helpers (mirror of utils.js in the frontend — keep in sync)
// ---------------------------------------------------------------------
const IG_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*instagram\.com\/(?:reel|reels|p|tv|share)\/([A-Za-z0-9_-]+)/i;

function normalizeInstagramUrl(raw: string): string | null {
  try {
    let s = raw.trim();
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    const u = new URL(s);
    if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(reel|reels|p|tv|share)\/([A-Za-z0-9_-]+)/i);
    if (!m) return null;
    let kind = m[1].toLowerCase();
    if (kind === 'reels') kind = 'reel';
    return `https://www.instagram.com/${kind}/${m[2]}/`;
  } catch {
    return null;
  }
}

/** Find every Instagram media permalink in a message, structured first. */
function collectReelCandidates(message: any): {
  candidates: ReelCandidate[];
  attachmentTypes: string[];
  mediaIdOnly: boolean;
} {
  const found = new Map<string, ReelCandidate>();
  const attachmentTypes: string[] = [];

  const attachments: any[] = Array.isArray(message?.attachments)
    ? message.attachments
    : message?.attachment
      ? [message.attachment]
      : [];

  for (const att of attachments) {
    const type = String(att?.type ?? 'unknown');
    attachmentTypes.push(type);
    const url = att?.payload?.url;
    if (typeof url === 'string' && IG_URL_RE.test(url)) {
      const normalized = normalizeInstagramUrl(url);
      if (normalized) {
        found.set(normalized, {
          raw: url,
          normalized,
          via: `attachment:${type}`,
          mediaId: typeof att?.payload?.id === 'string' ? att.payload.id : null,
        });
      }
    }
  }

  // Fall back to links pasted into the DM text.
  if (typeof message?.text === 'string') {
    const re = new RegExp(IG_URL_RE.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(message.text)) !== null) {
      const normalized = normalizeInstagramUrl(m[0]);
      if (normalized && !found.has(normalized)) {
        found.set(normalized, { raw: m[0], normalized, via: 'text', mediaId: null });
      }
    }
  }

  // An attachment that carries only a media id (no URL) — recorded so
  // the limitation is visible, and never turned into a fake permalink.
  const mediaIdOnly = attachments.some(
    (att) => !att?.payload?.url && !!att?.payload?.id
  );

  return { candidates: [...found.values()], attachmentTypes, mediaIdOnly };
}

// ---------------------------------------------------------------------
// Signature verification (X-Hub-Signature-256)
// ---------------------------------------------------------------------
async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = await hmacSha256Hex(ENV.appSecret, rawBody);
  return timingSafeEqual(header.slice(7), expected);
}

// ---------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === 'GET') return handleVerification(url);
  if (req.method === 'POST') return handleEventDelivery(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { allow: 'GET, POST, OPTIONS' },
    });
  }
  return json({ error: 'method_not_allowed' }, 405);
});

// --- Meta webhook verification handshake ------------------------------
function handleVerification(url: URL): Response {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge') ?? '';

  if (mode === 'subscribe' && ENV.verifyToken !== '' && token === ENV.verifyToken) {
    log('webhook verified — subscription confirmed');
    // Meta expects the challenge echoed back, plain text.
    return new Response(challenge, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }
  log('webhook verification rejected (mode or token mismatch)');
  return new Response('Forbidden', { status: 403 });
}

// --- Event delivery ----------------------------------------------------
async function handleEventDelivery(req: Request): Promise<Response> {
  const raw = await req.text();

  // 1) Signature check (when the app secret is configured — always
  //    configure it in production; unsigned acceptance is dev-only).
  if (ENV.appSecret) {
    const ok = await verifySignature(raw, req.headers.get('x-hub-signature-256'));
    if (!ok) {
      log('rejected: X-Hub-Signature-256 mismatch');
      return json({ error: 'invalid_signature' }, 401);
    }
  } else {
    log('WARNING: INSTAGRAM_APP_SECRET not set — accepting unsigned payload (dev only)');
  }

  // 2) Parse
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    log('rejected: body is not valid JSON');
    return json({ error: 'invalid_json' }, 400);
  }

  // 3) Process the critical path BEFORE acknowledging. These are a few
  //    fast database round-trips (same region as the database). A
  //    failure returns 500 so Meta retries the delivery — that is the
  //    reliability mechanism; idempotency makes the retry a no-op.
  let failure: unknown = null;
  try {
    await processPayload(body);
  } catch (err) {
    failure = err;
    log('processing error (Meta will retry):', (err as Error)?.message ?? err);
  }

  if (failure) return json({ error: 'processing_failed' }, 500);
  return new Response('EVENT_RECEIVED', { status: 200 });
}

// ---------------------------------------------------------------------
// Payload processing
// ---------------------------------------------------------------------
async function processPayload(body: any): Promise<void> {
  if (body?.object !== 'instagram') {
    log('ignored delivery for object:', body?.object);
    return;
  }
  for (const entry of body.entry ?? []) {
    for (const evt of entry?.messaging ?? []) {
      try {
        await processMessagingEvent(entry, evt);
      } catch (err) {
        // Surface the first failure; already-processed events in this
        // delivery stay safe thanks to the ledger.
        log('event failed:', (err as Error)?.message ?? err);
        throw err;
      }
    }
  }
}

async function processMessagingEvent(entry: any, evt: any): Promise<void> {
  const message = evt?.message;

  // Only inbound human messages matter. Echoes (our own account
  // replying), deletions, reactions, read receipts, postbacks and
  // standbys are not Reel shares.
  if (!message || message.is_echo || message.is_deleted || message.is_unsupported) {
    return; // not a message worth recording
  }

  const messageId: string = message.mid ?? `${entry?.id ?? 'ig'}-${evt?.timestamp ?? Date.now()}`;
  const senderId: string | null = evt?.sender?.id ?? null;
  const senderLabel: string = senderId ? `IGSID:${senderId}` : 'unknown';
  const receivedAt: string | null = evt?.timestamp
    ? new Date(evt.timestamp).toISOString()
    : null;

  // --- idempotency ledger claim -------------------------------------
  const claimRow = {
    message_id: messageId,
    status: 'received',
    sender_label: senderLabel,
    received_at: receivedAt ?? undefined,
    payload: { entry_id: entry?.id, messaging: evt },
  };
  const { data: claimed, error: claimError } = await supabase
    .from('webhook_events')
    .upsert(claimRow, { onConflict: 'message_id', ignoreDuplicates: true })
    .select('message_id');

  if (claimError) throw claimError;

  if (!claimed || claimed.length === 0) {
    // Row already existed — a redelivery. Skip only if it is final.
    const { data: existing, error: fetchErr } = await supabase
      .from('webhook_events')
      .select('status')
      .eq('message_id', messageId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (existing && FINAL_STATUSES.has(existing.status)) {
      log(`redelivery of ${messageId} — already ${existing.status}, ignored`);
      return;
    }
    log(`resuming ${messageId} — previous attempt left status '${existing?.status}'`);
  }

  // --- URL extraction ------------------------------------------------
  const { candidates, attachmentTypes, mediaIdOnly } = collectReelCandidates(message);

  if (candidates.length === 0) {
    const detail = mediaIdOnly
      ? 'Attachment carried a media id but no URL — the original permalink cannot be recovered through the messaging webhook, and no URL was fabricated.'
      : `No Instagram media URL in payload. Attachment types: [${attachmentTypes.join(', ') || 'none'}]. Instagram only includes a URL for supported share types (share / media_share / ig_reel / reel); stickers, gifs and disappearing media are not delivered with links.`;
    await updateEvent(messageId, { status: 'skipped_no_reel_url', detail });
    log(`skipped ${messageId}: no reel URL`, detail);
    return;
  }

  // --- store / dedupe each URL ---------------------------------------
  const enrichmentJobs: EnrichmentJob[] = [];
  let finalStatus = 'processed';
  let firstReelId: string | null = null;
  let firstUrl = '';

  for (const cand of candidates) {
    if (!cand.normalized) {
      await updateEvent(messageId, {
        status: 'skipped_invalid_url',
        detail: `Could not normalise "${cand.raw}" — discarded.`,
      });
      finalStatus = finalStatus === 'processed' ? 'skipped_invalid_url' : finalStatus;
      continue;
    }

    const { data: existing, error: findErr } = await supabase
      .from('reels')
      .select('id')
      .eq('normalized_url', cand.normalized)
      .maybeSingle();
    if (findErr) throw findErr;

    if (existing) {
      // Duplicate: record that this teammate shared it too, never a
      // second library entry.
      const { error: shareErr } = await supabase
        .from('reel_shares')
        .upsert(
          {
            reel_id: existing.id,
            sender_label: senderLabel,
            sender_ig_id: senderId,
            source: 'instagram_dm',
            shared_at: receivedAt ?? undefined,
          },
          { onConflict: 'reel_id,sender_label', ignoreDuplicates: true }
        );
      if (shareErr) throw shareErr;

      finalStatus = 'duplicate_reel';
      firstReelId = firstReelId ?? existing.id;
      firstUrl = firstUrl || cand.raw;
      log(`duplicate reel ${cand.normalized} — share attributed to ${senderLabel}`);
      continue;
    }

    const insertRow: Record<string, unknown> = {
      instagram_url: cand.raw,           // original, exactly as delivered
      normalized_url: cand.normalized,   // canonical identity
      category: 'uncategorized',
      received_at: receivedAt ?? undefined,
    };
    if (cand.mediaId) insertRow.media_id = cand.mediaId;
    if (typeof message?.text === 'string' && message.text.trim() && !candidates.some((c) => c.via === 'text' && c.raw === message.text.trim())) {
      // Keep the sender's caption if it was sent alongside the share —
      // useful context, stored as the initial note.
      const note = message.text.trim().slice(0, 500);
      if (note) insertRow.notes = `From DM: ${note}`;
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('reels')
      .insert(insertRow)
      .select('id')
      .single();
    if (insertErr) {
      // Lost a race with a concurrent delivery of the same reel?
      if (/duplicate key|unique constraint/i.test(insertErr.message ?? '')) {
        finalStatus = 'duplicate_reel';
        continue;
      }
      throw insertErr;
    }

    const { error: shareErr } = await supabase
      .from('reel_shares')
      .insert({
        reel_id: inserted.id,
        sender_label: senderLabel,
        sender_ig_id: senderId,
        source: 'instagram_dm',
        shared_at: receivedAt ?? undefined,
      });
    if (shareErr) log('share log failed (reference is saved):', shareErr.message);

    firstReelId = firstReelId ?? inserted.id;
    firstUrl = firstUrl || cand.raw;
    enrichmentJobs.push({ reelId: inserted.id, reelUrl: cand.raw, senderId });
    log(`saved new reference ${cand.normalized} (via ${cand.via})`);
  }

  await updateEvent(messageId, {
    status: finalStatus,
    extracted_url: firstUrl || null,
    reel_id: firstReelId,
    detail:
      finalStatus === 'duplicate_reel'
        ? 'Already in the library — this share was attributed to the existing entry.'
        : finalStatus === 'processed'
        ? `New reference saved (${enrichmentJobs.length} URL${enrichmentJobs.length === 1 ? '' : 's'}).`
        : null,
  });

  // --- enrichment AFTER acknowledging (best-effort, time-boxed) ------
  if (enrichmentJobs.length > 0 && ENV.accessToken) {
    const task = runEnrichment(enrichmentJobs);
    const runtime = (globalThis as any).EdgeRuntime;
    if (runtime && typeof runtime.waitUntil === 'function') {
      runtime.waitUntil(task); // acknowledge fast, enrich in background
    } else {
      await task; // rare fallback: inline but strictly time-boxed
    }
  }
}

async function updateEvent(
  messageId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from('webhook_events')
    .update(patch)
    .eq('message_id', messageId);
  if (error) log('ledger update failed:', error.message);
}

// ---------------------------------------------------------------------
// Enrichment — best-effort only, never blocking, never fabricated
// ---------------------------------------------------------------------
async function runEnrichment(jobs: EnrichmentJob[]): Promise<void> {
  for (const job of jobs) {
    // (a) Resolve the sender's @username (replaces the raw IGSID label
    //     when the API allows it). Failure keeps the IGSID label.
    if (job.senderId) {
      try {
        const res = await fetch(
          `https://graph.facebook.com/${ENV.apiVersion}/${encodeURIComponent(job.senderId)}` +
          `?fields=username&access_token=${encodeURIComponent(ENV.accessToken)}`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data?.username) {
            const label = `@${data.username}`;
            const { error } = await supabase
              .from('reel_shares')
              .update({ sender_label: label })
              .eq('reel_id', job.reelId)
              .eq('sender_label', `IGSID:${job.senderId}`);
            log(
              error ? 'sender label update failed' : `sender resolved to ${label}`
            );
          }
        } else {
          log(`sender lookup unavailable (HTTP ${res.status}) — keeping IGSID label`);
        }
      } catch (e) {
        log('sender lookup error:', (e as Error)?.message);
      }
    }

    // (b) oEmbed title. NOTE: Meta removed thumbnail_url and author_name
    //     from the Instagram oEmbed endpoint (see the oEmbed Updates
    //     blog post, April 2025) — so this can only ever supply a title,
    //     and only when the oembed_read permission has been granted.
    //     Requires INSTAGRAM_ACCESS_TOKEN; skipped silently otherwise.
    try {
      const res = await fetch(
        `https://graph.facebook.com/${ENV.apiVersion}/instagram_oembed` +
        `?url=${encodeURIComponent(job.reelUrl)}&fields=title` +
        `&access_token=${encodeURIComponent(ENV.accessToken)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.title) {
          await supabase.from('reels').update({ title: data.title }).eq('id', job.reelId).is('title', null);
          log('oEmbed title stored');
        }
      } else if (res.status === 403 || res.status === 400) {
        log('oEmbed unavailable — oembed_read permission likely not granted; continuing without it');
      } else {
        log(`oEmbed failed (HTTP ${res.status})`);
      }
    } catch (e) {
      log('oEmbed error:', (e as Error)?.message);
    }
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

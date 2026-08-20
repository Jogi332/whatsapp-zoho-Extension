// Creates a Zoho CRM Lead for a WhatsApp contact that doesn't have one yet.
//
// Triggered from liveChatWebhook when an inbound packet arrives. NOTE the
// trigger is USER_MESSAGE, not START_CHAT, despite START_CHAT being the
// original plan: in practice START_CHAT rarely fires (it needs the bot flow to
// hit a Transfer to Agent node), and when it does fire on the web channel its
// userId is a session UUID rather than a phone number. USER_MESSAGE fires on
// every inbound WhatsApp message and carries the real phone number, so it is
// both more reliable and the only one with usable data.
//
// Because it runs on every message, it must be cheap and idempotent: it
// searches for an existing Lead first and only creates one when there is no
// match. That also makes it self-healing - if a create fails, the contact's
// next message retries it.
//
// *** LEGACY-PATH-ONLY as of the Deluge correction below - see index.js's
// comment at its ensureLeadForPhone() call site for the full story. Kept
// working exactly as-is for existing per-customer dedicated-project
// deployments; NOT used by new, shared-backend/extension installs anymore. ***
//
// CORRECTED ARCHITECTURE (confirmed by Zoho Marketplace support, Aug 2026 -
// see "Zoho CRM Extension Development - US DC Requirement & Connections
// Support Query" email thread): Sigma/CRM extensions don't support
// "Connections" for third-party auth, and per-org Self Client OAuth (what
// this whole file does) is exactly the manual-per-customer burden the
// Marketplace migration set out to remove. Zoho's confirmed alternative for
// unattended, per-org CRM writes is a REST-API-triggered Deluge Function
// bundled in the extension, which gets implicit, tokenless CRM access - see
// deluge/leadSync.dg (new, in this repo). New/shared-backend installs do
// their Lead/Task/Signal writes there instead of through this file.
//
// CREDENTIALS (legacy path only): every function here takes an `orgConfig`
// argument (the resolved OrgConfig row from orgConfig.js, or null - always
// null on this path, since legacy deployments have no OrgConfig table at
// all). Credentials fall back to process.env exactly as before this
// migration - this keeps every existing customer's deployment working
// unmodified.
//
//   ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN
//   ZOHO_ACCOUNTS_HOST (default accounts.zoho.in) / ZOHO_API_HOST (default www.zohoapis.in)
//
// The orgConfig.zoho_* fields this file's functions also accept are now
// dead weight for the shared-backend path (nothing populates them anymore -
// see the Deluge redirect above) but harmless to leave wired, in case a
// future case turns up where an external-backend CRM write is still needed
// per org despite Deluge covering the Engati case.
//
// The hosts matter regardless of which path is used: a customer on the US/EU
// data centre uses .com / .eu, and calling the wrong one fails authentication
// in a confusing way.

const https = require('https');

function requestJson(options, body) {
  return new Promise(function (resolve) {
    const req = https.request(options, function (res) {
      let chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (e) { parsed = null; }
        resolve({ statusCode: res.statusCode, body: chunks, json: parsed });
      });
    });
    req.on('error', function (err) {
      resolve({ statusCode: 599, body: String((err && err.message) || err), json: null });
    });
    if (body) { req.write(body); }
    req.end();
  });
}

// Access tokens last an hour. Cached PER TENANT (keyed by client id, which is
// unique per org whether it came from OrgConfig or process.env) across warm
// invocations, so we're not burning a token refresh on every single inbound
// message. A single shared module-level token (the pre-migration design)
// would leak org A's CRM access token into org B's request on this shared
// backend - this map is what keeps tenants isolated.
const tokenCache = new Map(); // clientId -> { token, expiresAt }

function accountsHost(orgConfig) {
  return (orgConfig && orgConfig.zoho_accounts_host) || process.env.ZOHO_ACCOUNTS_HOST || 'accounts.zoho.in';
}
function apiHost(orgConfig) {
  return (orgConfig && orgConfig.zoho_api_host) || process.env.ZOHO_API_HOST || 'www.zohoapis.in';
}

async function getAccessToken(orgConfig) {
  const clientId = (orgConfig && orgConfig.zoho_client_id) || process.env.ZOHO_CLIENT_ID;
  const clientSecret = (orgConfig && orgConfig.zoho_client_secret) || process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = (orgConfig && orgConfig.zoho_refresh_token) || process.env.ZOHO_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Zoho CRM credentials not configured for this tenant (client id / secret / refresh token)');
  }

  const now = Date.now();
  const cached = tokenCache.get(clientId);
  // Refresh a minute early rather than racing the expiry.
  if (cached && now < cached.expiresAt - 60000) { return cached.token; }

  const form = 'grant_type=refresh_token'
    + '&client_id=' + encodeURIComponent(clientId)
    + '&client_secret=' + encodeURIComponent(clientSecret)
    + '&refresh_token=' + encodeURIComponent(refreshToken);

  const res = await requestJson({
    hostname: accountsHost(orgConfig),
    path: '/oauth/v2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form)
    }
  }, form);

  const token = res.json && res.json.access_token;
  if (!token) {
    throw new Error('Token refresh failed (' + res.statusCode + '): ' + String(res.body).slice(0, 300));
  }
  const expiresInSec = (res.json && res.json.expires_in) || 3600;
  tokenCache.set(clientId, { token: token, expiresAt: Date.now() + expiresInSec * 1000 });
  return token;
}

// Leads in this system are only ever created by upsertLead() below, from an
// Engati userId - which is always the full international number - and always
// written as '+' + digits. So that is the only format a Lead's Phone can hold,
// and it is the first thing we look for.
//
// The plain-digits form is kept purely as a cheap safety net for a number
// somebody hand-edited in CRM after the fact.
//
// Deliberately NOT searched: national-format renderings (bare "561145456",
// "0561145456", "+971 561145456"). An earlier version built those by stripping
// a country code, which was both buggy - it did digits.slice(-10), hardcoding
// India's 10-digit national number, so UAE's 971561145456 split into country
// code "97" and national "1561145456" - and unnecessary, since no Lead here is
// ever stored that way. Worse, Zoho's phone search is not strictly exact, so
// searching a bare national number can match a DIFFERENT country's Lead ending
// in the same digits and silently attach this conversation to the wrong person.
// Restore them only if a customer starts creating Leads by hand or by import,
// and split on an explicitly configured country code, never on length.
function phoneVariants(digits) {
  return ['+' + digits, digits];
}

async function findLeadByPhone(orgConfig, token, digits) {
  for (const variant of phoneVariants(digits)) {
    const res = await requestJson({
      hostname: apiHost(orgConfig),
      path: '/crm/v2/Leads/search?phone=' + encodeURIComponent(variant),
      method: 'GET',
      headers: { 'Authorization': 'Zoho-oauthtoken ' + token }
    });
    // 204 = no match, which is a normal answer here, not an error.
    if (res.statusCode === 200 && res.json && Array.isArray(res.json.data) && res.json.data.length) {
      return res.json.data[0];
    }
  }
  return null;
}

// Fallback name Leads are created with when no real name is known yet -
// shared between upsertLead's write and ensureLeadForPhone's check for
// whether a Lead still needs its name backfilled.
function fallbackName(digits) { return 'WhatsApp ' + digits; }

// Patches just Last_Name on an existing Lead. Used to repair a Lead that was
// created before a real name was known (e.g. from USER_MESSAGE, which never
// carries a name) once a later START_CHAT supplies one. Best-effort - a
// failure here shouldn't take down the caller, the Lead already exists and
// works fine, it would just keep its placeholder name.
async function updateLeadName(orgConfig, token, id, displayName) {
  const payload = JSON.stringify({ data: [{ id: id, Last_Name: displayName }] });
  const res = await requestJson({
    hostname: apiHost(orgConfig),
    path: '/crm/v2/Leads',
    method: 'PUT',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
  const record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  return !!(record && record.code === 'SUCCESS');
}

// Zoho CRM's REST API rejects Date.prototype.toISOString()'s output
// ("...761Z") for a "datetime" field with INVALID_DATA - confirmed via a
// real failing call (Aug 11 2026): {"code":"INVALID_DATA","details":
// {"expected_data_type":"datetime","api_name":"Last_WhatsApp_Message"}}.
// It wants an explicit numeric UTC offset instead of the "Z" designator,
// and no milliseconds. This was silently swallowed by the same
// catch-and-log pattern every other CRM write failure here uses, so
// WhatsApp_Unread/Last_WhatsApp_Message were never actually being set in
// Production despite every other part of the pipeline working - caught by
// checking DevOps > Logs after a real end-to-end test, not by inspection.
function zohoDateTime(date) {
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) +
    'T' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds()) + '+00:00';
}

function zohoDate(date) {
  const pad = function (n) { return n < 10 ? '0' + n : String(n); };
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
}

// Used only if a Lead's Owner is ever unexpectedly blank when creating the
// reply Task below. Owner is a mandatory Zoho CRM field, so this is
// defensive insurance rather than an expected path.
//
// NOTE (multi-tenancy): this id is specific to ONE customer's org - it must
// not be relied on for any other tenant. On the shared backend this should
// really come from orgConfig (e.g. orgConfig.fallback_task_owner_id) rather
// than being a shared constant; kept as a legacy-path-only fallback until
// that column exists. See whatsapp-unread-notification-system memory for how
// to look up the right id for a given org.
const LEGACY_FALLBACK_TASK_OWNER_ID = '1371289000000545001';

// Creates the "reply to this WhatsApp message" Task directly via the CRM
// REST API, called synchronously right after markUnread below.
//
// This used to be a Zoho Workflow Rule (Create/Edit trigger, condition
// WhatsApp_Unread=true) calling a Deluge Function. That worked, but a real
// end-to-end test (Aug 11 2026) measured ~2 minutes from message-received to
// Task-created - Zoho's own Workflow Rule -> Function execution queue isn't
// fast enough to call "real-time", and the delay isn't something this
// codebase can control from outside Zoho's automation engine. Doing the
// exact same create-Task-for-current-Owner logic here instead, in the same
// Catalyst invocation that already updates the Lead, removes that queue
// entirely - the only latency left is the two direct HTTPS calls below.
async function createReplyTask(orgConfig, token, leadId) {
  const res = await requestJson({
    hostname: apiHost(orgConfig),
    path: '/crm/v2/Leads/' + leadId + '?fields=First_Name,Last_Name,Owner',
    method: 'GET',
    headers: { 'Authorization': 'Zoho-oauthtoken ' + token }
  });
  const record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  // Last_Name alone reads oddly for contacts whose name got split unevenly
  // between First_Name/Last_Name (e.g. a WhatsApp profile name landing
  // entirely in Last_Name via updateLeadName's backfill) - use both when
  // available, same as how Zoho's own "Lead Name" display combines them.
  const leadName = ((record && ((record.First_Name ? record.First_Name + ' ' : '') + (record.Last_Name || ''))) || '').trim() || 'WhatsApp Lead';
  const ownerId = (record && record.Owner && record.Owner.id) ||
    (orgConfig && orgConfig.fallback_task_owner_id) || LEGACY_FALLBACK_TASK_OWNER_ID;

  const payload = JSON.stringify({
    data: [{
      Subject: 'Reply to WhatsApp message - ' + leadName,
      Status: 'Not Started',
      Priority: 'High',
      Due_Date: zohoDate(new Date()),
      Owner: ownerId,
      What_Id: leadId,
      $se_module: 'Leads'
    }]
  });
  const createRes = await requestJson({
    hostname: apiHost(orgConfig),
    path: '/crm/v2/Tasks',
    method: 'POST',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
  const created = createRes.json && Array.isArray(createRes.json.data) && createRes.json.data[0];
  if (!(created && created.code === 'SUCCESS')) {
    console.error('[crmLeads] createReplyTask failed for Lead ' + leadId + ': ' + String(createRes.body).slice(0, 300));
  }

  await notifySignal(orgConfig, token, leadId, leadName);
}

// Must match a Signal created by hand in Setup > Experience Center >
// Signals, with "Trigger Signal via: API" - Zoho auto-generates this from
// the Label/Service entered there, this isn't something this code can
// create itself, and it is per-org (each customer's Zoho org needs its own).
// See zoho-signals-research memory note for the full setup and the OAuth
// scope history (needs ZohoCRM.signals.ALL on top of the Leads/Tasks scopes
// createReplyTask above needs).
//
// NOTE (multi-tenancy): the namespace below is specific to the legacy,
// single-customer setup. On the shared backend this should come from
// orgConfig (e.g. orgConfig.signal_namespace) once each installing org has
// set up their own Signal - falls back to the legacy constant so existing
// deployments keep working unmodified.
const LEGACY_SIGNAL_NAMESPACE = 'whatsyoo_newwhatsappmessage';

// Fires a Zoho Signal (the bell-icon notification) so an agent sees this
// even in a CRM tab that's already open - createReplyTask() above is fast
// (same-second) but a tab that's already open has no way to know a Task
// was created elsewhere; that's a genuine Zoho web-app limitation, not
// something this codebase can influence. Signals is Zoho's own answer to
// that specific gap. Never throws - a Signals failure (e.g. missing scope,
// or the Signal not yet existing in a customer's org) must not break Lead
// sync or Task creation, which both already succeeded by this point.
async function notifySignal(orgConfig, token, leadId, leadName) {
  const namespace = (orgConfig && orgConfig.signal_namespace) || LEGACY_SIGNAL_NAMESPACE;
  // Confirmed by a real failing call (Aug 12 2026): a flat payload gets
  // {"code":"MANDATORY_NOT_FOUND","details":{"api_name":"signals"}} -
  // same "wrap in a named array" convention Zoho uses for /Leads and
  // /Tasks ("data": [...]), just with "signals" as the key here instead.
  const payload = JSON.stringify({
    signals: [{
      signal_namespace: namespace,
      subject: 'New WhatsApp message',
      message: leadName + ' sent a new WhatsApp message.',
      id: leadId
    }]
  });
  const res = await requestJson({
    hostname: apiHost(orgConfig),
    path: '/crm/v2/signals/notifications',
    method: 'POST',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    console.error('[crmLeads] notifySignal failed for Lead ' + leadId + ': ' + res.statusCode + ' ' + String(res.body).slice(0, 300));
  }
}

// Sets the two fields that let agents see "new message" from the Leads
// LIST VIEW, without opening every record - see multi-tenant-customer-
// expansion / composer-ui-additions memory notes for why this exists.
// WhatsApp_Unread and Last_WhatsApp_Message are both custom fields that
// must be created on the Leads module before this does anything useful
// (see SETUP.md) - a missing-field error here is swallowed the same way
// every other CRM write failure in this file is, so a customer who
// hasn't set these fields up yet doesn't lose inbound message
// processing over it.
//
// Cleared client-side instead of here - see app.js's PageLoad handler,
// which clears it the moment an agent actually opens the record's
// WhatsApp panel. That's the real "read" signal, not "an agent sent a
// reply" (an agent might open a conversation just to check it).
//
// Also fires createReplyTask() - see its own comment for why that lives
// here now instead of in a Zoho Workflow Rule.
async function markUnread(orgConfig, token, id) {
  const payload = JSON.stringify({ data: [{ id: id, WhatsApp_Unread: true, Last_WhatsApp_Message: zohoDateTime(new Date()) }] });
  const res = await requestJson({
    hostname: apiHost(orgConfig),
    path: '/crm/v2/Leads',
    method: 'PUT',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
  const record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  if (!(record && record.code === 'SUCCESS')) {
    console.error('[crmLeads] markUnread failed for Lead ' + id + ': ' + String(res.body).slice(0, 300));
  }
  await createReplyTask(orgConfig, token, id);
}

async function getLeadName(orgConfig, token, id) {
  const res = await requestJson({
    hostname: apiHost(orgConfig),
    path: '/crm/v2/Leads/' + id + '?fields=Last_Name',
    method: 'GET',
    headers: { 'Authorization': 'Zoho-oauthtoken ' + token }
  });
  const record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  return record ? record.Last_Name : null;
}

// Given a Lead id we already know about (from either cache layer), check and
// backfill its name if it still has the placeholder. One extra GET (plus a
// PUT if it needs fixing) - acceptable because this path only runs when
// displayName is present, which only happens on START_CHAT, an infrequent
// event compared to USER_MESSAGE.
async function backfillIfNeeded(orgConfig, token, id, digits, displayName) {
  const currentName = await getLeadName(orgConfig, token, id);
  if (currentName !== fallbackName(digits)) {
    return 'existing Lead ' + id + ' (name already set)';
  }
  const renamed = await updateLeadName(orgConfig, token, id, displayName);
  return 'existing Lead ' + id + ' (name ' + (renamed ? 'backfilled' : 'backfill FAILED') + ')';
}

// Uses upsert rather than plain create, and this matters: Zoho's /search
// endpoint reads a search index that lags behind writes by a few seconds, so a
// Lead created moments ago is not yet findable. Testing showed two messages in
// quick succession producing two duplicate Leads for the same number.
//
// /upsert with duplicate_check_fields does the find-or-create atomically on
// Zoho's side against live data, which closes that race entirely.
async function upsertLead(orgConfig, token, digits, displayName) {
  // Last_Name is mandatory on Zoho Leads. WhatsApp gives us a profile name at
  // best, often nothing, so fall back to something identifiable rather than
  // failing the write.
  const payload = JSON.stringify({
    data: [{
      Last_Name: displayName || fallbackName(digits),
      Phone: '+' + digits,
      Lead_Source: 'WhatsApp',
      // /upsert handles both the brand-new-Lead case AND the case where
      // duplicate_check_fields matches an existing record - either way,
      // this message just arrived, so both cases get the same "unread,
      // just now" state in one write. No separate markUnread() call
      // needed for this path.
      WhatsApp_Unread: true,
      Last_WhatsApp_Message: zohoDateTime(new Date())
    }],
    duplicate_check_fields: ['Phone'],
    trigger: []
  });

  const res = await requestJson({
    hostname: apiHost(orgConfig),
    path: '/crm/v2/Leads/upsert',
    method: 'POST',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  const record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  if (record && record.code === 'SUCCESS') {
    const id = record.details && record.details.id;
    // Zoho reports which branch it took, so the log can distinguish a genuinely
    // new contact from a repeat message by an existing one.
    return { id: id, action: record.action || 'unknown' };
  }
  throw new Error('Lead upsert failed (' + res.statusCode + '): ' + String(res.body).slice(0, 300));
}

// Zoho's /search endpoint reads an index that lags writes by a long time -
// measured at over 20 seconds against this org, and it may be minutes. That
// makes it useless on its own for "did I just create this?", and testing
// confirmed a contact sending three quick messages got three duplicate Leads.
// /upsert with duplicate_check_fields doesn't help either: it only dedupes on
// fields marked unique in the CRM, and Phone isn't by default.
//
// So recently-created numbers are remembered directly. Two layers, because
// neither alone is sufficient:
//   1. an in-process Map - instant, but only covers a warm container
//   2. Catalyst Cache - survives across containers and cold starts
// Once the search index catches up (well within the cache TTL) the search path
// takes over, so nothing depends on the cache persisting.
//
// Cache keys are prefixed with the org id (multi-tenancy: on the shared
// backend two different customers could otherwise have overlapping phone
// digits collide in the same process-wide Map/Cache segment). Legacy
// dedicated-project deployments have no orgConfig, so their prefix is just
// "legacy" - harmless, since that deployment only ever serves one org anyway.
const recentlyCreated = new Map();
const RECENT_TTL_MS = 60 * 60 * 1000;
const CACHE_TTL_HOURS = 6;

function tenantPrefix(orgConfig) {
  return (orgConfig && orgConfig.org_id) || 'legacy';
}

function rememberLocally(orgConfig, digits, leadId) {
  const key = tenantPrefix(orgConfig) + ':' + digits;
  recentlyCreated.set(key, { leadId: leadId, at: Date.now() });
  // Cheap sweep so a long-lived container doesn't grow this forever.
  if (recentlyCreated.size > 500) {
    const cutoff = Date.now() - RECENT_TTL_MS;
    for (const [k, v] of recentlyCreated) {
      if (v.at < cutoff) recentlyCreated.delete(k);
    }
  }
}

function recallLocally(orgConfig, digits) {
  const key = tenantPrefix(orgConfig) + ':' + digits;
  const hit = recentlyCreated.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RECENT_TTL_MS) { recentlyCreated.delete(key); return null; }
  return hit.leadId;
}

function cacheKeyFor(orgConfig, digits) { return 'lead_' + tenantPrefix(orgConfig) + '_' + digits; }

async function recallFromCache(catalystApp, orgConfig, digits) {
  if (!catalystApp) return null;
  try {
    const segment = catalystApp.cache().segment();
    const item = await segment.getValue(cacheKeyFor(orgConfig, digits));
    return item || null;
  } catch (e) {
    // Cache being unavailable must not stop us - worst case we fall through to
    // search and possibly create a duplicate, which is better than erroring.
    console.error('[crmLeads] cache read failed: ' + (e && e.message));
    return null;
  }
}

async function rememberInCache(catalystApp, orgConfig, digits, leadId) {
  if (!catalystApp) return;
  try {
    const segment = catalystApp.cache().segment();
    await segment.put(cacheKeyFor(orgConfig, digits), String(leadId), CACHE_TTL_HOURS);
  } catch (e) {
    console.error('[crmLeads] cache write failed: ' + (e && e.message));
  }
}

// Returns a short string describing what happened, for the caller to log.
// Never throws - a CRM problem must not break the webhook response to Engati.
//
// `orgConfig` is the resolved OrgConfig row (or null for legacy dedicated-
// project deployments, which fall back to process.env everywhere above).
async function ensureLeadForPhone(catalystApp, orgConfig, userId, displayName) {
  const digits = String(userId || '').replace(/[^0-9]/g, '');
  // Web-channel sessions use UUIDs, not phone numbers. Those aren't contacts we
  // can create a Lead for, so skip rather than creating junk records.
  if (!digits || digits.length < 8 || digits !== String(userId).trim()) {
    return 'skipped (userId is not a plain phone number: ' + String(userId).slice(0, 40) + ')';
  }
  // Cheapest checks first - both are local/near-local and immediately
  // consistent, unlike the search index. BUT: only take the fast exit when
  // there's no displayName to offer. displayName is only ever present on
  // START_CHAT (see extractDisplayName in index.js), which is infrequent
  // compared to USER_MESSAGE - so when it IS present, it's worth one extra
  // GET to check whether a Lead already found by the fast caches still has
  // its placeholder name and needs backfilling. Skipping this check on the
  // cache-hit path was a real bug: USER_MESSAGE creates the Lead first with
  // no name, the id gets cached, and a same-session START_CHAT with the
  // real name would otherwise hit the cache and return before ever
  // comparing names - the placeholder would then persist for the entire
  // cache TTL (up to 6 hours) even though the real name was right there.
  const localHit = recallLocally(orgConfig, digits);

  try {
    // Fetched up front now, unlike before markUnread() existed - every
    // return path below (except the create/upsert one, which folds the
    // fields into its own write) now needs a token to mark the Lead
    // unread, so there is no longer a token-free fast path. getAccessToken()
    // caches per-tenant for an hour, so this is a cheap in-memory check on
    // every call except the first per warm container per tenant.
    const token = await getAccessToken(orgConfig);

    if (localHit && !displayName) {
      await markUnread(orgConfig, token, localHit);
      return 'existing Lead ' + localHit + ' (in-process cache)';
    }

    const cachedId = localHit || await recallFromCache(catalystApp, orgConfig, digits);
    if (cachedId && !displayName) {
      rememberLocally(orgConfig, digits, cachedId);
      await markUnread(orgConfig, token, cachedId);
      return 'existing Lead ' + cachedId + ' (Catalyst cache)';
    }

    if (cachedId) {
      // Already know the id - one GET to check the name, cheaper than a
      // fresh /search.
      rememberLocally(orgConfig, digits, cachedId);
      await rememberInCache(catalystApp, orgConfig, digits, cachedId);
      await markUnread(orgConfig, token, cachedId);
      return await backfillIfNeeded(orgConfig, token, cachedId, digits, displayName);
    }

    // Search covers established contacts, once the index has caught up.
    const existing = await findLeadByPhone(orgConfig, token, digits);
    if (existing) {
      rememberLocally(orgConfig, digits, existing.id);
      await rememberInCache(catalystApp, orgConfig, digits, existing.id);
      await markUnread(orgConfig, token, existing.id);
      if (displayName && existing.Last_Name === fallbackName(digits)) {
        const renamed = await updateLeadName(orgConfig, token, existing.id, displayName);
        return 'existing Lead ' + existing.id + ' (matched by search, name ' + (renamed ? 'backfilled' : 'backfill FAILED') + ')';
      }
      return 'existing Lead ' + existing.id + ' (matched by search)';
    }

    // upsertLead's own payload already includes WhatsApp_Unread/
    // Last_WhatsApp_Message - no separate markUnread() call needed here.
    // createReplyTask() is still needed explicitly though, since only
    // markUnread() calls it automatically.
    const result = await upsertLead(orgConfig, token, digits, displayName);
    rememberLocally(orgConfig, digits, result.id);
    await rememberInCache(catalystApp, orgConfig, digits, result.id);
    await createReplyTask(orgConfig, token, result.id);
    return result.action + ' Lead ' + result.id;
  } catch (e) {
    return 'FAILED: ' + ((e && e.message) || String(e));
  }
}

module.exports = { ensureLeadForPhone };

// liveChatWebhook
//
// This is the "External Webhook URL" target for Engati's External Live Chat
// feature (Configure > External Live Chat > External Webhook URL). Engati
// POSTs these event types here:
//   - START_CHAT    : a bot user requested a human agent
//   - USER_MESSAGE  : a bot user sent a message while in live chat
//   - STATUS_PACKET : async delivery-status callback for a packet WE sent
//                     via liveChatSender (AGENT_MESSAGE/RESOLVE_LIVE_CHAT).
//                     The synchronous response liveChatSender gets back
//                     (messageId/errorCode) is just "packet received", NOT
//                     delivery confirmation - the real outcome (including
//                     errors like USER_NOT_IN_LIVE_CHAT, code 1004) arrives
//                     later as a STATUS_PACKET here.
//
//                     CORRECTION (Aug 13 2026, verified against real
//                     packets): STATUS_PACKET arrives with
//                     "externalPacketType":"STATUS_PACKET", the SAME field
//                     as the other event types. An earlier version of this
//                     comment claimed it used a top-level "type" instead,
//                     and the check below was written to match that - so the
//                     dedicated branch never once fired. Packets still got
//                     stored by the generic path (packet_type was right),
//                     but the code/description were DISCARDED, because the
//                     generic path reads body.packetType/body.text.value,
//                     which a status packet doesn't have. That is why every
//                     STATUS_PACKET row in LiveChatEvents has a blank
//                     text_value. Real observed shape:
//                       {"externalPacketType":"STATUS_PACKET",
//                        "body":{"code":1002,
//                                "description":"User is outside conversation window",
//                                "status":"FAILED","timestamp":"..."},
//                        "platform":"dialog360","userId":"...","botKey":"..."}
//                     Both spellings are accepted below so this can't break
//                     again if Engati ever does send "type".
//
// Contract (from Engati's "External Live Chat V2" developer doc):
//   - MUST return a 2xx status. Engati validates this endpoint with an
//     empty-body POST when the External Webhook URL is saved in Configure;
//     a non-2xx response there means Engati won't save the setup at all.
//   - Response body is ignored by Engati - respond fast, don't block on
//     anything slow (e.g. don't wait on a downstream call before responding
//     if you can avoid it).
//
// What this function does:
//   1. Validates the packet shape.
//   2. Stores the event in a Catalyst Data Store table (`LiveChatEvents`)
//      keyed by userId, so the widget (or another function) can read recent
//      live-chat activity. This exists because once External Live Chat is
//      on, Engati says these conversations stop routing to its own
//      Messages inbox - meaning the widget's current polling of Engati's
//      /conversations GET API may NOT include live-chat messages during an
//      active live-chat session. Storing them here is the fallback so nothing
//      gets lost; how the widget actually surfaces this is a follow-up (see
//      NOTE at the bottom of this file).
//   3. Always responds 200 quickly, even on storage errors (Engati only
//      cares about receiving 2xx; log failures instead of failing the
//      response).
//
// IMPORTANT: this is an Advanced I/O function, same as whatsappProxy and
// liveChatSender - `req`/`res` are raw Node http objects, NOT Express-style.
// No req.body (must read the stream manually), no res.status().send() (must
// use res.writeHead()/res.end()). An earlier version of this file assumed
// Express conventions and crashed every invocation with
// "TypeError: res.status is not a function" - confirmed via direct curl
// test before this ever got wired into Engati's Configure screen.

const https = require('https');
const catalyst = require('zcatalyst-sdk-node');
const { ensureLeadForPhone } = require('./crmLeads');
const { findByWebhookSlug, slugFromUrl } = require('./orgConfig');

// Calls this org's bundled Deluge Lead-sync function (deluge/leadSync.dg) -
// see the call site's comment for why this direction (Catalyst calls
// Deluge, not the reverse). Never rejects - a CRM-sync problem must not
// affect Engati's 2xx, same contract ensureLeadForPhone already follows for
// the legacy path.
//
// UNCONFIRMED: crm_function_url is the admin-pasted, full REST API URL
// Zoho generates for the Function (URL + zapikey together per Zoho's own
// docs - see deluge/leadSync.dg's SETUP section) - assumed to be a normal
// HTTPS POST target needing no additional auth header, since the zapikey is
// already embedded in the URL's query string per Zoho's documented shape.
// Re-verify this against a real Function URL before trusting it.
function callLeadSyncFunction(functionUrl, userId, displayName) {
  return new Promise(function (resolve) {
    var body;
    var url;
    try {
      body = JSON.stringify({ userId: userId, displayName: displayName || '' });
      url = new URL(functionUrl);
    } catch (e) {
      resolve('FAILED: invalid crm_function_url (' + (e && e.message) + ')');
      return;
    }
    var req2 = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function (res2) {
      var chunks = '';
      res2.on('data', function (c) { chunks += c; });
      res2.on('end', function () { resolve('statusCode=' + res2.statusCode + ' body=' + chunks.slice(0, 300)); });
    });
    req2.on('error', function (err) {
      resolve('FAILED: ' + ((err && err.message) || String(err)));
    });
    req2.write(body);
    req2.end();
  });
}

function readBody(req) {
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () { resolve(data); });
    req.on('error', function () { resolve(''); });
  });
}

// A real contact name only ever shows up on START_CHAT, inside
// body.attributeMap - USER_MESSAGE packets have no attributeMap at all, so
// this returns undefined for those and the Lead falls back to "WhatsApp
// <number>", same as before.
//
// An earlier version of this function looked for eventBody.userName /
// body.userName - neither exists anywhere in Engati's packets (checked
// against the developer doc AND real captured payloads), so displayName was
// always undefined and every auto-created Lead was named "WhatsApp
// <number>", even when Engati clearly had a real name on file (confirmed
// via "First Name"/"Username"/"user.first_name" in attributeMap).
function extractDisplayName(eventBody) {
  var am = eventBody.attributeMap;
  if (!am) return undefined;
  var first = am['First Name'] || am['user.first_name'];
  var last = am['Last Name'] || am['user.last_name'];
  if (first && last) return first + ' ' + last;
  // "Username" tends to be the fullest single field Engati populates when
  // only a first name is on file - prefer it, then fall back further.
  return am['Username'] || am['user.user_name'] || first || last || undefined;
}

module.exports = function (req, res) {
  var headers = { 'Content-Type': 'application/json' };

  // MULTI-TENANCY (shared backend, see plan Phase A): Engati's payload
  // itself carries no CRM org id anywhere, so tenant resolution goes through
  // an opaque webhook_slug in the query string of the URL each org's admin
  // pasted into Engati's Configure screen (Settings page, see plan Phase B).
  // An unresolved slug (unknown, or a legacy dedicated-project deployment
  // that never set one) must NOT block the 2xx response - Engati's own
  // Configure-screen validation ping depends on this URL always answering
  // 2xx, and a broken/typo'd slug shouldn't be able to brick that save.
  var catalystApp = catalyst.initialize(req);
  var slug = slugFromUrl(req.url);
  // No slug at all = a legacy dedicated-project deployment (its Engati
  // webhook URL predates the Settings-page-generated ?t= slug) - that mode
  // is untouched, org resolution is simply skipped and everything below
  // falls back to process.env, exactly as before this migration. A slug
  // THAT DOESN'T MATCH any active OrgConfig row is a different, real
  // problem (broken/typo'd/deactivated) and is logged loudly below.
  var isLegacyMode = !slug;
  var orgConfigPromise = slug ? findByWebhookSlug(catalystApp, slug) : Promise.resolve(null);

  Promise.all([readBody(req), orgConfigPromise]).then(function (results) {
    var raw = results[0];
    var orgConfig = results[1];
    var orgId = (orgConfig && orgConfig.org_id) || '';
    if (!isLegacyMode && !orgConfig) {
      console.error('[liveChatWebhook] no OrgConfig row for webhook_slug (unknown/inactive/typo\'d) - event will still 200 but nothing is stored. slug=' + slug);
    }

    var body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }

    // Optional shared-secret check: if you set an Inbound API key when
    // configuring External Live Chat in Engati, it's sent back to us as an
    // Authorization header on every call here. Uncomment and set the
    // expected value once you've decided to use one.
    //
    // var expected = 'Basic ' + process.env.ENGATI_INBOUND_API_KEY;
    // if (req.headers['authorization'] !== expected) {
    //   res.writeHead(401, headers);
    //   res.end(JSON.stringify({ error: 'unauthorized' }));
    //   return;
    // }

    // Checked before the validation-ping fallback below, or it gets swallowed
    // as a no-op. Accepts either spelling: real packets use
    // externalPacketType (see the correction in the header comment); "type"
    // is kept only so a future change on Engati's side can't silently
    // reintroduce the same blank-text_value bug.
    if (body.externalPacketType === 'STATUS_PACKET' || body.type === 'STATUS_PACKET') {
      var statusBody = body.body || {};
      console.log('[liveChatWebhook] STATUS_PACKET status=' + statusBody.status + ' code=' + statusBody.code + ' description=' + statusBody.description + ' userId=' + (body.userId || '') + ' botKey=' + (body.botKey || '') + ' orgId=' + orgId);

      if (!isLegacyMode && !orgId) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true, note: 'unresolved tenant - not stored' }));
        return;
      }

      catalystApp.datastore().table('LiveChatEvents').insertRow({
        org_id: orgId,
        packet_type: 'STATUS_PACKET',
        user_id: body.userId || '',
        bot_key: body.botKey || '',
        platform: body.platform || '',
        message_type: statusBody.status || null,
        text_value: (statusBody.code || '') + ': ' + (statusBody.description || ''),
        media_value: null,
        media_mime_type: null,
        livechat_category: null,
        raw_payload: JSON.stringify(body).slice(0, 5000),
        received_at: new Date().toISOString()
      }).catch(function (e) {
        console.error('[liveChatWebhook] LiveChatEvents insert (STATUS_PACKET) failed: ' + (e && e.message));
      }).then(function () {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    // Engati's own validation ping on Save is an empty-body POST - just ack it.
    // This must succeed regardless of orgId resolution (see comment above).
    if (!body.externalPacketType) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, note: 'no externalPacketType - treated as validation ping' }));
      return;
    }

    var packetType = body.externalPacketType;
    var eventBody = body.body || {};
    var userId = body.userId || '';
    var botKey = body.botKey || '';
    var platform = body.platform || '';

    console.log('[liveChatWebhook] packetType=' + packetType + ' userId=' + userId + ' botKey=' + botKey + ' orgId=' + orgId);

    if (!isLegacyMode && !orgId) {
      // Real event, unresolvable tenant - still 2xx (Engati's contract), but
      // nothing useful can be stored or lead-synced without knowing which
      // org's CRM to touch. Logged loudly above so this is visible in
      // Catalyst logs rather than silently swallowed.
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, note: 'unresolved tenant - not stored' }));
      return;
    }

    var table = catalystApp.datastore().table('LiveChatEvents');
    table.insertRow({
      org_id: orgId,
      packet_type: packetType,
      user_id: userId,
      bot_key: botKey,
      platform: platform,
      message_type: eventBody.packetType || null,
      text_value: (eventBody.text && eventBody.text.value) || null,
      media_value: (eventBody.media && eventBody.media.value) || null,
      media_mime_type: (eventBody.media && eventBody.media.mimeType) || null,
      livechat_category: eventBody.livechatCategoryName || null,
      raw_payload: JSON.stringify(body).slice(0, 5000),
      received_at: new Date().toISOString()
    }).catch(function (e) {
      // Don't fail the response over a storage hiccup - Engati only needs 2xx.
      console.error('[liveChatWebhook] LiveChatEvents insert failed: ' + (e && e.message));
    }).then(function () {
      // Auto-create a Zoho CRM Lead for contacts we haven't seen before.
      //
      // IMPORTANT (corrected architecture, confirmed by Zoho Marketplace
      // support - see email thread "Zoho CRM Extension Development - US DC
      // Requirement & Connections Support Query", Aug 2026, and plan's
      // "Correction" section): for the shared, multi-tenant extension path
      // (isLegacyMode === false, i.e. orgId resolved via webhook_slug), this
      // function does NOT do the CRM write itself anymore. Sigma/CRM
      // extensions don't support "Connections" for third-party auth, and
      // per-org Self Client OAuth (what crmLeads.js still does, for the
      // legacy path only) is exactly what we were trying to avoid running
      // per customer. Zoho's confirmed alternative: a REST-API-triggered
      // Deluge Function bundled in the extension gets a per-installing-org
      // URL + zapikey at setup time, and runs with IMPLICIT, tokenless CRM
      // access to that org's data - see deluge/leadSync.dg (new, in this
      // repo - Deluge is authored in Zoho's Sigma console, not deployable
      // from this Node/Catalyst codebase).
      //
      // Call direction: THIS function calls that Deluge function (via a
      // plain HTTPS POST to orgConfig.crm_function_url, the admin-pasted
      // URL from the Settings page) - not the other way around. Engati's
      // webhook target stays the Catalyst URL, unchanged; only the CRM
      // write step is redirected. See callLeadSyncFunction() below.
      //
      // Legacy dedicated-project deployments (isLegacyMode === true) have no
      // Deluge function in the picture at all - the OAuth-based
      // ensureLeadForPhone path is still exactly how those keep working.
      //
      // Runs on USER_MESSAGE rather than START_CHAT deliberately: START_CHAT
      // only fires when the bot flow reaches a Transfer to Agent node (often
      // never), and on the web channel its userId is a session UUID rather than
      // a phone number. USER_MESSAGE fires on every inbound WhatsApp message
      // and carries the real number.
      //
      // Neither path throws on a CRM/network problem - a downstream failure
      // can't stop Engati getting its 2xx. Both are idempotent-ish (the
      // legacy path via search-before-create, the Deluge path via
      // duplicate_check_fields), which matters because this runs on every
      // single message.
      if (packetType !== 'USER_MESSAGE' && packetType !== 'START_CHAT') {
        return;
      }
      if (isLegacyMode) {
        return ensureLeadForPhone(catalystApp, orgConfig, userId, extractDisplayName(eventBody))
          .then(function (outcome) {
            console.log('[liveChatWebhook] lead sync for ' + userId + ': ' + outcome);
          });
      }
      if (orgConfig.crm_function_url) {
        return callLeadSyncFunction(orgConfig.crm_function_url, userId, extractDisplayName(eventBody))
          .then(function (outcome) {
            console.log('[liveChatWebhook] Deluge lead sync for ' + userId + ': ' + outcome);
          });
      }
      console.log('[liveChatWebhook] no crm_function_url set for orgId=' + orgId + ' - Lead sync skipped, see Settings page');
    }).catch(function (e) {
      console.error('[liveChatWebhook] lead sync threw unexpectedly: ' + (e && e.message));
    }).then(function () {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true }));
    });
  });
};

// NOTE - follow-up not covered by this function:
// The widget (app.js `fetchConversation`) currently polls Engati's
// /conversations GET endpoint directly. Once External Live Chat is enabled,
// confirm with Engati whether that endpoint still includes live-chat-window
// messages, or only bot/template messages outside live chat. If it doesn't,
// the widget (or a new proxy action) will need to also read from the
// `LiveChatEvents` table above and merge those rows into the rendered
// conversation - similar to how `localSentMessages` are merged today in
// `renderMerged()`. Not built yet; flagging so it isn't missed once this
// goes live.

// liveChatSender
//
// Sends AGENT_MESSAGE and RESOLVE_LIVE_CHAT packets to Engati's "Inbound
// Message Webhook URL" - the system-generated URL Engati shows in
// Configure > External Live Chat once the feature is enabled. This is the
// mechanism for an agent (our widget) to actually send replies once
// External Live Chat is on - it replaces the old direct call to Engati's
// /broadcast endpoint, which is permanently blocked without this add-on.
//
// MULTI-TENANT: this function is shared across all customers/Zoho orgs -
// it does NOT hardcode any one customer's Engati credentials. Every
// customer's Inbound Message Webhook URL, bot key, and optional inbound API
// key are passed in on each request (sourced from that org's own Zoho CRM
// Variables, same place ENGATI_CUSTOMER_ID/BOT_ID/API_KEY already live).
// Widget-side wiring: app.js loadConfigFromVariables() reads
// ENGATI_INBOUND_MESSAGE_WEBHOOK_URL (and ENGATI_INBOUND_API_KEY if set)
// alongside the existing three variables, and sendFreeTextMessage() passes
// them through on every call.
//
// Follows the exact same conventions as the real `whatsappProxy` function
// (confirmed by reading its live source in the Catalyst console):
//   - Advanced I/O, `module.exports = function(req, res) {...}`
//   - raw `https` module for outbound calls - no npm dependencies at all,
//     whatsappProxy's package.json has none, so don't assume fetch/
//     node-fetch/axios are available. If you want them, add to
//     package.json's "dependencies" and redeploy.
//   - CORS headers + OPTIONS preflight handling
//   - body read manually via a data/end listener, then JSON.parse
//   - response shaped {statusCode, body} matching how app.js's
//     safeParse(resp) / data.statusCode checks already expect proxy
//     responses to look (see sendTemplateViaProxy() + templateBtn handler
//     in app.js)
//
// Expected POST body from the widget:
//   {
//     action: "sendAgentMessage" | "resolveLiveChat",
//     phone,                            // channel-user id, see normalizePhone() in app.js
//     inboundMessageWebhookUrl,         // REQUIRED - this org's Engati Inbound Message Webhook URL
//     botKey,                           // REQUIRED - this org's Engati bot key
//     inboundApiKey,                    // optional - this org's Inbound API key, if configured in Engati
//     platform, botIdentifier,          // botIdentifier is REQUIRED in
//                                        // practice - see the check below
//                                        // for what value it actually
//                                        // needs (not ENGATI_CUSTOMER_ID)
//     text,                             // for sendAgentMessage: plain text
//     media                             // for sendAgentMessage: { value: <url>, mimeType }
//   }
//
// whatsappProxy still hardcodes its one customer's credentials as of this
// writing - revisit that separately if/when a second customer needs
// template sending too. Don't assume it's already multi-tenant.

const https = require('https');
// Needed only by the getStatusPackets read path below (Data Store access).
const catalyst = require('zcatalyst-sdk-node');

function readBody(req) {
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () { resolve(data); });
    req.on('error', function () { resolve(''); });
  });
}

function engatiPost(urlString, payload, inboundApiKey) {
  return new Promise(function (resolve) {
    var body = JSON.stringify(payload);
    var url = new URL(urlString);
    var headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    if (inboundApiKey) {
      headers['Authorization'] = 'Basic ' + inboundApiKey;
    }
    var options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: headers
    };
    var req2 = https.request(options, function (res2) {
      var chunks = '';
      res2.on('data', function (c) { chunks += c; });
      res2.on('end', function () {
        resolve({ statusCode: res2.statusCode, body: chunks });
      });
    });
    req2.on('error', function (err) {
      resolve({ statusCode: 599, body: JSON.stringify({ error: String((err && err.message) || err) }) });
    });
    req2.write(body);
    req2.end();
  });
}

// DOCUMENT confirmed real and working (Aug 11 2026) despite NOT being in
// Engati's documented packetType enum (their dev doc only lists
// TEXT/IMAGE/AUDIO/VIDEO) - verified via a genuine PDF, real send, real
// delivery. Without this branch, any PDF would fall through to the
// default 'IMAGE' return below and WhatsApp would reject the
// packetType/mimeType mismatch. See workdrive-attachment-research-
// unfinished persistent notes for the full test.
function inferPacketType(mimeType) {
  if (!mimeType) return 'IMAGE';
  if (mimeType.indexOf('video') === 0) return 'VIDEO';
  if (mimeType.indexOf('audio') === 0) return 'AUDIO';
  if (mimeType === 'application/pdf') return 'DOCUMENT';
  return 'IMAGE';
}

module.exports = function (req, res) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  readBody(req).then(function (raw) {
    var input;
    try { input = JSON.parse(raw || '{}'); } catch (e) { input = {}; }

    var action = input.action;
    var phone = input.phone;
    var inboundMessageWebhookUrl = input.inboundMessageWebhookUrl;
    var botKey = input.botKey;
    var botIdentifier = input.botIdentifier;
    var inboundApiKey = input.inboundApiKey || '';

    // Read-only: recent delivery-failure packets for one user.
    //
    // Handled here rather than in a new function because a freshly-deployed
    // Catalyst function 404s until it's manually given an API Gateway route,
    // per environment (see SETUP.md) - and rather than in liveChatWebhook
    // because that one has no CORS headers (Engati calls it server-side, the
    // browser never does). This function is already widget-facing and
    // already CORS-correct, so it's the cheapest correct home.
    //
    // Returns FAILED status packets only. Deliberately placed above the
    // send-path required-field checks below: reading statuses needs nothing
    // but a phone number.
    if (action === 'getStatusPackets') {
      if (!phone) {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'phone required' }) }));
        return;
      }
      var sinceMs = Number(input.sinceMs) || 0;
      var app = catalyst.initialize(req);
      // ZCQL has no parameter binding, so both the phone and orgId are
      // whitelisted before interpolation - phone is a channel-user id
      // (digits only), orgId is Zoho's own numeric org id (digits only).
      // Multi-tenancy note: on the shared backend, orgId scoping is what
      // stops org A from reading org B's delivery-failure packets just by
      // guessing/knowing a phone number - see plan Phase D. Legacy
      // dedicated-project deployments (no orgId sent, or rows written before
      // this change) simply match against an empty org_id, which is fine
      // since those deployments only ever hold one org's data anyway.
      var safePhone = String(phone).replace(/[^0-9]/g, '');
      var safeOrgId = String(input.orgId || '').replace(/[^0-9]/g, '');
      var orgClause = safeOrgId ? " AND org_id = '" + safeOrgId + "'" : '';
      app.zcql().executeZCQLQuery(
        "SELECT text_value, message_type, received_at, raw_payload FROM LiveChatEvents" +
        " WHERE packet_type = 'STATUS_PACKET' AND user_id = '" + safePhone + "'" + orgClause +
        " ORDER BY CREATEDTIME DESC LIMIT 50"
      ).then(function (rows) {
        var out = (rows || []).map(function (r) {
          var v = r.LiveChatEvents || {};
          // text_value is "<code>: <description>" for packets stored after
          // the Aug 13 externalPacketType fix. Older rows have it blank
          // because the code was being discarded, so fall back to digging
          // the values out of raw_payload - otherwise every historic failure
          // would silently render as "unknown".
          var code = null, description = null, status = v.message_type || null;
          var m = /^(\d+):\s*(.*)$/.exec(v.text_value || '');
          if (m) { code = Number(m[1]); description = m[2]; }
          var ts = null;
          try {
            var rp = JSON.parse(v.raw_payload || '{}');
            var b = rp.body || {};
            if (code === null && b.code != null) { code = Number(b.code); description = b.description || null; }
            if (!status && b.status) { status = b.status; }
            if (b.timestamp) { ts = Date.parse(b.timestamp) || null; }
          } catch (e) { /* raw_payload is truncated at 5000 chars - ignore */ }
          if (!ts && v.received_at) { ts = Date.parse(v.received_at) || null; }
          return { code: code, description: description, status: status, ts: ts };
        }).filter(function (s) {
          return s.ts && s.status !== 'SUCCESS' && s.ts >= sinceMs;
        });
        res.writeHead(200, headers);
        res.end(JSON.stringify({ statusCode: 200, body: JSON.stringify({ statuses: out }) }));
      }).catch(function (e) {
        // Never fail the widget over this - it's a diagnostic overlay on top
        // of a conversation that renders fine without it.
        console.error('[liveChatSender] getStatusPackets failed: ' + (e && e.message));
        res.writeHead(200, headers);
        res.end(JSON.stringify({ statusCode: 200, body: JSON.stringify({ statuses: [] }) }));
      });
      return;
    }

    if (!inboundMessageWebhookUrl) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        statusCode: 400,
        body: JSON.stringify({ error: 'inboundMessageWebhookUrl required - External Live Chat not configured for this org' })
      }));
      return;
    }

    if (!botKey) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'botKey required' }) }));
      return;
    }

    // Confirmed by testing (Aug 2026): Engati silently accepts AGENT_MESSAGE
    // packets with an empty botIdentifier and just never delivers them -
    // returns {"messageId":null,"errorCode":null} with no error surfaced.
    // Treat as required here so that failure is loud instead of silent.
    //
    // IMPORTANT - this is NOT the org's ENGATI_CUSTOMER_ID (an earlier
    // version of this comment wrongly said it was, and every AGENT_MESSAGE
    // sent with that value was accepted and silently never delivered - see
    // ES-58715). It is a separate, longer, base64-looking token that only
    // appears in the top-level "botIdentifier" field of a genuine
    // (bot-flow-triggered, not manually agent-picked-up) START_CHAT packet,
    // e.g. "eyJib3RSZWYiOjE0NzkxNCwidXNlcnNCb3RSZWYiOjE0NzkxNH0=". Widget
    // side, this is ENGATI_LIVECHAT_BOT_IDENTIFIER - see app.js and
    // SETUP.md for how to capture the real value on a new bot.
    if (!botIdentifier) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'botIdentifier required - this is NOT the Customer ID; see the code comment above this check' }) }));
      return;
    }

    if (!phone) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'phone required' }) }));
      return;
    }

    var enginePacket;

    if (action === 'sendAgentMessage') {
      var text = input.text;
      var media = input.media; // { value: <url>, mimeType: <string> }
      enginePacket = {
        externalPacketType: 'AGENT_MESSAGE',
        body: {
          packetType: media ? inferPacketType(media.mimeType) : 'TEXT',
          text: text ? { value: text } : undefined,
          media: media ? { value: media.value, mimeType: media.mimeType } : undefined,
          timestamp: new Date().toISOString()
        },
        platform: input.platform || 'whatsapp',
        userId: phone,
        botKey: botKey,
        botIdentifier: botIdentifier
      };
    } else if (action === 'resolveLiveChat') {
      enginePacket = {
        externalPacketType: 'RESOLVE_LIVE_CHAT',
        platform: input.platform || 'whatsapp',
        userId: phone,
        botKey: botKey,
        botIdentifier: botIdentifier
      };
    } else {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: 'unknown action' }));
      return;
    }

    engatiPost(inboundMessageWebhookUrl, enginePacket, inboundApiKey).then(function (result) {
      res.writeHead(200, headers);
      res.end(JSON.stringify(result));
    });
  });
};

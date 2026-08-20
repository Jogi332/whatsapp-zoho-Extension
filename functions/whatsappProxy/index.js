// whatsappProxy
//
// RECONSTRUCTED FROM SCRATCH (see plan Phase D) - this function previously
// existed only console-side, in one customer's Catalyst project, hardcoding
// that customer's Engati credentials. It was never committed to git (see
// SETUP.md Phase 3 step 9), so this is a rebuild from indirect evidence, NOT
// a lift-and-shift of working source. Treat as unverified until a real
// template send succeeds end-to-end on a real phone - see the plan's Phase D
// risk flag.
//
// Its one real job, confirmed from app.js's actual call site
// (sendTemplateViaProxy, action: 'sendTemplate'): forward a WhatsApp
// Template send to Engati's Template API. The exact request shape below is
// not guesswork either - it's copied from app.js's sendTemplateMessage(),
// an earlier, dead-code direct-from-browser implementation of the same call
// that predates this proxy (superseded because calling Engati directly from
// the browser meant exposing ENGATI_API_KEY client-side - see plan Phase G's
// note on fetchConversation() having the same still-open exposure). That
// function's request (URL, headers, body shape) is the last known-correct
// reference for what Engati's Template API actually expects:
//   POST https://api.engati.ai/whatsapp-api/v1.0/customer/<engatiCustomerId>/bot/<engatiBotId>/template
//   Headers: Authorization: Basic <engatiApiKey>, Content-Type: application/json
//   Body: { phoneNumber: '+'+phone, payload: templatePayload }
//
// MULTI-TENANCY: CORRECTED (see plan's "Correction" section, confirmed by
// Zoho Marketplace support) - Engati credentials are NOT looked up from a
// shared Data Store table. Zoho's own guidance for per-org third-party
// API-key storage is CRM Variables, which the widget already reads (see
// app.js loadConfigFromVariables) and now passes straight through on every
// request here (engatiCustomerId/engatiBotId/engatiApiKey in the POST
// body) - exactly the same pattern liveChatSender already used correctly
// from the start. This function no longer looks anything up by `orgId` at
// all; that field is accepted only for logging/diagnostics. Falls back to
// process.env if the widget didn't send credentials (legacy dedicated-
// project deployments, where CATALYST_PROXY_URL points at that customer's
// own Catalyst project and the widget's applyCatalystBaseUrl path is in
// play - same as how the original console-only whatsappProxy worked for
// its one customer).
//
// Same platform conventions as every other function in this repo - Advanced
// I/O (raw req/res, no Express), no npm deps beyond zcatalyst-sdk-node, CORS
// + OPTIONS handling, manual body read.

const https = require('https');

function readBody(req) {
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () { resolve(data); });
    req.on('error', function () { resolve(''); });
  });
}

function engatiTemplatePost(customerId, botId, apiKey, phone, templatePayload) {
  return new Promise(function (resolve) {
    var body = JSON.stringify({ phoneNumber: '+' + phone, payload: templatePayload });
    var options = {
      hostname: 'api.engati.ai',
      path: '/whatsapp-api/v1.0/customer/' + encodeURIComponent(customerId) + '/bot/' + encodeURIComponent(botId) + '/template',
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
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
    if (action !== 'sendTemplate') {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: 'unknown action' }));
      return;
    }

    var phone = input.phone;
    var templatePayload = input.templatePayload;
    if (!phone || !templatePayload) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'phone and templatePayload required' }) }));
      return;
    }

    // orgId is accepted for logging only now - see file header. Credentials
    // come straight from the request body (widget-supplied, sourced from
    // CRM Variables), falling back to process.env for legacy dedicated-
    // project deployments that never send these fields at all.
    var customerId = input.engatiCustomerId || process.env.ENGATI_CUSTOMER_ID;
    var botId = input.engatiBotId || process.env.ENGATI_BOT_ID;
    var apiKey = input.engatiApiKey || process.env.ENGATI_API_KEY;

    if (!customerId || !botId || !apiKey) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'Engati credentials missing - not sent by the widget and no legacy env vars configured' }) }));
      return;
    }

    engatiTemplatePost(customerId, botId, apiKey, phone, templatePayload).then(function (result) {
      res.writeHead(200, headers);
      res.end(JSON.stringify(result));
    }).catch(function (e) {
      console.error('[whatsappProxy] sendTemplate failed for orgId=' + input.orgId + ': ' + (e && e.message));
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 502, body: JSON.stringify({ error: (e && e.message) || String(e) }) }));
    });
  });
};

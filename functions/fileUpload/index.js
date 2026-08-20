// fileUpload
//
// Lets an agent attach a file from their own device (not just paste a URL)
// when replying via the widget's free-text composer. Uploads the file to
// Zoho WorkDrive and returns a public, unauthenticated, single-GET-fetchable
// URL - the same shape WhatsApp/Meta needs for outbound media, and the same
// shape the widget's existing attachUrl/attachType fields already expect
// (see app.js's sendBtn handler and sendFreeTextMessage's `media` param).
//
// This function only produces the URL. Sending the message is a separate,
// already-working step - see catalyst-functions/liveChatSender/.
//
// CREDENTIALS: read from environment variables, set per deployment in the
// Catalyst console (Functions > fileUpload > Configuration). Deliberately
// NOT committed - each customer's Catalyst project holds their own org's
// values. See SETUP.md.
//   WORKDRIVE_CLIENT_ID
//   WORKDRIVE_CLIENT_SECRET
//   WORKDRIVE_REFRESH_TOKEN
//   WORKDRIVE_FOLDER_ID       REQUIRED - the WorkDrive folder (privatespace
//                             or team folder) resource id to upload into.
//                             See SETUP.md for how to find it.
//   WORKDRIVE_ACCOUNTS_HOST   optional, default accounts.zoho.in
//   WORKDRIVE_API_HOST        optional, default www.zohoapis.in (upload endpoint)
//   WORKDRIVE_HOST            optional, default workdrive.zoho.in (links endpoint -
//                             note this is a DIFFERENT host from the upload
//                             endpoint; using the wrong one for either call
//                             just 500s with no useful error, cost real time
//                             to work out - see SETUP.md)
//   WORKDRIVE_DOWNLOAD_HOST   optional, default files-accl.zohoexternal.in
//                             (the actual raw-bytes download host - yet
//                             another different domain from the two above)
// A customer on a different data centre needs the .com/.eu/etc equivalents
// for ALL FOUR hosts - they don't share a suffix pattern predictably enough
// to derive from one setting, so each is independently overridable.
//
// This CAN reuse the same WORKDRIVE_CLIENT_ID/SECRET as a Zoho CRM Self
// Client (Zoho allows only one Self Client per account), but needs its OWN
// refresh token generated with WorkDrive scopes
// (WorkDrive.files.ALL,WorkDrive.links.ALL at minimum) - a CRM-scoped
// refresh token will not work here. See SETUP.md.
//
// THE VERIFIED UPLOAD RECIPE (confirmed working end-to-end via curl before
// this function was written - see persistent notes, this is not guesswork):
//   1. POST {WORKDRIVE_API_HOST}/workdrive/api/v1/upload - multipart upload,
//      returns a resource_id.
//   2. POST {WORKDRIVE_HOST}/api/v1/links - creates a public link. The
//      request body below is copied EXACTLY from intercepting WorkDrive's
//      own web UI's request (blind guessing against this undocumented
//      endpoint just 500s with no useful signal regardless of what's
//      wrong) - do not simplify it, missing fields cause the same opaque
//      500 as using the wrong host entirely.
//   3. The actual raw-bytes URL is NOT the "download_url" field in step 2's
//      response, and NOT the plain share link even with ?directDownload=true
//      appended (both of those serve an HTML/JS preview shell, confirmed by
//      testing - a third-party blog's claim to the contrary was WRONG).
//      It's a separately-constructed URL on yet another host:
//      {WORKDRIVE_DOWNLOAD_HOST}/public/workdrive-external/download/<resource_id>
//        ?x-cli-msg={"linkId":"<step 2's response data.id>","isFileOwner":false,"version":"1.0","isWDSupport":false}
//      Confirmed stateless (no cookies/auth needed) and byte-correct via
//      curl - but see the next comment for why that's NOT the URL this
//      function actually hands back.
//
// WHY THIS FUNCTION PROXIES INSTEAD OF RETURNING THE WORKDRIVE URL DIRECTLY:
// A real WhatsApp send test (Aug 10 2026) proved the raw files-accl URL
// above, despite being byte-correct, is REJECTED by WhatsApp/Meta's own
// media fetcher - the message was accepted by Engati's API (200,
// messageId, no errorCode) but never arrived on the phone. A clean A/B
// test isolated the cause to the URL's SHAPE: a plain, short, no-query-
// string URL (the widget's own brand logo) delivered correctly through
// the exact same AGENT_MESSAGE mechanism; the long `?x-cli-msg=<percent-
// encoded JSON>` query string did not. Whatever curl/a browser tolerates,
// Meta's fetcher apparently does not.
//
// The fix: never hand WhatsApp the WorkDrive URL. Generate a short,
// opaque, plain-path id, remember which WorkDrive file+link it maps to
// (Catalyst Cache), and hand out OUR OWN short URL instead:
//   GET /server/fileUpload/media/<shortId>
// A request to that path (this same function, routed by the same API
// Gateway rule - see SETUP.md's API Gateway callout) looks up the mapping,
// fetches the real bytes from WorkDrive server-side, and streams them
// straight through - WhatsApp only ever sees our short URL, never the
// long WorkDrive one. This was NOT re-verified with a real WhatsApp send
// after being built - see persistent notes for status; re-test the same
// rigorous way (real send, real phone) before trusting it.
//
// IMPORTANT: this is an Advanced I/O function, same as whatsappProxy,
// liveChatWebhook, liveChatSender - req/res are raw Node http objects, no
// Express conventions. Only npm dependency is zcatalyst-sdk-node (for
// Cache) - everything else is raw https + manual multipart body
// construction, matching this project's other functions.

const https = require('https');
const crypto = require('crypto');
const catalyst = require('zcatalyst-sdk-node');
// MULTI-TENANCY: CORRECTED (see plan's "Correction" section, confirmed by
// Zoho Marketplace support) - WorkDrive credentials are NOT looked up from
// a shared Data Store table. Same reasoning/pattern as whatsappProxy's
// Engati fix: the widget already reads these from CRM Variables (see
// app.js's WORKDRIVE_* globals) and passes them straight through on every
// upload request. Every function below that takes an `orgConfig`-shaped
// argument is really just being handed a plain object built from the
// request body in handleUpload() - the property names
// (workdrive_client_id etc.) are kept identical to what the old OrgConfig
// row shape used, so none of these helper functions needed to change.
// Null/missing = legacy dedicated-project deployment, falls back to
// process.env exactly as originally built.

function readBody(req) {
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () { resolve(data); });
    req.on('error', function () { resolve(''); });
  });
}

function requestJson(options, body) {
  return new Promise(function (resolve) {
    var req = https.request(options, function (res) {
      var chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () {
        var parsed = null;
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

function accountsHost(orgConfig) { return (orgConfig && orgConfig.workdrive_accounts_host) || process.env.WORKDRIVE_ACCOUNTS_HOST || 'accounts.zoho.in'; }
function apiHost(orgConfig) { return (orgConfig && orgConfig.workdrive_api_host) || process.env.WORKDRIVE_API_HOST || 'www.zohoapis.in'; }
function workdriveHost(orgConfig) { return (orgConfig && orgConfig.workdrive_host) || process.env.WORKDRIVE_HOST || 'workdrive.zoho.in'; }
function downloadHost(orgConfig) { return (orgConfig && orgConfig.workdrive_download_host) || process.env.WORKDRIVE_DOWNLOAD_HOST || 'files-accl.zohoexternal.in'; }

// Access tokens last an hour. Cached PER TENANT (keyed by client id), same
// reasoning as crmLeads.js's tokenCache - a single shared module-level token
// would leak org A's WorkDrive access into org B's upload on this shared
// backend.
var tokenCache = new Map(); // clientId -> { token, expiresAt }

async function getAccessToken(orgConfig) {
  var clientId = (orgConfig && orgConfig.workdrive_client_id) || process.env.WORKDRIVE_CLIENT_ID;
  var clientSecret = (orgConfig && orgConfig.workdrive_client_secret) || process.env.WORKDRIVE_CLIENT_SECRET;
  var refreshToken = (orgConfig && orgConfig.workdrive_refresh_token) || process.env.WORKDRIVE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('WorkDrive credentials not configured for this tenant (client id / secret / refresh token)');
  }

  var now = Date.now();
  var cached = tokenCache.get(clientId);
  if (cached && now < cached.expiresAt - 60000) { return cached.token; }

  var form = 'grant_type=refresh_token'
    + '&client_id=' + encodeURIComponent(clientId)
    + '&client_secret=' + encodeURIComponent(clientSecret)
    + '&refresh_token=' + encodeURIComponent(refreshToken);

  var res = await requestJson({
    hostname: accountsHost(orgConfig),
    path: '/oauth/v2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form)
    }
  }, form);

  var token = res.json && res.json.access_token;
  if (!token) {
    throw new Error('WorkDrive token refresh failed (' + res.statusCode + '): ' + String(res.body).slice(0, 300));
  }
  var expiresInSec = (res.json && res.json.expires_in) || 3600;
  tokenCache.set(clientId, { token: token, expiresAt: Date.now() + expiresInSec * 1000 });
  return token;
}

// Hand-built multipart/form-data body - no npm form-data package available
// (see file header). WorkDrive's upload API expects the file under a field
// named "content".
function buildMultipart(filename, mimeType, buffer) {
  var boundary = 'WhatsyooBoundary' + Date.now() + Math.random().toString(16).slice(2);
  var preamble = '--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="content"; filename="' + filename.replace(/"/g, '') + '"\r\n'
    + 'Content-Type: ' + (mimeType || 'application/octet-stream') + '\r\n\r\n';
  var epilogue = '\r\n--' + boundary + '--\r\n';
  var body = Buffer.concat([Buffer.from(preamble, 'utf8'), buffer, Buffer.from(epilogue, 'utf8')]);
  return { boundary: boundary, body: body };
}

async function uploadFile(orgConfig, token, filename, mimeType, buffer) {
  var folderId = (orgConfig && orgConfig.workdrive_folder_id) || process.env.WORKDRIVE_FOLDER_ID;
  if (!folderId) {
    throw new Error('WorkDrive folder id not configured for this tenant - see SETUP.md for how to find it');
  }
  var multipart = buildMultipart(filename, mimeType, buffer);
  var path = '/workdrive/api/v1/upload'
    + '?filename=' + encodeURIComponent(filename)
    + '&parent_id=' + encodeURIComponent(folderId)
    + '&override-name-exist=true';

  var res = await requestJson({
    hostname: apiHost(orgConfig),
    path: path,
    method: 'POST',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'multipart/form-data; boundary=' + multipart.boundary,
      'Content-Length': multipart.body.length
    }
  }, multipart.body);

  var record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  var resourceId = record && (record.resource_id || (record.attributes && record.attributes.resource_id));
  if (!resourceId) {
    throw new Error('WorkDrive upload failed (' + res.statusCode + '): ' + String(res.body).slice(0, 300));
  }
  return resourceId;
}

// The exact payload shape here was captured by intercepting WorkDrive's own
// web UI request, not guessed - see the file header. Every field is
// required even when empty; omitting any one produces the same generic
// 500 as calling the wrong host, so don't "clean this up" without testing
// against a real upload again.
async function createPublicLink(orgConfig, token, resourceId, linkName) {
  var payload = JSON.stringify({
    data: {
      attributes: {
        resource_id: resourceId,
        link_name: linkName,
        password_text: '',
        expiration_date: '',
        request_user_data: false,
        allow_download: true,
        role_id: '34'
      },
      type: 'links'
    }
  });

  var res = await requestJson({
    hostname: workdriveHost(orgConfig),
    path: '/api/v1/links',
    method: 'POST',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  var linkId = res.json && res.json.data && res.json.data.id;
  if (!linkId) {
    throw new Error('WorkDrive link creation failed (' + res.statusCode + '): ' + String(res.body).slice(0, 300));
  }
  return linkId;
}

// The real WorkDrive URL - byte-correct, but NOT what gets handed to
// WhatsApp (see file header). Only used internally by the /media proxy
// route below.
function buildWorkdriveDownloadUrl(orgConfig, resourceId, linkId) {
  var xCliMsg = JSON.stringify({
    linkId: linkId,
    isFileOwner: false,
    version: '1.0',
    isWDSupport: false
  });
  return 'https://' + downloadHost(orgConfig) + '/public/workdrive-external/download/'
    + encodeURIComponent(resourceId) + '?x-cli-msg=' + encodeURIComponent(xCliMsg);
}

// Short opaque id -> {resourceId, linkId, mimeType} mapping, so the /media
// route can resolve a plain-path URL back to the real WorkDrive file
// without WhatsApp ever seeing the long query-string URL. Catalyst Cache,
// not Data Store - this is exactly the TTL-appropriate, no-relational-
// query-needed shape Cache is for (see catalyst-serverless-platform-
// reference notes). expiry is in HOURS (Catalyst Cache API unit, confirmed
// from the SDK's segment.put signature).
//
// 48 is the actual MAXIMUM Catalyst Cache allows - confirmed by testing,
// not documentation (Catalyst's docs don't state a limit; the API itself
// rejects anything outside 1-48 with "expiry_in_hours value should be
// within the range of 1 to 48"). This resolves an open question from
// earlier in this project's history (see catalyst-deploy-workflow-traps
// notes) - there IS a hard ceiling, it's just undocumented.
//
// This means an attachment's proxy URL stops working 48 hours after
// upload - fine for WhatsApp delivery (happens within minutes), but the
// widget will show a broken-media fallback (see appendMediaTo in app.js)
// for any attachment older than 48h in chat history. Re-upload isn't
// possible after the fact since the original file on the agent's device
// is gone by then. Live with this for now; revisit only if customers
// actually complain about old attachments going blank.
var MEDIA_CACHE_TTL_HOURS = 48;

// shortId itself is a crypto.randomBytes(9) opaque token (~2^72 space) - not
// namespaced per-org here deliberately. GET /media only ever receives the
// shortId (WhatsApp fetches the exact URL this function handed back, with
// no org context of any kind), so true per-org namespacing of the cache key
// would need embedding an org identifier into the WhatsApp-facing URL - and
// that URL's shape is under active, fragile investigation (see plan Phase E
// / file header re: Meta's media fetcher rejecting anything but a short
// plain-path URL). Not worth risking a second unproven variable while that
// investigation is open; the random id's collision space is the isolation
// mechanism instead.
function mediaCacheKey(shortId) { return 'wdmedia_' + shortId; }

// downloadHostOverride is stored alongside the mapping (not just resolved
// fresh from orgConfig at upload time) because streamMedia() below has no
// org context at GET time either - see the comment above. Storing it here
// is what lets a customer on a non-default WorkDrive data centre still get
// the right download host reconstructed later.
async function rememberMedia(catalystApp, shortId, resourceId, linkId, mimeType, downloadHostOverride) {
  var segment = catalystApp.cache().segment();
  var value = JSON.stringify({ resourceId: resourceId, linkId: linkId, mimeType: mimeType, downloadHost: downloadHostOverride || null });
  await segment.put(mediaCacheKey(shortId), value, MEDIA_CACHE_TTL_HOURS);
}

async function recallMedia(catalystApp, shortId) {
  var segment = catalystApp.cache().segment();
  var raw = await segment.getValue(mediaCacheKey(shortId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// Base URL for the short proxy link this function hands out. Built from
// the inbound request's own Host header rather than hardcoded, so this
// works unmodified for every customer's own Catalyst project (same
// multi-tenant principle as the rest of this repo - see liveChatSender's
// header comment). Always https - Catalyst serves Advanced I/O functions
// over https only.
function ownBaseUrl(req) {
  var host = (req.headers && (req.headers.host || req.headers[':authority'])) || '';
  // Strip a redundant default-port suffix (Catalyst's Host header includes
  // ":443" on this stack) - the whole point of this proxy URL is to be as
  // plain and simple as the URL that was proven to deliver over WhatsApp
  // (see file header), so don't reintroduce an unusual-looking URL here.
  host = host.replace(/:443$/, '');
  return 'https://' + host + '/server/fileUpload/';
}

// IMPORTANT PLATFORM QUIRK, confirmed by testing (not documented anywhere):
// Catalyst's Advanced I/O gateway does NOT forward the API Gateway's
// captured path segment into req.url at all - req.url is hardcoded to "/"
// no matter what sub-path was actually requested (confirmed: hitting
// .../server/fileUpload/media/<id> still shows req.url === "/" inside the
// function). This is true even though the API Gateway route's own "Target
// URL" field displays "/server/fileUpload/{path1}" as if it forwards -
// that's cosmetic/documentation only for Advanced I/O targets, not real
// behaviour. The QUERY STRING, however, DOES survive (confirmed:
// "?id=x&foo=bar" arrives as req.url === "/?foo=bar&id=x"). So the short
// media id has to travel as a query parameter, not a path segment, even
// though a path segment would have been the more natural design and is
// what an initial version of this function assumed.
function extensionFromFilename(filename) {
  var clean = String(filename || '').split('#')[0].split('?')[0];
  var dot = clean.lastIndexOf('.');
  if (dot === -1 || dot === clean.length - 1) return '';
  return clean.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function shortIdFromUrl(url) {
  var qIdx = String(url || '').indexOf('?');
  if (qIdx === -1) return null;
  var params = new URLSearchParams(url.slice(qIdx));
  return params.get('id') || null;
}

// Fetches the real WorkDrive bytes and hands them to the caller (which
// may be WhatsApp/Meta's media fetcher, or the widget's own <img>/<video>
// rendering of chat history).
//
// Deliberately BUFFERS the whole file rather than piping it straight
// through - an earlier version piped, which meant no Content-Length could
// be set and Catalyst's gateway serves such responses as
// `Transfer-Encoding: chunked` with no Content-Length at all. A real
// WhatsApp send test with that version still failed to deliver, even
// after fixing the URL shape (see file header) - comparing response
// headers against a URL that DID deliver successfully showed the working
// one had `Content-Length` + `Accept-Ranges: bytes` (a normal static
// file served by Apache), while the chunked proxy response had neither.
// Not proven which of the two fixes (or both) actually matters, but
// buffering is cheap at these file sizes (capped at MAX_UPLOAD_BYTES) and
// removes the variable entirely rather than leaving it as an open
// question.
// BUG FOUND BY CODE REVIEW (Phase E, not yet confirmed by a real send - see
// note at the fix site below): module.exports below only ever routed
// `req.method === 'GET'` here. A HEAD request to the exact same
// `?id=<shortId>` URL fell through to handleUpload() instead - which reads
// an empty body and returns a 200-wrapped `{statusCode:400, "filename and
// dataBase64 required"}` JSON error, not real media headers. Many media-
// fetching clients issue a preliminary HEAD probe (checking Content-Length/
// Content-Type against platform size/type limits) before the real GET -
// if WhatsApp's business media fetcher does this, it would receive that
// nonsense JSON instead of valid headers and could reject the attachment
// silently, asynchronously - which is an exact match for the reported
// symptom (Engati's API accepts the send with a real messageId, but the
// media never arrives on the phone). This is a genuinely plausible root
// cause identified via static review; it has NOT been confirmed against a
// real WhatsApp send - do that before considering this "the" fix rather
// than "a" fix. See module.exports below for the routing correction.
function streamMedia(req, res) {
  var shortId = shortIdFromUrl(req.url);
  if (!shortId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing media id' }));
    return;
  }
  var isHead = req.method === 'HEAD';

  var catalystApp = catalyst.initialize(req);
  recallMedia(catalystApp, shortId).then(function (mapping) {
    if (!mapping) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(isHead ? undefined : JSON.stringify({ error: 'unknown or expired attachment id' }));
      return;
    }

    var workdriveUrl = buildWorkdriveDownloadUrl({ workdrive_download_host: mapping.downloadHost }, mapping.resourceId, mapping.linkId);
    var parsed = new URL(workdriveUrl);
    // Always issues a real upstream GET, even for a HEAD request - simplest
    // correct behaviour (guarantees an accurate Content-Length) rather than
    // trusting WorkDrive's own HEAD support, which isn't confirmed. Slightly
    // wasteful (fetches the whole file just to answer a HEAD) but this path
    // is rare enough (one probe per attachment, not per byte) that it's not
    // worth the complexity of a separate upstream HEAD until proven to
    // matter.
    var upstreamReq = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET'
    }, function (upstreamRes) {
      var chunks = [];
      upstreamRes.on('data', function (c) { chunks.push(c); });
      upstreamRes.on('end', function () {
        var buffer = Buffer.concat(chunks);
        res.writeHead(upstreamRes.statusCode || 200, {
          'Content-Type': mapping.mimeType || upstreamRes.headers['content-type'] || 'application/octet-stream',
          'Content-Length': buffer.length,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(isHead ? undefined : buffer);
      });
      upstreamRes.on('error', function (err) {
        console.error('[fileUpload] media proxy response read failed: ' + (err && err.message));
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(isHead ? undefined : JSON.stringify({ error: 'failed to read attachment' }));
      });
    });
    upstreamReq.on('error', function (err) {
      console.error('[fileUpload] media proxy fetch failed: ' + (err && err.message));
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(isHead ? undefined : JSON.stringify({ error: 'failed to fetch attachment' }));
    });
    upstreamReq.end();
  }).catch(function (e) {
    console.error('[fileUpload] media cache lookup failed: ' + (e && e.message));
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(isHead ? undefined : JSON.stringify({ error: 'attachment lookup failed' }));
  });
}

// WhatsApp's own per-type media ceilings (images 5MB, audio/video 16MB,
// documents 100MB) are the real limit that matters in theory - but
// Catalyst's Advanced I/O request-body handling has an actual, now-TESTED
// ceiling of its own that's much lower than any of those. Confirmed via
// direct testing (Aug 11 2026): a 25MB raw file uploads and gets a clean
// 413 rejection as expected; a 28MB raw file makes the function return a
// bare HTTP 200 with an EMPTY body (no JSON, not even an error) - the
// platform silently kills/truncates the request somewhere between those
// two sizes, almost certainly because this function fully buffers the
// whole file in memory (readBody() + Buffer.from(base64)) rather than
// streaming it. This means WhatsApp's real 100MB document ceiling is NOT
// achievable with this function's current architecture - would need a
// genuine rewrite to stream/chunk the upload instead of buffering it
// whole, not attempted here. Base64 inflates wire size ~33%, so these
// constants cap the DECODED size, with real margin kept below the ~25-28MB
// point where things start breaking silently.
var MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // images/audio/video
var MAX_DOCUMENT_UPLOAD_BYTES = 20 * 1024 * 1024; // documents (PDF etc.) - see [[workdrive-attachment-research-unfinished]] persistent notes for the DOCUMENT packetType finding this supports

function uploadCapFor(mimeType) {
  return (mimeType === 'application/pdf') ? MAX_DOCUMENT_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
}

function handleUpload(req, res) {
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  readBody(req).then(function (raw) {
    var input;
    try { input = JSON.parse(raw || '{}'); } catch (e) { input = {}; }

    var filename = input.filename;
    var mimeType = input.mimeType;
    var dataBase64 = input.dataBase64;
    var orgId = input.orgId;

    if (!filename || !dataBase64) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'filename and dataBase64 required' }) }));
      return;
    }

    var buffer;
    try {
      buffer = Buffer.from(dataBase64, 'base64');
    } catch (e) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'dataBase64 is not valid base64' }) }));
      return;
    }

    if (!buffer.length) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'file is empty' }) }));
      return;
    }
    var cap = uploadCapFor(mimeType);
    if (buffer.length > cap) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 413, body: JSON.stringify({ error: 'file too large - max ' + Math.round(cap / 1024 / 1024) + 'MB' }) }));
      return;
    }

    var catalystApp = catalyst.initialize(req);

    // Credentials come straight from the request body now (widget-supplied,
    // sourced from CRM Variables) - see file header. `orgConfig`-shaped only
    // to avoid touching the helper functions below; not an actual lookup
    // result. Falls back to process.env inside each accessor function
    // (accountsHost/apiHost/etc., getAccessToken, uploadFile) if a given
    // field wasn't sent - legacy dedicated-project deployments send none of
    // these at all and work unchanged.
    var orgConfig = {
      workdrive_client_id: input.workdriveClientId,
      workdrive_client_secret: input.workdriveClientSecret,
      workdrive_refresh_token: input.workdriveRefreshToken,
      workdrive_folder_id: input.workdriveFolderId,
      workdrive_accounts_host: input.workdriveAccountsHost,
      workdrive_api_host: input.workdriveApiHost,
      workdrive_host: input.workdriveHost,
      workdrive_download_host: input.workdriveDownloadHost
    };

    Promise.resolve()
      .then(function () {
        return getAccessToken(orgConfig).then(function (token) {
          return uploadFile(orgConfig, token, filename, mimeType, buffer).then(function (resourceId) {
            return createPublicLink(orgConfig, token, resourceId, filename).then(function (linkId) {
              return { orgConfig: orgConfig, resourceId: resourceId, linkId: linkId };
            });
          });
        });
      })
      .then(function (result) {
        // Appending the real file extension to the id (e.g.
        // "...&id=aB3xZ.png" instead of "...&id=aB3xZ") is a second,
        // unproven-but-cheap hedge alongside the Content-Length fix above
        // - untested whether WhatsApp's media validation checks for a
        // recognisable extension in the URL itself in addition to (or
        // instead of) trusting Content-Type, but a URL that merely LOOKS
        // like a file is strictly closer to the one proven to work than
        // one that doesn't, so there's no reason not to do it too.
        var ext = extensionFromFilename(filename);
        var shortId = crypto.randomBytes(9).toString('base64url') + (ext ? '.' + ext : '');
        var downloadHostOverride = result.orgConfig && result.orgConfig.workdrive_download_host;
        return rememberMedia(catalystApp, shortId, result.resourceId, result.linkId, mimeType, downloadHostOverride).then(function () {
          return shortId;
        });
      })
      .then(function (shortId) {
        var url = ownBaseUrl(req) + '?id=' + shortId;
        res.writeHead(200, headers);
        res.end(JSON.stringify({ statusCode: 200, body: JSON.stringify({ url: url, filename: filename, mimeType: mimeType }) }));
      })
      .catch(function (e) {
        console.error('[fileUpload] failed for orgId=' + orgId + ': ' + (e && e.message));
        res.writeHead(200, headers);
        res.end(JSON.stringify({ statusCode: 502, body: JSON.stringify({ error: (e && e.message) || String(e) }) }));
      });
  });
}

module.exports = function (req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // See streamMedia's header comment (Phase E finding) - HEAD must route
  // here too, not just GET. A media-fetching client's preliminary HEAD
  // probe falling through to handleUpload() below (which expects an
  // upload POST body) is the leading suspect for why attachments were
  // silently rejected - fixed here, not yet confirmed with a real send.
  if ((req.method === 'GET' || req.method === 'HEAD') && shortIdFromUrl(req.url)) {
    streamMedia(req, res);
    return;
  }

  handleUpload(req, res);
};

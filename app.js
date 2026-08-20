function renderStatus(t){document.getElementById('messages').innerHTML='<div class="status">'+t+'</div>';}
function safeParse(r){try{return typeof r==='string'?JSON.parse(r):r;}catch(e){return null;}}
function parseEngatiTimestamp(ts){
if(!ts) return null;
var iso = String(ts).replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3').replace(' ', 'T');
iso = iso.replace(/T(\d{2}):(\d{2}):(\d{2}\.\d+)([+-]\d{4})$/, function(_, h, mi, s, tz){
return 'T'+h+':'+mi+':'+s+tz.slice(0,3)+':'+tz.slice(3);
});
var d = new Date(iso);
return isNaN(d.getTime()) ? null : d;
}
function formatTimestamp(d){
if(!d) return '';
var opts = {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'};
return d.toLocaleString(undefined, opts);
}
// Engati's /conversations returns several message_type values beyond plain
// TEXT, and the widget used to dump each one's raw payload straight into a
// chat bubble. Observed in the live conversation:
//   AGENT_PARTICIPATION_STATUS -> rendered the literal JSON
//     {"agentId":128654,"PARTICIPATION_MESSAGE":"Adlinks Test<\/strong> joined..."}
//   OPTIONS                    -> rendered the literal array "[⭐, ⭐⭐, ⭐⭐⭐]"
// These classify/format them instead.

// Pulls the human sentence out of an AGENT_PARTICIPATION_STATUS payload.
// Engati embeds HTML in it ("<strong>Name</strong> joined the conversation"),
// so tags are stripped rather than injected - everything else in this UI uses
// textContent and we don't want raw markup reaching the DOM.
function participationText(raw){
var parsed = safeParse(raw);
var msg = (parsed && parsed.PARTICIPATION_MESSAGE) || '';
return msg ? String(msg).replace(/<[^>]*>/g, '').trim() : '';
}

function mediaKindFor(url, messageType, mime){
// The MIME type Engati sends alongside the file is the most reliable signal
// and is checked first: inbound media all arrives as message_type
// FILE_RECEIVED regardless of kind, and the URL's extension can be mangled
// by their storage layer ("...jpeg-NUBM6.jpeg"). messageType and the
// extension stay as fallbacks for outbound/echoed messages, which do carry
// a real IMAGE/VIDEO/AUDIO/DOCUMENT type.
var mt = String(mime || '').toLowerCase().split(';')[0].trim();
if(mt.indexOf('image/') === 0) return 'image';
if(mt.indexOf('video/') === 0) return 'video';
if(mt.indexOf('audio/') === 0) return 'audio';
if(mt.indexOf('application/') === 0 || mt.indexOf('text/') === 0) return 'document';
var t = String(messageType || '').toUpperCase();
if(t === 'IMAGE' || t === 'VIDEO' || t === 'AUDIO'){ return t.toLowerCase(); }
if(t === 'DOCUMENT'){ return 'document'; }
var u = String(url || '').toLowerCase().split('#')[0].split('?')[0];
if(/\.(jpg|jpeg|png|gif|webp)$/.test(u)) return 'image';
if(/\.(mp4|3gp|mov|webm)$/.test(u)) return 'video';
if(/\.(mp3|ogg|m4a|amr|aac|wav)$/.test(u)) return 'audio';
if(/\.pdf$/.test(u)) return 'document';
return 'file';
}

// Confirmed against a real inbound WhatsApp photo (Aug 12): Engati's
// /conversations returns media as message_type FILE_RECEIVED with the real
// URL nested in a `file` OBJECT - {url, mimeType, uploadType} - while
// `response` carries only a placeholder sentence ("User uploaded <name> -
// [<mime>]") and `attachments` is null.
//
// The original version treated `m.file` as a string, so an object fell
// through to `attachments`, found null, and returned null before ever
// reaching the "unrecognised shape" log below. That silent path is why every
// inbound photo rendered as the placeholder text instead of an image, with
// nothing in the debug log to explain it. The string/array shapes are kept
// as fallbacks - they cost nothing and were never disproved.
//
// Returns {url, mime} rather than a bare URL because mimeType is the only
// reliable way to tell an image from a voice note from a PDF here.
function extractMedia(m){
var f = m.file || (m.media && m.media.value) || null;
if(f && typeof f === 'object'){
var u = f.url || f.value || f.link || null;
return u ? { url: u, mime: f.mimeType || f.mime_type || null } : null;
}
if(typeof f === 'string' && f){
return { url: f, mime: (m.media && (m.media.mimeType || m.media.mime_type)) || null };
}
var att = m.attachments;
if(!att) return null;
if(typeof att === 'string') return { url: att, mime: null };
if(Array.isArray(att) && att.length){
var first = att[0];
if(typeof first === 'string') return { url: first, mime: null };
if(first && typeof first === 'object'){
var fu = first.url || first.value || first.link;
return fu ? { url: fu, mime: first.mimeType || first.mime_type || null } : null;
}
}
if(typeof att === 'object'){
var au = att.url || att.value || att.link;
if(au) return { url: au, mime: att.mimeType || att.mime_type || null };
}
showDebug('extractMedia: unrecognised attachment shape: ' + JSON.stringify(att).slice(0, 300));
return null;
}

// Engati's placeholder text for an inbound file, e.g.
// "User uploaded invoice.pdf - [application/pdf]". Not something the
// customer typed, so it must never be shown as a caption under the media -
// but the filename inside it is the only human-readable name we get, and
// it's what the document renderer labels its link with.
var UPLOAD_PLACEHOLDER_RE = /^User uploaded\s+(.*?)\s+-\s+\[[^\]]*\]\s*$/;

// Turns one raw Engati message into what the UI needs to draw it.
function toDisplayMessage(m){
var d = parseEngatiTimestamp(m.timestamp);
var type = String(m.message_type || '').toUpperCase();
var base = {
direction: (m.sender === 'bot' ? 'out' : 'in'),
time: formatTimestamp(d),
ts: d ? d.getTime() : 0,
status: 'delivered'
};
if(type === 'AGENT_PARTICIPATION_STATUS'){
base.kind = 'system';
base.text = participationText(m.response);
return base;
}
var media = extractMedia(m);
if(media){
base.kind = 'media';
base.mediaUrl = media.url;
base.mediaKind = mediaKindFor(media.url, type, media.mime);
// Media messages can carry a real caption alongside the file, but on an
// inbound FILE_RECEIVED `response` is Engati's own placeholder - showing
// that would just repeat the filename under the image. Strip it, and reuse
// the filename it contains to label document links.
var caption = (typeof m.response === 'string' && m.response !== media.url) ? m.response : '';
var placeholder = UPLOAD_PLACEHOLDER_RE.exec(caption);
if(placeholder){
base.mediaFilename = placeholder[1] || '';
base.text = '';
} else {
base.text = caption;
}
return base;
}
base.kind = 'text';
base.text = m.response || m.text || '';
return base;
}

function appendMediaTo(container, msg){
var kind = msg.mediaKind;
var node;
if(kind === 'image'){
node = document.createElement('img');
node.src = msg.mediaUrl;
node.alt = 'Image attachment';
node.loading = 'lazy';
// Thumbnails are capped in CSS so a photo can't dominate the panel, so
// there has to be a way to see the full-size original - the zoom-in
// cursor has always implied one existed. Opens in a new tab rather than
// building a lightbox, which would have to fight the iframe's bounds.
node.title = 'Open full size';
node.addEventListener('click', function(){ window.open(msg.mediaUrl, '_blank', 'noopener'); });
} else if(kind === 'video'){
node = document.createElement('video');
node.src = msg.mediaUrl;
node.controls = true;
node.preload = 'metadata';
} else if(kind === 'audio'){
node = document.createElement('audio');
node.src = msg.mediaUrl;
node.controls = true;
node.preload = 'metadata';
} else if(kind === 'document'){
// className is set below by the shared 'bubble-media bubble-media-' +
// kind line, same as every other kind - not set here to avoid it being
// silently overwritten.
node = document.createElement('a');
node.href = msg.mediaUrl;
node.target = '_blank';
node.rel = 'noopener noreferrer';
node.textContent = '📄 ' + (msg.mediaFilename || 'Open PDF');
} else {
// Unknown type (sticker, anything new) - a link is always safe.
node = document.createElement('a');
node.href = msg.mediaUrl;
node.target = '_blank';
node.rel = 'noopener noreferrer';
node.textContent = 'Open attachment';
}
node.className = 'bubble-media bubble-media-' + kind;
// A broken media URL shouldn't leave an invisible gap with no explanation -
// this is exactly the 131053 class of failure, where the URL is accepted but
// unfetchable.
if(kind === 'image' || kind === 'video' || kind === 'audio'){
node.onerror = function(){
var fallback = document.createElement('a');
fallback.href = msg.mediaUrl;
fallback.target = '_blank';
fallback.rel = 'noopener noreferrer';
fallback.className = 'bubble-media-failed';
fallback.textContent = 'Attachment could not be loaded - open directly';
if(node.parentNode){ node.parentNode.replaceChild(fallback, node); }
};
}
container.appendChild(node);
}

function renderMessages(list){
var el=document.getElementById('messages');
el.innerHTML='';
if(!list||!list.length){renderStatus('No messages found.');return;}
list.forEach(function(m){
// System notes (agent joined/left) aren't messages from either party, so
// they're drawn as a centered note rather than a chat bubble.
if(m.kind === 'system'){
if(!m.text) return;
var sys=document.createElement('div');
sys.className='system-note';
sys.textContent=m.text+(m.time?' · '+m.time:'');
el.appendChild(sys);
return;
}
var d=document.createElement('div');
d.className='bubble '+(m.direction==='out'?'out':'in');
if(m.kind === 'media' && m.mediaUrl){
appendMediaTo(d, m);
}
// Media messages only get a text node if they actually carry a caption.
if(m.kind !== 'media' || m.text){
var textEl=document.createElement('div');
textEl.className='bubble-text';
textEl.textContent=m.text||'';
d.appendChild(textEl);
}
if(m.time){
var timeEl=document.createElement('div');
timeEl.className='bubble-time';
var tickEl=document.createElement('span');
// Honest status marker, outbound messages only. A "success" response from
// Engati's API (or the message appearing in their Conversation History)
// does NOT mean WhatsApp delivered it - proven on Aug 13 2026, when two
// sends each returned HTTP 200 with a real messageId and both came back as
// STATUS_PACKET code 1002 FAILED. So a tick here only ever means "Engati
// accepted the packet", never "the customer got it".
//
// What IS authoritative is a STATUS_PACKET, which arrives asynchronously on
// our webhook and is surfaced by attachDeliveryFailures() below. When one
// matches this message, the tick is replaced by a red \u2717 carrying Engati's
// own code and description - the only real delivery signal this integration
// has.
if(m.failure){
tickEl.className='ticks failed';
tickEl.textContent=' \u2717';
tickEl.title='NOT delivered - Engati reported '
+ (m.failure.code ? m.failure.code + ': ' : '')
+ (m.failure.description || 'delivery failed')
+ (m.failure.code === 1002 ? '\n\nThe 24-hour WhatsApp window has closed. Only template messages can be sent until the customer replies.' : '');
} else {
tickEl.className='ticks'+(m.status==='read'?' read':'');
tickEl.textContent=(m.status==='sent'?' \u2713':' \u2713\u2713');
if(m.direction === 'out'){
tickEl.title = (m.status==='sent')
? 'Sent to Engati - not yet confirmed received'
: 'Accepted by Engati. This is NOT delivery confirmation - WhatsApp delivery is only reported when it FAILS, via a status packet.';
}
}
timeEl.textContent=m.time;
timeEl.appendChild(tickEl);
d.appendChild(timeEl);
}
el.appendChild(d);
});
el.scrollTop=el.scrollHeight;
}
// Default country code used only for numbers stored WITHOUT one. Set per org
// via the DEFAULT_COUNTRY_CODE variable - a customer in the US needs "1", the
// UK "44", etc. Defaults to India for backward compatibility with the original
// org, which is where this widget started.
var DEFAULT_COUNTRY_CODE = '91';

// WhatsApp/Engati identify a user by their full international number, digits
// only, no "+". CRM records store phone numbers inconsistently though, so this
// normalises the common shapes.
//
// The previous version did `if(digits.length === 10) digits = '91' + digits`,
// which hardcoded India for ANY 10-digit number - a US number like 4155551234
// became 914155551234. That breaks the moment a customer outside India (or an
// Indian customer with overseas contacts) uses this.
function normalizePhone(phone){
var raw = String(phone == null ? '' : phone).trim();
// A leading "+" or "00" means the number already carries its country code.
var isInternational = /^\+/.test(raw) || /^00\d/.test(raw);
var digits = raw.replace(/[^0-9]/g, '');
if(/^00\d/.test(raw)){ digits = digits.replace(/^00/, ''); }
if(!digits) return '';
if(isInternational) return digits;
// A leading 0 is a national trunk prefix (UK, DE, AU, ZA...) - it is dropped
// when dialling internationally and replaced by the country code.
if(/^0/.test(digits)){ return DEFAULT_COUNTRY_CODE + digits.replace(/^0+/, ''); }
// 10 digits or fewer is a bare national number needing a country code.
// Longer than that already includes one - importantly this is decided by
// length, not by sniffing for a leading "91", because plenty of valid Indian
// mobiles legitimately start with 91 themselves.
if(digits.length <= 10){ return DEFAULT_COUNTRY_CODE + digits; }
return digits;
}
var pollTimer = null;
var lastSignature = null;
var POLL_INTERVAL_MS = 2000;
var failureTimer = null;
// Status packets land seconds after a send and are then immutable, so this
// polls the Data Store much less aggressively than the 2s conversation poll.
var FAILURE_POLL_INTERVAL_MS = 15000;
var currentPhone = null;var lastMappedMessages = [];var localSentMessages = [];
// Delivery failures from Engati STATUS_PACKETs, newest-first. Populated by
// fetchDeliveryFailures(); consumed by attachDeliveryFailures().
var deliveryFailures = [];
// CORRECTED Aug 9, 2026: an earlier version of this preferred a UUID
// captured from /conversations, on the theory that AGENT_MESSAGE had to
// address Engati's "internal" id. That was wrong. Inspecting the real
// LiveChatEvents webhook rows showed those UUIDs only ever appear on
// packets with platform:"web" (i.e. someone testing via the web chat
// widget). Actual WhatsApp traffic for this bot arrives with
// platform:"dialog360" and user_id set to the plain phone number
// (e.g. "919061084736"). So sending AGENT_MESSAGE addressed to the UUID
// was targeting a web-channel user that doesn't exist on WhatsApp -
// which is why it was silently dropped with no STATUS_PACKET at all.
// Keep this null unless a non-UUID id is genuinely observed; the phone
// number is the correct target for WhatsApp.
var currentEngatiUserId = null;
// Channel/platform Engati uses for this conversation. Engati's own
// packets for this bot's WhatsApp channel say "dialog360", NOT
// "whatsapp" - captured from inbound webhook packets rather than
// assumed, since it's provider-specific (a bot on a different WhatsApp
// BSP would report something else).
var currentEngatiPlatform = null;
var ENGATI_CUSTOMER_ID = null;
var ENGATI_BOT_ID = null;
var ENGATI_API_KEY = null;
var ENGATI_INBOUND_MESSAGE_WEBHOOK_URL = null; // optional - only needed for free-text/attachments via External Live Chat
var ENGATI_INBOUND_API_KEY = null; // optional - only if this org set one up in Engati's Configure screen
// NOT the same value as ENGATI_CUSTOMER_ID, despite both looking like "the
// bot's ID". ENGATI_CUSTOMER_ID (labelled "Customer Identifier" in Engati's
// own Integrations screen) is a short number and is correct for the
// Conversation History and Template APIs. This is a different, longer,
// base64-looking token that only shows up in the top-level "botIdentifier"
// field of a genuine (bot-flow-triggered, not manually agent-picked-up)
// START_CHAT packet - e.g. "eyJib3RSZWYiOjE0NzkxNCwidXNlcnNCb3RSZWYiOjE0NzkxNH0="
// decodes to {"botRef":147914,"usersBotRef":147914}. Every AGENT_MESSAGE
// sent with ENGATI_CUSTOMER_ID here was silently accepted (200, real
// messageId, errorCode:null) and never delivered - see ES-58715. See
// SETUP.md for how to capture the real value on a new bot.
var ENGATI_LIVECHAT_BOT_IDENTIFIER = null;
// WorkDrive (attachments) - same CRM-Variables pattern as the Engati fields
// above (see plan's "Correction" section: Zoho's confirmed guidance for
// per-org third-party credentials is CRM Variables, not a custom Data Store
// table - fileUpload no longer looks these up from OrgConfig). All optional
// - attachments just stay unavailable for this org until set, same "not a
// hard failure" treatment as ENGATI_INBOUND_MESSAGE_WEBHOOK_URL above.
var WORKDRIVE_CLIENT_ID = null;
var WORKDRIVE_CLIENT_SECRET = null;
var WORKDRIVE_REFRESH_TOKEN = null;
var WORKDRIVE_FOLDER_ID = null;
var WORKDRIVE_ACCOUNTS_HOST = null;
var WORKDRIVE_API_HOST = null;
var WORKDRIVE_HOST = null;
var WORKDRIVE_DOWNLOAD_HOST = null;
// --- Multi-tenancy (Marketplace migration, see plan Phase A) ---------------
// Historically each customer ran their OWN dedicated Catalyst project, and
// the widget found it via a per-org CATALYST_BASE_URL CRM Variable
// (applyCatalystBaseUrl below). That mode still works untouched, for
// existing customers - see plan Phase F, no forced cutover.
//
// New installs (via the Marketplace extension) don't get their own Catalyst
// project at all: they share ONE multi-tenant backend, and every request
// carries this org's CRM org id (CURRENT_ORG_ID) so the shared functions can
// look up that org's Engati/CRM/WorkDrive config from the OrgConfig table
// instead of from process-wide env vars. See functions/liveChatSender,
// functions/liveChatWebhook, functions/fileUpload, functions/whatsappProxy.
//
// SHARED_CATALYST_BASE_URL itself lives in sharedConfig.js (loaded before
// this file, see index.html) so it can't drift out of sync with settings.js's
// copy - see that file's header comment for the deploy TODO.
// NOT read automatically anymore (see below) - this used to be the silent
// fallback for the one legacy org that predates the CATALYST_BASE_URL
// variable. Auto-falling-back to one specific customer's project is exactly
// the cross-tenant leak this migration removes: ANY org that forgets to set
// CATALYST_BASE_URL now falls back to the shared multi-tenant backend
// instead (safe, org-scoped via CURRENT_ORG_ID). That one legacy org must
// therefore have this value set as its explicit CATALYST_BASE_URL variable
// (a one-time, no-code migration step) - kept here only as the value to
// paste in for that.
var LEGACY_DEFAULT_CATALYST_BASE_URL = "https://project-rainfall-60081410942.catalystserverless.in"; // eslint-disable-line no-unused-vars
var CATALYST_PROXY_URL = SHARED_CATALYST_BASE_URL + "/server/whatsappProxy/";
var LIVE_CHAT_SENDER_PROXY_URL = SHARED_CATALYST_BASE_URL + "/server/liveChatSender/";
var FILE_UPLOAD_PROXY_URL = SHARED_CATALYST_BASE_URL + "/server/fileUpload/";
// Set once per session by loadConfigFromVariables(). Every backend POST body
// should include this as `orgId` so shared, multi-tenant functions can
// resolve which OrgConfig row to use. Harmless to send even in legacy
// dedicated-project mode - those functions just ignore the extra field.
//
// TODO(verify): ZOHO.CRM.CONFIG.getOrgInfo()'s exact response shape hasn't
// been confirmed against a live widget yet - the field used below (ZGID) is
// this SDK's documented org identifier, but re-check against the real
// response (see showDebug logging in loadConfigFromVariables) before relying
// on it for tenant isolation in production.
var CURRENT_ORG_ID = null;
var configReadyPromise = null;

// Builds the three function endpoints from whatever base URL this org
// explicitly supplied (legacy dedicated-project mode only). Tolerates a
// trailing slash, and a value that already includes "/server".
function applyCatalystBaseUrl(baseUrl){
var base = String(baseUrl || '').trim().replace(/\/+$/, '');
if(!base){ return false; }
base = base.replace(/\/server$/, '');
CATALYST_PROXY_URL = base + '/server/whatsappProxy/';
LIVE_CHAT_SENDER_PROXY_URL = base + '/server/liveChatSender/';
FILE_UPLOAD_PROXY_URL = base + '/server/fileUpload/';
return true;
}

function loadConfigFromVariables(){
  if(configReadyPromise){ return configReadyPromise; }
  configReadyPromise = Promise.all([
    ZOHO.CRM.API.getOrgVariable("ENGATI_CUSTOMER_ID"),
    ZOHO.CRM.API.getOrgVariable("ENGATI_BOT_ID"),
    ZOHO.CRM.API.getOrgVariable("ENGATI_API_KEY"),
    ZOHO.CRM.API.getOrgVariable("ENGATI_INBOUND_MESSAGE_WEBHOOK_URL"),
    ZOHO.CRM.API.getOrgVariable("ENGATI_INBOUND_API_KEY"),
    ZOHO.CRM.API.getOrgVariable("CATALYST_BASE_URL"),
    ZOHO.CRM.API.getOrgVariable("DEFAULT_COUNTRY_CODE"),
    ZOHO.CRM.API.getOrgVariable("ENGATI_LIVECHAT_BOT_IDENTIFIER"),
    ZOHO.CRM.CONFIG.getOrgInfo(),
    ZOHO.CRM.API.getOrgVariable("WORKDRIVE_CLIENT_ID"),
    ZOHO.CRM.API.getOrgVariable("WORKDRIVE_CLIENT_SECRET"),
    ZOHO.CRM.API.getOrgVariable("WORKDRIVE_REFRESH_TOKEN"),
    ZOHO.CRM.API.getOrgVariable("WORKDRIVE_FOLDER_ID"),
    ZOHO.CRM.API.getOrgVariable("WORKDRIVE_ACCOUNTS_HOST"),
    ZOHO.CRM.API.getOrgVariable("WORKDRIVE_API_HOST"),
    ZOHO.CRM.API.getOrgVariable("WORKDRIVE_HOST"),
    ZOHO.CRM.API.getOrgVariable("WORKDRIVE_DOWNLOAD_HOST")
  ]).then(function(results){
    showDebug('getOrgVariable raw response[0]: ' + JSON.stringify(results[0]).slice(0,500));
    showDebug('getOrgVariable raw response[1]: ' + JSON.stringify(results[1]).slice(0,500));
    showDebug('getOrgVariable raw response[2]: ' + JSON.stringify(results[2]).slice(0,500));
    ENGATI_CUSTOMER_ID = (results[0] && results[0].Success && results[0].Success.Content) || null;
    ENGATI_BOT_ID = (results[1] && results[1].Success && results[1].Success.Content) || null;
    ENGATI_API_KEY = (results[2] && results[2].Success && results[2].Success.Content) || null;
    // Optional - free-text/attachments simply stay unavailable (not a hard
    // failure) if these aren't set for this org yet.
    ENGATI_INBOUND_MESSAGE_WEBHOOK_URL = (results[3] && results[3].Success && results[3].Success.Content) || null;
    ENGATI_INBOUND_API_KEY = (results[4] && results[4].Success && results[4].Success.Content) || null;

    // This org's CRM org id - needed on every shared-backend call so the
    // multi-tenant functions can resolve its OrgConfig row. See TODO on
    // CURRENT_ORG_ID's declaration re: verifying this response shape.
    showDebug('getOrgInfo raw response: ' + JSON.stringify(results[8]).slice(0,500));
    var orgInfo = results[8] && results[8].org && results[8].org[0];
    CURRENT_ORG_ID = (orgInfo && (orgInfo.ZGID || orgInfo.id)) || null;
    if(!CURRENT_ORG_ID){
      showDebug('WARNING: could not resolve CURRENT_ORG_ID from getOrgInfo() - shared multi-tenant backend calls will be unscoped until this is fixed.');
    }

    // Legacy dedicated-project mode, unchanged: if this org explicitly set
    // CATALYST_BASE_URL, point at their own Catalyst project.
    var catalystBaseUrl = (results[5] && results[5].Success && results[5].Success.Content) || null;
    if(applyCatalystBaseUrl(catalystBaseUrl)){
      showDebug('CATALYST_BASE_URL from org variable (legacy dedicated-project mode): ' + catalystBaseUrl);
    } else {
      showDebug('CATALYST_BASE_URL not set for this org - using the shared multi-tenant backend (org-scoped via CURRENT_ORG_ID), see SETUP.md.');
    }
    // Country code applied only to phone numbers stored without one.
    var countryCode = (results[6] && results[6].Success && results[6].Success.Content) || null;
    if(countryCode){
      DEFAULT_COUNTRY_CODE = String(countryCode).replace(/[^0-9]/g, '') || DEFAULT_COUNTRY_CODE;
      showDebug('DEFAULT_COUNTRY_CODE from org variable: ' + DEFAULT_COUNTRY_CODE);
    } else {
      showDebug('DEFAULT_COUNTRY_CODE not set - defaulting to ' + DEFAULT_COUNTRY_CODE + ' (India). Orgs outside India must set this, or national-format numbers will get the wrong country code.');
    }
    // Distinct from ENGATI_CUSTOMER_ID - see the declaration comment above
    // for why these are two different values despite both looking like "the
    // bot ID". Free-text sending just stays unavailable (not a hard
    // failure) if this isn't set yet, same as the inbound webhook URL.
    ENGATI_LIVECHAT_BOT_IDENTIFIER = (results[7] && results[7].Success && results[7].Success.Content) || null;
    if(!ENGATI_LIVECHAT_BOT_IDENTIFIER){
      showDebug('ENGATI_LIVECHAT_BOT_IDENTIFIER not set - free-text sending will be accepted by Engati but silently never delivered. See SETUP.md.');
    }

    WORKDRIVE_CLIENT_ID = (results[9] && results[9].Success && results[9].Success.Content) || null;
    WORKDRIVE_CLIENT_SECRET = (results[10] && results[10].Success && results[10].Success.Content) || null;
    WORKDRIVE_REFRESH_TOKEN = (results[11] && results[11].Success && results[11].Success.Content) || null;
    WORKDRIVE_FOLDER_ID = (results[12] && results[12].Success && results[12].Success.Content) || null;
    WORKDRIVE_ACCOUNTS_HOST = (results[13] && results[13].Success && results[13].Success.Content) || null;
    WORKDRIVE_API_HOST = (results[14] && results[14].Success && results[14].Success.Content) || null;
    WORKDRIVE_HOST = (results[15] && results[15].Success && results[15].Success.Content) || null;
    WORKDRIVE_DOWNLOAD_HOST = (results[16] && results[16].Success && results[16].Success.Content) || null;
    if(!WORKDRIVE_CLIENT_ID || !WORKDRIVE_REFRESH_TOKEN || !WORKDRIVE_FOLDER_ID){
      showDebug('WorkDrive CRM Variables not fully set for this org - file attachments will be unavailable until WORKDRIVE_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN/FOLDER_ID are set. See SETUP.md.');
    }

    if(!ENGATI_CUSTOMER_ID || !ENGATI_BOT_ID || !ENGATI_API_KEY){
      renderStatus('WhatsApp integration is not configured. Please set ENGATI_CUSTOMER_ID, ENGATI_BOT_ID and ENGATI_API_KEY under Setup > Developer Hub > Variables.');
      throw new Error('Missing configuration variables');
    }
  }).catch(function(err){
    renderStatus('Could not load WhatsApp configuration. Please check Setup > Developer Hub > Variables.');
    throw err;
  });
  return configReadyPromise;
}

// How far before a local send we'll still accept a server message as being
// that same message. Generous, because the server's clock and ours can drift
// and Engati stamps the message when it processes it, not when we sent it.
var ECHO_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

// Drops locally-echoed sends once the server confirms them, so a message
// doesn't appear twice while polling catches up.
//
// The matching is one-to-one and timestamp-aware on purpose. A previous
// version matched on text alone (`sm.text === lm.text`), which broke in two
// user-visible ways:
//   - Sending the same text twice: the first server copy matched BOTH local
//     copies, so the second message vanished from the UI until the next poll.
//   - Sending text that already exists earlier in the history (e.g. "hi"
//     sent again days later): the old server message matched the new local
//     one, so the new message disappeared immediately and looked unsent.
// Now each server message can confirm at most one local message, and only
// if it isn't older than that local send.
function dropConfirmedLocalEchoes(localMsgs, serverMsgs){
var claimed = {};
return localMsgs.filter(function(lm){
for(var i = 0; i < serverMsgs.length; i++){
var sm = serverMsgs[i];
if(claimed[i]) continue;
if(sm.direction !== 'out') continue;
if(sm.text !== lm.text) continue;
// Reject server messages that predate this local send - those are older
// history that merely happens to share the same text.
if(sm.ts && lm.ts && sm.ts < lm.ts - ECHO_MATCH_TOLERANCE_MS) continue;
claimed[i] = true;
return false;
}
return true;
});
}

// Engati's STATUS_PACKET carries NO message id - the real captured packet has
// "messageAckId":null - so a failure cannot be correlated to a specific
// message the way a normal delivery receipt would be. All it gives is a user
// and a timestamp.
//
// So this matches each failure to the nearest preceding outbound message,
// within a window. That is a heuristic, and it is the best the data allows;
// the window keeps it from silently blaming an unrelated older message when
// a failure arrives with nothing near it. Failures are applied newest-first
// and each message is claimed at most once, so two failures can't collapse
// onto the same bubble.
var MAX_FAILURE_MATCH_MS = 5 * 60 * 1000;
function attachDeliveryFailures(messages, failures){
messages.forEach(function(m){ m.failure = null; });
if(!failures || !failures.length) return messages;
var outbound = messages.filter(function(m){ return m.direction === 'out' && m.ts; })
.sort(function(a,b){ return b.ts - a.ts; });
failures.slice().sort(function(a,b){ return b.ts - a.ts; }).forEach(function(f){
for(var i = 0; i < outbound.length; i++){
var m = outbound[i];
if(m.failure) continue;
if(m.ts <= f.ts && (f.ts - m.ts) <= MAX_FAILURE_MATCH_MS){ m.failure = f; return; }
}
});
return messages;
}

// Polls the STATUS_PACKETs our webhook stored for this user. Failure is
// non-fatal by design: this is an overlay on a conversation that renders
// fine without it, so any error just leaves the ticks as they were.
function fetchDeliveryFailures(phone){
if(!LIVE_CHAT_SENDER_PROXY_URL || !phone){ return Promise.resolve(); }
return fetch(LIVE_CHAT_SENDER_PROXY_URL, {
method: 'POST',
// text/plain to stay a CORS "simple request" - see sendFreeTextMessage().
headers: { 'Content-Type': 'text/plain' },
body: JSON.stringify({ action: 'getStatusPackets', phone: phone, orgId: CURRENT_ORG_ID })
}).then(function(r){ return r.text(); }).then(function(raw){
var outer = safeParse(raw);
var inner = outer && safeParse(outer.body);
var list = (inner && inner.statuses) || [];
deliveryFailures = list.filter(function(s){ return s && s.ts; });
showDebug('fetchDeliveryFailures: ' + deliveryFailures.length + ' failure packet(s)');
renderMerged(false);
}).catch(function(e){
showDebug('fetchDeliveryFailures failed (non-fatal): ' + (e && e.message));
});
}

function renderMerged(isInitial){ localSentMessages = dropConfirmedLocalEchoes(localSentMessages, lastMappedMessages); var merged = lastMappedMessages.concat(localSentMessages).sort(function(a,b){ return (a.ts||0)-(b.ts||0); }); attachDeliveryFailures(merged, deliveryFailures); var signature2 = JSON.stringify(merged); showDebug('renderMerged: mapped='+lastMappedMessages.length+' local='+localSentMessages.length+' merged='+merged.length+' sigChanged='+(signature2!==lastSignature)); if(signature2 === lastSignature){ return; } var el2 = document.getElementById('messages'); var wasNearBottom2 = isInitial || isNearBottom(el2); lastSignature = signature2; renderMessages(merged); if(!wasNearBottom2){ el2.scrollTop = el2.scrollHeight - el2.clientHeight - 60; } } function isNearBottom(el){
return (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
}

function fetchConversation(phone, isInitial){
var url = "https://api.engati.ai/bot-api/v1.0/customer/" + ENGATI_CUSTOMER_ID + "/bot/" + ENGATI_BOT_ID + "/channel-user/" + phone + "/conversations?page_size=50";
return ZOHO.CRM.HTTP.get({
url: url,
headers: { "Authorization": "Basic " + ENGATI_API_KEY }
}).then(function(resp){
var data = safeParse(resp);
if(!data || data.error){
if(isInitial){ renderStatus('Could not load conversation.'); }
return;
}
var body = data.body || data.details || data;
var bodyParsed = safeParse(body) || body;
var list = (bodyParsed && (bodyParsed.conversations || bodyParsed.messages)) || data.conversations || data.messages || []; showDebug('fetchConversation: server list.length='+list.length+' status_code='+data.status_code);
if(isInitial && list.length){ var lastOut = list.slice().reverse().find(function(m){ return m.sender==='bot'; }); if(lastOut){ showDebug('FULL raw bot message keys: ' + JSON.stringify(lastOut)); console.log('[Whatsyoo] FULL raw bot message keys:', JSON.stringify(lastOut)); } }
var mapped = list.map(function(m){
var display = toDisplayMessage(m);
display.user_id = m.user_id || null;
return display;
});
// WhatsApp's 24-hour customer-service-window rule: outside 24h since the
// user's last inbound message, only template messages can be sent - free
// text/AGENT_MESSAGE gets rejected. Engati's own error code for this is
// 1002 USER_IS_OUTSIDE_CONVERSATION_WINDOW. We can't call that API to ask
// in advance, so this banner is a same-side heuristic from the last
// inbound message timestamp we've already fetched - a warning, not a
// guarantee (Engati's own window calculation is the actual authority).
var lastInboundTs = mapped.slice().reverse().find(function(m){ return m.direction === 'in' && m.ts; });
updateWindowBanner(lastInboundTs ? lastInboundTs.ts : null);
// Deliberately NOT capturing a user_id here any more - see the
// currentEngatiUserId comment at the top of this file. The ids that
// appear in /conversations for this bot are web-widget session UUIDs,
// not the WhatsApp channel-user id, and addressing AGENT_MESSAGE to them
// causes silent drops. The phone number is the correct target.
lastMappedMessages = mapped; renderMerged(isInitial); return;
if(signature === lastSignature){ return; }
var el = document.getElementById('messages');
var wasNearBottom = isInitial || isNearBottom(el);
lastSignature = signature;
renderMessages(mapped);
if(!wasNearBottom){
el.scrollTop = el.scrollHeight - el.clientHeight - 60;
}
}).catch(function(){
if(isInitial){ renderStatus('Error loading conversation.'); }
});
}

// True when the CRM value carried no country code of its own, so normalizePhone
// had to fall back to DEFAULT_COUNTRY_CODE. That fallback can only ever assume
// ONE country, so in an org that deals with several it is a guess - and a wrong
// guess fails silently (Engati still returns SUCCESS and a wamid, the message
// just never arrives). Surfacing it turns that into something an agent can see.
// Mirrors normalizePhone's branches exactly - both places where it falls back
// to DEFAULT_COUNTRY_CODE must be flagged here, including the leading-zero
// trunk-prefix branch (an 11-digit "09061084736" also gets a country code
// prepended, so a length check alone misses it).
function countryCodeWasGuessed(rawPhone){
var raw = String(rawPhone == null ? '' : rawPhone).trim();
if(!raw) return false;
if(/^\+/.test(raw) || /^00\d/.test(raw)) return false;
var digits = raw.replace(/[^0-9]/g, '');
if(!digits) return false;
return /^0/.test(digits) || digits.length <= 10;
}

function updateCountryCodeBanner(rawPhone, normalised){
var el = document.getElementById('countryBanner');
if(!el) return;
if(!countryCodeWasGuessed(rawPhone)){ el.style.display = 'none'; return; }
el.textContent = '⚠ "' + rawPhone + '" has no country code, so +' + DEFAULT_COUNTRY_CODE
  + ' was assumed → +' + normalised + '. If this contact is in another country, '
  + 'fix the number in CRM (store it with a leading +) or the message will silently not arrive.';
el.style.display = 'block';
}

function loadConversation(phone){
renderStatus('Loading conversation...');
var rawPhone = phone;
phone = normalizePhone(phone);
updateCountryCodeBanner(rawPhone, phone);
currentPhone = phone;
if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
// Cleared alongside pollTimer so re-initialising on a different record can't
// leave a second interval running against the previous phone number.
if(failureTimer){ clearInterval(failureTimer); failureTimer = null; }
deliveryFailures = [];
fetchConversation(phone, true).then(function(){
pollTimer = setInterval(function(){ fetchConversation(phone, false); }, POLL_INTERVAL_MS);
});
// Status packets arrive seconds after a send and then don't change, so this
// polls far more slowly than the conversation itself - no need to hit the
// Data Store every 2s. Also fired right after each send (see below), which
// is when a new failure is actually likely to appear.
fetchDeliveryFailures(phone);
failureTimer = setInterval(function(){ fetchDeliveryFailures(phone); }, FAILURE_POLL_INTERVAL_MS);
}

// NOTE: /broadcast (the old direct-to-Engati free-text call) is permanently
// blocked without Engati's paid External Live Chat add-on - confirmed via
// support ticket ES-58564. This function now goes through the AGENT_MESSAGE
// path instead (see catalyst-functions/liveChatSender/), which is the
// mechanism Engati's docs describe for that feature. It will fail until
// External Live Chat is confirmed enabled for this org's bot AND this org
// has set ENGATI_INBOUND_MESSAGE_WEBHOOK_URL - that's expected, not a bug,
// for orgs that haven't set that up yet.
function sendFreeTextMessage(phone, text, media){
if(!ENGATI_INBOUND_MESSAGE_WEBHOOK_URL){
return Promise.resolve(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'Free-text sending is not configured for this org. Set ENGATI_INBOUND_MESSAGE_WEBHOOK_URL under Setup > Developer Hub > Variables once Engati confirms External Live Chat is enabled.' }) }));
}
// AGENT_MESSAGE targets the WhatsApp channel-user id, which for this
// bot IS the plain phone number (e.g. "919061084736") - verified against
// real inbound webhook packets in the LiveChatEvents table, where every
// platform:"dialog360" (WhatsApp) row carries the phone number as
// user_id. Only platform:"web" rows (web chat widget test sessions)
// carry UUIDs. See the currentEngatiUserId comment at the top of this
// file for the full history of getting this wrong.
var targetUserId = currentEngatiUserId || phone;
// platform must match the channel Engati actually uses for this
// conversation. This bot's WhatsApp channel reports as "dialog360" (the
// BSP), not the generic "whatsapp" that liveChatSender defaults to -
// again taken from real inbound packets rather than assumed, since a bot
// on a different WhatsApp provider would report a different value.
var targetPlatform = currentEngatiPlatform || 'dialog360';
// botIdentifier must be ENGATI_LIVECHAT_BOT_IDENTIFIER, NOT
// ENGATI_CUSTOMER_ID - see the ENGATI_LIVECHAT_BOT_IDENTIFIER declaration
// comment near the top of this file. Engati silently accepts and drops
// AGENT_MESSAGE packets that carry the wrong one (confirmed by testing,
// not documented - ES-58715). See catalyst-functions/liveChatSender/index.js.
var body = { action: 'sendAgentMessage', orgId: CURRENT_ORG_ID, phone: targetUserId, platform: targetPlatform, botKey: ENGATI_BOT_ID, botIdentifier: ENGATI_LIVECHAT_BOT_IDENTIFIER, inboundMessageWebhookUrl: ENGATI_INBOUND_MESSAGE_WEBHOOK_URL };
if(ENGATI_INBOUND_API_KEY){ body.inboundApiKey = ENGATI_INBOUND_API_KEY; }
if(text){ body.text = text; }
if(media && media.value){ body.media = { value: media.value, mimeType: media.mimeType }; }
showDebug('sendAgentMessage outgoing body: ' + JSON.stringify(body).slice(0,500));
// Content-Type is deliberately text/plain, not application/json: Catalyst's
// Advanced I/O gateway answers the browser's CORS preflight (OPTIONS) itself,
// before our function code runs, with no Access-Control-Allow-* headers.
// (Correction, Aug 10 2026: an earlier version of this comment claimed API
// Gateway "isn't enabled here" and could fix this if it were - API Gateway
// IS enabled on this project, confirmed while debugging why a brand-new
// function's URL 404'd until it got its own API Gateway route, see
// SETUP.md's Phase 3 step 9 callout. Whether reconfiguring routes through
// API Gateway would also fix this CORS issue was never actually tested -
// the text/plain workaround below works regardless, so there was no reason
// to change a working thing.) application/json is a "non-simple" content-type
// that forces a preflight, which then gets blocked. text/plain is "simple"
// and skips preflight entirely, going straight to the real POST - whose
// response headers ARE correct (confirmed via curl). The function still
// JSON.parse()s the body regardless of declared content-type, so this needs
// no server-side change. See same fix on sendTemplateViaProxy()/CATALYST_PROXY_URL below.
return fetch(LIVE_CHAT_SENDER_PROXY_URL, {
method: 'POST',
headers: { 'Content-Type': 'text/plain' },
body: JSON.stringify(body)
}).then(function(r){ return r.text(); });
}
var templatesById = {};

function loadTemplates(){
var select = document.getElementById('templateSelect');
return ZOHO.CRM.API.getAllRecords({Entity:'WhatsApp_Templates', sort_order:'asc', per_page:200}).then(function(res){
var records = (res && res.data) || [];
showDebug('loadTemplates: fetched '+records.length+' record(s)');
templatesById = {};
select.innerHTML = '<option value="">Send a template...</option>';
records.forEach(function(rec){
var active = rec.Is_Active;
if(active === false || active === 'false'){ return; }
if(!rec.Template_Name){ return; }
templatesById[rec.id] = rec;
var opt = document.createElement('option');
opt.value = rec.id;
opt.textContent = rec.Name || rec.Template_Name;
select.appendChild(opt);
});
showDebug('loadTemplates: '+Object.keys(templatesById).length+' active template(s) added to dropdown');
}).catch(function(err){
showDebug('loadTemplates ERROR: '+((err&&(err.message||JSON.stringify(err)))||'unknown'));
select.innerHTML = '<option value="">(templates error: '+((err&&(err.message||JSON.stringify(err)))||'unknown')+')</option>';
});
}

function renderTemplateParams(rec){
var wrap = document.getElementById('templateParams');
wrap.innerHTML = '';
if(!rec){ return; }
var langs = (rec.Available_Languages || '').split(';').map(function(s){return s.trim();}).filter(Boolean);
if(langs.length > 1){
var langSelect = document.createElement('select');
langSelect.id = 'tplLanguageSelect';
langs.forEach(function(code){
var opt = document.createElement('option');
opt.value = code;
opt.textContent = code;
if(code === (rec.Language_Code || '')){ opt.selected = true; }
langSelect.appendChild(opt);
});
wrap.appendChild(langSelect);
}
var headerType = rec.Header_Type;
if(headerType && headerType !== 'None'){
var hInput = document.createElement('input');
hInput.type = 'text';
hInput.id = 'tplHeaderValue';
hInput.placeholder = headerType + ' URL';
hInput.value = rec.Header_Value || '';
wrap.appendChild(hInput);
}
var count = parseInt(rec.Body_Param_Count, 10) || 0;
var labels = (rec.Body_Param_Labels || '').split(',').map(function(s){return s.trim();});
for(var i=0;i<count;i++){
var pInput = document.createElement('input');
pInput.type = 'text';
pInput.className = 'tplBodyParam';
pInput.placeholder = labels[i] || ('Parameter ' + (i+1));
wrap.appendChild(pInput);
}
}

function buildTemplatePayload(rec){
var components = [];
var headerType = rec.Header_Type;
if(headerType && headerType !== 'None'){
var headerVal = (document.getElementById('tplHeaderValue') || {}).value || rec.Header_Value || '';
var headerKey = headerType.toLowerCase();
var headerParam = { type: headerKey };
headerParam[headerKey] = { link: headerVal };
components.push({ type: 'header', parameters: [headerParam] });
}
var count = parseInt(rec.Body_Param_Count, 10) || 0;
if(count > 0){
var paramInputs = document.querySelectorAll('.tplBodyParam');
var bodyParams = [];
for(var i=0;i<count;i++){
bodyParams.push({ type:'text', text: (paramInputs[i] && paramInputs[i].value) || '' });
}
components.push({ type:'body', parameters: bodyParams });
}
var flowKeys = (rec.Button_Flow_Keys || '').split(';').map(function(s){return s.trim();}).filter(Boolean);
var startIdx = parseInt(rec.Button_Start_Index, 10) || 0;
flowKeys.forEach(function(key, idx){
components.push({
index: startIdx + idx,
sub_type: 'quick_reply',
type: 'button',
parameters: [{ type:'payload', payload: key }]
});
});
return {
name: rec.Template_Name,
components: components,
language: { code: (document.getElementById('tplLanguageSelect') || {}).value || rec.Language_Code || 'en', policy: 'deterministic' }
};
}

function sendTemplateMessage(phone, rec){
var url = "https://api.engati.ai/whatsapp-api/v1.0/customer/" + ENGATI_CUSTOMER_ID + "/bot/" + ENGATI_BOT_ID + "/template"; return fetch(CATALYST_PROXY_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'sendTemplate', orgId: CURRENT_ORG_ID, phone: phone, engatiCustomerId: ENGATI_CUSTOMER_ID, engatiBotId: ENGATI_BOT_ID, engatiApiKey: ENGATI_API_KEY, templatePayload: buildTemplatePayload(rec) }) }).then(function(r){ return r.text(); });
var body = {
phoneNumber: '+' + phone,
payload: buildTemplatePayload(rec)
};
return ZOHO.CRM.HTTP.post({
url: url,
headers: { "Authorization": "Basic " + ENGATI_API_KEY, "Content-Type": "application/json" },
body: (function(){ showDebug('outgoing body (raw object, with content-type header): ' + JSON.stringify(body).slice(0,500)); return body; })()
});
}

function sendTemplateViaProxy(phone, rec){ return fetch(CATALYST_PROXY_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'sendTemplate', orgId: CURRENT_ORG_ID, phone: phone, engatiCustomerId: ENGATI_CUSTOMER_ID, engatiBotId: ENGATI_BOT_ID, engatiApiKey: ENGATI_API_KEY, templatePayload: buildTemplatePayload(rec) }) }).then(function(r){ return r.text(); }); } document.getElementById('templateSelect').addEventListener('change', function(){
var rec = templatesById[this.value];
renderTemplateParams(rec);
});

document.getElementById('templateBtn').addEventListener('click', function(){
var select = document.getElementById('templateSelect');
var rec = templatesById[select.value];
if(!rec || !currentPhone){ return; }
var btn = document.getElementById('templateBtn');
btn.disabled = true;
var prevLabel = btn.textContent;
btn.textContent = 'Sending...';
pausePolling();
sendTemplateViaProxy(currentPhone, rec).then(function(resp){
var data = safeParse(resp);
var inner = data && safeParse(data.body); var failed = !(data && data.statusCode === 200 && inner && inner.status && inner.status.code === 1000);
btn.disabled = false;
btn.textContent = prevLabel;
resumePolling();
if(failed){
alert('Could not send template. Check the template configuration in the WhatsApp Templates module.');
return;
}
localSentMessages.push({ direction:'out', kind:'text', text: '[Template] ' + (rec.Name || rec.Template_Name || ''), time: formatTimestamp(new Date()), ts: Date.now(), status: 'sent' }); showDebug('templateBtn: pushed local message, count='+localSentMessages.length); renderMerged(false); select.value = '';
document.getElementById('templateParams').innerHTML = '';
fetchConversation(currentPhone, false);
}).catch(function(){
btn.disabled = false;
btn.textContent = prevLabel;
resumePolling();
alert('Could not send template. Check the template configuration in the WhatsApp Templates module.');
});
});

document.getElementById('brandHeader').addEventListener('click', function(){
this.classList.toggle('collapsed');
});

ZOHO.embeddedApp.on('PageLoad',function(data){
var entityId = data && (Array.isArray(data.EntityId)?data.EntityId[0]:data.EntityId);
var entity = (data && data.Entity) || 'Leads';
if(!entityId){renderStatus('No record context found.');return;}
renderStatus('Loading configuration...');
loadConfigFromVariables().then(function(){
loadTemplates();
return ZOHO.CRM.API.getRecord({Entity:entity,RecordID:entityId});
}).then(function(res){
var rec=res && res.data && res.data[0];
var phone=rec && (rec.Phone||rec.Mobile);
if(phone){loadConversation(phone);}else{renderStatus('No phone number on this record.');}
// Opening this record's WhatsApp panel IS the "read" signal - clear the
// Unread flag liveChatWebhook sets on every inbound message (see
// crmLeads.js markUnread()), so the Leads list view stops flagging this
// record as needing attention. Fire-and-forget: this is a convenience
// indicator, not something that should block the chat from loading if
// it fails or is slow, and there's nothing useful to do with an error
// here beyond logging it.
if(rec && rec.id && rec.WhatsApp_Unread){
ZOHO.CRM.API.updateRecord({Entity:entity,APIData:{id:rec.id,WhatsApp_Unread:false}}).catch(function(err){
showDebug('clear WhatsApp_Unread FAILED: ' + (err && err.message));
});
}
// Same "read" signal also closes any open "reply to WhatsApp message"
// Tasks this record has (see crmLeads.js createReplyTask()) - opening the
// chat means an agent is already on it, so the reminder has done its job.
// Matched by subject prefix rather than closing every open Task on the
// record, so this never touches something an agent added by hand for an
// unrelated reason.
if(rec && rec.id){
ZOHO.CRM.API.getRelatedRecords({Entity:entity,RecordID:rec.id,RelatedList:'Tasks'}).then(function(taskRes){
var tasks=(taskRes && taskRes.data)||[];
tasks.forEach(function(t){
if(t.Status!=='Completed' && t.Subject && t.Subject.indexOf('Reply to WhatsApp message')===0){
ZOHO.CRM.API.updateRecord({Entity:'Tasks',APIData:{id:t.id,Status:'Completed'}}).catch(function(err){
showDebug('close reply Task FAILED: ' + (err && err.message));
});
}
});
}).catch(function(err){
showDebug('getRelatedRecords Tasks FAILED: ' + (err && err.message));
});
}
}).catch(function(){});
});
function showDebug(text){
var el = document.getElementById('debugBox');
if(!el){
var wrap = document.createElement('div'); wrap.id = 'debugWrap'; wrap.className = 'collapsed'; wrap.style.cssText = 'border-top:2px solid red;background:#111;flex:0 0 auto;';
var header = document.createElement('div'); header.id = 'debugHeader'; header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 8px;font-size:11px;color:#f66;cursor:pointer;font-family:monospace;';
var headerLabel = document.createElement('span'); headerLabel.textContent = 'Debug log';
var headerChevron = document.createElement('span'); headerChevron.id = 'debugChevron'; headerChevron.textContent = '▶'; headerChevron.style.cssText = 'transition:transform 0.15s ease;';
header.appendChild(headerLabel); header.appendChild(headerChevron);
var body = document.createElement('div'); body.id = 'debugBody'; body.style.cssText = 'display:none;';
header.onclick = function(){
var collapsed = wrap.classList.toggle('collapsed');
body.style.display = collapsed ? 'none' : '';
headerChevron.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(90deg)';
};
el = document.createElement('pre');
el.id = 'debugBox';
el.style.cssText = 'white-space:pre-wrap;word-break:break-all;background:#111;color:#0f0;font-size:11px;padding:8px;max-height:200px;overflow:auto;margin:0;';
var copyBtn = document.createElement('button'); copyBtn.id = 'debugCopyBtn'; copyBtn.textContent = 'Copy log'; copyBtn.style.cssText = 'margin:4px 8px;padding:2px 8px;font-size:11px;background:#222;color:#0f0;border:1px solid #0f0;cursor:pointer;'; copyBtn.onclick = function(){ var txt = el.textContent; function done(ok){ copyBtn.textContent = ok ? 'Copied!' : 'Copy failed'; setTimeout(function(){ copyBtn.textContent = 'Copy log'; }, 1500); } if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(function(){ done(true); }).catch(function(){ done(false); }); } else { var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); var ok = false; try{ ok = document.execCommand('copy'); }catch(e){} document.body.removeChild(ta); done(ok); } }; body.appendChild(copyBtn); var clearBtn = document.createElement('button'); clearBtn.id = 'debugClearBtn'; clearBtn.textContent = 'Clear log'; clearBtn.style.cssText = 'margin:4px 8px;padding:2px 8px;font-size:11px;background:#222;color:#f66;border:1px solid #f66;cursor:pointer;'; clearBtn.onclick = function(){ el.textContent = ''; }; body.appendChild(clearBtn);  body.appendChild(el);
wrap.appendChild(header); wrap.appendChild(body);
document.getElementById('chat-root').appendChild(wrap);
}
el.textContent += (new Date()).toISOString().slice(11,19) + ' ' + text + String.fromCharCode(10); el.scrollTop = el.scrollHeight;
}
function pausePolling(){
if(pollTimer){ clearInterval(pollTimer); pollTimer=null; }
}
function resumePolling(){
if(!pollTimer && currentPhone){
pollTimer = setInterval(function(){ fetchConversation(currentPhone, false); }, POLL_INTERVAL_MS);
}
}
// Attachment UI (free-text side). Two ways to fill attachUrl: paste a URL
// directly (original, still works for an already-hosted file), or upload a
// file from this device via fileUpload (Catalyst function -> Zoho WorkDrive
// -> public download URL - see catalyst-functions/fileUpload/index.js for
// the full recipe).
//
// lastUploadedAttachment tracks the real MIME type of a device-uploaded
// file, separately from attachUrl's text value. This matters because
// mimeTypeForPacketType() below guesses MIME type from the URL's file
// extension - which works for a hand-pasted URL like ".../photo.jpg", but
// WorkDrive's download URLs have no extension at all (just a query
// string), so that guess would silently fall back to a category default
// (e.g. always "image/jpeg" for IMAGE) regardless of the file's real type.
// That's the same class of mismatch as Meta error 131053 (see
// mimeTypeForPacketType's own comment) - so for an uploaded file, the
// verified real MIME type from the upload response is used instead of
// re-guessing. Cleared whenever attachUrl no longer matches the uploaded
// URL (manual edit, clear, or after a successful send), so a stale
// verified type can never get attached to a different URL.
var lastUploadedAttachment = null;

document.getElementById('attachToggleBtn').addEventListener('click', function(){
var row = document.getElementById('attachRow');
var willShow = row.classList.contains('hidden') || !row.classList.contains('open');
row.classList.toggle('open');
this.classList.toggle('active');
});

// Emoji picker - the FULL Unicode emoji set (see emoji-data.js, generated
// from Unicode's own emoji-test.txt), not a curated subset. Still zero
// npm/CDN dependencies, in keeping with the rest of this project: the data
// is a plain generated .js file served from the same GitHub Pages origin.
//
// 1900 glyphs are unusable as one flat grid, so the panel gets a category
// tab strip and a name search box. A "Recent" tab (localStorage) replaces
// what used to be a hardcoded jewellery-first block - it adapts to whatever
// each customer actually sends, which also makes the picker multi-tenant
// safe instead of biased toward this one deployment.
var EMOJI_RECENT_KEY = 'whatsyoo.emoji.recent';
var EMOJI_RECENT_MAX = 32;
var EMOJI_TONE_KEY = 'whatsyoo.emoji.tone';

// Applies a skin tone via the verified template map (see emoji-data.js).
// A template like "🧑*‍🤝‍🧑*" marks every spot a modifier goes, so
// multi-person emoji tone all their people and nothing else. Anything with
// no template - objects, animals, flags, and person emoji that don't take
// tones - is returned unchanged, which makes this safe to run over a whole
// grid indiscriminately.
var emojiToneMap = null;
function emojiApplyTone(ch, tone){
if(!tone || typeof EMOJI_TONE_TEMPLATES_RAW === 'undefined') return ch;
if(!emojiToneMap){
emojiToneMap = {};
EMOJI_TONE_TEMPLATES_RAW.split('|').forEach(function(entry){
var sp = entry.indexOf(' ');
emojiToneMap[entry.slice(0, sp)] = entry.slice(sp + 1);
});
}
var tmpl = emojiToneMap[ch];
return tmpl ? tmpl.split('*').join(tone) : ch;
}

function emojiLoadRecent(){
try{
var raw = window.localStorage.getItem(EMOJI_RECENT_KEY);
var arr = raw ? JSON.parse(raw) : [];
return Array.isArray(arr) ? arr.filter(function(x){ return typeof x === 'string' && x; }) : [];
}catch(e){ return []; }  // private-mode / blocked storage must not break the picker
}

function emojiRememberRecent(ch){
try{
var list = emojiLoadRecent().filter(function(x){ return x !== ch; });
list.unshift(ch);
window.localStorage.setItem(EMOJI_RECENT_KEY, JSON.stringify(list.slice(0, EMOJI_RECENT_MAX)));
}catch(e){}
}

// Parses one group's packed "<emoji> <name>|..." blob into [{ch,name}].
// Done lazily per group so opening the picker doesn't parse all 1900 up
// front - only the visible tab (and any tab actually clicked) is expanded.
function emojiParseGroup(group){
if(group.parsed) return group.parsed;
group.parsed = group.data.split('|').map(function(entry){
var sp = entry.indexOf(' ');
return { ch: entry.slice(0, sp), name: entry.slice(sp + 1) };
});
return group.parsed;
}

(function(){
var panel = document.getElementById('emojiPanel');
if(!panel || typeof EMOJI_GROUPS === 'undefined') return;

var currentTone = '';
try{ currentTone = window.localStorage.getItem(EMOJI_TONE_KEY) || ''; }catch(e){}

var topRow = document.createElement('div'); topRow.id = 'emojiTopRow';
var search = document.createElement('input');
search.id = 'emojiSearch';
search.type = 'text';
search.placeholder = 'Search emoji';
var toneWrap = document.createElement('div'); toneWrap.id = 'emojiTones';
topRow.appendChild(search); topRow.appendChild(toneWrap);
var tabs = document.createElement('div'); tabs.id = 'emojiTabs';
var grid = document.createElement('div'); grid.id = 'emojiGrid';
var empty = document.createElement('div'); empty.id = 'emojiEmpty'; empty.textContent = 'No emoji found';
empty.style.display = 'none';
panel.appendChild(topRow); panel.appendChild(tabs); panel.appendChild(grid); panel.appendChild(empty);

function insert(ch){
var input = document.getElementById('msgInput');
var start = input.selectionStart == null ? input.value.length : input.selectionStart;
var end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
input.value = input.value.slice(0, start) + ch + input.value.slice(end);
var caret = start + ch.length;
input.focus();
input.setSelectionRange(caret, caret);
// Auto-grow matches the composer's own input handler - inserting an emoji
// changes the content height just like typing does.
input.style.height = 'auto';
input.style.height = Math.min(input.scrollHeight, 120) + 'px';
emojiRememberRecent(ch);
}

function renderList(items){
grid.textContent = '';
empty.style.display = items.length ? 'none' : '';
// One DocumentFragment rather than 300+ individual appends - the Objects
// and Flags groups are large enough for this to be visible.
var frag = document.createDocumentFragment();
items.forEach(function(item){
// Tone is applied at render time so the grid previews exactly what will
// be inserted - and so changing tone is a re-render, not a data rebuild.
var shown = emojiApplyTone(item.ch, currentTone);
var btn = document.createElement('button');
btn.type = 'button';
btn.textContent = shown;
btn.title = item.name;
btn.addEventListener('click', function(){ insert(shown); });
frag.appendChild(btn);
});
grid.appendChild(frag);
}

function refresh(){
if(search.value.trim()){ search.dispatchEvent(new Event('input')); }
else if(activeTab){ activeTab.click(); }
}

// Tone swatches: default (no tone) plus the five Fitzpatrick modifiers,
// previewed on a hand so the choice is visible rather than abstract.
['', EMOJI_TONES[0], EMOJI_TONES[1], EMOJI_TONES[2], EMOJI_TONES[3], EMOJI_TONES[4]].forEach(function(tone){
var sw = document.createElement('button');
sw.type = 'button';
sw.textContent = emojiApplyTone('✋', tone);
sw.title = tone ? 'Skin tone' : 'Default skin tone';
if(tone === currentTone) sw.classList.add('active');
sw.addEventListener('click', function(){
currentTone = tone;
try{ window.localStorage.setItem(EMOJI_TONE_KEY, tone); }catch(e){}
Array.prototype.forEach.call(toneWrap.children, function(c){ c.classList.remove('active'); });
sw.classList.add('active');
refresh();
});
toneWrap.appendChild(sw);
});

function recentItems(){
return emojiLoadRecent().map(function(ch){ return { ch: ch, name: 'recently used' }; });
}

var activeTab = null;
function selectTab(btn, itemsFn){
if(activeTab) activeTab.classList.remove('active');
activeTab = btn; btn.classList.add('active');
grid.scrollTop = 0;
renderList(itemsFn());
}

var recentBtn = document.createElement('button');
recentBtn.type = 'button'; recentBtn.textContent = '🕘'; recentBtn.title = 'Recently used';
recentBtn.addEventListener('click', function(){ search.value = ''; selectTab(recentBtn, recentItems); });
tabs.appendChild(recentBtn);

var firstGroupBtn = null;
EMOJI_GROUPS.forEach(function(group){
var btn = document.createElement('button');
btn.type = 'button'; btn.textContent = group.icon; btn.title = group.label;
btn.addEventListener('click', function(){
search.value = '';
selectTab(btn, function(){ return emojiParseGroup(group); });
});
tabs.appendChild(btn);
if(!firstGroupBtn) firstGroupBtn = btn;
});

// Search spans every group, so it's the one place all 1900 get parsed.
search.addEventListener('input', function(){
var q = search.value.trim().toLowerCase();
if(!q){
if(activeTab === recentBtn) selectTab(recentBtn, recentItems);
else if(activeTab) activeTab.click();
return;
}
if(activeTab){ activeTab.classList.remove('active'); activeTab = null; }
var hits = [];
EMOJI_GROUPS.forEach(function(group){
emojiParseGroup(group).forEach(function(item){
if(hits.length < 300 && item.name.indexOf(q) !== -1) hits.push(item);
});
});
grid.scrollTop = 0;
renderList(hits);
});

// Open on Recent if there's anything there, otherwise Smileys - a
// first-time user shouldn't be greeted by an empty grid.
if(recentItems().length) selectTab(recentBtn, recentItems);
else selectTab(firstGroupBtn, function(){ return emojiParseGroup(EMOJI_GROUPS[0]); });
})();
document.getElementById('emojiBtn').addEventListener('click', function(e){
e.stopPropagation();
document.getElementById('emojiPanel').classList.toggle('open');
this.classList.toggle('active');
});

// Text formatting toolbar - wraps the current selection (or drops empty
// markers at the cursor if nothing is selected) in msgInput with
// WhatsApp's own markdown-style syntax. WhatsApp renders *bold*,
// _italic_, ~strike~ and ```monospace``` itself on the recipient's
// device once the message arrives as plain text - nothing else in this
// pipeline (AGENT_MESSAGE body, Engati, WhatsApp) needs to know these
// markers exist.
var FORMAT_MARKERS = { bold: '*', italic: '_', strike: '~', mono: '```' };
document.querySelectorAll('#formatPanel button[data-fmt]').forEach(function(btn){
btn.addEventListener('click', function(){
var marker = FORMAT_MARKERS[this.getAttribute('data-fmt')];
var input = document.getElementById('msgInput');
var start = input.selectionStart == null ? input.value.length : input.selectionStart;
var end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
var selected = input.value.slice(start, end);
input.value = input.value.slice(0, start) + marker + selected + marker + input.value.slice(end);
// With a selection, land the cursor right after the closing marker;
// with none, land it between the two markers so typing continues
// formatted from there.
var caret = selected ? (start + marker.length * 2 + selected.length) : (start + marker.length);
input.focus();
input.setSelectionRange(caret, caret);
document.getElementById('formatPanel').classList.remove('open');
document.getElementById('formatBtn').classList.remove('active');
});
});
document.getElementById('formatBtn').addEventListener('click', function(e){
e.stopPropagation();
document.getElementById('formatPanel').classList.toggle('open');
this.classList.toggle('active');
});

// Auto-grow the textarea as the user types multi-line messages (now
// possible via Shift+Enter, see the keydown listener below) - capped by
// #msgInput's CSS max-height, beyond which it scrolls internally instead
// of growing forever. Reset to 'auto' first so shrinking (e.g. after
// deleting a line) is picked up too, not just growth.
document.getElementById('msgInput').addEventListener('input', function(){
this.style.height = 'auto';
this.style.height = this.scrollHeight + 'px';
});

// Close either popup on any click outside it, same pattern as a typical
// dropdown - without this they'd stay open until something else toggled
// them.
document.addEventListener('click', function(e){
var emojiPanel = document.getElementById('emojiPanel');
var emojiBtn = document.getElementById('emojiBtn');
if(!emojiPanel.contains(e.target) && e.target !== emojiBtn){
emojiPanel.classList.remove('open');
emojiBtn.classList.remove('active');
}
var formatPanel = document.getElementById('formatPanel');
var formatBtn = document.getElementById('formatBtn');
if(!formatPanel.contains(e.target) && e.target !== formatBtn){
formatPanel.classList.remove('open');
formatBtn.classList.remove('active');
}
});
document.getElementById('attachClearBtn').addEventListener('click', function(){
document.getElementById('attachUrl').value = '';
document.getElementById('attachType').value = 'IMAGE';
document.getElementById('attachRow').classList.remove('open');
document.getElementById('attachToggleBtn').classList.remove('active');
lastUploadedAttachment = null;
});
// A manual edit to the URL field means whatever was uploaded no longer
// necessarily matches what's in the box - stop trusting its MIME type.
document.getElementById('attachUrl').addEventListener('input', function(){
lastUploadedAttachment = null;
});

function readFileAsBase64(file){
return new Promise(function(resolve, reject){
var reader = new FileReader();
reader.onload = function(){
var result = String(reader.result || '');
var comma = result.indexOf(',');
resolve(comma === -1 ? result : result.slice(comma + 1));
};
reader.onerror = function(){ reject(reader.error || new Error('file read failed')); };
reader.readAsDataURL(file);
});
}

function attachTypeForMime(mimeType){
if(mimeType && mimeType.indexOf('video') === 0) return 'VIDEO';
if(mimeType && mimeType.indexOf('audio') === 0) return 'AUDIO';
if(mimeType === 'application/pdf') return 'DOCUMENT';
return 'IMAGE';
}

// Must match MAX_UPLOAD_BYTES / MAX_DOCUMENT_UPLOAD_BYTES in
// catalyst-functions/fileUpload/index.js (which cap the DECODED size,
// i.e. the original file - not the base64-inflated wire size). Checking
// this client-side before ever touching the network gives an immediate,
// specific error instead of making the user wait through a full base64
// read + upload attempt just to get a 413 back at the end - the gap that
// made video uploads look like a silent hang rather than a clear "too
// big" message.
//
// Documents get a higher cap than images/audio/video (20MB vs 15MB) -
// NOT because WhatsApp allows more (their real document ceiling is
// 100MB), but because that's as far as this project's own upload
// pipeline has actually been tested working. Confirmed via direct
// testing (Aug 11 2026): a 25MB file uploads and cleanly rejects; a 28MB
// file makes the Catalyst function silently die (HTTP 200, empty body,
// no error) - almost certainly because it buffers the whole file in
// memory rather than streaming it. 100MB is not achievable without a
// genuine rewrite of that function - don't raise this constant without
// re-testing the real ceiling first.
var MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // images/audio/video
var MAX_DOCUMENT_UPLOAD_BYTES = 20 * 1024 * 1024; // documents (PDF)
function uploadCapFor(mimeType){
return (mimeType === 'application/pdf') ? MAX_DOCUMENT_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
}

// Same text/plain CORS-bypass as every other Catalyst call in this file -
// see the comment on sendFreeTextMessage's fetch() for why.
//
// TRIED XMLHttpRequest here first, specifically to get real upload
// percentage via xhr.upload.onprogress (fetch has no upload-progress
// event at all) - REVERTED after real testing broke uploads entirely
// ("network error during upload" in the debug log, i.e. xhr.onerror, a
// genuine network-level failure, not an HTTP error status). Root cause:
// per the CORS spec, attaching ANY listener to XMLHttpRequestUpload
// (xhr.upload.onprogress) disqualifies the request from being treated as
// a "simple request" even when the method/headers would otherwise
// qualify - it forces a real CORS preflight (OPTIONS) regardless of the
// text/plain trick. That preflight then failed against this function's
// CORS setup, breaking what was previously reliable. Not worth chasing a
// percentage indicator at the cost of uploads actually working - back to
// plain fetch(), no upload-progress events, just an indeterminate "still
// working" animation instead of a real percentage (see the UI code
// below).
function uploadAttachmentFile(file){
return readFileAsBase64(file).then(function(dataBase64){
return fetch(FILE_UPLOAD_PROXY_URL, {
method: 'POST',
headers: { 'Content-Type': 'text/plain' },
body: JSON.stringify({ orgId: CURRENT_ORG_ID, filename: file.name, mimeType: file.type, dataBase64: dataBase64,
  workdriveClientId: WORKDRIVE_CLIENT_ID, workdriveClientSecret: WORKDRIVE_CLIENT_SECRET, workdriveRefreshToken: WORKDRIVE_REFRESH_TOKEN, workdriveFolderId: WORKDRIVE_FOLDER_ID,
  workdriveAccountsHost: WORKDRIVE_ACCOUNTS_HOST, workdriveApiHost: WORKDRIVE_API_HOST, workdriveHost: WORKDRIVE_HOST, workdriveDownloadHost: WORKDRIVE_DOWNLOAD_HOST })
});
}).then(function(r){ return r.text(); });
}

// Shared by both attach paths (file-picker "Upload file…" button, and
// drag-and-drop onto the widget) - pulled out so drag-and-drop could
// reuse the exact same validation/upload/UI-update logic rather than
// duplicating it. The only thing NOT shared is resetting the file
// <input>'s value, since a dropped file never touched that element.
function handleAttachmentFile(file){
if(!file) return;
var uploadBtn = document.getElementById('attachUploadBtn');
var prevLabel = uploadBtn.textContent;
var progressWrap = document.getElementById('attachProgressWrap');
var progressBar = document.getElementById('attachProgressBar');
var cap = uploadCapFor(file.type);
if(file.size > cap){
showDebug('fileUpload REJECTED client-side: ' + file.name + ' is ' + (file.size/1024/1024).toFixed(1) + 'MB, max is ' + (cap/1024/1024) + 'MB');
alert('That file is ' + (file.size/1024/1024).toFixed(1) + 'MB - the limit is ' + (cap/1024/1024) + 'MB. Choose a smaller file.');
return;
}
// Drag-and-drop has no "accept" attribute to lean on the way the file
// input does - the browser lets you drop literally anything. Same
// image/video/audio/pdf check enforced here explicitly instead.
if(file.type && !/^(image|video|audio)\//.test(file.type) && file.type !== 'application/pdf'){
showDebug('fileUpload REJECTED client-side: ' + file.name + ' is ' + file.type + ', not image/video/audio/pdf');
alert('"' + file.name + '" is a ' + file.type + ' file - only images, videos, audio, and PDFs can be attached.');
return;
}
uploadBtn.disabled = true;
// No real percentage available - plain fetch() (restored above after
// XHR's upload-progress listener broke CORS) gives no visibility into
// either the local read or the network upload. Indeterminate animation
// for the whole operation instead: honest about "still working, no ETA"
// rather than faking a number that isn't real.
uploadBtn.textContent = 'Uploading...';
progressWrap.style.display = 'block';
progressWrap.classList.add('indeterminate');
progressBar.style.width = '100%';
uploadAttachmentFile(file).then(function(resp){
var data = safeParse(resp);
showDebug('fileUpload RAW RESPONSE: ' + JSON.stringify(resp).slice(0,1000));
var body = data && data.body ? safeParse(data.body) : null;
uploadBtn.disabled = false;
uploadBtn.textContent = prevLabel;
progressWrap.style.display = 'none';
if(!(data && data.statusCode === 200 && body && body.url)){
showDebug('fileUpload FAILED: ' + ((body && body.error) || 'upload failed'));
return;
}
var url = body.url;
var mimeType = body.mimeType || file.type || '';
document.getElementById('attachUrl').value = url;
document.getElementById('attachType').value = attachTypeForMime(mimeType);
lastUploadedAttachment = { url: url, mimeType: mimeType };
document.getElementById('attachRow').classList.add('open');
document.getElementById('attachToggleBtn').classList.add('active');
}).catch(function(err){
uploadBtn.disabled = false;
uploadBtn.textContent = prevLabel;
progressWrap.style.display = 'none';
showDebug('fileUpload CATCH ERROR: ' + (err && err.message));
});
}

document.getElementById('attachUploadBtn').addEventListener('click', function(){
document.getElementById('attachFileInput').click();
});
document.getElementById('attachFileInput').addEventListener('change', function(){
var file = this.files && this.files[0];
handleAttachmentFile(file);
this.value = '';
});

// Drag-and-drop attach - drop a file anywhere on the widget (not just a
// small target) to attach it, reusing the exact same upload pipeline as
// the "Upload file…" button. #chat-root covers the whole widget body
// (messages + composer), not just the composer, so this works whether
// the agent drops onto the conversation or the input area.
(function(){
var dropTarget = document.getElementById('chat-root');
var overlay = document.getElementById('dropOverlay');
var dragDepth = 0; // dragenter/dragleave fire per-child-element, not
// just once for the whole zone - a plain counter is the standard fix
// for the overlay otherwise flickering off while still dragging over
// a child element inside the drop target.
dropTarget.addEventListener('dragenter', function(e){
e.preventDefault();
dragDepth++;
overlay.classList.add('active');
});
dropTarget.addEventListener('dragover', function(e){
e.preventDefault(); // required - without this, 'drop' never fires
});
dropTarget.addEventListener('dragleave', function(e){
dragDepth = Math.max(0, dragDepth - 1);
if(dragDepth === 0){ overlay.classList.remove('active'); }
});
dropTarget.addEventListener('drop', function(e){
e.preventDefault();
dragDepth = 0;
overlay.classList.remove('active');
var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
if(!file) return;
document.getElementById('attachRow').classList.add('open');
document.getElementById('attachToggleBtn').classList.add('active');
handleAttachmentFile(file);
});
})();

document.getElementById('sendBtn').addEventListener('click',function(){
var input=document.getElementById('msgInput');
var text=input.value.trim();
var attachUrlInput = document.getElementById('attachUrl');
var attachUrl = attachUrlInput.value.trim();
var attachType = document.getElementById('attachType').value;
// Prefer the verified MIME type from a device upload over guessing from the
// URL's extension - WorkDrive download URLs have none. See
// lastUploadedAttachment's declaration comment above for why this matters.
var uploadedMime = (lastUploadedAttachment && lastUploadedAttachment.url === attachUrl) ? lastUploadedAttachment.mimeType : null;
var media = attachUrl ? { value: attachUrl, mimeType: uploadedMime || mimeTypeForPacketType(attachType, attachUrl) } : null;
if(!text && !media)return;
if(!currentPhone){ return; }
var btn=document.getElementById('sendBtn');
btn.disabled=true;
var prevLabel=btn.textContent;
btn.textContent='Sending...';
pausePolling();
sendFreeTextMessage(currentPhone, text, media).then(function(resp){
var data=safeParse(resp);
showDebug('RAW RESPONSE: ' + JSON.stringify(resp).slice(0,3000));
var failed = !!(data && ((data.statusCode && data.statusCode>=400) || (data.status_code && data.status_code>=400) || (data.status && data.status>=400) || data.error || data.type==='about:blank' || (data.body && safeParse(data.body) && (safeParse(data.body).error || (safeParse(data.body).status && safeParse(data.body).status>=400)))));
btn.disabled=false;
btn.textContent=prevLabel;
resumePolling();
if(failed){
return;
}
localSentMessages.push({ direction:'out', kind: media ? 'media' : 'text', mediaUrl: media ? media.value : null, mediaKind: media ? mediaKindFor(media.value, attachType) : null, text: text || '', time: formatTimestamp(new Date()), ts: Date.now(), status: 'sent' }); showDebug('sendBtn: pushed local message, count='+localSentMessages.length); renderMerged(false); // A failure packet for THIS send lands a few seconds later, so re-check
// sooner than the 15s poll would - this is the moment a red x is most
// likely to be needed, and waiting a full cycle looks like it worked.
setTimeout(function(){ fetchDeliveryFailures(currentPhone); }, 4000);
setTimeout(function(){ fetchDeliveryFailures(currentPhone); }, 12000);
input.value=''; input.style.height='auto';
attachUrlInput.value=''; document.getElementById('attachRow').classList.remove('open'); document.getElementById('attachToggleBtn').classList.remove('active');
lastUploadedAttachment = null;
fetchConversation(currentPhone, false);
}).catch(function(err){
btn.disabled=false;
btn.textContent=prevLabel;
resumePolling();
showDebug('CATCH ERROR: name=' + (err && err.name) + ' message=' + (err && err.message) + ' stack=' + (err && err.stack ? String(err.stack).slice(0,500) : 'none'));
});
});
var WINDOW_MS = 24 * 60 * 60 * 1000;
function updateWindowBanner(lastInboundTsMs){
var el = document.getElementById('windowBanner');
if(!el) return;
if(!lastInboundTsMs){ el.style.display = 'none'; return; }
var age = Date.now() - lastInboundTsMs;
if(age > WINDOW_MS){
var hours = Math.floor(age / (60 * 60 * 1000));
el.textContent = '⚠ It\'s been ' + hours + 'h since the customer last messaged. Free-text replies may fail outside WhatsApp\'s 24-hour window - use a template instead.';
el.style.display = 'block';
} else {
el.style.display = 'none';
}
}
// Derive the MIME type from the file URL's actual extension rather than
// assuming one per category. The previous version returned a hardcoded
// 'image/jpeg' for ANY image, so attaching a .png declared the wrong type -
// the same mismatch class as Meta error 131053 (Media Upload Error), which
// silently killed template delivery until we found it via Engati support.
// Falls back to the category default when the extension is missing or
// unrecognised (e.g. a URL with no extension, or a redirect/CDN link).
var MIME_BY_EXTENSION = {
jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
mp4: 'video/mp4', '3gp': 'video/3gpp',
mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', amr: 'audio/amr', aac: 'audio/aac',
pdf: 'application/pdf'
};
var MIME_CATEGORY_DEFAULT = { IMAGE: 'image/jpeg', VIDEO: 'video/mp4', AUDIO: 'audio/mpeg', DOCUMENT: 'application/pdf' };
function extensionOf(url){
// Strip query string and fragment before reading the extension, so
// ".../logo.png?v=2" doesn't come out as "png?v=2".
var clean = String(url || '').split('#')[0].split('?')[0];
var lastSegment = clean.substring(clean.lastIndexOf('/') + 1);
var dot = lastSegment.lastIndexOf('.');
return dot === -1 ? '' : lastSegment.substring(dot + 1).toLowerCase();
}
function mimeTypeForPacketType(t, url){
var fromExt = MIME_BY_EXTENSION[extensionOf(url)];
// Only trust the extension if it agrees with the category the user picked -
// otherwise a mislabelled URL (e.g. .mp4 selected as IMAGE) would send a
// contradictory packetType/mimeType pair, which WhatsApp also rejects.
// DOCUMENT is checked as an exact match rather than a prefix, since
// "application/pdf" doesn't share a clean "type/" prefix scheme the way
// image/video/audio do (documents aren't restricted to one MIME family
// in general - PDF is just the one this project actually supports).
if(t === 'DOCUMENT'){
return (fromExt === 'application/pdf') ? fromExt : MIME_CATEGORY_DEFAULT.DOCUMENT;
}
var expectedPrefix = (t === 'VIDEO' ? 'video/' : t === 'AUDIO' ? 'audio/' : 'image/');
if(fromExt && fromExt.indexOf(expectedPrefix) === 0){ return fromExt; }
return MIME_CATEGORY_DEFAULT[t] || 'image/jpeg';
}
// Enter key in the message box triggers the same Send click, matching
// WhatsApp's own composer. Shift+Enter is deliberately NOT prevented -
// msgInput is now a <textarea> (see index.html), so the browser's default
// behaviour for Shift+Enter (insert a newline) fires on its own; the
// auto-grow listener above then resizes the box to fit.
document.getElementById('msgInput').addEventListener('keydown', function(e){
if(e.key === 'Enter' && !e.shiftKey){
e.preventDefault();
document.getElementById('sendBtn').click();
}
});
ZOHO.embeddedApp.init();

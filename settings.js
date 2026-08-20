// settings.js
//
// Backend for settings.html (plan Phase B, corrected scope - see the plan's
// "Correction" section). Engati/WorkDrive credentials route through CRM
// Variables directly now, not this page. This page's remaining jobs:
//   1. Show this org's generated Engati webhook URL (from OrgConfig's
//      webhook_slug, set once at install time by functions/extensionLifecycle).
//   2. Let the admin save their org's Lead-sync Deluge function URL
//      (deluge/leadSync.dg) - the one piece of config that couldn't move to
//      a CRM Variable, since it carries a bearer credential (zapikey) in
//      its query string.
//
// SHARED_CATALYST_BASE_URL comes from sharedConfig.js, loaded before this
// file (see settings.html).

var ORG_CONFIG_API_URL = SHARED_CATALYST_BASE_URL + "/server/orgConfigApi/";
var CURRENT_ORG_ID = null;

function setStatus(msg, isError) {
  var el = document.getElementById('settingsStatus');
  el.textContent = msg;
  el.className = 'settingsStatus' + (isError ? ' settingsStatusError' : '');
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function loadConfig() {
  setStatus('Loading...');
  return fetch(ORG_CONFIG_API_URL + '?orgId=' + encodeURIComponent(CURRENT_ORG_ID), {
    method: 'GET'
  }).then(function (r) { return r.text(); }).then(function (raw) {
    var outer = safeParse(raw);
    if (!outer || outer.statusCode !== 200) {
      var err = outer && safeParse(outer.body);
      setStatus((err && err.error) || 'Could not load settings.', true);
      return;
    }
    var data = safeParse(outer.body);
    var urlField = document.getElementById('webhookUrlField');
    urlField.value = (data && data.webhookUrl) || '(not available - extension install may not have finished)';
    var fnField = document.getElementById('f_crm_function_url');
    if (data && data.crmFunctionUrl_isSet) { fnField.placeholder = '(already set - enter to replace)'; }
    setStatus('');
  }).catch(function (e) {
    setStatus('Could not load settings: ' + ((e && e.message) || e), true);
  });
}

function saveFunctionUrl() {
  var field = document.getElementById('f_crm_function_url');
  if (!field.value) { setStatus('Nothing to save.'); return; }
  setStatus('Saving...');
  return fetch(ORG_CONFIG_API_URL, {
    // text/plain to stay a CORS "simple request", same reasoning as
    // app.js's sendFreeTextMessage() comment.
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ orgId: CURRENT_ORG_ID, crmFunctionUrl: field.value })
  }).then(function (r) { return r.text(); }).then(function (raw) {
    var outer = safeParse(raw);
    if (!outer || outer.statusCode !== 200) {
      var err = outer && safeParse(outer.body);
      setStatus((err && err.error) || 'Save failed.', true);
      return;
    }
    field.value = '';
    field.placeholder = '(already set - enter to replace)';
    setStatus('Saved.');
  }).catch(function (e) {
    setStatus('Save failed: ' + ((e && e.message) || e), true);
  });
}

document.getElementById('saveFunctionUrlBtn').addEventListener('click', saveFunctionUrl);
document.getElementById('copyWebhookBtn').addEventListener('click', function () {
  var field = document.getElementById('webhookUrlField');
  field.select();
  try { document.execCommand('copy'); setStatus('Webhook URL copied.'); } catch (e) { /* clipboard not available - field is still selected for manual copy */ }
});

ZOHO.embeddedApp.on('PageLoad', function () {
  ZOHO.CRM.CONFIG.getOrgInfo().then(function (resp) {
    // TODO(verify): same unconfirmed getOrgInfo() response shape noted in
    // app.js's CURRENT_ORG_ID declaration - re-check against a real widget
    // once this can actually be tested.
    var orgInfo = resp && resp.org && resp.org[0];
    CURRENT_ORG_ID = (orgInfo && (orgInfo.ZGID || orgInfo.id)) || null;
    if (!CURRENT_ORG_ID) {
      setStatus('Could not determine this org\'s id - settings cannot be loaded.', true);
      return;
    }
    loadConfig();
  }).catch(function (e) {
    setStatus('Could not load org info: ' + ((e && e.message) || e), true);
  });
});
ZOHO.embeddedApp.init();

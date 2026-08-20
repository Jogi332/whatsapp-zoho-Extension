// extensionLifecycle
//
// Install/uninstall/upgrade webhook target declared in plugin-manifest.json
// (plugin-execution.install-url/uninstall-url/upgrade-url), all pointed at
// this same function - see plan Phase C. Provisions/deprovisions a row in
// the shared, multi-tenant OrgConfig table (see functions/liveChatWebhook/
// orgConfig.js's schema comment) for the installing/uninstalling org.
//
// UNCONFIRMED (flagged per plan Phase C/G): the exact payload shape Zoho
// sends to an extension's install/uninstall/upgrade webhook - which field
// carries the org id, whether there's an explicit "event" field or it's
// implied by which URL was hit, what (if anything) needs to be returned -
// has not been verified against a real Zoho Extension install, because
// that requires an authenticated `zet`/Developer Console session this
// environment doesn't have. This function is written defensively:
//   - logs the full raw payload on every call, so the real shape can be
//     read from Catalyst logs the first time a real install/uninstall hits
//     it, and this file corrected accordingly.
//   - tries several plausible field names for org id and event type rather
//     than assuming one.
//   - always responds 2xx even when it can't confidently parse the payload,
//     on the same "don't block Zoho's own flow over our uncertainty"
//     principle liveChatWebhook already follows for Engati.
// Re-verify this whole file against a real install before relying on it.
//
// INSTALL/UPGRADE: create (or reactivate, if this org previously
// uninstalled and is reinstalling) an OrgConfig row with status='active'
// and a freshly-generated webhook_slug - see plan Phase A for why the slug
// exists and how it's used. Reinstalling within a short window intentionally
// reuses NOTHING else (Engati creds, WorkDrive tokens) automatically; those
// still need re-entering via the Settings page (plan Phase B) since we have
// no way to know if they're still valid.
//
// UNINSTALL: soft-delete (status='inactive') rather than hard-delete - see
// plan Phase C. A same-day reinstall then just flips status back to active
// without losing history; a genuinely departed org's row simply stops being
// matched by orgConfig.js's findByOrgId/findByWebhookSlug (both filter on
// status = 'active'), so its data stays inert but isn't destroyed outright.

const catalyst = require('zcatalyst-sdk-node');
const crypto = require('crypto');

function readBody(req) {
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () { resolve(data); });
    req.on('error', function () { resolve(''); });
  });
}

function safeDigits(v) { return String(v || '').replace(/[^0-9]/g, ''); }

// Tries several plausible shapes - see UNCONFIRMED note above. Corrects
// itself the first time a real payload is logged and inspected.
function extractOrgId(body) {
  return safeDigits(
    body.orgId || body.org_id ||
    (body.org && (body.org.id || body.org.zgid)) ||
    (body.data && (body.data.orgId || body.data.org_id)) ||
    ''
  );
}

function extractEvent(req, body) {
  var fromBody = String(body.event || body.eventType || body.action || '').toUpperCase();
  if (fromBody) { return fromBody; }
  // Fallback: infer from which manifest URL was hit, if the query string
  // carries it (see plugin-manifest.json - all three lifecycle URLs
  // currently point at this same function/path).
  var url = String(req.url || '').toLowerCase();
  if (url.indexOf('uninstall') !== -1) { return 'UNINSTALL'; }
  if (url.indexOf('upgrade') !== -1) { return 'UPGRADE'; }
  return 'INSTALL';
}

function findRow(catalystApp, orgId) {
  return catalystApp.zcql().executeZCQLQuery(
    "SELECT ROWID FROM OrgConfig WHERE org_id = '" + orgId + "' LIMIT 1"
  ).then(function (rows) {
    var row = rows && rows[0] && rows[0].OrgConfig;
    return row ? row.ROWID : null;
  });
}

function activateOrg(catalystApp, orgId) {
  var table = catalystApp.datastore().table('OrgConfig');
  return findRow(catalystApp, orgId).then(function (rowId) {
    var now = new Date().toISOString();
    if (rowId) {
      // Reinstall within the soft-delete window - reactivate, keep
      // everything else (webhook_slug, any previously-entered Engati/
      // WorkDrive config) exactly as it was.
      return table.updateRow({ ROWID: rowId, status: 'active', updated_at: now });
    }
    var slug = crypto.randomBytes(16).toString('base64url');
    return table.insertRow({
      org_id: orgId,
      webhook_slug: slug,
      status: 'active',
      installed_at: now,
      updated_at: now
    });
  });
}

function deactivateOrg(catalystApp, orgId) {
  var table = catalystApp.datastore().table('OrgConfig');
  return findRow(catalystApp, orgId).then(function (rowId) {
    if (!rowId) {
      // Nothing to deactivate - not an error, just log for visibility.
      console.error('[extensionLifecycle] UNINSTALL for unknown org_id=' + orgId + ' - no OrgConfig row to deactivate');
      return null;
    }
    return catalystApp.datastore().table('OrgConfig').updateRow({
      ROWID: rowId,
      status: 'inactive',
      updated_at: new Date().toISOString()
    });
  });
}

module.exports = function (req, res) {
  var headers = { 'Content-Type': 'application/json' };

  readBody(req).then(function (raw) {
    var body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }

    console.log('[extensionLifecycle] raw payload (unconfirmed shape, see file header): ' + raw.slice(0, 2000));

    var orgId = extractOrgId(body);
    var event = extractEvent(req, body);
    console.log('[extensionLifecycle] event=' + event + ' orgId=' + orgId);

    if (!orgId) {
      console.error('[extensionLifecycle] could not extract an org id from this payload - nothing provisioned. See raw payload logged above.');
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, note: 'no org id resolved' }));
      return;
    }

    var catalystApp = catalyst.initialize(req);
    var work = (event === 'UNINSTALL') ? deactivateOrg(catalystApp, orgId) : activateOrg(catalystApp, orgId);

    work.then(function () {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true }));
    }).catch(function (e) {
      console.error('[extensionLifecycle] ' + event + ' failed for orgId=' + orgId + ': ' + (e && e.message));
      // Still 2xx - see file header re: not blocking Zoho's own install flow
      // over our uncertainty. The failure is logged loudly for follow-up.
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
    });
  });
};

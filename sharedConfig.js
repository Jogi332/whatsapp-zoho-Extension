// sharedConfig.js
//
// Loaded by BOTH index.html (app.js) and settings.html (settings.js), so
// the shared multi-tenant Catalyst backend's URL lives in exactly one
// place instead of drifting between two copies - see plan Phase A/C.
//
// TODO(deploy): fill in the real shared project's base URL once Phase C's
// Catalyst project actually exists. Note the data-centre-suffix caveat
// documented in app.js's SHARED_CATALYST_BASE_URL comment - a customer on
// the US/EU/AU DC needs an entirely different domain, not just a different
// project name. (Multi-DC handling for the shared project itself is an open
// question flagged in the plan's Phase F risk notes, not solved here.)
var SHARED_CATALYST_BASE_URL = "https://REPLACE-WITH-SHARED-PROJECT.catalystserverless.in";

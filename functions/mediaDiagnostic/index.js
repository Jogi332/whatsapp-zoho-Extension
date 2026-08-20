// mediaDiagnostic — TEMPORARY, Phase E investigation tool only.
//
// Not part of the product - do not wire the widget/app.js to this. Purpose:
// capture EXACTLY what WhatsApp/Meta's media-fetching client sends when
// fetching an AGENT_MESSAGE's media URL, per plan Phase E step 3 (root-
// causing why uploaded attachments never arrive on the phone despite
// Engati's API accepting the send).
//
// HOW TO USE (once this is deployed - not done from this session, see
// SETUP.md/plan for the "don't push/deploy" hold):
//   1. Deploy this function alongside the others.
//   2. Send a real AGENT_MESSAGE (via liveChatSender, same mechanism the
//      widget uses) with media.value set to this function's own URL
//      (https://<project>.catalystserverless.<dc>/server/mediaDiagnostic/)
//      and a real media.mimeType (e.g. image/jpeg).
//   3. Check Catalyst's function logs (DevOps > Logs) for this invocation -
//      every header, method, and query string WhatsApp's fetcher used will
//      be there verbatim.
//   4. Compare against what functions/fileUpload/index.js's streamMedia
//      actually returns for the same request shape - this is what confirms
//      or refutes the Phase E HEAD-routing fix (see that file's header
//      comment) as the real root cause, rather than leaving it as an
//      unconfirmed hypothesis.
//   5. DELETE this function once the investigation concludes - it's
//      diagnostic scaffolding, not something to ship.
//
// Responds to both GET and HEAD with a real, tiny, valid JPEG (a tiny
// black-pixel image) and the same header shape fileUpload's streamMedia
// uses (Content-Type, Content-Length, Accept-Ranges, no chunked encoding) -
// so it's a genuine, deliverable-if-everything-else-is-right media target
// for a real test send, not just a logging stub that would fail delivery
// for an unrelated reason (invalid image bytes) and muddy the result.

var TINY_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
var TINY_JPEG = Buffer.from(TINY_JPEG_BASE64, 'base64');

module.exports = function (req, res) {
  var summary = {
    method: req.method,
    url: req.url,
    headers: req.headers
  };
  // Deliberately console.error (not .log) so this stands out in Catalyst's
  // log viewer against normal traffic - this function should see almost no
  // real traffic besides deliberate test hits.
  console.error('[mediaDiagnostic] ' + JSON.stringify(summary));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  var headers = {
    'Content-Type': 'image/jpeg',
    'Content-Length': TINY_JPEG.length,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  res.writeHead(200, headers);
  res.end(TINY_JPEG);
};

// Preview sites: each open pull request into development is served at
// <slug>.landslidesncgs.org from the <slug>/ folder of the preview bucket
// (.github/workflows/pr-preview.yml). Prefixes the request URI with the
// host's first label so each preview reads its own folder. The shared data
// paths are left alone: those behaviors read the production data bucket,
// which has no per-preview folders. Answers 404 for a host that is not a
// single DNS label under landslidesncgs.org. Composed into the preview
// function after rewrite(), which has already appended index.html.
var PREVIEW_DOMAIN = '.landslidesncgs.org';
var PREVIEW_NOT_FOUND = {
  statusCode: 404,
  statusDescription: 'Not Found',
  headers: { 'content-type': { value: 'text/plain' } },
  body: 'No preview site at this address.',
};

function previewPrefix(request) {
  var host = request.headers.host ? request.headers.host.value : '';
  host = host.toLowerCase();
  if (!host.endsWith(PREVIEW_DOMAIN)) {
    return PREVIEW_NOT_FOUND;
  }

  var slug = host.substring(0, host.length - PREVIEW_DOMAIN.length);
  if (!/^[a-z0-9-]{1,63}$/.test(slug)) {
    return PREVIEW_NOT_FOUND;
  }

  var uri = request.uri;
  if (uri.startsWith('/alerts/data/') || uri.startsWith('/simple/data/')) {
    return request;
  }

  request.uri = '/' + slug + uri;
  return request;
}

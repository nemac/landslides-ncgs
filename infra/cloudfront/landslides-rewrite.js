function rewrite(event) {
    var request = event.request;
    var uri = request.uri;

    // The SIREN alerts dashboard under /alerts/ was taken offline on
    // 2026-10-22; its pages redirect to DFENS Simple. The data files under
    // /alerts/data/ stay reachable because the daily pipeline still writes
    // them and nothing else serves them.
    if (uri === '/alerts' || (uri.startsWith('/alerts/') && !uri.startsWith('/alerts/data/'))) {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: '/simple/' } }
        };
    }

    // Directory-style URL without a trailing slash (e.g. "/simple",
    // "/alerts"): redirect to the slash form instead of rewriting it.
    // A rewrite would serve index.html at "/simple", and the page's
    // relative asset paths (css/, js/) would then resolve from the site
    // root and 403. The redirect keeps relative URLs correct.
    var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
    if (!uri.endsWith('/') && lastSegment.indexOf('.') === -1) {
        var qs = '';
        var keys = Object.keys(request.querystring);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            qs += (qs ? '&' : '?') + k + '=' + request.querystring[k].value;
        }
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: uri + '/' + qs } }
        };
    }

    // The origin is an S3 REST endpoint (OAC), which does not resolve
    // directory indexes. Append index.html for directory-style URIs so
    // paths like "/simple/" work.
    if (uri.endsWith('/')) {
        uri += 'index.html';
    }

    request.uri = uri;
    return request;
}

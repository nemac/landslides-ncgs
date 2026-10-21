function handler(event) {
    var request = event.request;
    var host = request.headers.host ? request.headers.host.value : '';
    var uri = request.uri;

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

    // The alerts dashboard is served from the dashboard.landslidesncgs.org
    // hostname but its files live under /alerts/ in the shared bucket.
    // Map that host onto the /alerts prefix.
    if (host === 'dashboard.landslidesncgs.org') {
        uri = '/alerts' + uri;
    }

    // The origin is an S3 REST endpoint (OAC), which does not resolve
    // directory indexes. Append index.html for directory-style URIs so
    // paths like "/alerts/" or the dashboard root work.
    if (uri.endsWith('/')) {
        uri += 'index.html';
    }

    request.uri = uri;
    return request;
}

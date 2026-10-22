function rewrite(event) {
    var request = event.request;
    var host = request.headers.host ? request.headers.host.value : '';
    var uri = request.uri;

    // dashboard.landslidesncgs.org shows DFENS Simple at its root: the
    // page lives under /simple/ in the bucket, so the host is mapped onto
    // that prefix below. /alerts/data/ is left alone because the page's
    // building footprints come from ../alerts/data/ (shared data files).
    var isDashboardHost = host === 'dashboard.landslidesncgs.org';
    var isSharedData = uri.startsWith('/alerts/data/');

    // The SIREN alerts dashboard under /alerts/ was taken offline on
    // 2026-10-22; its pages redirect to DFENS Simple (the root on the
    // dashboard host). The data files under /alerts/data/ stay reachable
    // because the daily pipeline still writes them.
    if (uri === '/alerts' || (uri.startsWith('/alerts/') && !isSharedData)) {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: isDashboardHost ? '/' : '/simple/' } }
        };
    }

    // On the dashboard host a /simple/... URL would double the prefix;
    // send it to the same path at the root instead.
    if (isDashboardHost && (uri === '/simple' || uri.startsWith('/simple/'))) {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: uri.substring('/simple'.length) || '/' } }
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

    if (isDashboardHost && !isSharedData) {
        uri = '/simple' + uri;
    }

    // The origin is an S3 REST endpoint (OAC), which does not resolve
    // directory indexes. Append index.html for directory-style URIs so
    // paths like "/simple/" or the dashboard root work.
    if (uri.endsWith('/')) {
        uri += 'index.html';
    }

    request.uri = uri;
    return request;
}

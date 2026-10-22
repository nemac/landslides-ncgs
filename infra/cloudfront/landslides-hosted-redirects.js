// Hosts that have no files in the bucket and are answered entirely by this
// function: inventory.landslidesncgs.org serves a page framing the NCGS
// ArcGIS Experience, both mapviewer hosts redirect to the ArcGIS web app
// viewer, and dashboard.landslidesncgs.org redirects to DFENS Simple (the
// SIREN alerts dashboard it used to serve was taken offline on 2026-10-22).
// Every other host falls through (returns null) so the rewrite piece can
// handle it. Composed into the production function by the CDK app.
var INVENTORY_HOST = 'inventory.landslidesncgs.org';
var DASHBOARD_HOST = 'dashboard.landslidesncgs.org';
var SIMPLE_URL = 'https://landslidesncgs.org/simple/';
var MAPVIEWER_HOSTS = ['mapviewer.landslidesncgs.org', 'mapviewer.landslidesncgs.com'];
var MAPVIEWER_URL = 'https://unca.maps.arcgis.com/apps/webappviewer/index.html?id=e9f79de934f24e40a71bab8db8050612';

var INVENTORY_PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>Landslide Inventory | NC Geological Survey</title>'
  + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden}'
  + 'iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style>'
  + '</head><body>'
  + '<iframe src="https://experience.arcgis.com/experience/cd122ec3a6414d8e80ca93f5efe6bcb5"'
  + ' title="Landslide Inventory"'
  + ' allow="geolocation; fullscreen; clipboard-write"'
  + ' allowfullscreen></iframe>'
  + '</body></html>';

function hostedRedirects(event) {
    var headers = event.request.headers;
    var host = headers.host ? headers.host.value : '';

    if (host === INVENTORY_HOST) {
        return {
            statusCode: 200,
            statusDescription: 'OK',
            headers: {
                'content-type': { value: 'text/html; charset=utf-8' },
                'cache-control': { value: 'public, max-age=300' }
            },
            body: INVENTORY_PAGE
        };
    }

    if (MAPVIEWER_HOSTS.indexOf(host) !== -1) {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: MAPVIEWER_URL } }
        };
    }

    if (host === DASHBOARD_HOST) {
        return {
            statusCode: 301,
            statusDescription: 'Moved Permanently',
            headers: { location: { value: SIMPLE_URL } }
        };
    }

    return null;
}

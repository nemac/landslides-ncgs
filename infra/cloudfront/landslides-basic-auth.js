// HTTP basic auth for the dev site. The expected credential is the base64 of
// "user:password", stored under the key "basic-auth" in the function's
// KeyValueStore (set by hand, never in this repo). Returns a 401 challenge
// when the header is missing, malformed or wrong, or when the key is unset,
// and null when the request may continue. Composed into the dev function.
var AUTH_KEY = 'basic-auth';
var CHALLENGE = {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: { 'www-authenticate': { value: 'Basic realm="landslides dev"' } }
};

async function basicAuth(event, kvs) {
    var headers = event.request.headers;
    var provided = headers.authorization ? headers.authorization.value : '';

    var expected;
    try {
        expected = await kvs.get(AUTH_KEY);
    } catch (err) {
        return CHALLENGE;
    }

    if (provided === 'Basic ' + expected) {
        return null;
    }
    return CHALLENGE;
}

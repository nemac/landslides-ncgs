# CloudFront Functions

Source of record for the viewer-request functions on the production and dev
distributions. The CDK app in `infra/cdk/` composes them and deploys them;
nothing here is applied by hand.

## Pieces

Each file defines exactly one top-level function and nothing else, so the
files can be concatenated into one CloudFront Function:

| File | Function | Does |
|---|---|---|
| `landslides-rewrite.js` | `rewrite(event)` | 301 the retired SIREN dashboard pages (`/alerts`, `/alerts/*` except `/alerts/data/*`) to `/simple/`, or to `/` on the dashboard host; 301 a directory path without a trailing slash to the slash form; map the `dashboard.landslidesncgs.org` host onto `/simple/` (leaving `/alerts/data/*`, the shared building footprints, alone, and 301ing a doubled `/simple/...` to the root form); append `index.html` to directory paths (the S3 origin does not resolve indexes). |
| `landslides-hosted-redirects.js` | `hostedRedirects(event)` | Serve the iframe page for `inventory.landslidesncgs.org`; 301 both mapviewer hosts to the ArcGIS web app viewer; `null` for every other host. |
| `landslides-basic-auth.js` | `basicAuth(event, kvs)` | 401 challenge unless the Authorization header matches the base64 credential under key `basic-auth` in the function's KeyValueStore; `null` when it matches. |

The CDK app (`infra/cdk/lib/compose-function.ts`) builds:

- **production**: hosted-redirects, then rewrite;
- **dev**: basic-auth, then rewrite, with the KeyValueStore attached.

Both run on `cloudfront-js-2.0` and must stay under 10 KB combined.

## Tests

Plain Node tests load each piece by name and call it with CloudFront-shaped
events. No AWS access needed:

```bash
node --test "infra/cloudfront/test/*.test.js"
```

## Changing a piece

Edit the file, add or adjust a test, run the tests, then `cdk deploy Web`
from `infra/cdk/` (see `infra/README.md`). The old `update-function` /
`publish-function` commands are no longer used.

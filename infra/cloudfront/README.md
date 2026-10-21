# CloudFront configuration

Source of record for pieces of the production CloudFront setup that are
otherwise only visible in the AWS console. Changes here are applied by hand
with the AWS CLI; nothing deploys this folder.

## `landslides-rewrite.js`

Viewer-request function on distribution `E139BPMQTMFRUH`. It does three
things:

1. Redirects (301) a directory-style path without a trailing slash, such as
   `/simple` or `/alerts`, to the slash form. Without this the page would be
   served at `/simple` and its relative `css/` and `js/` links would resolve
   from the site root and 403 (seen 2026-10-20).
2. Maps the `dashboard.landslidesncgs.org` host onto the `/alerts/` prefix.
3. Appends `index.html` to paths ending in `/`, because the S3 origin (OAC,
   REST endpoint) does not resolve directory indexes.

To update it:

```bash
ETAG=$(aws cloudfront describe-function --name landslides-rewrite --stage DEVELOPMENT --query ETag --output text)
aws cloudfront update-function --name landslides-rewrite --if-match "$ETAG" \
  --function-config Comment="Directory index + dashboard host map; redirect no-slash dirs",Runtime=cloudfront-js-2.0 \
  --function-code fileb://infra/cloudfront/landslides-rewrite.js
# test with `aws cloudfront test-function --stage DEVELOPMENT ...`, then:
ETAG=$(aws cloudfront describe-function --name landslides-rewrite --stage DEVELOPMENT --query ETag --output text)
aws cloudfront publish-function --name landslides-rewrite --if-match "$ETAG"
```

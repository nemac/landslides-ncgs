# Infrastructure

Everything that serves landslidesncgs.org and landslidesncgs.com lives in AWS
account **710482330128** and is defined by the CDK app in `infra/cdk/`.
GitHub holds only source code. Design: `docs/superpowers/specs/2026-10-21-aws-account-migration-design.md`.

| Folder | Holds |
|---|---|
| `cdk/` | The CDK app (TypeScript). Four stacks: `Dns`, `Web`, `Ci`, `Trigger`. |
| `cloudfront/` | CloudFront Function source pieces and their tests. |
| `lambda/refresh-simple-trigger/` | The Lambda that dispatches GitHub workflows from EventBridge. |

## Day to day

```bash
cd infra/cdk
npm ci                       # once per clone
npm test                     # stack and composer tests, no AWS access
npm run diff                 # what a deploy would change (SSO profile jbliss-landslidesncgs)
npm run deploy               # deploy every stack
npx cdk deploy Web --profile jbliss-landslidesncgs   # one stack
```

Deploys run from a developer machine with the `jbliss-landslidesncgs` SSO
profile (`aws sso login --profile jbliss-landslidesncgs` first). CI only
synthesizes. The migration below is complete (2026-10-26). The `cutover`
context key that staged it (`wildcard`, `subdomains`, `done`) was removed on
2026-10-27; the production distribution now always claims the eight
hostnames in `lib/config.ts`, and the `--context cutover=...` flags in the
runbook commands below are historical.

The workflows carry the role ARNs, bucket names and distribution ids as
literals copied from the stack outputs; `test/workflows.test.ts` checks the
ARNs and bucket names against `lib/config.ts` on every CI run, so a renamed
role or bucket fails CI instead of failing a deploy. The distribution ids
are only checked for shape.

Secrets never live in this repo. Two values are set by hand, once, with the
commands in step 4 below: the GitHub token in Secrets Manager and the dev
site's basic-auth credential in a CloudFront KeyValueStore. The pull request
preview sites share that KeyValueStore, so the same credential opens them.

## Pull request previews

`.github/workflows/pr-preview.yml` deploys every open pull request into
`development` to `<slug>.landslidesncgs.org` (see `OPERATIONS.md` for how
the slug is chosen). The pieces, all in the `Web` and `Ci` stacks:

| Piece | Name |
|---|---|
| Bucket, one folder per slug, objects expire after 60 days | `landslidesncgs-preview-site` |
| Distribution with the alias `*.landslidesncgs.org` | `Web` output `PreviewDistributionId` |
| Viewer-request function: basic auth, rewrite, then the slug prefix | `landslides-preview` |
| Wildcard A and AAAA records in the `.org` zone | `*.landslidesncgs.org` |
| OIDC role, trusted by the `preview` GitHub environment only | `landslides-github-preview` |

The wildcard covers only names nothing else claims: CloudFront sends a
request to the distribution with the exact alias when there is one, and
Route 53 answers from an exact record before the wildcard, so production,
dev and the other named hosts are unaffected. The certificate already
covers `*.landslidesncgs.org`. GitHub creates the `preview` environment on
the first run; it needs no branch restriction, since any branch may have a
pull request.

To set it up, or after changing any of the above:

```bash
cd infra/cdk
npx cdk diff Web Ci --profile jbliss-landslidesncgs
npx cdk deploy Web --profile jbliss-landslidesncgs
npx cdk deploy Ci --profile jbliss-landslidesncgs
```

Copy the `Web` output `PreviewDistributionId` into both places in
`pr-preview.yml` (the `distribution_id` input and the `--distribution-id`
flag); `test/workflows.test.ts` checks that they agree.

---

## Cutover runbook: NEMAC account 104538610210 to 710482330128

Done once, in order. Every step can be checked before
the next. Nothing in the old account is turned off until step 10, and by
then it serves only the two apex redirects. The old account is the default
AWS profile; the new one is `--profile jbliss-landslidesncgs`. Steps marked
**(hand)** are outside CDK.

Placeholders used below, all read from stack outputs after step 2:

| Placeholder | From |
|---|---|
| `PROD_ID`, `PROD_DOMAIN` | `Web` outputs `ProductionDistributionId`, `ProductionDomainName` (a `*.cloudfront.net` name) |
| `DEV_ID`, `DEV_DOMAIN` | `Web` outputs `DevDistributionId`, `DevDomainName` |
| `KVS_ARN` | `Web` output `DevAuthStoreArn` |
| `OLD_ORG_ZONE`, `OLD_COM_ZONE` | `Z0975952219HYWK0M3KBW`, `Z09867101HKHS3GND0YIE` (old account) |
| `OLD_PROD` | `E139BPMQTMFRUH` (old production distribution) |

Read outputs at any time with:

```bash
aws cloudformation describe-stacks --stack-name Web --profile jbliss-landslidesncgs \
  --query 'Stacks[0].Outputs' --output table
```

### 1. Bootstrap and deploy Dns

```bash
cd infra/cdk && npm ci
npx cdk bootstrap aws://710482330128/us-east-1 --profile jbliss-landslidesncgs
npx cdk deploy Dns --profile jbliss-landslidesncgs
```

The deploy pauses on the certificate: ACM writes two validation CNAMEs into
the new zones, which are not authoritative yet. In a second terminal, read
them and copy them into the old zones **(hand)**:

```bash
# new account: the two validation records (one per domain)
for z in landslidesncgs.org landslidesncgs.com; do
  ID=$(aws route53 list-hosted-zones-by-name --dns-name $z --profile jbliss-landslidesncgs --query 'HostedZones[0].Id' --output text)
  aws route53 list-resource-record-sets --hosted-zone-id "$ID" --profile jbliss-landslidesncgs \
    --query "ResourceRecordSets[?Type=='CNAME'].{Name:Name,Value:ResourceRecords[0].Value}" --output table
done
```

For each record, in the old account:

```bash
aws route53 change-resource-record-sets --hosted-zone-id OLD_ORG_ZONE --change-batch '{
  "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
    "Name": "<Name>", "Type": "CNAME", "TTL": 300,
    "ResourceRecords": [{"Value": "<Value>"}]}}]}'
```

(Use `OLD_COM_ZONE` for the `.com` record.) The certificate issues within a
few minutes and the deploy finishes. Check: `Dns` stack status `CREATE_COMPLETE`.

### 2. Deploy the rest with aliases off

```bash
npx cdk deploy --all --context cutover=wildcard --profile jbliss-landslidesncgs
```

In this stage the production distribution's only domain names are
`*.landslidesncgs.org` and `*.landslidesncgs.com`; dev has
`dev.landslidesncgs.org`. Check: four stacks `CREATE_COMPLETE`; note the
outputs listed above.

### 3. Seed the buckets (hand)

Data bucket, from a checkout that has `alerts/data/` (about 870 MB):

```bash
aws s3 sync alerts/data/buildings s3://landslidesncgs-data/alerts/data/buildings \
  --content-type application/json --cache-control "public, max-age=86400" --profile jbliss-landslidesncgs
aws s3 sync alerts/data s3://landslidesncgs-data/alerts/data --exclude "buildings/*" \
  --content-type application/json --cache-control "public, max-age=300" --profile jbliss-landslidesncgs
```

DFENS Simple data, via a local copy (the three small files):

```bash
aws s3 sync s3://landslides-ncgs/simple/data /tmp/simple-data
aws s3 sync /tmp/simple-data s3://landslidesncgs-data/simple/data --exclude status.json \
  --content-type application/json --cache-control "public, max-age=60" --profile jbliss-landslidesncgs
aws s3 cp /tmp/simple-data/status.json s3://landslidesncgs-data/simple/data/status.json \
  --content-type application/json --cache-control "public, max-age=30" --profile jbliss-landslidesncgs
```

Site and dev-site buckets are seeded by the deploy workflows in step 6. To
test earlier, run the two sync passes from `.github/workflows/deploy-site.yml`
by hand with the profile.

Check: `aws s3 ls s3://landslidesncgs-data/alerts/data/ --profile jbliss-landslidesncgs`
lists the live files and `buildings/`, `historical/`.

### 4. Set the two hand values (hand)

GitHub token (the existing fine-grained token, valid to 2027-10-21, can be
reused):

```bash
read -s TOKEN && aws secretsmanager put-secret-value --secret-id landslides/github-dispatch-token \
  --secret-string "$TOKEN" --profile jbliss-landslidesncgs && unset TOKEN
```

Dev basic-auth credential, typed as `user:password`:

```bash
read -s CRED
ETAG=$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn KVS_ARN --profile jbliss-landslidesncgs --query ETag --output text)
aws cloudfront-keyvaluestore put-key --kvs-arn KVS_ARN --key basic-auth \
  --value "$(printf '%s' "$CRED" | base64)" --if-match "$ETAG" --profile jbliss-landslidesncgs
unset CRED
```

Then stop the old account's triggers so only one fires:

```bash
for s in landslides-refresh-simple-10min landslides-github-token-expiry-reminder; do
  aws scheduler update-schedule --name $s --state DISABLED \
    --schedule-expression "$(aws scheduler get-schedule --name $s --query ScheduleExpression --output text)" \
    --flexible-time-window Mode=OFF \
    --target "$(aws scheduler get-schedule --name $s --query Target --output json)"
done
```

Check: `aws lambda invoke --function-name landslides-refresh-simple-trigger --profile jbliss-landslidesncgs /dev/stdout`
prints `"status": 204`.

### 5. Test before anything moves

CloudFront routes by hostname, so a request for `landslidesncgs.org` reaches
the old distribution no matter which address it resolves to. Test the new
distributions by the names only they can answer:

```bash
# host-independent pages and the data behaviors, straight at the new distribution
for p in / /alerts/ /simple/ /alerts/data/forecast_24h.geojson /simple/data/status.json /alerts/data/buildings/manifest.json; do
  printf '%-45s' "$p"; curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' "https://PROD_DOMAIN$p"
done

# the wildcard and the certificate, on a throwaway name
EDGE=$(dig +short PROD_DOMAIN | head -1)
curl -sI --resolve cut-test.landslidesncgs.org:443:$EDGE https://cut-test.landslidesncgs.org/alerts/ | head -3

# dev: 401, then 200 with the credential
EDGE=$(dig +short DEV_DOMAIN | head -1)
curl -s -o /dev/null -w '%{http_code}\n' --resolve dev.landslidesncgs.org:443:$EDGE https://dev.landslidesncgs.org/
curl -s -o /dev/null -w '%{http_code}\n' --resolve dev.landslidesncgs.org:443:$EDGE -u 'user:password' https://dev.landslidesncgs.org/
```

Rehearse the step 8 alias move on the throwaway name before any real
hostname moves: run the "new account: add" half of step 8 with
`NAME=cut-test.landslidesncgs.org`, confirm `curl -sI --resolve ...` above
still returns 200, then run the "old account: remove" half against
`PROD_ID` with the new-account profile (the same jq, removing the name
again), and confirm the wildcard answers the name once more. Both halves
must print the expected `grep -c` counts.

Host-dependent logic (dashboard mapping, inventory page, mapviewer
redirects) is covered by the function tests and can be exercised live with
`aws cloudfront test-function --name landslides-production --stage LIVE --event-object fileb://event.json --profile jbliss-landslidesncgs`
using an event whose `request.headers.host.value` is the host to test.

### 6. Switch the workflows

Fill the two `TODO-AFTER-FIRST-DEPLOY` values in
`.github/workflows/deploy-prod.yml` (`PROD_ID`) and
`.github/workflows/deploy-dev.yml` (`DEV_ID`), commit, and merge the branch
to `master` and `development`. From this moment every data write goes to the
new bucket, and the deploy workflows fill the site and dev-site buckets.

```bash
gh workflow run deploy-prod.yml --ref master
gh workflow run deploy-dev.yml --ref development
gh workflow run refresh-simple.yml --ref master -f force=true   # first run ignores the old status file
```

Check: all three runs green; `https://PROD_DOMAIN/` serves the site.
Steps 6 to 9 are done in one sitting so the old site serves stale data for
about an hour, not a day.

### 7. Repoint the subdomain records in the old zones (hand)

Nothing changes yet (the old distribution still holds the aliases), but
this makes step 8 a pure alias move. For each of
`www.landslidesncgs.org`, `dashboard.landslidesncgs.org`,
`inventory.landslidesncgs.org`, `mapviewer.landslidesncgs.org` in
`OLD_ORG_ZONE`, and `www.landslidesncgs.com`, `mapviewer.landslidesncgs.com`
in `OLD_COM_ZONE`:

```bash
aws route53 change-resource-record-sets --hosted-zone-id OLD_ORG_ZONE --change-batch '{
  "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
    "Name": "www.landslidesncgs.org", "Type": "A",
    "AliasTarget": {"HostedZoneId": "Z2FDTNDATAQYW2", "DNSName": "PROD_DOMAIN", "EvaluateTargetHealth": false}}}]}'
```

`Z2FDTNDATAQYW2` is CloudFront's fixed hosted zone id. Repeat with
`"Type": "AAAA"` where an AAAA record exists today (`dashboard`,
`inventory`).

### 8. Move the six subdomains with the wildcard method (hand)

One hostname at a time. Remove it from the old distribution, wait, add it to
the new one, wait, check. The new distribution's wildcard answers the name
in between, so there is no gap.

```bash
NAME=www.landslidesncgs.org

# old account: remove
aws cloudfront get-distribution-config --id OLD_PROD > /tmp/old.json
jq --arg name "$NAME" '.DistributionConfig | .Aliases.Items -= [$name] | .Aliases.Quantity = (.Aliases.Items | length)' /tmp/old.json > /tmp/old-config.json
jq --arg name "$NAME" '[.Aliases.Items[] | select(. == $name)] | length' /tmp/old-config.json   # must print 0
aws cloudfront update-distribution --id OLD_PROD --if-match "$(jq -r .ETag /tmp/old.json)" --distribution-config file:///tmp/old-config.json > /dev/null
aws cloudfront wait distribution-deployed --id OLD_PROD

# new account: add
aws cloudfront get-distribution-config --id PROD_ID --profile jbliss-landslidesncgs > /tmp/new.json
jq --arg name "$NAME" '.DistributionConfig | .Aliases.Items += [$name] | .Aliases.Quantity = (.Aliases.Items | length)' /tmp/new.json > /tmp/new-config.json
jq --arg name "$NAME" '[.Aliases.Items[] | select(. == $name)] | length' /tmp/new-config.json   # must print 1
aws cloudfront update-distribution --id PROD_ID --if-match "$(jq -r .ETag /tmp/new.json)" --distribution-config file:///tmp/new-config.json --profile jbliss-landslidesncgs > /dev/null
aws cloudfront wait distribution-deployed --id PROD_ID --profile jbliss-landslidesncgs

curl -sI https://$NAME/ | head -1
```

The check inspects the alias list, not the whole file: a distribution's
`Comment` may name its host. When the removal leaves an old distribution
with no alias, the same jq must also replace `.ViewerCertificate` with
`{CloudFrontDefaultCertificate: true, MinimumProtocolVersion: "TLSv1",
CertificateSource: "cloudfront"}`, because CloudFront rejects a custom
certificate with zero aliases.

`inventory.landslidesncgs.org` lives on old distribution `EQE7L8KCKTTWN`,
`mapviewer.landslidesncgs.org` on `EOBSDQ691NOUV` and
`mapviewer.landslidesncgs.com` on `E2PYK3QNTDKCOU`: use those ids in the
"remove" half. Rollback for any one name is the same pair of updates in
reverse. When all six are moved:

```bash
npx cdk deploy --all --context cutover=subdomains --profile jbliss-landslidesncgs
```

This matches the CDK state to what CloudFront already has and adds the six
records to the new zones.

### 9. Bridge the apex names (hand)

Update the old account's `landslides-rewrite` function so the two apex hosts
send visitors to `www`, which is already on the new account. Start from the
LIVE source, not the repo copy (the repo's piece has no `handler` any more):

```bash
aws cloudfront get-function --name landslides-rewrite --stage LIVE /tmp/landslides-rewrite-bridge.js
```

Edit `/tmp/landslides-rewrite-bridge.js` and add this at the top of its
`handler`, after `host` and `uri` are read:

```js
if (host === 'landslidesncgs.org' || host === 'landslidesncgs.com') {
    var q = '';
    var keys = Object.keys(request.querystring);
    for (var j = 0; j < keys.length; j++) {
        q += (q ? '&' : '?') + keys[j] + '=' + request.querystring[keys[j]].value;
    }
    return {
        statusCode: 302,
        statusDescription: 'Found',
        headers: { location: { value: 'https://www.' + host + uri + q } }
    };
}
```

```bash
ETAG=$(aws cloudfront describe-function --name landslides-rewrite --stage DEVELOPMENT --query ETag --output text)
aws cloudfront update-function --name landslides-rewrite --if-match "$ETAG" \
  --function-config Comment="Apex 302 bridge during account migration",Runtime=cloudfront-js-2.0 \
  --function-code fileb:///tmp/landslides-rewrite-bridge.js
ETAG=$(aws cloudfront describe-function --name landslides-rewrite --stage DEVELOPMENT --query ETag --output text)
aws cloudfront publish-function --name landslides-rewrite --if-match "$ETAG"
curl -sI https://landslidesncgs.org/alerts/ | grep -i '^location'
```

Expected: `location: https://www.landslidesncgs.org/alerts/`. If the
function fails to publish or the header is missing, re-publish the
unmodified LIVE source before going on.

From here every visitor reaches the new account.

### 10. Move the apex names (hand)

The wildcard method cannot move an apex and CloudFront requires the source
distribution to be disabled for a cross-account move, so this is the one
step with a gap: a few minutes, on the two bare names only, late in the
evening, while the bridge above has already sent visitors to `www`.

Ownership TXT records, in the old zones (still authoritative):

```bash
aws route53 change-resource-record-sets --hosted-zone-id OLD_ORG_ZONE --change-batch '{
  "Changes": [{"Action": "UPSERT", "ResourceRecordSet": {
    "Name": "_.landslidesncgs.org", "Type": "TXT", "TTL": 300,
    "ResourceRecords": [{"Value": "\"PROD_DOMAIN\""}]}}]}'
# same for _.landslidesncgs.com in OLD_COM_ZONE
```

Disable the old distribution, then move each apex from the new account:

```bash
aws cloudfront get-distribution-config --id OLD_PROD > /tmp/old.json
jq '.DistributionConfig | .Enabled = false' /tmp/old.json > /tmp/old-config.json
aws cloudfront update-distribution --id OLD_PROD --if-match "$(jq -r .ETag /tmp/old.json)" --distribution-config file:///tmp/old-config.json > /dev/null
aws cloudfront wait distribution-deployed --id OLD_PROD

for apex in landslidesncgs.org landslidesncgs.com; do
  ETAG=$(aws cloudfront get-distribution-config --id PROD_ID --profile jbliss-landslidesncgs --query ETag --output text)
  aws cloudfront update-domain-association --domain $apex \
    --target-resource DistributionId=PROD_ID --if-match "$ETAG" --profile jbliss-landslidesncgs
done
aws cloudfront wait distribution-deployed --id PROD_ID --profile jbliss-landslidesncgs

npx cdk deploy --all --context cutover=done --profile jbliss-landslidesncgs
```

**Immediately after the association, before the deploy**, repoint the apex
A and AAAA records in the old zones to `PROD_DOMAIN` (the step 11 command).
Disabling the old distribution withdraws its `*.cloudfront.net` name from
DNS, so the apex alias records resolve to nothing until they are
repointed; the gap lasts until then, not until the association deploys.
Resolvers that asked during the gap cache the empty answer for up to the
SOA TTL (900 s).

The last deploy records the eight exact aliases, drops the wildcards and
adds the apex records to the new zones. (The stage mechanism was removed
after the migration; the `done` state is now the only one the code knows.)

### 11. Repoint the apex records, then the name servers at GoDaddy (hand)

Apex A records in the old zones, as in step 7 but for `landslidesncgs.org`
and `landslidesncgs.com`. Check `curl -sI https://landslidesncgs.org/ | head -1`
returns `200` with no redirect.

Then the name servers. Read the new zones' servers:

```bash
for z in landslidesncgs.org landslidesncgs.com; do
  ID=$(aws route53 list-hosted-zones-by-name --dns-name $z --profile jbliss-landslidesncgs --query 'HostedZones[0].Id' --output text)
  echo "== $z"; aws route53 get-hosted-zone --id "$ID" --profile jbliss-landslidesncgs --query 'DelegationSet.NameServers' --output text
done
```

At GoDaddy, for each domain, replace the four `awsdns` name servers with the
four printed above. No DNSSEC is configured on either domain, so there is
nothing else to change there. Visitors see no change: the new zones hold
the same records the old zones now hold.

### 12. Wait 48 hours, then confirm

```bash
for r in 8.8.8.8 1.1.1.1 9.9.9.9; do dig +short NS landslidesncgs.org @$r; echo; done
for r in 8.8.8.8 1.1.1.1 9.9.9.9; do dig +short NS landslidesncgs.com @$r; echo; done
```

Every resolver must list only the new servers. Also confirm on the Actions
tab that `refresh-data.yml` ran at 04:00 UTC and `refresh-simple.yml` runs
every ten minutes, both as `workflow_dispatch`, and that
`https://landslidesncgs.org/simple/data/status.json` is fresh. Then run the
decommission list below.

### 13. Rewrite history and retire GitHub Pages

Do this after the DNS work, in a quiet moment, and tell the other contributors
first: they re-clone once afterwards.

```bash
git push origin --delete cloudfront-redirect simple-dashboard refresh-simple-trigger   # merged, stale
brew install git-filter-repo
git filter-repo --path alerts/data --invert-paths --force     # removes the origin remote
git remote add origin git@github.com:nemac/landslides-ncgs.git
git push --force --all origin
git push --force --tags origin
gh api -X DELETE repos/nemac/landslides-ncgs/pages              # retire the Pages site
```

If `master` has branch protection that blocks force pushes, lift it for
the push and restore it after. Fresh clones are small at once; the size
GitHub shows for the repository drops only after GitHub runs garbage
collection, which can be requested from GitHub Support and is cosmetic.

---

## Decommission list (old account, after step 12)

In this order, all on the default profile:

1. Distributions: `OLD_PROD` is already disabled; disable `EQE7L8KCKTTWN`,
   `EOBSDQ691NOUV`, `E2PYK3QNTDKCOU` the same way (step 10's jq), wait, then
   `aws cloudfront delete-distribution --id <id> --if-match <etag>` for all four.
2. Functions: `aws cloudfront delete-function --name <n> --if-match <etag>` for
   `landslides-rewrite` and `inventory-landslidesncgs-wrapper`.
3. Certificates: `e509892f-063c-4cc3-b884-bb97b90d9e39` and
   `ef7adc33-ff3f-422f-b590-80d5e2c12a57` with `aws acm delete-certificate`.
4. Hosted zones: delete every record except NS and SOA in `OLD_ORG_ZONE` and
   `OLD_COM_ZONE`, then `aws route53 delete-hosted-zone`.
5. Buckets: `landslidesncgs.com`, `landslidesncgs.org`, `www.landslidesncgs.com`,
   `www.landslidesncgs.org`, `mapviewer.landslidesncgs.com`,
   `mapviewer.landslidesncgs.org` (all empty: `aws s3 rb s3://<name>`), and
   last `landslides-ncgs` after confirming the new data bucket has everything
   (`aws s3 rb s3://landslides-ncgs --force`).
6. Trigger: Lambda `landslides-refresh-simple-trigger`, roles
   `landslides-refresh-simple-trigger-lambda` and `-scheduler`, secret
   `landslides/github-dispatch-token` (`--force-delete-without-recovery`),
   schedules `landslides-refresh-simple-10min` and
   `landslides-github-token-expiry-reminder`.
7. Role `landslides-github-actions-prod` (delete its inline policy first).

Do not touch the `*.nemac.org` certificate, the `nemac.org` zone, or
anything without `landslides` in its name. Once the old `landslides-ncgs`
bucket is deleted its name becomes free for anyone; that has no effect on
the site.

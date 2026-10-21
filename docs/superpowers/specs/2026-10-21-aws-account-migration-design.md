# Migrate landslides-ncgs to its own AWS account

Date: 2026-10-21. Status: approved by Jeff 2026-10-21. inventory.landslidesncgs.com is deliberately not created.

## Intent

Move every AWS resource that serves landslidesncgs.org and landslidesncgs.com
out of the shared NEMAC account (104538610210) into the dedicated
landslidesncgs account (710482330128), define all of it in AWS CDK, and stop
storing pipeline data in git. When this is done, GitHub holds only source
code, the NEMAC account holds nothing landslides-related, and the whole
runtime can be recreated from this repo with one CDK deploy plus a short
runbook of hand steps.

Why now: the project has its own account at last, the repo is at GitHub's
1 GB soft limit because 92 daily bot commits pushed about 870 MB of data,
and the current infrastructure exists only as console state plus one shell
script. Each extra resource added in the NEMAC account would be one more
thing to recreate later, so the move happens before anything else is built.

## Goals

- Every piece of runtime infrastructure for both domains lives in the
  landslidesncgs account and is defined in one CDK app in this repo.
- `alerts/data/` and `simple/data/` live only in S3. Git never holds data
  again, and the 1.8 GB history goes away.
- A password-protected development site at dev.landslidesncgs.org replaces
  the GitHub Pages site, showing live production data.
- No visible downtime for any subdomain during the cutover, and at most a
  few minutes of partial errors on the two bare apex names, at a chosen
  time, with a bridge in place so visitors still reach the site (see
  "Apex names" in the runbook).
- Nothing landslides-related remains in the NEMAC account afterwards.

## Non-goals

- Running the pipelines themselves on AWS (Fargate or Lambda). They stay on
  GitHub Actions for this pass, using new OIDC roles. The backlog keeps
  "Option B" as a later step.
- Reproducible snapshots of flagged runs. The data bucket is designed so
  that item can be added later (versioning on, a snapshots prefix reserved),
  but the snapshot logic is not part of this work.
- Any change to the site's HTML, CSS or JavaScript beyond what the data
  move requires. The frontend keeps fetching the same relative data paths.
- Changing the pipeline Python code. `scripts/refresh.py` and
  `simple/pipeline/` run unchanged; only the workflows around them change.

## Anti-goals

- A migration that technically works but leaves the public site, the
  dashboard subdomain, inventory or either mapviewer host returning errors
  beyond the apex window described in the runbook.
- A secret, password or token of any kind committed to this public repo,
  including inside the design document, the CDK app or a CloudFront
  Function.
- Infrastructure that still needs the console. If a value cannot be in CDK
  because it is a secret, it must be a documented hand step with the exact
  command.
- A second copy of anything. One site bucket, one data bucket, one
  production distribution, one dev distribution.
- A hand-made change that the next `cdk deploy` silently reverts.

## Constraints

- The repo `nemac/landslides-ncgs` is public. Actions minutes are free, and
  nothing sensitive may be in it.
- GitHub's cron scheduler is hours late for this repo (measured 4 to 8
  hours on the daily job). Anything time-sensitive is triggered from
  EventBridge Scheduler, as the DFENS Simple refresh already is.
- CloudFront picks the distribution by the TLS server name and Host header,
  not by IP address. An alias (alternate domain name) is globally unique
  across all accounts. Between accounts, CloudFront's alias-move API only
  works when the source distribution is disabled; the supported no-downtime
  method for subdomains is the wildcard method, and it does not work for
  apex names. A wildcard alias is itself unique, so `*.landslidesncgs.org`
  can be on only one distribution. (Verified in the CloudFront developer
  guide, "Move the alternate domain name".)
- CloudFront allows one CloudFront Function per event type per cache
  behavior, and a function's code must stay under 10 KB. Functions cannot
  import other files; only the `cloudfront` KeyValueStore module.
- CloudFront compresses only listed content types, between 1,000 bytes and
  10 MB. `application/json` is on the list; `application/geo+json` is not.
- Route 53 hosted zones cannot move between accounts. New zones get new
  name servers, so the registrar (GoDaddy, both domains) must be updated.
  DNSSEC is not enabled on either zone and no DS records are published, so
  the name-server change needs no DNSSEC steps.
- Bucket names are global. The old `landslides-ncgs` bucket keeps its name
  until it is deleted, so the new buckets need different names.
- Ian has no AWS access and works on Windows. His local workflow is
  `python scripts/refresh.py` plus a static server; that must keep working.
- The data is about 870 MB, of which 842 MB is building footprints across 77
  county files. Flagged files are 11 to 12 MB on wet days.
- The existing GitHub fine-grained token for the DFENS Simple trigger is
  valid until 2027-10-21 and can be reused in the new account's secret.
- Local AWS access: the new account is reached with the SSO profile
  `jbliss-landslidesncgs` (AdministratorAccess). The old account is the
  default profile.
- GitHub repo state, checked 2026-10-21: environment `production` exists
  with no protection rules and no branch policy; there is no `development`
  environment yet (a workflow that declares it creates it, with no rules);
  GitHub Pages is on, serving the `development` branch; the repo reports
  1.5 GB.

## What exists today

| Piece | Where | Notes |
|---|---|---|
| Site + data bucket `landslides-ncgs` | NEMAC, us-east-1 | 183 objects, 994 MB; site, `alerts/data/`, `simple/data/` |
| Distribution `E139BPMQTMFRUH` | NEMAC | aliases apex and www for both domains, plus `dashboard.landslidesncgs.org`; OAC origin; function `landslides-rewrite` on viewer-request |
| Distribution `EQE7L8KCKTTWN` | NEMAC | `inventory.landslidesncgs.org`; function `inventory-landslidesncgs-wrapper` returns an iframe page; placeholder origin |
| Distributions `EOBSDQ691NOUV`, `E2PYK3QNTDKCOU` | NEMAC | `mapviewer.landslidesncgs.org` and `.com`; origin is an empty S3 website bucket whose only job is a redirect to the ArcGIS web app viewer |
| Certs `e509892f` (apex + wildcard, both domains) and `ef7adc33` (apex + mapviewer) | NEMAC | DNS validated |
| Hosted zones for `.org` and `.com` | NEMAC | registrar GoDaddy, delegated to these zones. Contents: A/AAAA aliases for the eight hostnames, NS, SOA, and ACM validation CNAMEs. No mail, verification or other records. |
| IAM role `landslides-github-actions-prod` | NEMAC | OIDC trust on `repo:nemac/landslides-ncgs:environment:production` |
| Lambda `landslides-refresh-simple-trigger`, two roles, secret `landslides/github-dispatch-token`, schedules `landslides-refresh-simple-10min` and `landslides-github-token-expiry-reminder` | NEMAC | created by `infra/lambda/refresh-simple-trigger/deploy.sh` |
| Buckets `landslidesncgs.com`, `landslidesncgs.org`, `www.landslidesncgs.com`, `www.landslidesncgs.org`, `mapviewer.landslidesncgs.com` | NEMAC | 2020 and 2021 leftovers; empty; nothing points at them |
| GitHub Pages | repo settings | serves the `development` branch |
| Workflows `deploy-prod.yml`, `refresh-data.yml`, `refresh-simple.yml`, `token-expiry-reminder.yml` | repo | refresh-data commits data to master and dispatches the deploy |

Not in scope and not landslides-related: the `*.nemac.org` cert and every
other NEMAC distribution.

## Decisions

### Shape of the new account

One CDK app in TypeScript at `infra/cdk/`, deployed to us-east-1 (CloudFront
certs must be there anyway). It replaces `deploy.sh` and becomes the source
of record for everything below.

TypeScript rather than Python because the CDK and its docs are
TypeScript-first, the Python binding is generated and lags on typing, the
repo already depends on Node for ESLint and Prettier, and the CDK app never
shares code with the Python pipeline.

Stacks, in dependency order:

1. **Dns**: hosted zones for `landslidesncgs.org` and `landslidesncgs.com`,
   one ACM certificate covering both apexes and both wildcards, DNS
   validated (ACM uses one validation CNAME per domain, so two records).
   Records for every hostname below are defined here, pointing at the
   distributions in Web, behind the same context flag that controls the
   aliases (see runbook).
2. **Ci**: the GitHub OIDC provider and two roles:
   - `landslides-github-prod`: trust `repo:nemac/landslides-ncgs:environment:production`;
     read/write/delete on the site bucket, write on the data bucket,
     invalidation on the production distribution.
   - `landslides-github-dev`: trust `repo:nemac/landslides-ncgs:environment:development`;
     read/write/delete on the dev site bucket, invalidation on the dev
     distribution. No access to the data bucket.
3. **Web**: three buckets and two distributions in one stack, because the
   dev distribution reads the production data bucket and a cross-stack
   origin access control would create a CloudFormation cycle through the
   bucket policy.
   - Site bucket `landslidesncgs-site`: HTML, CSS, JS, assets. Private, OAC.
     Owned entirely by `deploy-prod.yml`, which syncs with `--delete` and no
     data excludes, because no data lives here.
   - Data bucket `landslidesncgs-data`: versioning on; prefixes
     `alerts/data/` and `simple/data/` written by the refresh workflows;
     `alerts/snapshots/` reserved for the later snapshot item. Private, OAC.
   - Dev site bucket `landslidesncgs-dev-site`. Private, OAC.
   - **Production distribution**, eight aliases: apex and www for both
     domains, `dashboard.landslidesncgs.org`, `inventory.landslidesncgs.org`,
     `mapviewer.landslidesncgs.org`, `mapviewer.landslidesncgs.com`. Two
     origins. Behaviors `alerts/data/*`, `simple/data/*` and `data/*` go to
     the data bucket; the default behavior goes to the site bucket. (The
     `data/*` behavior is for the dashboard host, where the browser asks for
     `/data/x` and the function rewrites it to `/alerts/data/x`; CloudFront
     chooses the behavior before the function runs and does not re-match
     afterwards.) Compression on. A response headers policy adds HSTS and
     `X-Content-Type-Options: nosniff` (the managed security headers policy;
     CSP is still a backlog item).
     One viewer-request function on every behavior, composed at synth time
     from two source files (see "CloudFront Functions" below): the hosted
     redirects for inventory and mapviewer, then the existing rewrite.
   - **Dev distribution**, one alias `dev.landslidesncgs.org`. Default
     origin is the dev site bucket; the same three data behaviors point at
     the production data bucket, so dev shows live data with no copying and
     no CORS. One viewer-request function on every behavior, composed from
     basic auth then the rewrite. No dashboard host mapping.
4. **Trigger**: Secrets Manager secret `landslides/github-dispatch-token`
   (CloudFormation gives it a random generated value until the real token
   is set), the Lambda from `infra/lambda/refresh-simple-trigger/handler.py`
   (python3.12, stdlib plus boto3), its execution role, the scheduler role,
   and these schedules:
   - `landslides-refresh-simple-10min`: rate 10 minutes, empty payload
     (dispatches `refresh-simple.yml`). Created ENABLED. Until the secret is
     set the Lambda logs a GitHub 401 every ten minutes, which is harmless,
     and the workflow's own cron is the backup. Nothing about its state is
     changed by hand, so a later deploy cannot revert it.
   - `landslides-refresh-data-daily`: cron 04:00 UTC, payload
     `{"workflow_file": "refresh-data.yml"}`. New. The nightly refresh no
     longer relies on GitHub cron. (My call; the Lambda already supports
     this payload.)
   - `landslides-github-token-expiry-reminder-2027-09-21`: one-time at
     2027-09-21T13:00:00 UTC, payload
     `{"workflow_file": "token-expiry-reminder.yml"}`. No self-delete:
     CloudFormation owns its lifecycle. The expiry date and reminder date
     are two constants at the top of the Trigger stack, and the date is part
     of the construct id, so renewing the token replaces the schedule with
     a new one and removes the old.
   `deploy.sh` is deleted once this stack is deployed.

### CloudFront Functions

Source pieces live in `infra/cloudfront/`, one concern per file, with the
existing `landslides-rewrite.js` unchanged as the core:

- `landslides-rewrite.js`: slash redirect, dashboard host map, index append
  (as today).
- `landslides-hosted-redirects.js`: on Host `inventory.landslidesncgs.org`
  return the iframe wrapper page, body and headers exactly as today's
  `inventory-landslidesncgs-wrapper` (target
  `https://experience.arcgis.com/experience/cd122ec3a6414d8e80ca93f5efe6bcb5`);
  on either mapviewer host return a 301 to
  `https://unca.maps.arcgis.com/apps/webappviewer/index.html?id=e9f79de934f24e40a71bab8db8050612`;
  otherwise fall through.
- `landslides-basic-auth.js`: read the expected `Basic` credential from the
  function's KeyValueStore (key `basic-auth`, value is the base64 of
  `user:password`), compare to the Authorization header, and on mismatch or
  a missing key return 401 with `WWW-Authenticate: Basic realm="landslides dev"`;
  otherwise fall through.

Because CloudFront allows one function per event per behavior, the CDK app
composes one function per distribution at synth time: production is
hosted-redirects then rewrite; dev is basic-auth then rewrite. Both run on
`cloudfront-js-2.0` (the KeyValueStore needs it, and the dev handler is
async). Each composed function must stay under 10 KB; the iframe page is
about 0.6 KB, so there is room. The KeyValueStore is created by CDK with no
value, and the value is set once by hand (runbook). The username and
password are known to Jeff and are never written down in the repo.

### How CDK is run

`cdk deploy` runs from a developer machine with the `jbliss-landslidesncgs`
SSO profile. No CI role has rights to change infrastructure. A PR check
runs `cdk synth` with no credentials so a broken app cannot be merged. (My
call: the project has one infrastructure maintainer and this avoids a
privileged CI role.)

### Cache-Control, content types and compression

Set at write time, per file class, by whichever workflow writes the object:

| Files | Cache-Control |
|---|---|
| HTML, CSS, JS (site and dev buckets) | `no-cache` |
| `assets/*` | `public, max-age=86400` |
| `alerts/data/buildings/*` | `public, max-age=86400` |
| every other file under `alerts/data/` | `public, max-age=300` |
| `simple/data/*` | as `refresh-simple.yml` sets today (60 s data, 30 s status) |

Every `.geojson` is uploaded with `Content-Type: application/json`, because
CloudFront does not compress `application/geo+json`. The browser code uses
`fetch().json()` and does not care. Flagged files above 10 MB are served
uncompressed either way; pre-compressing them is left to the builder as
optional and not needed for cutover.

The site deploys still invalidate `/*` after a sync, since HTML is
`no-cache` rather than versioned. Data uploads never invalidate.

### Data leaves git

- `refresh-data.yml` no longer checks out with write credentials, commits,
  pushes or dispatches a deploy. It declares `environment: production` so
  it can assume the prod role. Before the run it copies the buildings
  manifest from the bucket (the checkout no longer has one) and restores
  its mtime as today, so the monthly buildings re-extract still fires.
  After `scripts/refresh.py` it syncs `alerts/data/` to
  `s3://landslidesncgs-data/alerts/data/` with the classes above. If
  `refresh.py` exits non-zero, nothing is uploaded (the partial-results
  split stays a backlog item).
- `alerts/data/` is removed from tracking and added to `.gitignore`.
- History is rewritten with `git filter-repo --path alerts/data --invert-paths`
  on every branch and force-pushed. Ian re-clones once. Stale branches
  (`cloudfront-redirect`, `simple-dashboard`, `refresh-simple-trigger`, all
  merged) are deleted from origin first rather than rewritten. Fresh clones
  are small immediately; the size GitHub reports for the repo only drops
  after GitHub runs garbage collection, which can be requested from GitHub
  Support and is cosmetic.
- Fresh checkouts have no data. `OPERATIONS.md` documents two ways to get
  it: anyone with account access runs one `aws s3 sync` from the data
  bucket; anyone else runs `python scripts/refresh.py`, which regenerates
  everything (5 to 15 minutes the first time because of buildings). No
  HTTPS download script. (My call: the bucket is private behind OAC, and
  the only person without account access already runs the pipeline.)
- GitHub Pages is disabled in the repo settings. The `development` branch
  now deploys to dev.landslidesncgs.org instead.

### Workflows after the change

| Workflow | Trigger | Does |
|---|---|---|
| `deploy-prod.yml` | push to `master`, manual | sync repo to site bucket with Cache-Control classes, invalidate prod distribution; `environment: production` |
| `deploy-dev.yml` | push to `development`, manual | same, to the dev site bucket and dev distribution; `environment: development` |
| `refresh-data.yml` | manual (dispatched daily by EventBridge), GitHub cron kept as backup | run `refresh.py`, sync `alerts/data/` to the data bucket; `environment: production` |
| `refresh-simple.yml` | manual (dispatched every 10 min), GitHub cron kept as backup | unchanged except role, bucket and content type |
| `token-expiry-reminder.yml` | manual (dispatched once by EventBridge) | unchanged |
| `ci.yml` | pull request | `cdk synth`, plus the lint and format checks from the backlog if they are cheap to add |

Deploy workflows exclude only what is not web content: `.git`, `.github`,
`infra`, `scripts`, `docs`, `simple/pipeline`, Python, Markdown, editor
config, `node_modules`, `package*.json`, and config files at the root.
No data excludes remain.

Account id, bucket names, distribution ids and role ARNs appear in the
workflows only as `env:` values at the top of each file, as today.

### Cutover runbook

Two facts shape the order. CloudFront routes by hostname, so a hostname is
served by whichever distribution holds its alias, regardless of which
distribution the DNS record points at; the alias move is therefore the real
cutover for each hostname, and `curl --resolve` against a hostname the old
distribution still holds tests the old distribution, not the new one. And
the new distributions cannot hold the real hostnames before the move, so
host-dependent logic is tested with `aws cloudfront test-function` and with
throwaway hostnames under the wildcard.

Steps marked (hand) cannot be in CDK.

1. Bootstrap CDK in the new account. Deploy **Dns** with the hostname
   records off (context flag `aliases=false`). ACM writes two validation
   CNAMEs into the new zones, which are not authoritative yet, so copy
   them into the old zones by hand (hand); the certificate issues within
   minutes and the deploy completes.
2. Deploy **Ci**, **Web** and **Trigger** with `aliases=false`. In that
   mode the production distribution's domain names are just the two
   wildcards `*.landslidesncgs.org` and `*.landslidesncgs.com`, and the dev
   distribution's is `dev.landslidesncgs.org` (a new name, no move needed).
   Both carry the certificate from step 1. This satisfies the CDK rule that
   a certificate needs at least one domain name.
3. Seed the data bucket: `aws s3 sync` of `alerts/data/` from the current
   checkout, and `simple/data/` from the old bucket. Seed the site and dev
   site buckets with one hand sync each (the workflows take over in step 6).
4. Set the two hand values (hand): the GitHub token into the new secret
   (`read -s` then `put-secret-value`, as the trigger README shows), the
   basic-auth credential into the KeyValueStore. Disable the old account's
   two schedules so only one trigger fires.
5. Test before any move. Logic: `test-function` with recorded events for
   each host and path case. Live: hit the production distribution's
   `*.cloudfront.net` domain for host-independent paths (apex pages, alerts,
   simple, data behaviors), and a throwaway hostname such as
   `cut-test.landslidesncgs.org` with `curl --resolve` for TLS and the
   wildcard. Dev: `curl --resolve` on `dev.landslidesncgs.org` expects 401,
   then 200 with the credential. Rehearse the rollback of step 8 on the
   throwaway name.
6. Merge the workflow changes to `master` and `development`. From here
   every data write goes to the new bucket. Dispatch `refresh-simple.yml`
   once with `force=true` so its change check does not compare against the
   old site's status file. Steps 6 to 9 happen in one sitting so the old
   site serves stale data for about an hour, not a day.
7. Point the old zones' A and AAAA records for the six subdomains at the
   new distributions (hand). Nothing changes yet: the old distribution
   still holds the aliases and keeps serving.
8. Move the six subdomains with the wildcard method (hand), one at a time,
   waiting for each distribution update to deploy: remove the alias from
   the old distribution, add it to the new one, confirm with `dig` and a
   request. Rollback for any one name is the reverse pair of updates. When
   all six are done, deploy with `aliases=true`, which adds the six exact
   aliases and their Route 53 records in the new zones and is otherwise a
   no-op.
9. Bridge the apex names (hand): update the old distribution's rewrite
   function so a request on either apex host returns a 302 to the same
   path on the matching www host, and publish it. From this moment every
   visitor reaches the new account; the old distribution only answers the
   two apexes with a redirect.
10. Move the apex names with Option A below (Jeff's decision, 2026-10-21:
    a short gap is acceptable anywhere except inventory.landslidesncgs.org,
    which is a subdomain and moves with no gap in step 8). First add the
    ownership TXT records `_.landslidesncgs.org` and `_.landslidesncgs.com`
    (value: the new distribution's domain) to the old zones (hand).
11. Point the old zones' apex A records at the new distribution (hand),
    then update the name servers at GoDaddy for both domains (hand) to the
    four servers of each new zone.
12. Wait at least 48 hours, confirm `dig NS` from several resolvers shows
    only the new servers, confirm the daily and 10-minute refreshes have
    run from the new account, then run the decommission list.
13. Rewrite history and force-push; Ian re-clones; disable GitHub Pages.
    The order of this step against the rest does not matter; it is last
    only so the force-push does not coincide with the DNS work.

#### Apex names

- **Option A, self-service, a few minutes of partial errors.** With the 302
  bridge from step 9 in place, disable the old distribution (it then serves
  only the apex redirects), run `aws cloudfront update-domain-association`
  from the new account for each apex, and deploy with the apex aliases on.
  While the disable and the new aliases propagate, some edge locations
  return a CloudFront error for the bare apex names. Subdomains and www are
  unaffected. Done late in the evening this is a few minutes for a handful
  of visitors, and anyone who hit the apex earlier already followed the
  bridge to www.
- **Option B, AWS Support, no gap.** With the TXT records and the bridge
  in place, open a Support case asking CloudFront to move the two apex
  aliases to the new distribution while both stay enabled. The site runs
  on the bridge until Support acts, which can take days, and the new
  account's support plan may limit this.

Decision: Option A. Option B stays here only as the fallback if the
alias move is refused for any reason.

### Decommission list (old account, after step 12)

Delete, in this order: the four distributions (disable, wait, delete), the
three CloudFront Functions, the two certificates, both hosted zones, the
seven buckets (`landslides-ncgs` last, after confirming the new data
bucket has everything), the Lambda, its two roles, the secret, the two
schedules if not already gone, the role `landslides-github-actions-prod`.
Leave the orphaned ACM validation CNAMEs alone; they go with the zones.
Do not touch the `*.nemac.org` certificate or anything without
`landslides` in its name.

Once the old `landslides-ncgs` bucket is deleted its name becomes free for
anyone; that has no effect on the site.

### Repo housekeeping in the same change

- `BACKLOG.md`: remove the "Move alerts/data out of git", "Everything on
  AWS except the code" step 1, and "Migrate the DFENS Simple trigger"
  items; keep Option B and snapshots; add the decommission date.
- `OPERATIONS.md`, `README.md`, `alerts/README.md`, `simple/README.md`,
  `infra/lambda/refresh-simple-trigger/README.md` and
  `infra/cloudfront/README.md`: update to the new account, buckets, dev
  site and the `cdk deploy` workflow. The CloudFront README no longer
  describes hand updates of the function; CDK deploys it.
- Memory and docs that cite account 104538610210 or the old ids are
  updated.

## Left to the builder

- Exact CDK construct choices and stack file layout, including how the two
  source files are composed into one function per distribution at synth
  time, and whether the L2 `Distribution` or an L1 override is used for the
  KeyValueStore association.
- How the `aliases` context flag is wired, and the `cdk.json` layout.
- The shape of `ci.yml` and whether lint checks ride along.
- Whether to pre-compress data files above 10 MB.
- Exact `aws s3 sync` invocations for the Cache-Control classes and the
  content type (several passes with include/exclude is fine).
- Test approach for the three function pieces and the two composed
  functions. `aws cloudfront test-function` with recorded events is
  expected; unit tests in plain JavaScript are acceptable.
- Ordering and wording inside the runbook steps, as long as every subdomain
  stays up, the apex gap stays within Option A, and no secret enters the
  repo.

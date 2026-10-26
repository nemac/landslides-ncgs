# AWS account migration: handoff for the cutover session

Written 2026-10-21 at the end of the implementation session. Read this
first, then `infra/README.md` (the runbook). The runbook is executed by
hand, step by step, with Jeff present; nothing in it has been run yet.

## What this is

Every AWS resource behind landslidesncgs.org and landslidesncgs.com is
moving from the shared NEMAC account (**104538610210**, the default AWS
profile on Jeff's machine) to the dedicated landslidesncgs account
(**710482330128**, SSO profile `jbliss-landslidesncgs`, AdministratorAccess).
The new account is empty. All infrastructure is now defined as a TypeScript
CDK app in `infra/cdk/`; pipeline data leaves git and lives only in S3; the
GitHub Pages dev site is replaced by dev.landslidesncgs.org behind basic auth.

Documents, in reading order:

| File | What |
|---|---|
| `docs/superpowers/specs/2026-10-21-aws-account-migration-design.md` | The approved design. Binding on any question of intent. |
| `docs/superpowers/plans/2026-10-21-aws-account-migration.md` | The implementation plan that was executed. |
| `infra/README.md` | **The cutover runbook.** 13 numbered steps plus a decommission list. |
| `infra/cloudfront/README.md`, `infra/lambda/refresh-simple-trigger/README.md` | The function pieces and the trigger Lambda. |
| `OPERATIONS.md`, `BACKLOG.md` | Day-to-day operations; open items. |

## State of the code

- Branch `jeffs-improvements`, pushed. Pull request
  **nemac/landslides-ncgs#10** against `master`, open, **not to be merged
  until runbook step 6**. Merging earlier points the deploy and refresh
  workflows at buckets and roles that do not exist yet, and stops the old
  site's nightly refresh.
- `master` still runs the old workflows (commit data to git, deploy to the
  old bucket). It receives one bot commit a day from `refresh-data.yml`;
  merge `master` into the branch before step 6 if it has moved.
- Local checkout: clean, in sync with origin. `alerts/data/` is on disk but
  untracked and ignored.
- Verified green on the final tree: `cd infra/cdk && npm run typecheck && npm test`
  (34 tests), `node --test "infra/cloudfront/test/*.test.js"` (18),
  `actionlint`, `cdk synth` at all three cutover stages, the Lambda's
  `python3 -m unittest test_handler`.
- A fresh reviewer (Fable 5.1) reviewed the whole branch; the Critical
  and Important findings were fixed. Deferred minors are listed below.

## What was built

- **CDK app** `infra/cdk/` (aws-cdk-lib 2.274.0 pinned, tsx, node:test).
  Stacks in deploy order: `Dns` (both hosted zones, one DNS-validated cert
  for both apexes and both wildcards), `Web` (buckets `landslidesncgs-site`,
  `landslidesncgs-data` versioned, `landslidesncgs-dev-site`; the production
  distribution; the dev distribution with a KeyValueStore
  `landslides-dev-basic-auth`; the Route 53 records), `Ci` (GitHub OIDC
  provider; roles `landslides-github-prod` and `landslides-github-dev`),
  `Trigger` (secret `landslides/github-dispatch-token`, Lambda
  `landslides-refresh-simple-trigger`, schedules every 10 min, daily 04:00
  UTC, and a one-time token reminder). Every stack is termination
  protected; zones, distributions and buckets are RETAIN.
- **Context flag `cutover`** = `wildcard` (default) | `subdomains` | `done`
  selects the production distribution's alias list. The runbook moves
  through them in order. After step 10, edit `infra/cdk/cdk.json` to make
  `done` the default.
- **Production distribution**: eight aliases (apex and www for both
  domains, dashboard, inventory, mapviewer .org and .com), two origins,
  behaviors `alerts/data/*`, `simple/data/*`, `data/*` to the data bucket,
  compression on, managed security headers policy, one viewer-request
  function composed from `landslides-hosted-redirects.js` (inventory
  iframe page, mapviewer 301s) and `landslides-rewrite.js`.
- **Dev distribution**: alias `dev.landslidesncgs.org`, dev site bucket as
  default origin, production data bucket for the data behaviors, one
  function composed from `landslides-basic-auth.js` and the rewrite.
- **Workflows**: `deploy-site.yml` (reusable: two sync passes with
  Cache-Control classes, invalidate), `deploy-prod.yml` (push to master)
  and `deploy-dev.yml` (push to development) call it; `refresh-data.yml`
  uploads `alerts/data/` to the data bucket with no commit and no
  `--delete`; `refresh-simple.yml` writes `simple/data/` to the data
  bucket; `ci.yml` runs typecheck, tests, synth and function tests on PRs.
  Two placeholders `TODO-AFTER-FIRST-DEPLOY` (the distribution ids) in the
  two deploy callers are filled at runbook step 6 from the `Web` outputs.
- **Data**: every `.geojson` is uploaded as `application/json` so
  CloudFront compresses it; buildings and assets `max-age=86400`, other
  data `max-age=300`, pages `no-cache`.

## Facts the runbook relies on (verified 2026-10-21)

- Old account resources: distribution `E139BPMQTMFRUH` (site, five
  aliases, function `landslides-rewrite`), `EQE7L8KCKTTWN` (inventory,
  function `inventory-landslidesncgs-wrapper`), `EOBSDQ691NOUV` and
  `E2PYK3QNTDKCOU` (mapviewer .org/.com, redirect via an empty S3 website
  bucket); certs `e509892f-...` and `ef7adc33-...`; zones
  `Z0975952219HYWK0M3KBW` (.org) and `Z09867101HKHS3GND0YIE` (.com);
  bucket `landslides-ncgs` (183 objects, 994 MB); role
  `landslides-github-actions-prod`; Lambda, two roles, secret and two
  schedules for the trigger; six empty leftover buckets from 2020/2021.
- Both zones hold only A/AAAA aliases for the site hostnames, NS, SOA and
  ACM validation CNAMEs. No mail or verification records. DNSSEC is off
  and no DS records exist at GoDaddy. Registrar for both domains: GoDaddy.
- `inventory.landslidesncgs.com` does not exist and must not be created.
- GitHub: environment `production` exists with no protection rules;
  `development` does not exist yet (the first `deploy-dev.yml` run creates
  it); GitHub Pages serves the `development` branch; repo size 1.5 GB.
- The GitHub fine-grained token for the trigger (Actions: read/write)
  expires 2027-10-21 and can be reused in the new secret.
- GitHub's cron is hours late for this repo; EventBridge is the real
  trigger. The old account's schedules are disabled at runbook step 4.
- CloudFront routes by hostname, not IP. Cross-account alias moves: the
  wildcard method for the six subdomains (no gap); the two apexes need the
  old distribution disabled and `aws cloudfront update-domain-association`
  (a few minutes of partial errors on the bare apex only, bridged by a 302
  to www added to the old function in step 9). Jeff accepted this; the one
  host that must never drop, inventory, is a subdomain and never does.

## Hand values (never in the repo)

- The dev site username and password: Jeff knows them. They go into the
  KeyValueStore at runbook step 4 as base64 of `user:password`. Do not
  write them into any file, commit, or chat log.
- The GitHub token: set at step 4 with `read -s`.

## Deferred review minors (not done; Jeff decides)

- Runbook step 5: `aws cloudfront test-function` needs `--if-match <etag>`.
- Runbook step 7: UPSERT both A and AAAA for all six names, and add
  `dev.landslidesncgs.org` (A and AAAA to the dev distribution) to the old
  .org zone so dev resolves before the name-server change propagates.
- Runbook step 8: a distribution left with zero aliases may need
  `ViewerCertificate` switched to the CloudFront default cert; check that
  the AWS CLI has `update-domain-association` before starting step 10.
- `Ci` stack: the prod role has `s3:Delete*` on the data bucket via
  `grantReadWrite`; `grantPut` plus `grantRead` would match the spec's
  "write".
- Runbook intro says nothing is turned off before step 10; step 4
  disables the two old schedules.
- `read -rs` for the credential prompts.
- Style: `devAuthStore!` definite assignment in `web-stack.ts`.
- `ci.yml` blocks merges only if the `infra` job is made a required status
  check on `master`.

## Suggested first message for the cutover session

> Read `docs/superpowers/2026-10-21-aws-migration-handoff.md`, then
> `infra/README.md`. Confirm the local checkout is on `jeffs-improvements`
> and clean, that `aws sts get-caller-identity --profile jbliss-landslidesncgs`
> returns account 710482330128, and that `master` has not moved past the
> branch. Then walk me through runbook step 1. Stop before every (hand)
> command that changes either AWS account or GoDaddy and show me the exact
> command first.

## Cutover progress

### 2026-10-26: step 12 passed, old account decommissioned

Step 12 checks passed on 2026-10-22 (every public resolver on the new
servers; `refresh-data.yml` at 04:00 UTC and `refresh-simple.yml` every
ten minutes, both `workflow_dispatch`; `status.json` fresh) and again on
2026-10-26 before the teardown. The decommission list ran on 2026-10-26
between 14:55 and 15:05 UTC, in the runbook's order, after confirming the
new data bucket held all 102 of the old bucket's data objects:

- Distributions `E139BPMQTMFRUH`, `EQE7L8KCKTTWN`, `EOBSDQ691NOUV`,
  `E2PYK3QNTDKCOU` (disabled, then deleted); functions `landslides-rewrite`
  and `inventory-landslidesncgs-wrapper`; certificates `e509892f-...` and
  `ef7adc33-...` (ACM accepted the deletes at once); hosted zones
  `Z0975952219HYWK0M3KBW` (17 records) and `Z09867101HKHS3GND0YIE`
  (11 records); the six empty hostname buckets and `landslides-ncgs`
  (183 objects, never versioned); schedules, Lambda, secret and the two
  trigger roles; role `landslides-github-actions-prod` with its inline
  policy `landslides-s3-cloudfront-deploy`.
- Also removed, found by a final sweep: log group
  `/aws/lambda/landslides-refresh-simple-trigger` and origin access
  control `landslides-ncgs-oac` (`E14O35ATI4G7HM`).
- Nothing else in the NEMAC account was touched. The GitHub OIDC provider
  there is shared with other NEMAC projects and stays.
- Every hostname answered 200 or its expected 301/401 afterwards, and the
  Simple data kept refreshing.

Remaining: step 13 (history rewrite and GitHub Pages retirement), after
telling Ian.

### 2026-10-21 evening: runbook steps 6 to 10 done, step 11 apex records done

Every hostname is served by the new account. PR nemac/landslides-ncgs#10
merged to `master` as 5e61a82; `development` fast-forwarded to it. The
production distribution holds the eight exact aliases, `cdk.json` defaults
to `cutover=done`, and `cdk diff` is clean. The apex A and AAAA records in
the old zones already point at `PROD_DOMAIN` (done inside step 10, see
below). **Resume at step 11's name-server change at GoDaddy**, then step 12.

Timings and findings from steps 6 to 10:

- Step 8: each alias move took about two minutes; no host ever returned an
  error. The runbook's `grep -c` check tripped on `EQE7L8KCKTTWN` because
  its Comment names the host; the script stopped before changing anything
  and the check now inspects the alias list (runbook updated). Removing the
  last alias from the three single-host distributions worked with the
  certificate switched to the CloudFront default in the same update.
- The mapviewer `.com` distribution id was mistyped in the docs; it is
  `E2PYK3QNTDKCOU` (fixed everywhere).
- Step 9: the bridge reached the edge within five seconds of publishing.
  The unmodified LIVE source is not needed again; the old function is on
  the decommission list.
- Step 10: disabled `E139BPMQTMFRUH` at 22:37 UTC (deployed 22:40), both
  associations succeeded at 22:40. Disabling the distribution withdrew
  `d3jh2fu1jt5on0.cloudfront.net` from DNS, so the apex alias records in
  the old zones resolved to nothing until repointed at 22:41. Resolvers
  that asked in that window cache the empty answer up to 900 s. Runbook
  updated to repoint the apex records immediately after the association.
- Old account state now: `E139BPMQTMFRUH` disabled with no aliases; the
  three single-host distributions enabled with no aliases on the default
  certificate; `landslides-rewrite` LIVE carries the apex bridge (unused);
  old zones still authoritative and identical to the new ones except NS,
  SOA, ACM validation CNAMEs and the two `_.` TXT ownership records.

### 2026-10-21 afternoon: runbook steps 1 to 5 done

All four stacks are `CREATE_COMPLETE` in 710482330128 and every step 5
check passed.

| Placeholder | Value |
|---|---|
| `PROD_ID` | `E2ERQC7EESP0UJ` |
| `PROD_DOMAIN` | `d1l2ettg5f95r5.cloudfront.net` |
| `DEV_ID` | `E3AS4HL2G2AKTI` |
| `DEV_DOMAIN` | `d25hk2rsm9ccef.cloudfront.net` |
| `KVS_ARN` | `arn:aws:cloudfront::710482330128:key-value-store/c057491b-60d9-4fb9-aa9b-23f754803a24` |
| New `.org` zone | `Z004871826306EDVE3SHV` |
| New `.com` zone | `Z0537419FRWL9VN4J5ZN` |
| Certificate | `arn:aws:acm:us-east-1:710482330128:certificate/1c053a7f-47b7-4126-82b6-395725f39247` (ISSUED) |

State at the end of the sitting:

- Old account changes so far: two ACM validation CNAMEs added to the old
  zones; schedules `landslides-refresh-simple-10min` and
  `landslides-github-token-expiry-reminder` DISABLED. Nothing else.
- New account: data bucket seeded (102 objects, 914 MB); both site buckets
  seeded by hand with the workflow's two sync passes (80 objects each), so
  the step 6 workflow runs only reconcile. Token in the secret (copied
  from the old secret, never typed); `basic-auth` key set in the KVS and
  dev tested 401 then 200 with the credential.
- The new 10-minute schedule is live and dispatches `refresh-simple.yml`
  on `master`, which until step 6 is the old workflow writing to the old
  bucket. `landslides-refresh-data-daily` (04:00 UTC) dispatches the old
  `refresh-data.yml`, which still commits data to `master`: merge `master`
  into the branch before step 6.
- Step 5 rehearsal of the step 8 alias move on `cut-test.landslidesncgs.org`
  passed both halves; the production distribution is back to the two
  wildcards only.
- Deferred minors applied: Ci role `grantRead` + `grantPut` on the data
  bucket (commit 5aa59bd); `--if-match` on `test-function`; `read -rs`.
- Deferred minors still to apply when their step comes: step 7, UPSERT
  both A and AAAA for all six names and add `dev.landslidesncgs.org`
  (A and AAAA to `DEV_DOMAIN`) to the old `.org` zone; step 8, if removing
  the last alias from `EQE7L8KCKTTWN`, `EOBSDQ691NOUV` or `E2PYK3QNTDKCOU`
  is rejected, set `ViewerCertificate.CloudFrontDefaultCertificate=true`
  in the same update.
- Lessons: the CDK needs a live SSO token (`aws sso login --profile
  jbliss-landslidesncgs`) even when the CLI still works from its cache. A
  hand seed from a developer checkout needs `--exclude` for
  `node_modules/*`, `.ruff_cache/*` and `.superpowers/*` on top of the
  workflow's list; they were uploaded and then removed.

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
  `E2PYK3QNTDCOU` (mapviewer .org/.com, redirect via an empty S3 website
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

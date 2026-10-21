# AWS Account Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define every landslidesncgs.org/.com runtime resource in a TypeScript CDK app for AWS account 710482330128, rewire the GitHub workflows to it, take pipeline data out of git, and leave a runbook that moves the live site over with no gap on any subdomain.

**Architecture:** One CDK app at `infra/cdk/` with four stacks (Dns, Web, Ci, Trigger). The production and dev CloudFront distributions each get one viewer-request function composed at synth time from single-purpose source files in `infra/cloudfront/`. GitHub Actions keep running the Python pipelines and write only to S3 through two OIDC roles. The cutover itself is a documented hand procedure in `infra/README.md`, executed after this plan ships.

**Tech Stack:** TypeScript, aws-cdk-lib 2.x (2.200.0 or newer, pinned exact), constructs, tsx, Node 22 `node:test`, CloudFront Functions on `cloudfront-js-2.0`, GitHub Actions, AWS CLI v2.

**Spec:** `docs/superpowers/specs/2026-10-21-aws-account-migration-design.md`

## Global Constraints

- Target account `710482330128`, region `us-east-1`, local profile `jbliss-landslidesncgs`. No CI role may change infrastructure; CI runs `cdk synth` only.
- Bucket names: `landslidesncgs-site`, `landslidesncgs-data`, `landslidesncgs-dev-site`. Role names: `landslides-github-prod`, `landslides-github-dev`. Lambda `landslides-refresh-simple-trigger`. Secret `landslides/github-dispatch-token`. Schedules `landslides-refresh-simple-10min`, `landslides-refresh-data-daily`, `landslides-github-token-expiry-reminder-2027-09-21`. KeyValueStore `landslides-dev-basic-auth`, key `basic-auth`.
- Production aliases, exactly eight: `landslidesncgs.org`, `www.landslidesncgs.org`, `landslidesncgs.com`, `www.landslidesncgs.com`, `dashboard.landslidesncgs.org`, `inventory.landslidesncgs.org`, `mapviewer.landslidesncgs.org`, `mapviewer.landslidesncgs.com`. Dev alias: `dev.landslidesncgs.org`. `inventory.landslidesncgs.com` is deliberately never created.
- Context key `cutover` selects the production domain list: `wildcard` gives `*.landslidesncgs.org` and `*.landslidesncgs.com`; `subdomains` gives the six non-apex names plus both wildcards; `done` gives the eight exact names and no wildcards. Default `wildcard`. Route 53 records are created only for names in the exact list, plus dev always.
- Behaviors on both distributions: `alerts/data/*`, `simple/data/*`, `data/*` to the data bucket; default to the site (or dev site) bucket. Compression on. Security headers policy on production.
- One viewer-request function per distribution, `cloudfront-js-2.0`, composed code under 10,240 bytes.
- Cache-Control classes: HTML/CSS/JS `no-cache`; `assets/*` and `alerts/data/buildings/*` `public, max-age=86400`; other `alerts/data/` files `public, max-age=300`; `simple/data/*` unchanged (60 s data, 30 s status). Every `.geojson` and `.json` data file is uploaded with `Content-Type: application/json`.
- No secret, token or password in the repo, in tests, in fixtures or in commit messages. Test credentials in tests are obviously fake values such as `user:pass`.
- Commit messages 100 characters or less, bulleted bodies with 80-character bullets, ending with `Co-Authored-By: Claude claude-fable-5-1 <noreply@anthropic.com>`.
- Code style: one job per function, plain names, readable over clever.

## Review Focus

- A request on `dashboard.landslidesncgs.org` for `/data/forecast.geojson` must reach the data bucket at key `alerts/data/forecast.geojson`; the behavior list and the rewrite are both involved (Task 2 and Task 4 tests).
- A dev request when the KeyValueStore has no `basic-auth` key, or the header is malformed, must get 401, never 500 and never the page (Task 2 tests).
- A composed function over 10,240 bytes must fail `cdk synth` with a clear error rather than fail at deploy (Task 3 tests).
- `refresh-data.yml` must upload nothing when `refresh.py` exits non-zero, and must never delete `alerts/data/historical/` from the bucket (no `--delete` anywhere in that workflow; Task 8 verification).
- Apex, www and dashboard hosts must fall through the hosted-redirects piece untouched so the production function never redirects the main site (Task 2 tests).

---

### Task 1: CDK app scaffold with config and the Dns stack

**Files:**
- Create: `infra/cdk/package.json`, `infra/cdk/tsconfig.json`, `infra/cdk/cdk.json`, `infra/cdk/.gitignore`
- Create: `infra/cdk/bin/app.ts`, `infra/cdk/lib/config.ts`, `infra/cdk/lib/cutover.ts`, `infra/cdk/lib/dns-stack.ts`
- Test: `infra/cdk/test/cutover.test.ts`, `infra/cdk/test/dns-stack.test.ts`
- Modify: `.gitignore` (append `infra/cdk/node_modules/` and `infra/cdk/cdk.out/`)
- Modify: `eslint.config.mjs` ignores (add `infra/`)

**Interfaces:**
- Produces `lib/config.ts` exporting: `ACCOUNT = '710482330128'`, `REGION = 'us-east-1'`, `ORG_DOMAIN = 'landslidesncgs.org'`, `COM_DOMAIN = 'landslidesncgs.com'`, `PROD_HOSTNAMES: readonly string[]` (the eight, in the order listed in Global Constraints), `APEX_HOSTNAMES = ['landslidesncgs.org', 'landslidesncgs.com']`, `DEV_HOSTNAME = 'dev.landslidesncgs.org'`, `SITE_BUCKET`, `DATA_BUCKET`, `DEV_SITE_BUCKET`, `GITHUB_REPO = 'nemac/landslides-ncgs'`, `TOKEN_EXPIRES = '2027-10-21'`, `REMINDER_AT = '2027-09-21T13:00:00Z'`.
- Produces `lib/cutover.ts` exporting `type CutoverStage = 'wildcard' | 'subdomains' | 'done'`, `readCutoverStage(app: App): CutoverStage` (reads context `cutover`, default `wildcard`, throws on any other value), `productionDomainNames(stage: CutoverStage): string[]`, `recordedHostnames(stage: CutoverStage): string[]` (exact production names that get Route 53 records at that stage: none, six, eight).
- Produces `DnsStack` with public readonly `orgZone: route53.IHostedZone`, `comZone: route53.IHostedZone`, `certificate: acm.ICertificate`.
- `bin/app.ts` creates the stacks in the order Dns, Web, Ci, Trigger with `env: { account: ACCOUNT, region: REGION }`; later tasks add their stacks there.

- [ ] **Step 1: Scaffold the package**

`package.json` name `landslides-ncgs-infra`, private, scripts: `"test": "node --import tsx --test test/*.test.ts"`, `"synth": "cdk synth"`, `"diff": "cdk diff --profile jbliss-landslidesncgs"`, `"deploy": "cdk deploy --all --profile jbliss-landslidesncgs"`. Dependencies pinned exact: `aws-cdk-lib`, `constructs`, `aws-cdk` (CLI), `tsx`, `typescript`, `@types/node`. `cdk.json` app: `npx tsx bin/app.ts`. `tsconfig.json` strict, target ES2022, module NodeNext. Run `npm install` inside `infra/cdk`.

- [ ] **Step 2: Write the failing cutover tests**

```ts
test('wildcard stage has only the two wildcards', () => {
  assert.deepEqual(productionDomainNames('wildcard'), ['*.landslidesncgs.org', '*.landslidesncgs.com']);
  assert.deepEqual(recordedHostnames('wildcard'), []);
});
test('subdomains stage has six exact names plus wildcards', ...)  // length 8, no apex, both wildcards
test('done stage has the eight exact names and no wildcard', ...)  // deepEqual PROD_HOSTNAMES
test('unknown stage throws', () => assert.throws(() => readCutoverStage(appWithContext({ cutover: 'nope' }))));
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd infra/cdk && npm test`
Expected: FAIL, module `lib/cutover` not found.

- [ ] **Step 4: Implement `lib/config.ts` and `lib/cutover.ts`**

- [ ] **Step 5: Write the failing Dns stack test**

```ts
test('DnsStack has both zones and one cert covering apexes and wildcards', () => {
  const template = Template.fromStack(new DnsStack(app, 'Dns', { env }));
  template.resourceCountIs('AWS::Route53::HostedZone', 2);
  template.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: 'landslidesncgs.org',
    SubjectAlternativeNames: Match.arrayWith(['*.landslidesncgs.org', 'landslidesncgs.com', '*.landslidesncgs.com']),
    ValidationMethod: 'DNS',
  });
});
```

- [ ] **Step 6: Implement `DnsStack`** using `route53.PublicHostedZone` for each domain and one `acm.Certificate` with `CertificateValidation.fromDnsMultiZone({ [ORG_DOMAIN]: orgZone, [COM_DOMAIN]: comZone })`.

- [ ] **Step 7: Run tests and synth**

Run: `cd infra/cdk && npm test && npx cdk synth Dns`
Expected: tests PASS; `cdk.out/Dns.template.json` exists.

- [ ] **Step 8: Commit**

```bash
git add infra/cdk .gitignore eslint.config.mjs
git commit -m "Add the CDK app with config, cutover stages and the Dns stack"
```

---

### Task 2: CloudFront Function source pieces

**Files:**
- Modify: `infra/cloudfront/landslides-rewrite.js` (rename `handler` to `rewrite`; no other change)
- Create: `infra/cloudfront/landslides-hosted-redirects.js`, `infra/cloudfront/landslides-basic-auth.js`
- Create: `infra/cloudfront/test/load-piece.js`, `infra/cloudfront/test/rewrite.test.js`, `infra/cloudfront/test/hosted-redirects.test.js`, `infra/cloudfront/test/basic-auth.test.js`
- Modify: `infra/cloudfront/README.md` (describe the three pieces and that CDK composes and deploys them; drop the hand `update-function` instructions)

**Interfaces:**
- Each piece is a plain script that defines exactly one top-level function and nothing else, so it can be concatenated:
  - `function rewrite(event)` returns a request or a response object (today's behavior).
  - `function hostedRedirects(event)` returns a response for the inventory host or either mapviewer host, else `null`.
  - `async function basicAuth(event, kvs)` returns a 401 response or `null`; `kvs` has `get(key: string): Promise<string>` that rejects when the key is missing.
- `test/load-piece.js` exports `loadPiece(file, name)`: reads the file and returns the named function via `new Function(source + '; return ' + name + ';')()`.
- Events follow the CloudFront Functions shape: `{ request: { uri, querystring, headers: { host: { value } , authorization?: { value } } } }`.

- [ ] **Step 1: Write the failing rewrite tests** (one per behavior kept from today)

```js
test('directory path without slash redirects 301 with query kept', ...)   // '/simple' + {a:{value:'1'}} -> 301, location '/simple/?a=1'
test('dashboard host is prefixed with /alerts', ...)                        // host dashboard.landslidesncgs.org, uri '/data/forecast.geojson' -> uri '/alerts/data/forecast.geojson'
test('trailing slash gets index.html', ...)                                 // '/alerts/' -> '/alerts/index.html'
test('a file path passes through', ...)                                     // '/alerts/js/app.js' unchanged
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test infra/cloudfront/test/`
Expected: FAIL, `rewrite is not defined`.

- [ ] **Step 3: Rename `handler` to `rewrite` in `landslides-rewrite.js`; run tests**

Expected: PASS.

- [ ] **Step 4: Write the failing hosted-redirects tests**

```js
test('inventory host returns the iframe page', ...)      // status 200, content-type 'text/html; charset=utf-8', cache-control 'public, max-age=300', body contains 'experience.arcgis.com/experience/cd122ec3a6414d8e80ca93f5efe6bcb5'
test('mapviewer.org redirects to the ArcGIS viewer', ...) // 301, location 'https://unca.maps.arcgis.com/apps/webappviewer/index.html?id=e9f79de934f24e40a71bab8db8050612'
test('mapviewer.com redirects the same way', ...)
for each of ['landslidesncgs.org','www.landslidesncgs.org','landslidesncgs.com','www.landslidesncgs.com','dashboard.landslidesncgs.org']:
  test(host + ' falls through', () => assert.equal(hostedRedirects(eventFor(host, '/')), null));
test('missing host header falls through', ...)
```

- [ ] **Step 5: Implement `landslides-hosted-redirects.js`**, copying the page markup verbatim from the old function (it is in the spec's "What exists today" and in the old account; the title is `Landslide Inventory | NC Geological Survey`, the iframe has `allow="geolocation; fullscreen; clipboard-write"` and `allowfullscreen`).

- [ ] **Step 6: Run tests; expected PASS. Write the failing basic-auth tests**

```js
const kvsWith = (value) => ({ get: async (k) => { if (k === 'basic-auth' && value !== undefined) return value; throw new Error('missing'); } });
test('matching credential falls through', ...)          // header 'Basic ' + base64('user:pass'), kvs base64('user:pass') -> null
test('wrong credential gets 401 with challenge', ...)   // statusCode 401, headers['www-authenticate'].value === 'Basic realm="landslides dev"'
test('missing header gets 401', ...)
test('malformed header gets 401', ...)                  // 'Bearer xyz'
test('missing kvs key gets 401, not a throw', ...)      // kvsWith(undefined)
```

- [ ] **Step 7: Implement `landslides-basic-auth.js`**; compare the full header value to `'Basic ' + expected`, wrap `kvs.get` in try/catch.

- [ ] **Step 8: Run all function tests**

Run: `node --test infra/cloudfront/test/`
Expected: PASS, all.

- [ ] **Step 9: Update `infra/cloudfront/README.md` and commit**

```bash
git add infra/cloudfront
git commit -m "Split the CloudFront function into composable pieces with tests"
```

---

### Task 3: Function composer

**Files:**
- Create: `infra/cdk/lib/compose-function.ts`
- Test: `infra/cdk/test/compose-function.test.ts`

**Interfaces:**
- Produces `composeProductionFunction(): string` and `composeDevFunction(): string`, both reading the pieces from `infra/cloudfront/` relative to the CDK app, and `MAX_FUNCTION_BYTES = 10240`.
- Production output: hosted-redirects source, rewrite source, then `function handler(event) { var r = hostedRedirects(event); if (r) { return r; } return rewrite(event); }`.
- Dev output: first line `import cf from 'cloudfront';`, basic-auth source, rewrite source, `var kvs = cf.kvs();`, then `async function handler(event) { var r = await basicAuth(event, kvs); if (r) { return r; } return rewrite(event); }`.
- Both throw `Error` naming the size when the UTF-8 byte length exceeds `MAX_FUNCTION_BYTES`.

- [ ] **Step 1: Write the failing tests**

```ts
test('production function defines one handler and both pieces', () => {
  const code = composeProductionFunction();
  assert.equal(code.match(/function handler\(/g)?.length, 1);
  assert.match(code, /function hostedRedirects\(/); assert.match(code, /function rewrite\(/);
  assert.doesNotMatch(code, /import cf/);
});
test('dev function imports cloudfront and awaits basicAuth', ...)   // starts with "import cf from 'cloudfront';", one async handler, contains 'cf.kvs()'
test('both stay under the CloudFront limit', ...)                    // Buffer.byteLength < MAX_FUNCTION_BYTES
test('production handler behaves end to end', () => {
  const handler = new Function(composeProductionFunction() + '; return handler;')();
  // inventory host -> 200; dashboard '/data/x.geojson' -> request uri '/alerts/data/x.geojson'
});
test('oversized piece throws at compose time', ...)                  // pass a pieces directory override with a 11 KB file, or temporarily stub readFileSync
```

- [ ] **Step 2: Run tests to verify they fail; implement `compose-function.ts`; run tests**

Expected: PASS. Export an internal `composeFrom(pieceDir: string, mode: 'production' | 'dev'): string` so the oversized test can point at a fixture directory under `infra/cdk/test/fixtures/`.

- [ ] **Step 3: Commit**

```bash
git add infra/cdk/lib/compose-function.ts infra/cdk/test
git commit -m "Compose one CloudFront Function per distribution at synth time"
```

---

### Task 4: Web stack (buckets, two distributions, records)

**Files:**
- Create: `infra/cdk/lib/web-stack.ts`
- Test: `infra/cdk/test/web-stack.test.ts`
- Modify: `infra/cdk/bin/app.ts` (instantiate `WebStack` after `DnsStack`)

**Interfaces:**
- Consumes `DnsStack.orgZone`, `comZone`, `certificate`; `CutoverStage`; `composeProductionFunction`, `composeDevFunction`.
- `new WebStack(scope, id, { env, stage, orgZone, comZone, certificate })`.
- Produces public readonly `siteBucket`, `dataBucket`, `devSiteBucket: s3.IBucket`, `productionDistribution`, `devDistribution: cloudfront.IDistribution`.
- Route 53 records live here, not in Dns, because they reference the distributions and Dns is deployed first; an `ARecord` and `AaaaRecord` with `CloudFrontTarget` for every name in `recordedHostnames(stage)` in the zone matching its suffix, and for `DEV_HOSTNAME` always.

- [ ] **Step 1: Write the failing tests**

```ts
test('three private buckets, data versioned', ...)               // resourceCountIs Bucket 3; BucketName landslidesncgs-data has VersioningConfiguration Enabled; all have PublicAccessBlockConfiguration all true
test('production distribution aliases follow the stage', ...)    // wildcard: Aliases exactly the two wildcards; done: the eight exact names
test('production has the three data behaviors and compression', ...)  // CacheBehaviors PathPatterns alerts/data/*, simple/data/*, data/*; every behavior Compress true and one FunctionAssociation viewer-request
test('production attaches the security headers policy', ...)
test('dev distribution has one alias and a key value store', ...)     // Aliases ['dev.landslidesncgs.org']; resourceCountIs AWS::CloudFront::KeyValueStore 1 with Name landslides-dev-basic-auth; its Function has KeyValueStoreAssociations
test('records match the stage', ...)                              // wildcard: 1 A and 1 AAAA (dev only); subdomains: 7 each; done: 9 each
```

- [ ] **Step 2: Run tests to verify they fail; implement `WebStack`**

Buckets: `BlockPublicAccess.BLOCK_ALL`, `enforceSSL: true`, `removalPolicy: RETAIN`, data bucket `versioned: true`. Origins via `origins.S3BucketOrigin.withOriginAccessControl`. Distributions via the L2 `cloudfront.Distribution` with `viewerProtocolPolicy: REDIRECT_TO_HTTPS`, `cachePolicy: CachePolicy.CACHING_OPTIMIZED`, production `responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS`, `minimumProtocolVersion: TLS_V1_2_2021`. Functions via `cloudfront.Function` with `FunctionCode.fromInline`, `runtime: FunctionRuntime.JS_2_0`, and `keyValueStore` on the dev function only. One helper per concern: `makeBucket`, `makeDataBehaviors`, `makeRecords`.

- [ ] **Step 3: Run tests and synth every stage**

Run: `cd infra/cdk && npm test && for s in wildcard subdomains done; do npx cdk synth Web --context cutover=$s > /dev/null; done`
Expected: PASS; three synths succeed.

- [ ] **Step 4: Commit**

```bash
git add infra/cdk
git commit -m "Add the Web stack: site, data and dev buckets with two distributions"
```

---

### Task 5: Ci stack (GitHub OIDC roles)

**Files:**
- Create: `infra/cdk/lib/ci-stack.ts`
- Test: `infra/cdk/test/ci-stack.test.ts`
- Modify: `infra/cdk/bin/app.ts`

**Interfaces:**
- Consumes `WebStack.siteBucket`, `dataBucket`, `devSiteBucket`, `productionDistribution`, `devDistribution`.
- `new CiStack(scope, id, { env, siteBucket, dataBucket, devSiteBucket, productionDistribution, devDistribution })`.
- Produces public readonly `prodRole`, `devRole: iam.IRole`, and `CfnOutput`s `ProdRoleArn`, `DevRoleArn` (the workflows copy these values).

- [ ] **Step 1: Write the failing tests**

```ts
test('one GitHub OIDC provider', ...)   // resourceCountIs Custom::AWSCDKOpenIdConnectProvider 1 with Url https://token.actions.githubusercontent.com
test('prod role trusts the production environment only', ...)  // AssumeRolePolicyDocument Condition StringEquals sub 'repo:nemac/landslides-ncgs:environment:production', aud 'sts.amazonaws.com'; RoleName landslides-github-prod
test('dev role trusts the development environment only', ...)
test('dev role has no statement on the data bucket', ...)        // no policy statement whose Resource mentions landslidesncgs-data
test('each role may invalidate only its distribution', ...)      // cloudfront:CreateInvalidation with the matching distribution ARN
```

- [ ] **Step 2: Run to fail; implement `CiStack`**

`iam.OpenIdConnectProvider` with `clientIds: ['sts.amazonaws.com']`; roles with `iam.WebIdentityPrincipal` conditions; `grantReadWrite` on the buckets each role owns (prod: site and data, dev: dev site); invalidation via `PolicyStatement` on `arn:aws:cloudfront::${ACCOUNT}:distribution/${distributionId}`.

- [ ] **Step 3: Run tests, synth, commit**

```bash
git add infra/cdk
git commit -m "Add the Ci stack with GitHub OIDC roles for prod and dev deploys"
```

---

### Task 6: Trigger stack and retirement of deploy.sh

**Files:**
- Create: `infra/cdk/lib/trigger-stack.ts`
- Test: `infra/cdk/test/trigger-stack.test.ts`
- Delete: `infra/lambda/refresh-simple-trigger/deploy.sh`
- Modify: `infra/lambda/refresh-simple-trigger/README.md` (pieces table unchanged in spirit but under the new account; setup now `cdk deploy Trigger` then set the secret; drop every mention of deploy.sh; add the daily schedule)
- Modify: `infra/cdk/bin/app.ts`

**Interfaces:**
- `new TriggerStack(scope, id, { env })`, no inputs from other stacks.
- Lambda code `lambda.Code.fromAsset('../lambda/refresh-simple-trigger', { exclude: ['test_handler.py', 'README.md', '__pycache__'] })`, runtime Python 3.12, handler `handler.handler`, timeout 30 s, memory 128 MB, environment `GITHUB_REPO`, `WORKFLOW_FILE=refresh-simple.yml`, `GIT_REF=master`, `TOKEN_SECRET_ID`.
- Schedules through `aws-cdk-lib/aws-scheduler` and `aws-scheduler-targets` `LambdaInvoke` (fall back to `CfnSchedule` for any property the L2 lacks); reminder construct id `Reminder-${REMINDER_AT.slice(0, 10)}`, `scheduleName` `landslides-github-token-expiry-reminder-${date}`, one-time `ScheduleExpression.at(new Date(REMINDER_AT))`.

- [ ] **Step 1: Write the failing tests**

```ts
test('secret, function and three schedules exist by name', ...)   // Secret Name; Function FunctionName, Runtime python3.12, Environment variables; Schedule Names: the three
test('ten-minute schedule is enabled with rate(10 minutes) and empty input', ...)
test('daily schedule runs at 04:00 UTC with the refresh-data payload', ...)  // ScheduleExpression 'cron(0 4 * * ? *)', Target Input containing "refresh-data.yml"
test('reminder is a one-time at() schedule with no self delete', ...)        // ScheduleExpression 'at(2027-09-21T13:00:00)', ActionAfterCompletion absent or NONE
test('function may read only that secret', ...)
```

- [ ] **Step 2: Run to fail; implement `TriggerStack`; run tests and `npx cdk synth Trigger`**

- [ ] **Step 3: Delete `deploy.sh`, rewrite the trigger README, run the Lambda's own tests**

Run: `(cd infra/lambda/refresh-simple-trigger && python3 -m unittest test_handler)`
Expected: OK.

- [ ] **Step 4: Commit**

```bash
git add -A infra
git commit -m "Add the Trigger stack and retire deploy.sh"
```

---

### Task 7: Reusable site deploy workflow for prod and dev

**Files:**
- Create: `.github/workflows/deploy-site.yml` (reusable, `on: workflow_call`)
- Modify: `.github/workflows/deploy-prod.yml` (becomes a caller)
- Create: `.github/workflows/deploy-dev.yml` (caller, push to `development`)

**Interfaces:**
- `deploy-site.yml` inputs: `environment` (string), `role_arn`, `bucket`, `distribution_id`, `site_url`. Declares `environment: { name: ${{ inputs.environment }}, url: ${{ inputs.site_url }} }`, `permissions: id-token: write, contents: read`, concurrency group `deploy-${{ inputs.environment }}`.
- Steps: checkout; configure-aws-credentials v4 with `role-to-assume`; sync pass one, everything except `assets/*`, `--delete`, `--cache-control "no-cache"`, with excludes `.git/*`, `.github/*`, `.idea/*`, `.claude/*`, `__pycache__/*`, `*/__pycache__/*`, `scripts/*`, `docs/*`, `infra/*`, `cache/*`, `simple/pipeline/*`, `alerts/data/*`, `*.py`, `*.md`, `.gitignore`, `.prettierrc`, `.prettierignore`, `eslint.config.mjs`, `environment.yml`, `package.json`, `package-lock.json`, `pyproject.toml`, `requirements-dev.txt`; sync pass two `assets/` to `assets/` with `--delete --cache-control "public, max-age=86400"`; invalidate `/*`; step summary.
- Callers set `env`-style values inline in `with:` (account id, ARN, bucket, distribution id). Values for the new account are placeholders `TODO-AFTER-FIRST-DEPLOY` until the stacks exist; the cutover runbook fills them.

- [ ] **Step 1: Write the three workflow files**

- [ ] **Step 2: Validate**

Run: `brew install actionlint` once, then `actionlint`
Expected: no findings. Also `grep -n "alerts/data" .github/workflows/deploy-site.yml` shows the exclude (the data must never be synced from a checkout once Task 9 removes it, but a developer's local checkout still has it).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows
git commit -m "Deploy prod and dev through one reusable workflow with cache classes"
```

---

### Task 8: Pipeline workflows write only to S3

**Files:**
- Modify: `.github/workflows/refresh-data.yml`
- Modify: `.github/workflows/refresh-simple.yml`
- Modify: `simple/pipeline/settings.py:27` only if `PUBLIC_STATUS_URL` must change (it stays on the public hostname; no change expected)

**Interfaces:**
- `refresh-data.yml`: `permissions: id-token: write, contents: read`; `environment: production`; env `AWS_ROLE`, `DATA_BUCKET=landslidesncgs-data`, `DATA_PREFIX=alerts/data`. Steps in order: checkout (no write credentials); configure AWS credentials; "Fetch buildings manifest" (`aws s3 cp s3://$DATA_BUCKET/$DATA_PREFIX/buildings/manifest.json alerts/data/buildings/manifest.json || echo "no manifest yet"`); restore mtime (unchanged); cache month and debris cache (unchanged); micromamba (unchanged); run pipeline (unchanged); "Upload buildings" `aws s3 sync alerts/data/buildings s3://.../buildings --content-type application/json --cache-control "public, max-age=86400"`; "Upload alert data" `aws s3 sync alerts/data s3://... --exclude "buildings/*" --content-type application/json --cache-control "public, max-age=300"`; summary. No `--delete`. No commit, push or `gh workflow run` steps. The cron stays as backup.
- `refresh-simple.yml`: `AWS_ROLE` and `S3_DATA` point at the new role and `s3://landslidesncgs-data/simple/data`; the two `--content-type application/geo+json` become `application/json`; everything else unchanged.

- [ ] **Step 1: Edit both workflows**

- [ ] **Step 2: Validate**

Run: `actionlint && ! grep -n -- "--delete" .github/workflows/refresh-data.yml && ! grep -n "git push\|gh workflow run" .github/workflows/refresh-data.yml && ! grep -rn "geo+json" .github/workflows`
Expected: actionlint clean, every `grep` finds nothing (exit 0 overall).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows simple/pipeline/settings.py
git commit -m "Refresh workflows upload to the data bucket and stop committing data"
```

---

### Task 9: Data leaves the repo

**Files:**
- Modify: `.gitignore` (append `alerts/data/`)
- Remove from tracking: `alerts/data/` (`git rm -r --cached alerts/data`)
- Modify: `OPERATIONS.md` (replace the "Refreshing data" intro and the file-locations table: data is not in git; two ways to get it; historical files are regenerated with `--hindcast` and uploaded by hand with `aws s3 sync alerts/data/historical s3://landslidesncgs-data/alerts/data/historical --content-type application/json --cache-control "public, max-age=300"`)

- [ ] **Step 1: Untrack the data and ignore it**

Run: `git rm -r -q --cached alerts/data && printf '\n# Pipeline outputs live only in S3 (see OPERATIONS.md)\nalerts/data/\n' >> .gitignore && git status --short | grep -c "^D  alerts/data"`
Expected: a count over 100; `ls alerts/data` still lists the files on disk.

- [ ] **Step 2: Update OPERATIONS.md as described; check the frontend still loads locally**

Run: `python3 -m http.server 8000` then open `http://localhost:8000/alerts/`
Expected: the dashboard loads from the files still on disk (nothing in the browser depends on git).

- [ ] **Step 3: Commit**

```bash
git add -A .gitignore alerts/data OPERATIONS.md
git commit -m "Stop tracking alerts/data; pipeline outputs live only in S3"
```

---

### Task 10: CI check workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- `on: pull_request` and `workflow_dispatch`. Jobs: `infra` (setup-node 22, `npm ci` in `infra/cdk`, `npm test`, `npx cdk synth --context cutover=done`, `node --test infra/cloudfront/test/`), `lint` (`npm ci` at root, `npm run lint`, `npm run format:check`, Python 3.12 with `pip install -r requirements-dev.txt`, `ruff check scripts`). No AWS credentials anywhere in the file.

- [ ] **Step 1: Write `ci.yml`; run `actionlint`; run the same commands locally**

Run: `(cd infra/cdk && npm test && npx cdk synth --context cutover=done >/dev/null) && node --test infra/cloudfront/test/ && npm run lint && npm run format:check && ruff check scripts`
Expected: all PASS.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Run CDK synth, function tests and lint on every pull request"
```

---

### Task 11: Cutover runbook with exact commands

**Files:**
- Create: `infra/README.md`

**Interfaces:**
- The runbook follows the spec's numbered steps 1 to 13 and the decommission list exactly, each with the command to run, the profile to use, and the output that means it worked. Every secret-bearing command uses `read -s` and never echoes. It must contain these commands in particular:
  - bootstrap: `npx cdk bootstrap aws://710482330128/us-east-1 --profile jbliss-landslidesncgs`
  - deploy order and stage: `npx cdk deploy Dns --profile ...`, then `npx cdk deploy --all --context cutover=wildcard`, later `--context cutover=subdomains`, finally `--context cutover=done`
  - reading the two validation CNAMEs from the new zones and writing them to the old zones with `aws route53 change-resource-record-sets` on the default profile
  - seeding: `aws s3 sync alerts/data s3://landslidesncgs-data/alerts/data --content-type application/json` (buildings pass with max-age 86400, rest with 300), `aws s3 sync s3://landslides-ncgs/simple/data s3://landslidesncgs-data/simple/data --source-region us-east-1` run with cross-account access or via a local copy
  - secret: `read -s TOKEN && aws secretsmanager put-secret-value --secret-id landslides/github-dispatch-token --secret-string "$TOKEN" --profile jbliss-landslidesncgs && unset TOKEN`
  - KeyValueStore: `read -s CRED` (typed as `user:password`), then `aws cloudfront-keyvaluestore put-key --kvs-arn <arn> --key basic-auth --value "$(printf '%s' "$CRED" | base64)" --if-match "$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn <arn> --query ETag --output text)"`, then `unset CRED`
  - tests: `aws cloudfront test-function` for each host case; `curl --resolve cut-test.landslidesncgs.org:443:<edge ip> https://cut-test.landslidesncgs.org/`; dev 401 then 200
  - filling the `TODO-AFTER-FIRST-DEPLOY` placeholders in the three caller workflows from the `ProdRoleArn`/`DevRoleArn` outputs and distribution ids, then merging
  - the wildcard move per subdomain: `get-distribution-config` on the old distribution, remove the alias, `update-distribution --if-match`; wait for `Deployed`; same on the new one adding it; `dig +short` check; rollback is the reverse pair
  - the apex bridge: the old function's source with the apex 302 added, `update-function` and `publish-function` on the old account
  - the apex move: TXT records `_.landslidesncgs.org` and `_.landslidesncgs.com`, `aws cloudfront update-distribution` to disable the old distribution, `aws cloudfront update-domain-association --domain landslidesncgs.org --target-resource DistributionId=<new> --if-match <etag> --profile jbliss-landslidesncgs` for each apex, then `cdk deploy --all --context cutover=done`
  - GoDaddy: the four name servers per domain from `aws route53 get-hosted-zone`
  - the 48-hour check: `dig NS landslidesncgs.org @8.8.8.8` and `@1.1.1.1`
  - decommission commands in the spec's order
  - history rewrite: `git branch -r` cleanup of the three merged branches, `git filter-repo --path alerts/data --invert-paths --force`, re-adding `origin`, `git push --force --all && git push --force --tags`, and the note to Ian to re-clone; disabling GitHub Pages with `gh api -X DELETE repos/nemac/landslides-ncgs/pages`

- [ ] **Step 1: Write `infra/README.md`**

- [ ] **Step 2: Check it against the spec**

Run: `grep -c "^\s*[0-9]\+\." infra/README.md` and read the "Cutover runbook" and "Decommission list" sections of the spec side by side.
Expected: every spec step and every decommission item has a command block; no literal credential anywhere (`grep -n "ncgs\." infra/README.md` shows only hostnames).

- [ ] **Step 3: Commit**

```bash
git add infra/README.md
git commit -m "Write the cutover runbook with every command and check"
```

---

### Task 12: Remaining docs and backlog

**Files:**
- Modify: `README.md` (replace the placeholder with: what the site is, where it runs, the two accounts no longer, link to `infra/README.md`, `OPERATIONS.md`, `BACKLOG.md`)
- Modify: `alerts/README.md`, `simple/README.md` (data location, dev site URL, that Pages is gone)
- Modify: `BACKLOG.md` (remove the three completed items, keep Option B and snapshots, note in Option B that the data bucket and roles now exist, add "Decommission the NEMAC account resources" with a date placeholder and a pointer to `infra/README.md`)

- [ ] **Step 1: Edit the five files; run the format check**

Run: `npm run format:check && grep -rn "104538610210\|landslides-github-actions-prod\|E139BPMQTMFRUH" --include=*.md . | grep -v node_modules | grep -v docs/superpowers`
Expected: format clean; the only remaining mentions of the old account are inside `infra/README.md` (the runbook needs them) and the spec.

- [ ] **Step 2: Commit**

```bash
git add README.md alerts/README.md simple/README.md BACKLOG.md
git commit -m "Update docs for the new AWS account, dev site and S3-only data"
```

---

## After the plan ships: cutover

The twelve tasks produce code and documents only. Nothing is deployed and
no DNS changes until Jeff runs `infra/README.md` with Claude, which is the
spec's runbook. That run fills the three `TODO-AFTER-FIRST-DEPLOY`
placeholders, which is the one code change made during cutover, and ends
with the history rewrite. The repo memory file for deploy infrastructure
is rewritten after the decommission.

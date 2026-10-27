# Workflow trigger (EventBridge Scheduler + Lambda)

Dispatches the pipeline workflows on nemac/landslides-ncgs from AWS, because
GitHub's own cron runs hours late for this repo (the daily job started 4.4 to
7.8 hours late on every one of 30 runs measured 2026-10-21). EventBridge
Scheduler fires on time; the Lambda just calls GitHub's `workflow_dispatch`
API. The pipelines themselves still run on GitHub Actions. Each workflow's
cron stays as a best-effort backup; duplicate runs are serialized by the
workflow's concurrency group.

## Pieces (us-east-1, account 710482330128, defined in `infra/cdk/lib/trigger-stack.ts`)

| Resource | Name | Fires |
|---|---|---|
| Secrets Manager secret | `landslides/github-dispatch-token` | |
| Lambda function | `landslides-refresh-simple-trigger` (python3.12, `handler.py`) | |
| Schedule | `landslides-refresh-simple-10min` | `rate(10 minutes)`, dispatches `refresh-simple.yml` |
| Schedule | `landslides-refresh-data-daily` | `cron(0 4 * * ? *)` UTC, dispatches `refresh-data.yml` |
| Schedule | `landslides-github-token-expiry-reminder-<date>` | once, a month before the token expires, dispatches `token-expiry-reminder.yml` |

The roles for the Lambda and the scheduler are created by the same stack.

## First-time setup

1. `cd infra/cdk && npx cdk deploy Trigger --profile jbliss-landslidesncgs`.
   The secret is created with a random placeholder and every schedule is
   enabled; until the real token is set the Lambda logs a GitHub 401 every
   run, which is harmless.
2. Create a GitHub token the Lambda can use. Fine-grained token at
   github.com/settings/personal-access-tokens/new: resource owner `nemac`,
   repository `nemac/landslides-ncgs`, permission **Actions: Read and
   write** (Metadata: read is added automatically). The token created
   2026-10-21 expires 2027-10-21 and can be reused.
3. Store it without echoing it anywhere:
   ```bash
   read -s TOKEN && aws secretsmanager put-secret-value --secret-id landslides/github-dispatch-token --secret-string "$TOKEN" --profile jbliss-landslidesncgs && unset TOKEN
   ```
4. Test one invocation:
   ```bash
   aws lambda invoke --function-name landslides-refresh-simple-trigger --profile jbliss-landslidesncgs /dev/stdout
   ```
   A successful invoke returns `{"status": 204, ...}` and a new
   `workflow_dispatch` run appears in the Actions tab within seconds.

## Token expiry reminder

`REMINDER_AT` lives in `infra/cdk/lib/config.ts`; the expiry date shown in
the issue is the `expires` input default in the workflow. The
one-time schedule invokes the Lambda with
`{"workflow_file": "token-expiry-reminder.yml"}`, and that workflow opens a
GitHub issue titled "Renew the GitHub token for the DFENS Simple trigger"
with the renewal steps. The date is part of the schedule's name, so renewing
the token means: store the new value (step 3 above), edit both constants,
and `cdk deploy Trigger`, which replaces the old reminder with a new one.
To preview the issue text without creating it:
`gh workflow run token-expiry-reminder.yml -f dry_run=true`.

## Updating the code

Edit `handler.py`, run the tests, deploy the stack:

```bash
(cd infra/lambda/refresh-simple-trigger && python3 -m unittest test_handler)
(cd infra/cdk && npx cdk deploy Trigger --profile jbliss-landslidesncgs)
```

## Checking on it

- Lambda logs: CloudWatch log group `/aws/lambda/landslides-refresh-simple-trigger`.
  Each run prints `Dispatched <workflow> ... HTTP 204` or a GitHub API
  error (401 means the token expired, was revoked, or is still the placeholder).
- GitHub side: Actions tab, runs with event `workflow_dispatch` about every
  10 minutes for DFENS Simple and once a day at 04:00 UTC for the alerts.
- Page side: https://landslidesncgs.org/simple/data/status.json
  `checked_at` should never be more than about 12 minutes old.

# refresh-simple trigger (EventBridge Scheduler + Lambda)

Fires `refresh-simple.yml` on nemac/landslides-ncgs every 10 minutes.

**Why this exists.** The workflow has its own `*/10` cron, but GitHub's
scheduler runs hours late for this repo: the daily `refresh-data.yml`
(cron 04:00 UTC) started between 4.4 and 7.8 hours late on every one of
its last 30 runs (measured 2026-10-21). The DFENS Simple page shows a
stale banner after 45 minutes without a check, so GitHub cron alone
cannot keep it fresh. EventBridge Scheduler fires on time; the Lambda
just calls GitHub's `workflow_dispatch` API. The pipeline itself still
runs on GitHub Actions. The GitHub cron stays in the workflow as a
best-effort backup; duplicate runs are serialized by the workflow's
concurrency group.

## Pieces (all in us-east-1, account 104538610210)

| Resource | Name |
|---|---|
| Secrets Manager secret | `landslides/github-dispatch-token` |
| Lambda function | `landslides-refresh-simple-trigger` (python3.12, `handler.py`) |
| Lambda execution role | `landslides-refresh-simple-trigger-lambda` |
| Scheduler role | `landslides-refresh-simple-trigger-scheduler` |
| EventBridge Scheduler schedule | `landslides-refresh-simple-10min`, `rate(10 minutes)` |

These must move with everything else when the project migrates to its own
AWS account (see `BACKLOG.md`).

## First-time setup

1. Run `infra/lambda/refresh-simple-trigger/deploy.sh`. It creates
   everything above, with a placeholder secret value and the schedule
   DISABLED.
2. Create a GitHub token the Lambda can use. Fine-grained token at
   github.com/settings/personal-access-tokens/new: resource owner `nemac`,
   repository `nemac/landslides-ncgs`, permission **Actions: Read and
   write** (Metadata: read is added automatically). If the nemac org does
   not allow fine-grained tokens, a classic token with the `repo` scope
   works too. Set an expiration you will remember to renew.
3. Store it without echoing it anywhere:
   ```bash
   read -s TOKEN && aws secretsmanager put-secret-value --secret-id landslides/github-dispatch-token --secret-string "$TOKEN" && unset TOKEN
   ```
4. Test one invocation, then enable the schedule:
   ```bash
   aws lambda invoke --function-name landslides-refresh-simple-trigger /dev/stdout
   aws scheduler update-schedule --name landslides-refresh-simple-10min --state ENABLED \
     --schedule-expression "rate(10 minutes)" --flexible-time-window Mode=OFF \
     --target "$(aws scheduler get-schedule --name landslides-refresh-simple-10min --query Target --output json)"
   ```
   A successful invoke returns `{"status": 204, ...}` and a new
   `workflow_dispatch` run appears in the Actions tab within seconds.

## Token expiry reminder

The token expires on the date in `deploy.sh` (`TOKEN_EXPIRES`). A one-time
EventBridge Scheduler schedule, `landslides-github-token-expiry-reminder`,
fires at `REMINDER_AT` (a month earlier), invokes the same Lambda with
`{"workflow_file": "token-expiry-reminder.yml"}`, and that workflow opens a
GitHub issue titled "Renew the GitHub token for the DFENS Simple trigger"
with the renewal steps. The schedule deletes itself after firing.

When you renew the token: store the new value (step 3 above), then edit
`TOKEN_EXPIRES` and `REMINDER_AT` in `deploy.sh` and re-run it to create
the next reminder. To preview the issue text without creating it:
`gh workflow run token-expiry-reminder.yml -f dry_run=true`.

## Updating the code

Edit `handler.py`, run the tests, re-run `deploy.sh`:

```bash
(cd infra/lambda/refresh-simple-trigger && python3 -m unittest test_handler)
infra/lambda/refresh-simple-trigger/deploy.sh
```

## Checking on it

- Lambda logs: CloudWatch log group `/aws/lambda/landslides-refresh-simple-trigger`.
  Each run prints `Dispatched refresh-simple.yml ... HTTP 204` or a GitHub
  API error (401 means the token expired or was revoked).
- GitHub side: Actions tab, "Refresh DFENS Simple data" runs with event
  `workflow_dispatch` about every 10 minutes.
- Page side: https://landslidesncgs.org/simple/data/status.json
  `checked_at` should never be more than about 12 minutes old.

#!/usr/bin/env bash
# Create or update the AWS pieces that trigger refresh-simple.yml every
# 10 minutes: a Secrets Manager secret (GitHub token), a Lambda that calls
# GitHub's workflow_dispatch API, and an EventBridge Scheduler schedule.
# Safe to re-run: every step creates if missing, else updates.
#
# Usage: infra/lambda/refresh-simple-trigger/deploy.sh
# Needs: AWS CLI with rights in account 104538610210, zip.
set -euo pipefail

REGION=us-east-1
REPO=nemac/landslides-ncgs
WORKFLOW=refresh-simple.yml
FN=landslides-refresh-simple-trigger
SECRET=landslides/github-dispatch-token
LAMBDA_ROLE=landslides-refresh-simple-trigger-lambda
SCHED_ROLE=landslides-refresh-simple-trigger-scheduler
SCHEDULE=landslides-refresh-simple-10min
# The GitHub token in $SECRET expires on TOKEN_EXPIRES. A one-time schedule
# fires on REMINDER_AT (UTC) and dispatches token-expiry-reminder.yml, which
# opens an issue. Update both dates whenever the token is renewed.
TOKEN_EXPIRES=2027-10-21
REMINDER_AT=2027-09-21T13:00:00
REMINDER_SCHEDULE=landslides-github-token-expiry-reminder
REMINDER_WORKFLOW=token-expiry-reminder.yml
HERE=$(cd "$(dirname "$0")" && pwd)
export AWS_DEFAULT_REGION=$REGION

log() { printf '\n== %s\n' "$*"; }

# ---- 1. Secret (placeholder value; set the real token afterwards) --------
log "secret $SECRET"
if ! aws secretsmanager describe-secret --secret-id "$SECRET" >/dev/null 2>&1; then
  aws secretsmanager create-secret --name "$SECRET" \
    --description "GitHub token (Actions: read/write on $REPO) used by $FN" \
    --secret-string REPLACE_ME >/dev/null
  echo "created with placeholder value"
fi
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET" --query ARN --output text)

# ---- 2. Lambda execution role -------------------------------------------
log "role $LAMBDA_ROLE"
LAMBDA_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$LAMBDA_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$LAMBDA_ROLE" \
    --assume-role-policy-document "$LAMBDA_TRUST" \
    --description "Execution role for $FN" >/dev/null
  aws iam attach-role-policy --role-name "$LAMBDA_ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "created"
fi
aws iam put-role-policy --role-name "$LAMBDA_ROLE" --policy-name read-github-dispatch-token \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$SECRET_ARN\"}]}"
LAMBDA_ROLE_ARN=$(aws iam get-role --role-name "$LAMBDA_ROLE" --query Role.Arn --output text)

# ---- 3. Lambda function -------------------------------------------------
log "function $FN"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
(cd "$HERE" && zip -q "$TMP/handler.zip" handler.py)
ENV_VARS="Variables={GITHUB_REPO=$REPO,WORKFLOW_FILE=$WORKFLOW,GIT_REF=master,TOKEN_SECRET_ID=$SECRET}"
if ! aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  # A freshly created role takes a few seconds to become assumable.
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if aws lambda create-function --function-name "$FN" --runtime python3.12 \
         --role "$LAMBDA_ROLE_ARN" --handler handler.handler \
         --zip-file "fileb://$TMP/handler.zip" --timeout 30 --memory-size 128 \
         --environment "$ENV_VARS" \
         --description "Dispatches $WORKFLOW on $REPO (GitHub cron is unreliable)" >/dev/null 2>"$TMP/err"; then
      echo "created"; break
    fi
    grep -q "cannot be assumed" "$TMP/err" || { cat "$TMP/err"; exit 1; }
    echo "waiting for role propagation ($attempt)"; sleep 5
  done
else
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$TMP/handler.zip" >/dev/null
  aws lambda wait function-updated --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" \
    --runtime python3.12 --handler handler.handler --timeout 30 --memory-size 128 \
    --environment "$ENV_VARS" >/dev/null
  aws lambda wait function-updated --function-name "$FN"
  echo "updated"
fi
FN_ARN=$(aws lambda get-function --function-name "$FN" --query Configuration.FunctionArn --output text)

# ---- 4. Scheduler role --------------------------------------------------
log "role $SCHED_ROLE"
SCHED_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SCHED_ROLE" \
    --assume-role-policy-document "$SCHED_TRUST" \
    --description "Lets EventBridge Scheduler invoke $FN" >/dev/null
  echo "created"
fi
aws iam put-role-policy --role-name "$SCHED_ROLE" --policy-name invoke-trigger-lambda \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":\"$FN_ARN\"}]}"
SCHED_ROLE_ARN=$(aws iam get-role --role-name "$SCHED_ROLE" --query Role.Arn --output text)

# ---- 5. Schedule (created DISABLED; enable once the token is stored) ----
log "schedule $SCHEDULE"
TARGET="{\"Arn\":\"$FN_ARN\",\"RoleArn\":\"$SCHED_ROLE_ARN\"}"
if ! aws scheduler get-schedule --name "$SCHEDULE" >/dev/null 2>&1; then
  for attempt in 1 2 3 4 5 6; do
    if aws scheduler create-schedule --name "$SCHEDULE" \
         --schedule-expression "rate(10 minutes)" --flexible-time-window Mode=OFF \
         --target "$TARGET" --state DISABLED \
         --description "Triggers $WORKFLOW on $REPO every 10 min" >/dev/null 2>"$TMP/err"; then
      echo "created (DISABLED)"; break
    fi
    grep -qi "role" "$TMP/err" || { cat "$TMP/err"; exit 1; }
    echo "waiting for role propagation ($attempt)"; sleep 5
  done
else
  STATE=$(aws scheduler get-schedule --name "$SCHEDULE" --query State --output text)
  aws scheduler update-schedule --name "$SCHEDULE" \
    --schedule-expression "rate(10 minutes)" --flexible-time-window Mode=OFF \
    --target "$TARGET" --state "$STATE" \
    --description "Triggers $WORKFLOW on $REPO every 10 min" >/dev/null
  echo "updated (state $STATE)"
fi

# ---- 6. One-time token-expiry reminder ----------------------------------
# Fires once at REMINDER_AT, dispatches the reminder workflow (which opens
# the issue), then deletes itself (ActionAfterCompletion=DELETE).
log "reminder schedule $REMINDER_SCHEDULE (at $REMINDER_AT, token expires $TOKEN_EXPIRES)"
REMINDER_INPUT="{\"workflow_file\":\"$REMINDER_WORKFLOW\"}"
REMINDER_TARGET="{\"Arn\":\"$FN_ARN\",\"RoleArn\":\"$SCHED_ROLE_ARN\",\"Input\":$(printf '%s' "$REMINDER_INPUT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"
REMINDER_DESC="Dispatches $REMINDER_WORKFLOW a month before the GitHub token expires ($TOKEN_EXPIRES)"
if ! aws scheduler get-schedule --name "$REMINDER_SCHEDULE" >/dev/null 2>&1; then
  aws scheduler create-schedule --name "$REMINDER_SCHEDULE" \
    --schedule-expression "at($REMINDER_AT)" --schedule-expression-timezone UTC \
    --flexible-time-window Mode=OFF --action-after-completion DELETE \
    --target "$REMINDER_TARGET" --description "$REMINDER_DESC" >/dev/null
  echo "created"
else
  aws scheduler update-schedule --name "$REMINDER_SCHEDULE" \
    --schedule-expression "at($REMINDER_AT)" --schedule-expression-timezone UTC \
    --flexible-time-window Mode=OFF --action-after-completion DELETE \
    --target "$REMINDER_TARGET" --description "$REMINDER_DESC" >/dev/null
  echo "updated"
fi

log "done"
echo "function:  $FN_ARN"
echo "schedule:  $SCHEDULE ($(aws scheduler get-schedule --name "$SCHEDULE" --query State --output text))"
echo "reminder:  $REMINDER_SCHEDULE at $REMINDER_AT UTC -> $REMINDER_WORKFLOW"
echo "secret:    $SECRET_ARN (token expires $TOKEN_EXPIRES)"

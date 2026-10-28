import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_REPO, REMINDER_AT } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HANDLER_DIR = path.resolve(
  here,
  '..',
  '..',
  'lambda',
  'refresh-simple-trigger'
);

// GitHub's cron runs hours late for this repo, so EventBridge Scheduler
// dispatches the pipeline workflows through a small Lambda that calls
// GitHub's workflow_dispatch API with a token from Secrets Manager. The
// secret is created with a random placeholder; the real token is set by
// hand (infra/README.md). Until then the Lambda logs a 401 every run, which
// is harmless, and the workflows' own cron is the backup.
export class TriggerStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, { terminationProtection: true, ...props });
    const secret = new secretsmanager.Secret(this, 'Token', {
      secretName: 'landslides/github-dispatch-token',
      description: `GitHub token (Actions: read/write on ${GITHUB_REPO}) used to dispatch workflows`,
    });
    const fn = this.makeFunction(secret);
    secret.grantRead(fn);

    this.makeSchedule(
      'TenMinute',
      'landslides-refresh-simple-10min',
      fn,
      scheduler.ScheduleExpression.rate(Duration.minutes(10)),
      undefined
    );
    // Daily check of the two reference datasets (Overture buildings, the
    // NCGS debris-flow layer); the workflow rebuilds only what changed.
    this.makeSchedule(
      'ReferenceDaily',
      'landslides-refresh-reference-daily',
      fn,
      scheduler.ScheduleExpression.cron({ minute: '0', hour: '5' }),
      { workflow_file: 'refresh-reference.yml' }
    );
    this.makeReminder(fn);
  }

  private makeFunction(secret: secretsmanager.ISecret): lambda.Function {
    return new lambda.Function(this, 'Function', {
      functionName: 'landslides-refresh-simple-trigger',
      description: `Dispatches GitHub Actions workflows on ${GITHUB_REPO} (GitHub cron is unreliable)`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(HANDLER_DIR, {
        exclude: ['test_handler.py', 'README.md', '__pycache__'],
      }),
      timeout: Duration.seconds(30),
      memorySize: 128,
      environment: {
        GITHUB_REPO,
        WORKFLOW_FILE: 'refresh-simple.yml',
        GIT_REF: 'master',
        TOKEN_SECRET_ID: secret.secretName,
      },
    });
  }

  private makeSchedule(
    id: string,
    scheduleName: string,
    fn: lambda.IFunction,
    schedule: scheduler.ScheduleExpression,
    payload: Record<string, string> | undefined
  ): scheduler.Schedule {
    const input = payload
      ? scheduler.ScheduleTargetInput.fromObject(payload)
      : undefined;
    return new scheduler.Schedule(this, id, {
      scheduleName,
      schedule,
      target: new targets.LambdaInvoke(fn, { input }),
      enabled: true,
    });
  }

  // One-time reminder a month before the GitHub token expires. The date is
  // part of the construct id, so renewing the token (and editing REMINDER_AT)
  // replaces this schedule with a new one and removes the old.
  private makeReminder(fn: lambda.IFunction): void {
    const date = REMINDER_AT.slice(0, 10);
    this.makeSchedule(
      `Reminder-${date}`,
      `landslides-github-token-expiry-reminder-${date}`,
      fn,
      scheduler.ScheduleExpression.at(new Date(REMINDER_AT)),
      { workflow_file: 'token-expiry-reminder.yml' }
    );
  }
}

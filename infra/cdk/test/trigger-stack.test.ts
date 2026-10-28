import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ACCOUNT, REGION } from '../lib/config.js';
import { TriggerStack } from '../lib/trigger-stack.js';

const env = { account: ACCOUNT, region: REGION };

function triggerTemplate() {
  return Template.fromStack(new TriggerStack(new App(), 'Trigger', { env }));
}

function scheduleNamed(template: Template, name: string) {
  const [schedule] = Object.values(
    template.findResources('AWS::Scheduler::Schedule', {
      Properties: { Name: name },
    })
  );
  assert.ok(schedule, `schedule ${name} exists`);
  return schedule.Properties;
}

test('secret, function and three schedules exist by name', () => {
  const template = triggerTemplate();
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'landslides/github-dispatch-token',
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'landslides-refresh-simple-trigger',
    Runtime: 'python3.12',
    Handler: 'handler.handler',
    Timeout: 30,
    MemorySize: 128,
    Environment: {
      Variables: Match.objectLike({
        GITHUB_REPO: 'nemac/landslides-ncgs',
        WORKFLOW_FILE: 'refresh-simple.yml',
        GIT_REF: 'master',
        TOKEN_SECRET_ID: Match.anyValue(),
      }),
    },
  });
  template.resourceCountIs('AWS::Scheduler::Schedule', 3);
  scheduleNamed(template, 'landslides-refresh-simple-10min');
  scheduleNamed(template, 'landslides-refresh-reference-daily');
  scheduleNamed(template, 'landslides-github-token-expiry-reminder-2027-09-21');
});

test('ten-minute schedule is enabled with rate(10 minutes) and no input', () => {
  const props = scheduleNamed(
    triggerTemplate(),
    'landslides-refresh-simple-10min'
  );
  assert.equal(props.ScheduleExpression, 'rate(10 minutes)');
  assert.equal(props.State, 'ENABLED');
  assert.equal(props.Target.Input, undefined);
});

test('daily schedule runs at 05:00 UTC with the refresh-reference payload', () => {
  const props = scheduleNamed(
    triggerTemplate(),
    'landslides-refresh-reference-daily'
  );
  assert.equal(props.ScheduleExpression, 'cron(0 5 * * ? *)');
  assert.equal(props.State, 'ENABLED');
  assert.deepEqual(JSON.parse(props.Target.Input), {
    workflow_file: 'refresh-reference.yml',
  });
});

test('reminder is a one-time at() schedule with no self delete', () => {
  const props = scheduleNamed(
    triggerTemplate(),
    'landslides-github-token-expiry-reminder-2027-09-21'
  );
  assert.equal(props.ScheduleExpression, 'at(2027-09-21T13:00:00)');
  assert.deepEqual(JSON.parse(props.Target.Input), {
    workflow_file: 'token-expiry-reminder.yml',
  });
  assert.ok(
    props.ActionAfterCompletion === undefined ||
      props.ActionAfterCompletion === 'NONE'
  );
});

test('function may read only that secret', () => {
  const template = triggerTemplate();
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  const reads = policies
    .flatMap(
      (p) =>
        p.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>
    )
    .filter((s) =>
      JSON.stringify(s.Action).includes('secretsmanager:GetSecretValue')
    );
  assert.equal(reads.length, 1);
  assert.match(JSON.stringify(reads[0].Resource), /Token/);
});

test('stack is termination protected', () => {
  const stack = new TriggerStack(new App(), 'Trigger', { env });
  assert.equal(stack.terminationProtection, true);
});

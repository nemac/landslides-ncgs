import { App } from 'aws-cdk-lib';
import { ACCOUNT, REGION } from '../lib/config.js';
import { readCutoverStage } from '../lib/cutover.js';
import { DnsStack } from '../lib/dns-stack.js';
import { WebStack } from '../lib/web-stack.js';

const app = new App();
const env = { account: ACCOUNT, region: REGION };
const stage = readCutoverStage(app);

const dns = new DnsStack(app, 'Dns', { env });
const web = new WebStack(app, 'Web', {
  env,
  stage,
  orgZone: dns.orgZone,
  comZone: dns.comZone,
  certificate: dns.certificate,
});

// Later stacks (Ci, Trigger) are added here as they are built.
void web;

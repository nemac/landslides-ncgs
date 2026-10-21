import { App } from 'aws-cdk-lib';
import { ACCOUNT, REGION } from '../lib/config.js';
import { readCutoverStage } from '../lib/cutover.js';
import { DnsStack } from '../lib/dns-stack.js';
import { WebStack } from '../lib/web-stack.js';
import { CiStack } from '../lib/ci-stack.js';
import { TriggerStack } from '../lib/trigger-stack.js';

const app = new App();
const env = { account: ACCOUNT, region: REGION };
// Every stack owns something that must not vanish by accident (the only
// authoritative DNS, the live distributions, the data bucket).
const protect = { env, terminationProtection: true };
const stage = readCutoverStage(app);

const dns = new DnsStack(app, 'Dns', protect);
const web = new WebStack(app, 'Web', {
  ...protect,
  stage,
  orgZone: dns.orgZone,
  comZone: dns.comZone,
  certificate: dns.certificate,
});

new CiStack(app, 'Ci', {
  ...protect,
  siteBucket: web.siteBucket,
  dataBucket: web.dataBucket,
  devSiteBucket: web.devSiteBucket,
  productionDistribution: web.productionDistribution,
  devDistribution: web.devDistribution,
});

new TriggerStack(app, 'Trigger', protect);

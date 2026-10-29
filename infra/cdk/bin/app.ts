import { App } from 'aws-cdk-lib';
import { ACCOUNT, REGION } from '../lib/config.js';
import { DnsStack } from '../lib/dns-stack.js';
import { WebStack } from '../lib/web-stack.js';
import { CiStack } from '../lib/ci-stack.js';
import { TriggerStack } from '../lib/trigger-stack.js';

const app = new App();
const env = { account: ACCOUNT, region: REGION };
// Every stack owns something that must not vanish by accident (the only
// authoritative DNS, the live distributions, the data bucket).
const protect = { env, terminationProtection: true };

const dns = new DnsStack(app, 'Dns', protect);
const web = new WebStack(app, 'Web', {
  ...protect,
  orgZone: dns.orgZone,
  comZone: dns.comZone,
  certificate: dns.certificate,
});

new CiStack(app, 'Ci', {
  ...protect,
  siteBucket: web.siteBucket,
  dataBucket: web.dataBucket,
  devSiteBucket: web.devSiteBucket,
  previewSiteBucket: web.previewSiteBucket,
  productionDistribution: web.productionDistribution,
  devDistribution: web.devDistribution,
  previewDistribution: web.previewDistribution,
});

new TriggerStack(app, 'Trigger', protect);

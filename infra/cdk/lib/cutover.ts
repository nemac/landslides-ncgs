import type { App } from 'aws-cdk-lib';
import { APEX_HOSTNAMES, COM_DOMAIN, ORG_DOMAIN, PROD_HOSTNAMES } from './config.js';

// Which hostnames the production distribution claims. The cutover runbook
// moves through the stages in order: wildcard (nothing moved yet), subdomains
// (the six non-apex names moved with the wildcard method), done (apexes moved,
// wildcards dropped). Passed as `--context cutover=<stage>`.
export type CutoverStage = 'wildcard' | 'subdomains' | 'done';

const STAGES: readonly CutoverStage[] = ['wildcard', 'subdomains', 'done'];
const WILDCARDS = [`*.${ORG_DOMAIN}`, `*.${COM_DOMAIN}`];

function isStage(value: unknown): value is CutoverStage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

export function readCutoverStage(app: App): CutoverStage {
  const value = app.node.tryGetContext('cutover') ?? 'wildcard';
  if (!isStage(value)) {
    throw new Error(`Unknown cutover stage "${value}"; expected one of ${STAGES.join(', ')}`);
  }
  return value;
}

function subdomainHostnames(): string[] {
  return PROD_HOSTNAMES.filter((name) => !APEX_HOSTNAMES.includes(name));
}

// Exact production names that get Route 53 records at this stage.
export function recordedHostnames(stage: CutoverStage): string[] {
  if (stage === 'wildcard') return [];
  if (stage === 'subdomains') return subdomainHostnames();
  return [...PROD_HOSTNAMES];
}

// The full alias list for the production distribution at this stage.
export function productionDomainNames(stage: CutoverStage): string[] {
  if (stage === 'done') return [...PROD_HOSTNAMES];
  return [...recordedHostnames(stage), ...WILDCARDS];
}

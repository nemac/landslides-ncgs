// Every fixed name and id for the landslidesncgs AWS account, in one place.
// Workflows copy bucket names and role ARNs from here (see infra/README.md).

export const ACCOUNT = '710482330128';
export const REGION = 'us-east-1';

export const ORG_DOMAIN = 'landslidesncgs.org';
export const COM_DOMAIN = 'landslidesncgs.com';

// The eight production hostnames. inventory.landslidesncgs.com is deliberately
// absent; it has never existed and is not to be created.
export const PROD_HOSTNAMES: readonly string[] = [
  'landslidesncgs.org',
  'www.landslidesncgs.org',
  'landslidesncgs.com',
  'www.landslidesncgs.com',
  'dashboard.landslidesncgs.org',
  'inventory.landslidesncgs.org',
  'mapviewer.landslidesncgs.org',
  'mapviewer.landslidesncgs.com',
];
export const DEV_HOSTNAME = 'dev.landslidesncgs.org';

// Pull request previews claim every other name under the .org domain;
// CloudFront and Route 53 both prefer the exact names above to a wildcard.
export const PREVIEW_HOSTNAME = `*.${ORG_DOMAIN}`;

export const SITE_BUCKET = 'landslidesncgs-site';
export const DATA_BUCKET = 'landslidesncgs-data';
export const DEV_SITE_BUCKET = 'landslidesncgs-dev-site';
export const PREVIEW_SITE_BUCKET = 'landslidesncgs-preview-site';

// pr-preview.yml deletes a preview's folder when its pull request closes.
// Anything a missed cleanup leaves behind expires after this many days; the
// next push to a still-open pull request uploads it again.
export const PREVIEW_EXPIRY_DAYS = 60;

export const GITHUB_REPO = 'nemac/landslides-ncgs';

// The roles GitHub Actions assume (Ci stack). The workflows carry their ARNs
// as literals; test/workflows.test.ts checks those literals against these.
export const PROD_ROLE_NAME = 'landslides-github-prod';
export const DEV_ROLE_NAME = 'landslides-github-dev';
export const PREVIEW_ROLE_NAME = 'landslides-github-preview';

// The one data-bucket prefix a workflow may delete from: refresh-reference.yml
// mirrors the building footprints there with `aws s3 sync --delete`.
export const BUILDINGS_PREFIX = 'alerts/data/buildings/';

// Old versions in the versioned data bucket are kept this long. Runs that
// flagged pathways are copied to simple/archive/ as current objects, which
// this does not touch.
export const DATA_NONCURRENT_VERSION_DAYS = 30;

// A one-time schedule fires at REMINDER_AT, a month before the GitHub token
// in the dispatch secret expires, to open a renewal issue. The expiry date
// itself is the `expires` input default in token-expiry-reminder.yml. Update
// both when the token is renewed.
export const REMINDER_AT = '2027-09-21T13:00:00Z';

// Turns a pull request's branch name into the DNS label of its preview site,
// <slug>.landslidesncgs.org. Used by .github/workflows/pr-preview.yml:
//
//   node infra/preview/preview-slug.js <branch> <pr-number>
//
// The label is the branch name lowercased, with every run of characters
// other than letters, digits and hyphens turned into one hyphen, trimmed of
// hyphens at either end and cut to the 63 characters DNS allows. A branch
// that leaves nothing, or that lands on a hostname the production or dev
// distribution already claims, gets pr-<number> instead: an exact hostname
// always wins over the preview wildcard, so that preview would never show.

// First labels of the real hostnames under landslidesncgs.org.
// infra/cdk/test/workflows.test.ts checks this against lib/config.ts.
const RESERVED_LABELS = ['www', 'dev', 'dashboard', 'inventory', 'mapviewer'];

const MAX_LABEL_LENGTH = 63;

function labelFrom(branch) {
  const label = branch
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return label.substring(0, MAX_LABEL_LENGTH).replace(/-+$/, '');
}

function previewSlug(branch, prNumber) {
  const label = labelFrom(branch);
  if (label === '' || RESERVED_LABELS.includes(label)) {
    return `pr-${prNumber}`;
  }
  return label;
}

if (require.main === module) {
  const [branch, prNumber] = process.argv.slice(2);
  if (!branch || !/^[0-9]+$/.test(prNumber || '')) {
    console.error('usage: preview-slug.js <branch> <pr-number>');
    process.exit(2);
  }
  console.log(previewSlug(branch, prNumber));
}

module.exports = { previewSlug, RESERVED_LABELS };

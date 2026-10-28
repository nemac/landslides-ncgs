import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CloudFront allows one function per event type per cache behavior and no
// imports between files, so each distribution gets one function built here
// by concatenating single-purpose pieces from infra/cloudfront/ and adding a
// small handler that calls them in order.

export const MAX_FUNCTION_BYTES = 10240;

export type FunctionMode = 'production' | 'dev' | 'preview';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PIECE_DIR = path.resolve(here, '..', '..', 'cloudfront');

const PRODUCTION_HANDLER = `function handler(event) {
    var r = hostedRedirects(event);
    if (r) { return r; }
    return rewrite(event);
}`;

const DEV_HANDLER = `var kvs = cf.kvs();
async function handler(event) {
    var r = await basicAuth(event, kvs);
    if (r) { return r; }
    return rewrite(event);
}`;

// rewrite() answers a redirect or 410 itself; only a request that passes
// through it is pointed at the preview's folder.
const PREVIEW_HANDLER = `var kvs = cf.kvs();
async function handler(event) {
    var r = await basicAuth(event, kvs);
    if (r) { return r; }
    var out = rewrite(event);
    if (out.statusCode) { return out; }
    return previewPrefix(out);
}`;

function readPiece(pieceDir: string, file: string): string {
  return fs.readFileSync(path.join(pieceDir, file), 'utf8').trimEnd();
}

function assertWithinLimit(code: string, mode: FunctionMode): void {
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > MAX_FUNCTION_BYTES) {
    throw new Error(
      `Composed ${mode} CloudFront Function is ${bytes} bytes; the limit is ${MAX_FUNCTION_BYTES}`
    );
  }
}

function productionParts(pieceDir: string): string[] {
  return [
    readPiece(pieceDir, 'landslides-hosted-redirects.js'),
    readPiece(pieceDir, 'landslides-rewrite.js'),
    PRODUCTION_HANDLER,
  ];
}

function devParts(pieceDir: string): string[] {
  return [
    "import cf from 'cloudfront';",
    readPiece(pieceDir, 'landslides-basic-auth.js'),
    readPiece(pieceDir, 'landslides-rewrite.js'),
    DEV_HANDLER,
  ];
}

function previewParts(pieceDir: string): string[] {
  return [
    "import cf from 'cloudfront';",
    readPiece(pieceDir, 'landslides-basic-auth.js'),
    readPiece(pieceDir, 'landslides-rewrite.js'),
    readPiece(pieceDir, 'landslides-preview-prefix.js'),
    PREVIEW_HANDLER,
  ];
}

const PARTS_BY_MODE: Record<FunctionMode, (pieceDir: string) => string[]> = {
  production: productionParts,
  dev: devParts,
  preview: previewParts,
};

export function composeFrom(pieceDir: string, mode: FunctionMode): string {
  const parts = PARTS_BY_MODE[mode](pieceDir);
  const code = parts.join('\n\n') + '\n';
  assertWithinLimit(code, mode);
  return code;
}

export function composeProductionFunction(): string {
  return composeFrom(DEFAULT_PIECE_DIR, 'production');
}

export function composeDevFunction(): string {
  return composeFrom(DEFAULT_PIECE_DIR, 'dev');
}

export function composePreviewFunction(): string {
  return composeFrom(DEFAULT_PIECE_DIR, 'preview');
}

// Repo-level rules: the files the standalone rulebook asks for, the README standard, the CSS standard, CI, the shelf entry, the talk track.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTalkTrack } from './build-talk-track.mjs';
import { buildPack, CATALOG } from './build-content-pack.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SKIP = new Set(['node_modules', 'dist', '.git', 'package-lock.json']);
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(root, p);

test('the files the standalone rules ask for are present', () => {
  for (const f of ['README.md', 'CLAUDE.md', 'LICENSE', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.env.example', '.nvmrc', '.gitignore', '.github/workflows/ci.yml', 'docs/talk-track.md', 'docs/shelf-entry.json', 'docs/content-pack.schema.json', 'content-pack.json', 'scripts/doctor.mjs', 'scripts/reset.mjs', 'scripts/smoke.mjs', 'web/src/styles/standalone-ui.css']) {
    assert.ok(fs.existsSync(path.join(root, f)), f);
  }
});

test('package.json has the standard scripts, requires Node 26, and is named for the LAB', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const s of ['start', 'dev', 'test', 'build', 'doctor', 'reset', 'prepare', 'smoke']) assert.ok(pkg.scripts[s], `script ${s}`);
  assert.equal(pkg.engines.node, '>=26');
  assert.equal(read('.nvmrc').trim(), '26');
  assert.match(pkg.name, /-lab$/);
  assert.match(read('Dockerfile').split('\n').filter((l) => l.startsWith('FROM')).join('\n'), /^FROM node:26-alpine AS build\nFROM node:26-alpine$/);
});

test('the shelf entry is valid and portable: relative composeFile, loopback url, health path, catalog id', () => {
  const e = JSON.parse(read('docs/shelf-entry.json')).demos[0];
  assert.equal(e.id, 'p1az-inspector');
  assert.equal(e.kind, 'Tester');
  assert.equal(e.healthPath, '/api/health');
  assert.equal(e.url, 'http://localhost:4840');
  assert.equal(e.composeFile, 'p1az-inspector-LAB/docker-compose.yml');
  assert.ok(!path.isAbsolute(e.composeFile));
  assert.ok(!/\/Users\//.test(JSON.stringify(e)), 'no absolute home path');
  assert.equal(e.catalogId, CATALOG, 'the shelf entry carries the same catalog id as the content pack');
  assert.equal(buildPack().demo.catalog, CATALOG);
  assert.equal(CATALOG, 'B2');
});

test('docs/talk-track.md is exactly what the builder makes from content/stories.json (no drift), and it says UNVERIFIED', () => {
  assert.equal(read('docs/talk-track.md'), buildTalkTrack());
  assert.match(read('docs/talk-track.md'), /UNVERIFIED/);
  for (const s of JSON.parse(read('content/stories.json'))) assert.ok(read('docs/talk-track.md').includes(s.say), s.id);
});

test('the CI workflow is GitHub-hosted, Node 26 only, and carries the forbidden-strings, gitleaks and doctor jobs', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /runs-on: ubuntu-latest/);
  assert.ok(!/self-hosted/.test(ci));
  const versions = [...ci.matchAll(/node-version: (\S+)/g)].map((m) => m[1]);
  assert.ok(versions.length >= 3 && versions.every((v) => v === '26'), versions.join());
  assert.match(ci, /forbidden-strings:/);
  assert.match(ci, /gitleaks/);
  assert.match(ci, /PORT=4849 npm run doctor/);
  assert.match(ci, /actions\/checkout@v5/);
  assert.match(ci, /actions\/setup-node@v5/);
});

test('README follows the README standard: title ends in LAB, plain Tier, Repo and Catalog lines, the 12 sections in order, the port text', () => {
  const r = read('README.md');
  assert.match(r.split('\n')[0], /^# .* LAB$/);
  assert.match(r, /^Tier: Tester$/m);
  assert.match(r, /^Repo: https:\/\/github\.com\/curtismu7\/p1az-inspector-LAB$/m);
  assert.match(r, new RegExp(`^Catalog: ${CATALOG}\\b`, 'm'));
  const order = ['What is simulated', 'Run from a clone', 'Settings file', 'Ports, and what to do if the port is taken', 'Mock and live modes', 'Health, doctor and reset', 'Docker', 'Tests', 'Troubleshooting', 'Ownership'].map((h) => r.indexOf(`\n## ${h}`));
  assert.ok(order.every((i) => i > 0), order.join());
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'sections are in order');
  assert.match(r, /lsof -iTCP:4840 -sTCP:LISTEN -n -P/);
  assert.match(r, /PORT=<other port> npm start/);
  assert.match(r, /4840-4849/);
  assert.ok(!/ping-devops|cmuir|curtismu/i.test(r));
  assert.ok(!/\bdoor\b/i.test(r));
});

test('docs and code carry no SE, k8s, hosted-build or bare-MODE leftovers (deferred by the owner, 2026-10-31)', () => {
  assert.ok(!fs.existsSync(path.join(root, 'k8s')));
  const hits = [];
  for (const p of walk(root)) {
    if (/\.(png|ico|woff2?)$/.test(p) || rel(p) === 'scripts/repo.test.mjs' || rel(p).startsWith('CHANGELOG')) continue;
    const t = fs.readFileSync(p, 'utf8');
    for (const re of [/process\.env\.MODE\b/, /\benv\.MODE\b/, /P1AZ_HOSTED/, /\bhosted build\b/i, /\b__SE_HOST__\b|\b__IMAGE__\b/, /ai-demo\.ping-devops/]) if (re.test(t)) hits.push(`${rel(p)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('no EC key generation through generateKeyPair(Sync) (SIGABRT lesson), and no ~/.config/demo-kit/pingone.json reader', () => {
  const hits = [];
  for (const p of walk(root)) {
    if (!/\.(m?js|jsx)$/.test(p) || rel(p) === 'scripts/repo.test.mjs') continue;
    const t = fs.readFileSync(p, 'utf8');
    if (/generateKeyPair(Sync)?\(/.test(t)) hits.push(`${rel(p)}: generateKeyPair`);
    if (/pingone\.json/.test(t) && !/server\/test\//.test(rel(p))) hits.push(`${rel(p)}: pingone.json`);
  }
  assert.deepEqual(hits, []);
});

test('app CSS follows the CSS standard: tokens only, no dark-mode media query, no forced priority, no italics, breakpoints 600 and 900 only, no purple', () => {
  const css = read('web/src/app.css');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(css), 'no colour literal');
  assert.ok(!/prefers-color-scheme/.test(css)); assert.ok(!/!important/.test(css)); assert.ok(!/font-style:\s*italic/.test(css));
  const widths = [...css.matchAll(/@media \((?:max|min)-width: (\d+)px\)/g)].map((m) => m[1]);
  assert.ok(widths.length > 0 && widths.every((w) => w === '600' || w === '900'), widths.join());
  assert.ok(!/purple|violet|magenta|indigo/i.test(css));
  const main = read('web/src/main.jsx');
  assert.ok(main.indexOf('standalone-ui.css') < main.indexOf('app.css'), 'the shared stylesheet loads before the app stylesheet');
  for (const f of walk(path.join(root, 'web', 'src')).filter((p) => /\.jsx$/.test(p) && !/__tests__/.test(p))) {
    assert.ok(!/style=\{\{/.test(fs.readFileSync(f, 'utf8')), `${rel(f)}: no style attributes`);
  }
});

test('the web code has no credential field other than the write-only worker secret, and never writes HTML', () => {
  const all = walk(path.join(root, 'web', 'src')).filter((p) => /\.jsx?$/.test(p) && !/__tests__/.test(p)).map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  assert.deepEqual([...all.matchAll(/type="password"/g)].length, 1);
  assert.ok(!/dangerouslySetInnerHTML|innerHTML/.test(all));
});

test('no user-facing text says Live reaches "the one host": for PingOne cloud it is the token host and the API host', () => {
  for (const f of ['README.md', 'CLAUDE.md', 'content/stories.json', 'content/terms.json', 'docs/talk-track.md', 'content-pack.json', 'web/src/App.jsx']) {
    const s = read(f);
    assert.ok(!/(?:reach|reaches) that one host|permit for exactly the one host|one PingOne environment or PingAuthorize you set up/.test(s), f);
  }
  assert.match(read('README.md'), /auth\.pingone\.<region>/);
  assert.match(read('README.md'), /api\.pingone\.<region>/);
  assert.match(read('web/src/App.jsx'), /only to the PingOne hosts for your region/);
});

test('the README says the on-prem URL is the one address the server fetches and may be internal', () => {
  assert.match(read('README.md'), /on-prem URL is the one address you type that the server will fetch/);
  assert.match(read('README.md'), /link-local/);
});

test('the content pack and talk track never carry a shared-file secret, and the builders do not read the shared file', async () => {
  const sentinel = 'sentinel-shared-secret-456';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-pack-'));
  const envFile = path.join(dir, 'shared.env');
  fs.writeFileSync(envFile, `PINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${sentinel}\n`, { mode: 0o600 });
  const before = process.env.STANDALONE_ENV;
  process.env.STANDALONE_ENV = envFile;
  try {
    assert.ok(!buildTalkTrack().includes(sentinel));
    assert.ok(!JSON.stringify(buildPack()).includes(sentinel));
  } finally { if (before === undefined) delete process.env.STANDALONE_ENV; else process.env.STANDALONE_ENV = before; }
  for (const f of ['docs/talk-track.md', 'content-pack.json', 'README.md', 'CLAUDE.md', '.env.example']) assert.ok(!read(f).includes(sentinel), f);
  assert.match(read('README.md'), /PINGONE_CLIENT_SECRET/);
  assert.match(read('.env.example'), /PINGONE_CLIENT_ID/);
});

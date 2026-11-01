#!/usr/bin/env node
/**
 * Generates content-pack.json (repo root). Format: docs/content-pack.schema.json (a copy of the Learning Hub schema).
 * Glossary from content/terms.json, stories from content/stories.json, cards for the three pages. Deterministic: lists sorted by
 * id, 2-space JSON, no timestamps. The git commit is recorded only when passed (--commit=<sha>), so a plain run is reproducible.
 *
 * Sources: none. No public documentation URL is cited in this repo that was verified, so the pack lists none, and product claims
 * are labelled UNVERIFIED in the glossary.
 *
 * CATALOG is the family-plan catalog id the hub requires. The catalog has no exact row for this app (B2, "Authorize policy playground",
 * is the nearest neighbour), so B2 is a stand-in until the owner assigns one. Change it here, in docs/shelf-entry.json and in the README
 * (a repo test pins all three).
 *
 *   node scripts/build-content-pack.mjs [--commit=<sha>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACK_PATH = path.join(ROOT, 'content-pack.json');
export const CATALOG = 'B2';
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The UI is one page per view with a hash route.
const CARDS = [
  { id: 'console', label: 'Send a decision and read the verdict', description: 'Pick a preset, send it to the Mock engine (or Live), and see the verdict, statements and the exact call.', group: 'try-it', href: '/#console', terms: ['decision', 'statements', 'mock-engine', 'decision-endpoint'], story: 'S01' },
  { id: 'settings', label: 'Set up Live (opt-in)', description: 'Connect a PingOne environment or an on-prem PingAuthorize. The client secret is write-only.', group: 'setup', href: '/#settings', terms: ['live', 'worker-token', 'pingauthorize-onprem', 'netguard'], story: 'S04' },
  { id: 'flow', label: 'How a decision travels', description: 'Request, engine or PingOne Authorize, verdict and statements as a movable diagram with Simulate.', group: 'concept', href: '/#diagram', terms: ['pingone-authorize', 'decision', 'recent-decisions'], story: 'S02' },
];

export function buildPack({ commit } = {}) {
  const pkg = readJson('package.json');
  const stories = readJson('content/stories.json').sort(byId);
  const ids = new Set(stories.map((s) => s.id));
  const pack = {
    schema: 'demo-content-pack/1',
    id: 'p1az-inspector',
    title: 'P1AZ Inspector LAB',
    version: pkg.version,
    ...(commit ? { source: { repo: 'p1az-inspector-LAB', commit } } : {}),
    demo: { id: 'p1az-inspector', name: 'P1AZ Inspector LAB', catalog: CATALOG, baseUrl: 'http://localhost:4840', doctor: '/api/health', tags: ['pingone-authorize', 'decision', 'mock', 'tester'] },
    glossary: readJson('content/terms.json').sort(byId),
    sources: [],
    cards: CARDS.map(({ href, ...c }) => ({ ...c, action: { type: 'route', href } })).sort(byId),
    diagrams: [{ id: 'flow', label: 'How a decision travels', href: '/#diagram' }],
    stories,
  };
  for (const c of pack.cards) if (c.story && !ids.has(c.story)) throw new Error(`card ${c.id} names unknown story ${c.story}`);
  return pack;
}

export const serialize = (pack) => `${JSON.stringify(pack, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commit = process.argv.find((a) => a.startsWith('--commit='))?.slice(9);
  fs.writeFileSync(PACK_PATH, serialize(buildPack({ commit })));
  console.log(`wrote ${path.relative(process.cwd(), PACK_PATH) || PACK_PATH}`);
}

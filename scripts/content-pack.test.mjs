// Rule 6: the Learning Hub pack (demo-content-pack/1) validates against the hub schema and is up to date with its sources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { buildPack, serialize, PACK_PATH } from './build-content-pack.mjs';
import { validatePack } from './validate-content-pack.mjs';

test('content-pack.json validates against the hub schema and its cross-references', () => {
  const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
  assert.deepEqual(validatePack(pack), []);
  assert.equal(pack.schema, 'demo-content-pack/1');
});

test('content-pack.json is exactly what the build script generates (never hand-edited)', () => {
  assert.equal(fs.readFileSync(PACK_PATH, 'utf8'), serialize(buildPack()));
});

test('the validator rejects a broken pack: unknown term, unknown story, missing field', () => {
  const pack = buildPack();
  const bad = structuredClone(pack);
  bad.cards[0].terms = ['no-such-term'];
  bad.cards[1].story = 'S99';
  delete bad.demo.catalog;
  const errors = validatePack(bad);
  assert.ok(errors.some((e) => /unknown term/.test(e)));
  assert.ok(errors.some((e) => /unknown story/.test(e)));
  assert.ok(errors.some((e) => /catalog/.test(e)));
});

test('every glossary term is used by a card (no dead content)', () => {
  const pack = buildPack();
  const used = new Set(pack.cards.flatMap((c) => c.terms || []));
  for (const t of pack.glossary) assert.ok(used.has(t.id), `glossary term ${t.id} is not used by any card`);
});

test('product claims that are not sourced say UNVERIFIED', () => {
  const pack = buildPack();
  const text = (id) => pack.glossary.find((g) => g.id === id).definition;
  assert.match(text('pingone-authorize'), /UNVERIFIED/);
  assert.match(text('pingauthorize-onprem'), /UNVERIFIED/);
});

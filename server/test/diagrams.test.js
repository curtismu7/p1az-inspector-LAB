// Rule 17: the diagram is diagram-studio/1 data in server/diagrams, validated at startup and served by name.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { DIAGRAM_DIR, DIAGRAM_NAMES, createDiagrams, loadDiagrams } from '../src/diagramData.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';
import { runChecks } from '../src/doctor.js';

const NAME = 'p1az-inspector-flow';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-diagrams-'));
const good = () => JSON.parse(fs.readFileSync(path.join(DIAGRAM_DIR, `${NAME}.json`), 'utf8'));
const dirWith = (doc) => { const d = tmp(); fs.writeFileSync(path.join(d, `${NAME}.json`), typeof doc === 'string' ? doc : JSON.stringify(doc)); return d; };

async function boot(opts = {}) {
  const root = tmp();
  const env = { DATA_DIR: path.join(root, 'own'), STANDALONE_ENV: path.join(root, 'none.env') };
  const server = createApp({ env, ...opts }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, get: (u) => fetch(base + u), close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('the shipped file is diagram-studio/1, valid, and its id is its file name', () => {
  assert.deepEqual([...DIAGRAM_NAMES], [NAME]);
  const d = good();
  assert.equal(d.schema, 'diagram-studio/1');
  assert.deepEqual(validateDiagram(d), []);
  assert.equal(d.id, NAME);
  // The content the page used to bundle: 6 boxes, 5 arrows, 3 groups, 3 steps (a drop here is a visual change).
  assert.equal(d.nodes.length, 6);
  assert.equal(d.edges.length, 5);
  assert.equal(Object.keys(d.groups).length, 3);
  assert.equal(d.steps.length, 3);
});

test('GET /api/diagrams/:name serves the validated document, uncached, as JSON', async () => {
  const t = await boot();
  try {
    const res = await t.get(`/api/diagrams/${NAME}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), good());
  } finally { await t.close(); }
});

test('an unknown name is a JSON 404 that does not echo the name', async () => {
  const t = await boot();
  try {
    const probes = ['nope', 'sk-live-ABCDEF1234567890SECRETVALUE', 'P1AZ-INSPECTOR-FLOW', `${NAME}.json`, `${NAME}%2f..%2f..%2fpackage`, '..%2f..%2fpackage', '%2e%2e', `${NAME}%00`];
    for (const p of probes) {
      const res = await t.get(`/api/diagrams/${p}`);
      assert.equal(res.status, 404, p);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const text = await res.text();
      const j = JSON.parse(text); // a path with an encoded slash never reaches the route and gets the API's own 404; both say nothing of the input
      assert.equal(j.error, 'not_found');
      assert.ok(/^no such (diagram|endpoint)$/.test(j.message), j.message);
      assert.ok(!text.includes('ABCDEF') && !text.includes('package'), text);
    }
    const res = await t.get('/api/diagrams/sk-live-ABCDEF1234567890SECRETVALUE');
    assert.ok(!(await res.text()).includes('SECRETVALUE'));
    assert.equal((await t.get('/api/diagrams')).status, 404);
  } finally { await t.close(); }
});

test('__proto__, constructor, prototype and other Object keys are refused, never looked up', async () => {
  const t = await boot();
  try {
    for (const p of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
      const res = await t.get(`/api/diagrams/${p}`);
      assert.equal(res.status, 404, p);
      assert.deepEqual(await res.json(), { error: 'not_found', message: 'no such diagram' });
    }
  } finally { await t.close(); }
  const store = createDiagrams();
  for (const k of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', undefined, null, 5, {}, ['p1az-inspector-flow'], { toString: () => NAME }]) assert.equal(store.get(k), null, String(k));
  assert.equal(store.get(NAME).id, NAME);
});

test('a malformed percent escape is a plain 400 that does not echo the path', async () => {
  const t = await boot();
  try {
    const res = await t.get('/api/diagrams/%E0%A4%A-SECRETVALUE');
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!text.includes('SECRETVALUE'), text);
    assert.equal(JSON.parse(text).error, 'bad_request');
  } finally { await t.close(); }
});

test('startup refuses an invalid, missing, unparseable or mis-named file (createDiagrams, createApp and doctor)', async () => {
  const bad = {
    'wrong schema': { ...good(), schema: 'diagram-studio/2' },
    'edge to a missing box': { ...good(), edges: [{ source: 'you', target: 'ghost' }] },
    'unknown group': { ...good(), nodes: good().nodes.map((n, i) => (i ? n : { ...n, group: 'nope' })) },
    'id is not the file name': { ...good(), id: 'something-else' },
    'step points past the edges': { ...good(), steps: [{ title: 'x', what: 'y', edges: [99] }] },
    'not an object': [],
    'not JSON': '{ this is not json',
  };
  for (const [why, doc] of Object.entries(bad)) {
    const dir = dirWith(doc);
    assert.throws(() => loadDiagrams({ dir }), /diagram data refused/, why);
    assert.throws(() => createDiagrams({ dir }), /diagram data refused/, why);
    const c = runChecks({ env: { DATA_DIR: path.join(tmp(), 'own'), STANDALONE_ENV: path.join(tmp(), 'none.env') }, diagramDir: dir }).find((x) => x.id === 'diagrams');
    assert.equal(c.level, 'fail', why);
  }
  assert.throws(() => loadDiagrams({ dir: tmp() }), /diagram data refused/, 'missing file');
  assert.throws(() => createApp({ diagrams: createDiagrams({ dir: dirWith('nope') }) }), /diagram data refused/);
  // The default createApp loads the shipped files; with them valid it boots (doctor agrees).
  const c = runChecks({ env: { DATA_DIR: path.join(tmp(), 'own'), STANDALONE_ENV: path.join(tmp(), 'none.env') } }).find((x) => x.id === 'diagrams');
  assert.equal(c.level, 'pass');
});

test('names that are not on the pattern or the allow-list are refused at load time', () => {
  for (const names of [['__proto__'], ['../package'], ['UPPER'], [''], [5], ['a/b'], ['nope-not-a-file']]) assert.throws(() => loadDiagrams({ names }), /diagram data refused/, JSON.stringify(names));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';

// Regression: the header "Shelf" button reads GET /api/shelf. It must answer with no web build present.
test('GET /api/shelf returns SHELF_URL (trailing slash trimmed) without a web build; POST is not 200', async () => {
  const prev = process.env.SHELF_URL;
  process.env.SHELF_URL = 'https://shelf.example:8443/';
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/shelf`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { shelfUrl: 'https://shelf.example:8443' });
    const p = await fetch(`${base}/api/shelf`, { method: 'POST', headers: { Origin: base } });
    assert.notEqual(p.status, 200);
  } finally {
    if (prev === undefined) delete process.env.SHELF_URL; else process.env.SHELF_URL = prev;
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
});

#!/usr/bin/env node
// Real-browser run of the host-run app with a temp DATA_DIR and a STANDALONE_ENV that does not exist (your real ~/Development/.env and
// ~/.p1az-inspector are never touched). Drives Mock sends, the Mock / Live toggle and banner, the Live gate, Settings (secret never
// echoed), the diagram. Live PingOne is NOT called here: no network, no tenant. Screenshots go to .data/e2e-screenshots (git-ignored). Not run by CI.
//   npm run build   (once; the server serves web/dist)      npm run e2e
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, '.data', 'e2e-screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function waitFor(url, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`${url} did not come up`);
    await sleep(150);
  }
}
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) { console.error('Run `npm run build` first.'); process.exit(2); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-e2e-'));
fs.mkdirSync(shots, { recursive: true });
const port = await freePort();
const server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: path.join(work, 'own'), STANDALONE_ENV: path.join(work, 'none.env') }, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}/`;
const SECRET = 'e2e-secret-xyz';
let browser;
try {
  await waitFor(`${base}api/health`);
  browser = await chromium.launch({ executablePath: process.env.P1AZ_E2E_CHROMIUM || undefined }); // optional: a Chromium you already have
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base);

  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByTestId('detail').getByText('Consent needed').first().waitFor();
  check(true, 'Mock: a 500 transfer needs consent');
  await page.getByLabel('Amount').fill('5000');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByTestId('detail').getByText('Deny').first().waitFor();
  check((await page.getByTestId('detail').innerText()).includes('Over the limit'), 'Mock: 5000 is denied with the statement');
  await page.screenshot({ path: path.join(shots, 'console-mock.png') });

  check((await page.getByTestId('banner').innerText()).startsWith('MOCK mode'), 'Mock: the banner says MOCK');
  // The Live gate: until Settings is filled in, Live is disabled and its title says why; the page stays in Mock.
  const live = page.getByRole('button', { name: 'Live' });
  await page.waitForFunction(() => document.querySelector('[data-testid="mode-live"]')?.title?.length > 0);
  check(await live.isDisabled(), 'Live: the Live button is disabled until Settings is filled in');
  check(/live settings are incomplete/.test((await live.getAttribute('title')) || ''), 'Live: the disabled button says why (settings incomplete)');
  check((await page.getByTestId('mode').innerText()) === 'Mode: mock', 'Live: the header stays in Mock');

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Environment ID').fill('00000000-0000-4000-8000-000000000000');
  await page.getByLabel('Worker client ID').fill('e2e-client');
  await page.getByLabel('Worker client secret').fill(SECRET);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Saved.').waitFor();
  check(!(await page.content()).includes(SECRET), 'Settings: the secret is not in the page after saving');
  const own = path.join(work, 'own', 'settings.json');
  check((fs.statSync(own).mode & 0o777) === 0o600, 'Settings: the settings file is owner-only (600)');
  await live.click({ timeout: 10_000 });
  await page.getByText(/^LIVE mode, owner-run\./).waitFor();
  check((await page.getByTestId('mode').innerText()) === 'Mode: live', 'Settings: after saving, Live can be chosen and the header shows it');
  check(true, 'Settings: after saving, the banner says Live is set up');
  await page.getByRole('button', { name: 'Mock' }).click();
  await page.screenshot({ path: path.join(shots, 'settings.png') });

  await page.getByRole('tab', { name: 'How it fits' }).click();
  await page.getByRole('button', { name: 'Simulate' }).click();
  await page.getByTestId('caption').getByText(/Step 1/).waitFor();
  check(true, 'Diagram: Simulate shows a captioned step');
  // exact: the header also has "Reset session", which would match a substring.
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  check((await page.getByTestId('caption').innerText()).includes('Press Simulate'), 'Diagram: Reset clears it');
  await page.screenshot({ path: path.join(shots, 'diagram.png') });

  // Rule 3: Reset session in a real browser clears the server's call log, and says so.
  await page.getByRole('tab', { name: 'Console' }).click();
  await page.getByText('Calls this session').waitFor();
  await page.getByText('No calls yet. Press Send.').waitFor({ state: 'detached' }); // the list loads after the page mounts
  check(true, 'Reset session: the Console has calls before it');
  await page.getByRole('button', { name: 'Reset session' }).click();
  await page.getByText('No calls yet. Press Send.').waitFor();
  check(true, 'Reset session: the call log is empty afterwards');
  check((await (await fetch(`${base}api/calls`)).json()).calls.length === 0, 'Reset session: the server log is empty too');
  check(await page.getByText(/Saved settings kept/).count() === 1, 'Reset session: says what it kept');
} catch (err) {
  console.error(err.message); failures++;
} finally {
  await browser?.close();
  server.kill();
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

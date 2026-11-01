#!/usr/bin/env node
/**
 * Generates docs/talk-track.md from content/stories.json (the four "say" lines the presenter reads), so the doc and the stories cannot drift:
 * a test compares the committed file with this builder's output.
 *   node scripts/build-talk-track.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TALK_PATH = path.join(ROOT, 'docs', 'talk-track.md');

export function buildTalkTrack() {
  const stories = JSON.parse(fs.readFileSync(path.join(ROOT, 'content', 'stories.json'), 'utf8')).sort((a, b) => (a.id < b.id ? -1 : 1));
  const lines = [
    '# P1AZ Inspector LAB: talk track',
    '',
    'Generated from `content/stories.json` by `npm run talk-track`. Do not edit by hand.',
    '',
    'Press P (or the Presenter button) for presenter mode: larger text, the Mock / Live toggle and the simulation banner stay on screen. Esc leaves it.',
    'Say which mode you are in before you start: the header and the banner both show it. Mock is simulated; Live is owner-run against your own PingOne environment or PingAuthorize.',
    '',
  ];
  for (const s of stories) lines.push(`## ${s.id}. ${s.title}`, '', s.say, '');
  lines.push(
    '## Caveat to say out loud',
    '',
    'The request and response shapes follow an earlier internal integration and are UNVERIFIED against PingOne\'s documentation. The on-prem PingAuthorize call has only been checked against a stand-in, not a real PingAuthorize.',
    '',
  );
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.dirname(TALK_PATH), { recursive: true });
  fs.writeFileSync(TALK_PATH, buildTalkTrack());
  console.log(`wrote ${path.relative(process.cwd(), TALK_PATH) || TALK_PATH}`);
}

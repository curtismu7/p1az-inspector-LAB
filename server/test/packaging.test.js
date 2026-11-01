import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Rule 2 (section 2): Docker publishes 127.0.0.1 only. This pins it, so a later edit cannot open the port to the network.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('docker-compose publishes the port on loopback only', () => {
  const yml = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(yml, /"127\.0\.0\.1:\$\{HOST_PORT:-\d+\}:\d+"/);
  assert.doesNotMatch(yml, /"0\.0\.0\.0:|^\s*- "\d+:\d+"/m);
});

test('the container is locked down: read-only fs, no capabilities, no new privileges, no host mounts, non-root, Node 26', () => {
  const yml = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(yml, /read_only: true/);
  assert.match(yml, /cap_drop: \[ALL\]/);
  assert.match(yml, /no-new-privileges:true/);
  assert.doesNotMatch(yml, /\$\{HOME\}|\/Users\/|~\//, 'no host directory is mounted');
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(docker, /^USER node$/m);
  assert.match(docker, /^ENV P1AZ_BIND=0\.0\.0\.0$/m);
  assert.equal((docker.match(/^FROM node:26-alpine/gm) || []).length, 2);
  const port = Number(/^EXPOSE (\d+)/m.exec(docker)[1]);
  assert.equal(port, 4840);
  assert.match(yml, new RegExp(`:${port}"`));
});

test('the image copies the diagram files, and the server reads them from server/diagrams (rule 17)', () => {
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(docker, /^COPY server\/diagrams server\/diagrams$/m);
  const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  assert.doesNotMatch(ignore, /diagrams/);
  assert.ok(fs.existsSync(path.join(root, 'server', 'diagrams', 'p1az-inspector-flow.json')));
});

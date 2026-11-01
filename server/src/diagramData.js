// The diagrams are diagram-studio/1 DATA (server/diagrams/<name>.json), checked with the studio's own validator copy and served by
// name (GET /api/diagrams/:name, rule 17). Nothing here, and nothing in the web app, builds nodes or edges by hand.
// Loading is strict: every file in DIAGRAM_NAMES must exist, parse, validate and carry its own file name as its id, or the whole
// load throws (the server refuses to start and doctor fails). A lookup takes only a name from that allow-list.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDiagram } from './diagramStudioValidate.js';

export const DIAGRAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../diagrams');
export const DIAGRAM_NAMES = Object.freeze(['p1az-inspector-flow']);
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;

// Returns a null-prototype map name -> document. Throws one Error naming every problem; never returns a partial set.
export function loadDiagrams({ dir = DIAGRAM_DIR, names = DIAGRAM_NAMES } = {}) {
  const docs = Object.create(null);
  const problems = [];
  for (const name of names) {
    if (typeof name !== 'string' || !NAME.test(name)) { problems.push('a diagram name is not on the allowed pattern'); continue; }
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')); } catch (err) {
      problems.push(`${name}: cannot be read as JSON (${err.code || 'parse error'})`);
      continue;
    }
    const bad = validateDiagram(doc);
    if (bad.length) { problems.push(`${name}: not valid diagram-studio/1: ${bad.join('; ')}`); continue; }
    if (doc.id !== name) { problems.push(`${name}: the id inside the file is not the file name`); continue; }
    docs[name] = doc;
  }
  if (problems.length) throw new Error(`diagram data refused: ${problems.join(' | ')}`);
  return docs;
}

// The store the API serves. get() answers only for a string on the allow-list, so '__proto__', 'constructor' and the like are refused.
export function createDiagrams(opts) {
  const docs = loadDiagrams(opts);
  const names = Object.freeze(Object.keys(docs));
  return {
    names,
    get: (name) => (typeof name === 'string' && NAME.test(name) && Object.hasOwn(docs, name) ? docs[name] : null),
  };
}

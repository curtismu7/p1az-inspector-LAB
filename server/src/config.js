import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4840;

export function dataDir(env = process.env) { return env.DATA_DIR || path.join(os.homedir(), '.p1az-inspector'); }
export function port(env = process.env) { return Number(env.PORT) || DEFAULT_PORT; }

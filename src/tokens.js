import fs from 'node:fs';
import { CTXTREE_DIR, CALIB_FILE } from './paths.js';

export * from '../plugins/ctxtree/core/tokens.js';

export function saveCalibration(cal) {
  try {
    fs.mkdirSync(CTXTREE_DIR, { recursive: true });
    fs.writeFileSync(CALIB_FILE, JSON.stringify({ ...cal, at: new Date().toISOString() }, null, 2));
  } catch { /* cache is an optimisation */ }
}
export function loadCalibration() {
  try { return JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')); } catch { return null; }
}

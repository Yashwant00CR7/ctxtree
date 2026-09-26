import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');
export const CTXTREE_DIR = path.join(CLAUDE_DIR, 'ctxtree');
export const LINEAGE_FILE = path.join(CTXTREE_DIR, 'lineage.jsonl');
export const CALIB_FILE = path.join(CTXTREE_DIR, 'calibration.json');
export const CLAUDE_JSON = path.join(HOME, '.claude.json');

// ~/.claude/projects/-Users-me-code-foo  ->  /Users/me/code/foo  (best effort)
export function slugToPath(slug) {
  return slug.replace(/^-/, '/').replace(/-/g, '/');
}
export function prettyProject(slug) {
  const parts = slug.replace(/^-/, '').split('-');
  return parts.slice(-2).join('/') || slug;
}

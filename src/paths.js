import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
// Claude Code honours CLAUDE_CONFIG_DIR; so do we (and the tests use it to run
// against a sandbox instead of your real ~/.claude).
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const FILE_HISTORY_DIR = path.join(CLAUDE_DIR, 'file-history');
export const CTXTREE_DIR = path.join(CLAUDE_DIR, 'ctxtree');
export const LINEAGE_FILE = path.join(CTXTREE_DIR, 'lineage.jsonl');
// --settings overlays forks are launched with (see boot.js).
export const PROFILES_DIR = path.join(CTXTREE_DIR, 'profiles');
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

// A demo project and a scripted model for the walkthrough's screenshots: a
// realistic afternoon of work (a bug fix, a feature, a log check, a screenshot,
// a README edit) so the map has something real to show. The tools really run,
// against these files, in the sandbox.
import path from 'node:path';
import zlib from 'node:zlib';

const line = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

const TOKEN_JS = `// Access and refresh tokens for the API.
const crypto = require('node:crypto');
const { sign, verify } = require('../lib/jwt');

const ACCESS_TTL = 15 * 60;        // seconds
const REFRESH_TTL = 30 * 24 * 3600; // seconds

class Token {
  constructor({ userId, scopes = [], issuedAt, expiresAt, refresh }) {
    this.userId = userId;
    this.scopes = scopes;
    this.issuedAt = issuedAt;
    this.expiresAt = expiresAt;
    this.refresh = refresh;
  }

  static issue(userId, scopes) {
    const now = Math.floor(Date.now() / 1000);
    return new Token({ userId, scopes, issuedAt: now, expiresAt: now + ACCESS_TTL, refresh: crypto.randomBytes(32).toString('hex') });
  }

  isExpired() {
    return Date.now() > this.expiresAt;
  }

  toJwt() {
    return sign({ sub: this.userId, scp: this.scopes, iat: this.issuedAt, exp: this.expiresAt });
  }

  static fromJwt(jwt) {
    const p = verify(jwt);
    return new Token({ userId: p.sub, scopes: p.scp, issuedAt: p.iat, expiresAt: p.exp });
  }
}
${line(90, i => `// helper ${i}: ${['normalise scopes', 'audit hook', 'clock skew guard', 'token rotation note'][i % 4]} (${i})`)}
module.exports = { Token, ACCESS_TTL, REFRESH_TTL };
`;

const SESSION_JS = `// Sessions: one per signed-in device.
const { Token } = require('./token');
const store = require('../lib/store');

async function createSession(userId, device) {
  const token = Token.issue(userId, ['read', 'write']);
  await store.put(\`session:\${token.refresh}\`, { userId, device, createdAt: Date.now() });
  return token;
}

async function refreshSession(refresh, current) {
  const s = await store.get(\`session:\${refresh}\`);
  if (!s) throw new Error('unknown session');
  if (current && !current.isExpired()) return current;   // still valid: keep it
  const next = Token.issue(s.userId, ['read', 'write']);
  await store.move(\`session:\${refresh}\`, \`session:\${next.refresh}\`);
  return next;
}
${line(80, i => `// session note ${i}: ${['device fingerprint', 'idle timeout', 'revocation list', 'audit trail'][i % 4]}`)}
module.exports = { createSession, refreshSession };
`;

const LOGIN_JS = `const express = require('express');
const { createSession, refreshSession } = require('../auth/session');
const router = express.Router();

router.post('/login', async (req, res) => {
  const user = await req.users.check(req.body.email, req.body.password);
  if (!user) return res.status(401).json({ error: 'bad credentials' });
  const token = await createSession(user.id, req.get('user-agent'));
  res.json({ access: token.toJwt(), refresh: token.refresh });
});

router.post('/refresh', async (req, res) => {
  const token = await refreshSession(req.body.refresh);
  res.json({ access: token.toJwt(), refresh: token.refresh });
});

module.exports = router;
`;

const CORS_JS = `// CORS for the web client.
module.exports = function cors(allowed) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowed.includes(origin)) {
      res.set('access-control-allow-origin', origin);
      res.set('access-control-allow-credentials', 'true');
    }
    next();
  };
};
`;

const RATE_LIMIT_JS = `// Fixed-window rate limit per client IP.
const WINDOW_MS = 60 * 1000;

module.exports = function rateLimit({ max = 5, windowMs = WINDOW_MS, key = (req) => req.ip } = {}) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req), now = Date.now();
    let h = hits.get(k);
    if (!h || now - h.start > windowMs) { h = { start: now, n: 0 }; hits.set(k, h); }
    h.n++;
    res.set('x-ratelimit-limit', String(max));
    res.set('x-ratelimit-remaining', String(Math.max(0, max - h.n)));
    if (h.n > max) {
      res.set('retry-after', String(Math.ceil((h.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: 'too many attempts, try again shortly' });
    }
    next();
  };
};
${line(60, i => `// tuning note ${i}: ${['burst allowance', 'proxy headers', 'redis store option', 'per-route overrides'][i % 4]}`)}
`;

const SERVER_LOG = line(1800, (i) => {
  const t = `2026-10-11T${String(Math.floor(i / 75)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}Z`;
  if (i % 211 === 17) return `${t} ERROR POST /refresh 500 TypeError: Cannot read properties of undefined (reading 'userId') at refreshSession (src/auth/session.js:12)`;
  if (i % 97 === 5) return `${t} WARN  POST /login 401 bad credentials ip=10.0.${i % 255}.${(i * 3) % 255}`;
  return `${t} INFO  ${['GET /health 200 1ms', 'POST /login 200 84ms', 'GET /me 200 12ms', 'POST /refresh 200 31ms', 'GET /orders 200 45ms'][i % 5]} req=${(i * 2654435761 >>> 0).toString(16)}`;
});

const README = `# acme-api

The API behind the Acme web and mobile clients.

## Setup

1. \`npm install\`
2. Copy \`.env.example\` to \`.env\` and fill in \`DATABASE_URL\` and \`JWT_SECRET\`.
3. \`npm run dev\` starts the server on port 8080.

## Auth

Access tokens last 15 minutes; refresh tokens 30 days. Clients refresh through \`POST /refresh\`.
${line(50, i => `\n### Section ${i}\nNotes about ${['deployments', 'migrations', 'feature flags', 'observability', 'on-call'][i % 5]} go here.`)}
`;

// A test runner whose output depends on whether the expiry bug is fixed.
const RUN_TESTS = `#!/bin/sh
suite=\${1:-all}
echo "> acme-api@1.4.0 test"
echo "> node --test test/ ($suite)"
echo
i=1
while [ $i -le 60 ]; do echo "ok $i - $suite: case $i passes (\${i}ms)"; i=$((i+1)); done
if grep -q FIXED src/auth/token.js; then
  echo "ok 61 - auth: refresh keeps a valid session"
  echo "ok 62 - auth: refresh rotates an expired token"
  echo
  echo "# tests 62"; echo "# pass 62"; echo "# fail 0"
else
  echo "not ok 61 - auth: refresh keeps a valid session"
  echo "  ---"
  echo "  expected: same token"
  echo "  actual:   a new token was issued (isExpired() returned true for a fresh token)"
  echo "  at: test/auth.test.js:88"
  echo "  ..."
  echo "not ok 62 - auth: refresh rotates an expired token"
  echo
  echo "# tests 62"; echo "# pass 60"; echo "# fail 2"
  exit 1
fi
`;

// A 320x120 "error page" screenshot: a red banner with a white panel, built as
// a real PNG so Claude Code reads it as an image.
function makePng(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; } }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const SCREENSHOT_PNG = makePng(320, 120, (x, y) => (y < 34 ? [200, 40, 50] : x > 30 && x < 290 && y > 50 && y < 100 ? [245, 245, 245] : [252, 228, 230]));

export const FILES = {
  'package.json': JSON.stringify({ name: 'acme-api', version: '1.4.0', scripts: { test: 'node --test test/', dev: 'node src/server.js' } }, null, 2),
  'src/auth/token.js': TOKEN_JS,
  'src/auth/session.js': SESSION_JS,
  'src/routes/login.js': LOGIN_JS,
  'src/middleware/cors.js': CORS_JS,
  'logs/server.log': SERVER_LOG,
  'README.md': README,
  'run-tests.sh': RUN_TESTS,
  'docs/error-page.png': SCREENSHOT_PNG,
};

export const PROMPTS = {
  bug: 'The login keeps failing right after a token refresh. Can you find out why?',
  rate: 'Now add rate limiting to the login route: 5 attempts per minute per IP.',
  log: "Check last night's server log for errors.",
  shot: 'Here is what users see when it fails: docs/error-page.png. Anything useful in it?',
  readme: "Update the README's setup section to mention the new rate limit.",
  cleanup: "Free up some context: drop the old test runs and that big server log, I don't need them anymore.",
  slow: 'Summarise everything we changed today for the changelog.',
  access: 'Actually, check the access log for 429s instead.',
  after: 'Write the changelog entry for this release.',
};

const say = (text) => ({ type: 'text', text });
const use = (name, input) => ({ type: 'tool_use', name, input });

// Each turn: what the model does at each step after the prompt.
function turns(PROJ) {
  const p = (f) => path.join(PROJ, f);
  return [
    { match: PROMPTS.bug, steps: [
      () => [say("I'll find where the refresh happens first."), use('Grep', { pattern: 'refresh', path: 'src', output_mode: 'content', '-n': true })],
      () => [use('Read', { file_path: p('src/auth/token.js') })],
      () => [use('Read', { file_path: p('src/auth/session.js') })],
      () => [say('Let me run the auth tests to confirm.'), use('Bash', { command: './run-tests.sh auth', description: 'Run the auth tests' })],
      () => [say('Found it: `isExpired()` compares `expiresAt`, stored in **seconds**, with `Date.now()`, which is in **milliseconds**, so every token looks expired and refresh always rotates it.'),
        use('Edit', { file_path: p('src/auth/token.js'), old_string: '    return Date.now() > this.expiresAt;', new_string: '    return Date.now() > this.expiresAt * 1000; // FIXED: expiresAt is in seconds' })],
      () => [use('Bash', { command: './run-tests.sh auth', description: 'Run the auth tests again' })],
      () => [say('Fixed. `isExpired()` now converts `expiresAt` to milliseconds before comparing, so a fresh token is kept on refresh. All 62 auth tests pass.')],
    ] },
    { match: PROMPTS.rate, steps: [
      () => [say("I'll look at the login route and the existing middleware."), use('Read', { file_path: p('src/routes/login.js') })],
      () => [use('Glob', { pattern: 'src/middleware/*.js' })],
      () => [use('Read', { file_path: p('src/middleware/cors.js') })],
      () => [use('Write', { file_path: p('src/middleware/rateLimit.js'), content: RATE_LIMIT_JS })],
      () => [use('Edit', { file_path: p('src/routes/login.js'), old_string: "router.post('/login', async (req, res) => {", new_string: "const rateLimit = require('../middleware/rateLimit');\n\nrouter.post('/login', rateLimit({ max: 5 }), async (req, res) => {" })],
      () => [use('Bash', { command: './run-tests.sh', description: 'Run the full test suite' })],
      () => [say('Done: `src/middleware/rateLimit.js` allows 5 login attempts per minute per IP, answers 429 with `Retry-After` past that, and sets `X-RateLimit-*` headers. The full suite passes.')],
    ] },
    { match: PROMPTS.log, steps: [
      () => [use('Read', { file_path: p('logs/server.log') })],
      () => [use('Grep', { pattern: 'ERROR', path: 'logs/server.log', output_mode: 'content' })],
      () => [say("Nine errors last night, all the same: `POST /refresh` → 500, `Cannot read properties of undefined (reading 'userId')` in `refreshSession`. That's the expiry bug we just fixed: every refresh rotated the token, and concurrent refreshes raced on the old session key.")],
    ] },
    { match: PROMPTS.shot, steps: [
      () => [use('Read', { file_path: p('docs/error-page.png') })],
      () => [say("It's the generic red error banner, with no request id on it. Worth adding the `req` id to the error page so support can find the log line.")],
    ] },
    { match: PROMPTS.readme, steps: [
      () => [use('Read', { file_path: p('README.md') })],
      () => [use('Edit', { file_path: p('README.md'), old_string: '3. `npm run dev` starts the server on port 8080.', new_string: '3. `npm run dev` starts the server on port 8080.\n4. `POST /login` is rate limited: 5 attempts per minute per IP (429 with `Retry-After` past that).' })],
      () => [say('Added a setup step describing the login rate limit.')],
    ] },
    { match: PROMPTS.cleanup, steps: [
      () => [say("I'll map what's in the context first."), use('ToolSearch', { query: 'select:mcp__ctxtree__map,mcp__ctxtree__stage', max_results: 5 })],
      () => [use('mcp__ctxtree__map', { view: 'type' })],
      ({ result }) => {
        const read = (result.split('\n').find(l => /\] Read\b/.test(l)) || '').match(/\[([^\]]+)\]/);
        return [use('mcp__ctxtree__map', { view: 'type', under: read ? read[1] : 'g:r:Read' })];
      },
      ({ results }) => {
        const all = results.join('\n');
        const bash = (all.split('\n').find(l => /\] Bash\b/.test(l)) || '').match(/\[([^\]]+)\]/);
        const log = (all.split('\n').find(l => l.includes('server.log')) || '').match(/\[([^\]]+)\]/);
        const items = [bash && { id: bash[1], op: 'drop' }, log && { id: log[1], op: 'drop' }].filter(Boolean);
        return [use('mcp__ctxtree__stage', { items })];
      },
      ({ result }) => [say(`I've staged them for you to review: ${result.split('\n')[0].replace(/^Staged /, 'staged ')} Nothing is removed until you apply it: press **2** on the ctxtree band (or run \`/ctxtree review\`), check the list, then **a**.`)],
    ] },
    { match: PROMPTS.access, steps: [
      () => [say('There is no access log in this repo yet; the rate limiter only sets headers. I can add request logging for 429s if you want it.')],
    ] },
    { match: PROMPTS.after, steps: [
      () => [say('**1.4.1**\n- Fix: token refresh kept rotating valid tokens.\n- Add: login rate limit (5/min/IP).\n- Docs: README setup.')],
    ] },
    { match: PROMPTS.slow, steps: [
      () => { const c = [say('**Changelog**\n- Fix: refresh no longer rotates valid tokens (`isExpired()` compared seconds with milliseconds).\n- Add: login rate limit, 5 attempts per minute per IP.\n- Docs: README setup mentions the rate limit.')]; c.delayMs = 9000; return c; },
    ] },
  ];
}

const BRIDGE_ASK = "The user is trimming this conversation's context";
function bridgeReply(text) {
  if (/session\.js/.test(text)) return 'session.js: createSession() issues a token and stores the session; refreshSession() keeps a still-valid token and rotates an expired one (relies on token.isExpired(), fixed in turn 1).';
  if (/server\.log/.test(text)) return 'server.log (Oct 11): 9 errors, all POST /refresh 500 "reading userId" in refreshSession, caused by the expiry bug fixed earlier.';
  return 'Summary kept: the details are no longer needed for the rest of this work.';
}

const textOf = (m) => (typeof m.content === 'string' ? m.content : m.content.filter(b => b.type === 'text').map(b => b.text).join(' '));
const resultsOf = (m) => (typeof m.content === 'string' ? [] : m.content.filter(b => b.type === 'tool_result').map(b => (typeof b.content === 'string' ? b.content : (b.content || []).map(x => x.text || '').join(''))));

export function script(blocks, req, { PROJ }) {
  const msgs = req.messages || [];
  let at = -1, prompt = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'user') continue;
    const t = textOf(msgs[i]).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (t) { at = i; prompt = t; break; }
  }
  if (prompt.includes(BRIDGE_ASK)) return [say(bridgeReply(prompt))];
  const turn = turns(PROJ).find(T => prompt.includes(T.match));
  if (!turn) return null;
  const after = msgs.slice(at + 1);
  const n = after.filter(m => m.role === 'assistant').length;
  const results = after.filter(m => m.role === 'user').flatMap(resultsOf);
  const step = turn.steps[n];
  return step ? step({ result: results[results.length - 1] || '', results }) : null;
}

const SUMMARY = `This session is being continued from a previous conversation. Summary:
1. Fixed the token refresh bug: Token.isExpired() compared expiresAt (seconds) with Date.now() (milliseconds); now multiplies by 1000. All 62 auth tests pass.
2. Added src/middleware/rateLimit.js (5 login attempts per minute per IP, 429 + Retry-After) and wired it into POST /login.
3. README setup section now mentions the login rate limit.
Pending: nothing.`;

export function side(blocks, req) {
  const t = (req.messages || []).map(textOf).join(' ');
  if (t.includes(BRIDGE_ASK)) return [say(bridgeReply(t.slice(t.lastIndexOf(BRIDGE_ASK))))];
  if (/summary of the conversation|detailed summary|summarize the conversation/i.test(t)) return [say(SUMMARY)];
  return null;
}

export const ALLOWED = ['--allowedTools', 'Read,Grep,Glob,Bash,Edit,Write,ToolSearch,mcp__ctxtree__map,mcp__ctxtree__stage,mcp__ctxtree__inspect,mcp__ctxtree__unstage,mcp__ctxtree__restore'];

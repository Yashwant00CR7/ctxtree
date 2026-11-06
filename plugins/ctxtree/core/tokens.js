// Token estimates: per-kind chars-per-token ratios, fitted from measured sessions.

export const KINDS = ['text', 'thinking', 'tool_use', 'tool_result', 'image', 'attach'];
// Physically plausible envelope. A fitted coefficient outside this is evidence
// of a misspecified model, not a discovery about tokenisation.
const MIN_RATIO = 1.8, MAX_RATIO = 6.5;
export const DEFAULT_RATIOS = { text: 3.9, thinking: 3.9, tool_use: 3.2, tool_result: 3.4, image: 1.0, attach: 3.6 };

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Fitted WITH an intercept. Every turn re-injects system reminders that appear
// in no record we count; without a constant term that hidden per-turn overhead
// gets smeared onto the chars we can see and halves every ratio.
function ols(samples, kinds) {
  const n = kinds.length + 1;                       // +1 for the intercept
  const xs = (s, i) => (i === 0 ? 1 : (s.d[kinds[i - 1]] || 0));
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (const s of samples) for (let i = 0; i < n; i++) {
    const xi = xs(s, i);
    if (!xi) continue;
    b[i] += xi * s.y;
    for (let j = 0; j < n; j++) A[i][j] += xi * xs(s, j);
  }
  return solve(A, b);
}

// The free regression is ill-posed here: kinds are collinear, thinking text is
// stripped, and per-turn reinjection is invisible. So priors set the ratios and
// the fit only VALIDATES them -- a fitted value inside the plausible envelope is
// adopted, anything outside is reported and discarded rather than believed.
export function calibrate(samples) {
  const out = { ratios: { ...DEFAULT_RATIOS }, fitted: false, n: 0, kept: [], rejected: [] };
  const candidates = ['text', 'tool_use', 'tool_result', 'attach'];
  const pool = samples.filter(s => s.y > 0 && s.y < 250000 && candidates.some(k => (s.d[k] || 0) > 0));
  out.n = pool.length;
  if (pool.length < 40) return out;

  const kinds = candidates.filter(k => pool.reduce((a, s) => a + (s.d[k] || 0), 0) > 0);
  let beta = ols(pool, kinds);
  if (!beta) return out;

  const predict = (b, s) => {
    let p = b[0];
    for (let i = 0; i < kinds.length; i++) p += b[i + 1] * (s.d[kinds[i]] || 0);
    return p;
  };
  const resid = pool.map(s => Math.abs(s.y - predict(beta, s)));
  const cut = [...resid].sort((a, b) => a - b)[Math.floor(resid.length * 0.9)] ?? Infinity;
  const trimmed = pool.filter((_, i) => resid[i] <= cut);
  const beta2 = ols(trimmed, kinds);
  const use = (beta2 && beta2.every(Number.isFinite)) ? beta2 : beta;

  out.perTurnOverhead = Math.max(0, Math.round(use[0]));
  kinds.forEach((k, i) => {
    const ratio = use[i + 1] > 0 ? 1 / use[i + 1] : null;
    if (ratio && ratio >= MIN_RATIO && ratio <= MAX_RATIO) { out.ratios[k] = ratio; out.kept.push(k); }
    else out.rejected.push({ kind: k, ratio: ratio ? +ratio.toFixed(2) : null });
  });
  let ssRes = 0, ssTot = 0, mean = trimmed.reduce((a, s) => a + s.y, 0) / trimmed.length;
  for (const s of trimmed) { ssRes += (s.y - predict(use, s)) ** 2; ssTot += (s.y - mean) ** 2; }
  out.r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  out.fitted = out.kept.length > 0;
  out.n = trimmed.length;
  return out;
}

// Images cost a roughly fixed amount set by pixel dimensions, NOT by the length
// of their base64 payload. Dividing base64 by a chars/token ratio turned twelve
// screenshots into 5.7M phantom tokens.
export const IMAGE_TOKENS = 1200;
export const tokensOf = (chars, kind, cal) =>
  kind === 'image' ? IMAGE_TOKENS : Math.round(chars / (cal.ratios[kind] || cal.ratios.text || 4.0));

// Per-session truth anchor. We know exactly how many tokens were in context at
// the peak turn; we scale that session's estimates so they agree with it. The
// split between chunks stays proportional; only the absolute level is corrected.
export function fitSession(session, chunks, cal) {
  const T = Math.max(session.turns, 1);
  const at = T - 1;
  let est = 0;
  for (const c of chunks) {
    if (c.cat === 'subcontext' || c.side) continue;
    if (c.turn <= at && at < c.turn + (c.live || 1)) est += tokensOf(c.chars, c.kind, cal);
  }
  const measured = session.peak || 0;
  let scale = 1, quality = 'unmeasured';
  if (measured > 0 && est > 0) {
    scale = measured / est;
    quality = (scale > 0.6 && scale < 1.8) ? 'good' : 'coarse';
    scale = Math.min(Math.max(scale, 0.4), 2.5);
  }
  return { scale, estAtPeak: est, measured, quality };
}

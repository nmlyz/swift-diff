// swift-diff: a fast drop-in for makefun-diff 1.0.0.
//
// Same patch rule as makefun-diff: lines cut after every "\n", a last line
// with no "\n" is a line too; the common prefix, then the common suffix; then
// Myers's greedy search (furthest into the old text on each diagonal, the
// deletion when both reach one point, no move past either text's end, no edge
// pruning, every run of equal lines followed as far as it goes; the first
// path to reach both ends is the script); hunks with 3 kept lines of context
// and runs at most 6 kept lines apart sharing a hunk; a line with no newline
// is written with one and followed by "%".
//
// Speed: lines are hashed to integer ids once (one shared counter, two maps
// so no line string is ever rebuilt), the search runs on typed arrays with no
// per-state allocation, and the V trace lives in one reusable flat buffer, so
// backtracking needs no linked history on any path. The search itself is cut
// down in two exact steps: a banded pass finds an upper bound on the edit
// distance, then the full pass only visits diagonals that can still reach the
// end within that bound (a path of the shortest length always stays inside
// the diamond, so the script it finds is the same one).

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;
const CONTEXT = 3;
const FORMAT = 'makefun-diff/1';
const BAND_W = 96;

/**
 * The V trace's reusable scratch buffer: fully rewritten on every run, never a
 * cached answer. Depth d's block starts at d*d and holds 2d+1 entries.
 */
let traceBuf = null;
let traceCap = 0;

function traceEnsure(cap) {
  if (traceCap >= cap) return traceBuf;
  const nc = traceCap === 0 ? cap : Math.max(cap, traceCap * 2);
  const nt = new Int32Array((nc + 1) * (nc + 1));
  if (traceBuf !== null) nt.set(traceBuf);
  traceBuf = nt;
  traceCap = nc;
  return nt;
}

/**
 * A text's lines (each with its "\n", the last one without when the text does
 * not end in one) and their ids. `mapNL` ids lines ending in "\n", `mapBare`
 * the one last line without, both drawing from the one shared `next` counter,
 * so equal lines share an id and a line with and without its newline do not.
 */
function tokenize(text, mapNL, mapBare, next) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const n = last + (parts[last] !== '' ? 1 : 0);
  const lines = new Array(n);
  const ids = new Int32Array(n);
  for (let i = 0; i < last; i++) {
    const line = parts[i] + '\n';
    lines[i] = line;
    let id = mapNL.get(parts[i]);
    if (id === undefined) { id = next.value++; mapNL.set(parts[i], id); }
    ids[i] = id;
  }
  if (parts[last] !== '') {
    const line = parts[last];
    lines[last] = line;
    let id = mapBare.get(line);
    if (id === undefined) { id = next.value++; mapBare.set(line, id); }
    ids[last] = id;
  }
  return { lines, ids };
}

/**
 * An upper bound on the edit distance of A into B: the shortest script whose
 * diagonal stays in the band from the start diagonal to the end one, widened
 * by BAND_W. -1 when no script stays in the band. Two small arrays only.
 */
function bandedD(A, B) {
  const n = A.length;
  const m = B.length;
  const kf = n - m;
  const lo = (kf < 0 ? kf : 0) - BAND_W;
  const hi = (kf > 0 ? kf : 0) + BAND_W;
  const span = hi - lo + 1;
  let prev = new Int32Array(span + 2).fill(-1);
  let cur = new Int32Array(span + 2).fill(-1);
  let x = 0;
  while (x < n && x < m && A[x] === B[x]) x++;
  if (x === n && x === m) return 0;
  prev[0 - lo + 1] = x;
  for (let d = 1; d <= n + m; d++) {
    let klo = -d > lo ? -d : lo;
    if (((klo - d) & 1) !== 0) klo++;
    const khi = d < hi ? d : hi;
    for (let k = klo, idx = klo - lo + 1; k <= khi; k += 2, idx += 2) {
      const vDel = k > -d && k - 1 >= lo ? prev[idx - 1] : -1;
      const vIns = k < d && k + 1 <= hi ? prev[idx + 1] : -1;
      const vd = vDel >= 0 && vDel < n ? vDel + 1 : -1;
      const vi = vIns >= 0 && vIns - k - 1 < m ? vIns : -1;
      if (vd < 0 && vi < 0) { cur[idx] = -1; continue; }
      let xx = vd >= vi ? vd : vi;
      let yy = xx - k;
      while (xx < n && yy < m && A[xx] === B[yy]) { xx++; yy++; }
      cur[idx] = xx;
      if (xx === n && yy === m) return d;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return -1;
}

/**
 * The forward pass, writing the V trace: for depth d only the diagonals k
 * with d + |k - kf| <= bound are visited (bound Infinity visits them all).
 * Returns [D, K] of the first path to reach both ends, or undefined.
 */
function forward(A, B, tr, bound) {
  const n = A.length;
  const m = B.length;
  const kf = n - m;
  let x = 0;
  while (x < n && x < m && A[x] === B[x]) x++;
  tr[0] = x;
  if (x === n && x === m) return [0, 0, tr];
  for (let d = 1; d <= n + m; d++) {
    if (d > traceCap) tr = traceEnsure(d);
    const base = d * d;
    const pb = (d - 1) * (d - 1);
    const rem = bound - d;
    let klo = -d;
    let khi = d;
    const blo = kf - rem;
    const bhi = kf + rem;
    if (blo > klo) klo = blo;
    if (bhi < khi) khi = bhi;
    if (((klo - d) & 1) !== 0) klo++;
    for (let k = klo, ki = klo + d, pi = klo + d; k <= khi; k += 2, ki += 2, pi += 2) {
      const vDel = k > -d ? tr[pb + pi - 2] : -1;
      const vIns = k < d ? tr[pb + pi] : -1;
      const vd = vDel >= 0 && vDel < n ? vDel + 1 : -1;
      const vi = vIns >= 0 && vIns - k - 1 < m ? vIns : -1;
      if (vd < 0 && vi < 0) { tr[base + ki] = -1; continue; }
      let xx = vd >= vi ? vd : vi;
      let yy = xx - k;
      while (xx < n && yy < m && A[xx] === B[yy]) { xx++; yy++; }
      tr[base + ki] = xx;
      if (xx === n && yy === m) return [d, k, tr];
    }
  }
  return undefined;
}

/**
 * The edit script of A into B (Int32Array views of line ids) as [kind, count]
 * runs in order, by the header's rule. The trace holds, at depth d and
 * diagonal k, the furthest old-line count reached after d edits and its snake
 * (-1: no path).
 */
function editRuns(A, B) {
  const n = A.length;
  const m = B.length;
  let tr = traceEnsure(4096);
  const dw = bandedD(A, B);
  let found = dw < 0 ? undefined : forward(A, B, tr, dw);
  if (found === undefined) found = forward(A, B, traceBuf, Infinity);
  if (found === undefined) throw new Error('swift-diff: the search ended without reaching both ends');
  tr = found[2];
  const D = found[0];
  const K = found[1];

  // Backtrack from (D, K) at (n, m): each step replays the forward choice
  // from the trace's depth d - 1, takes the snake back to where its move
  // landed, then the move.
  const segs = [];
  let x = n;
  let k = K;
  for (let d = D; d >= 1; d--) {
    const pb = (d - 1) * (d - 1);
    const vDel = k > -d ? tr[pb + k + d - 2] : -1;
    const vIns = k < d ? tr[pb + k + d] : -1;
    const vd = vDel >= 0 && vDel < n ? vDel + 1 : -1;
    const vi = vIns >= 0 && vIns - k - 1 < m ? vIns : -1;
    let xs;
    if (vd >= vi) {
      xs = vd;
      if (x > xs) segs.push([KEEP, x - xs]);
      segs.push([DELETE, 1]);
      x = xs - 1;
      k--;
    } else {
      xs = vi;
      if (x > xs) segs.push([KEEP, x - xs]);
      segs.push([INSERT, 1]);
      x = xs;
      k++;
    }
  }
  if (x > 0) segs.push([KEEP, x]);
  const runs = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === s[0]) last[1] += s[1];
    else runs.push([s[0], s[1]]);
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const mapNL = new Map();
  const mapBare = new Map();
  const next = { value: 0 };
  const a = tokenize(input.old, mapNL, mapBare, next);
  const b = tokenize(input.new, mapNL, mapBare, next);
  const ai = a.ids;
  const bi = b.ids;
  const an = ai.length;
  const bn = bi.length;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  const pn = an < bn ? an : bn;
  while (prefix < pn && ai[prefix] === bi[prefix]) prefix++;
  let suffix = 0;
  while (suffix < an - prefix && suffix < bn - prefix && ai[an - 1 - suffix] === bi[bn - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  const tn = an - prefix - suffix;
  const tm = bn - prefix - suffix;
  if (tn > 0 || tm > 0) {
    const er = editRuns(ai.subarray(prefix, prefix + tn), bi.subarray(prefix, prefix + tm));
    for (let i = 0; i < er.length; i++) runs.push(er[i]);
  }
  if (suffix > 0) runs.push([KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r[0] === KEEP) {
      o += r[1];
      p += r[1];
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r[0] === DELETE) {
      c.dels += r[1];
      o += r[1];
      deleted += r[1];
    } else {
      c.ins += r[1];
      p += r[1];
      inserted += r[1];
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const al = a.lines;
  const bl = b.lines;
  const out = [FORMAT + ' old=' + an + ' new=' + bn + ' hunks=' + hunks.length + ' deleted=' + deleted + ' inserted=' + inserted + '\n'];
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi];
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = first.o - CONTEXT > 0 ? first.o - CONTEXT : 0;
    const newStart = first.p - (first.o - oldStart);
    const after = an - (last.o + last.dels) < CONTEXT ? an - (last.o + last.dels) : CONTEXT;
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push('@ ' + (oldStart + 1) + ' ' + (oldEnd - oldStart) + ' ' + (newStart + 1) + ' ' + (newEnd - newStart) + '\n');
    let at = oldStart;
    for (let ci = 0; ci < h.length; ci++) {
      const c = h[ci];
      for (; at < c.o; at++) out.push(written('=', al[at]));
      for (let j = 0; j < c.dels; j++) out.push(written('-', al[c.o + j]));
      for (let j = 0; j < c.ins; j++) out.push(written('+', bl[c.p + j]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', al[at]));
  }
  return out.join('');
}

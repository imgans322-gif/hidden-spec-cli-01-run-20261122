// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements SPEC.md sections 1 to 10: the command line, the
// output and exit codes, safe paths, format detection, unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), JSON edits (section 9), line matching at three tiers (section 5) and the all-or-nothing
// write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- Files as lines (SPEC.md section 3) ----

interface FModel {
  lines: string[];
  br: string;
  fin: boolean;
}

function parseFile(text: string): FModel {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    parts.pop();
  }
  return { lines: parts, br, fin };
}

function serFile(m: FModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

// ---- Matching lines (SPEC.md section 5) ----

const normLine = (s: string, tier: number): string =>
  tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

interface Found {
  tier: number;
  positions: number[];
}

function findTier(fileLines: string[], O: string[], strict: boolean, from = 0, eofOnly = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos: number[] = [];
    const oN = O.map((x) => normLine(x, tier));
    for (let i = from; i + O.length <= fileLines.length; i += 1) {
      if (eofOnly && i + O.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (normLine(fileLines[i + j]!, tier) !== oN[j]) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}

/** The lines N becomes at a match: context lines keep the file's own line; at tier 2 other lines are re-indented. */
function buildN(fileLines: string[], pos: number, O: string[], N: string[], ctx: number[], tier: number): string[] {
  let F = '';
  let P = '';
  if (tier === 2) {
    F = /^[ \t]*/.exec(fileLines[pos] ?? '')![0];
    P = /^[ \t]*/.exec(O[0] ?? '')![0];
  }
  return N.map((n, j) => {
    if (ctx[j] !== undefined && ctx[j]! >= 0) return fileLines[pos + ctx[j]!]!;
    if (tier === 2 && n.replace(/[ \t]/g, '') !== '' && n.startsWith(P)) return F + n.slice(P.length);
    return n;
  });
}

interface BodyEntry {
  t: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  empty: boolean;
}

/** O, N and, for each line of N, the index in O of a context line (-1 when the line is new). */
function bodyON(entries: BodyEntry[]): { O: string[]; N: string[]; ctx: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const ctx: number[] = [];
  for (const e of entries) {
    if (e.t === 'ctx') {
      O.push(e.text);
      N.push(e.text);
      ctx.push(O.length - 1);
    } else if (e.t === 'del') {
      O.push(e.text);
    } else if (e.t === 'add') {
      N.push(e.text);
      ctx.push(-1);
    }
  }
  return { O, N, ctx };
}

/** Whether a `\` line follows the last entry of the given kinds (SPEC.md section 6). */
function bsAfterLast(entries: BodyEntry[], kinds: string[]): boolean {
  let last = -1;
  entries.forEach((e, i) => {
    if (kinds.includes(e.t)) last = i;
  });
  if (last < 0) return false;
  return entries[last + 1]?.t === 'bs';
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  A: number;
  entries: BodyEntry[];
}

interface USection {
  diffOld?: string;
  diffNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  hasPair: boolean;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function headerPath(raw: string): string | null {
  const tab = raw.indexOf('\t');
  const p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function applyHunks(model: FModel, hunks: Hunk[], path: string, strict: boolean): FModel {
  const lines = [...model.lines];
  let fin = model.fin;
  let d = 0;
  for (const h of hunks) {
    const { O, N, ctx } = bodyON(h.entries);
    if (O.length === 0) {
      let pos = h.A + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...N);
      if (atEnd) fin = !bsAfterLast(h.entries, ['ctx', 'add']);
      d += N.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + O.length === lines.length;
      const repl = buildN(lines, best, O, N, ctx, found.tier);
      lines.splice(best, O.length, ...repl);
      if (atEnd) fin = !bsAfterLast(h.entries, ['ctx', 'add']);
      d += N.length - O.length;
    }
  }
  return { lines, br: model.br, fin };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk !== null) {
      while (hunk.entries.length > 0) {
        const last = hunk.entries[hunk.entries.length - 1]!;
        if (last.t === 'ctx' && last.empty) hunk.entries.pop();
        else break;
      }
      hunk = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      const endMark = line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
      const isBody = !endMark && (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\');
      if (isBody) {
        if (line === '') hunk.entries.push({ t: 'ctx', text: '', empty: true });
        else if (line[0] === ' ') hunk.entries.push({ t: 'ctx', text: line.slice(1), empty: false });
        else if (line[0] === '-') hunk.entries.push({ t: 'del', text: line.slice(1), empty: false });
        else if (line[0] === '+') hunk.entries.push({ t: 'add', text: line.slice(1), empty: false });
        else hunk.entries.push({ t: 'bs', text: line.slice(1), empty: false });
        i += 1;
        continue;
      }
      closeHunk();
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1]!, diffNew: m[2]!, hasPair: false, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        const o = headerPath(line.slice(4));
        const n = headerPath(next.slice(4));
        if (cur !== null && !cur.hasPair && cur.hunks.length === 0) {
          cur.pairOld = o;
          cur.pairNew = n;
          cur.hasPair = true;
        } else {
          cur = { pairOld: o, pairNew: n, hasPair: true, newFile: false, delFile: false, hunks: [] };
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { A: Number(m[1]), entries: [] };
      cur.hunks.push(hunk);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  closeHunk();
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  let oldP: string | null | undefined;
  let newP: string | null | undefined;
  if (s.hasPair) {
    oldP = s.pairOld;
    newP = s.pairNew;
  } else if (s.renameFrom !== undefined) {
    oldP = s.renameFrom;
    newP = s.renameTo;
  } else {
    oldP = s.diffOld;
    newP = s.diffNew;
  }
  const hunks = s.hunks;
  return (tree) => {
    if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
    const creation = oldP === null || s.newFile;
    const deletion = newP === null || s.delFile;
    if (creation) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const flat: BodyEntry[] = [];
      const out: string[] = [];
      for (const h of hunks) {
        flat.push(...h.entries);
        for (const e of h.entries) if (e.t === 'add') out.push(e.text);
      }
      const fin = !bsAfterLast(flat, ['add']);
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (deletion) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const n = newP!;
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (o !== n) {
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const res = applyHunks(parseFile(before), hunks, o, strict);
      tree.now.set(n, serFile(res));
      tree.now.set(o, null);
      tree.moves.push([o, n]);
      return;
    }
    const res = applyHunks(parseFile(before), hunks, o, strict);
    tree.now.set(o, serFile(res));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldL: string[];
    newL: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    blocks.push({ path, oldL: lines.slice(i + 1, eq), newL: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => {
    const { path, oldL, newL } = b;
    return (tree: Tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldL.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newL.length === 0 ? '' : `${newL.join('\n')}\n`);
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const model = parseFile(before);
      const found = findTier(model.lines, oldL, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length !== 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const repl = buildN(model.lines, pos, oldL, newL, newL.map(() => -1), found.tier);
      model.lines.splice(pos, oldL.length, ...repl);
      tree.now.set(path, serFile(model));
    };
  });
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor?: string;
  eof: boolean;
  entries: BodyEntry[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  headLine: number;
  addLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    kind: VSection['kind'];
    path: string;
    headLine: number;
    raw: { line: string; no: number }[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (let k = first + 1; k < last; k += 1) {
    const line = lines[k]!;
    let kind: VSection['kind'] | null = null;
    let prefix = '';
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      prefix = '*** Add File:';
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'del';
      prefix = '*** Delete File:';
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      prefix = '*** Update File:';
    }
    if (kind !== null) {
      cur = { kind, path: line.slice(prefix.length).replace(/^ +| +$/g, ''), headLine: k + 1, raw: [] };
      raws.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${k + 1}`);
    }
    cur.raw.push({ line, no: k + 1 });
  }
  const sections: VSection[] = raws.map((r) => {
    const raw = [...r.raw];
    while (raw.length > 0 && raw[raw.length - 1]!.line.trim() === '') raw.pop();
    if (r.kind === 'add') {
      const addLines: string[] = [];
      for (const e of raw) {
        if (e.line.startsWith('+')) addLines.push(e.line.slice(1));
        else if (e.line === '') addLines.push('');
        else throw new Exit2(`error: parse ${e.no}`);
      }
      return { kind: 'add', path: r.path, headLine: r.headLine, addLines, chunks: [] };
    }
    if (r.kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      return { kind: 'del', path: r.path, headLine: r.headLine, addLines: [], chunks: [] };
    }
    let moveTo: string | undefined;
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    raw.forEach((e, idx) => {
      const line = e.line;
      if (idx === 0 && line.startsWith('*** Move to:')) {
        moveTo = line.slice('*** Move to:'.length).replace(/^ +| +$/g, '');
        return;
      }
      if (line.trim() === '*** End of File') {
        if (chunk === null) {
          chunk = { eof: true, entries: [] };
          chunks.push(chunk);
        }
        chunk.eof = true;
        chunk = null;
        return;
      }
      if (line.startsWith('@@')) {
        const anchor = line.slice(2).trim();
        chunk = { anchor: anchor === '' ? undefined : anchor, eof: false, entries: [] };
        chunks.push(chunk);
        return;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
        if (chunk === null) {
          chunk = { eof: false, entries: [] };
          chunks.push(chunk);
        }
        if (line === '') chunk.entries.push({ t: 'ctx', text: '', empty: true });
        else if (line[0] === ' ') chunk.entries.push({ t: 'ctx', text: line.slice(1), empty: false });
        else if (line[0] === '-') chunk.entries.push({ t: 'del', text: line.slice(1), empty: false });
        else chunk.entries.push({ t: 'add', text: line.slice(1), empty: false });
        return;
      }
      throw new Exit2(`error: parse ${e.no}`);
    });
    if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${r.headLine}`);
    return { kind: 'update', path: r.path, headLine: r.headLine, addLines: [], moveTo, chunks };
  });
  return sections.map((s) => v4aEdit(s, strict));
}

function findAnchor(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = normLine(anchor, tier);
    for (let k = from; k < fileLines.length; k += 1) {
      if (normLine(fileLines[k]!, tier) === want) return k;
    }
  }
  return -1;
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, s.addLines.length === 0 ? '' : `${s.addLines.join('\n')}\n`);
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (s.moveTo !== undefined && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (s.moveTo !== undefined && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const model = parseFile(before);
    const fileLines = model.lines;
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== undefined) {
        const at = findAnchor(fileLines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { O, N, ctx } = bodyON(chunk.entries);
      if (O.length === 0) {
        const pos = chunk.eof ? fileLines.length : Math.min(cursor, fileLines.length);
        fileLines.splice(pos, 0, ...N);
        cursor = pos + N.length;
      } else {
        const found = findTier(fileLines, O, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.positions[0]!;
        const repl = buildN(fileLines, pos, O, N, ctx, found.tier);
        fileLines.splice(pos, O.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    if (s.moveTo !== undefined) {
      tree.now.set(s.moveTo, serFile(model));
      tree.now.set(p, null);
      tree.moves.push([p, s.moveTo]);
    } else {
      tree.now.set(p, serFile(model));
    }
  };
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  const seenMove = new Set<string>();
  for (const [o, n] of tree.moves) {
    const mk = `${o}\0${n}`;
    if (seenMove.has(mk)) continue;
    seenMove.add(mk);
    const oWas = tree.original(o);
    const oNow = tree.get(o);
    const nWas = tree.original(n);
    const nNow = tree.get(n);
    if (oWas !== null && oNow === null && nWas === null && nNow !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

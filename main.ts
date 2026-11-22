// mend: one patch tool for every AI edit format.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`
// with the working directory as the root of a tree of text files. It reads a
// patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON
// edits), finds the lines each edit names at the first of three matching
// tiers, and writes every change or none, printing what it changed or why it
// failed. This file implements SPEC.md (version 1) in full.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 line: a usage error, no-patch, format or parse fault. */
class Exit2 {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class EditFail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimEndWs = (s: string): string => s.replace(/\s+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A patch's lines: its text split at \n, each with one trailing \r removed, and without the empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its /-separated segments is empty, . or .. */
function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text split at its own line break, with whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const lines = text.split(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  origCache = new Map<string, string | null>();
  now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p) as string | null;
  }
  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

/** A move a move edit made, for the R line of the output. */
interface MoveInfo {
  oldPath: string;
  newPath: string;
}

type EditFn = (tree: Tree) => MoveInfo | void;

/** One line of an old/new pair: ctx lines belong to both sides. */
interface PairLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position at or after `from` where oldLines match lines at one tier. */
function occurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0 || oldLines.length > lines.length) return out;
  const want = oldLines.map((l) => tierKey(l, tier));
  for (let i = Math.max(0, from); i + oldLines.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < want.length; j += 1) {
      if (tierKey(lines[i + j] as string, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which oldLines occur at or after `from`, and its positions. */
function findTier(lines: string[], oldLines: string[], from: number, strict: boolean): { tier: number; at: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const at = occurrences(lines, oldLines, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const want = tierKey(anchor, tier);
    for (let i = Math.max(0, from); i < lines.length; i += 1) {
      if (tierKey(lines[i] as string, tier) === want) return i;
    }
  }
  return -1;
}

/**
 * The replacement lines for a matched occurrence. A context line is written as
 * the file's own matched line, never the patch's. At tier 2 every other line
 * is re-indented: the leading spaces and tabs of O's first line are replaced
 * by those of the file's first matched line, where the line starts with them.
 */
function buildNew(fileLines: string[], at: number, oldLines: PairLine[], newLines: PairLine[], tier: number): string[] {
  const out: string[] = [];
  const f = leadWs(fileLines[at] as string);
  const p = leadWs(oldLines[0] === undefined ? '' : (oldLines[0] as PairLine).text);
  for (const e of newLines) {
    if (e.ctx) {
      out.push(fileLines[at + e.oIndex] as string);
    } else if (tier === 2) {
      const t = e.text;
      if (t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(e.text);
    }
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk, with its kind. */
interface BodyLine {
  kind: string;
  text: string;
}

function parseBody(body: string[]): BodyLine[] {
  return body.map((l) => {
    if (l === '') return { kind: 'c', text: '' };
    const c = l[0] as string;
    if (c === ' ') return { kind: 'c', text: l.slice(1) };
    if (c === '-') return { kind: 'o', text: l.slice(1) };
    if (c === '+') return { kind: 'n', text: l.slice(1) };
    return { kind: 'b', text: l.slice(1) };
  });
}

/** A body's context and old lines (O) and its context and new lines (N). */
function splitBody(parsed: BodyLine[]): { oldLines: PairLine[]; newLines: PairLine[] } {
  const oldLines: PairLine[] = [];
  const newLines: PairLine[] = [];
  for (const l of parsed) {
    if (l.kind === 'c') {
      const oi = oldLines.length;
      oldLines.push({ text: l.text, ctx: true, oIndex: oi });
      newLines.push({ text: l.text, ctx: true, oIndex: oi });
    } else if (l.kind === 'o') {
      oldLines.push({ text: l.text, ctx: false, oIndex: -1 });
    } else if (l.kind === 'n') {
      newLines.push({ text: l.text, ctx: false, oIndex: -1 });
    }
  }
  return { oldLines, newLines };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function bodyNoEol(parsed: BodyLine[]): boolean {
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const k = (parsed[i] as BodyLine).kind;
    if (k === 'c' || k === 'n') {
      return i + 1 < parsed.length && (parsed[i + 1] as BodyLine).kind === 'b';
    }
  }
  return false;
}

/** Whether a `\` line follows the last `+` line of a section's hunks. */
function sectionNoEol(bodies: BodyLine[][]): boolean {
  for (let h = bodies.length - 1; h >= 0; h -= 1) {
    const body = bodies[h] as BodyLine[];
    for (let i = body.length - 1; i >= 0; i -= 1) {
      if ((body[i] as BodyLine).kind === 'n') {
        return i + 1 < body.length && (body[i + 1] as BodyLine).kind === 'b';
      }
    }
  }
  return false;
}

/** The format of a patch, or null when --format=auto detects none. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => trimEndWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEditObject(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const f = splitFile(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new EditFail('no-match', p);
      const lines = [...f.lines.slice(0, lineNo), ...add, ...f.lines.slice(lineNo)];
      tree.now.set(p, joinFile(lines, f.br, f.finalBreak));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: EditFn[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface UnifiedHunk {
  a: number;
  body: string[];
}

interface UnifiedSection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  pairSet: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UnifiedHunk[];
}

/** The path of a `--- ` or `+++ ` line: the text after the four characters, up to the first tab, trimmed; /dev/null means no file; a leading a/ or b/ is removed. */
function diffPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  const n = lines.length;
  const fresh = (): UnifiedSection => {
    const s: UnifiedSection = {
      diffOld: null, diffNew: null, pairOld: null, pairNew: null, pairSet: false,
      renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < n) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1] as string;
      cur.diffNew = m[2] as string;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.pairSet) cur = fresh();
      cur.pairOld = diffPath(line);
      cur.pairNew = diffPath(lines[i + 1] as string);
      cur.pairSet = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const l = lines[j] as string;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(l);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: parseInt(m[1] as string, 10), body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's text; throws EditFail('no-match', failPath) when a hunk finds nothing. */
function applyUnifiedHunks(text: string, hunks: UnifiedHunk[], strict: boolean, failPath: string): string {
  let state = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const parsed = parseBody(h.body);
    const { oldLines, newLines } = splitBody(parsed);
    if (oldLines.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), state.lines.length);
      const lines = [...state.lines.slice(0, pos), ...newLines.map((e) => e.text), ...state.lines.slice(pos)];
      const touchesEnd = pos === state.lines.length;
      const finalBreak = touchesEnd ? !bodyNoEol(parsed) : state.finalBreak;
      state = { lines, br: state.br, finalBreak };
      d += newLines.length;
    } else {
      const found = findTier(state.lines, oldLines.map((e) => e.text), 0, strict);
      if (found === null) throw new EditFail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.at[0] as number;
      let bestDist = Math.abs(best - target);
      for (const p of found.at) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const built = buildNew(state.lines, best, oldLines, newLines, found.tier);
      const lines = [...state.lines.slice(0, best), ...built, ...state.lines.slice(best + oldLines.length)];
      const touchesEnd = best + oldLines.length === state.lines.length;
      const finalBreak = touchesEnd ? !bodyNoEol(parsed) : state.finalBreak;
      state = { lines, br: state.br, finalBreak };
      d += newLines.length - oldLines.length;
    }
  }
  return joinFile(state.lines, state.br, state.finalBreak);
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): EditFn {
  const oldPath = sec.pairSet ? sec.pairOld : (sec.renameFrom ?? sec.diffOld);
  const newPath = sec.pairSet ? sec.pairNew : (sec.renameTo ?? sec.diffNew);
  if (oldPath === null || sec.newFile) {
    if (newPath === null) return () => {};
    return (tree) => {
      if (!isSafe(newPath)) throw new EditFail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new EditFail('exists', newPath);
      const plus: string[] = [];
      const bodies: BodyLine[][] = [];
      for (const h of sec.hunks) {
        const parsed = parseBody(h.body);
        bodies.push(parsed);
        for (const l of parsed) if (l.kind === 'n') plus.push(l.text);
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (sectionNoEol(bodies) ? '' : '\n'));
    };
  }
  if (newPath === null || sec.deletedFile) {
    return (tree) => {
      if (oldPath === null) return;
      if (!isSafe(oldPath)) throw new EditFail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new EditFail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (oldPath !== newPath) {
    return (tree) => {
      if (!isSafe(oldPath)) throw new EditFail('unsafe', oldPath);
      if (!isSafe(newPath)) throw new EditFail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new EditFail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new EditFail('exists', newPath);
      const after = applyUnifiedHunks(before, sec.hunks, strict, oldPath);
      tree.now.set(newPath, after);
      tree.now.set(oldPath, null);
      return { oldPath, newPath };
    };
  }
  return (tree) => {
    if (!isSafe(oldPath)) throw new EditFail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new EditFail('missing', oldPath);
    tree.now.set(oldPath, applyUnifiedHunks(before, sec.hunks, strict, oldPath));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, 0, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.at.length > 1) throw new EditFail('ambiguous', path);
    const at = found.at[0] as number;
    const old = oldLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const nw = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const built = buildNew(f.lines, at, old, nw, found.tier);
    const lines = [...f.lines.slice(0, at), ...built, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile(lines, f.br, f.finalBreak));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (trimEndWs(lines[i] as string) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j] as string;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let sep = -1;
    let k = i + 1;
    while (k < n) {
      const t = trimEndWs(lines[k] as string);
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      k += 1;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    k = sep + 1;
    while (k < n) {
      if (trimEndWs(lines[k] as string) === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      k += 1;
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(searchReplaceEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4aLine {
  text: string;
  num: number;
}

function v4aAddEdit(path: string, secLines: V4aLine[]): EditFn {
  const fileLines: string[] = [];
  for (const item of secLines) {
    const l = item.text;
    if (l === '') fileLines.push('');
    else if (l[0] === '+') fileLines.push(l.slice(1));
    else throw new Exit2(`error: parse ${item.num}`);
  }
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) !== null) throw new EditFail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string, secLines: V4aLine[]): EditFn {
  if (secLines.length > 0) throw new Exit2(`error: parse ${(secLines[0] as V4aLine).num}`);
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (tree.get(path) === null) throw new EditFail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, secLines: V4aLine[], sectionLine: number, strict: boolean): EditFn {
  let moveTo: string | null = null;
  let rest = secLines;
  if (secLines.length > 0 && (secLines[0] as V4aLine).text.startsWith(V4A_MOVE)) {
    moveTo = (secLines[0] as V4aLine).text.slice(V4A_MOVE.length).trim();
    rest = secLines.slice(1);
  }
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push({ anchor: cur.anchor, eof: cur.eof, body: parseBody(cur.body) });
      cur = null;
    }
  };
  for (const item of rest) {
    const l = item.text;
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${item.num}`);
      cur.eof = true;
      flush();
      continue;
    }
    if (l.startsWith('@@')) {
      flush();
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${item.num}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      (cur as { body: string[] }).body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${item.num}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
  return (tree) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== null) {
      if (!isSafe(moveTo)) throw new EditFail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    }
    let state = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const ai = findAnchor(state.lines, ch.anchor, cursor, strict);
        if (ai < 0) throw new EditFail('no-match', path);
        cursor = ai + 1;
      }
      const { oldLines, newLines } = splitBody(ch.body);
      if (oldLines.length === 0) {
        const pos = ch.eof ? state.lines.length : cursor;
        const lines = [...state.lines.slice(0, pos), ...newLines.map((e) => e.text), ...state.lines.slice(pos)];
        state = { lines, br: state.br, finalBreak: state.finalBreak };
        cursor = pos + newLines.length;
      } else {
        let found: { tier: number; at: number[] } | null = null;
        const maxTier = strict ? 0 : 2;
        for (let tier = 0; tier <= maxTier; tier += 1) {
          let at = occurrences(state.lines, oldLines.map((e) => e.text), tier, cursor);
          if (ch.eof) at = at.filter((p) => p + oldLines.length === state.lines.length);
          if (at.length > 0) {
            found = { tier, at };
            break;
          }
        }
        if (found === null) throw new EditFail('no-match', path);
        const atPos = (found as { at: number[] }).at[0] as number;
        const built = buildNew(state.lines, atPos, oldLines, newLines, (found as { tier: number }).tier);
        const lines = [...state.lines.slice(0, atPos), ...built, ...state.lines.slice(atPos + oldLines.length)];
        state = { lines, br: state.br, finalBreak: state.finalBreak };
        cursor = atPos + newLines.length;
      }
    }
    const after = joinFile(state.lines, state.br, state.finalBreak);
    if (moveTo !== null) {
      tree.now.set(moveTo, after);
      tree.now.set(path, null);
      return { oldPath: path, newPath: moveTo };
    }
    tree.now.set(path, after);
  };
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i] as string)) {
      last = i;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i] as string)) {
      i += 1;
      continue;
    }
    const line = lines[i] as string;
    let kind: string | null = null;
    let path = '';
    if (line.startsWith(V4A_ADD)) {
      kind = 'add';
      path = line.slice(V4A_ADD.length).trim();
    } else if (line.startsWith(V4A_DEL)) {
      kind = 'delete';
      path = line.slice(V4A_DEL.length).trim();
    } else if (line.startsWith(V4A_UPD)) {
      kind = 'update';
      path = line.slice(V4A_UPD.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i + 1;
    const secLines: V4aLine[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j] as string;
      if (l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD)) break;
      secLines.push({ text: l, num: j + 1 });
      j += 1;
    }
    while (secLines.length > 0 && isBlank((secLines[secLines.length - 1] as V4aLine).text)) secLines.pop();
    if (kind === 'add') edits.push(v4aAddEdit(path, secLines));
    else if (kind === 'delete') edits.push(v4aDeleteEdit(path, secLines));
    else edits.push(v4aUpdateEdit(path, secLines, sectionLine, strict));
    i = j;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)    */
/* ------------------------------------------------------------------ */

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
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedSectionEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  const moves: MoveInfo[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== undefined) moves.push(mv);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const sortedPaths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const rows: string[] = [];
  const isRPair = (m: MoveInfo): boolean =>
    tree.original(m.oldPath) !== null && tree.now.get(m.oldPath) === null && tree.original(m.newPath) === null && tree.now.get(m.newPath) !== null;
  for (const p of sortedPaths) {
    const was = tree.original(p);
    const nowV = tree.now.get(p) as string | null;
    if (was === nowV) continue;
    const asNew = moves.find((m) => m.newPath === p);
    if (asNew !== undefined && isRPair(asNew)) {
      rows.push(`R ${asNew.oldPath} -> ${asNew.newPath}`);
      continue;
    }
    if (moves.some((m) => m.oldPath === p && isRPair(m))) continue;
    rows.push(`${was === null ? 'A' : nowV === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) {
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const nowV = tree.now.get(p) as string | null;
      if (was === nowV) continue;
      if (nowV === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, nowV);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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

// mend: apply an edit an AI model wrote to a tree of text files.
//
// The patch comes in one of four shapes — a unified diff (often with wrong
// line numbers), SEARCH/REPLACE blocks, the V4A patch format, or text-editor
// tool calls as JSON — and every file is changed or nothing is. SPEC.md in
// the kit is the contract; this file is a fresh implementation of it.
//
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to stop with an exit-2 line, e.g. `error: parse 3`. Pass the whole line. */
class ParseFault {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by one edit to report its failure; the run collects them all. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` off each, and no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is relative, has no backslash, and no segment is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, for the `R old -> new` output lines. */
  readonly moves: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file broken into lines: its line break, its lines, and whether it ends with a break. */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => trailingWs(s.replace(/^[ \t]+/, ''));

/** Section 5: one line matches at a tier. */
function lineMatches(tier: number, fileLine: string, oldLine: string): boolean {
  if (tier === 0) return fileLine === oldLine;
  if (tier === 1) return trailingWs(fileLine) === trailingWs(oldLine);
  return bothWs(fileLine) === bothWs(oldLine);
}

/** Every position where `old` occurs in `lines` at this tier; occurrences may overlap. */
function occurrencesAt(tier: number, old: string[], lines: string[], from: number, eofOnly: boolean): number[] {
  const at: number[] = [];
  if (old.length === 0) return at;
  for (let i = from; i + old.length <= lines.length; i += 1) {
    if (eofOnly && i + old.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!lineMatches(tier, lines[i + j]!, old[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) at.push(i);
  }
  return at;
}

/** The first tier (0, 1, 2) at which `old` occurs at or after `from`, and its positions; null when none. */
function firstTier(old: string[], lines: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; at: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t += 1) {
    const at = occurrencesAt(t, old, lines, from, eofOnly);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of a replacement: a context line taken from the file, or an added line from the patch. */
type NewItem = { ctx: number } | { add: string };

/**
 * Section 5: build the lines that replace a match. Context lines are the
 * file's own matched lines. At tier 2 every added line that is not empty or
 * only whitespace and starts with the old first line's leading whitespace has
 * that prefix swapped for the file's first matched line's leading whitespace.
 * At other tiers, or with no old lines, added lines are written as they are.
 */
function buildNew(items: NewItem[], fileLines: string[], pos: number, tier: number, oldLines: string[]): string[] {
  let fromWs = '';
  let oldWs = '';
  if (tier === 2 && oldLines.length > 0) {
    fromWs = leadingWs(fileLines[pos]!);
    oldWs = leadingWs(oldLines[0]!);
  }
  const out: string[] = [];
  for (const it of items) {
    if ('ctx' in it) {
      out.push(fileLines[pos + it.ctx]!);
    } else {
      let t = it.add;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(oldWs)) t = fromWs + t.slice(oldWs.length);
      out.push(t);
    }
  }
  return out;
}

/** Section 4: which format an auto patch is, or null when none fits. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  oldLines: string[];
  newItems: NewItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** The hunk has a `+` line at all. */
  hasPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null;
  headNew: string | null;
  renOld: string | null;
  renNew: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to the first tab, spaces removed, one `a/`/`b/` off. Null for `/dev/null`. */
function uniPath(line: string): string | null {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  let p = raw.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

/** Read one hunk body starting at `start`; returns the hunk and the next line after its body. */
function readHunk(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const oldLines: string[] = [];
  const newItems: NewItem[] = [];
  let lastNew = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const l = body[k]!;
    if (l.startsWith(' ')) {
      oldLines.push(l.slice(1));
      newItems.push({ ctx: oldLines.length - 1 });
      lastNew = k;
    } else if (l.startsWith('-')) {
      oldLines.push(l.slice(1));
    } else if (l.startsWith('+')) {
      newItems.push({ add: l.slice(1) });
      lastNew = k;
      lastPlus = k;
    } else if (l === '') {
      oldLines.push('');
      newItems.push({ ctx: oldLines.length - 1 });
      lastNew = k;
    }
    // `\` lines refer to the body line before them and are not part of O or N.
  }
  const noEol = lastNew >= 0 && lastNew + 1 < body.length && body[lastNew + 1]!.startsWith('\\');
  const plusNoEol = lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
  return { hunk: { a, oldLines, newItems, noEol, hasPlus: lastPlus >= 0, plusNoEol }, next: i };
}

/**
 * Apply one hunk to a file's lines, and return how much longer the file got
 * (new lines minus old lines) so the next hunk's line numbers shift by it.
 */
function applyHunk(f: FileLines, h: Hunk, d: number, strict: boolean, path: string): number {
  if (h.oldLines.length > 0) {
    const found = firstTier(h.oldLines, f.lines, 0, strict, false);
    if (found === null) throw new EditFault('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const rep = buildNew(h.newItems, f.lines, pos, found.tier, h.oldLines);
    const toEnd = pos + h.oldLines.length === f.lines.length;
    f.lines.splice(pos, h.oldLines.length, ...rep);
    if (toEnd) f.final = !h.noEol;
    return h.newItems.length - h.oldLines.length;
  }
  const at = Math.max(0, Math.min(h.a + d, f.lines.length));
  const atEnd = at === f.lines.length;
  const rep = buildNew(h.newItems, f.lines, at, -1, h.oldLines);
  f.lines.splice(at, 0, ...rep);
  if (atEnd) f.final = !h.noEol;
  return h.newItems.length;
}

function sectionEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.headOld ?? s.renOld ?? s.diffOld;
  const newP = s.headNew ?? s.renNew ?? s.diffNew;
  const isCreate = s.create || oldP === null;
  const isDelete = !isCreate && (s.remove || newP === null);
  if (isCreate) {
    const p = newP;
    return (tree) => {
      if (p === null) return;
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const it of h.newItems) if ('add' in it) plus.push(it.add);
      let noEol = false;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        if (s.hunks[k]!.hasPlus) {
          noEol = s.hunks[k]!.plusNoEol;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
    };
  }
  if (isDelete) {
    const p = oldP;
    return (tree) => {
      if (p === null) return;
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) === null) throw new EditFault('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return (tree) => {
      if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
      if (!isSafePath(newP)) throw new EditFault('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new EditFault('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFault('exists', newP);
      const f = splitFile(cur);
      let d = 0;
      for (const h of s.hunks) d += applyHunk(f, h, d, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(f));
      tree.moves.push({ from: oldP, to: newP });
    };
  }
  const p = oldP ?? newP;
  return (tree) => {
    if (p === null) return;
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new EditFault('missing', p);
    const f = splitFile(cur);
    let d = 0;
    for (const h of s.hunks) d += applyHunk(f, h, d, strict, p);
    tree.now.set(p, joinFile(f));
  };
}

function readUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHead = false;
  const fresh = (dOld: string | null, dNew: string | null): UniSection => {
    const s: UniSection = { diffOld: dOld, diffNew: dNew, headOld: null, headNew: null, renOld: null, renNew: null, create: false, remove: false, hunks: [] };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      cur = fresh(m[1]!, m[2]!);
      inHead = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      if (cur !== null && inHead) {
        cur.headOld = uniPath(line);
        cur.headNew = uniPath(lines[i + 1]!);
      } else {
        cur = fresh(null, null);
        cur.headOld = uniPath(line);
        cur.headNew = uniPath(lines[i + 1]!);
        inHead = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHead) throw new ParseFault(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      const got = readHunk(lines, i + 1, Number(m[1]));
      cur.hunks.push(got.hunk);
      i = got.next;
      inHead = false;
      continue;
    }
    if (cur !== null && inHead) {
      if (line.startsWith('+++ ')) cur.headNew = uniPath(line);
      else if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    const f = splitFile(cur);
    const found = firstTier(oldLines, f.lines, 0, strict, false);
    if (found === null) throw new EditFault('no-match', path);
    if (found.at.length > 1) throw new EditFault('ambiguous', path);
    const pos = found.at[0]!;
    const items: NewItem[] = newLines.map((t) => ({ add: t }));
    const rep = buildNew(items, f.lines, pos, found.tier, oldLines);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function readSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(`error: parse ${searchAt + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    edits.push(srEdit(path, lines.slice(searchAt + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newItems: NewItem[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

const isV4aBodyLine = (l: string): boolean => l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';

function vChunkFrom(body: Array<{ text: string }>, anchor: string | null, eof: boolean): VChunk {
  const oldLines: string[] = [];
  const newItems: NewItem[] = [];
  for (const b of body) {
    const t = b.text;
    if (t.startsWith(' ')) {
      oldLines.push(t.slice(1));
      newItems.push({ ctx: oldLines.length - 1 });
    } else if (t.startsWith('-')) {
      oldLines.push(t.slice(1));
    } else if (t.startsWith('+')) {
      newItems.push({ add: t.slice(1) });
    } else if (t === '') {
      oldLines.push('');
      newItems.push({ ctx: oldLines.length - 1 });
    }
  }
  return { anchor, eof, oldLines, newItems };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const f = splitFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt = -1;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && foundAt < 0; t += 1) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (lineMatches(t, f.lines[k]!, ch.anchor)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt < 0) throw new EditFault('no-match', path);
        cursor = foundAt + 1;
      }
      if (ch.oldLines.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const rep = buildNew(ch.newItems, f.lines, at, -1, ch.oldLines);
        f.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
      } else {
        const found = firstTier(ch.oldLines, f.lines, cursor, strict, ch.eof);
        if (found === null) throw new EditFault('no-match', path);
        const pos = found.at[0]!;
        const rep = buildNew(ch.newItems, f.lines, pos, found.tier, ch.oldLines);
        f.lines.splice(pos, ch.oldLines.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function readV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(`error: parse ${1}`);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseFault(`error: parse ${i + 1}`);
    }
    const headerAt = i;
    i += 1;
    const raw: Array<{ text: string; at: number }> = [];
    while (i < last && !isV4aSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, at: i });
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new ParseFault(`error: parse ${r.at + 1}`);
      }
      const p = path;
      const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!isSafePath(p)) throw new EditFault('unsafe', p);
        if (tree.get(p) !== null) throw new EditFault('exists', p);
        tree.now.set(p, text);
      });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new ParseFault(`error: parse ${raw[0]!.at + 1}`);
      const p = path;
      edits.push((tree) => {
        if (!isSafePath(p)) throw new EditFault('unsafe', p);
        if (tree.get(p) === null) throw new EditFault('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let j = 0;
      while (j < raw.length && isBlank(raw[j]!.text)) j += 1;
      let moveTo: string | null = null;
      if (j < raw.length && raw[j]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[j]!.text.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const chunks: VChunk[] = [];
      while (j < raw.length) {
        const t = raw[j]!;
        if (isBlank(t.text)) {
          j += 1;
          continue;
        }
        let anchor: string | null = null;
        if (t.text.startsWith('@@')) {
          anchor = t.text.slice(2).trim();
          if (anchor === '') anchor = null;
          j += 1;
        } else if (chunks.length === 0) {
          if (!isV4aBodyLine(t.text)) throw new ParseFault(`error: parse ${t.at + 1}`);
        } else {
          throw new ParseFault(`error: parse ${t.at + 1}`);
        }
        const body: Array<{ text: string }> = [];
        while (j < raw.length) {
          const b = raw[j]!;
          if (b.text === '*** End of File') break;
          if (b.text.startsWith('@@')) break;
          if (!isV4aBodyLine(b.text)) throw new ParseFault(`error: parse ${b.at + 1}`);
          body.push({ text: b.text });
          j += 1;
        }
        while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();
        let eof = false;
        if (j < raw.length && raw[j]!.text === '*** End of File') {
          eof = true;
          j += 1;
        }
        chunks.push(vChunkFrom(body, anchor, eof));
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(`error: parse ${headerAt + 1}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const needFile = (tree: Tree): string => {
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const atLine = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = needFile(tree);
      const f = splitFile(before);
      if (atLine < 0 || atLine > f.lines.length) throw new EditFault('no-match', p);
      f.lines.splice(atLine, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

function readJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(`error: parse ${1}`);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFault(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the exit codes, order and atomicity
// ---------------------------------------------------------------------------

function readPatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'unified') return readUnified(lines, strict);
  if (kind === 'search-replace') return readSearchReplace(lines, strict);
  if (kind === 'v4a') return readV4a(lines, strict);
  return readJson(text, lines);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = readPatch(kind, text, lines, strict);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; text: string }> = [];
  const covered = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.from);
    const nowOld = tree.get(mv.from);
    const wasNew = tree.original(mv.to);
    const nowNew = tree.get(mv.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
      covered.add(mv.from);
      covered.add(mv.to);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (covered.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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

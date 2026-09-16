import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AlignJustify, Check, ChevronDown, ChevronUp, Columns2, Loader2, WrapText, X } from "lucide-react";
import { api, errorMessage } from "../api";
import { useReposStore, type RepoState } from "../store/repos";
import { useUiStore } from "../store/ui";
import type { DiffHunk, DiffLine, FileDiff } from "../types";
import { actions } from "../lib/actions";

/** Character ranges [start, end) of a line that differ from its counterpart. */
type Ranges = [number, number][];

interface SplitRow {
  kind: "hunk" | "context" | "change" | "del" | "add";
  header?: string;
  left: DiffLine | null;
  right: DiffLine | null;
  oldRanges?: Ranges | null;
  newRanges?: Ranges | null;
}

const INLINE_MAX_CHARS = 600;
const INLINE_MAX_TOKENS = 240;

function tokenize(s: string): string[] {
  return s.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/** Marks the tokens of `a` and `b` that are not part of a longest common subsequence. */
function tokenDiff(a: string[], b: string[]): { da: boolean[]; db: boolean[] } {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const da: boolean[] = new Array(n).fill(true);
  const db: boolean[] = new Array(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      da[i] = false;
      db[j] = false;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return { da, db };
}

/**
 * Where a removed line and the added line that replaced it differ. Tokens
 * (words, spaces, punctuation) are matched first, then each changed stretch is
 * narrowed to the characters that really differ. Returns null when there is
 * nothing useful to show (identical lines, or nearly everything changed).
 */
function inlineDiff(oldText: string, newText: string): { old: Ranges; new: Ranges } | null {
  if (oldText.length > INLINE_MAX_CHARS || newText.length > INLINE_MAX_CHARS) return null;
  const minLen = Math.min(oldText.length, newText.length);
  let p = 0;
  while (p < minLen && oldText[p] === newText[p]) p++;
  let sfx = 0;
  while (sfx < minLen - p && oldText[oldText.length - 1 - sfx] === newText[newText.length - 1 - sfx]) sfx++;
  const aEndAll = oldText.length - sfx;
  const bEndAll = newText.length - sfx;
  if (p >= aEndAll && p >= bEndAll) return null;
  const ta = tokenize(oldText.slice(p, aEndAll));
  const tb = tokenize(newText.slice(p, bEndAll));
  const blocks: { aStart: number; aEnd: number; bStart: number; bEnd: number; aTokens: number; bTokens: number }[] = [];
  if (ta.length > INLINE_MAX_TOKENS || tb.length > INLINE_MAX_TOKENS) {
    blocks.push({ aStart: p, aEnd: aEndAll, bStart: p, bEnd: bEndAll, aTokens: 99, bTokens: 99 });
  } else {
    const { da, db } = tokenDiff(ta, tb);
    let i = 0;
    let j = 0;
    let ai = p;
    let bj = p;
    while (i < ta.length || j < tb.length) {
      if (i < ta.length && j < tb.length && !da[i] && !db[j]) {
        ai += ta[i++].length;
        bj += tb[j++].length;
        continue;
      }
      const seg = { aStart: ai, aEnd: ai, bStart: bj, bEnd: bj, aTokens: 0, bTokens: 0 };
      while (i < ta.length && da[i]) {
        ai += ta[i++].length;
        seg.aTokens++;
      }
      while (j < tb.length && db[j]) {
        bj += tb[j++].length;
        seg.bTokens++;
      }
      seg.aEnd = ai;
      seg.bEnd = bj;
      blocks.push(seg);
    }
  }
  // Changes separated by three characters or fewer read better as one block.
  const merged: typeof blocks = [];
  for (const s of blocks) {
    const last = merged[merged.length - 1];
    if (last && s.aStart - last.aEnd <= 3 && s.bStart - last.bEnd <= 3) {
      last.aEnd = s.aEnd;
      last.bEnd = s.bEnd;
      last.aTokens += s.aTokens + 1;
      last.bTokens += s.bTokens + 1;
    } else {
      merged.push({ ...s });
    }
  }
  blocks.length = 0;
  blocks.push(...merged);
  // A single word replaced by a single word is narrowed to the characters that differ.
  for (const s of blocks) {
    if (s.aTokens === 1 && s.bTokens === 1 && s.aEnd > s.aStart && s.bEnd > s.bStart) {
      let k = 0;
      while (s.aStart + k < s.aEnd && s.bStart + k < s.bEnd && oldText[s.aStart + k] === newText[s.bStart + k]) k++;
      s.aStart += k;
      s.bStart += k;
      let t = 0;
      while (s.aEnd - t > s.aStart && s.bEnd - t > s.bStart && oldText[s.aEnd - 1 - t] === newText[s.bEnd - 1 - t]) t++;
      s.aEnd -= t;
      s.bEnd -= t;
    }
  }
  const old: Ranges = blocks.filter((s) => s.aEnd > s.aStart).map((s) => [s.aStart, s.aEnd]);
  const nw: Ranges = blocks.filter((s) => s.bEnd > s.bStart).map((s) => [s.bStart, s.bEnd]);
  const covered = (r: Ranges) => r.reduce((n, [s, e]) => n + (e - s), 0);
  const oldLen = oldText.trim().length || 1;
  const newLen = newText.trim().length || 1;
  if (covered(old) > 0.8 * oldLen && covered(nw) > 0.8 * newLen) return null;
  return { old, new: nw };
}

/** Line text with its differing stretches wrapped in <mark>. */
function Marked({ text, ranges, cls }: { text: string; ranges?: Ranges | null; cls: string }) {
  if (!ranges || ranges.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([s, e], k) => {
    if (s > pos) out.push(text.slice(pos, s));
    out.push(
      <mark key={k} className={cls}>
        {text.slice(s, e)}
      </mark>
    );
    pos = e;
  });
  if (pos < text.length) out.push(text.slice(pos));
  return <>{out}</>;
}

/** Inline ranges for the unified layout, keyed by line. */
function unifiedInline(hunks: DiffHunk[]): Map<DiffLine, Ranges> {
  const map = new Map<DiffLine, Ranges>();
  for (const h of hunks) {
    const lines = h.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === "context") {
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
      if (dels.length === 0 && adds.length === 0) {
        i++;
        continue;
      }
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const r = inlineDiff(dels[k].content, adds[k].content);
        if (r) {
          map.set(dels[k], r.old);
          map.set(adds[k], r.new);
        }
      }
    }
  }
  return map;
}

type BlockKind = "add" | "del" | "mod";

/** A run of consecutive changed rows; `start`/`end` are indices into the rendered rows. */
interface ChangeBlock {
  start: number;
  end: number;
  kind: BlockKind;
}

/** Row index → block index for the first and the last row of every block. */
interface BlockMarks {
  start: Map<number, number>;
  end: Map<number, number>;
}

interface RulerState {
  top: number;
  height: number;
  marks: { top: number; height: number; kind: BlockKind }[];
}

/** Pair deletions with the additions that follow them so both sides line up. */
function buildSplitRows(hunks: DiffHunk[], withHeaders: boolean): SplitRow[] {
  const rows: SplitRow[] = [];
  for (const h of hunks) {
    if (withHeaders) rows.push({ kind: "hunk", header: h.header, left: null, right: null });
    const lines = h.lines;
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (l.kind === "context") {
        rows.push({ kind: "context", left: l, right: l });
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
      if (dels.length === 0 && adds.length === 0) {
        i++;
        continue;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        const left = dels[k] ?? null;
        const right = adds[k] ?? null;
        const inl = left && right ? inlineDiff(left.content, right.content) : null;
        rows.push({ kind: left && right ? "change" : left ? "del" : "add", left, right, oldRanges: inl?.old, newRanges: inl?.new });
      }
    }
  }
  return rows;
}

/** Runs of changed lines in unified order; rows are counted across all hunks. */
function unifiedBlocks(hunks: DiffHunk[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let row = 0;
  for (const h of hunks) {
    let open: ChangeBlock | null = null;
    for (const l of h.lines) {
      if (l.kind === "context") {
        open = null;
      } else {
        const kind: BlockKind = l.kind === "add" ? "add" : "del";
        if (open) {
          open.end = row;
          if (open.kind !== kind) open.kind = "mod";
        } else {
          open = { start: row, end: row, kind };
          blocks.push(open);
        }
      }
      row++;
    }
  }
  return blocks;
}

/** The same runs for the paired rows of the side-by-side layouts. */
function splitBlocks(rows: SplitRow[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = [];
  let open: ChangeBlock | null = null;
  rows.forEach((r, i) => {
    if (r.kind === "context" || r.kind === "hunk") {
      open = null;
      return;
    }
    const kind: BlockKind = r.kind === "change" ? "mod" : r.kind;
    if (open) {
      open.end = i;
      if (open.kind !== kind) open.kind = "mod";
    } else {
      open = { start: i, end: i, kind };
      blocks.push(open);
    }
  });
  return blocks;
}

function markBlocks(blocks: ChangeBlock[]): BlockMarks {
  const start = new Map<number, number>();
  const end = new Map<number, number>();
  blocks.forEach((b, i) => {
    start.set(b.start, i);
    end.set(b.end, i);
  });
  return { start, end };
}

/** Tags the first/last row of a block so DiffView can measure where it sits. */
function blockAttrs(marks: BlockMarks, row: number) {
  return { "data-bs": marks.start.get(row), "data-be": marks.end.get(row) };
}

/**
 * Side by side without soft wrap. One scroller moves both sides vertically so
 * they always line up; each side clips its long lines and scrolls them
 * horizontally on its own, with a single sticky line-number column. A sticky
 * bar at the bottom carries the horizontal scrollbars so they stay in view.
 */
function SplitPanes({ rows, isConflict, marks }: { rows: SplitRow[]; isConflict: boolean; marks: BlockMarks }) {
  const oldPane = useRef<HTMLDivElement>(null);
  const newPane = useRef<HTMLDivElement>(null);
  const oldBar = useRef<HTMLDivElement>(null);
  const newBar = useRef<HTMLDivElement>(null);
  const oldSpacer = useRef<HTMLDivElement>(null);
  const newSpacer = useRef<HTMLDivElement>(null);

  // Mirror one horizontal position to the other side and to both scrollbars.
  // A side that merely ran out of room (shorter lines) never drags the rest back.
  const syncFrom = (src: HTMLDivElement | null) => {
    if (!src) return;
    const atEnd = src.scrollLeft >= src.scrollWidth - src.clientWidth - 1;
    for (const t of [oldPane.current, newPane.current, oldBar.current, newBar.current]) {
      if (!t || t === src) continue;
      if (atEnd && t.scrollLeft > src.scrollLeft) continue;
      if (t.scrollLeft !== src.scrollLeft) t.scrollLeft = src.scrollLeft;
    }
  };

  // The bottom scrollbars get the same scroll range as their side.
  useLayoutEffect(() => {
    const fit = () => {
      if (oldPane.current && oldSpacer.current) oldSpacer.current.style.width = `${oldPane.current.scrollWidth}px`;
      if (newPane.current && newSpacer.current) newSpacer.current.style.width = `${newPane.current.scrollWidth}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (oldPane.current) ro.observe(oldPane.current);
    if (newPane.current) ro.observe(newPane.current);
    return () => ro.disconnect();
  }, [rows]);

  const side = (which: "old" | "new", pane: RefObject<HTMLDivElement | null>) => (
    <div ref={pane} className={`split-pane ${which}`} onScroll={() => syncFrom(pane.current)}>
      <div className="split-side">
        <div className="split-lnos">
          {rows.map((r, i) =>
            r.kind === "hunk" ? (
              <div key={i} className="split-hunk gap" />
            ) : (
              <span key={i} className="ln">
                {(which === "old" ? r.left?.oldLineno : r.right?.newLineno) ?? ""}
              </span>
            )
          )}
        </div>
        <div className="split-lines">
          {rows.map((r, i) => {
            if (r.kind === "hunk") {
              return (
                <div key={i} className="split-hunk">
                  <span>{r.header}</span>
                </div>
              );
            }
            const l = which === "old" ? r.left : r.right;
            const marker = isConflict && r.left && r.left.kind === "del";
            const state = !l ? " empty" : r.kind === "context" ? "" : marker ? " marker" : which === "old" ? " del" : " add";
            return (
              <div key={i} className={`code ${which}${state}`} {...(which === "new" ? blockAttrs(marks, i) : {})}>
                {l ? <Marked text={l.content} ranges={which === "old" ? r.oldRanges : r.newRanges} cls={which === "old" ? "del" : "add"} /> : ""}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
  return (
    <div className="split-panes">
      <div className="split-sides">
        {side("old", oldPane)}
        {side("new", newPane)}
      </div>
      <div className="split-hbar">
        <div ref={oldBar} onScroll={() => syncFrom(oldBar.current)}>
          <div ref={oldSpacer} />
        </div>
        <div ref={newBar} onScroll={() => syncFrom(newBar.current)}>
          <div ref={newSpacer} />
        </div>
      </div>
    </div>
  );
}

function SplitDiff({ rows, isConflict, marks }: { rows: SplitRow[]; isConflict: boolean; marks: BlockMarks }) {
  // One grid for the whole file so both columns stay aligned across rows.
  return (
    <div className="split-diff">
      {rows.map((r, i) => {
        if (r.kind === "hunk") {
          return (
            <div key={i} className="split-hunk">
              <span>{r.header}</span>
            </div>
          );
        }
        const l = r.left;
        const rt = r.right;
        const marker = isConflict && l && l.kind === "del";
        return (
          <div key={i} className={`split-row ${r.kind}`}>
            <span className="ln" {...blockAttrs(marks, i)}>
              {l?.oldLineno ?? ""}
            </span>
            <span className={`code old${l ? (r.kind === "context" ? "" : marker ? " marker" : " del") : " empty"}`}>
              {l ? <Marked text={l.content} ranges={r.oldRanges} cls="del" /> : ""}
            </span>
            <span className="ln">{rt?.newLineno ?? ""}</span>
            <span className={`code new${rt ? (r.kind === "context" ? "" : marker ? " marker" : " add") : " empty"}`}>
              {rt ? <Marked text={rt.content} ranges={r.newRanges} cls="add" /> : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function UnifiedDiff({ diff, marks }: { diff: FileDiff; marks: BlockMarks }) {
  const inline = useMemo(() => unifiedInline(diff.hunks), [diff]);
  let row = 0;
  return (
    <div className="unified-diff">
      {diff.hunks.map((h, hi) => (
        <div key={hi}>
          <div className="hunk-header">{h.header}</div>
          {h.lines.map((l, li) => (
            <div key={li} className={`diff-line ${l.kind}`} {...blockAttrs(marks, row++)}>
              <span className="ln">{l.oldLineno ?? ""}</span>
              <span className="ln">{l.newLineno ?? ""}</span>
              <span className="mark">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
              <span className="code">
                <Marked text={l.content} ranges={inline.get(l)} cls={l.kind === "del" ? "del" : "add"} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Fraction of the viewport kept above a change when jumping to it. */
const REVEAL = 0.3;

export function DiffView({ repo }: { repo: RepoState }) {
  const target = repo.diff!;
  const showDiff = useReposStore((s) => s.showDiff);
  const view = useUiStore((s) => s.diffView);
  const setDiffView = useUiStore((s) => s.setDiffView);
  const wrap = useUiStore((s) => s.diffWrap);
  const setDiffWrap = useUiStore((s) => s.setDiffWrap);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusKey = repo.status ? `${repo.status.staged.length}/${repo.status.unstaged.length}/${repo.refSig}` : "";
  const full = view === "split";
  // Without soft wrap the two sides scroll independently in their own panes.
  const panes = view === "split" && !wrap;
  const isConflict = target.kind === "conflict";
  const showRows = !!diff && !diff.isBinary && diff.hunks.length > 0;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .getDiff(repo.path, { ...target, full })
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [repo.path, target.kind, target.oid, target.path, target.oldPath, full, target.kind === "commit" ? "" : statusKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") showDiff(repo.path, null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [repo.path, showDiff]);

  // ---- change blocks: scrollbar marks and previous/next navigation ----
  const splitRows = useMemo(() => (diff && view === "split" ? buildSplitRows(diff.hunks, diff.hunks.length > 1) : null), [diff, view]);
  const blocks = useMemo(() => (!diff ? [] : splitRows ? splitBlocks(splitRows) : unifiedBlocks(diff.hunks)), [diff, splitRows]);
  const marks = useMemo(() => markBlocks(blocks), [blocks]);
  const outerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const metrics = useRef<{ el: HTMLElement; tops: number[] } | null>(null);
  const [ruler, setRuler] = useState<RulerState | null>(null);
  const [current, setCurrent] = useState(-1);
  const suppressUntil = useRef(0);
  const jumpedFor = useRef("");
  const layoutFor = useRef("");
  const targetKey = `${repo.path}|${target.kind}|${target.oid ?? ""}|${target.path}`;
  const layoutKey = `${view}|${wrap}`;

  /** The element that scrolls vertically in the current layout. */
  const scrollEl = useCallback((): HTMLElement | null => {
    const body = bodyRef.current;
    if (!body) return null;
    return (panes && body.querySelector<HTMLElement>(".split-panes")) || body;
  }, [panes]);

  /** Record where every block sits and lay the marks out along the scrollbar track. */
  const measure = useCallback(() => {
    const el = scrollEl();
    const outer = outerRef.current;
    if (!el || !outer || blocks.length === 0) {
      metrics.current = null;
      setRuler(null);
      return;
    }
    const base = el.getBoundingClientRect().top - el.scrollTop;
    const starts = new Map<string, HTMLElement>();
    el.querySelectorAll<HTMLElement>("[data-bs]").forEach((s) => starts.set(s.dataset.bs ?? "", s));
    const ends = new Map<string, HTMLElement>();
    el.querySelectorAll<HTMLElement>("[data-be]").forEach((s) => ends.set(s.dataset.be ?? "", s));
    const tops: number[] = [];
    const heights: number[] = [];
    blocks.forEach((_, i) => {
      const s = starts.get(String(i));
      const e = ends.get(String(i));
      const top = s ? s.getBoundingClientRect().top - base : 0;
      tops.push(top);
      heights.push(e ? e.getBoundingClientRect().bottom - base - top : 20);
    });
    metrics.current = { el, tops };
    const track = el.clientHeight;
    const total = Math.max(el.scrollHeight, 1);
    setRuler({
      top: el.getBoundingClientRect().top - outer.getBoundingClientRect().top,
      height: track,
      marks: blocks.map((b, i) => ({ kind: b.kind, top: (tops[i] / total) * track, height: Math.max(2, (heights[i] / total) * track) })),
    });
  }, [blocks, scrollEl]);

  const go = useCallback((i: number, behavior: ScrollBehavior) => {
    const m = metrics.current;
    if (!m || m.tops.length === 0) return;
    const idx = Math.min(Math.max(i, 0), m.tops.length - 1);
    const top = Math.max(0, Math.round(m.tops[idx] - m.el.clientHeight * REVEAL));
    // Ignore the scroll events this jump produces so `current` stays what was chosen.
    suppressUntil.current = Date.now() + 800;
    m.el.scrollTo({ top, behavior });
    setCurrent(idx);
  }, []);

  // Once the rows are in the DOM: measure them, jump to the first change of a newly
  // opened file, and keep the current change in view when the layout changes.
  useLayoutEffect(() => {
    measure();
    if (!showRows) {
      setCurrent(-1);
      return;
    }
    if (jumpedFor.current !== targetKey) {
      jumpedFor.current = targetKey;
      layoutFor.current = layoutKey;
      setCurrent(-1);
      go(0, "auto");
    } else if (layoutFor.current !== layoutKey) {
      layoutFor.current = layoutKey;
      go(current, "auto");
    }
  }, [diff, view, wrap]);

  // Follow manual scrolling so previous/next continue from what is on screen.
  useEffect(() => {
    const el = scrollEl();
    if (!el) return;
    const onScroll = () => {
      if (Date.now() < suppressUntil.current) return;
      const m = metrics.current;
      if (!m || m.el !== el) return;
      const reveal = el.scrollTop + el.clientHeight * REVEAL + 2;
      let idx = -1;
      for (let i = 0; i < m.tops.length && m.tops[i] <= reveal; i++) idx = i;
      if (el.scrollTop >= el.scrollHeight - el.clientHeight - 1) idx = m.tops.length - 1;
      setCurrent(idx);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [diff, view, wrap, scrollEl, measure]);

  const close = () => showDiff(repo.path, null);
  const busy = !!repo.busy;
  const kindLabel =
    target.kind === "unstaged" ? "Unstaged changes" : target.kind === "staged" ? "Staged changes" : target.kind === "conflict" ? "Conflicted file" : `Commit ${target.oid?.slice(0, 7)}`;

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
          {kindLabel}
        </span>
        <span className="path" title={target.path}>
          {diff?.oldPath ? `${diff.oldPath} → ` : ""}
          {target.path}
        </span>
        {diff ? (
          <span className="stats">
            <span className="a">+{diff.additions}</span>
            <span className="d">−{diff.deletions}</span>
          </span>
        ) : null}
        {showRows && blocks.length > 0 ? (
          <span className="diff-nav">
            <button className="icon-btn" title="Previous change" disabled={current <= 0} onClick={() => go(current - 1, "smooth")}>
              <ChevronUp />
            </button>
            <span className="count">
              {current + 1}/{blocks.length}
            </span>
            <button className="icon-btn" title="Next change" disabled={current >= blocks.length - 1} onClick={() => go(current + 1, "smooth")}>
              <ChevronDown />
            </button>
          </span>
        ) : null}
        <span className="segmented tiny" title="Diff layout">
          <button className={view === "unified" ? "active" : ""} title="Unified (changed hunks)" onClick={() => setDiffView("unified")}>
            <AlignJustify />
          </button>
          <button className={view === "split" ? "active" : ""} title="Side by side (whole file)" onClick={() => setDiffView("split")}>
            <Columns2 />
          </button>
        </span>
        <span className="segmented tiny" title="Line wrapping">
          <button className={wrap ? "active" : ""} title={wrap ? "Soft wrap is on (click to scroll long lines instead)" : "Soft wrap is off (click to wrap long lines)"} onClick={() => setDiffWrap(!wrap)}>
            <WrapText />
          </button>
        </span>
        {isConflict ? (
          <>
            <button className="btn small" disabled={busy} onClick={() => void actions.resolveConflict(repo.path, target.path, "ours")}>
              Take ours
            </button>
            <button className="btn small" disabled={busy} onClick={() => void actions.resolveConflict(repo.path, target.path, "theirs")}>
              Take theirs
            </button>
            <button className="btn small primary" disabled={busy} onClick={() => void actions.markResolved(repo.path, [target.path])}>
              <Check /> Mark resolved
            </button>
          </>
        ) : null}
        <button className="icon-btn" title="Close (Esc)" onClick={close}>
          <X />
        </button>
      </div>
      <div ref={outerRef} className="diff-scroll">
        <div ref={bodyRef} className={`diff-body ${wrap ? "wrap" : "nowrap"}${panes ? " panes" : ""}`}>
          {diff?.note ? <div className="diff-note">{diff.note}</div> : null}
          {error ? <div className="diff-empty" style={{ color: "var(--danger)" }}>{error}</div> : null}
          {!diff && !error ? (
            <div className="diff-empty">
              <Loader2 className="spin" size={16} /> Loading diff…
            </div>
          ) : null}
          {diff?.isBinary ? <div className="diff-empty">Binary file. No text diff available.</div> : null}
          {diff && !diff.isBinary && diff.hunks.length === 0 && !error ? <div className="diff-empty">No changes to display.</div> : null}
          {diff && showRows ? (
            !splitRows ? (
              <UnifiedDiff diff={diff} marks={marks} />
            ) : wrap ? (
              <SplitDiff rows={splitRows} isConflict={isConflict} marks={marks} />
            ) : (
              <SplitPanes rows={splitRows} isConflict={isConflict} marks={marks} />
            )
          ) : null}
        </div>
        {ruler ? (
          <div className="diff-ruler" style={{ top: ruler.top, height: ruler.height }}>
            {ruler.marks.map((m, i) => (
              <i key={i} className={m.kind} style={{ top: m.top, height: m.height }} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ListSelect — the shared, keyboard-driven list used by every devkit screen.
//
// Built on <box>/<text> + useKeyboard (rather than the built-in <select>) so we
// control row columns, multi-select marking, and colors. Supports:
//   - arrows or j/k to move, with wrap-around
//   - "/" to filter (type to narrow, Backspace to edit, Esc to clear)
//   - Space / Tab to toggle a mark (when `multiSelect`)
//   - "v" visual range: anchor at the cursor, sweep with j/k, "v" again to leave
//     (commit) the swept rows; Esc cancels the sweep (when `multiSelect`)
//   - Enter to submit (effective selection if any, otherwise the highlighted row)
//   - q to cancel; Esc peels back one step at a time — clear filter, then cancel
//     a visual sweep, then clear the selection — and only then a second Esc exits
//     (the first shows a "press again" hint)
//   - optional section headers via `sectionOf` (purely decorative — navigation is
//     unaffected, headers are derived from the already-sorted items)
// Pass `active={false}` to make it ignore keys (e.g. while a confirm/help shows).
//
// VIEWPORT: the window is "scroll-into-view", never cursor-centering. `start`
// holds still and only moves when the cursor actually leaves the window (then by
// the minimum, one row). So clicking a visible row, hovering, or an auto-refresh
// never shift the list — it only scrolls when you wheel, or step off an edge with
// j/k. (Centering the cursor was the old layout-shift: every cursor change, even
// a click mid-list, re-centered the window and pulled in a row.)
//
// MOUSE: hover is purely visual — it tints the row under the pointer (`hoverBg`,
// a subtler background than the selected row's `selBg`) and does NOT move the
// cursor or the viewport, so it can never scroll the list. A SINGLE click moves
// the cursor and activates the row (equivalent to Enter on it) — there is no
// double-click. The wheel moves the cursor. Hover/selection are both backgrounds
// on the row <box> — they repaint existing cells, so the row never changes height.
// A non-selectable row (isSelectable === false) takes neither: it doesn't tint on
// hover and a click on it does nothing, so it can't masquerade as clickable.
//
// NOTE: because a click activates, there is no longer a "click to just highlight"
// gesture. Screens whose keys act on the highlighted row (launch's e/d/a/p) are
// keyboard-driven for that; a click there runs the row instead.
//
// SELECTION: the list's subtree is marked non-selectable (see the effect below) so
// clicking a row doesn't also start OpenTUI's drag text-selection. That's scoped to
// the list only — text elsewhere on a screen stays selectable and drag-copyable.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import type { BoxRenderable, Renderable } from "@opentui/core";
import { useTheme, useThemeControls } from "../theme-context";

// Drop control chars (incl. CR/LF/Esc) from typed/pasted filter text.
const printable = (s: string) => s.replace(/[\x00-\x1f]/g, "");

/**
 * Scroll-into-view: where the visible window should start, given where it started
 * last render. The window holds still unless the cursor has stepped outside it,
 * and then moves by the minimum needed to bring the cursor back into view (one
 * row when stepping off an edge). It is NOT re-centered on the cursor — that's
 * what made the list shift a row every time the cursor moved (a click mid-list
 * pulled in a row from the bottom).
 */
export function windowStart(prev: number, cur: number, total: number, maxVisible: number): number {
  let start = Math.min(Math.max(0, prev), Math.max(0, total - maxVisible));
  if (cur < start) start = cur; // stepped above the window
  else if (cur >= start + maxVisible) start = cur - maxVisible + 1; // stepped below it
  return start;
}

/** Imperative controls a parent can hold via the `controlRef` prop. */
export interface ListSelectHandle {
  /** Move the cursor (and viewport, via scroll-into-view) to the item with this
   *  key. No-op when the key isn't in the current (filtered) list. */
  jumpTo: (key: string) => void;
}

export interface ListSelectProps<T> {
  items: T[];
  getKey: (item: T) => string;
  renderRow: (item: T, state: { selected: boolean; marked: boolean }) => ReactNode;
  /** Text matched against the "/" filter query. Defaults to getKey. */
  filterText?: (item: T) => string;
  /** Whether a row may be marked/submitted. Defaults to always true. */
  isSelectable?: (item: T) => boolean;
  multiSelect?: boolean;
  /** Keys to pre-mark when the list first mounts (multiSelect only). */
  initialMarked?: string[];
  /**
   * When true, a lone Esc cancels immediately (go back) in a single press — no
   * peel of a sweep/selection and no "press again" confirmation. Use on
   * transient picker screens where Esc means "go back one step".
   */
  immediateCancel?: boolean;
  active?: boolean;
  onSubmit: (items: T[]) => void;
  onCancel?: () => void;
  /** Called for un-handled keys when not filtering (e.g. "r", "a"). */
  onExtraKey?: (name: string, current: T | null) => void;
  /** Section id for an item; when set, a dim header is drawn at group boundaries. */
  sectionOf?: (item: T) => string;
  /** Header text for a section (defaults to the id + count). */
  sectionLabel?: (sectionId: string, count: number) => string;
  /** Notified when the user is mid-interaction (filtering or a visual sweep). */
  onInteractingChange?: (busy: boolean) => void;
  /** Enables [ / ] to move the highlighted row up / down. Called with the row and
   *  direction; the list advances the cursor in lockstep so the highlight stays
   *  on the moved row. Confined to a section when `sectionOf` is set. */
  onReorder?: (item: T, dir: -1 | 1) => void;
  emptyText?: string;
  /** Max rows to show at once; defaults to terminal height minus chrome. */
  maxVisible?: number;
  /** Receives imperative controls (jumpTo) — a plain ref object, assigned on
   *  every render (avoids forwardRef's poor ergonomics with generics). */
  controlRef?: { current: ListSelectHandle | null };
}

export function ListSelect<T>(props: ListSelectProps<T>) {
  const {
    items,
    getKey,
    renderRow,
    filterText = getKey,
    isSelectable = () => true,
    multiSelect = false,
    initialMarked,
    immediateCancel = false,
    onReorder,
    active = true,
    onSubmit,
    onCancel,
    onExtraKey,
    sectionOf,
    sectionLabel,
    onInteractingChange,
    emptyText = "(nothing to show)",
    controlRef,
  } = props;

  const theme = useTheme();
  const { cycle: cycleTheme } = useThemeControls();

  // The list's rows are interactive CONTROLS, not prose — a click on one is an
  // action. But OpenTUI hit-tests the topmost renderable on left mouse-down and
  // starts a drag text-selection if it's `selectable`, and TextRenderable defaults
  // to selectable:true (BoxRenderable is false). So a click landed on the row's
  // <text> and smeared a selection highlight across it.
  //
  // Fix it the way a GUI does — `user-select: none` on the control, not on the whole
  // app: mark only THIS subtree non-selectable. Text outside the list (headers,
  // hints, the help page, streamed logs) stays selectable, so drag-to-copy still
  // works there. Doing it here rather than via a `selectable={false}` prop keeps it
  // out of every screen's renderRow. No dep array: rows are rebuilt on filter /
  // refresh / re-sort, and new renderables default back to selectable.
  const listRef = useRef<BoxRenderable | null>(null);
  useEffect(() => {
    const deselect = (r: Renderable) => {
      r.selectable = false;
      for (const child of r.getChildren()) deselect(child);
    };
    if (listRef.current) deselect(listRef.current);
  });

  const [cursor, setCursor] = useState(0);
  // Row under the pointer. Purely cosmetic (underline) — deliberately NOT tied to
  // `cursor`, so moving the mouse can never move the highlight or scroll the list.
  const [hovered, setHovered] = useState<number | null>(null);
  const [marked, setMarked] = useState<Set<string>>(() => new Set(initialMarked ?? []));
  const [anchor, setAnchor] = useState<number | null>(null);
  const [filtering, setFiltering] = useState(false);
  const [query, setQuery] = useState("");
  const [escArmed, setEscArmed] = useState(false); // first Esc arms, second exits

  // Auto-disarm the "press Esc again" prompt after a short window.
  const escTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armEsc = () => {
    setEscArmed(true);
    if (escTimer.current) clearTimeout(escTimer.current);
    escTimer.current = setTimeout(() => setEscArmed(false), 2000);
  };
  const disarmEsc = () => {
    if (escTimer.current) clearTimeout(escTimer.current);
    escTimer.current = null;
    setEscArmed(false);
  };
  useEffect(() => () => disarmEsc(), []); // clear timer on unmount

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => filterText(it).toLowerCase().includes(q));
  }, [items, query, filterText]);

  const cur = Math.min(cursor, Math.max(0, filtered.length - 1));

  // Keys swept by the active visual range (anchor..cursor, inclusive).
  const rangeKeys = (a: number | null, c: number, list: T[]): string[] => {
    if (a === null) return [];
    const lo = Math.min(a, c);
    const hi = Math.max(a, c);
    const keys: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const it = list[i];
      if (it && isSelectable(it)) keys.push(getKey(it));
    }
    return keys;
  };

  // marks ∪ visual range — what the indicator shows and what Enter submits.
  const effective = useMemo(() => {
    const set = new Set(marked);
    for (const k of rangeKeys(anchor, cur, filtered)) set.add(k);
    return set;
  }, [marked, anchor, cur, filtered]);

  // Mirror derived state so the keyboard handler always reads fresh values.
  const ref = useRef({ filtered, cur, filtering, anchor, marked, escArmed });
  ref.current = { filtered, cur, filtering, anchor, marked, escArmed };

  // Imperative controls for the parent (e.g. clean's `g` jumping the cursor to
  // the GLOBALS section). Reassigned each render so it closes over fresh state.
  if (controlRef) {
    controlRef.current = {
      jumpTo: (key: string) => {
        const idx = ref.current.filtered.findIndex((it) => getKey(it) === key);
        if (idx >= 0) setCursor(idx);
      },
    };
  }

  // Let the parent pause things (e.g. auto-refresh) while the user is filtering
  // or mid visual-sweep, so the list doesn't shift under them.
  const interacting = filtering || anchor !== null;
  useEffect(() => {
    onInteractingChange?.(interacting);
  }, [interacting]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop marks whose row no longer exists (after a kill, refresh, or filter).
  useEffect(() => {
    setMarked((prev) => {
      if (prev.size === 0) return prev;
      const keys = new Set(items.map(getKey));
      const next = new Set<string>();
      for (const k of prev) if (keys.has(k)) next.add(k);
      return next.size === prev.size ? prev : next;
    });
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (delta: number) => {
    const n = ref.current.filtered.length;
    if (!n) return;
    let i = (ref.current.cur + delta) % n;
    if (i < 0) i += n;
    setCursor(i);
  };

  // Mouse: the wheel moves the cursor (clamped, no wrap); a single click activates
  // a row (see clickRow).
  const scrollBy = (delta: number) => {
    const n = ref.current.filtered.length;
    if (!n) return;
    setCursor((c) => Math.max(0, Math.min(n - 1, c + delta)));
  };
  // A single click activates the row (same as moving to it and pressing Enter) —
  // there is no double-click. The highlight moves first so the row you acted on is
  // the one left selected.
  const clickRow = (idx: number) => {
    // A non-selectable row (e.g. a protected system process in killport) is inert:
    // clicking it must not move the highlight either, or it would look picked and
    // then do nothing.
    const item = ref.current.filtered[idx];
    if (!item || !isSelectable(item)) return;
    setCursor(idx);
    onSubmit([item]);
  };

  const toggleMark = () => {
    const item = ref.current.filtered[ref.current.cur];
    if (!item || !isSelectable(item)) return;
    const k = getKey(item);
    setMarked((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });
  };

  // "v": start a sweep, or leave it (committing the swept rows to marks).
  const toggleVisual = () => {
    const { anchor: a, cur: c, filtered: list } = ref.current;
    if (a === null) {
      setAnchor(c);
      return;
    }
    const sweep = rangeKeys(a, c, list);
    setMarked((prev) => new Set([...prev, ...sweep]));
    setAnchor(null);
  };

  // "[" / "]": ask the parent to move the highlighted row up/down, and advance
  // the cursor in lockstep so the highlight stays on it. Won't cross a section
  // boundary (when sectionOf is set). The parent persists; we just move the view.
  const reorder = (dir: -1 | 1) => {
    if (!onReorder) return;
    const { filtered: list, cur: c } = ref.current;
    const j = c + dir;
    const a = list[c];
    const b = list[j];
    if (!a || !b) return;
    if (sectionOf && sectionOf(a) !== sectionOf(b)) return;
    onReorder(a, dir);
    setCursor(j);
  };

  const submit = () => {
    const { filtered: list, cur: c, anchor: a, marked: m } = ref.current;
    if (multiSelect) {
      const eff = new Set(m);
      for (const k of rangeKeys(a, c, list)) eff.add(k);
      if (eff.size) {
        const picked = items.filter((it) => eff.has(getKey(it)) && isSelectable(it));
        if (picked.length) onSubmit(picked);
        return;
      }
    }
    const item = list[c];
    if (item && isSelectable(item)) onSubmit([item]);
  };

  // Pasting (bracketed paste) goes into the filter query while filtering.
  usePaste((event) => {
    if (!active || !ref.current.filtering) return;
    const text = printable(new TextDecoder().decode(event.bytes));
    if (text) {
      setQuery((q) => q + text);
      setCursor(0);
    }
  });

  useKeyboard((key) => {
    if (!active) return;

    // Any key other than Esc cancels a pending "press Esc again to exit".
    if (key.name !== "escape" && ref.current.escArmed) disarmEsc();

    if (ref.current.filtering) {
      if (key.name === "escape") {
        setFiltering(false);
        setQuery("");
        setCursor(0);
      } else if (key.name === "return") {
        submit();
      } else if (key.name === "backspace") {
        setQuery((q) => q.slice(0, -1));
        setCursor(0);
      } else if (key.name === "up") {
        move(-1);
      } else if (key.name === "down") {
        move(1);
      } else {
        // A single char, or a paste delivered as one key chunk. Reject escape
        // sequences (special keys) — they always contain an Esc byte.
        const ch = key.sequence;
        if (ch && !key.ctrl && !key.meta && !ch.includes("\x1b")) {
          const text = printable(ch);
          if (text) {
            setQuery((q) => q + text);
            setCursor(0);
          }
        }
      }
      return;
    }

    switch (key.name) {
      case "up":
      case "k":
        move(-1);
        break;
      case "down":
      case "j":
        move(1);
        break;
      case "return":
        submit();
        break;
      case "space":
      case "tab":
        if (multiSelect) toggleMark();
        break;
      case "v":
        if (multiSelect) toggleVisual();
        break;
      case "[":
        if (onReorder) reorder(-1);
        else onExtraKey?.(key.name, ref.current.filtered[ref.current.cur] ?? null);
        break;
      case "]":
        if (onReorder) reorder(1);
        else onExtraKey?.(key.name, ref.current.filtered[ref.current.cur] ?? null);
        break;
      case "/":
        setFiltering(true);
        setQuery("");
        setCursor(0);
        break;
      case "escape":
        if (immediateCancel) {
          // Transient picker: Esc goes back in a single press, no prompt.
          onCancel?.();
        } else if (ref.current.anchor !== null) {
          // Esc peels back state one step at a time: cancel a visual sweep, then
          // clear the selection, and only once nothing is selected does a second
          // Esc exit (the first arms the "press again" prompt).
          setAnchor(null);
        } else if (ref.current.marked.size > 0) {
          setMarked(new Set());
          disarmEsc();
        } else if (ref.current.escArmed) onCancel?.();
        else armEsc();
        break;
      case "q":
        onCancel?.();
        break;
      case "t":
        cycleTheme();
        break;
      default:
        onExtraKey?.(key.name, ref.current.filtered[ref.current.cur] ?? null);
    }
  });

  // Per-section counts across the whole filtered list (for header labels).
  const sectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (sectionOf) {
      for (const it of filtered) {
        const s = sectionOf(it);
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
    return counts;
  }, [filtered, sectionOf]);

  const headerFor = (id: string) =>
    sectionLabel ? sectionLabel(id, sectionCounts.get(id) ?? 0) : `${id} (${sectionCounts.get(id) ?? 0})`;

  // Viewport windowing: scroll-into-view, NOT cursor-centering. `start` persists
  // across renders and only budges when the cursor steps outside the window — and
  // then by exactly one row. A click on a visible row, a hover, or an auto-refresh
  // leaves the window untouched (no layout shift); it scrolls only when you wheel
  // or walk off an edge with j/k.
  const { height } = useTerminalDimensions();
  const maxVisible = Math.max(3, props.maxVisible ?? height - 11);
  const total = filtered.length;
  const startRef = useRef(0);
  const start = windowStart(startRef.current, cur, total, maxVisible);
  startRef.current = start;
  const visible = filtered.slice(start, start + maxVisible);

  const selectedCount = effective.size;

  return (
    <box
      ref={listRef}
      style={{ flexDirection: "column" }}
      onMouseScroll={(e) => {
        if (!active) return;
        const dir = e.scroll?.direction;
        if (dir === "up") scrollBy(-1);
        else if (dir === "down") scrollBy(1);
      }}
    >
      {filtering ? (
        <text>
          <span fg={theme.accent}>/ </span>
          {query}
          <span fg={theme.dim}>_</span>
        </text>
      ) : null}

      {multiSelect && (selectedCount > 0 || anchor !== null) ? (
        <text>
          <span fg={theme.green}>{`* ${selectedCount} selected`}</span>
          {anchor !== null ? <span fg={theme.yellow}>{"   VISUAL - v to keep, Esc to cancel"}</span> : null}
        </text>
      ) : null}

      {total === 0 ? <text fg={theme.dim}>{emptyText}</text> : null}
      {start > 0 ? <text fg={theme.dim}>{`  ^ ${start} more`}</text> : null}

      {visible.map((item, i) => {
        const idx = start + i;
        const selected = idx === cur;
        const k = getKey(item);
        const isMarked = effective.has(k);
        // A non-selectable row (killport's protected system processes) must never
        // take the hover affordance — lighting it up read as "clickable", but the
        // click then did nothing. Inert rows stay inert-looking.
        const selectable = isSelectable(item);
        const isHovered = idx === hovered && selectable;
        const prev = i > 0 ? visible[i - 1] : undefined;
        const section = sectionOf?.(item);
        const showHeader =
          section !== undefined && (prev === undefined || sectionOf?.(prev) !== section);
        return (
          <box key={k} style={{ flexDirection: "column" }}>
            {showHeader ? (
              <text fg={theme.accentDim}>{headerFor(section!)}</text>
            ) : null}
            <box
              style={{
                flexDirection: "row",
                // Selection (cursor/click) wins over hover. Both are backgrounds on
                // this box: they repaint existing cells, so neither changes the row's
                // height — no layout shift as the pointer moves. (A bottom `border`
                // would look like an underline but costs a whole extra row.)
                backgroundColor: selected
                  ? theme.selBg
                  : isHovered
                    ? theme.hoverBg
                    : undefined,
              }}
              onMouseDown={() => {
                if (active) clickRow(idx);
              }}
              onMouseOver={() => {
                // Visual only: never moves the cursor, so the viewport can't shift
                // while the pointer drifts. Non-selectable rows take no hover.
                if (active) setHovered(selectable ? idx : null);
              }}
              onMouseOut={() => {
                if (active) setHovered((h) => (h === idx ? null : h));
              }}
            >
              <text fg={selected ? theme.accent : theme.dim}>{selected ? "> " : "  "}</text>
              {multiSelect ? (
                <text fg={isMarked ? theme.green : theme.dim}>{isMarked ? "* " : "- "}</text>
              ) : null}
              {renderRow(item, { selected, marked: isMarked })}
            </box>
          </box>
        );
      })}

      {start + maxVisible < total ? (
        <text fg={theme.dim}>{`  v ${total - start - maxVisible} more`}</text>
      ) : null}

      {escArmed ? <text fg={theme.yellow}>Press Esc again to exit</text> : null}
    </box>
  );
}

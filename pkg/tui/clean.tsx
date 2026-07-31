#!/usr/bin/env bun
// clean - reclaim disk space: build artifacts across all your projects, plus
// globally installed packages.
//
//   clean              scan + report (dry-run by default: NOTHING is deleted
//                      until you mark rows and confirm)
//   clean --globals    also list globally installed packages up front
//
// Artifacts (node_modules, dist, .next, target, ...) are found under the shared
// scan roots (the same folders `launch` scans; manage them there with `s`).
// Sizes fill in progressively - big trees are walked in the background.
// Projects with a live dev server (a listening process working inside them)
// are marked "(in use)" and can't be selected.
//
// UI logic only; discovery/sizing/deletion lives in pkg/core/clean.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { mountScreen } from "./app";
import { useTheme } from "./theme-context";
import { Header, Confirm, ListSelect, Help, type Binding, type ListSelectHandle } from "./components";
import {
  scanArtifacts,
  sizeDir,
  artifactKey,
  globalKey,
  validCachedSizes,
  updateSizeCache,
  evictSizeCache,
  inUseCwds,
  markProtected,
  deleteArtifact,
  listGlobals,
  removeGlobal,
  fmtBytes,
  fmtAge,
  type Artifact,
  type GlobalPkg,
} from "../core/clean";
import type { ScanRoot } from "../core/launch";
import { detectPm } from "../core/manifest";

const HELP: Binding[] = [
  { keys: "j / k", desc: "move (or arrow keys)" },
  { keys: "space / tab", desc: "mark the highlighted row" },
  { keys: "v", desc: "visual range - v, sweep with j/k, v again to keep" },
  { keys: "enter", desc: "delete the marked rows (asks to confirm first)" },
  { keys: "/", desc: "filter by project, kind, or package name" },
  { keys: "g", desc: "show globals + jump to them / hide them again" },
  { keys: "s", desc: "toggle sort: size <-> name" },
  { keys: "u", desc: "re-measure the highlighted row's size" },
  { keys: "r", desc: "refresh everything: rescan folders + re-measure all sizes" },
  { keys: "t", desc: "cycle color theme" },
  { keys: "q / esc esc", desc: "quit (q, or Esc twice)" },
];

type Row =
  | { rowType: "artifact"; art: Artifact }
  | { rowType: "global"; pkg: GlobalPkg };

const rowKey = (r: Row) => (r.rowType === "artifact" ? r.art.path : `${r.pkg.manager}:${r.pkg.name}`);

/** A project we should offer to reinstall after its node_modules was deleted. */
export interface ReinstallPlan {
  dir: string;
  pm: string;
}

// Column widths (killport-style): KIND/SIZE/AGE fixed, PROJECT flexes.
const COL = { kind: 14, size: 10, age: 10 };
const fit = (s: string, w: number) => {
  if (s.length <= w - 1) return s.padEnd(w);
  return (s.slice(0, Math.max(0, w - 4)) + "...").padEnd(w);
};

function ArtifactRow({
  a,
  size,
  selected,
  projWidth,
}: {
  a: Artifact;
  size: number | undefined;
  selected: boolean;
  projWidth: number;
}) {
  const theme = useTheme();
  if (a.protected) {
    return (
      <text fg={theme.dim}>
        {fit(a.kind, COL.kind) + fit(`${a.project} (in use)`, projWidth) + fit(fmtBytes(size), COL.size) + fmtAge(a.mtimeMs)}
      </text>
    );
  }
  return (
    <text>
      <span fg={theme.accent}>{fit(a.kind, COL.kind)}</span>
      <span fg={selected ? theme.selFg : theme.fg}>{fit(a.project, projWidth)}</span>
      <span fg={size === undefined ? theme.dim : theme.yellow}>{fit(fmtBytes(size), COL.size)}</span>
      <span fg={theme.dim}>{fmtAge(a.mtimeMs)}</span>
    </text>
  );
}

function GlobalRow({
  g,
  size,
  selected,
  projWidth,
}: {
  g: GlobalPkg;
  size: number | undefined;
  selected: boolean;
  projWidth: number;
}) {
  const theme = useTheme();
  const sizeText = g.path ? fmtBytes(size) : "-";
  if (g.protected) {
    return (
      <text fg={theme.dim}>
        {fit(g.manager, COL.kind) + fit(`${g.name} (protected)`, projWidth) + fit(sizeText, COL.size) + g.version}
      </text>
    );
  }
  return (
    <text>
      <span fg={theme.accent}>{fit(g.manager, COL.kind)}</span>
      <span fg={selected ? theme.selFg : theme.fg}>{fit(g.name, projWidth)}</span>
      <span fg={size === undefined ? theme.dim : theme.yellow}>{fit(sizeText, COL.size)}</span>
      <span fg={theme.dim}>{g.version}</span>
    </text>
  );
}

export function CleanScreen({
  onDone,
  initialGlobals = false,
  roots,
}: {
  onDone: (reinstall: ReinstallPlan[] | null) => void;
  initialGlobals?: boolean;
  /** Scan these roots instead of the configured ones (tests / ad-hoc paths). */
  roots?: ScanRoot[];
}) {
  const theme = useTheme();
  const [arts, setArts] = useState<Artifact[]>(() => scanArtifacts(roots));
  // Sizes come from the validated cache (see core): a cached number whose
  // validity key still matches (lockfile hash / mtime / version) is trusted
  // as-is; anything else is measured. `fresh` = paths with a trusted size.
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [refreshTick, setRefreshTick] = useState(0); // bumped by u / a re-measure
  const [globals, setGlobals] = useState<GlobalPkg[] | null>(null);
  const [showGlobals, setShowGlobals] = useState(initialGlobals);
  const [loadingGlobals, setLoadingGlobals] = useState(false);
  const [mode, setMode] = useState<"list" | "confirm" | "reinstall">("list");
  const [pending, setPending] = useState<Row[]>([]);
  const [reinstall, setReinstall] = useState<ReinstallPlan[]>([]);
  const [sortBy, setSortBy] = useState<"size" | "name">("size");
  const [showHelp, setShowHelp] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [spin, setSpin] = useState(0); // sizing spinner frame
  const listRef = useRef<ListSelectHandle<Row> | null>(null);
  // `g` (on) should land the cursor on the GLOBALS section — but globals load
  // lazily, so the jump is deferred until their rows actually exist.
  const [jumpToGlobals, setJumpToGlobals] = useState(false);

  // ---- sizing engine ----
  // Lives entirely in refs so NO re-render can cancel it. (The old version was
  // an effect whose cleanup cancelled the in-flight pool whenever `arts` got a
  // new identity — e.g. when the in-use marking landed — stranding every row
  // that hadn't finished: the "stuck at 3/n" bug.)
  const sized = useRef<Set<string>>(new Set()); // handled: adopted from cache or queued
  const inFlight = useRef<Set<string>>(new Set()); // queued or currently walking
  const queue = useRef<{ path: string; key: string }[]>([]);
  const workers = useRef(0);
  const batch = useRef<Record<string, { bytes: number; key: string }>>({});
  const unmounted = useRef(false);
  useEffect(
    () => () => {
      unmounted.current = true;
    },
    [],
  );

  const pump = () => {
    while (workers.current < 4 && queue.current.length) {
      const it = queue.current.shift()!;
      workers.current++;
      void sizeDir(it.path).then((bytes) => {
        workers.current--;
        inFlight.current.delete(it.path);
        // "Still wanted?" — a `u`/`r` refresh issued AFTER this walk started
        // removes the path from `sized`; the reconciler will re-queue it, so
        // this (pre-refresh) result must be discarded, not applied. Unrelated
        // paths are untouched — a refresh never disturbs the rest of a run.
        if (sized.current.has(it.path) && !unmounted.current) {
          batch.current[it.path] = { bytes, key: it.key };
          setSizes((prev) => ({ ...prev, [it.path]: bytes }));
          setFresh((prev) => new Set(prev).add(it.path));
        } else if (!unmounted.current) {
          // Discarded (refreshed mid-walk) — poke the reconciler so the path is
          // re-queued now that its in-flight slot is free.
          setRefreshTick((t) => t + 1);
        }
        if (queue.current.length) pump();
        else if (workers.current === 0 && Object.keys(batch.current).length) {
          updateSizeCache(batch.current);
          batch.current = {};
        }
      });
    }
  };
  const enqueue = (items: { path: string; key: string }[]) => {
    const add = items.filter((it) => !inFlight.current.has(it.path));
    if (!add.length) return;
    for (const it of add) inFlight.current.add(it.path);
    queue.current.push(...add);
    pump();
  };
  const { width } = useTerminalDimensions();
  const projWidth = Math.max(18, width - 2 - 4 - COL.kind - COL.size - COL.age);

  // Everything that can be sized, with its cache-validity key.
  const sizeItems = useMemo(
    () => [
      ...arts.map((a) => ({ path: a.path, key: artifactKey(a) })),
      ...(globals ?? [])
        .filter((g): g is GlobalPkg & { path: string } => !!g.path)
        .map((g) => ({ path: g.path, key: globalKey(g) })),
    ],
    [arts, globals],
  );

  // Reconciler: anything not yet handled gets a trusted cache adoption (validity
  // key matches — no walk) or a spot in the measuring queue. Idempotent, never
  // cancels anything; re-runs whenever the item set or a manual refresh changes.
  useEffect(() => {
    const unseen = sizeItems.filter((it) => !sized.current.has(it.path));
    if (!unseen.length) return;
    const cached = validCachedSizes(unseen);
    if (Object.keys(cached).length) {
      for (const p of Object.keys(cached)) sized.current.add(p);
      setSizes((prev) => ({ ...prev, ...cached }));
      setFresh((prev) => new Set([...prev, ...Object.keys(cached)]));
    }
    const todo = unseen.filter((it) => !(it.path in cached));
    todo.forEach((it) => sized.current.add(it.path));
    enqueue(todo);
  }, [sizeItems, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual re-measure (`u` highlighted / part of `r`): distrust the cache and
  // forget the paths; the reconciler re-queues them. A path being walked right
  // now is fine too — deleting it from `sized` makes that in-flight result get
  // discarded ("still wanted?" check), and it's measured again.
  const refreshSizes = (paths: string[]) => {
    if (!paths.length) return;
    for (const p of paths) sized.current.delete(p);
    setSizes((prev) => {
      const next = { ...prev };
      for (const p of paths) delete next[p];
      return next;
    });
    setFresh((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.delete(p);
      return next;
    });
    evictSizeCache(paths);
    setRefreshTick((t) => t + 1);
  };

  // Protect projects that a live (listening) process is working inside.
  useEffect(() => {
    let cancelled = false;
    void inUseCwds().then((cwds) => {
      if (cancelled) return;
      setArts((prev) => {
        const next = prev.map((a) => ({ ...a }));
        markProtected(next, cwds);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Lazy-load globals the first time they're shown.
  useEffect(() => {
    if (!showGlobals || globals !== null || loadingGlobals) return;
    setLoadingGlobals(true);
    void listGlobals().then((g) => {
      setGlobals(g);
      setLoadingGlobals(false);
    });
  }, [showGlobals, globals, loadingGlobals]);

  const rows: Row[] = useMemo(() => {
    const bySize = (a: Artifact, b: Artifact) =>
      (sizes[b.path] ?? -1) - (sizes[a.path] ?? -1) || a.project.localeCompare(b.project);
    const byName = (a: Artifact, b: Artifact) =>
      a.project.localeCompare(b.project) || a.kind.localeCompare(b.kind);
    const sortedArts = [...arts].sort(sortBy === "size" ? bySize : byName);
    const out: Row[] = sortedArts.map((art) => ({ rowType: "artifact", art }));
    if (showGlobals && globals) {
      const gBySize = (a: GlobalPkg, b: GlobalPkg) =>
        (b.path ? (sizes[b.path] ?? -1) : -1) - (a.path ? (sizes[a.path] ?? -1) : -1) ||
        a.name.localeCompare(b.name);
      const sortedGlobals = sortBy === "size" ? [...globals].sort(gBySize) : globals;
      out.push(...sortedGlobals.map((pkg) => ({ rowType: "global", pkg }) as Row));
    }
    return out;
  }, [arts, sizes, sortBy, showGlobals, globals]);

  // Deferred `g` jump: as soon as the first global row exists, move the cursor
  // onto it (scroll-into-view brings the section on screen).
  useEffect(() => {
    if (!jumpToGlobals) return;
    if (!showGlobals) {
      setJumpToGlobals(false); // toggled off before globals ever loaded
      return;
    }
    const first = rows.find((r) => r.rowType === "global");
    if (first) {
      listRef.current?.jumpTo(rowKey(first));
      setJumpToGlobals(false);
    } else if (globals && globals.length === 0) {
      setJumpToGlobals(false); // nothing to jump to
    }
  }, [jumpToGlobals, showGlobals, rows, globals]);

  const artTotal = arts.reduce((sum, a) => sum + (sizes[a.path] ?? 0), 0);
  const shownGlobals = showGlobals && globals ? globals : [];
  const globTotal = shownGlobals.reduce((sum, g) => sum + (g.path ? (sizes[g.path] ?? 0) : 0), 0);
  const totalKnown = artTotal + globTotal;
  // Sizing progress: every visible path (artifacts + shown globals) must have
  // been re-measured this session; until then a spinner ticks in the header.
  const allPaths = [...arts.map((a) => a.path), ...shownGlobals.map((g) => g.path).filter((p): p is string => !!p)];
  const freshCount = allPaths.filter((p) => fresh.has(p)).length;
  const allSized = freshCount === allPaths.length;

  // Tick the spinner while trees are still being walked (ASCII frames only) —
  // and run the watchdog: if rows are still pending but nothing is queued or
  // walking (any missed wake-up), forget them so the reconciler re-queues.
  // Rule of thumb: the count must converge on n; pending + idle = re-measure.
  const watchRef = useRef({ sizeItems, fresh });
  watchRef.current = { sizeItems, fresh };
  useEffect(() => {
    if (allSized) return;
    const id = setInterval(() => {
      setSpin((s) => (s + 1) % 4);
      if (inFlight.current.size === 0 && queue.current.length === 0) {
        const { sizeItems: items, fresh: done } = watchRef.current;
        const pending = items.filter((it) => !done.has(it.path));
        if (pending.length) {
          pending.forEach((it) => sized.current.delete(it.path));
          setRefreshTick((t) => t + 1);
        }
      }
    }, 150);
    return () => clearInterval(id);
  }, [allSized]);
  const spinner = "|/-\\"[spin];
  const sizing = allSized ? "" : ` | sizing ${freshCount}/${allPaths.length} ${spinner}`;

  // `r` — the one "make everything true" key: rescan the folders for new/gone
  // artifacts AND re-measure every size from scratch (cache distrusted).
  const fullRefresh = () => {
    const nextArts = scanArtifacts(roots);
    evictSizeCache(sizeItems.map((it) => it.path));
    sized.current.clear();
    // Drop queued-but-not-started items (and free their in-flight slots so the
    // reconciler can re-queue them). Walks already running keep going — their
    // results fail the "still wanted?" check and get discarded.
    for (const it of queue.current) inFlight.current.delete(it.path);
    queue.current = [];
    setSizes({});
    setFresh(new Set());
    setArts(nextArts);
    setGlobals(null); // re-listed on next show
    setStatus("Re-measuring everything...");
    setRefreshTick((t) => t + 1);
  };

  const doDelete = async () => {
    setBusy(true);
    const artRows = pending.filter((r): r is Extract<Row, { rowType: "artifact" }> => r.rowType === "artifact");
    const globRows = pending.filter((r): r is Extract<Row, { rowType: "global" }> => r.rowType === "global");

    let freed = 0;
    let fails = 0;
    for (const r of artRows) {
      const res = await deleteArtifact(r.art.path);
      if (res.ok) freed += sizes[r.art.path] ?? 0;
      else fails++;
    }
    for (const r of globRows) {
      const res = await removeGlobal(r.pkg);
      if (res.ok && r.pkg.path) freed += sizes[r.pkg.path] ?? 0;
      else if (!res.ok) fails++;
    }

    const deletedPaths = new Set(artRows.map((r) => r.art.path));
    const removedGlobalPaths = globRows.map((r) => r.pkg.path).filter((p): p is string => !!p);
    evictSizeCache([...deletedPaths, ...removedGlobalPaths]); // no ghost-paint next run
    setArts((prev) => prev.filter((a) => !deletedPaths.has(a.path)));
    if (globRows.length) setGlobals(null); // re-list on next show
    setStatus(
      `Freed ${fmtBytes(freed)} (${artRows.length} artifacts` +
        (globRows.length ? `, ${globRows.length} globals` : "") +
        `)${fails ? ` - ${fails} FAILED` : ""}`,
    );
    setPending([]);
    setBusy(false);

    // Offer to reinstall dependencies where node_modules was just deleted.
    const nmDirs = [...new Set(artRows.filter((r) => r.art.kind === "node_modules").map((r) => r.art.dir))];
    if (nmDirs.length) {
      setReinstall(nmDirs.map((dir) => ({ dir, pm: detectPm(dir) })));
      setMode("reinstall");
    } else {
      setMode("list");
    }
  };

  if (showHelp) {
    return <Help title="clean - keys" bindings={HELP} onClose={() => setShowHelp(false)} />;
  }

  const pendingBytes = pending.reduce(
    (sum, r) => (r.rowType === "artifact" ? sum + (sizes[r.art.path] ?? 0) : sum),
    0,
  );
  const confirmMsg =
    `Delete ${pending.length} item(s), about ${fmtBytes(pendingBytes)}? ` +
    "(artifact folders are removed from disk; globals are uninstalled)";

  return (
    <box style={{ padding: 1, flexDirection: "column" }}>
      <Header
        title="clean"
        subtitle={`${fmtBytes(totalKnown)} reclaimable${showGlobals ? ` (${fmtBytes(artTotal)} artifacts + ${fmtBytes(globTotal)} globals)` : ""}${sizing} | sort: ${sortBy}`}
        hint="space/tab/v mark | enter delete | g globals | u/r re-measure | s sort | h help | q quit"
      />
      {status ? <text fg={theme.green}>{status}</text> : null}
      {busy ? <text fg={theme.yellow}>Working...</text> : null}
      {loadingGlobals ? <text fg={theme.dim}>Listing global packages...</text> : null}
      <ListSelect
        items={rows}
        getKey={rowKey}
        controlRef={listRef}
        multiSelect
        active={mode === "list" && !showHelp && !busy}
        isSelectable={(r) => (r.rowType === "artifact" ? !r.art.protected : !r.pkg.protected)}
        filterText={(r) =>
          r.rowType === "artifact" ? `${r.art.kind} ${r.art.project}` : `${r.pkg.name} ${r.pkg.manager}`
        }
        sectionOf={(r) => r.rowType}
        sectionLabel={(id, count) =>
          id === "artifact"
            ? `ARTIFACTS (${count}) | ${fmtBytes(artTotal)}`
            : `GLOBALS (${count}) | ${fmtBytes(globTotal)}`
        }
        emptyText="No build artifacts found under your scan roots. (Add roots in launch with s.)"
        onSubmit={(items) => {
          if (!items.length) return;
          setPending(items);
          setMode("confirm");
        }}
        onCancel={() => onDone(null)}
        onExtraKey={(name, current) => {
          if (name === "h") setShowHelp(true);
          else if (name === "r") fullRefresh();
          else if (name === "s") setSortBy((s) => (s === "size" ? "name" : "size"));
          else if (name === "g") {
            setShowGlobals((v) => {
              if (!v) setJumpToGlobals(true); // turning ON -> land on the section
              return !v;
            });
          }
          else if (name === "u" && current) {
            const path = current.rowType === "artifact" ? current.art.path : current.pkg.path;
            if (path) refreshSizes([path]);
          }
        }}
        renderRow={(r, { selected }) =>
          r.rowType === "artifact" ? (
            <ArtifactRow a={r.art} size={sizes[r.art.path]} selected={selected} projWidth={projWidth} />
          ) : (
            <GlobalRow
              g={r.pkg}
              size={r.pkg.path ? sizes[r.pkg.path] : undefined}
              selected={selected}
              projWidth={projWidth}
            />
          )
        }
      />
      {mode === "confirm" ? (
        <Confirm
          message={confirmMsg}
          onConfirm={() => void doDelete()}
          onCancel={() => {
            setPending([]);
            setMode("list");
          }}
        />
      ) : null}
      {mode === "reinstall" ? (
        <Confirm
          message={`Reinstall dependencies for ${reinstall.length} project(s) now? (runs ${[...new Set(reinstall.map((p) => p.pm))].join("/")} install; output streams to this terminal)`}
          onConfirm={() => onDone(reinstall)}
          onCancel={() => {
            setReinstall([]);
            setMode("list");
          }}
        />
      ) : null}
    </box>
  );
}

// Mount the screen; if the user asked to reinstall after a node_modules delete,
// hand the terminal over and run the installs (launch's handoff pattern).
export async function runCleanScreen(initialGlobals = false) {
  const plans = await mountScreen<ReinstallPlan[] | null>((done) => (
    <CleanScreen onDone={done} initialGlobals={initialGlobals} />
  ));
  if (!plans || !plans.length) return;
  for (const p of plans) {
    console.log(`\n> ${p.pm} install  (${p.dir})\n`);
    const proc = Bun.spawn([p.pm, "install"], {
      cwd: p.dir,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  }
  console.log("\nDone.");
}

// ---------- CLI entry ----------

export async function runClean() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(
      [
        "Usage: clean [--globals]",
        "  clean            interactive picker (dry-run: nothing is deleted",
        "                   until you mark rows and confirm)",
        "  -g, --globals    also list globally installed packages up front",
        "",
        "Scans the folders configured as launch scan roots (manage them in",
        "launch with s). Sizes are measured once and cached; a cached size is",
        "reused until it stops being trustworthy (node_modules: the lockfile",
        "hash changed; other artifacts: the folder was touched; globals: the",
        "version changed). Re-measure by hand with u (highlighted row) or r",
        "(refresh everything: rescan folders + re-measure all).",
        "",
        "Examples:",
        "  clean            see every node_modules/dist/target with its size,",
        "                   mark with space (or v sweep), Enter + confirm deletes",
        "  clean -g         also review bun/npm/pnpm/deno global packages with",
        "                   their sizes; marked ones are uninstalled via their",
        "                   own manager",
      ].join("\n"),
    );
    return;
  }
  await runCleanScreen(argv.includes("--globals") || argv.includes("-g"));
  process.exit(0);
}

if (import.meta.main) {
  await runClean();
}

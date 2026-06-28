#!/usr/bin/env bun
// killport — find what's listening on a TCP port and kill it.
//
//   killport            interactive picker (this OpenTUI screen)
//   killport 3000 8080  kill listeners on those ports (plain CLI, scriptable)
//   killport 3000 -y    skip the confirmation prompt
//
// UI logic only; all discovery/killing lives in pkg/core/killport.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { mountScreen } from "./app";
import { useTheme } from "./theme-context";
import { Header, Confirm, ListSelect, Help, type Binding } from "./components";
import {
  listListeners,
  listenersForPort,
  killPid,
  parsePorts,
  type Listener,
  type PortCategory,
} from "../core/killport";
import { resolveAppName } from "../core/appname";

type Row = Listener & { appName?: string };

const RANK: Record<PortCategory, number> = { app: 0, service: 1, other: 2 };
const SECTION_NAME: Record<PortCategory, string> = {
  app: "APPS",
  service: "SERVICES",
  other: "OTHER",
};

// Auto-refresh presets cycled by `f` (ms; 0 = off). Default is 1500ms.
const REFRESH_STEPS = [500, 1000, 1500, 3000, 5000, 0];
const DEFAULT_REFRESH = 1500;
const fmtInterval = (ms: number) => (ms === 0 ? "off" : `${ms / 1000}s`);
const nextInterval = (ms: number) =>
  REFRESH_STEPS[(REFRESH_STEPS.indexOf(ms) + 1) % REFRESH_STEPS.length] ?? DEFAULT_REFRESH;

const HELP: Binding[] = [
  { keys: "j / k", desc: "move (or arrow keys)" },
  { keys: "space / tab", desc: "toggle the highlighted row" },
  { keys: "v", desc: "visual range - v, sweep with j/k, v again to keep" },
  { keys: "enter", desc: "kill the selection (or highlighted row)" },
  { keys: "/", desc: "filter by port, process name, or PID" },
  { keys: "a", desc: "toggle common (apps + services) <-> all ports" },
  { keys: "s", desc: "toggle sort: port number <-> process name" },
  { keys: "i", desc: "cycle auto-refresh interval: 0.5s / 1s / 1.5s / 3s / 5s / off" },
  { keys: "y", desc: "copy the highlighted PID to the clipboard" },
  { keys: "r", desc: "refresh now" },
  { keys: "t", desc: "cycle color theme" },
  { keys: "q / esc esc", desc: "quit (q, or Esc twice)" },
];

function copyPid(pid: number): boolean {
  try {
    Bun.spawn(["clip"], { stdin: Buffer.from(String(pid)) });
    return true;
  } catch {
    return false;
  }
}

// Columns: PORT · PID · NAME · PROCESS. PORT/PID/NAME are fixed width (NAME a bit
// wider than the old runtime column); PROCESS is last and fills the remaining
// terminal width (computed by the screen). ListSelect prefixes a "› ◉ " gutter.
const COL = { port: 7, pid: 8, name: 24 };
const GUTTER = 4; // "› " + "◉ " prefix that ListSelect adds before each row
const CHROME = 2; // screen box left+right padding
// Width the trailing PROCESS column may use: everything right of the fixed cols.
export const procColWidth = (termWidth: number) =>
  Math.max(10, termWidth - CHROME - GUTTER - COL.port - COL.pid - COL.name);

// Pad/truncate to exactly `w` chars, always leaving >=1 trailing space as a gap.
// "..." (3 chars) marks truncation, kept within w-1.
const fit = (s: string, w: number) => {
  if (s.length <= w - 1) return s.padEnd(w);
  return (s.slice(0, Math.max(0, w - 4)) + "...").padEnd(w);
};
// Truncate (no padding) - for the trailing PROCESS column so it can't wrap.
const clip = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 3)) + "..." : s);

// Header row matching the data columns (4 spaces = the ListSelect gutter width).
function ColumnHeader() {
  const theme = useTheme();
  return (
    <text fg={theme.dim}>
      {"    " + fit("PORT", COL.port) + fit("PID", COL.pid) + fit("NAME", COL.name) + "PROCESS"}
    </text>
  );
}

function PortRow({ l, selected, procWidth }: { l: Row; selected: boolean; procWidth: number }) {
  const theme = useTheme();
  const port = fit(String(l.port), COL.port);
  const pid = fit(String(l.pid), COL.pid);
  const proc = clip(l.name, procWidth); // last column, fills remaining width
  if (l.system) {
    return (
      <text fg={theme.dim}>
        {port}
        {pid}
        {fit("(protected)", COL.name)}
        {proc}
      </text>
    );
  }
  // NAME column: the resolved app name is more useful than the generic port-use
  // label, so prefer it; the runtime process fills the last column.
  const name = l.appName ?? l.portLabel ?? "";
  return (
    <text>
      <span fg={theme.accent}>{port}</span>
      <span fg={theme.dim}>{pid}</span>
      <span fg={selected ? theme.selFg : theme.fg}>{fit(name, COL.name)}</span>
      <span fg={theme.dim}>{proc}</span>
    </text>
  );
}

export function KillportScreen({
  onExit,
  initialInterval = DEFAULT_REFRESH,
}: {
  onExit: () => void;
  initialInterval?: number;
}) {
  const [listeners, setListeners] = useState<Listener[] | null>(null);
  const [mode, setMode] = useState<"list" | "confirm">("list");
  const [pending, setPending] = useState<Listener[]>([]);
  const [status, setStatus] = useState("");
  const [view, setView] = useState<"curated" | "all">("curated");
  const [sortBy, setSortBy] = useState<"port" | "name">("port");
  const [showHelp, setShowHelp] = useState(false);
  const [intervalMs, setIntervalMs] = useState(initialInterval);
  const [interacting, setInteracting] = useState(false);
  const [names, setNames] = useState<Record<number, string>>({}); // pid → app name
  const attempted = useRef<Set<number>>(new Set()); // pids we've already resolved
  const theme = useTheme();
  const { width } = useTerminalDimensions();
  const procWidth = procColWidth(width);

  // Refresh in the background without blanking the list to "Scanning…" — only
  // the very first load (listeners === null) shows that.
  const load = useCallback(async () => {
    setListeners(await listListeners());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh on a timer, paused while a confirm/help is up or the user is
  // mid-interaction (filtering / visual sweep) so the list doesn't shift.
  const paused = mode !== "list" || showHelp || interacting;
  useEffect(() => {
    if (intervalMs <= 0 || paused) return;
    const id = setInterval(() => void load(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, paused, load]);

  // Lazily resolve a friendly app name (from each process's package.json) once
  // the list is shown. Each pid is resolved once per session — refreshes reuse
  // the cache, so this never re-runs the native lookup for known pids.
  useEffect(() => {
    if (!listeners) return;
    const pids = [
      ...new Set(
        listeners.filter((l) => l.category === "app" && !l.system).map((l) => l.pid),
      ),
    ].filter((pid) => !attempted.current.has(pid));
    if (!pids.length) return;
    pids.forEach((pid) => attempted.current.add(pid));
    let cancelled = false;
    void (async () => {
      const found = await Promise.all(
        pids.map(async (pid) => [pid, await resolveAppName(pid)] as const),
      );
      if (cancelled) return;
      const hits = found.filter(([, name]) => name);
      if (hits.length) setNames((prev) => ({ ...prev, ...Object.fromEntries(hits) }));
    })();
    return () => {
      cancelled = true;
    };
  }, [listeners]);

  // Group by category (apps → services → other), then by the chosen sort key.
  const ordered = useMemo(() => {
    const arr = [...(listeners ?? [])];
    arr.sort(
      (a, b) =>
        RANK[a.category] - RANK[b.category] ||
        (sortBy === "name" ? a.name.localeCompare(b.name) : 0) ||
        a.port - b.port,
    );
    return arr;
  }, [listeners, sortBy]);

  const visible = view === "curated" ? ordered.filter((l) => l.category !== "other") : ordered;
  const display: Row[] = visible.map((l) => ({ ...l, appName: names[l.pid] }));
  const otherCount = ordered.filter((l) => l.category === "other").length;

  if (listeners === null) {
    return (
      <box style={{ padding: 1, flexDirection: "column" }}>
        <Header title="killport" subtitle="kill processes by port" />
        <text fg={theme.dim}>Scanning listening ports...</text>
      </box>
    );
  }

  const doKill = async () => {
    // One process can own several selected ports — kill each PID once.
    const pids = [...new Set(pending.map((t) => t.pid))];
    const results = await Promise.all(pids.map((pid) => killPid(pid)));
    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    setStatus(`Killed ${ok}${fail ? `, ${fail} failed` : ""} at ${new Date().toLocaleTimeString()}`);
    setPending([]);
    setMode("list");
    await load();
  };

  const confirmMsg =
    `Kill ${pending.length}: ` + pending.map((t) => `${t.name} (${t.port})`).join(", ") + " ?";

  const emptyText =
    view === "curated"
      ? `No common ports in use - press a to show all (${ordered.length} listening).`
      : "No listening ports found.";

  if (showHelp) {
    return <Help title="killport - keys" bindings={HELP} onClose={() => setShowHelp(false)} />;
  }

  return (
    <box style={{ padding: 1, flexDirection: "column" }}>
      <Header
        title="killport"
        subtitle={`${view === "curated" ? "common" : "all"} ports | sort: ${sortBy} | auto: ${fmtInterval(intervalMs)}`}
        hint="j/k | space/tab/v select | enter kill | / filter | a all | t theme | h help"
      />
      {status ? <text fg={theme.green}>{status}</text> : null}
      <ColumnHeader />
      <ListSelect
        items={display}
        getKey={(l) => `${l.port}:${l.pid}`}
        multiSelect
        active={mode === "list" && !showHelp}
        isSelectable={(l) => !l.system}
        filterText={(l) => `${l.port} ${l.name} ${l.pid} ${l.appName ?? ""} ${l.portLabel ?? ""}`}
        sectionOf={(l) => l.category}
        sectionLabel={(id, count) => `${SECTION_NAME[id as PortCategory]} (${count})`}
        onInteractingChange={setInteracting}
        emptyText={emptyText}
        onSubmit={(targets) => {
          setPending(targets);
          setMode("confirm");
        }}
        onCancel={onExit}
        onExtraKey={(name, current) => {
          if (name === "r") void load();
          else if (name === "a") setView((v) => (v === "curated" ? "all" : "curated"));
          else if (name === "s") setSortBy((s) => (s === "port" ? "name" : "port"));
          else if (name === "i") setIntervalMs((ms) => nextInterval(ms));
          else if (name === "h") setShowHelp(true);
          else if (name === "y" && current)
            setStatus(copyPid(current.pid) ? `Copied PID ${current.pid}` : "Copy failed");
        }}
        renderRow={(l, { selected }) => (
          <PortRow l={l} selected={selected} procWidth={procWidth} />
        )}
      />
      {view === "curated" && otherCount > 0 ? (
        <box style={{ flexDirection: "column" }}>
          <text fg={theme.accentDim}>{`OTHER (${otherCount})`}</text>
          <text fg={theme.dim}>{'  press "a" to show all ports'}</text>
        </box>
      ) : null}
      {mode === "confirm" ? (
        <Confirm
          message={confirmMsg}
          onConfirm={() => void doKill()}
          onCancel={() => {
            setPending([]);
            setMode("list");
          }}
        />
      ) : null}
    </box>
  );
}

// ---------- non-interactive CLI path (killport <ports> [-y]) ----------

async function runKillCli(ports: number[], autoYes: boolean) {
  const targets: Listener[] = [];
  for (const p of ports) {
    const ls = (await listenersForPort(p)).filter((l) => !l.system);
    if (!ls.length) console.log(`Port ${p}: nothing listening.`);
    targets.push(...ls);
  }
  if (!targets.length) {
    console.log("Nothing to kill.");
    return;
  }
  console.log("Targets:");
  for (const t of targets) console.log(`  ${t.port}  ${t.name} (pid ${t.pid})`);
  // One process can own several of the requested ports — kill each PID once.
  const byPid = new Map<number, Listener>();
  for (const t of targets) if (!byPid.has(t.pid)) byPid.set(t.pid, t);
  if (!autoYes) {
    const ans = prompt(`Kill ${byPid.size} process(es)? [y/N]`);
    if (!ans || !/^y/i.test(ans)) {
      console.log("Aborted.");
      return;
    }
  }
  for (const [pid, t] of byPid) {
    const r = await killPid(pid);
    console.log(
      r.ok ? `  ✓ killed ${t.name} (pid ${pid})` : `  ✗ ${t.name} (pid ${pid}): ${r.error}`,
    );
  }
}

export async function runKillport() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(
      [
        "Usage: killport [ports...] [-y] [--interval=<ms|off>]",
        "  killport               interactive picker",
        "  killport 3000 8080     kill listeners on those ports",
        "  -y, --yes              skip the confirmation prompt",
        "  --interval=<ms|off>    picker auto-refresh (default 1500)",
      ].join("\n"),
    );
    return;
  }
  const autoYes = argv.includes("-y") || argv.includes("--yes");
  const ports = parsePorts(argv);
  if (ports.length) {
    await runKillCli(ports, autoYes);
  } else {
    await mountScreen<void>((done) => (
      <KillportScreen onExit={done} initialInterval={parseInterval(argv)} />
    ));
    process.exit(0);
  }
}

// `--interval=2000` / `--interval=off` (and `--no-watch`) set the picker's
// starting auto-refresh; anything invalid falls back to the default.
function parseInterval(argv: string[]): number {
  if (argv.includes("--no-watch")) return 0;
  const arg = argv.find((a) => a.startsWith("--interval="));
  if (!arg) return DEFAULT_REFRESH;
  const val = arg.slice("--interval=".length).toLowerCase();
  if (val === "off" || val === "0") return 0;
  const n = Number(val);
  return Number.isFinite(n) && n >= 250 ? n : DEFAULT_REFRESH;
}

if (import.meta.main) {
  await runKillport();
}

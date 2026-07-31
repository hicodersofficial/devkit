// launch core — a config-driven project launcher. Discovers runnable projects
// and starts a chosen project's commands together.
//
// Pure logic (filesystem scan, config persistence, process spawning), no
// terminal UI. The TUI (pkg/tui/launch.tsx) renders a picker on top of these
// functions and calls startCommands() once commands are chosen.
//
// Projects come from two sources, both persisted in ~/.devkit.json:
//   - SCAN ROOTS: folders auto-scanned every run; each subfolder with a runnable
//     manifest becomes a project (e.g. a directory that holds all your apps).
//     Live — new subprojects appear without any manual step.
//   - MANUAL PROJECTS: explicitly added (via auto-detect or by hand), each with
//     a name and a set of commands.
//
// Each project owns commands; one or more may be flagged `isDefault` (Enter
// starts all defaults together — e.g. backend + frontend). The UI's `a` key
// lets the user run any ad-hoc subset for a single run.

import { readdirSync, statSync, accessSync, constants, writeFileSync } from "node:fs";
import { join, basename, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { loadConfig, saveConfig } from "./config";
import { detectCommandsInDir, manifestName } from "./manifest";

export interface Command {
  id: string; // stable within a project
  label: string; // e.g. "dev", "frontend:dev", "run"
  command: string; // full shell command, e.g. "bun run dev", "go run ."
  cwd: string; // absolute working directory
  isDefault?: boolean; // run on Enter (one or more may be default)
}

export interface Project {
  id: string;
  name: string;
  commands: Command[];
  /** Runtime-only origin: "manual" or the scan-root path it was discovered in. */
  source?: string;
  /** Runtime-only: whether the project is pinned (see LaunchConfig.pinned). */
  pinned?: boolean;
  /**
   * Ids of member projects this project combines (a "group" project, e.g.
   * "sustainatrix" = esg-kpi + auth-service). Non-empty => `commands` is
   * recomputed live from the members' CURRENT commands on every
   * scanProjects() call and is never itself persisted (see normalizeForSave).
   */
  memberIds?: string[];
}

export interface ScanRoot {
  path: string;
  exclude?: string[];
}

export interface LaunchConfig {
  projects: Project[];
  scanRoots: ScanRoot[];
  /** Ids of pinned (favorite) projects — floated to a ★ PINNED section on top. */
  pinned?: string[];
  /** Custom project order (ids); used as the sort key in "manual" sort mode. */
  order?: string[];
  /** How the list is sorted within each section. */
  sortMode?: SortMode;
  /** Per-project id → command labels last launched, so a run can be repeated. */
  lastRun?: Record<string, string[]>;
  /** Per-project id → epoch ms of the last launch (for "recent" sort mode). */
  lastRunAt?: Record<string, number>;
}

/** "manual" = user's custom order (alphabetical until reordered); "recent" =
 *  most-recently-launched first. */
export type SortMode = "manual" | "recent";

// ---- config persistence ----
//
// All projects and scan roots live in ~/.devkit.json (under the `launch` key) —
// nothing is hard-coded here. A fresh install starts empty; the user configures
// scan roots and projects from the UI (which persists to that JSON file) or by
// editing the file directly.

function emptyConfig(): LaunchConfig {
  return {
    projects: [],
    scanRoots: [],
    pinned: [],
    order: [],
    sortMode: "manual",
    lastRun: {},
    lastRunAt: {},
  };
}

/**
 * Scan roots live at the TOP LEVEL of ~/.devkit.json (`scanRoots`) so other
 * tools (e.g. clean) can share them without reaching into launch's config.
 * Older configs stored them under `launch.scanRoots` — reads fall back to that,
 * and the next saveLaunch() writes them top-level (a lazy, lossless migration).
 */
export function loadScanRoots(): ScanRoot[] {
  const cfg = loadConfig();
  return cfg.scanRoots ?? cfg.launch?.scanRoots ?? [];
}

export function loadLaunch(): LaunchConfig {
  const cfg = loadConfig();
  const c = cfg.launch;
  return {
    projects: c?.projects ?? [],
    scanRoots: cfg.scanRoots ?? c?.scanRoots ?? [],
    pinned: c?.pinned ?? [],
    order: c?.order ?? [],
    sortMode: c?.sortMode ?? "manual",
    lastRun: c?.lastRun ?? {},
    lastRunAt: c?.lastRunAt ?? {},
  };
}

export function saveLaunch(cfg: LaunchConfig): void {
  // Split on write: roots go to the shared top-level key, the rest under
  // `launch`. Writing `launch` whole (without scanRoots) also completes the
  // migration away from any legacy `launch.scanRoots` still in the file.
  const { scanRoots, ...launchRest } = cfg;
  saveConfig({ launch: launchRest, scanRoots });
}

export function addProject(p: Project): void {
  const cfg = loadLaunch();
  cfg.projects.push(normalizeForSave(p));
  saveLaunch(cfg);
}

export function updateProject(p: Project): void {
  const cfg = loadLaunch();
  cfg.projects = cfg.projects.map((x) => (x.id === p.id ? normalizeForSave(p) : x));
  saveLaunch(cfg);
}

export function removeProject(id: string): void {
  const cfg = loadLaunch();
  cfg.projects = cfg.projects.filter((x) => x.id !== id);
  saveLaunch(cfg);
}

export function addScanRoot(root: ScanRoot): void {
  const cfg = loadLaunch();
  if (!cfg.scanRoots.some((r) => r.path === root.path)) cfg.scanRoots.push(root);
  saveLaunch(cfg);
}

export function removeScanRoot(path: string): void {
  const cfg = loadLaunch();
  cfg.scanRoots = cfg.scanRoots.filter((r) => r.path !== path);
  saveLaunch(cfg);
}

/** The folder a scanned project was discovered in, or null for a manual one. */
export function scanFolder(p: Project): string | null {
  return p.id.startsWith("scan:") ? basename(p.id.slice("scan:".length)) : null;
}

/** Stop a scan root from re-discovering `folder` (its immediate subfolder). */
export function excludeFromScan(rootPath: string, folder: string): void {
  const cfg = loadLaunch();
  const root = cfg.scanRoots.find((r) => r.path === rootPath);
  if (!root) return;
  root.exclude = root.exclude ?? [];
  if (!root.exclude.includes(folder)) root.exclude.push(folder);
  saveLaunch(cfg);
}

/** Un-hide: drop `folder` from a scan root's exclude list so it's scanned again. */
export function includeInScan(rootPath: string, folder: string): void {
  const cfg = loadLaunch();
  const root = cfg.scanRoots.find((r) => r.path === rootPath);
  if (!root?.exclude) return;
  root.exclude = root.exclude.filter((f) => f !== folder);
  saveLaunch(cfg);
}

/**
 * Turn a discovered (scanned) project into a persisted manual one so it can be
 * edited: copy it into `projects` with a fresh id and exclude its original
 * folder from the scan root so it isn't listed twice. Returns the manual copy.
 */
export function adoptProject(p: Project): Project {
  const manual: Project = {
    id: newId(),
    name: p.name,
    commands: p.commands.map((c) => ({ ...c })),
  };
  const cfg = loadLaunch();
  cfg.projects.push(manual);
  const folder = scanFolder(p);
  if (p.source && folder) {
    const root = cfg.scanRoots.find((r) => r.path === p.source);
    if (root) {
      root.exclude = root.exclude ?? [];
      if (!root.exclude.includes(folder)) root.exclude.push(folder);
    }
  }
  saveLaunch(cfg);
  return manual;
}

/** Pin or unpin a project (toggles its id in the persisted `pinned` list). */
export function togglePin(id: string): void {
  const cfg = loadLaunch();
  const pinned = new Set(cfg.pinned ?? []);
  pinned.has(id) ? pinned.delete(id) : pinned.add(id);
  cfg.pinned = [...pinned];
  saveLaunch(cfg);
}

/** Which display section a project belongs to (used to constrain reordering). */
function sectionKey(p: Project): string {
  return p.pinned ? "pinned" : (p.source ?? "manual");
}

/** Persist the list sort mode. */
export function setSortMode(mode: SortMode): void {
  const cfg = loadLaunch();
  cfg.sortMode = mode;
  saveLaunch(cfg);
}

/**
 * Move a project one step up (dir -1) or down (dir +1) within its own section,
 * persisting the new order. Stops at section boundaries (won't jump a project
 * out of PINNED / PROJECTS / a scan group). Takes the current display order
 * (`ordered`, from orderProjects) so it never re-scans the filesystem; the saved
 * `order` is that sequence with the swap applied, which self-prunes stale ids.
 */
export function moveProject(id: string, dir: -1 | 1, ordered: Project[]): void {
  const idx = ordered.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const j = idx + dir;
  if (j < 0 || j >= ordered.length) return;
  if (sectionKey(ordered[idx]!) !== sectionKey(ordered[j]!)) return; // don't cross sections
  const next = [...ordered];
  [next[idx], next[j]] = [next[j]!, next[idx]!];
  const cfg = loadLaunch();
  cfg.order = next.map((p) => p.id);
  saveLaunch(cfg);
}

/** Record the command labels + time last launched for a project (repeat/recent). */
export function recordLastRun(id: string, labels: string[]): void {
  const cfg = loadLaunch();
  cfg.lastRun = { ...(cfg.lastRun ?? {}), [id]: labels };
  cfg.lastRunAt = { ...(cfg.lastRunAt ?? {}), [id]: Date.now() };
  saveLaunch(cfg);
}

/** Command labels last launched for a project, or [] if never run. */
export function lastRunLabels(id: string, cfg: LaunchConfig = loadLaunch()): string[] {
  return cfg.lastRun?.[id] ?? [];
}

// Never persist the runtime-only `source` / `pinned` markers on a project. A
// group project's `commands` is derived, never authoritative — if a TUI call
// site spreads a live-recomputed `target` (e.g. renaming a group), don't let
// that stale snapshot hit disk; scanProjects() recomputes it on every read.
function normalizeForSave(p: Project): Project {
  const { source, pinned, ...rest } = p;
  void source;
  void pinned;
  if (rest.memberIds?.length) return { ...rest, commands: [] };
  return rest;
}

// ---- ids + command construction ----

export function newId(): string {
  return crypto.randomUUID();
}

export function newCommand(
  label: string,
  command: string,
  cwd: string,
  isDefault = false,
): Command {
  return { id: newId(), label, command, cwd, isDefault };
}

/** The commands Enter should start: the defaults, or all if none are flagged. */
export function defaultCommands(p: Project): Command[] {
  const def = p.commands.filter((c) => c.isDefault);
  return def.length ? def : p.commands;
}

/**
 * A group's live command list: each member's commands, label-prefixed with
 * the member's name so a merged/ask picker can tell them apart (e.g.
 * "esg-kpi: dev"). A member that is itself a group is skipped (no nesting) —
 * a missing member (deleted/renamed away) is simply absent from `members`
 * already, so it degrades gracefully to fewer/zero commands.
 */
function groupCommands(members: Project[]): Command[] {
  return members
    .filter((m) => !m.memberIds?.length)
    .flatMap((m) => m.commands.map((c) => ({ ...c, label: `${m.name}: ${c.label}` })));
}

/**
 * Same as groupCommands, but each member's DEFAULT commands only — what
 * launchGrouped actually runs. groupCommands' full list is for the group's
 * persisted `commands`/the ask-picker, where the user chooses a subset
 * themselves; running a group's own defaults should never leak every
 * script (lint/build/test/...) a member happens to have.
 */
function defaultGroupCommands(members: Project[]): Command[] {
  return members
    .filter((m) => !m.memberIds?.length)
    .flatMap((m) => defaultCommands(m).map((c) => ({ ...c, label: `${m.name}: ${c.label}` })));
}

// ---- detection ----

// Backend services start before frontends when both are present.
const rank = (label: string) => (/server|service|backend|api/i.test(label) ? 0 : 1);

function subPackageCommands(dir: string): Command[] {
  const out: Command[] = [];
  let subs: string[] = [];
  try {
    subs = readdirSync(dir);
  } catch {
    return out;
  }
  for (const sub of subs) {
    if (sub === "node_modules") continue;
    const subDir = join(dir, sub);
    try {
      if (!statSync(subDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const c of detectCommandsInDir(subDir)) {
      out.push(newCommand(`${sub}:${c.label}`, c.command, c.cwd));
    }
  }
  return out;
}

/**
 * All candidate commands for a folder the user points the auto-add flow at: the
 * folder's own manifest commands plus one level of sub-packages (labels
 * namespaced as `<sub>:<label>`). Backend-before-frontend ordered.
 */
export function detectProjectCommands(dir: string): Command[] {
  const own = detectCommandsInDir(dir).map((c) => newCommand(c.label, c.command, c.cwd));
  const cmds = own.length ? own : subPackageCommands(dir);
  cmds.sort((a, b) => rank(a.label) - rank(b.label));
  return cmds;
}

/** A sensible default name for a folder (manifest name, else the folder name). */
export function suggestName(dir: string): string {
  return manifestName(dir) ?? basename(dir.replace(/[\\/]+$/, "")) ?? dir;
}

// Per working directory, flag the dev (else start, else first) command default,
// so Enter mirrors the old behavior of starting each package's dev script.
function markDefaults(cmds: Command[]): void {
  const byCwd = new Map<string, Command[]>();
  for (const c of cmds) {
    const arr = byCwd.get(c.cwd);
    if (arr) arr.push(c);
    else byCwd.set(c.cwd, [c]);
  }
  const base = (c: Command) => c.label.split(":").pop()!;
  for (const group of byCwd.values()) {
    const pick =
      group.find((c) => base(c) === "dev") ?? group.find((c) => base(c) === "start") ?? group[0];
    if (pick) pick.isDefault = true;
  }
}

/**
 * Scan one root: every immediate subfolder that has runnable commands (directly,
 * or via its own sub-packages) becomes a project. Mirrors the old egp discover()
 * Case 1 / Case 2 logic, generalized to every manifest type.
 */
export function scanRoot(root: ScanRoot): Project[] {
  const exclude = new Set([...(root.exclude ?? []), "node_modules"]);
  const projects: Project[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root.path);
  } catch {
    return projects;
  }
  for (const entry of entries) {
    if (exclude.has(entry)) continue;
    const dir = join(root.path, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const own = detectCommandsInDir(dir).map((c) => newCommand(c.label, c.command, c.cwd));
    const cmds = own.length ? own : subPackageCommands(dir);
    if (!cmds.length) continue;

    cmds.sort((a, b) => rank(a.label) - rank(b.label));
    markDefaults(cmds);
    projects.push({ id: `scan:${dir}`, name: entry, commands: cmds, source: root.path });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

/**
 * EXPENSIVE: read the filesystem. Returns the raw set of projects — manual ones
 * plus everything discovered under the scan roots, each tagged with `source` but
 * NOT yet pinned/sorted. Call this only on load / rescan, then feed the result
 * to orderProjects() (cheap) for display; that keeps pin/reorder/sort instant.
 */
export function scanProjects(cfg: LaunchConfig = loadLaunch()): Project[] {
  const manual = cfg.projects.map((p) => ({ ...p, source: "manual" as const }));
  const scanned = cfg.scanRoots.flatMap((r) => scanRoot(r));
  const all = [...manual, ...scanned];

  // Live-recompute any group project's commands from its members' CURRENT
  // commands (never a stored snapshot). Fast-path: skip entirely when there
  // are no groups, so ordinary configs pay nothing extra.
  if (!all.some((p) => p.memberIds?.length)) return all;
  const byId = new Map(all.map((p) => [p.id, p] as const));
  return all.map((p) => {
    if (!p.memberIds?.length) return p;
    const members = p.memberIds.map((id) => byId.get(id)).filter((m): m is Project => !!m);
    return { ...p, commands: groupCommands(members) };
  });
}

/**
 * CHEAP: pure ordering of an already-scanned project list. Pinned projects come
 * first (a ★ PINNED section), then manual projects, then each scan root's
 * projects — contiguous so the UI can draw section headers. A pinned project
 * appears only in the pinned group. Within every group the order follows
 * `cfg.sortMode`: "manual" = custom `order` then alphabetical; "recent" = most
 * recently launched first.
 */
export function orderProjects(projects: Project[], cfg: LaunchConfig = loadLaunch()): Project[] {
  const order = cfg.order ?? [];
  const at = cfg.lastRunAt ?? {};
  const rankOf = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Infinity : i;
  };
  const cmp = (a: Project, b: Project) =>
    cfg.sortMode === "recent"
      ? (at[b.id] ?? 0) - (at[a.id] ?? 0) || a.name.localeCompare(b.name)
      : rankOf(a.id) - rankOf(b.id) || a.name.localeCompare(b.name);

  const all = projects.map((p) => ({ ...p }));
  const pins = new Set(cfg.pinned ?? []);
  for (const p of all) p.pinned = pins.has(p.id);

  const pinned = all.filter((p) => p.pinned).sort(cmp);
  const manualRest = all.filter((p) => !p.pinned && p.source === "manual").sort(cmp);
  const scannedRest = cfg.scanRoots.flatMap((r) =>
    all.filter((p) => !p.pinned && p.source === r.path).sort(cmp),
  );
  return [...pinned, ...manualRest, ...scannedRest];
}

/** Convenience: scan + order in one call (used by the CLI path). */
export function allProjects(cfg: LaunchConfig = loadLaunch()): Project[] {
  return orderProjects(scanProjects(cfg), cfg);
}

/**
 * Match a CLI argument against an already-ordered project list. Accepts, in
 * order of precedence:
 *   - a 1-based index into the visible list ("1" = the top row; with "recent"
 *     sort that's the last-opened, with "manual" sort the visible top);
 *   - an exact (case-insensitive) name;
 *   - a name prefix;
 *   - a name substring.
 * Pure — takes the list rather than scanning, so a caller matching several
 * names in a row (multi-project launch) can reuse one allProjects() snapshot
 * instead of re-walking the filesystem per name.
 */
export function matchProject(arg: string, ordered: Project[]): Project | null {
  if (/^\d+$/.test(arg)) return ordered[Number(arg) - 1] ?? null;
  const q = arg.trim().toLowerCase();
  if (!q) return null;
  return (
    ordered.find((p) => p.name.toLowerCase() === q) ??
    ordered.find((p) => p.name.toLowerCase().startsWith(q)) ??
    ordered.find((p) => p.name.toLowerCase().includes(q)) ??
    null
  );
}

/** Resolve a single CLI argument to a project (scans + orders, then matches). */
export function resolveProject(arg: string, cfg: LaunchConfig = loadLaunch()): Project | null {
  return matchProject(arg, allProjects(cfg));
}

export function findProject(name: string): Project | null {
  const q = name.toLowerCase();
  return allProjects().find((p) => p.name.toLowerCase() === q) ?? null;
}

/**
 * Build an in-memory (never persisted) Project merging several others — used
 * for an ad-hoc CLI/TUI multi-project launch (e.g. `launch esg auth`). Its id
 * is deterministic (stable for the same set of members) rather than random,
 * so repeating the same ad-hoc combo reuses one lastRun/lastRunAt entry
 * instead of growing a fresh orphaned key on every invocation.
 */
export function mergeProjects(name: string, members: Project[], id?: string): Project {
  return {
    id: id ?? `merge:${members.map((m) => m.id).sort().join(",")}`,
    name,
    commands: groupCommands(members),
    memberIds: members.map((m) => m.id),
  };
}

/**
 * Look up a group/merge project's members against an already-fetched project
 * list — used at dispatch time when only `p.memberIds` (not the original
 * pre-merge Project objects) is available, e.g. a saved group resolved from
 * a single CLI token. Missing members (deleted/renamed away) are dropped.
 */
export function resolveMembers(p: Project, ordered: Project[]): Project[] {
  const byId = new Map(ordered.map((m) => [m.id, m] as const));
  return (p.memberIds ?? []).map((id) => byId.get(id)).filter((m): m is Project => !!m);
}

// ---- running ----

/**
 * Spawn each command (full shell string) in its cwd, inheriting stdio so logs
 * stream to the terminal. Wires SIGINT to kill them all. The caller must tear
 * down any TUI renderer first.
 */
export function startCommands(cmds: Command[]): ChildProcess[] {
  const children = cmds.map((c) =>
    spawn(c.command, { cwd: c.cwd, stdio: "inherit", shell: true }),
  );
  const killAll = () => children.forEach((c) => c.kill());
  process.on("SIGINT", () => {
    killAll();
    process.exit(0);
  });
  return children;
}

// ---- group/merge dispatch (tabs on Windows, "concurrently" elsewhere) ----
//
// Used ONLY when the resolved project is a group/merge (non-empty
// memberIds) — an ordinary project's own multi-default-command launch (e.g.
// backend + frontend) always goes through startCommands() above, unchanged.

/**
 * Bun.which("wt") often reports "not found" even when wt.exe is on PATH: a
 * Store-installed wt.exe is a 0-byte MSIX "app execution alias" reparse
 * point, and Bun.which stats the candidate (which throws EACCES on that
 * reparse point) rather than just checking it's executable. Walk PATH
 * ourselves with accessSync(X_OK), which succeeds on the same file.
 */
function findWt(): string | null {
  if (process.platform !== "win32") return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "wt.exe");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next PATH entry
    }
  }
  return null;
}

const ANSI_COLORS = ["36", "35", "33", "32", "34", "91", "95", "93", "92", "94"];
const ANSI_RESET = "\x1b[0m";

function lineSplitter(onLine: (line: string) => void) {
  let buf = "";
  return {
    write: (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) onLine(line.replace(/\r$/, ""));
    },
    flush: () => {
      if (buf) onLine(buf.replace(/\r$/, ""));
      buf = "";
    },
  };
}

/**
 * "concurrently"-style: piped (not inherited) stdio, each line tagged with a
 * colored [label] prefix on this terminal. Default on macOS/Linux; opt-in on
 * Windows via -c, or the automatic fallback there when wt.exe is missing. One
 * shared SIGINT kills every child, mirroring startCommands().
 */
export function spawnConcurrent(cmds: Command[]): ChildProcess[] {
  const width = Math.min(24, Math.max(...cmds.map((c) => c.label.length)));
  const children = cmds.map((c, i) => {
    const child = spawn(c.command, { cwd: c.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const tag = `\x1b[${ANSI_COLORS[i % ANSI_COLORS.length]}m[${c.label.padEnd(width)}]${ANSI_RESET} `;
    const out = lineSplitter((l) => process.stdout.write(tag + l + "\n"));
    const err = lineSplitter((l) => process.stderr.write(tag + l + "\n"));
    child.stdout?.on("data", out.write);
    child.stderr?.on("data", err.write);
    child.on("close", () => {
      out.flush();
      err.flush();
    });
    return child;
  });
  const killAll = () => children.forEach((c) => c.kill());
  process.on("SIGINT", () => {
    killAll();
    process.exit(0);
  });
  return children;
}

// Wrap a value for a Windows command-line string: double-quoted (it may
// contain spaces), any embedded literal quote backslash-escaped up-front —
// the CommandLineToArgvW convention wt.exe's own argv parser expects. Only
// used for wt's own args (label, cwd, script path) — never for a user's full
// shell command, which goes in its own file instead (see writeTabScript).
function quoteWin(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

// Write a command to a small temp .cmd file rather than embedding it as a
// string inside wt's own command line. A tab's command line otherwise nests
// THREE layers of Windows quoting (wt's argv -> node's shell:true wrapping ->
// cmd.exe's own /C parsing) around an arbitrary user shell string that may
// itself contain quotes/&/|/^ — verified this breaks silently. A real file
// sidesteps all of that: cmd.exe just runs its lines verbatim, no re-quoting.
// Left in %TEMP% for the tab's lifetime (harmless clutter, not tracked/
// cleaned up — the OS reclaims %TEMP% periodically).
function writeTabScript(c: Command): string {
  const path = join(tmpdir(), `devkit-tab-${newId()}.cmd`);
  writeFileSync(path, `@echo off\r\ncd /d "${c.cwd}"\r\n${c.command}\r\n`, "utf8");
  return path;
}

/**
 * Windows only: one Windows Terminal tab per command, opened in the CURRENT
 * window (-w 0). Fire-and-forget — tabs are independent processes, not
 * tracked/killed from here. Returns false (nothing spawned) when wt.exe can't
 * be found, so the caller falls back to spawnConcurrent().
 *
 * Spawned via a shell command-line string (`shell: true`), not an argv array:
 * a Store-installed wt.exe is an MSIX "app execution alias" reparse point,
 * and node's spawn() refuses to launch it directly by path (throws
 * "Executable not found in $PATH" even though the file is there and
 * accessible) — verified. Routing through cmd.exe (what shell: true does)
 * works, because cmd.exe resolves/launches the alias itself rather than
 * node's own broken pre-check.
 */
export function spawnTabs(cmds: Command[]): boolean {
  if (!(Bun.which("wt") ?? findWt())) return false;
  const parts: string[] = ["wt", "-w", "0"];
  cmds.forEach((c, i) => {
    if (i > 0) parts.push(";");
    const script = writeTabScript(c);
    parts.push(
      "new-tab",
      "--title",
      quoteWin(c.label),
      "-d",
      quoteWin(c.cwd),
      "cmd.exe",
      "/k",
      quoteWin(script),
    );
  });
  try {
    const child = spawn(parts.join(" "), { stdio: "ignore", detached: true, shell: true });
    // Fire-and-forget: an unhandled 'error' on a detached ChildProcess is an
    // uncaught exception that would crash devkit itself.
    child.on("error", () => {
      console.log("Windows Terminal failed to start.");
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatch a GROUP's commands only — never called for an ordinary project
 * (see startCommands above). Returns whether the caller must keep the
 * process alive: false only when tabs were opened, since nothing local is
 * left running for the caller to hold open.
 */
export function launchCommands(
  cmds: Command[],
  opts?: { concurrent?: boolean },
): { holdsTerminal: boolean } {
  if (cmds.length <= 1) {
    startCommands(cmds);
    return { holdsTerminal: true };
  }
  if (process.platform === "win32" && !opts?.concurrent) {
    if (spawnTabs(cmds)) {
      console.log(`Opened ${cmds.length} Windows Terminal tabs.`);
      return { holdsTerminal: false };
    }
    console.log("Windows Terminal (wt.exe) not found - running together in this pane instead.\n");
  }
  spawnConcurrent(cmds);
  return { holdsTerminal: true };
}

// A project-level tab's script: just re-invoke `launch <name>` (relies on
// bin/ being on PATH inside the new tab, same as any devkit CLI use) so that
// project's own default commands run together exactly like a normal
// `launch <name>` — same startCommands, same single pane, same Ctrl-C scope
// — rather than re-implementing that behavior inside the tab's script.
function writeProjectTabScript(m: Project): string {
  const path = join(tmpdir(), `devkit-tab-${newId()}.cmd`);
  writeFileSync(path, `@echo off\r\nlaunch "${m.name}"\r\n`, "utf8");
  return path;
}

/**
 * Windows only: one Windows Terminal tab per MEMBER PROJECT (not per
 * script) — the project-level counterpart to spawnTabs. Same wt -w 0 /
 * quoting / fire-and-forget approach; returns false when wt.exe can't be
 * found so the caller falls back to spawnConcurrent().
 */
function spawnProjectTabs(members: Project[]): boolean {
  if (!(Bun.which("wt") ?? findWt())) return false;
  const parts: string[] = ["wt", "-w", "0"];
  members.forEach((m, i) => {
    if (i > 0) parts.push(";");
    const script = writeProjectTabScript(m);
    const cwd = defaultCommands(m)[0]?.cwd; // best-effort starting dir, cosmetic only
    parts.push("new-tab", "--title", quoteWin(m.name));
    if (cwd) parts.push("-d", quoteWin(cwd));
    parts.push("cmd.exe", "/k", quoteWin(script));
  });
  try {
    const child = spawn(parts.join(" "), { stdio: "ignore", detached: true, shell: true });
    child.on("error", () => {
      console.log("Windows Terminal failed to start.");
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatch a multi-project/group launch at PROJECT granularity by default
 * (one tab per member project on Windows, each running that project's own
 * defaults together — see writeProjectTabScript) — the counterpart to
 * launchCommands' per-script granularity. `opts.scriptTabs` (-st) opts back
 * into the per-script behavior; `opts.concurrent` (-c) has no per-project
 * vs per-script distinction to make (one shared pane either way), so it
 * always falls through to the flat launchCommands dispatch.
 */
export function launchGrouped(
  members: Project[],
  opts?: { concurrent?: boolean; scriptTabs?: boolean },
): { holdsTerminal: boolean } {
  const cmds = defaultGroupCommands(members);
  if (cmds.length <= 1 || opts?.scriptTabs) {
    return launchCommands(cmds, opts);
  }
  if (process.platform === "win32" && !opts?.concurrent) {
    if (spawnProjectTabs(members)) {
      console.log(`Opened ${members.length} Windows Terminal tabs.`);
      return { holdsTerminal: false };
    }
    console.log("Windows Terminal (wt.exe) not found - running together in this pane instead.\n");
  }
  spawnConcurrent(cmds);
  return { holdsTerminal: true };
}

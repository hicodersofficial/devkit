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

import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
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
  cfg.projects.push(stripSource(p));
  saveLaunch(cfg);
}

export function updateProject(p: Project): void {
  const cfg = loadLaunch();
  cfg.projects = cfg.projects.map((x) => (x.id === p.id ? stripSource(p) : x));
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

// Never persist the runtime-only `source` / `pinned` markers on a project.
function stripSource(p: Project): Project {
  const { source, pinned, ...rest } = p;
  void source;
  void pinned;
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
  return [...manual, ...scanned];
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
 * Resolve a CLI argument to a project, against the displayed order (pins +
 * sortMode already applied by allProjects). Accepts, in order of precedence:
 *   - a 1-based index into the visible list ("1" = the top row; with "recent"
 *     sort that's the last-opened, with "manual" sort the visible top);
 *   - an exact (case-insensitive) name;
 *   - a name prefix;
 *   - a name substring.
 */
export function resolveProject(arg: string, cfg: LaunchConfig = loadLaunch()): Project | null {
  const ordered = allProjects(cfg);
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

export function findProject(name: string): Project | null {
  const q = name.toLowerCase();
  return allProjects().find((p) => p.name.toLowerCase() === q) ?? null;
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

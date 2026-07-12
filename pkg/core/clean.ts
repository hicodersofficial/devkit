// clean core — find (and delete) build artifacts across every project, plus
// globally installed packages.
//
// Pure logic, no UI. Artifacts are discovered under the shared scan roots
// (~/.devkit.json `scanRoots` — the same folders launch scans). A root's
// launch-side `exclude` list is deliberately IGNORED here: hiding a project
// from the launcher doesn't make its node_modules less worth reclaiming.
//
// Sizing is the expensive part (a node_modules holds 50k-200k files), so it is
// separated from discovery: scanArtifacts() is a cheap readdir pass that
// returns rows immediately, and sizeArtifacts() walks the trees afterwards on a
// small concurrency pool, reporting each result through a callback so a UI can
// fill sizes in progressively.

import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { loadScanRoots, type ScanRoot } from "./launch";
import { listListeners } from "./killport";
import { readProcessCwd } from "./appname";
import { runCapture } from "./proc";

/** Directory names that are safely regenerable build/dependency output. */
export const ARTIFACT_KINDS = [
  "node_modules",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  ".pytest_cache",
  "coverage",
] as const;

export interface Artifact {
  kind: string; // "node_modules", ".next", ...
  project: string; // display name ("app" or "app/web" for a subpackage)
  dir: string; // project directory that owns the artifact
  path: string; // full path of the artifact directory itself
  mtimeMs: number; // artifact mtime — a cheap "last built" signal
  size?: number; // bytes; filled in later by sizeArtifacts()
  protected?: boolean; // a live process is running inside this project
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function artifactsInProject(dir: string, project: string): Artifact[] {
  const out: Artifact[] = [];
  for (const kind of ARTIFACT_KINDS) {
    const p = join(dir, kind);
    try {
      const st = statSync(p);
      if (st.isDirectory()) out.push({ kind, project, dir, path: p, mtimeMs: st.mtimeMs });
    } catch {
      /* absent */
    }
  }
  return out;
}

/**
 * CHEAP discovery pass: every project folder directly under a scan root, plus
 * one level of subpackages (monorepos), checked for artifact dirs. No sizing.
 */
export function scanArtifacts(roots: ScanRoot[] = loadScanRoots()): Artifact[] {
  const out: Artifact[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(root.path, entry);
      if (!isDir(dir)) continue;
      out.push(...artifactsInProject(dir, entry));
      // One level of subpackages — but never descend into artifact dirs.
      let subs: string[] = [];
      try {
        subs = readdirSync(dir);
      } catch {
        continue;
      }
      for (const sub of subs) {
        if ((ARTIFACT_KINDS as readonly string[]).includes(sub) || sub.startsWith(".")) continue;
        const subDir = join(dir, sub);
        if (!isDir(subDir)) continue;
        out.push(...artifactsInProject(subDir, `${entry}/${sub}`));
      }
    }
  }
  return out;
}

/** Recursive size of a directory (or single file) in bytes. IO-heavy for big
 *  trees — call via sizeArtifacts(). */
export async function sizeDir(path: string): Promise<number> {
  try {
    const st = await lstat(path);
    if (st.isFile()) return st.size; // deno-style single-binary "globals"
  } catch {
    return 0;
  }
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true, recursive: true });
  } catch {
    return 0;
  }
  let total = 0;
  const files = entries.filter((e) => e.isFile());
  // lstat in modest batches — 100k sequential awaits would crawl.
  const BATCH = 64;
  for (let i = 0; i < files.length; i += BATCH) {
    const sizes = await Promise.all(
      files.slice(i, i + BATCH).map(async (e) => {
        try {
          return (await lstat(join(e.parentPath ?? (e as any).path ?? path, e.name))).size;
        } catch {
          return 0;
        }
      }),
    );
    for (const s of sizes) total += s;
  }
  return total;
}

/**
 * Size many paths (artifacts or global packages) on a small pool, reporting
 * each as it lands so the UI can fill the SIZE column progressively.
 */
export async function sizeArtifacts(
  items: { path: string }[],
  onSize: (path: string, bytes: number) => void,
  concurrency = 4,
): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (;;) {
      const a = queue.shift();
      if (!a) return;
      onSize(a.path, await sizeDir(a.path));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

// ---- size cache (validated, not SWR) ----
//
// Walking a node_modules takes long enough that measuring everything on every
// run is wasteful. Sizes are cached in ~/.devkit-cache.json, each entry stamped
// with a VALIDITY KEY; a cached size is trusted (no re-walk) while its key
// still matches:
//   - node_modules  -> hash of the project's lockfile (bun.lock, package-lock,
//     pnpm-lock.yaml, yarn.lock, deno.lock, ...) — deps changed => key changes
//   - other kinds   -> the artifact dir's mtime (rebuilds touch it)
//   - globals       -> the installed version
// Anything with a missing/mismatched key is (re)measured automatically; the UI
// adds manual refresh keys on top for when the user wants ground truth.

const CACHE_PATH = join(homedir(), ".devkit-cache.json");

export interface SizeEntry {
  bytes: number;
  at: number;
  /** Validity fingerprint — cached bytes are trusted only while it matches. */
  key: string;
}

interface DevkitCache {
  sizes?: Record<string, SizeEntry>;
}

function loadCache(): DevkitCache {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as DevkitCache;
  } catch {
    return {};
  }
}

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "deno.lock",
];

/** Validity key for an artifact (see the cache comment above). */
export function artifactKey(a: Artifact): string {
  if (a.kind === "node_modules") {
    for (const lf of LOCKFILES) {
      try {
        const data = readFileSync(join(a.dir, lf));
        return `lock:${Bun.hash(data).toString(16)}`;
      } catch {
        /* try the next lockfile */
      }
    }
  }
  return `mtime:${Math.round(a.mtimeMs)}`;
}

/** Validity key for a global package: its installed version. */
export function globalKey(g: GlobalPkg): string {
  return `ver:${g.manager}@${g.version}`;
}

/** Cached sizes whose validity key still matches — safe to trust, no re-walk. */
export function validCachedSizes(items: { path: string; key: string }[]): Record<string, number> {
  const sizes = loadCache().sizes ?? {};
  const out: Record<string, number> = {};
  for (const it of items) {
    const hit = sizes[it.path];
    if (hit && hit.key === it.key) out[it.path] = hit.bytes;
  }
  return out;
}

/** Merge freshly measured sizes (with their keys) into the cache. */
export function updateSizeCache(fresh: Record<string, { bytes: number; key: string }>): void {
  try {
    const cache = loadCache();
    cache.sizes = cache.sizes ?? {};
    const at = Date.now();
    for (const [path, { bytes, key }] of Object.entries(fresh)) {
      cache.sizes[path] = { bytes, at, key };
    }
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    /* cache is an optimization — losing it only costs a re-measure */
  }
}

/** Drop deleted paths from the cache so they don't ghost-paint next run. */
export function evictSizeCache(paths: string[]): void {
  try {
    const cache = loadCache();
    if (!cache.sizes) return;
    for (const p of paths) delete cache.sizes[p];
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    /* best-effort */
  }
}

/**
 * Working directories of processes currently LISTENING on a port (a dev server,
 * a db). Used to protect their projects from deletion. Limitation: a process
 * with no listening socket (a bare `tsc --watch`) is not seen.
 */
export async function inUseCwds(): Promise<string[]> {
  const listeners = await listListeners();
  const pids = [...new Set(listeners.filter((l) => !l.system).map((l) => l.pid))];
  const cwds = await Promise.all(pids.map((pid) => readProcessCwd(pid).catch(() => null)));
  return cwds.filter((c): c is string => !!c);
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/** Flag artifacts whose project directory contains a live process's cwd. */
export function markProtected(artifacts: Artifact[], cwds: string[]): void {
  const normed = cwds.map(norm);
  for (const a of artifacts) {
    const dir = norm(a.dir);
    a.protected = normed.some((c) => c === dir || c.startsWith(dir + sep));
  }
}

export async function deleteArtifact(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- globally installed packages ----

export type PackageManager = "bun" | "npm" | "pnpm" | "deno";

export interface GlobalPkg {
  name: string;
  version: string;
  manager: PackageManager;
  /** Where the package lives on disk (dir, or a single binary for deno) — lets
   *  the same sizing pool measure globals too. Absent when unresolvable. */
  path?: string;
  /** Package managers themselves (and devkit) can't be uninstalled from here. */
  protected?: boolean;
}

const PROTECTED_GLOBALS = new Set(["npm", "pnpm", "yarn", "corepack", "@hicoders/devkit", "bun", "deno"]);

function markGlobal(
  name: string,
  version: string,
  manager: PackageManager,
  root: string | null,
): GlobalPkg {
  const pkg: GlobalPkg = { name, version, manager, protected: PROTECTED_GLOBALS.has(name) };
  if (root) {
    const p = join(root, ...name.split("/")); // scoped names are nested dirs
    if (isDir(p)) pkg.path = p;
  }
  return pkg;
}

/** List globals across bun/npm/pnpm/deno. Each manager is probed defensively. */
export async function listGlobals(): Promise<GlobalPkg[]> {
  const out: GlobalPkg[] = [];

  // bun: `bun pm ls -g` prints a tree — "├── cowsay@1.6.0". First line is the
  // global install dir ("...global node_modules (N)"), which locates packages.
  const bun = await runCapture(["bun", "pm", "ls", "-g"]);
  if (bun.code === 0) {
    // First line: "C:\Users\me\.bun\install\global node_modules (69)" — the
    // install dir and the literal word node_modules, space-separated.
    const bunRootDefault = join(homedir(), ".bun", "install", "global", "node_modules");
    const firstLine = (bun.stdout.split("\n")[0] ?? "").trim();
    const rootMatch = /^(.+?) node_modules \(\d+\)/.exec(firstLine);
    const bunRoot = rootMatch ? join(rootMatch[1]!, "node_modules") : bunRootDefault;
    for (const line of bun.stdout.split("\n")) {
      const m = /[├└]──\s+(@?[^@\s]+(?:\/[^@\s]+)?)@(\S+)/.exec(line);
      if (m) out.push(markGlobal(m[1]!, m[2]!, "bun", bunRoot));
    }
  }

  // npm: JSON with a dependencies map; `npm root -g` locates them.
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const [npm, npmRootR] = await Promise.all([
    runCapture([npmCmd, "ls", "-g", "--depth=0", "--json"]),
    runCapture([npmCmd, "root", "-g"]),
  ]);
  const npmRoot = npmRootR.code === 0 ? npmRootR.stdout.trim() : null;
  if (npm.stdout.trim()) {
    try {
      const deps = (JSON.parse(npm.stdout).dependencies ?? {}) as Record<string, { version?: string }>;
      for (const [name, info] of Object.entries(deps)) {
        out.push(markGlobal(name, info.version ?? "?", "npm", npmRoot));
      }
    } catch {
      /* unparseable — skip npm section */
    }
  }

  // pnpm: JSON array of trees; `pnpm root -g` locates them.
  const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const [pnpm, pnpmRootR] = await Promise.all([
    runCapture([pnpmCmd, "ls", "-g", "--depth=0", "--json"]),
    runCapture([pnpmCmd, "root", "-g"]),
  ]);
  const pnpmRoot = pnpmRootR.code === 0 ? pnpmRootR.stdout.trim() : null;
  if (pnpm.stdout.trim()) {
    try {
      const trees = JSON.parse(pnpm.stdout) as { dependencies?: Record<string, { version?: string }> }[];
      for (const tree of Array.isArray(trees) ? trees : []) {
        for (const [name, info] of Object.entries(tree.dependencies ?? {})) {
          out.push(markGlobal(name, info.version ?? "?", "pnpm", pnpmRoot));
        }
      }
    } catch {
      /* skip pnpm section */
    }
  }

  // deno: `deno install -g` drops scripts/binaries into ~/.deno/bin (or
  // $DENO_INSTALL_ROOT/bin). No version metadata — group the bin files (foo +
  // foo.cmd on Windows) by stem; size = the largest file (the real binary).
  const denoBin = join(process.env.DENO_INSTALL_ROOT ?? join(homedir(), ".deno"), "bin");
  try {
    const stems = new Map<string, { path: string; size: number }>();
    for (const entry of readdirSync(denoBin)) {
      const full = join(denoBin, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const stem = entry.replace(/\.(cmd|exe|bat|ps1)$/i, "");
      if (stem === "deno") continue; // deno itself
      const prev = stems.get(stem);
      if (!prev || st.size > prev.size) stems.set(stem, { path: full, size: st.size });
    }
    for (const [name, f] of stems) {
      out.push({ name, version: "-", manager: "deno", path: f.path, protected: false });
    }
  } catch {
    /* no deno bin dir — skip */
  }

  out.sort((a, b) => a.name.localeCompare(b.name) || a.manager.localeCompare(b.manager));
  return out;
}

export async function removeGlobal(pkg: GlobalPkg): Promise<{ ok: boolean; error?: string }> {
  const cmd: Record<PackageManager, string[]> = {
    bun: ["bun", "remove", "-g", pkg.name],
    npm: [process.platform === "win32" ? "npm.cmd" : "npm", "uninstall", "-g", pkg.name],
    pnpm: [process.platform === "win32" ? "pnpm.cmd" : "pnpm", "remove", "-g", pkg.name],
    deno: ["deno", "uninstall", "-g", pkg.name],
  };
  const r = await runCapture(cmd[pkg.manager]);
  // Older deno lacks the -g flag — retry the legacy form once.
  if (r.code !== 0 && pkg.manager === "deno") {
    const legacy = await runCapture(["deno", "uninstall", pkg.name]);
    if (legacy.code === 0) return { ok: true };
  }
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || `exit ${r.code}` };
}

// ---- formatting ----

export function fmtBytes(n: number | undefined): string {
  if (n === undefined) return "...";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  for (const u of units) {
    if (v < 1024) return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} PB`;
}

/** A short "how stale is this" from an mtime. */
export function fmtAge(mtimeMs: number, now = Date.now()): string {
  const d = now - mtimeMs;
  if (d < 3600e3) return "just now";
  if (d < 86400e3) return `${Math.round(d / 3600e3)}h ago`;
  if (d < 30 * 86400e3) return `${Math.round(d / 86400e3)}d ago`;
  if (d < 365 * 86400e3) return `${Math.round(d / (30 * 86400e3))}mo ago`;
  return `${Math.round(d / (365 * 86400e3))}y ago`;
}

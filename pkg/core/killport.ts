// killport core — discover TCP listeners and kill processes by PID.
//
// Pure logic only: no terminal UI, no console output. The TUI layer
// (pkg/tui/killport.tsx) and any future GUI both build on these functions.
//
// Cross-platform. How listeners are discovered depends on the OS:
//   - Windows: native `netstat -ano` (port -> pid) joined with one PowerShell
//     `Get-Process` (pid -> name + exe path). Kills via `taskkill`.
//   - Linux:   `ss -tlnp` (port + pid + name in one shot); exe path from
//     /proc/<pid>/exe. Kills via `kill -9`.
//   - macOS:   `lsof -nP -iTCP -sTCP:LISTEN` (port + pid + name). Kills via
//     `kill -9`.
// All external commands are spawned defensively: a missing binary yields an
// empty result instead of throwing, so the picker degrades gracefully.

import { homedir } from "node:os";
import { readlinkSync } from "node:fs";

export type PortCategory = "app" | "service" | "other";

export interface Listener {
  port: number;
  pid: number;
  name: string; // ACTUAL process name from the OS, e.g. "node" — always primary
  path: string | null; // full exe path when readable (null for protected/system)
  system: boolean; // true => protected, must not be killed
  category: PortCategory; // which section this port belongs to
  portLabel?: string; // conventional use of the port, e.g. "MySQL" — hint only
}

export interface KillResult {
  pid: number;
  ok: boolean;
  error?: string;
}

// Conventional uses of well-known ports. This is ONLY used to (a) sort ports
// into sections and (b) show a dim hint — it never overrides the real process
// name, so something other than MySQL on 3306 still shows its true name.
const PORT_CATALOG: Record<number, { label: string; category: "app" | "service" }> = {
  // app / dev servers
  3000: { label: "dev server", category: "app" },
  3001: { label: "dev server", category: "app" },
  4173: { label: "Vite preview", category: "app" },
  4200: { label: "Angular", category: "app" },
  4321: { label: "Astro", category: "app" },
  5000: { label: "dev server", category: "app" },
  8000: { label: "dev server", category: "app" },
  8080: { label: "HTTP alt", category: "app" },
  8081: { label: "HTTP alt", category: "app" },
  1420: { label: "Tauri", category: "app" },
  19006: { label: "Expo", category: "app" },
  // services / infra
  1433: { label: "SQL Server", category: "service" },
  2181: { label: "Zookeeper", category: "service" },
  3306: { label: "MySQL", category: "service" },
  5432: { label: "PostgreSQL", category: "service" },
  5672: { label: "RabbitMQ", category: "service" },
  5984: { label: "CouchDB", category: "service" },
  6379: { label: "Redis", category: "service" },
  9092: { label: "Kafka", category: "service" },
  9200: { label: "Elasticsearch", category: "service" },
  11211: { label: "Memcached", category: "service" },
  27017: { label: "MongoDB", category: "service" },
};

// Inclusive port ranges with a shared conventional use.
const RANGE_CATALOG: { from: number; to: number; label: string; category: "app" | "service" }[] = [
  { from: 5173, to: 5190, label: "Vite", category: "app" },
];

/** Conventional category + label for a port from the catalog (port-only). */
export function portInfo(port: number): { category: "app" | "service" | null; label?: string } {
  const exact = PORT_CATALOG[port];
  if (exact) return exact;
  for (const r of RANGE_CATALOG) {
    if (port >= r.from && port <= r.to) return { category: r.category, label: r.label };
  }
  return { category: null };
}

// Programming-language runtimes / dev tooling. A process with one of these names
// is "something I'm running" → grouped under APPS, regardless of port. (Compiled
// Go/Rust/etc. binaries get an arbitrary exe name, so those are caught instead by
// the dev-path heuristic below.)
const RUNTIME_NAMES = new Set([
  "node", "bun", "deno", "tsx", "ts-node", "nodemon",
  "python", "python3", "pythonw", "py",
  "ruby", "rubyw", "php",
  "java", "javaw", "dotnet",
  "go", "cargo", "rustc", "air",
  "elixir", "erl", "dart", "flutter", "perl",
  "uvicorn", "gunicorn", "hypercorn",
]);

// Database / infrastructure daemons → grouped under SERVICES.
const SERVICE_NAMES = new Set([
  "mysqld", "mariadbd", "postgres", "pg_ctl", "mongod",
  "redis-server", "redis", "memcached", "sqlservr", "oracle",
  "cassandra", "influxd", "couchdb", "rabbitmq", "rabbitmq-server",
  "docker", "dockerd", "com.docker.backend",
]);

// True when an exe lives in one of the user's own dev locations (scoop, .cargo,
// go/bin, project/target dirs, go-build temp) — i.e. something the user built or
// runs themselves. This is what lets a compiled Go/Rust binary with an arbitrary
// name land in APPS. We deliberately exclude the AppData subtree so installed
// Electron/GUI apps (VS Code, Discord, Slack…) don't masquerade as dev servers —
// except AppData\Local\Temp, where `go run` drops its compiled binaries.
const HOME = (homedir() || "").toLowerCase();
function isDevPath(path: string | null): boolean {
  if (!path || !HOME) return false;
  const p = path.toLowerCase();
  if (!p.startsWith(HOME)) return false;
  const rel = p.slice(HOME.length);
  if (rel.includes("\\appdata\\")) return rel.includes("\\appdata\\local\\temp\\");
  return true;
}

/**
 * Decide which section a listener belongs to, from the actual process + port.
 * APPS first (dev runtime name OR a user-owned exe path), so "anything I run"
 * floats to the top; then SERVICES (known daemon name or service port); the
 * catalog is also consulted for the dim port-use hint.
 */
export function classify(p: { port: number; name: string; path: string | null }): {
  category: PortCategory;
  label?: string;
} {
  const name = p.name.toLowerCase();
  const { category: portCat, label } = portInfo(p.port);

  if (RUNTIME_NAMES.has(name) || isDevPath(p.path)) return { category: "app", label };
  if (SERVICE_NAMES.has(name) || portCat === "service") return { category: "service", label };
  if (portCat === "app") return { category: "app", label }; // well-known dev port, unknown proc
  return { category: "other", label };
}

// PIDs / process names that belong to the OS itself. These are flagged
// `system: true` and treated as protected — a "free up my dev port" tool
// should never invite killing core OS processes (their ports are RPC/SMB/etc).
// pid 0/4 are Windows; pid 1 is init/systemd/launchd on POSIX. pid 0 is also
// the sentinel we use when a listener's owner couldn't be resolved.
const SYSTEM_PIDS = new Set([0, 1, 4]);
const SYSTEM_NAMES = new Set([
  // Windows
  "system",
  "idle",
  "system idle process",
  "registry",
  "svchost",
  "lsass",
  "services",
  "wininit",
  "winlogon",
  "csrss",
  "smss",
  "spoolsv",
  // POSIX
  "systemd",
  "init",
  "launchd",
]);

// One Get-Process call maps every pid to its name + exe path as compact JSON.
// `Path` is null for processes we can't open (system / other-session) — a useful
// "don't touch this" signal that also keeps them out of APPS.
const PS_PROCS = "Get-Process | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress";

interface ProcRow {
  Id: number;
  ProcessName: string | null;
  Path: string | null;
}

// Run a command and capture its output. A missing executable (Bun.spawn throws
// "Executable not found in $PATH") is turned into a non-zero result rather than
// propagating, so a tool absent on this OS just yields no rows.
async function runCapture(cmd: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  } catch (e) {
    return { stdout: "", stderr: e instanceof Error ? e.message : String(e), code: -1 };
  }
}

// Try each command in turn, returning the first that runs (exit code 0). Used to
// probe alternative binary locations (e.g. ss in /usr/sbin vs /usr/bin).
async function firstCapture(cmds: string[][]): Promise<string> {
  for (const cmd of cmds) {
    const r = await runCapture(cmd);
    if (r.code === 0) return r.stdout;
  }
  return "";
}

function isSystem(pid: number, name: string): boolean {
  return SYSTEM_PIDS.has(pid) || SYSTEM_NAMES.has(name.toLowerCase());
}

// Parse `netstat -ano` rows into { port, pid }, keeping only TCP LISTENING.
// Rows look like: "  TCP    0.0.0.0:135   0.0.0.0:0   LISTENING   2216"
// IPv6 rows are "  TCP    [::1]:5178   [::]:0   LISTENING   3144" (also "TCP").
// UDP rows have no state column (4 fields) so they're filtered out below.
function parseNetstat(out: string): { port: number; pid: number }[] {
  const rows: { port: number; pid: number }[] = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
    const local = parts[1]!;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(port) && Number.isInteger(pid)) rows.push({ port, pid });
  }
  return rows;
}

// Parse the Get-Process JSON into a pid → { name, path } map.
function parseProcs(out: string): Map<number, { name: string; path: string | null }> {
  const map = new Map<number, { name: string; path: string | null }>();
  const raw = out.trim();
  if (!raw) return map;
  let parsed: ProcRow | ProcRow[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
    if (r && typeof r.Id === "number") {
      map.set(r.Id, { name: r.ProcessName ?? "(unknown)", path: r.Path ?? null });
    }
  }
  return map;
}

// A raw listener row before classification: just where + who.
interface RawListener {
  port: number;
  pid: number;
  name: string;
  path: string | null;
}

// ---- Windows: netstat -ano joined with one Get-Process ----
async function collectWindows(): Promise<RawListener[]> {
  // Plain `netstat -ano` (no `-p TCP`!) on purpose: `-p TCP` lists only IPv4,
  // dropping IPv6-only listeners like Vite/Node on [::1]. Both IPv4 and IPv6 TCP
  // rows are labelled "TCP" by netstat, so the parser handles both.
  const [net, procs] = await Promise.all([
    runCapture(["netstat", "-ano"]).then((r) => parseNetstat(r.stdout)),
    runCapture(["powershell", "-NoProfile", "-NonInteractive", "-Command", PS_PROCS]).then((r) =>
      parseProcs(r.stdout),
    ),
  ]);
  return net.map(({ port, pid }) => {
    const proc = procs.get(pid);
    return { port, pid, name: proc?.name ?? "(unknown)", path: proc?.path ?? null };
  });
}

// ---- Linux: ss -tlnp (port + pid + name); exe path from /proc/<pid>/exe ----
function readExe(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

// ss rows: `LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=20))`
// Columns: State Recv-Q Send-Q Local Peer [Process]. The Process column may hold
// several ("name",pid=N,...) tuples, or be absent for sockets we can't inspect.
function parseSs(out: string): RawListener[] {
  const rows: RawListener[] = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("LISTEN")) continue; // skips the header and non-listening rows
    const parts = t.split(/\s+/);
    const local = parts[3] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port)) continue;
    const procPart = parts.slice(5).join(" ");
    const matches = [...procPart.matchAll(/"([^"]+)",pid=(\d+)/g)];
    if (matches.length === 0) {
      rows.push({ port, pid: 0, name: "(unknown)", path: null }); // owner not visible
    } else {
      for (const m of matches) {
        const pid = Number(m[2]);
        rows.push({ port, pid, name: m[1]!, path: readExe(pid) });
      }
    }
  }
  return rows;
}

async function collectLinux(): Promise<RawListener[]> {
  // ss ships with iproute2 but isn't always on a non-login PATH; probe the usual
  // locations. (We intentionally don't fall back to the deprecated net-tools
  // `netstat`, which is absent on many modern distros.)
  const out = await firstCapture([
    ["ss", "-tlnp"],
    ["/usr/sbin/ss", "-tlnp"],
    ["/sbin/ss", "-tlnp"],
    ["/usr/bin/ss", "-tlnp"],
  ]);
  return parseSs(out);
}

// ---- macOS: lsof ----
// lsof rows: `node 1234 user 20u IPv4 0x.. 0t0 TCP *:3000 (LISTEN)`. The address
// is the token right before "(LISTEN)"; COMMAND/PID are the first two columns.
function parseLsof(out: string): RawListener[] {
  const rows: RawListener[] = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("COMMAND")) continue;
    const parts = t.split(/\s+/);
    const pid = Number(parts[1]);
    if (!Number.isInteger(pid)) continue;
    const li = parts.indexOf("(LISTEN)");
    const addr = (li > 0 ? parts[li - 1] : parts[parts.length - 1]) ?? "";
    const port = Number(addr.slice(addr.lastIndexOf(":") + 1));
    if (!Number.isInteger(port)) continue;
    rows.push({ port, pid, name: parts[0]!, path: null });
  }
  return rows;
}

async function collectDarwin(): Promise<RawListener[]> {
  const out = await firstCapture([
    ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"],
    ["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN"],
  ]);
  return parseLsof(out);
}

async function collectListeners(): Promise<RawListener[]> {
  switch (process.platform) {
    case "win32":
      return collectWindows();
    case "linux":
      return collectLinux();
    case "darwin":
      return collectDarwin();
    default:
      return [];
  }
}

/** All TCP ports currently in the LISTEN state, sorted by port then pid. */
export async function listListeners(): Promise<Listener[]> {
  const raw = await collectListeners();

  const seen = new Set<string>();
  const listeners: Listener[] = [];
  for (const { port, pid, name, path } of raw) {
    const key = `${port}:${pid}`;
    if (seen.has(key)) continue; // collapse IPv4 + IPv6 duplicates of the same socket
    seen.add(key);
    const { category, label } = classify({ port, name, path });
    listeners.push({
      port,
      pid,
      name,
      path,
      system: isSystem(pid, name),
      category,
      portLabel: label,
    });
  }
  listeners.sort((a, b) => a.port - b.port || a.pid - b.pid);
  return listeners;
}

/** Listeners bound to a specific port. */
export async function listenersForPort(port: number): Promise<Listener[]> {
  return (await listListeners()).filter((l) => l.port === port);
}

/** Force-kill a process by PID — `taskkill /F /T` on Windows (kills the tree),
 *  `kill -9` on POSIX. */
export async function killPid(pid: number): Promise<KillResult> {
  const cmd =
    process.platform === "win32"
      ? ["taskkill", "/PID", String(pid), "/F", "/T"]
      : ["kill", "-9", String(pid)];
  const { stderr, code } = await runCapture(cmd);
  if (code === 0) return { pid, ok: true };
  return { pid, ok: false, error: stderr.trim() || `kill exited with code ${code}` };
}

/** Parse CLI args into a unique, sorted list of valid port numbers (1-65535). */
export function parsePorts(args: string[]): number[] {
  const ports = new Set<number>();
  for (const a of args) {
    if (a.startsWith("-")) continue; // skip flags such as -y / --yes
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.add(n);
  }
  return [...ports].sort((a, b) => a - b);
}

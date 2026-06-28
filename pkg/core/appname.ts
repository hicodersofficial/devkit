// appname — resolve a friendly app name for a process by reading its working
// directory and walking up to the nearest project file.
//
// "node"/"bun"/"python" tell you the runtime, not which app. The app's project
// dir is the process's current directory (dev servers are launched from the
// project), so we read the cwd and look upward for a project manifest:
//   package.json (name) · Cargo.toml · pyproject.toml · go.mod
//
// Getting another process's cwd is OS-specific:
//   - Windows (x64): read it from the process PEB via bun:ffi
//   - Linux:        readlink /proc/<pid>/cwd
//   - macOS:        lsof -a -p <pid> -d cwd
// For processes we can't inspect (elevated / other user) this returns null and
// the caller just shows the runtime name. Results are cached per pid per session.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { basename, dirname } from "node:path";
import { readlinkSync } from "node:fs";
import { tomlName } from "./manifest";

// ---- native plumbing (lazy + guarded so importing never throws) ----

function initNative() {
  const k32 = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    ReadProcessMemory: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const ntdll = dlopen("ntdll.dll", {
    NtQueryInformationProcess: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  return {
    OpenProcess: k32.symbols.OpenProcess,
    ReadProcessMemory: k32.symbols.ReadProcessMemory,
    CloseHandle: k32.symbols.CloseHandle,
    NtQueryInformationProcess: ntdll.symbols.NtQueryInformationProcess,
  };
}

let nativeInit = false;
let native: ReturnType<typeof initNative> | null = null;

function getNative() {
  if (nativeInit) return native;
  nativeInit = true;
  if (process.platform !== "win32" || process.arch !== "x64") return (native = null);
  try {
    native = initNative();
  } catch {
    native = null;
  }
  return native;
}

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;

// PEB walk offsets (x64): PROCESS_BASIC_INFORMATION.PebBaseAddress @ 0x08,
// PEB.ProcessParameters @ 0x20, RTL_USER_PROCESS_PARAMETERS.CurrentDirectory
// (a UNICODE_STRING: Length @ 0x00, Buffer @ 0x08) @ 0x38.
function readCwdWindows(pid: number): string | null {
  const n = getNative();
  if (!n) return null;
  const h = n.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
  if (!h) return null;
  try {
    const scratch = new Uint8Array(8);
    const rpm = (addr: bigint, size: number): Uint8Array | null => {
      const out = new Uint8Array(size);
      const ok = n.ReadProcessMemory(h, addr, ptr(out), BigInt(size), ptr(scratch));
      return ok ? out : null;
    };
    const u64 = (b: Uint8Array, off = 0) => new DataView(b.buffer).getBigUint64(off, true);

    const pbi = new Uint8Array(48);
    if (n.NtQueryInformationProcess(h, 0, ptr(pbi), 48, ptr(scratch)) !== 0) return null;
    const ppBuf = rpm(u64(pbi, 8) + 0x20n, 8);
    if (!ppBuf) return null;
    const cur = rpm(u64(ppBuf) + 0x38n, 16);
    if (!cur) return null;
    const len = new DataView(cur.buffer).getUint16(0, true);
    if (!len) return null;
    const strBuf = rpm(u64(cur, 8), len);
    if (!strBuf) return null;
    const cwd = Buffer.from(strBuf).toString("utf16le").replace(/\\+$/, "");
    return cwd || null;
  } catch {
    return null;
  } finally {
    n.CloseHandle(h);
  }
}

function readCwdLinux(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`) || null;
  } catch {
    return null;
  }
}

async function readCwdDarwin(pid: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of out.split("\n")) if (line.startsWith("n")) return line.slice(1).trim() || null;
    return null;
  } catch {
    return null;
  }
}

/** Current working directory of another process, or null if unavailable. */
export async function readProcessCwd(pid: number): Promise<string | null> {
  switch (process.platform) {
    case "win32":
      return readCwdWindows(pid);
    case "linux":
      return readCwdLinux(pid);
    case "darwin":
      return readCwdDarwin(pid);
    default:
      return null;
  }
}

// ---- name resolution (cached per pid for the session) ----

const cache = new Map<number, string | null>();

async function tryRead(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

// If `dir` holds a known project manifest, return its app name (or the folder
// name as a fallback); return null when there's no manifest here.
async function nameFromManifest(dir: string): Promise<string | null> {
  const base = dir.replace(/\\/g, "/");
  const folder = basename(dir);

  const pj = await tryRead(`${base}/package.json`);
  if (pj !== null) {
    try {
      const n = JSON.parse(pj)?.name;
      if (typeof n === "string" && n) return n;
    } catch {
      /* malformed package.json — fall through to folder name */
    }
    return folder;
  }

  const cargo = await tryRead(`${base}/Cargo.toml`);
  if (cargo !== null) return tomlName(cargo, "package") ?? folder;

  const py = await tryRead(`${base}/pyproject.toml`);
  if (py !== null) return tomlName(py, "project") ?? tomlName(py, "tool\\.poetry") ?? folder;

  const gomod = await tryRead(`${base}/go.mod`);
  if (gomod !== null) {
    const m = gomod.match(/^\s*module\s+(\S+)/m);
    return m ? m[1]!.split("/").pop()! : folder;
  }

  return null;
}

async function projectNameAbove(startDir: string): Promise<string | null> {
  let dir = startDir;
  for (let i = 0; i < 8 && dir; i++) {
    const name = await nameFromManifest(dir);
    if (name) return name;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Friendly app name for a process (from package.json / Cargo.toml /
 * pyproject.toml / go.mod, or the project folder), or null if it can't be
 * determined. Cached per pid for the session.
 */
export async function resolveAppName(pid: number): Promise<string | null> {
  if (cache.has(pid)) return cache.get(pid)!;
  let name: string | null = null;
  const cwd = await readProcessCwd(pid);
  if (cwd) name = await projectNameAbove(cwd);
  cache.set(pid, name);
  return name;
}

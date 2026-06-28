// manifest — read project manifests to derive a project's name and its runnable
// commands. Shared by pkg/core/appname.ts (name lookup for a running process)
// and pkg/core/launch.ts (command discovery for the launcher).
//
// Supported manifests: package.json (scripts), Cargo.toml, go.mod, pyproject.toml.
// Pure logic, no UI. Detection is synchronous (cheap file reads) so the launcher
// can scan many folders in one pass.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** A runnable command detected from a folder's manifest. */
export interface DetectedCommand {
  label: string; // e.g. "dev", "build", "run"
  command: string; // full shell command, e.g. "bun run dev", "cargo run"
  cwd: string; // the folder the command runs in
}

/** Pull `name = "..."` from a TOML `[section]` (section is a regex fragment). */
export function tomlName(toml: string, section: string): string | null {
  const sec = toml.match(new RegExp(`\\[${section}\\]([\\s\\S]*?)(?:\\n\\[|$)`));
  const m = sec?.[1].match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return m ? m[1]! : null;
}

/** Keys of a TOML table `[section]` (the `foo` in `foo = "..."`). */
function tomlTableKeys(toml: string, section: string): string[] {
  const sec = toml.match(new RegExp(`\\[${section}\\]([\\s\\S]*?)(?:\\n\\[|$)`));
  if (!sec) return [];
  const keys: string[] = [];
  for (const line of sec[1]!.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

function read(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Package manager for a JS project, inferred from its lockfile (default bun). */
export function detectPm(dir: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  return "bun";
}

/** Project name from a folder's manifest, or the folder name as a fallback. */
export function manifestName(dir: string): string | null {
  const pj = read(join(dir, "package.json"));
  if (pj !== null) {
    try {
      const n = JSON.parse(pj)?.name;
      if (typeof n === "string" && n) return n;
    } catch {
      /* malformed — fall through to folder name */
    }
    return basename(dir);
  }
  const cargo = read(join(dir, "Cargo.toml"));
  if (cargo !== null) return tomlName(cargo, "package") ?? basename(dir);
  const py = read(join(dir, "pyproject.toml"));
  if (py !== null) return tomlName(py, "project") ?? tomlName(py, "tool\\.poetry") ?? basename(dir);
  const gomod = read(join(dir, "go.mod"));
  if (gomod !== null) {
    const m = gomod.match(/^\s*module\s+(\S+)/m);
    return m ? m[1]!.split("/").pop()! : basename(dir);
  }
  return null;
}

/**
 * Runnable commands found directly in `dir` (not its sub-packages):
 *   - package.json `scripts` → `<pm> run <name>` for each
 *   - Cargo.toml            → `cargo run`
 *   - go.mod                → `go run .`
 *   - pyproject.toml        → `poetry run <name>` for each [project.scripts] /
 *                             [tool.poetry.scripts] entry
 * Returns [] when the folder has no recognized, runnable manifest.
 */
export function detectCommandsInDir(dir: string): DetectedCommand[] {
  const out: DetectedCommand[] = [];

  const pj = read(join(dir, "package.json"));
  if (pj !== null) {
    try {
      const scripts = JSON.parse(pj)?.scripts as Record<string, string> | undefined;
      if (scripts) {
        const pm = detectPm(dir);
        for (const name of Object.keys(scripts)) {
          out.push({ label: name, command: `${pm} run ${name}`, cwd: dir });
        }
      }
    } catch {
      /* malformed package.json — no scripts */
    }
  }

  if (existsSync(join(dir, "Cargo.toml"))) {
    out.push({ label: "run", command: "cargo run", cwd: dir });
  }
  if (existsSync(join(dir, "go.mod"))) {
    out.push({ label: "run", command: "go run .", cwd: dir });
  }

  const py = read(join(dir, "pyproject.toml"));
  if (py !== null) {
    const keys = [
      ...tomlTableKeys(py, "project\\.scripts"),
      ...tomlTableKeys(py, "tool\\.poetry\\.scripts"),
    ];
    for (const key of keys) out.push({ label: key, command: `poetry run ${key}`, cwd: dir });
  }

  return out;
}

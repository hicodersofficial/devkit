#!/usr/bin/env bun
// EGP project launcher — interactive menu to start a project's dev services.
// Run from HOME:  bun pkg/egp.ts   (or double-click egp.bat)
//
// Navigate: Up/Down or j/k   Select: Enter   Quit: q / Esc / Ctrl-C
//
// It scans APPS_DIR for projects. A "project" is either:
//   - a folder whose own package.json has a `dev` (or `start`) script, or
//   - a folder containing sub-packages (frontend + backend) that each have one.
// All matching dev services for the chosen project are started together.

import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const APPS_DIR = "G:\\EGP\\Apps";

// Folders to ignore (dummies, duplicates, infra, libraries).
const EXCLUDE = new Set<string>([
  "LRDP-leak",
  "ghg-old",
  "frappe_docker",
  "infra",
  "local-infra",
  "form-builder",
  "Sustainatrix",
  "hrms",
  "AMR",
  ".vscode",
  "node_modules",
]);

type Scripts = Record<string, string>;

interface Service {
  label: string;
  cwd: string;
  script: string;
}

interface Project {
  name: string;
  services: Service[];
}

function readScripts(dir: string): Scripts | null {
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return null;
  try {
    return (JSON.parse(readFileSync(pkg, "utf8")).scripts as Scripts) || {};
  } catch {
    return {};
  }
}

function devScript(scripts: Scripts | null): string | null {
  if (!scripts) return null;
  if (scripts.dev) return "dev";
  if (scripts.start) return "start";
  return null;
}

// Returns list of { name, services: [{ label, cwd, script }] }
function discover(): Project[] {
  const projects: Project[] = [];
  for (const entry of readdirSync(APPS_DIR)) {
    if (EXCLUDE.has(entry)) continue;
    const dir = join(APPS_DIR, entry);
    let isDir: boolean;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    // Case 1: root package.json defines the dev entry (monorepo / concurrently).
    const rootDev = devScript(readScripts(dir));
    if (rootDev) {
      projects.push({
        name: entry,
        services: [{ label: entry, cwd: dir, script: rootDev }],
      });
      continue;
    }

    // Case 2: sub-packages (frontend + backend) each with a dev script.
    const services: Service[] = [];
    let subEntries: string[] = [];
    try {
      subEntries = readdirSync(dir);
    } catch {
      /* ignore */
    }
    for (const sub of subEntries) {
      if (sub === "node_modules") continue;
      const subDir = join(dir, sub);
      try {
        if (!statSync(subDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const s = devScript(readScripts(subDir));
      if (s) services.push({ label: sub, cwd: subDir, script: s });
    }
    if (services.length) {
      // Start backend before frontend when both are present.
      services.sort((a, b) => {
        const rank = (l: string) => (/server|service|backend|api/i.test(l) ? 0 : 1);
        return rank(a.label) - rank(b.label);
      });
      projects.push({ name: entry, services });
    }
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

// ---------- interactive menu ----------
const ESC = "\x1b";
const C = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  cyan: `${ESC}[36m`,
  green: `${ESC}[32m`,
  bold: `${ESC}[1m`,
  inv: `${ESC}[7m`,
};

function render(shown: Project[], idx: number, filtering: boolean, query: string): string {
  const lines: string[] = [];
  const hint = filtering
    ? `${C.dim}- type to filter, Enter to start, Esc/Backspace to clear${C.reset}`
    : `${C.dim}- Up/Down or j/k, / to find, Enter to start, q to quit${C.reset}`;
  lines.push(`${C.bold}${C.cyan}EGP launcher${C.reset} ${hint}`);
  if (filtering) lines.push(`${C.cyan}/${C.reset}${query}${C.dim}_${C.reset}`);
  else lines.push("");
  if (!shown.length) {
    lines.push(`${C.dim}    (no match)${C.reset}`);
  }
  shown.forEach((p, i) => {
    const svc = p.services.map((s) => s.label).join(" + ");
    if (i === idx)
      lines.push(`${C.green}> ${C.inv} ${p.name} ${C.reset}${C.dim} (${svc})${C.reset}`);
    else lines.push(`    ${p.name}  ${C.dim}(${svc})${C.reset}`);
  });
  return lines.join("\n");
}

function filterProjects(projects: Project[], query: string): Project[] {
  if (!query) return projects;
  const q = query.toLowerCase();
  return projects.filter((p) => p.name.toLowerCase().includes(q));
}

function menu(projects: Project[]): Promise<Project | null> {
  return new Promise((resolve) => {
    let idx = 0;
    let filtering = false;
    let query = "";
    const out = process.stdout;
    const stdin = process.stdin;
    let prevLines = 0;

    const visible = () => filterProjects(projects, query);

    const draw = () => {
      const shown = visible();
      if (idx >= shown.length) idx = Math.max(0, shown.length - 1);
      if (prevLines) out.write(`${ESC}[${prevLines}A`);
      const text = render(shown, idx, filtering, query);
      out.write(`${ESC}[0J`); // clear from cursor down
      out.write(text + "\n");
      prevLines = text.split("\n").length;
    };

    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    out.write(`${ESC}[?25l`); // hide cursor
    draw();

    const cleanup = () => {
      out.write(`${ESC}[?25h`); // show cursor
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (key: string) => {
      const shown = visible();

      if (key === "\x03") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        if (shown.length) {
          cleanup();
          resolve(shown[idx]);
        }
        return;
      }

      // Esc: leave filter mode (clearing it) or quit.
      if (key === ESC) {
        if (filtering || query) {
          filtering = false;
          query = "";
          idx = 0;
        } else {
          cleanup();
          resolve(null);
          return;
        }
        draw();
        return;
      }

      // Enter filter mode.
      if (!filtering && (key === "/" || key === "f")) {
        filtering = true;
        query = "";
        idx = 0;
        draw();
        return;
      }

      const up = key === `${ESC}[A` || (!filtering && key === "k");
      const down = key === `${ESC}[B` || (!filtering && key === "j");
      if (up || down) {
        if (shown.length) {
          if (up) idx = (idx - 1 + shown.length) % shown.length;
          else idx = (idx + 1) % shown.length;
          draw();
        }
        return;
      }

      if (filtering) {
        if (key === "\x7f" || key === "\b") {
          query = query.slice(0, -1); // backspace
          idx = 0;
          draw();
          return;
        }
        // printable char
        if (key.length === 1 && key >= " ") {
          query += key;
          idx = 0;
          draw();
        }
        return;
      }

      // Not filtering: q quits.
      if (key === "q") {
        cleanup();
        resolve(null);
      }
    };

    stdin.on("data", onData);
  });
}

function start(project: Project): void {
  console.log(`\n${C.bold}Starting ${C.cyan}${project.name}${C.reset}${C.bold} ...${C.reset}\n`);
  const children: ReturnType<typeof spawn>[] = [];
  for (const svc of project.services) {
    console.log(
      `${C.green}>${C.reset} ${svc.label}: bun run ${svc.script}  ${C.dim}(${svc.cwd})${C.reset}`
    );
    const child = spawn("bun", ["run", svc.script], {
      cwd: svc.cwd,
      stdio: "inherit",
      shell: true,
    });
    children.push(child);
  }
  const killAll = () => children.forEach((c) => c.kill());
  process.on("SIGINT", () => {
    killAll();
    process.exit(0);
  });
}

const projects = discover();
if (!projects.length) {
  console.error(`No runnable projects found in ${APPS_DIR}`);
  process.exit(1);
}
const chosen = await menu(projects);
if (!chosen) {
  console.log("Cancelled.");
  process.exit(0);
}
start(chosen);

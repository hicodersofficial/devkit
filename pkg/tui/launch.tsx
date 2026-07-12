#!/usr/bin/env bun
// launch - interactive launcher for your dev projects.
//
//   launch          pick a project; Enter starts its default command(s) with
//                   logs streaming to this terminal. Ctrl-C stops them.
//   launch <name>   start that project's defaults directly (scriptable).
//
// Projects come from scan roots (folders auto-scanned each run) and manually
// added entries, all persisted in ~/.devkit.json. Press `a` on a project to run
// an ad-hoc subset of its commands; `n` to add a project (auto-detect or by
// hand); `e`/`d` to edit/delete; `s` to manage scan roots.
//
// UI logic only; discovery/config/spawning lives in pkg/core/launch.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { basename } from "node:path";
import { mountScreen } from "./app";
import { useTheme } from "./theme-context";
import { Header, ListSelect, Confirm, Help, TextPrompt, type Binding } from "./components";
import {
  allProjects,
  scanProjects,
  orderProjects,
  loadLaunch,
  saveLaunch,
  addProject,
  updateProject,
  removeProject,
  adoptProject,
  excludeFromScan,
  includeInScan,
  scanFolder,
  recordLastRun,
  lastRunLabels,
  addScanRoot,
  removeScanRoot,
  detectProjectCommands,
  defaultCommands,
  suggestName,
  newId,
  newCommand,
  resolveProject,
  startCommands,
  type Command,
  type Project,
  type ScanRoot,
  type SortMode,
  type LaunchConfig,
} from "../core/launch";

const HELP: Binding[] = [
  { keys: "", desc: "Move & run" },
  { keys: "j / k", desc: "move the highlight (or arrow keys)" },
  { keys: "enter", desc: "start the project's default command(s)" },
  { keys: "a", desc: "pick commands to run (pre-marks your last run)" },
  { keys: "/", desc: "filter projects" },
  { keys: "", desc: "Organize the list" },
  { keys: "p", desc: "pin / unpin (PINNED stays on top)" },
  { keys: "[ ]", desc: "move project up / down (switches to manual sort)" },
  { keys: "o", desc: "sort: manual order or last run (recent first)" },
  { keys: "", desc: "Add, edit & remove projects" },
  { keys: "n", desc: "add a project (auto-detect a folder or by hand)" },
  { keys: "e", desc: "edit (rename / defaults / commands; adopts a scanned one)" },
  { keys: "d", desc: "delete a manual project, or hide a scanned one" },
  { keys: "s", desc: "scan folders - add/remove roots, un-hide hidden projects" },
  { keys: "r", desc: "rescan the folders now" },
  { keys: "", desc: "General" },
  { keys: "t", desc: "cycle color theme" },
  { keys: "h", desc: "show / hide this help" },
  { keys: "q / esc esc", desc: "quit (q, or Esc twice)" },
];

// Help shown on the scan-roots management screen.
const SCAN_HELP: Binding[] = [
  { keys: "j / k", desc: "move (or arrow keys)" },
  { keys: "enter", desc: "manage this root's hidden (excluded) projects" },
  { keys: "n", desc: "add a scan folder (auto-lists projects under it)" },
  { keys: "d", desc: "remove the highlighted scan root (keeps your files)" },
  { keys: "h", desc: "show / hide this help" },
  { keys: "esc / q", desc: "back to the project list" },
];

type Mode =
  | "list"
  | "run"
  | "add"
  | "auto-path"
  | "auto-pick"
  | "auto-name"
  | "auto-default"
  | "manual-name"
  | "manual-label"
  | "manual-command"
  | "manual-cwd"
  | "manual-more"
  | "manual-default"
  | "edit"
  | "edit-rename"
  | "edit-default"
  | "edit-remove"
  | "delete"
  | "scan"
  | "scan-add"
  | "scan-excludes";

interface Draft {
  name: string;
  commands: Command[];
}

interface MenuItem {
  id: string;
  label: string;
  desc: string;
}

// Default-command guess for the include/default pickers: dev/start commands, or
// everything when none look like a start script.
function guessDefaultIds(cmds: Command[]): string[] {
  const ids = cmds
    .filter((c) => {
      const base = c.label.split(":").pop();
      return base === "dev" || base === "start";
    })
    .map((c) => c.id);
  return ids.length ? ids : cmds.map((c) => c.id);
}

function sectionLabelFor(id: string): string {
  if (id === "pinned") return "* PINNED";
  return id === "manual" ? "PROJECTS" : `SCANNED | ${basename(id) || id}`;
}

// Pad/truncate to exactly `w` chars, always leaving >=1 trailing space as a gap.
// When truncating, "..." (3 chars) replaces the tail, kept within w-1.
const fit = (s: string, w: number) => {
  if (s.length <= w - 1) return s.padEnd(w);
  return (s.slice(0, Math.max(0, w - 4)) + "...").padEnd(w);
};

// A section header (PROJECTS / SCANNED | x / ★ PINNED) that also labels the
// scripts column on its right, aligned to where each row's "▸ scripts" begins
// (the 2-char row gutter + the name column width). No separate header row.
function sectionHeader(id: string, nameWidth: number): string {
  const label = sectionLabelFor(id);
  const pad = Math.max(2 + nameWidth, label.length + 2);
  return label.padEnd(pad) + "SCRIPTS";
}

function ProjectRow({ p, selected, nameWidth }: { p: Project; selected: boolean; nameWidth: number }) {
  const theme = useTheme();
  const defs = defaultCommands(p)
    .map((c) => c.label)
    .join(", ");
  return (
    <text>
      <span fg={selected ? theme.selFg : theme.fg}>{fit(p.name, nameWidth)}</span>
      <span fg={theme.dim}>{`> ${defs}`}</span>
    </text>
  );
}

function CommandRow({ c, selected }: { c: Command; selected: boolean }) {
  const theme = useTheme();
  return (
    <text>
      <span fg={selected ? theme.selFg : theme.fg}>{fit(c.label, 26)}</span>
      <span fg={theme.dim}>{c.command}</span>
    </text>
  );
}

function MenuRow({ m, selected }: { m: MenuItem; selected: boolean }) {
  const theme = useTheme();
  return (
    <text>
      <span fg={selected ? theme.selFg : theme.fg}>{m.label.padEnd(28)}</span>
      <span fg={theme.dim}>{m.desc}</span>
    </text>
  );
}

const ADD_MENU: MenuItem[] = [
  { id: "auto", label: "Auto-detect from a folder", desc: "find scripts in package.json, go.mod, Cargo.toml, pyproject.toml" },
  { id: "manual", label: "Add manually", desc: "enter a name and commands by hand" },
  { id: "scan", label: "Add a scan folder", desc: "auto-list every project under a folder" },
];

const EDIT_MENU: MenuItem[] = [
  { id: "rename", label: "Rename", desc: "change the project name" },
  { id: "default", label: "Set default command(s)", desc: "what Enter starts" },
  { id: "remove", label: "Remove a command", desc: "drop one or more commands" },
  { id: "back", label: "Back", desc: "return to the project list" },
];

export function LaunchScreen({
  onChoose,
  initialProject = null,
}: {
  onChoose: (cmds: Command[] | null) => void;
  /** Open straight on this project's command picker (the `a` page) instead of the
   *  project list — used by `launch <name> -a`. Esc still falls back to the list. */
  initialProject?: Project | null;
}) {
  const theme = useTheme();
  const [cfg, setCfg] = useState(() => loadLaunch());
  // Raw scanned projects (expensive filesystem read) - refreshed only on mount,
  // `r`, and structural changes (add/edit/delete/scan roots). Pin/reorder/sort
  // never re-scan; they just re-order this list in memory, so they're instant.
  const [raw, setRaw] = useState<Project[]>(() => scanProjects());
  const [mode, setMode] = useState<Mode>(initialProject ? "run" : "list");
  const [showHelp, setShowHelp] = useState(false);
  const [status, setStatus] = useState("");
  const [seq, setSeq] = useState(0); // bumped on transitions to remount TextPrompt
  const [target, setTarget] = useState<Project | null>(initialProject);
  const [scanTarget, setScanTarget] = useState<ScanRoot | null>(null);
  const [draft, setDraft] = useState<Draft>({ name: "", commands: [] });
  const [pendingCmd, setPendingCmd] = useState({ label: "", command: "", cwd: "" });

  const projects = useMemo(() => orderProjects(raw, cfg), [raw, cfg]);

  // Width of the NAME column so the "▸ defaults" column lines up across all
  // rows; sized to the longest name (capped) plus a 2-space gap.
  const nameWidth = useMemo(
    () => Math.min(32, Math.max(12, ...projects.map((p) => p.name.length))) + 2,
    [projects],
  );

  // cfg/raw mirrored in refs so rapid keypresses read the latest value without
  // waiting for a re-render (otherwise spamming [ / ] would use stale state).
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const rawRef = useRef(raw);
  rawRef.current = raw;

  // Persistence is debounced off the keypress path: pin/reorder/sort update state
  // instantly (so the highlight follows immediately) and the JSON file is written
  // ~400ms after the last change. Writing on every keypress is what caused the
  // intermittent lag (Windows file scanning blocking the render thread).
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<LaunchConfig | null>(null);
  const flushPersist = () => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
    }
    if (pending.current) {
      saveLaunch(pending.current);
      pending.current = null;
    }
  };
  const schedulePersist = (next: LaunchConfig) => {
    pending.current = next;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(flushPersist, 400);
  };
  // Apply an in-memory config change instantly and persist it lazily.
  const applyCfg = (next: LaunchConfig) => {
    cfgRef.current = next;
    setCfg(next);
    schedulePersist(next);
  };
  // Flush any pending write when the screen unmounts.
  useEffect(() => () => flushPersist(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Expensive: re-read config AND re-scan the filesystem (structural changes).
  // Flush first so the fresh read includes any pending in-memory edits.
  const rescan = () => {
    flushPersist();
    const c = loadLaunch();
    cfgRef.current = c;
    setCfg(c);
    const r = scanProjects(c);
    rawRef.current = r;
    setRaw(r);
  };
  // Run a disk-mutating core op (add/edit/delete/scan root) then re-scan.
  const structural = (fn: () => void) => {
    flushPersist();
    fn();
    rescan();
  };
  const go = (next: Mode) => {
    // Persist any pending in-memory edits before a screen transition, so the
    // disk-reading flows (add/edit/scan) below never read stale config.
    flushPersist();
    setSeq((s) => s + 1);
    setMode(next);
  };
  const promptKey = `${mode}-${seq}`;

  // ---- pin / sort / reorder: instant in-memory edits (debounced persist) ----
  const togglePinUI = (p: Project) => {
    const prev = cfgRef.current;
    const pinned = new Set(prev.pinned ?? []);
    pinned.has(p.id) ? pinned.delete(p.id) : pinned.add(p.id);
    applyCfg({ ...prev, pinned: [...pinned] });
  };
  const toggleSortUI = () => {
    const prev = cfgRef.current;
    const next: SortMode = prev.sortMode === "recent" ? "manual" : "recent";
    applyCfg({ ...prev, sortMode: next });
    setStatus(`Sort: ${next === "recent" ? "last run" : "manual order"}.`);
  };
  // Move `item` one step in `dir` within its section. ListSelect already confined
  // it to a section and moved the cursor; we just rewrite the saved order.
  const reorderUI = (item: Project, dir: -1 | 1) => {
    const prev = cfgRef.current;
    const ordered = orderProjects(rawRef.current, prev);
    const idx = ordered.findIndex((p) => p.id === item.id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= ordered.length) return;
    const next = [...ordered];
    [next[idx], next[j]] = [next[j]!, next[idx]!];
    applyCfg({ ...prev, sortMode: "manual", order: next.map((p) => p.id) });
  };

  // Launch a set of commands for a project, remembering them as its last run.
  const launch = (p: Project, cmds: Command[]) => {
    if (!cmds.length) return;
    const prev = cfgRef.current; // already holds any unpersisted pin/reorder/sort
    if (persistTimer.current) clearTimeout(persistTimer.current);
    pending.current = null;
    saveLaunch({
      ...prev,
      lastRun: { ...(prev.lastRun ?? {}), [p.id]: cmds.map((c) => c.label) },
      lastRunAt: { ...(prev.lastRunAt ?? {}), [p.id]: Date.now() },
    });
    onChoose(cmds);
  };
  // ---- run a project's default command(s) ----
  const runProject = (p: Project) => launch(p, defaultCommands(p));

  // Commands to pre-mark in the `a` picker: the last run if any, else defaults.
  const lastRunIds = (p: Project) => {
    const labels = lastRunLabels(p.id, cfg);
    const ids = labels.length
      ? p.commands.filter((c) => labels.includes(c.label)).map((c) => c.id)
      : [];
    return ids.length ? ids : defaultCommands(p).map((c) => c.id);
  };

  // ---- help (its own full page, not an overlay) ----
  if (showHelp) {
    const bindings = mode === "scan" ? SCAN_HELP : HELP;
    const title = mode === "scan" ? "scan folders - keys" : "launch - keys";
    return <Help title={title} bindings={bindings} onClose={() => setShowHelp(false)} />;
  }

  // ---- main list ----
  if (mode === "list" || mode === "delete") {
    return (
      <box style={{ padding: 1, flexDirection: "column" }}>
        <Header
          title="launch"
          subtitle={`sort: ${cfg.sortMode === "recent" ? "last run" : "manual order"}`}
          hint="j/k move | enter run | a pick | p pin | [ ]/o sort | n/e/d project | s scan | h help"
        />
        {status ? <text fg={theme.green}>{status}</text> : null}
        <ListSelect
          items={projects}
          getKey={(p) => p.id}
          filterText={(p) => `${p.name} ${p.commands.map((c) => c.label).join(" ")}`}
          active={mode === "list" && !showHelp}
          onReorder={reorderUI}
          sectionOf={(p) => (p.pinned ? "pinned" : (p.source ?? "manual"))}
          sectionLabel={(id) => sectionHeader(id, nameWidth)}
          emptyText="No projects yet - press n to add one, or s to add a scan folder."
          onSubmit={(items) => {
            const p = items[0];
            if (p) runProject(p);
          }}
          onCancel={() => {
            flushPersist();
            onChoose(null);
          }}
          onExtraKey={(name, current) => {
            if (name === "h") {
              setShowHelp(true);
            } else if (name === "r") {
              rescan();
              setStatus("Rescanned.");
            } else if (name === "o") {
              toggleSortUI();
            } else if (name === "n") {
              go("add");
            } else if (name === "s") {
              go("scan");
            } else if (name === "a" && current) {
              setTarget(current);
              go("run");
            } else if (name === "p" && current) {
              togglePinUI(current);
              setStatus(current.pinned ? `Unpinned ${current.name}.` : `Pinned ${current.name}.`);
            } else if (name === "e" && current) {
              // Scanned projects are regenerated from disk each run, so adopt
              // the project into the config first so edits persist.
              if (current.source === "manual") {
                setTarget(current);
                go("edit");
              } else {
                let adopted: Project | null = null;
                structural(() => {
                  adopted = adoptProject(current);
                });
                if (adopted) {
                  setTarget(adopted);
                  setStatus(`Adopted "${(adopted as Project).name}" into your config for editing.`);
                  go("edit");
                }
              }
            } else if (name === "d" && current) {
              setTarget(current);
              go("delete");
            }
          }}
          renderRow={(p, { selected }) => (
            <ProjectRow p={p} selected={selected} nameWidth={nameWidth} />
          )}
        />
        {mode === "delete" && target ? (
          <Confirm
            message={
              target.source && target.source !== "manual"
                ? `Hide scanned project "${target.name}"? (adds it to the scan-root exclude list - your files are untouched)`
                : `Delete project "${target.name}"?`
            }
            onConfirm={() => {
              structural(() => {
                if (target.source && target.source !== "manual") {
                  const folder = scanFolder(target) ?? target.name;
                  excludeFromScan(target.source, folder);
                  setStatus(`Hid ${target.name} from the scan.`);
                } else {
                  removeProject(target.id);
                  setStatus(`Deleted ${target.name}.`);
                }
              });
              setTarget(null);
              setMode("list");
            }}
            onCancel={() => setMode("list")}
          />
        ) : null}
      </box>
    );
  }

  // ---- ad-hoc run picker (a) - pre-marks your last run (else the defaults) ----
  if (mode === "run" && target) {
    const preMarked = lastRunIds(target);
    const remembered = lastRunLabels(target.id, cfg).length > 0;
    return (
      <Frame
        title={`run: ${target.name}`}
        hint={`space/tab select | enter run | q/esc back${remembered ? " | last run pre-selected" : ""}`}
      >
        <ListSelect
          items={target.commands}
          getKey={(c) => c.id}
          filterText={(c) => `${c.label} ${c.command}`}
          multiSelect
          immediateCancel
          initialMarked={preMarked}
          emptyText="This project has no commands."
          onSubmit={(cmds) => launch(target, cmds)}
          onCancel={() => go("list")}
          renderRow={(c, { selected }) => <CommandRow c={c} selected={selected} />}
        />
      </Frame>
    );
  }

  // ---- add menu (n) ----
  if (mode === "add") {
    return (
      <Frame title="add a project" hint="enter choose | q/esc back">
        <ListSelect
          items={ADD_MENU}
          getKey={(m) => m.id}
          filterText={(m) => m.label}
          immediateCancel
          onSubmit={(items) => {
            const choice = items[0]?.id;
            if (choice === "auto") {
              setDraft({ name: "", commands: [] });
              go("auto-path");
            } else if (choice === "manual") {
              setDraft({ name: "", commands: [] });
              go("manual-name");
            } else if (choice === "scan") {
              go("scan-add");
            }
          }}
          onCancel={() => go("list")}
          renderRow={(m, { selected }) => <MenuRow m={m} selected={selected} />}
        />
      </Frame>
    );
  }

  // ---- auto-detect flow ----
  if (mode === "auto-path") {
    return (
      <Frame title="auto-detect a project">
        <TextPrompt
          key={promptKey}
          label="Folder to scan for a project"
          placeholder="C:\\path\\to\\project"
          onSubmit={(path) => {
            const dir = path.trim();
            if (!dir) return;
            const cmds = detectProjectCommands(dir);
            if (!cmds.length) {
              setStatus(`No runnable manifest found in ${dir}.`);
              go("list");
              return;
            }
            setDraft({ name: suggestName(dir), commands: cmds });
            go("auto-pick");
          }}
          onCancel={() => go("add")}
        />
      </Frame>
    );
  }

  if (mode === "auto-pick") {
    return (
      <Frame title="pick commands to include" hint="space/tab toggle | enter keep | q/esc back">
        <ListSelect
          items={draft.commands}
          getKey={(c) => c.id}
          filterText={(c) => `${c.label} ${c.command}`}
          multiSelect
          immediateCancel
          initialMarked={draft.commands.map((c) => c.id)}
          onSubmit={(cmds) => {
            setDraft((d) => ({ ...d, commands: cmds }));
            go("auto-name");
          }}
          onCancel={() => go("add")}
          renderRow={(c, { selected }) => <CommandRow c={c} selected={selected} />}
        />
      </Frame>
    );
  }

  if (mode === "auto-name") {
    return (
      <Frame title="project name">
        <TextPrompt
          key={promptKey}
          label="Project name"
          initial={draft.name}
          onSubmit={(name) => {
            setDraft((d) => ({ ...d, name: name.trim() || d.name }));
            go("auto-default");
          }}
          onCancel={() => go("auto-pick")}
        />
      </Frame>
    );
  }

  if (mode === "auto-default") {
    return (
      <Frame title="default command(s) - what Enter starts" hint="space/tab toggle | enter save | q/esc back">
        <ListSelect
          items={draft.commands}
          getKey={(c) => c.id}
          filterText={(c) => `${c.label} ${c.command}`}
          multiSelect
          immediateCancel
          initialMarked={guessDefaultIds(draft.commands)}
          onSubmit={(defs) => {
            const commands = draft.commands.map((c) => ({
              ...c,
              isDefault: defs.some((d) => d.id === c.id),
            }));
            addProject({ id: newId(), name: draft.name, commands });
            rescan();
            setStatus(`Added ${draft.name}.`);
            go("list");
          }}
          onCancel={() => go("auto-name")}
          renderRow={(c, { selected }) => <CommandRow c={c} selected={selected} />}
        />
      </Frame>
    );
  }

  // ---- manual flow ----
  if (mode === "manual-name") {
    return (
      <Frame title="add a project manually">
        <TextPrompt
          key={promptKey}
          label="Project name"
          initial={draft.name}
          onSubmit={(name) => {
            setDraft((d) => ({ ...d, name: name.trim() || "project" }));
            go("manual-label");
          }}
          onCancel={() => go("add")}
        />
      </Frame>
    );
  }

  if (mode === "manual-label") {
    return (
      <Frame title={`${draft.name} - add a command`}>
        <TextPrompt
          key={promptKey}
          label="Command label (e.g. dev, server)"
          onSubmit={(label) => {
            setPendingCmd({ label: label.trim() || "run", command: "", cwd: "" });
            go("manual-command");
          }}
          onCancel={() => go(draft.commands.length ? "manual-more" : "add")}
        />
      </Frame>
    );
  }

  if (mode === "manual-command") {
    return (
      <Frame title={`${draft.name} - add a command`}>
        <TextPrompt
          key={promptKey}
          label="Shell command (e.g. bun run dev)"
          onSubmit={(command) => {
            setPendingCmd((c) => ({ ...c, command: command.trim() }));
            go("manual-cwd");
          }}
          onCancel={() => go("manual-label")}
        />
      </Frame>
    );
  }

  if (mode === "manual-cwd") {
    return (
      <Frame title={`${draft.name} - add a command`}>
        <TextPrompt
          key={promptKey}
          label="Working directory"
          initial={process.cwd()}
          onSubmit={(cwd) => {
            const dir = cwd.trim() || process.cwd();
            setDraft((d) => ({
              ...d,
              commands: [...d.commands, newCommand(pendingCmd.label, pendingCmd.command, dir)],
            }));
            go("manual-more");
          }}
          onCancel={() => go("manual-command")}
        />
      </Frame>
    );
  }

  if (mode === "manual-more") {
    return (
      <Frame title={`${draft.name} - ${draft.commands.length} command(s)`}>
        <Confirm
          message="Add another command?"
          onConfirm={() => go("manual-label")}
          onCancel={() => go(draft.commands.length ? "manual-default" : "list")}
        />
      </Frame>
    );
  }

  if (mode === "manual-default") {
    return (
      <Frame title="default command(s) - what Enter starts" hint="space/tab toggle | enter save | q/esc back">
        <ListSelect
          items={draft.commands}
          getKey={(c) => c.id}
          filterText={(c) => `${c.label} ${c.command}`}
          multiSelect
          immediateCancel
          initialMarked={guessDefaultIds(draft.commands)}
          onSubmit={(defs) => {
            const commands = draft.commands.map((c) => ({
              ...c,
              isDefault: defs.some((d) => d.id === c.id),
            }));
            addProject({ id: newId(), name: draft.name, commands });
            rescan();
            setStatus(`Added ${draft.name}.`);
            go("list");
          }}
          onCancel={() => go("manual-more")}
          renderRow={(c, { selected }) => <CommandRow c={c} selected={selected} />}
        />
      </Frame>
    );
  }

  // ---- edit flow ----
  if (mode === "edit" && target) {
    return (
      <Frame title={`edit: ${target.name}`} hint="enter choose | q/esc back">
        <ListSelect
          items={EDIT_MENU}
          getKey={(m) => m.id}
          filterText={(m) => m.label}
          immediateCancel
          onSubmit={(items) => {
            const choice = items[0]?.id;
            if (choice === "rename") go("edit-rename");
            else if (choice === "default") go("edit-default");
            else if (choice === "remove") go("edit-remove");
            else go("list");
          }}
          onCancel={() => go("list")}
          renderRow={(m, { selected }) => <MenuRow m={m} selected={selected} />}
        />
      </Frame>
    );
  }

  if (mode === "edit-rename" && target) {
    return (
      <Frame title={`rename: ${target.name}`}>
        <TextPrompt
          key={promptKey}
          label="New project name"
          initial={target.name}
          onSubmit={(name) => {
            const updated = { ...target, name: name.trim() || target.name };
            updateProject(updated);
            setTarget(updated);
            rescan();
            go("edit");
          }}
          onCancel={() => go("edit")}
        />
      </Frame>
    );
  }

  if (mode === "edit-default" && target) {
    return (
      <Frame title={`${target.name} - default command(s)`} hint="space/tab toggle | enter save | q/esc back">
        <ListSelect
          items={target.commands}
          getKey={(c) => c.id}
          filterText={(c) => `${c.label} ${c.command}`}
          multiSelect
          immediateCancel
          initialMarked={target.commands.filter((c) => c.isDefault).map((c) => c.id)}
          onSubmit={(defs) => {
            const updated = {
              ...target,
              commands: target.commands.map((c) => ({
                ...c,
                isDefault: defs.some((d) => d.id === c.id),
              })),
            };
            updateProject(updated);
            setTarget(updated);
            rescan();
            go("edit");
          }}
          onCancel={() => go("edit")}
          renderRow={(c, { selected }) => <CommandRow c={c} selected={selected} />}
        />
      </Frame>
    );
  }

  if (mode === "edit-remove" && target) {
    return (
      <Frame title={`${target.name} - remove command(s)`} hint="space/tab mark | enter remove | q/esc back">
        <ListSelect
          items={target.commands}
          getKey={(c) => c.id}
          filterText={(c) => `${c.label} ${c.command}`}
          multiSelect
          immediateCancel
          emptyText="No commands to remove."
          onSubmit={(toRemove) => {
            const updated = {
              ...target,
              commands: target.commands.filter((c) => !toRemove.some((r) => r.id === c.id)),
            };
            updateProject(updated);
            setTarget(updated);
            rescan();
            go("edit");
          }}
          onCancel={() => go("edit")}
          renderRow={(c, { selected }) => <CommandRow c={c} selected={selected} />}
        />
      </Frame>
    );
  }

  // ---- scan-root management ----
  if (mode === "scan") {
    const projectCount = (r: ScanRoot) => raw.filter((p) => p.source === r.path).length;
    return (
      <Frame
        title="scan folders"
        hint="enter manage hidden | n add | d remove root | h help | esc back"
      >
        {status ? <text fg={theme.green}>{status}</text> : null}
        <ListSelect
          items={cfg.scanRoots}
          getKey={(r) => r.path}
          immediateCancel
          active={!showHelp}
          filterText={(r) => r.path}
          emptyText="No scan folders yet - press n to add one."
          onSubmit={(items) => {
            const r = items[0];
            if (r) {
              setScanTarget(r);
              go("scan-excludes");
            }
          }}
          onCancel={() => go("list")}
          onExtraKey={(name, current) => {
            if (name === "h") setShowHelp(true);
            else if (name === "n") go("scan-add");
            else if (name === "d" && current) {
              structural(() => removeScanRoot(current.path));
              setStatus(`Removed scan folder ${current.path}.`);
            }
          }}
          renderRow={(r: ScanRoot, { selected }) => {
            const hidden = r.exclude?.length ?? 0;
            return (
              <text>
                <span fg={selected ? theme.selFg : theme.fg}>{r.path}</span>
                <span fg={theme.dim}>
                  {`  ${projectCount(r)} projects${hidden ? ` | ${hidden} hidden` : ""}`}
                </span>
              </text>
            );
          }}
        />
      </Frame>
    );
  }

  // Un-hide projects you previously hid (revert a hide / an adopt's exclude).
  if (mode === "scan-excludes" && scanTarget) {
    const root = cfg.scanRoots.find((r) => r.path === scanTarget.path) ?? scanTarget;
    const hidden = root.exclude ?? [];
    return (
      <Frame
        title={`hidden in ${basename(root.path) || root.path}`}
        hint="enter / d un-hide (show again) | esc back"
      >
        <ListSelect
          items={hidden}
          getKey={(f) => f}
          immediateCancel
          filterText={(f) => f}
          emptyText="Nothing hidden here. (Hiding a project, or editing a scanned one, adds it here.)"
          onSubmit={(items) => {
            const f = items[0];
            if (f) {
              structural(() => includeInScan(root.path, f));
              setStatus(`Un-hid ${f} - it'll show again if it has a runnable manifest.`);
            }
          }}
          onCancel={() => go("scan")}
          onExtraKey={(name, current) => {
            if (name === "d" && current) {
              structural(() => includeInScan(root.path, current));
              setStatus(`Un-hid ${current}.`);
            }
          }}
          renderRow={(f: string, { selected }) => (
            <text fg={selected ? theme.selFg : theme.fg}>{f}</text>
          )}
        />
      </Frame>
    );
  }

  if (mode === "scan-add") {
    return (
      <Frame title="add a scan folder">
        <TextPrompt
          key={promptKey}
          label="Folder to auto-scan for projects"
          placeholder="C:\\path\\to\\projects"
          onSubmit={(path) => {
            const dir = path.trim();
            if (dir) {
              structural(() => addScanRoot({ path: dir }));
              setStatus(`Added scan folder ${dir}.`);
            }
            go("scan");
          }}
          onCancel={() => go("scan")}
        />
      </Frame>
    );
  }

  // Fallback (e.g. a mode that needs a target but lost it): back to the list.
  return (
    <Frame title="launch">
      <text fg={theme.dim}>Returning...</text>
    </Frame>
  );
}

// Small consistent chrome for the sub-screens.
function Frame({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <box style={{ padding: 1, flexDirection: "column" }}>
      <Header title="launch" subtitle={title} hint={hint} />
      {children}
    </box>
  );
}

// ---------- CLI entry ----------

// Mount the picker; on a real selection, hand the terminal to the dev servers and
// hold it (so a caller's loop can't redraw over the logs); on cancel, return so the
// caller (e.g. the devkit hub) can show its menu again. Pass `initialProject` to
// open straight on that project's command picker (the `a` page).
export async function runLaunchScreen(initialProject: Project | null = null) {
  const chosen = await mountScreen<Command[] | null>((done) => (
    <LaunchScreen onChoose={done} initialProject={initialProject} />
  ));
  if (!chosen || !chosen.length) return;
  // Renderer is torn down by now; hand the terminal to the dev servers.
  console.log(`\nStarting ...\n`);
  for (const c of chosen) console.log(`> ${c.label}: ${c.command}  (${c.cwd})`);
  startCommands(chosen); // wires SIGINT -> process.exit(0)
  await new Promise<void>(() => {}); // hold the terminal until Ctrl-C
}

export async function runLaunch() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(
      [
        "Usage: launch [name|partial|index] [-a]",
        "  launch                 interactive picker",
        '  launch "Auth Service"  start that project by full name',
        "  launch auth            ... or by a partial name",
        "  launch 1               ... or by its position in the list",
        "",
        "  -a, --ask              pick which scripts to run instead of the",
        "                         defaults (pre-marked with your last run)",
        "  launch auth -a         e.g. choose the scripts for a one-off run",
      ].join("\n"),
    );
    return;
  }

  // -a / --ask: don't start the defaults, open the project's command picker.
  const ask = argv.includes("-a") || argv.includes("--ask");
  const nameArg = argv.find((a) => !a.startsWith("-"));

  if (nameArg) {
    const p = resolveProject(nameArg);
    if (!p) {
      console.log(`No project matching "${nameArg}". Known projects:`);
      allProjects().forEach((x, i) => console.log(`  ${i + 1}  ${x.name}`));
      process.exit(1);
    }
    if (ask) {
      // Straight to that project's `a` page; it records the run and starts it.
      await runLaunchScreen(p);
      process.exit(0);
    }
    const cmds = defaultCommands(p);
    recordLastRun(p.id, cmds.map((c) => c.label));
    console.log(`\nStarting ${p.name} ...\n`);
    for (const c of cmds) console.log(`> ${c.label}: ${c.command}  (${c.cwd})`);
    startCommands(cmds);
    return;
  }

  // Bare `-a` (no project named) just opens the normal picker — `a` works there.
  await runLaunchScreen();
  process.exit(0);
}

if (import.meta.main) {
  await runLaunch();
}

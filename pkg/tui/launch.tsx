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
import {
  Header,
  ListSelect,
  Confirm,
  Help,
  TextPrompt,
  type Binding,
  type ListSelectHandle,
} from "./components";
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
  matchProject,
  mergeProjects,
  resolveMembers,
  startCommands,
  launchCommands,
  launchGrouped,
  type Command,
  type Project,
  type ScanRoot,
  type SortMode,
  type LaunchConfig,
} from "../core/launch";

const HELP: Binding[] = [
  { keys: "", desc: "Move & run" },
  { keys: "j / k", desc: "move the highlight (or arrow keys)" },
  { keys: "space / tab", desc: "mark several projects to launch together" },
  { keys: "v", desc: "visual range - sweep with j/k, v again to keep" },
  { keys: "enter", desc: "run marked projects (or the highlighted one), each in its own tab" },
  { keys: "c", desc: "same, but concurrently in one pane (colored prefixes)" },
  { keys: "x", desc: "same, but expand every script to its own tab" },
  { keys: "a", desc: "pick commands to run (pre-marks your last run; s saves as default)" },
  { keys: "/", desc: "filter projects" },
  { keys: "", desc: "Organize the list" },
  { keys: "p", desc: "pin / unpin (PINNED stays on top)" },
  { keys: "[ ]", desc: "move project up / down (switches to manual sort)" },
  { keys: "o", desc: "sort: manual order or last run (recent first)" },
  { keys: "", desc: "Add, edit & remove projects" },
  { keys: "n", desc: "add a project (auto-detect, by hand, or combine existing ones)" },
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
  | "group-pick"
  | "group-name"
  | "edit"
  | "edit-rename"
  | "edit-default"
  | "edit-remove"
  | "edit-members"
  | "delete"
  | "scan"
  | "scan-add"
  | "scan-excludes";

interface Draft {
  name: string;
  commands: Command[];
}

// What a launch resolves to: the commands to start, and which project they
// came from (so the caller can tell an ordinary project from a group/merge —
// see launchCommands() in core/launch.ts). `grouped`, when present, means
// "dispatch at project granularity via launchGrouped" — set only for a plain
// Enter/c/x launch of a group/multi-marked set from the main list; the ask
// picker (`a`) never sets it, so its hand-picked subset keeps dispatching
// through the flat, per-script launchCommands exactly as before.
interface LaunchResult {
  project: Project;
  cmds: Command[];
  grouped?: { members: Project[]; concurrent?: boolean; scriptTabs?: boolean };
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

// Default command(s) first, then the rest — so the `a` picker leads with what Enter
// would have started. Stable (JS sort is), so each group keeps its detection order
// (already backend-before-frontend). Not sorted by *marked*: that would reshuffle the
// list between runs as the last-run set changes.
const defaultsFirst = (cmds: Command[]): Command[] =>
  [...cmds].sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));

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
  { id: "group", label: "Combine existing projects", desc: "run several together as one launchable project (e.g. a backend + its frontend)" },
];

const EDIT_MENU: MenuItem[] = [
  { id: "rename", label: "Rename", desc: "change the project name" },
  { id: "default", label: "Set default command(s)", desc: "what Enter starts" },
  { id: "remove", label: "Remove a command", desc: "drop one or more commands" },
  { id: "back", label: "Back", desc: "return to the project list" },
];

// Shown instead of EDIT_MENU for a group project: its commands are computed
// live from its members, so there's no per-command default/remove to set.
const GROUP_EDIT_MENU: MenuItem[] = [
  { id: "rename", label: "Rename", desc: "change the group's name" },
  { id: "members", label: "Edit members", desc: "change which projects this group combines" },
  { id: "back", label: "Back", desc: "return to the project list" },
];

export function LaunchScreen({
  onChoose,
  initialProject = null,
}: {
  onChoose: (result: LaunchResult | null) => void;
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
  const [pickedMembers, setPickedMembers] = useState<Project[]>([]);
  // Imperative handle onto the main list, so `c`/`x` can read the marked set
  // (getSelected) the same way Enter's onSubmit already receives it.
  const listRef = useRef<ListSelectHandle<Project> | null>(null);
  // Same, but for the ask-picker's command list — lets `s` (save as default)
  // read the current marks without needing Enter to submit first.
  const runListRef = useRef<ListSelectHandle<Command> | null>(null);

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
  const launch = (
    p: Project,
    cmds: Command[],
    grouped?: { members: Project[]; concurrent?: boolean; scriptTabs?: boolean },
  ) => {
    if (!cmds.length) return;
    const prev = cfgRef.current; // already holds any unpersisted pin/reorder/sort
    if (persistTimer.current) clearTimeout(persistTimer.current);
    pending.current = null;
    saveLaunch({
      ...prev,
      lastRun: { ...(prev.lastRun ?? {}), [p.id]: cmds.map((c) => c.label) },
      lastRunAt: { ...(prev.lastRunAt ?? {}), [p.id]: Date.now() },
    });
    onChoose({ project: p, cmds, grouped });
  };
  // ---- run a project's default command(s) ----
  // A single group project's own defaults ALSO dispatch via launchGrouped
  // (project tabs by default) — consistent with `launch <groupName>` on the
  // CLI. Only the ask-picker (`a` page, below) skips this and keeps the flat
  // per-script launchCommands, since it's already a hand-picked subset.
  const runProject = (p: Project) => {
    const cmds = defaultCommands(p);
    if (p.memberIds?.length) {
      launch(p, cmds, { members: resolveMembers(p, projects) });
    } else {
      launch(p, cmds);
    }
  };

  // Launch several marked projects together (or just one, same as
  // runProject) — the main list's Enter/c/x dispatch. `opts` is empty for
  // Enter (project tabs by default), {concurrent:true} for `c`, or
  // {scriptTabs:true} for `x`.
  const launchMarked = (picked: Project[], opts: { concurrent?: boolean; scriptTabs?: boolean }) => {
    const first = picked[0];
    if (!first) return;
    if (picked.length === 1) {
      if (first.memberIds?.length) {
        launch(first, defaultCommands(first), { members: resolveMembers(first, projects), ...opts });
      } else {
        // A single ordinary project: concurrent/script-tabs have nothing to
        // apply to, so `c`/`x` behave exactly like plain Enter here.
        runProject(first);
      }
      return;
    }
    const merged = mergeProjects(picked.map((p) => p.name).join(" + "), picked);
    launch(merged, defaultCommands(merged), { members: picked, ...opts });
  };

  // Commands to pre-mark in the `a` picker: the last run if any, else defaults.
  const lastRunIds = (p: Project) => {
    const labels = lastRunLabels(p.id, cfg);
    const ids = labels.length
      ? p.commands.filter((c) => labels.includes(c.label)).map((c) => c.id)
      : [];
    return ids.length ? ids : defaultCommands(p).map((c) => c.id);
  };

  // ---- `s` in the ask-picker: persist the current marks as the project's
  // real default commands, separate from running them. Adopts a scanned
  // project into the config first if needed (mirrors the list's `e` key).
  // No-op for a group/merge - its defaults live on its members, not on it.
  const saveAsDefault = (p: Project, picked: Command[]) => {
    if (!picked.length) return;
    if (p.memberIds?.length) {
      setStatus("Can't save defaults for a combined project - edit its members instead.");
      return;
    }
    const pickedIds = new Set(picked.map((c) => c.id));
    const withDefaults = (proj: Project): Project => ({
      ...proj,
      commands: proj.commands.map((c) => ({ ...c, isDefault: pickedIds.has(c.id) })),
    });
    if (p.source === "manual") {
      const updated = withDefaults(p);
      updateProject(updated);
      setTarget(updated);
      rescan();
      setStatus(`Saved ${picked.length} command(s) as default for ${p.name}.`);
    } else {
      let adopted: Project | null = null;
      structural(() => {
        adopted = adoptProject(p);
      });
      if (adopted) {
        const updated = withDefaults(adopted);
        updateProject(updated);
        setTarget(updated);
        rescan();
        setStatus(`Adopted "${updated.name}" and saved ${picked.length} command(s) as default.`);
      }
    }
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
          hint="j/k move | space mark | enter run | c concurrent | x script-tabs | a pick | p pin | n/e/d project | h help"
        />
        {status ? <text fg={theme.green}>{status}</text> : null}
        <ListSelect
          items={projects}
          getKey={(p) => p.id}
          filterText={(p) => `${p.name} ${p.commands.map((c) => c.label).join(" ")}`}
          active={mode === "list" && !showHelp}
          multiSelect
          controlRef={listRef}
          onReorder={reorderUI}
          sectionOf={(p) => (p.pinned ? "pinned" : (p.source ?? "manual"))}
          sectionLabel={(id) => sectionHeader(id, nameWidth)}
          emptyText="No projects yet - press n to add one, or s to add a scan folder."
          onSubmit={(items) => launchMarked(items, {})}
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
            } else if (name === "c") {
              launchMarked(listRef.current?.getSelected() ?? (current ? [current] : []), {
                concurrent: true,
              });
            } else if (name === "x") {
              launchMarked(listRef.current?.getSelected() ?? (current ? [current] : []), {
                scriptTabs: true,
              });
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
    const cmds = defaultsFirst(target.commands);
    // Only section the list when there's actually a split to show.
    const mixed = cmds.some((c) => c.isDefault) && cmds.some((c) => !c.isDefault);
    return (
      <Frame
        title={`run: ${target.name}`}
        hint={`space/tab select | enter run | s save as default | q/esc back${remembered ? " | last run pre-selected" : ""}`}
      >
        <ListSelect
          items={cmds}
          getKey={(c) => c.id}
          filterText={(c) => `${c.label} ${c.command}`}
          multiSelect
          immediateCancel
          controlRef={runListRef}
          initialMarked={preMarked}
          sectionOf={mixed ? (c) => (c.isDefault ? "default" : "other") : undefined}
          sectionLabel={(id) => (id === "default" ? "DEFAULT" : "OTHER")}
          emptyText="This project has no commands."
          onSubmit={(cmds) => launch(target, cmds)}
          onCancel={() => go("list")}
          onExtraKey={(name) => {
            if (name === "s") saveAsDefault(target, runListRef.current?.getSelected() ?? []);
          }}
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
            } else if (choice === "group") {
              setPickedMembers([]);
              go("group-pick");
            }
          }}
          onCancel={() => go("list")}
          renderRow={(m, { selected }) => <MenuRow m={m} selected={selected} />}
        />
      </Frame>
    );
  }

  // ---- combine projects into a group flow ----
  if (mode === "group-pick") {
    const candidates = projects.filter((p) => !p.memberIds?.length);
    return (
      <Frame title="pick projects to combine" hint="space/tab toggle | enter keep | q/esc back">
        <ListSelect
          items={candidates}
          getKey={(p) => p.id}
          filterText={(p) => p.name}
          multiSelect
          immediateCancel
          emptyText="No standalone projects to combine yet."
          onSubmit={(picked) => {
            setPickedMembers(picked);
            go("group-name");
          }}
          onCancel={() => go("add")}
          renderRow={(p, { selected }) => (
            <ProjectRow p={p} selected={selected} nameWidth={nameWidth} />
          )}
        />
      </Frame>
    );
  }

  if (mode === "group-name") {
    return (
      <Frame title="group name">
        <TextPrompt
          key={promptKey}
          label="Group project name"
          placeholder="e.g. sustainatrix"
          onSubmit={(name) => {
            const trimmed = name.trim() || "group";
            addProject({
              id: newId(),
              name: trimmed,
              commands: [],
              memberIds: pickedMembers.map((p) => p.id),
            });
            rescan();
            setStatus(`Combined ${pickedMembers.length} projects into "${trimmed}".`);
            setPickedMembers([]);
            go("list");
          }}
          onCancel={() => go("group-pick")}
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
    const isGroup = !!target.memberIds?.length;
    return (
      <Frame title={`edit: ${target.name}`} hint="enter choose | q/esc back">
        <ListSelect
          items={isGroup ? GROUP_EDIT_MENU : EDIT_MENU}
          getKey={(m) => m.id}
          filterText={(m) => m.label}
          immediateCancel
          onSubmit={(items) => {
            const choice = items[0]?.id;
            if (choice === "rename") go("edit-rename");
            else if (choice === "default") go("edit-default");
            else if (choice === "remove") go("edit-remove");
            else if (choice === "members") go("edit-members");
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

  if (mode === "edit-members" && target) {
    const candidates = projects.filter((p) => p.id !== target.id && !p.memberIds?.length);
    return (
      <Frame title={`${target.name} - edit members`} hint="space/tab toggle | enter save | q/esc back">
        <ListSelect
          items={candidates}
          getKey={(p) => p.id}
          filterText={(p) => p.name}
          multiSelect
          immediateCancel
          initialMarked={target.memberIds ?? []}
          emptyText="No standalone projects available."
          onSubmit={(picked) => {
            const updated = { ...target, memberIds: picked.map((p) => p.id) };
            updateProject(updated); // normalizeForSave resets commands for us
            setTarget(updated);
            rescan();
            go("edit");
          }}
          onCancel={() => go("edit")}
          renderRow={(p, { selected }) => (
            <ProjectRow p={p} selected={selected} nameWidth={nameWidth} />
          )}
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
// open straight on that project's command picker (the `a` page). `opts.concurrent`
// only matters for a group project (see launchCommands in core/launch.ts) — an
// ordinary project always uses startCommands, unchanged.
export async function runLaunchScreen(
  initialProject: Project | null = null,
  opts?: { concurrent?: boolean },
) {
  const chosen = await mountScreen<LaunchResult | null>((done) => (
    <LaunchScreen onChoose={done} initialProject={initialProject} />
  ));
  if (!chosen || !chosen.cmds.length) return;
  const { project, cmds, grouped } = chosen;
  // Renderer is torn down by now; hand the terminal to the dev servers.
  console.log(`\nStarting ...\n`);
  for (const c of cmds) console.log(`> ${c.label}: ${c.command}  (${c.cwd})`);
  if (grouped) {
    // Plain Enter/c/x on a group or a marked multi-select (main list) —
    // project granularity by default, per grouped.concurrent/scriptTabs.
    const { holdsTerminal } = launchGrouped(grouped.members, {
      concurrent: grouped.concurrent,
      scriptTabs: grouped.scriptTabs,
    });
    if (holdsTerminal) await new Promise<void>(() => {}); // hold until Ctrl-C
  } else if (project.memberIds?.length) {
    // The ask picker (`a`) on a group/merge: always the flat, per-script
    // dispatch — the user already hand-picked individual scripts here.
    const { holdsTerminal } = launchCommands(cmds, opts);
    if (holdsTerminal) await new Promise<void>(() => {}); // hold until Ctrl-C
    // else: tabs were opened elsewhere — return so the caller's process.exit runs.
  } else {
    startCommands(cmds); // wires SIGINT -> process.exit(0)
    await new Promise<void>(() => {}); // hold the terminal until Ctrl-C
  }
}

function dedupeById(projects: Project[]): Project[] {
  const seen = new Set<string>();
  const out: Project[] = [];
  for (const p of projects) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

// Start a resolved project's defaults non-interactively. The only place that
// distinguishes a group from an ordinary project: memberIds present -> the
// new project-tabs/concurrent/script-tabs dispatcher; otherwise
// startCommands(), unchanged. `members`, when given (the ad-hoc multi-name
// path already has the real pre-merge projects), skips resolveMembers'
// id-lookup round-trip.
function startResolved(
  p: Project,
  concurrent: boolean,
  scriptTabs: boolean,
  ordered: Project[],
  members?: Project[],
) {
  const cmds = defaultCommands(p);
  recordLastRun(p.id, cmds.map((c) => c.label));
  console.log(`\nStarting ${p.name} ...\n`);
  for (const c of cmds) console.log(`> ${c.label}: ${c.command}  (${c.cwd})`);
  if (p.memberIds?.length) {
    const resolved = members ?? resolveMembers(p, ordered);
    const { holdsTerminal } = launchGrouped(resolved, { concurrent, scriptTabs });
    if (!holdsTerminal) process.exit(0);
  } else {
    startCommands(cmds);
  }
}

export async function runLaunch() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(
      [
        "Usage: launch [name|partial|index ...] [-a] [-c] [-st]",
        "  launch                 interactive picker",
        "  launch <project>       start that project's default command(s)",
        "  launch <a> <b> ...     fuzzy-launch multiple projects together (or one",
        "                         saved group by name) - each project gets its own",
        "                         Windows Terminal tab (its own defaults running",
        "                         together in that tab, same as launching it alone),",
        "                         or runs concurrently in one pane on macOS/Linux",
        "                         (and on Windows with -c)",
        "  -a, --ask              pick which scripts to run instead of the",
        "                         defaults (pre-marked with your last run)",
        "  -c, --concurrent       Windows only: run combined projects together in",
        "                         this pane instead of opening a tab per project",
        "                         (irrelevant on macOS/Linux, which always do this)",
        "  -st, --script-tabs     expand every script (across every resolved",
        "                         project) to its own tab, instead of one tab per",
        "                         project",
        "",
        "Examples:",
        '  launch "Auth Service"  full name',
        "  launch auth            a partial name works too",
        "  launch 1               1-based position in the list",
        "  launch auth -a         choose the scripts for a one-off run",
        "  launch esg auth        one tab for esg-kpi, one for auth-service",
        "  launch esg auth -c     ...in this pane instead of separate tabs (Windows)",
        "  launch esg auth -st    ...one tab per script instead of per project",
        "  launch sustainatrix    launch a saved group (see 'n' > Combine projects)",
      ].join("\n"),
    );
    return;
  }

  const ask = argv.includes("-a") || argv.includes("--ask");
  const concurrent = argv.includes("-c") || argv.includes("--concurrent");
  const scriptTabs = argv.includes("-st") || argv.includes("--script-tabs");
  const names = argv.filter((a) => !a.startsWith("-"));
  const ordered = allProjects(); // one snapshot: matching, member-resolution, and the miss list all reuse it

  if (names.length === 1) {
    const p = matchProject(names[0]!, ordered);
    if (!p) {
      console.log(`No project matching "${names[0]}". Known projects:`);
      ordered.forEach((x, i) => console.log(`  ${i + 1}  ${x.name}`));
      process.exit(1);
    }
    if (ask) {
      // Straight to that project's `a` page; it records the run and starts it.
      await runLaunchScreen(p, { concurrent });
      process.exit(0);
    }
    startResolved(p, concurrent, scriptTabs, ordered);
    return;
  }

  if (names.length >= 2) {
    const resolved: Project[] = [];
    const misses: string[] = [];
    for (const n of names) {
      const p = matchProject(n, ordered);
      if (p) resolved.push(p);
      else misses.push(n);
    }
    if (misses.length) {
      console.log(`No project matching: ${misses.map((m) => `"${m}"`).join(", ")}.`);
      console.log("Known projects:");
      ordered.forEach((x, i) => console.log(`  ${i + 1}  ${x.name}`));
      process.exit(1);
    }
    const distinct = dedupeById(resolved);
    const target = distinct.length === 1 ? distinct[0]! : mergeProjects(names.join(" "), distinct);
    if (ask) {
      await runLaunchScreen(target, { concurrent });
      process.exit(0);
    }
    startResolved(target, concurrent, scriptTabs, ordered, distinct.length > 1 ? distinct : undefined);
    return;
  }

  // Bare `-a`/`-c`/`-st` (no project named) just opens the normal picker.
  await runLaunchScreen(null, { concurrent });
  process.exit(0);
}

if (import.meta.main) {
  await runLaunch();
}

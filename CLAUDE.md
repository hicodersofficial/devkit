# devkit

A personal collection of small, daily-use developer/productivity tools — a
terminal toolbelt. Run `devkit` for an interactive hub that lists every tool, or
run any tool directly by name (`killport`, `launch`, …). Each tool is launchable
from anywhere via a thin `.bat` shim.

`bin/` is on the user `PATH` (entry: `C:\Users\hicod\devkit\bin`), so every shim
there is runnable by name from any shell.

The TUIs are built on **[OpenTUI](https://opentui.com)** (`@opentui/core` +
`@opentui/react`) — React-rendered terminal interfaces. Tool logic is split from
its UI so the same core can back a future GUI.

## Layout

```
devkit/
├── bin/                 # launcher shims — this folder is on PATH
│   ├── devkit.bat       # → pkg/tui/devkit.tsx  (the hub)
│   ├── launch.bat       # → pkg/tui/launch.tsx
│   └── killport.bat     # → pkg/tui/killport.tsx
├── pkg/
│   ├── core/            # PURE logic — no terminal UI, reusable by a future GUI
│   │   ├── launch.ts    # project registry + scan, config CRUD, startCommands
│   │   ├── killport.ts
│   │   ├── manifest.ts  # read package.json/go.mod/Cargo.toml/pyproject for cmds
│   │   ├── appname.ts   # resolve app name from a pid's cwd (cross-platform)
│   │   └── config.ts    # persisted settings (~/.devkit.json): theme + launch
│   └── tui/             # OpenTUI/React screens
│       ├── app.tsx          # mountScreen() — renderer bootstrap + teardown
│       ├── theme.ts         # Theme type + color presets
│       ├── theme-context.tsx# ThemeProvider / useTheme / cycle (t key)
│       ├── winmouse.ts      # Windows mouse fix (Bun #25663 workaround)
│       ├── tools.tsx        # tool registry the hub lists
│       ├── devkit.tsx       # the hub screen
│       ├── launch.tsx       # launch screen + CLI entry
│       ├── killport.tsx     # killport screen + CLI entry
│       └── components/      # shared UI: ListSelect, Header, Confirm, Help, TextPrompt
├── tsconfig.json
├── package.json
└── CLAUDE.md
```

- **`pkg/core/`** holds pure logic (filesystem scans, process discovery/killing).
  No `console`, no TUI — so a GUI could import the same functions. Prefer
  **TypeScript** (`.ts`, run with Bun); **Python** is fine when it fits better.
- **`pkg/tui/`** holds the OpenTUI/React screens (`.tsx`). Each screen file is also
  a standalone CLI entry (`if (import.meta.main) …`) so its tool runs on its own.
- **`bin/`** holds the `.bat` shims and is on the user `PATH`. Each is a tiny shim
  that runs its screen via Bun. Using `%~dp0` (the shim's own folder) keeps them
  portable regardless of where the repo lives. Example (`bin/killport.bat`):

  ```bat
  @echo off
  bun "%~dp0..\pkg\tui\killport.tsx" %*
  ```

## Conventions

- One tool = a `pkg/core/<tool>.ts` (logic) + a `pkg/tui/<tool>.tsx` (UI) + a row
  in `pkg/tui/tools.tsx` + a `bin/<tool>.bat` shim of the same name.
- Tools run directly with **Bun** — no build step. `tsconfig.json` sets
  `jsx: react-jsx` + `jsxImportSource: @opentui/react` for the `.tsx` screens.
- The shared OpenTUI/React stack is a deliberate common dependency; beyond it keep
  each tool light and self-documenting (header comment: what it does + how to use).
- Reuse the shared UI: `ListSelect` (keyboard list with `/` filter + optional
  multi-select with `initialMarked`, mouse click/hover/scroll, `t` theme cycle;
  `immediateCancel` makes Esc go back in a single press on transient pickers,
  skipping the default peel + "press Esc again to exit" guard; `onReorder` enables
  `[`/`]` to move the highlighted row, advancing the cursor in lockstep),
  `Header`, `Confirm`, `Help` (a binding with empty `keys` renders as a section
  heading), and `TextPrompt` (single-line text entry — render
  it while it should capture input and set the underlying list `active={false}`).
  Mount screens through `mountScreen()` in `pkg/tui/app.tsx` so the
  renderer is torn down cleanly on exit and the theme provider + Windows mouse
  fix are wired in.
- **Theming:** colors come from `useTheme()` (never import a static palette).
  Presets live in `pkg/tui/theme.ts`; `t` cycles them and the choice persists to
  `~/.devkit.json` (`pkg/core/config.ts`) so it applies across every tool.
- **Mouse on Windows:** `pkg/tui/winmouse.ts` patches `setRawMode` to re-apply
  `ENABLE_MOUSE_INPUT` (Bun wipes it — oven-sh/bun#25663). Without it, no mouse
  events arrive and terminal text selection breaks. `mountScreen` calls it.
- **ASCII-only in rendered text:** keep all on-screen strings ASCII. Ambiguous-
  width glyphs (arrows `↑↓`, `▸`, `↔`, `★`, `●`, `◉`/`○`, em dash, `…`) are
  mis-measured by OpenTUI on Windows terminals and corrupt the rest of the line
  (eaten spaces, shifted/garbled words). Use `>` `*` `^`/`v` `<->` `-` `...`
  instead. `·` and `›` render fine but prefer `|` / `>` for consistency.
- **Overlay layout:** in a flex-column box, wrap each line in its own `<box>`
  (see `Help`/`ListSelect`) rather than emitting bare sibling `<text>` nodes, and
  never embed `\n` inside a `<text>` — both cause lines to overlap. Use a
  `<box style={{ height: 1 }}>` for a blank spacer line.
- The hub runs each chosen tool as a child process (`bun pkg/tui/<tool>.tsx`), so
  tools get a clean terminal and the menu returns when they exit.
- Hard-coded machine-specific paths (e.g. project directories) live near the top
  of each file as named constants so they're easy to find and adjust.

## Tools

Every screen supports `h` for an in-app keybinding help overlay (any key closes),
`q` to quit, and `t` to cycle the color theme (persisted to `~/.devkit.json`,
shared by all tools). **Esc** is gentle: it peels back one step at a time (clear
filter → cancel visual sweep → clear selection) and only exits on a **second**
Esc, which shows a "Press Esc again to exit" hint. **Mouse** works too: click a
row to highlight, **hover** to move the highlight, double-click to activate,
scroll to navigate, and click the `[ y · Yes ]` / `[ n · No ]` confirm buttons.
All in the shared `ListSelect` / `Confirm`.

### `devkit` — the hub
Interactive menu listing every registered tool (from `pkg/tui/tools.tsx`); Enter
runs one, and you return to the menu when it exits. Navigate with arrows/`j`/`k`,
`/` to filter, `h` for help, `q` or Esc-Esc to quit.

- Run: `devkit` or `bun pkg/tui/devkit.tsx`

### `killport` — kill processes by port
Find what's listening on TCP ports and kill it. By default the picker shows a
**curated** view grouped into **APPS** and **SERVICES** — only ports with
something actually listening appear. The collapsed **OTHER (n)** heading is still
shown with a "press `a` to show all" hint; `a` expands it. The real OS process
name is always primary. The list **auto-refreshes** (default 1.5s; `i` cycles
0.5s/1s/1.5s/3s/5s/off), pausing while you filter, sweep, or confirm a kill.

Sectioning is **process-driven, not port-hardcoded** (`classify()` in core):
- **APPS** = a programming-language runtime (node, bun, deno, python, go, cargo,
  java, dotnet, …) *or* an exe the user runs from their own dev locations (under
  `~`, excluding installed `AppData` apps but allowing `AppData\Local\Temp` so
  `go run` binaries count). This catches arbitrarily-named compiled Go/Rust
  servers, and anything you launch — on any port (e.g. 9091).
- **SERVICES** = a known database/infra daemon name (mysqld, postgres, mongod,
  redis-server, docker, …) *or* a well-known service port.
- A small port catalog (`portInfo()`) supplies only the dim hint (`· MySQL`,
  `· Vite`) and a fallback for well-known ports.

For runtime processes (node/bun/deno/python/go/…) the **NAME** column shows the
**real app name** from the project manifest, resolved **lazily after the list
shows** and cached per pid for the session (`pkg/core/appname.ts`). It reads the
process's working directory and walks up to the nearest manifest —
`package.json`, `Cargo.toml`, `pyproject.toml` (`[project]`/`[tool.poetry]`), or
`go.mod` — using its name (or the project folder as a fallback). Reading another
process's cwd is OS-specific: **Windows** via the PEB (`bun:ffi`, x64), **Linux**
via `/proc/<pid>/cwd`, **macOS** via `lsof`. Processes it can't inspect just keep
the runtime name. Columns are `PORT · PID · NAME · PROCESS`, where NAME flexes to
fill the available terminal width and PROCESS (the runtime) is the last column.

Picker keys: `↑↓`/`j`/`k` move · Space/Tab toggle a row · `v` visual range (press
`v`, sweep with `j`/`k`, `v` again to keep) · Enter kill (after a confirm) · `/`
filter (port, name, or PID) · `a` curated↔all · `s` sort port↔name · `i` cycle
auto-refresh interval · `y` copy highlighted PID · `r` refresh now · `h` help ·
`q` quit (Esc clears filter→sweep→selection, then a second Esc exits). Or direct:

- `killport` — interactive picker
- `killport 3000 8080` — kill listeners on those ports (confirms first)
- `killport 3000 -y` — skip the confirmation prompt
- `killport --interval=<ms|off>` — picker's starting auto-refresh (default 1500)
- Core: `pkg/core/killport.ts` (`classify()`, `portInfo()`), `pkg/core/appname.ts`
  (`resolveAppName()`) · UI: `pkg/tui/killport.tsx`

Listeners are gathered from native `netstat -ano` joined with one `Get-Process`
call, run in parallel (~350ms) — this avoids the slow `Get-NetTCPConnection`
cmdlet the first version used (~1s).

Core Windows processes (System, svchost, lsass, …) are flagged **protected** and
can't be selected/killed. A process listening on several selected ports is killed
once (PIDs are de-duplicated).

### `launch` — project launcher
A config-driven launcher for your dev projects (the generic successor to the old
work-specific `egp`). Pick a project and Enter starts its **default command(s)**
together (e.g. backend + frontend), streaming their logs to the terminal;
Ctrl-C stops them.

Projects come from two sources, both persisted in `~/.devkit.json` under a
`launch` key (`{ projects: [], scanRoots: [] }`). Nothing is hard-coded — a fresh
install starts empty; the user configures everything from the UI (which writes to
that JSON) or by editing the file directly (each scan root may carry an `exclude`
list):
- **Scan roots** — folders auto-scanned every run; each subfolder with a runnable
  manifest becomes a project. New subprojects show up automatically. Add/remove
  via `s`.
- **Manual projects** — added explicitly via **auto-detect** (point at a folder,
  we read its scripts and you pick which to keep + which are default) or **by
  hand** (name, commands, defaults).

Each project owns a set of **commands**; one or more are flagged *default* (what
Enter starts). Command discovery (`pkg/core/manifest.ts`) reads `package.json`
`scripts` (run via the detected package manager — bun/pnpm/yarn/npm),
`Cargo.toml` (`cargo run`), `go.mod` (`go run .`), and `pyproject.toml`
(`[project.scripts]` / `[tool.poetry.scripts]` → `poetry run <name>`).

Project rows are `NAME ▸ default-scripts`; names are padded to a uniform width so
the scripts column lines up, and each section header (`PROJECTS` / `SCANNED · x` /
`★ PINNED`) carries a right-side `SCRIPTS` label over that column (no separate
header row). A project can be **pinned** (favorited) with **`p`** — pinned projects
float to a `★ PINNED` section at the top (across both manual and scanned).

The list has two **sort modes**, toggled with **`o`** and persisted in
`launch.sortMode`: **manual** (the default — your custom order, alphabetical until
you reorder; **`[`** / **`]`** move the highlighted project up / down within its
section, highlight following) and **recent** (most-recently-launched first). Pins
and the manual order persist under `launch.pinned` / `launch.order`. Pin/reorder/
sort are **in-memory and instant**: discovery (`scanProjects`, filesystem) is split
from ordering (`orderProjects`, pure), and these edits only re-order in memory and
**debounce-persist** (~400ms) — never re-scanning or writing on each keypress (the
keypress-time disk write was what made reordering lag on Windows). `ListSelect`'s
`onReorder` moves the cursor in lockstep so the highlight tracks the moved row.

Each launch is **remembered** per project (`launch.lastRun`: id → command labels,
`launch.lastRunAt`: id → time): the **recent** sort uses the time, and re-opening
the **`a`** picker pre-marks your last run (falling back to the defaults), so a
non-default command set is one keystroke to repeat.

**Scan folders** (`s`): a dedicated screen lists each scan root with its project +
hidden counts. `n` add a root, `d` remove one, **Enter** opens that root's
**hidden** list where Enter/`d` **un-hide** (revert) a project you previously hid
(via `d` on a scanned project) or that an **adopt** excluded — un-hiding drops it
from the root's `exclude` so it's scanned again. Hiding/adopting never touch disk,
so they're always reversible here. (Deleting a *manual* project is permanent —
there's no folder to restore it from.)

Picker keys: `↑↓`/`j`/`k` move · Enter start defaults · **`a`** pick which
commands to run for this run (a multi-select, pre-marked with your last run else
the defaults) · **`p`** pin / unpin · **`[` `]`** reorder (manual sort) · **`o`**
toggle sort (manual ↔ recent) · **`n`**
add a project (auto / manual / scan folder) · **`e`** edit (rename, set defaults,
remove commands; editing a scanned project first **adopts** it — copies it into
your config and excludes the original folder from the scan so it isn't listed
twice) · **`d`** delete a manual project, or **hide** a scanned one (adds its
folder to the scan root's `exclude` list — never touches disk; un-hide via `s`) ·
**`s`** manage scan folders (add/remove roots, un-hide hidden projects) · `r`
rescan · `/` filter · `h` help (grouped) · `t` theme · `q`/Esc-Esc quit. Or direct:

- `launch` — interactive picker
- `launch <name>` — start that project's default command(s)
- Core: `pkg/core/launch.ts` (+ `pkg/core/manifest.ts`) · UI: `pkg/tui/launch.tsx`
  (text entry via the shared `TextPrompt` component)

## Adding a new tool

1. **Logic** → `pkg/core/<tool>.ts`: pure functions, no UI/`console`.
2. **UI** → `pkg/tui/<tool>.tsx`: a `<Screen>` built on the shared components, plus
   a CLI entry guarded by `if (import.meta.main)`. Reuse `mountScreen`, `ListSelect`,
   `Header`, `Confirm`.
3. **Register** → add a row to `TOOLS` in `pkg/tui/tools.tsx` so the hub lists it.
4. **Shim** → `bin/<tool>.bat` (on PATH, so `<tool>` works from any shell):
   ```bat
   @echo off
   bun "%~dp0..\pkg\tui\<tool>.tsx" %*
   ```
5. Add a `scripts` entry in `package.json` and document it under **Tools** above.

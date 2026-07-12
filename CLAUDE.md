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
│   ├── launch.bat       # → pkg/tui/launch.tsx   (same pattern for every tool)
│   ├── killport.bat
│   ├── clean.bat
│   └── x.bat
├── pkg/
│   ├── core/            # PURE logic — no terminal UI, reusable by a future GUI
│   │   ├── launch.ts    # project registry + scan, config CRUD, startCommands
│   │   ├── killport.ts
│   │   ├── clean.ts     # artifact scan/size/delete + global packages
│   │   ├── x.ts         # detect() — ranked readings of any pasted string
│   │   ├── manifest.ts  # read package.json/go.mod/Cargo.toml/pyproject for cmds
│   │   ├── appname.ts   # resolve app name from a pid's cwd (cross-platform)
│   │   ├── proc.ts      # defensive spawn helpers (runCapture/firstCapture/runFeed)
│   │   ├── clipboard.ts # cross-platform clipboard copyText/readText
│   │   └── config.ts    # persisted settings (~/.devkit.json): theme + scanRoots + launch
│   └── tui/             # OpenTUI/React screens
│       ├── app.tsx          # mountScreen() — renderer bootstrap + teardown
│       ├── theme.ts         # Theme type + color presets
│       ├── theme-context.tsx# ThemeProvider / useTheme / cycle (t key)
│       ├── winmouse.ts      # Windows mouse fix (Bun #25663 workaround)
│       ├── winsize.ts       # live terminal size via Win32 (SIGWINCH shim)
│       ├── tools.tsx        # tool registry the hub lists
│       ├── devkit.tsx       # the hub screen
│       ├── launch.tsx       # launch screen + CLI entry
│       ├── killport.tsx     # killport screen + CLI entry
│       ├── clean.tsx        # clean screen + CLI entry
│       ├── x.tsx            # x screen + CLI entry
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
  multi-select with `initialMarked`, mouse click + hover-tint + scroll-wheel,
  a stable scroll-into-view viewport (`windowStart`), `t` theme cycle;
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
  `~/.devkit.json` (`pkg/core/config.ts`) so it applies across every tool. Row
  states use `selBg` (cursor / clicked) and `hoverBg` (a subtler tint for the row
  under the mouse) — adding a preset means filling in every token.
- **Mouse on Windows:** `pkg/tui/winmouse.ts` patches `setRawMode` to re-apply
  `ENABLE_MOUSE_INPUT` (Bun wipes it — oven-sh/bun#25663). Without it, no mouse
  events arrive and terminal text selection breaks. `mountScreen` calls it.
- **Resize on Windows:** OpenTUI's only resize source is `process.on("SIGWINCH")`,
  which never fires on Windows — and Bun's `stdout.columns/rows` are snapshotted
  at startup there, so polling them never sees a change either. `mountScreen`
  shims it with `pkg/tui/winsize.ts`: `terminalSize()` asks the Win32 console
  directly (`GetConsoleScreenBufferInfo` via `bun:ffi`, reading `srWindow` from
  the 22-byte CSBI struct — same kernel32 pattern as winmouse) and falls back to
  `stdout.columns/rows` off Windows / when no console is attached (piped, test
  harness → clean `null`). A 300ms poll plus a listener on stdout's `"resize"`
  event calls `renderer.resize(w, h)` on change; `processResize` no-ops when
  unchanged, so the poll is free. Poll + listener are cleaned up in `done()`.
- **List rows are not text-selectable** (the `user-select: none`-on-controls rule).
  On left mouse-down OpenTUI hit-tests the topmost renderable and starts a drag
  text-selection if it's `selectable` — and `TextRenderable` defaults to
  `selectable: true` (`BoxRenderable` is `false`), so a click landed on the row's
  `<text>` and smeared a selection highlight across it. A row click is an *action*,
  not "select this text". `ListSelect` therefore holds a `ref` to its root box and,
  in an effect after every render, walks its own subtree setting
  `selectable = false` (rows are rebuilt on filter/refresh/re-sort, and fresh
  renderables default back to `true`). **Scope matters:** do *not* disable selection
  renderer-wide (`renderer.startSelection`) — text outside the list (headers, hints,
  help, streamed logs) must stay selectable and drag-copyable. This also means a
  screen's `renderRow` needs no `selectable` prop; it's handled for every tool.
- **ASCII-only in rendered text:** keep all on-screen strings ASCII. Ambiguous-
  width glyphs (arrows `↑↓`, `▸`, `↔`, `★`, `●`, `◉`/`○`, em dash, `…`) are
  mis-measured by OpenTUI on Windows terminals and corrupt the rest of the line
  (eaten spaces, shifted/garbled words). Use `>` `*` `^`/`v` `<->` `-` `...`
  instead. `·` and `›` render fine but prefer `|` / `>` for consistency.
- **Overlay layout:** in a flex-column box, wrap each line in its own `<box>`
  (see `Help`/`ListSelect`) rather than emitting bare sibling `<text>` nodes, and
  never embed `\n` inside a `<text>` — both cause lines to overlap. Use a
  `<box style={{ height: 1 }}>` for a blank spacer line.
- The hub runs each chosen tool **in-process** via the shared `mountScreen` loop
  (each tool exports a `run<Tool>Screen()` the registry calls) — it tears its own
  screen down, mounts the tool's, and shows the menu again when the tool returns.
  In-process (not a child process) is what keeps raw keyboard/mouse alive on
  Windows. `killport` returns to the menu on quit; `launch` streams its dev-server
  logs and holds the terminal until Ctrl-C (like running `launch` standalone).
- Hard-coded machine-specific paths (e.g. project directories) live near the top
  of each file as named constants so they're easy to find and adjust.
- **`scanRoots` are shared config**, stored at the TOP LEVEL of `~/.devkit.json` —
  the project folders every cross-project tool works from (`launch` discovers
  runnable projects there, `clean` reclaims their build artifacts). Read them via
  `loadScanRoots()` (`pkg/core/launch.ts`); never reach into `launch`'s own
  config. Legacy configs kept them under `launch.scanRoots` — reads fall back to
  that and the next `saveLaunch()` migrates them up. A root's `exclude` list is a
  *launch-view* concern (hiding projects from the picker); `clean` ignores it.
- **CLI tools respect pipes** (`x`): when stdout is **not a TTY**, print the raw
  value/output only — no headings, no "Copied." chatter, no clipboard side
  effects — so they compose (`... | x`, `x <val> | jq`). When stdout IS a TTY,
  be helpful: headings, notes, copy to clipboard. Check `process.stdout.isTTY`.
- **Clipboard** goes through `pkg/core/clipboard.ts` (`copyText`/`readText`,
  cross-platform, defensive) — never spawn `clip`/`pbcopy` directly in a screen.

## Tools

Every screen supports `h` for an in-app keybinding help overlay (any key closes),
`q` to quit, and `t` to cycle the color theme (persisted to `~/.devkit.json`,
shared by all tools). **Esc** is gentle: it peels back one step at a time (clear
filter → cancel visual sweep → clear selection) and only exits on a **second**
Esc, which shows a "Press Esc again to exit" hint. **Mouse** works too: **hover**
tints the row under the pointer (`hoverBg`), a **single click** activates the row
(same as Enter on it — there is no double-click), the **wheel** navigates, and the
`[ y · Yes ]` / `[ n · No ]` confirm buttons are clickable. All in the shared
`ListSelect` / `Confirm`. Since a click *runs* the row, there's no click-to-just-
highlight gesture: keys that act on the highlighted row (launch's `e`/`d`/`a`/`p`)
are driven by moving the cursor with `j`/`k` or the wheel.

**Viewport = scroll-into-view, never cursor-centering** (`windowStart()` in
`ListSelect`): the window holds still and only moves when the cursor steps *off*
an edge, and then by exactly one row. Clicking a visible row, hovering, or a
killport auto-refresh therefore never shift the list — it scrolls only on the
wheel or when you walk past an edge with `j`/`k`. (Centering the cursor was the
old layout shift: every cursor change re-centered the window and pulled in a row,
so a click mid-list visibly jumped.) Hover is likewise **cosmetic only** — it
tints, but never moves the cursor or the viewport, so it cannot scroll.

**Hover / selection are both backgrounds on the row `<box>`**, set in one place in
`ListSelect` — `selected ? theme.selBg : hovered ? theme.hoverBg : undefined`.
Backgrounds repaint existing cells, so neither state changes the row's height:
no layout shift as the pointer moves. Rows therefore need **no** hover plumbing —
`renderRow` only receives `{ selected, marked }`.

Two dead ends worth not re-litigating: a row-`<box>` **`border: ["bottom"]`** looks
like an underline but **costs a whole extra row** (measured: 4 rows render as 5
lines), i.e. it re-introduces the layout shift on every hover. And a **text
underline** (`TextAttributes.UNDERLINE`) can only live on `<text>`/`<span>`, not on
a box — and a terminal draws it in each span's own `fg`, so a multi-column row
underlines in several colors at once. Making it one color meant collapsing every
column's `fg` and threading `hovered` into all 7 row components; `hoverBg` gets
the same affordance for free.

**Non-selectable rows stay inert.** `ListSelect` gates *both* hover and click on
`isSelectable`, so a row that can't be picked (killport's **protected** system
processes) never takes the hover highlight and a click on it does nothing — not
even move the cursor. Without this, hovering a protected row lit it up like a
clickable one and the click then silently did nothing.

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

Listener discovery is **cross-platform**, dispatched on `process.platform`:
**Windows** joins native `netstat -ano` with one `Get-Process` (PowerShell) and
kills via `taskkill /F /T`; **Linux** uses `ss -tlnp` (port + pid + name in one
shot, exe path from `/proc/<pid>/exe`) and kills via `kill -9`; **macOS** uses
`lsof -nP -iTCP -sTCP:LISTEN` and `kill -9`. Every external command is spawned
defensively (`runCapture` swallows a missing-binary throw), so an absent tool
yields an empty list instead of crashing the picker.

Core OS processes (Windows: System, svchost, lsass, …; POSIX: pid 1
init/systemd/launchd) are flagged **protected** and can't be selected/killed; a
listener whose owner can't be resolved (e.g. another user's socket in `ss`) shows
as pid 0 and is likewise protected. A process listening on several selected ports
is killed once (PIDs are de-duplicated).

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
- `launch <name|partial|index>` — start that project's default command(s), matched
  (via `resolveProject`) by full name, a partial/prefix, or its 1-based position
  in the displayed list (recent sort: `1` = last opened; manual sort: visible top)
- `launch <name|partial|index> -a` (`--ask`) — instead of starting the defaults,
  open **that project's command picker** (the same `a` page as in the TUI,
  pre-marked with your last run else the defaults) and run what you select. Done
  by passing `initialProject` to `LaunchScreen`, which then starts in its `run`
  mode rather than `list` — Esc still falls back to the project list.
- Core: `pkg/core/launch.ts` (+ `pkg/core/manifest.ts`) · UI: `pkg/tui/launch.tsx`
  (text entry via the shared `TextPrompt` component)

### `clean` — reclaim disk space
Finds regenerable **build artifacts** (`node_modules`, `.next`, `.nuxt`, `.turbo`,
`dist`, `build`, `out`, `target`, `__pycache__`, `.pytest_cache`, `coverage`)
across every project under the shared scan roots — each project folder plus one
level of subpackages (monorepos). **Dry-run by default**: running `clean` only
scans and reports; nothing is deleted until rows are marked and a Confirm is
answered, and there is deliberately **no non-interactive delete flag**.

Rows are `KIND · PROJECT · SIZE · LAST USED`. Discovery (`scanArtifacts`, a cheap
readdir pass) is split from **sizing** (`sizeArtifacts`) because a `node_modules`
holds 50k+ files: what needs measuring is walked on a small concurrency pool
(4 walkers) and the SIZE column fills in as each tree finishes — the same
lazy-fill pattern as killport's app names.

**Sizes are measured once and cached with a validity key** (`~/.devkit-cache.json`
— deliberately *not* SWR; a trusted cache entry is never re-walked). The key
says when a cached number stops being trustworthy (`artifactKey`/`globalKey` in
core): `node_modules` → the **hash of the project's lockfile** (first of
bun.lock/bun.lockb/package-lock.json/pnpm-lock.yaml/yarn.lock/deno.lock — deps
changed ⇒ re-measure); other artifact kinds → the artifact dir's **mtime**
(rebuilds touch it); globals → the installed **version**. On mount, entries with
a matching key are adopted as-is and only the rest are walked — so the first run
measures everything, later runs measure only what changed. Manual re-measure:
**`u`** (highlighted row) / **`r`** (refresh everything: rescan the folders AND
re-measure all sizes) — both evict the cache entries first, so a forced refresh
never trusts old numbers. Deleted/uninstalled paths are evicted so they don't
ghost-paint. Sorting (`s`) is size↔name; the header totals what's reclaimable
with a `sizing i/n` ASCII spinner while walks are in flight.

The sizing engine lives in **refs, not an effect** (`pump`/`enqueue` in
`clean.tsx`): an effect-scoped pool got cancelled by its own cleanup whenever
`arts` changed identity mid-run (e.g. when the in-use marking landed), stranding
every unfinished row — the "stuck at 3/n" bug. The ref-based pool survives any
re-render; a reconciler effect only adopts valid cache entries and queues the
rest (idempotent). Refreshing a path mid-walk is safe: `u`/`r` remove it from
`sized`, so the in-flight result fails a "still wanted?" check on completion,
is discarded, and the path re-queues — without disturbing the rest of the run.
A watchdog in the spinner interval enforces the invariant "pending + idle =
re-queue": if rows are unsized but nothing is queued or walking, they're
re-queued automatically.

A project with a **live listening process working inside it** (cwds via
`listListeners()` + `readProcessCwd()`) is marked `(in use)` and can't be
selected — deleting `node_modules` under a running dev server is the one real
foot-gun. (Limitation: a portless process like a bare `tsc --watch` isn't seen.)
After a delete that included a `node_modules`, a Confirm offers to **reinstall**
(`detectPm()` per project); accepting tears the screen down and streams
`<pm> install` per project (launch's terminal-handoff pattern).

**Globals are shown only when asked**: `g` (or `--globals`) reveals a GLOBALS
section listing packages from **bun + npm + pnpm + deno** (`MANAGER · NAME ·
SIZE · VERSION`, loaded lazily, each manager probed defensively). Turning `g` on
also **jumps the cursor onto the section** (no manual scroll past all the
artifacts) — deferred until the lazily-loaded rows exist, then driven through
`ListSelect`'s `controlRef` handle (`jumpTo(key)`); scroll-into-view brings the
viewport along. Each package's
**size** is measured too: `listGlobals` resolves the on-disk path per manager
(bun's global `node_modules` from `bun pm ls -g`'s first line, `npm root -g`,
`pnpm root -g`; deno = the binaries in `~/.deno/bin`, grouped by stem) and those
paths flow through the same sizing pool + SWR cache as artifacts. Both sections
carry subtotals in their headers and the screen header shows the combined
"X reclaimable (artifacts + globals)" plus a `sizing 12/58 |` ASCII spinner
while walks are in flight. Marked globals are uninstalled via their own manager
(deno falls back to the legacy no-`-g` uninstall). The managers themselves
(`npm`, `pnpm`, `yarn`, `corepack`, `bun`, `deno`) and `@hicoders/devkit` are
protected rows.

- `clean` — interactive picker (a scan/report until you mark + confirm)
- `clean --globals` — start with the GLOBALS section already shown
- Core: `pkg/core/clean.ts` · UI: `pkg/tui/clean.tsx`

### `x` — decode anything
Paste a string, get it readable — **locally** (zero network, nothing persisted;
the point is that real tokens stop going to jwt.io / base64decode.org /
epochconverter.com). `detect()` runs every detector and returns ranked candidate
readings: **jwt** (header+claims pretty-printed, `exp`/`iat`/`nbf` humanized as
"EXPIRED 3h ago", loud warning on `alg: none`, always noted as decoded-NOT-
verified; an empty signature part is accepted since `alg:none` tokens end with
a bare dot), **json** (pretty-print; malformed input reports the parse error
plus hints like trailing commas / unquoted keys), **base64/base64url** (printable-
ratio gated; decoding to JSON boosts confidence and pretty-prints; short all-alpha
words are damped to avoid false hits), **epoch** (10/13-digit within 2001–2100 →
local + UTC + relative), **uuid** (version/variant; v7 shows its embedded
timestamp), **url** (decode + query params split out), **hash** (32/40/64/96/128
hex → md5/sha1/sha256/... guess, low confidence by design), **color** (#hex →
rgb/hsl), **cron** (per-field English, 6 fields read Quartz seconds-first).

Input precedence: **argument > piped stdin > clipboard** — so bare `x` decodes
whatever was just copied. TTY output prints a heading + note + "also matched:
..."; piped output is the rendered result only.

- `x <value>` / `... | x` / `x` (clipboard)
- `x --as <type>` force a reading · `x --all` print every candidate · `-c` copy
  the output back to the clipboard · `-i` interactive screen (TextPrompt input,
  `t`/arrows cycle candidate readings, `c` copy, `n` new input)
- Core: `pkg/core/x.ts` · UI: `pkg/tui/x.tsx`

## Adding a new tool

1. **Logic** → `pkg/core/<tool>.ts`: pure functions, no UI/`console`.
2. **UI** → `pkg/tui/<tool>.tsx`: a `<Screen>` built on the shared components, a
   CLI entry guarded by `if (import.meta.main)`, and an exported
   `run<Tool>Screen()` that `mountScreen`s the screen and returns (no
   `process.exit`) so the hub can run it in-process. Reuse `mountScreen`,
   `ListSelect`, `Header`, `Confirm`.
3. **Register** → add a row to `TOOLS` in `pkg/tui/tools.tsx` (with
   `run: () => run<Tool>Screen()`) so the hub lists and runs it.
4. **Shim** → `bin/<tool>.bat` (on PATH, so `<tool>` works from any shell):
   ```bat
   @echo off
   bun "%~dp0..\pkg\tui\<tool>.tsx" %*
   ```
5. Add a `scripts` entry in `package.json` and document it under **Tools** above.

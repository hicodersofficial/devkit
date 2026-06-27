# tools

A personal collection of small, daily-use developer/productivity tools — CLI
utilities and scripts that speed up my own programming workflow. Each tool is
self-contained and can be launched from anywhere via a thin `.bat` shim.

`bin/` is on the user `PATH` (entry: `C:\Users\hicod\tools\bin`), so every shim
there is runnable by name from any shell.

## Layout

```
tools/
├── bin/           # launcher shims — this folder is on PATH
│   └── egp.bat
├── pkg/           # the actual tool source — one file (or folder) per tool
│   └── egp.ts
├── tsconfig.json
├── package.json
└── CLAUDE.md
```

- **`pkg/`** holds the real source. Prefer **TypeScript** (`.ts`, run with Bun).
  **Python** (`.py`) is also fine when it's the better fit for a given tool.
- **`bin/`** holds the `.bat` shims and is on the user `PATH`. Each is a tiny
  shim that invokes its tool in `../pkg`. Using `%~dp0` (the shim's own folder)
  keeps them portable regardless of where the repo lives. Example (`bin/egp.bat`):

  ```bat
  @echo off
  bun "%~dp0..\pkg\egp.ts" %*
  ```

## Conventions

- One tool = one entry in `pkg/` + one `.bat` shim of the same name in `bin/`.
- TypeScript tools run directly with **Bun** (`bun pkg/<tool>.ts`) — no build step.
- Keep each tool dependency-light and self-documenting (header comment explaining
  what it does and how to use it).
- Hard-coded machine-specific paths (e.g. project directories) live near the top
  of each file as named constants so they're easy to find and adjust.

## Tools

### `egp` — EGP project launcher
Interactive terminal menu that scans `G:\EGP\Apps` for runnable projects and
starts a project's dev services together (backend before frontend). A project is
either a folder whose `package.json` has a `dev`/`start` script, or a folder of
sub-packages that each have one. Navigate with arrows/`j`/`k`, `/` to filter,
Enter to start, `q`/Esc to quit.

- Run: `egp` (via `egp.bat`) or `bun pkg/egp.ts`
- Source: `pkg/egp.ts`

## Adding a new tool

1. Create the source in `pkg/` (e.g. `pkg/mytool.ts` or `pkg/mytool.py`).
2. Add a `mytool.bat` shim in `bin/` that runs it (it's on PATH, so `mytool`
   then works from any shell):
   - TS: `bun "%~dp0..\pkg\mytool.ts" %*`
   - Python: `python "%~dp0..\pkg\mytool.py" %*`
3. Document it under **Tools** above.

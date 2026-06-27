# tools

A personal collection of small, daily-use developer/productivity tools — CLI
utilities and scripts that speed up my own programming workflow. Each tool is
self-contained and can be launched from anywhere via a thin `.bat` shim.

## Layout

```
tools/
├── *.bat          # launcher shims (live in repo root, on PATH or run by name)
├── pkg/           # the actual tool source — one file (or folder) per tool
│   └── egp.ts
├── tsconfig.json
├── package.json
└── CLAUDE.md
```

- **`pkg/`** holds the real source. Prefer **TypeScript** (`.ts`, run with Bun).
  **Python** (`.py`) is also fine when it's the better fit for a given tool.
- **`*.bat`** files stay in the repo root. Each is a tiny shim that invokes its
  tool in `pkg/`. Using `%~dp0` keeps them portable regardless of where the repo
  lives. Example (`egp.bat`):

  ```bat
  @echo off
  bun "%~dp0pkg\egp.ts" %*
  ```

## Conventions

- One tool = one entry in `pkg/` + one `.bat` shim of the same name in the root.
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
2. Add a `mytool.bat` shim in the repo root that runs it:
   - TS: `bun "%~dp0pkg\mytool.ts" %*`
   - Python: `python "%~dp0pkg\mytool.py" %*`
3. Document it under **Tools** above.

# devkit

**Your terminal toolbelt — the small, annoying dev chores, fixed in a keystroke.**

`devkit` is a set of fast, keyboard-driven terminal tools for everyday development.
One hub, clean UI, mouse-friendly, no config to get started.

```sh
bun install -g @hicoders/devkit
```

> **Install with [Bun](https://bun.com), not npm.** devkit runs on Bun and relies
> on Bun to pull in the right native UI binary for your platform. `npm install -g`
> is not supported and can fail at runtime.

Then just run `devkit` — or jump straight to a tool by name.

---

## What you get

### 🔪 Kill whatever's hogging a port

That dreaded `Error: port 3000 is already in use`? Gone.

```sh
killport 3000          # kill whatever is on port 3000
killport 3000 8080     # several at once
killport               # not sure what's running? open the picker
```

The picker shows what's **actually** listening — grouped into your **apps** and
**services**, with real project names (not just "node"), auto-refreshing live.
Select with the keyboard or mouse, hit Enter, done.

> No more `netstat | findstr` → copy PID → `taskkill /F /PID …`. One screen, one keystroke.

### 🚀 Start your projects with one key

Stop `cd`-ing into folders and remembering which script to run.

```sh
launch                 # pick a project, press Enter
launch my-app          # or start it straight away
```

Point `launch` at the folders where your projects live and it finds them all
automatically — reading `package.json`, `go.mod`, `Cargo.toml`, and
`pyproject.toml`. Press **Enter** to start a project's default command(s)
(backend **and** frontend together, streaming logs); Ctrl-C stops everything.

- **Pin** your go-to projects to the top.
- **Reorder** the list however you like, or sort by what you ran most recently.
- Press **`a`** to launch a different combo of scripts for a one-off run — it even
  remembers your last choice.
- Add projects by auto-detecting a folder, or by hand.

### 🧰 One hub for all of it

```sh
devkit
```

A single menu lists every tool. Pick one, use it, and you're back at the menu when
it exits. Filter with `/`, navigate with arrows or `j`/`k`, press `h` anytime for
help.

---

## Nice touches

- ⌨️ **Keyboard-first**, but the **mouse works too** — click, hover, scroll, double-click.
- 🎨 **Themes** — press `t` to cycle; your choice sticks across every tool.
- 🧠 **Remembers your setup** — pins, order, and preferences persist automatically.
- ⚡ **Instant** — no build step, snappy native-feeling UI.

## Try it without installing

```sh
bunx @hicoders/devkit              # the hub
bunx -p @hicoders/devkit killport 3000
```

## Requirements

devkit runs on **[Bun](https://bun.com)** (v1.2+). Install Bun first, then install
devkit — that's the only prerequisite.

## License

[MIT](./LICENSE) © hicoders

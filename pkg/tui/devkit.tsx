#!/usr/bin/env bun
// devkit — the hub. Lists every tool and runs the chosen one.
//
// Each tool is mounted in-process (via the same mountScreen renderer loop): the
// hub tears its own screen down, runs the tool's screen, and shows the menu again
// when the tool returns. Running in-process (not as a child) is what keeps raw
// keyboard/mouse working on Windows. The same tool files run standalone too, so
// `killport` / `launch` work without going through `devkit`.

import { useState } from "react";
import { mountScreen } from "./app";
import { useTheme } from "./theme-context";
import { Header, ListSelect, Help, type Binding } from "./components";
import { TOOLS, type ToolDef } from "./tools";

const HELP: Binding[] = [
  { keys: "j / k", desc: "move (or arrow keys)" },
  { keys: "/", desc: "filter tools" },
  { keys: "enter", desc: "run the selected tool" },
  { keys: "t", desc: "cycle color theme" },
  { keys: "q / esc esc", desc: "quit (q, or Esc twice)" },
];

function ToolRow({ t, selected }: { t: ToolDef; selected: boolean }) {
  const theme = useTheme();
  return (
    <text>
      <span fg={selected ? theme.selFg : theme.fg}>{t.label.padEnd(12)}</span>
      <span fg={theme.dim}>{t.description}</span>
    </text>
  );
}

function DevkitHub({ onPick }: { onPick: (t: ToolDef | null) => void }) {
  const [showHelp, setShowHelp] = useState(false);
  if (showHelp) {
    return <Help title="devkit - keys" bindings={HELP} onClose={() => setShowHelp(false)} />;
  }
  return (
    <box style={{ padding: 1, flexDirection: "column" }}>
      <Header
        title="devkit"
        subtitle="developer toolbelt"
        hint="j/k move | / filter | enter run | t theme | h help | q quit"
      />
      <ListSelect
        items={TOOLS}
        getKey={(t) => t.id}
        filterText={(t) => `${t.label} ${t.description}`}
        active={!showHelp}
        emptyText="No tools registered."
        onSubmit={(items) => onPick(items[0] ?? null)}
        onCancel={() => onPick(null)}
        onExtraKey={(name) => {
          if (name === "h") setShowHelp(true);
        }}
        renderRow={(t, { selected }) => <ToolRow t={t} selected={selected} />}
      />
    </box>
  );
}

export async function runHub() {
  for (;;) {
    const picked = await mountScreen<ToolDef | null>((done) => <DevkitHub onPick={done} />);
    if (!picked) break;
    // Renderer is torn down by now; run the tool's screen on a clean terminal.
    await picked.run();
  }
  process.exit(0);
}

if (import.meta.main) {
  await runHub();
}

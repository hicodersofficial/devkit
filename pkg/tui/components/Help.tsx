// Help — a full-screen keybinding cheat-sheet. Render it as the whole screen
// (instead of the normal content) while help is requested; any key closes it.
//
// Layout mirrors ListSelect exactly — a plain flex-column box whose children are
// each their own row <box>. Bordered/padded containers that directly stack many
// children miscalculate child heights on some terminals and overlap; the plain
// column + per-row boxes used here render reliably. Keep all text ASCII (see
// CLAUDE.md): ambiguous-width glyphs corrupt line rendering.

import type { ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme-context";

export interface Binding {
  keys: string;
  desc: string;
}

export function Help({
  title,
  bindings,
  active = true,
  onClose,
}: {
  title: string;
  bindings: Binding[];
  active?: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  useKeyboard((key) => {
    if (!active) return;
    onClose(); // any key dismisses
    void key;
  });

  // A binding with empty `keys` is a section header (its `desc` is the heading).
  const pad = Math.max(...bindings.map((b) => b.keys.length));

  const Row = ({ children }: { children: ReactNode }) => (
    <box style={{ flexDirection: "row" }}>{children}</box>
  );
  const Blank = () => (
    <box style={{ height: 1, flexDirection: "row" }}>
      <text> </text>
    </box>
  );

  const lines: ReactNode[] = [];
  bindings.forEach((b, i) => {
    if (b.keys === "") {
      if (lines.length) lines.push(<Blank key={`gap-${i}`} />);
      lines.push(
        <Row key={i}>
          <text fg={theme.accentDim}>{b.desc}</text>
        </Row>,
      );
    } else {
      lines.push(
        <Row key={i}>
          <text fg={theme.yellow}>{b.keys.padEnd(pad)}</text>
          <text fg={theme.dim}>{`   ${b.desc}`}</text>
        </Row>,
      );
    }
  });

  return (
    <box style={{ padding: 1, flexDirection: "column" }}>
      <box style={{ flexDirection: "column" }}>
        <Row>
          <text fg={theme.accent}>{title}</text>
        </Row>
        <Blank />
        {lines}
        <Blank />
        <Row>
          <text fg={theme.dim}>press any key to close</text>
        </Row>
      </box>
    </box>
  );
}

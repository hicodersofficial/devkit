// Confirm — a small y/N bar. Owns its own keyboard handler; render it only when
// a decision is pending and set the underlying list to `active={false}`.

import { useKeyboard } from "@opentui/react";
import { useTheme } from "../theme-context";

export function Confirm({
  message,
  active = true,
  onConfirm,
  onCancel,
}: {
  message: string;
  active?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  useKeyboard((key) => {
    if (!active) return;
    if (key.name === "y") onConfirm();
    else if (key.name === "n" || key.name === "escape") onCancel();
  });

  return (
    <box
      style={{
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: theme.yellow,
        padding: 1,
        marginTop: 1,
      }}
    >
      <text fg={theme.yellow}>{message}</text>
      <box style={{ flexDirection: "row", marginTop: 1 }}>
        <box
          style={{ backgroundColor: theme.selBg, paddingLeft: 1, paddingRight: 1, marginRight: 2 }}
          onMouseDown={() => active && onConfirm()}
        >
          <text fg={theme.green}>[ y · Yes ]</text>
        </box>
        <box
          style={{ backgroundColor: theme.selBg, paddingLeft: 1, paddingRight: 1 }}
          onMouseDown={() => active && onCancel()}
        >
          <text fg={theme.red}>[ n · No ]</text>
        </box>
      </box>
    </box>
  );
}

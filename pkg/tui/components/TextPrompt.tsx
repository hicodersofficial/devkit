// TextPrompt — a single-line text input. Owns its own keyboard handler (mirrors
// ListSelect's "/" filter), so render it only while it should capture input and
// set any underlying list to `active={false}`. Give each use a distinct React
// `key` when the `initial` value differs between steps, so it remounts fresh.
//
// Accepts both typed characters and pasted text — the terminal delivers a paste
// either as a bracketed-paste event (usePaste) or as one multi-character key
// chunk, so we handle both.

import { useState } from "react";
import { useKeyboard, usePaste } from "@opentui/react";
import { useTheme } from "../theme-context";

// Drop control chars (incl. CR/LF/Esc) so pasted/typed text stays single-line.
const printable = (s: string) => s.replace(/[\x00-\x1f]/g, "");

export function TextPrompt({
  label,
  initial = "",
  placeholder,
  active = true,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial?: string;
  placeholder?: string;
  active?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [value, setValue] = useState(initial);

  usePaste((event) => {
    if (!active) return;
    const text = printable(new TextDecoder().decode(event.bytes));
    if (text) setValue((v) => v + text);
  });

  useKeyboard((key) => {
    if (!active) return;
    if (key.name === "escape") {
      onCancel();
    } else if (key.name === "return") {
      onSubmit(value);
    } else if (key.name === "backspace") {
      setValue((v) => v.slice(0, -1));
    } else {
      // A single char, or a paste delivered as one key chunk. Reject escape
      // sequences (special keys) — they always contain an Esc byte.
      const ch = key.sequence;
      if (ch && !key.ctrl && !key.meta && !ch.includes("\x1b")) {
        const text = printable(ch);
        if (text) setValue((v) => v + text);
      }
    }
  });

  return (
    <box
      style={{
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: theme.accent,
        padding: 1,
        marginTop: 1,
      }}
    >
      <text fg={theme.accent}>{label}</text>
      <text>
        {value ? (
          <span fg={theme.fg}>{value}</span>
        ) : (
          <span fg={theme.dim}>{placeholder ?? ""}</span>
        )}
        <span fg={theme.dim}>_</span>
      </text>
      <text fg={theme.dim}>enter confirm | esc cancel | paste supported</text>
    </box>
  );
}

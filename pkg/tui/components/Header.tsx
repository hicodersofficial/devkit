// Header — consistent title + hint block shown at the top of each screen.

import { useTheme } from "../theme-context";

export function Header({
  title,
  subtitle,
  hint,
}: {
  title: string;
  subtitle?: string;
  hint?: string;
}) {
  const theme = useTheme();
  // Each line is its own row <box> and the gap is a height:1 box (not
  // marginBottom) — a column box with margin/padding that directly stacks bare
  // <text> children overlaps them on some terminals. See Help for the rationale.
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row" }}>
        <text>
          <span fg={theme.accent}>* </span>
          <span fg={theme.fg}>{title}</span>
          {subtitle ? <span fg={theme.dim}>{`  ${subtitle}`}</span> : null}
        </text>
      </box>
      {hint ? (
        <box style={{ flexDirection: "row" }}>
          <text fg={theme.dim}>{hint}</text>
        </box>
      ) : null}
      <box style={{ height: 1, flexDirection: "row" }}>
        <text> </text>
      </box>
    </box>
  );
}

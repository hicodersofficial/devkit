// Shared visual tokens for every devkit TUI screen, so the suite looks uniform.
// Multiple named presets; the active one is chosen via the theme context and
// cycled with `t` (persisted in ~/.devkit.json). Add a preset by appending to
// THEMES — every screen picks it up automatically.

export interface Theme {
  name: string;
  accent: string; // primary brand / highlight color
  accentDim: string; // section headers, secondary accent
  fg: string; // normal text
  dim: string; // muted/secondary text
  muted: string; // between fg and dim
  green: string; // success
  red: string; // danger
  yellow: string; // warning / confirm
  selBg: string; // highlighted-row background (the cursor / clicked row)
  selFg: string; // highlighted-row text
  hoverBg: string; // row under the mouse — a subtler tint than selBg
}

export const THEMES: Theme[] = [
  {
    name: "midnight",
    accent: "#7C9CF4",
    accentDim: "#5566AA",
    fg: "#E6E6E6",
    dim: "#7A7A7A",
    muted: "#9AA0AA",
    green: "#5BD75B",
    red: "#FF6B6B",
    yellow: "#E5C07B",
    selBg: "#293356",
    selFg: "#FFFFFF",
    hoverBg: "#1B2138",
  },
  {
    name: "matrix",
    accent: "#4AE24A",
    accentDim: "#2E8B2E",
    fg: "#C8F7C8",
    dim: "#5A7A5A",
    muted: "#79A079",
    green: "#5BD75B",
    red: "#FF6B6B",
    yellow: "#D7D75B",
    selBg: "#143314",
    selFg: "#EAFFEA",
    hoverBg: "#0D1F0D",
  },
  {
    name: "amber",
    accent: "#E5A94B",
    accentDim: "#A0762E",
    fg: "#F0E6D6",
    dim: "#8A7A5A",
    muted: "#B0A080",
    green: "#9BD75B",
    red: "#FF7B6B",
    yellow: "#E5C07B",
    selBg: "#3A2E14",
    selFg: "#FFF6E6",
    hoverBg: "#241D0D",
  },
  {
    name: "rose",
    accent: "#FF6B9D",
    accentDim: "#AA4470",
    fg: "#F5E0EA",
    dim: "#8A6A7A",
    muted: "#B080A0",
    green: "#5BD75B",
    red: "#FF6B6B",
    yellow: "#E5C07B",
    selBg: "#3A1428",
    selFg: "#FFF0F6",
    hoverBg: "#240C19",
  },
  {
    name: "mono",
    accent: "#FFFFFF",
    accentDim: "#888888",
    fg: "#DDDDDD",
    dim: "#777777",
    muted: "#999999",
    green: "#BBBBBB",
    red: "#FF6B6B",
    yellow: "#CCCCCC",
    selBg: "#333333",
    selFg: "#FFFFFF",
    hoverBg: "#1F1F1F",
  },
];

export const defaultTheme = THEMES[0]!;

export function themeByName(name: string | undefined): Theme {
  return THEMES.find((t) => t.name === name) ?? defaultTheme;
}

export function nextTheme(current: string): Theme {
  const i = THEMES.findIndex((t) => t.name === current);
  return THEMES[(i + 1) % THEMES.length]!;
}

// Renderer bootstrap shared by every devkit screen.
//
// `mountScreen` mounts a React screen, hands it a `done(value)` callback, and
// resolves once the screen calls it — fully tearing the renderer down first so
// the terminal is restored (important before spawning a child tool or handing
// off to dev-server stdio). This lets the `devkit` hub run screens in a loop.

import { createCliRenderer, type CliRendererConfig } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { ReactNode } from "react";
import { enableWindowsMouse } from "./winmouse";
import { terminalSize } from "./winsize";
import { ThemeProvider } from "./theme-context";

export async function mountScreen<T>(
  render: (done: (value: T) => void) => ReactNode,
  config: CliRendererConfig = {},
): Promise<T> {
  // Must run before the renderer's setRawMode (works around Bun #25663 on Windows).
  enableWindowsMouse();
  const renderer = await createCliRenderer({ exitOnCtrlC: true, ...config });

  // Terminal-resize shim. OpenTUI's only resize source is process.on("SIGWINCH"),
  // which never fires on Windows — and Bun's stdout.columns/rows are snapshotted
  // at startup there, so polling THEM never sees a change either. terminalSize()
  // asks the Win32 console directly (GetConsoleScreenBufferInfo) on each call and
  // falls back to stdout.columns elsewhere. The renderer exposes resize(w, h)
  // exactly for externally-driven events, and processResize() no-ops when the
  // dimensions are unchanged, so a light poll is safe and cheap. We also
  // subscribe to stdout's "resize" event for runtimes that do emit it.
  const syncSize = () => {
    const size = terminalSize();
    if (size && (size.width !== renderer.terminalWidth || size.height !== renderer.terminalHeight)) {
      renderer.resize(size.width, size.height);
    }
  };
  const resizePoll = setInterval(syncSize, 300);
  process.stdout.on?.("resize", syncSize);

  const root = createRoot(renderer);
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      clearInterval(resizePoll);
      process.stdout.off?.("resize", syncSize);
      root.unmount();
      renderer.destroy();
      resolve(value);
    };
    root.render(<ThemeProvider>{render(done)}</ThemeProvider>);
  });
}

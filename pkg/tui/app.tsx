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
import { ThemeProvider } from "./theme-context";

export async function mountScreen<T>(
  render: (done: (value: T) => void) => ReactNode,
  config: CliRendererConfig = {},
): Promise<T> {
  // Must run before the renderer's setRawMode (works around Bun #25663 on Windows).
  enableWindowsMouse();
  const renderer = await createCliRenderer({ exitOnCtrlC: true, ...config });
  const root = createRoot(renderer);
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      root.unmount();
      renderer.destroy();
      resolve(value);
    };
    root.render(<ThemeProvider>{render(done)}</ThemeProvider>);
  });
}

// clipboard — cross-platform copy/read for the system clipboard.
//
// Pure logic, no UI. Shells out to the platform's clipboard binary, spawned
// defensively (a missing binary means false / "" — never a throw), so tools can
// offer copy/paste without caring about the OS:
//   - Windows: `clip` to write, PowerShell Get-Clipboard to read
//   - macOS:   pbcopy / pbpaste
//   - Linux:   wl-copy/wl-paste (Wayland), else xclip, else xsel

import { runFeed, firstCapture } from "./proc";

/** Copy text to the system clipboard. False when no clipboard tool is available. */
export async function copyText(text: string): Promise<boolean> {
  switch (process.platform) {
    case "win32":
      return runFeed(["clip"], text);
    case "darwin":
      return runFeed(["pbcopy"], text);
    default:
      return (
        (await runFeed(["wl-copy"], text)) ||
        (await runFeed(["xclip", "-selection", "clipboard"], text)) ||
        (await runFeed(["xsel", "-ib"], text))
      );
  }
}

/** Read the system clipboard as text. "" when empty or no tool is available. */
export async function readText(): Promise<string> {
  switch (process.platform) {
    case "win32": {
      const out = await firstCapture([
        ["powershell", "-NoProfile", "-Command", "Get-Clipboard", "-Raw"],
      ]);
      // Get-Clipboard -Raw still appends a trailing CRLF of its own.
      return out.replace(/\r?\n$/, "");
    }
    case "darwin":
      return firstCapture([["pbpaste"]]);
    default:
      return firstCapture([
        ["wl-paste", "--no-newline"],
        ["xclip", "-selection", "clipboard", "-o"],
        ["xsel", "-ob"],
      ]);
  }
}

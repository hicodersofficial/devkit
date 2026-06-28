// winmouse — work around Bun #25663 on Windows.
//
// On Windows, `process.stdin.setRawMode(true)` OVERWRITES the console input mode
// with just ENABLE_VIRTUAL_TERMINAL_INPUT (0x200) instead of preserving the
// existing flags. That wipes ENABLE_MOUSE_INPUT, so OpenTUI (which enables mouse
// and then calls setRawMode) never receives any mouse events — and it also wipes
// ENABLE_QUICK_EDIT_MODE, which is why terminal text selection stops working.
//
// Fix: monkey-patch setRawMode so that after Bun flips raw mode on, we re-apply
// the mouse flags via the Win32 console API. Doing it in the patch (not once)
// means it survives every later raw-mode toggle by OpenTUI. No-op off Windows.
//
// Ref: https://github.com/oven-sh/bun/issues/25663

import { dlopen, FFIType, ptr } from "bun:ffi";

const STD_INPUT_HANDLE = -10;
const ENABLE_MOUSE_INPUT = 0x0010;
const ENABLE_QUICK_EDIT_MODE = 0x0040;
const ENABLE_EXTENDED_FLAGS = 0x0080;
const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;

let installed = false;

export function enableWindowsMouse(): void {
  if (installed || process.platform !== "win32") return;
  installed = true;

  let k32;
  try {
    k32 = dlopen("kernel32.dll", {
      GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
      GetConsoleMode: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      SetConsoleMode: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    });
  } catch {
    return; // FFI unavailable — silently skip (keyboard still works)
  }

  const hIn = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);

  // Add the mouse flags back to whatever mode is currently set, keeping VT input
  // and ensuring QuickEdit stays off (so mouse goes to the app, not selection).
  const applyMouseFlags = () => {
    try {
      const buf = new Uint32Array(1);
      if (!k32.symbols.GetConsoleMode(hIn, ptr(buf))) return;
      const mode =
        ((buf[0]! | ENABLE_EXTENDED_FLAGS | ENABLE_MOUSE_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT) &
          ~ENABLE_QUICK_EDIT_MODE) >>>
        0;
      k32.symbols.SetConsoleMode(hIn, mode);
    } catch {
      /* ignore — non-console stdin, etc. */
    }
  };

  const stdin = process.stdin as NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => unknown;
  };
  const original = stdin.setRawMode?.bind(stdin);
  if (original) {
    stdin.setRawMode = (mode: boolean) => {
      const result = original(mode);
      if (mode) applyMouseFlags(); // re-add the flags Bun's setRawMode just wiped
      return result;
    };
  }
  applyMouseFlags(); // in case raw mode is already on
}

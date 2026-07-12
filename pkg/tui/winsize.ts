// winsize — the REAL terminal size, live, on every platform.
//
// On Windows, Bun never delivers SIGWINCH and process.stdout.columns/rows are
// snapshotted at startup — they don't change when the user resizes the window.
// So mountScreen's resize poll compared stale numbers forever and the UI never
// reflowed. The truth lives in the Win32 console API: GetConsoleScreenBufferInfo
// reports the CURRENT window rect on each call. Same kernel32 FFI pattern as
// winmouse.ts.
//
// Off Windows (or when no console is attached — piped stdout, test harness),
// falls back to process.stdout.columns/rows, which do update on POSIX.

import { dlopen, FFIType, ptr } from "bun:ffi";

const STD_OUTPUT_HANDLE = -11;

interface K32 {
  symbols: {
    GetStdHandle: (n: number) => unknown;
    GetConsoleScreenBufferInfo: (h: unknown, p: unknown) => number;
  };
}

let k32: K32 | null = null;
let hOut: unknown = null;
let ffiReady = false;
let ffiTried = false;

function initFfi(): boolean {
  if (ffiTried) return ffiReady;
  ffiTried = true;
  if (process.platform !== "win32") return false;
  try {
    k32 = dlopen("kernel32.dll", {
      GetStdHandle: { args: [FFIType.i32], returns: FFIType.ptr },
      GetConsoleScreenBufferInfo: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    }) as unknown as K32;
    hOut = k32.symbols.GetStdHandle(STD_OUTPUT_HANDLE);
    ffiReady = hOut !== null && hOut !== undefined;
  } catch {
    ffiReady = false;
  }
  return ffiReady;
}

// CONSOLE_SCREEN_BUFFER_INFO (22 bytes):
//   COORD dwSize (0,2) | COORD dwCursorPosition (4,6) | WORD wAttributes (8)
//   SMALL_RECT srWindow: Left(10) Top(12) Right(14) Bottom(16)
//   COORD dwMaximumWindowSize (18,20)
// The visible window is srWindow — that's what resizing the terminal changes.
const CSBI_BYTES = 22;

/** Current terminal size, or null when it can't be determined. */
export function terminalSize(): { width: number; height: number } | null {
  if (initFfi()) {
    try {
      const buf = new Uint8Array(CSBI_BYTES);
      if (k32!.symbols.GetConsoleScreenBufferInfo(hOut, ptr(buf))) {
        const dv = new DataView(buf.buffer);
        const width = dv.getInt16(14, true) - dv.getInt16(10, true) + 1; // Right - Left + 1
        const height = dv.getInt16(16, true) - dv.getInt16(12, true) + 1; // Bottom - Top + 1
        if (width > 0 && height > 0) return { width, height };
      }
    } catch {
      /* fall through to the stdout numbers */
    }
  }
  const width = process.stdout.columns;
  const height = process.stdout.rows;
  return width && height ? { width, height } : null;
}

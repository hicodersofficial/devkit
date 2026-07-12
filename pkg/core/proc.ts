// proc — defensive child-process helpers shared by the devkit cores.
//
// Every helper swallows a missing executable (Bun.spawn throws "Executable not
// found in $PATH") and turns it into a failed result instead of propagating, so
// a tool that is absent on this OS degrades gracefully (empty list, false)
// rather than crashing the screen.

/** Run a command and capture stdout/stderr/exit code. Never throws. */
export async function runCapture(
  cmd: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  } catch (e) {
    return { stdout: "", stderr: e instanceof Error ? e.message : String(e), code: -1 };
  }
}

/** Try each command in turn, returning the first stdout that ran (exit 0). Used
 *  to probe alternative binary locations (e.g. ss in /usr/sbin vs /usr/bin). */
export async function firstCapture(cmds: string[][]): Promise<string> {
  for (const cmd of cmds) {
    const r = await runCapture(cmd);
    if (r.code === 0) return r.stdout;
  }
  return "";
}

/** Run a command feeding `input` to its stdin (e.g. clip/pbcopy). True on exit 0. */
export async function runFeed(cmd: string[], input: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, {
      stdin: Buffer.from(input),
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

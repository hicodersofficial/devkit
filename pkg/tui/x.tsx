#!/usr/bin/env bun
// x - paste anything, get it readable. Decodes JWTs, base64, URL-encoding,
// epoch timestamps, JSON, UUIDs, hashes, hex colors, cron - locally, offline.
//
//   x <value>          decode an argument
//   ... | x            decode piped stdin
//   x                  decode whatever is on the clipboard
//   x --as <type>      force a detector (jwt, json, base64, epoch, ...)
//   x --all            print every candidate reading
//   x -c               also copy the decoded output back to the clipboard
//   x -i               interactive screen (paste, cycle candidate readings)
//
// Nothing ever leaves the machine: no network, no files. (That's the point -
// stop pasting production tokens into jwt.io.)
//
// UI logic only; detection lives in pkg/core/x.ts.

import { useState } from "react";
import { mountScreen } from "./app";
import { useTheme } from "./theme-context";
import { Header, Help, TextPrompt, type Binding } from "./components";
import { useKeyboard } from "@opentui/react";
import { detect, DETECTOR_TYPES, type Detection } from "../core/x";
import { copyText, readText } from "../core/clipboard";

const HELP: Binding[] = [
  { keys: "t / left right", desc: "cycle candidate readings (JWT vs base64 vs ...)" },
  { keys: "c", desc: "copy the decoded output to the clipboard" },
  { keys: "n", desc: "decode a new input" },
  { keys: "h", desc: "show / hide this help" },
  { keys: "q / esc", desc: "quit (esc from input goes back / quits)" },
];

// ---- interactive screen ----

export function XScreen({ onExit, initialInput = "" }: { onExit: () => void; initialInput?: string }) {
  const theme = useTheme();
  const [input, setInput] = useState(initialInput);
  const [results, setResults] = useState<Detection[]>(() => (initialInput ? detect(initialInput) : []));
  const [idx, setIdx] = useState(0);
  const [entering, setEntering] = useState(!initialInput);
  const [showHelp, setShowHelp] = useState(false);
  const [status, setStatus] = useState("");
  const [seq, setSeq] = useState(0);

  const submit = (value: string) => {
    const v = value.trim();
    if (!v) return;
    setInput(v);
    setResults(detect(v));
    setIdx(0);
    setEntering(false);
    setStatus("");
  };

  useKeyboard((key) => {
    if (entering || showHelp) return;
    if (key.name === "q" || key.name === "escape") onExit();
    else if (key.name === "h") setShowHelp(true);
    else if (key.name === "n") {
      setSeq((s) => s + 1);
      setEntering(true);
    } else if (key.name === "t" || key.name === "right") {
      if (results.length) setIdx((i) => (i + 1) % results.length);
    } else if (key.name === "left") {
      if (results.length) setIdx((i) => (i - 1 + results.length) % results.length);
    } else if (key.name === "c") {
      const cur = results[idx];
      if (cur) void copyText(cur.output).then((ok) => setStatus(ok ? "Copied output." : "Copy failed."));
    }
  });

  if (showHelp) {
    return <Help title="x - keys" bindings={HELP} onClose={() => setShowHelp(false)} />;
  }

  if (entering) {
    return (
      <box style={{ padding: 1, flexDirection: "column" }}>
        <Header title="x" subtitle="decode anything" hint="paste or type, enter decode | esc quit" />
        <TextPrompt
          key={seq}
          label="Value to decode (JWT, base64, epoch, JSON, ...)"
          onSubmit={submit}
          onCancel={onExit}
        />
      </box>
    );
  }

  const cur = results[idx];
  const inputPreview = input.length > 60 ? input.slice(0, 57) + "..." : input;
  const lines = cur ? cur.output.split("\n") : [];
  const MAX_LINES = 24;
  const shown = lines.slice(0, MAX_LINES);

  return (
    <box style={{ padding: 1, flexDirection: "column" }}>
      <Header
        title="x"
        subtitle={cur ? `${idx + 1}/${results.length} ${cur.label}` : "no match"}
        hint="t cycle reading | c copy | n new | h help | q quit"
      />
      <box style={{ flexDirection: "column" }}>
        <box>
          <text fg={theme.dim}>{`input: ${inputPreview}`}</text>
        </box>
        {status ? (
          <box>
            <text fg={theme.green}>{status}</text>
          </box>
        ) : null}
        {cur?.note ? (
          <box>
            <text fg={theme.yellow}>{cur.note}</text>
          </box>
        ) : null}
        <box style={{ height: 1 }} />
        {cur ? (
          shown.map((l, i) => (
            <box key={i}>
              <text fg={theme.fg}>{l || " "}</text>
            </box>
          ))
        ) : (
          <box>
            <text fg={theme.dim}>Nothing recognized. n to try another value.</text>
          </box>
        )}
        {lines.length > MAX_LINES ? (
          <box>
            <text fg={theme.dim}>{`... ${lines.length - MAX_LINES} more lines (c copies everything)`}</text>
          </box>
        ) : null}
      </box>
    </box>
  );
}

// Mount the screen and return when it exits (no process.exit) - used by the hub.
export async function runXScreen(initialInput = "") {
  await mountScreen<void>((done) => <XScreen onExit={done} initialInput={initialInput} />);
}

// ---------- CLI entry ----------

function printDetection(d: Detection, opts: { heading: boolean }) {
  if (opts.heading) {
    console.log(`${d.label}`);
    if (d.note) console.log(`  ${d.note}`);
    console.log("");
  }
  console.log(d.output);
}

export async function runX() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(
      [
        "Usage: x [value] [--as <type>] [--all] [-c] [-i]",
        "  x <value>       decode an argument",
        "  ... | x         decode piped stdin",
        "  x               decode the clipboard",
        `  --as <type>     force a reading: ${DETECTOR_TYPES.join(", ")}`,
        "  --all           print every candidate reading",
        "  -c, --copy      copy the decoded output to the clipboard",
        "  -i              interactive screen",
        "",
        "Everything is decoded locally - no network, nothing stored.",
        "",
        "Examples:",
        "  x eyJhbGciOi...          JWT -> header + claims + 'EXPIRED 3h ago'",
        "  x 1700000000             epoch -> local, UTC, '2y ago'",
        "  x '%7B%22a%22%3A1%7D'    URL-encoded -> decoded (params split out)",
        "  x 018f...-7abc-...       UUID v7 -> version + embedded timestamp",
        "  x '0 */6 * * *'          cron -> per-field English",
        "  copy a token, then: x    reads the clipboard when no input is given",
        "  cat resp.json | x        pretty-print (or point at the syntax error)",
        "  x SGVsbG8= --as base64   force a reading when detection is ambiguous",
      ].join("\n"),
    );
    return;
  }

  const asIdx = argv.findIndex((a) => a === "--as");
  const asType = asIdx >= 0 ? (argv[asIdx + 1] ?? "") : null;
  const all = argv.includes("--all");
  const copy = argv.includes("-c") || argv.includes("--copy");
  const interactive = argv.includes("-i");

  // Input precedence: args > piped stdin > clipboard.
  const positional = argv.filter((a, i) => !a.startsWith("-") && i !== asIdx + 1);
  let input = positional.join(" ").trim();
  let source = "argument";
  if (!input && !process.stdin.isTTY) {
    input = (await Bun.stdin.text()).trim();
    source = "stdin";
  }
  if (!input) {
    input = (await readText()).trim();
    source = "clipboard";
  }

  if (interactive) {
    await runXScreen(input);
    process.exit(0);
  }

  if (!input) {
    console.error("Nothing to decode: no argument, no piped input, clipboard is empty. See x --help.");
    process.exit(1);
  }

  let results = detect(input);
  if (asType) {
    results = results.filter((r) => r.type === asType);
    if (!results.length) {
      console.error(`Input doesn't read as "${asType}". Types: ${DETECTOR_TYPES.join(", ")}`);
      process.exit(1);
    }
  }
  if (!results.length) {
    console.error(`Nothing recognized (from ${source}). Try --as <type> to force a reading.`);
    process.exit(1);
  }

  const tty = process.stdout.isTTY === true;
  if (all) {
    results.forEach((d, i) => {
      if (i > 0) console.log("\n" + "-".repeat(40) + "\n");
      printDetection(d, { heading: true });
    });
  } else {
    const best = results[0]!;
    printDetection(best, { heading: tty });
    const others = results.slice(1).map((r) => r.type);
    if (tty && others.length) {
      console.log(`\nalso matched: ${others.join(", ")}  (x --as <type>)`);
    }
  }

  if (copy) {
    const ok = await copyText(results[0]!.output);
    if (tty) console.log(ok ? "\nCopied output to clipboard." : "\n(copy failed - no clipboard tool)");
  }
}

if (import.meta.main) {
  await runX();
}

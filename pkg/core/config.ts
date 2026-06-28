// config — tiny persisted settings for devkit, shared across all tools.
//
// Pure logic (no UI): reads/writes a single JSON file in the user's home dir, so
// a preference chosen in one tool (e.g. the theme) sticks and applies to every
// tool, including across the hub spawning each tool as its own process.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaunchConfig } from "./launch";

const CONFIG_PATH = join(homedir(), ".devkit.json");

export interface DevkitConfig {
  theme?: string;
  /** The `launch` tool's project registry + scan roots. */
  launch?: LaunchConfig;
}

export function loadConfig(): DevkitConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as DevkitConfig;
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<DevkitConfig>): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...patch }, null, 2));
  } catch {
    /* best-effort — a missing setting just falls back to defaults */
  }
}

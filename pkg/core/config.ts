// config — tiny persisted settings for devkit, shared across all tools.
//
// Pure logic (no UI): reads/writes a single JSON file in the user's home dir, so
// a preference chosen in one tool (e.g. the theme) sticks and applies to every
// tool, including across the hub spawning each tool as its own process.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaunchConfig, ScanRoot } from "./launch";

const CONFIG_PATH = join(homedir(), ".devkit.json");

export interface DevkitConfig {
  theme?: string;
  /**
   * Folders that hold the user's projects, shared by every tool that works
   * across them (launch discovers runnable projects here; clean reclaims their
   * build artifacts). Written by launch's scan-folder UI. Older configs stored
   * this under `launch.scanRoots` — loaders fall back to that, and the next
   * save migrates it here.
   */
  scanRoots?: ScanRoot[];
  /** The `launch` tool's project registry (scan roots live top-level now). */
  launch?: Partial<LaunchConfig>;
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

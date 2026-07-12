// Registry of tools shown in the `devkit` hub. Each entry carries a `run`
// function that mounts the tool's screen in-process (the hub runs tools in the
// same process, in a loop, rather than spawning a child).
//
// Adding a tool: build pkg/core/<tool>.ts + pkg/tui/<tool>.tsx (exporting a
// hub-friendly run<Tool>Screen), then add a row here and a bin/<tool>.bat shim.

import { runKillportScreen } from "./killport";
import { runLaunchScreen } from "./launch";

export interface ToolDef {
  id: string;
  label: string;
  description: string;
  run: () => Promise<void>; // mounts the tool's screen in-process
}

export const TOOLS: ToolDef[] = [
  {
    id: "killport",
    label: "killport",
    description: "Find and kill processes by port",
    run: () => runKillportScreen(),
  },
  {
    id: "launch",
    label: "launch",
    description: "Start your dev projects",
    run: () => runLaunchScreen(),
  },
];

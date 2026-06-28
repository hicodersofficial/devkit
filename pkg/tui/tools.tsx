// Registry of tools shown in the `devkit` hub. Each entry points at a screen
// file in this folder that the hub spawns as a child process.
//
// Adding a tool: build pkg/core/<tool>.ts + pkg/tui/<tool>.tsx, then add a row
// here and a bin/<tool>.bat shim.

export interface ToolDef {
  id: string;
  label: string;
  description: string;
  file: string; // filename within pkg/tui (spawned via `bun`)
}

export const TOOLS: ToolDef[] = [
  {
    id: "killport",
    label: "killport",
    description: "Find and kill processes by port",
    file: "killport.tsx",
  },
  {
    id: "launch",
    label: "launch",
    description: "Start your dev projects",
    file: "launch.tsx",
  },
];

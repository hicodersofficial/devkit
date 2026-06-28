// preinstall guard: devkit is Bun-only.
//
// Bun does not run a dependency's lifecycle scripts by default, so this never
// runs (and never blocks) a `bun add` / `bun install`. npm / yarn / pnpm DO run
// preinstall, so they hit this check and abort with instructions to use Bun.
// (If a package manager reports itself as Bun via the user-agent, allow it.)

const ua = process.env.npm_config_user_agent || "";
if (ua.startsWith("bun")) process.exit(0);

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

console.error(
  [
    "",
    red(bold("  @hicoders/devkit must be installed with Bun.")),
    "",
    "  devkit runs on Bun and relies on it to install the right native UI",
    "  binary for your platform. npm / yarn / pnpm are not supported.",
    "",
    "  Install it with:",
    cyan("      bun add -g @hicoders/devkit"),
    "",
    "  Don't have Bun? Get it at https://bun.com",
    "",
  ].join("\n"),
);
process.exit(1);

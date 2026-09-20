# AIRO for VS Code

AIRO brings the AIRO CLI into a stateful chat in the VS Code secondary sidebar.
It can continue the active repository session, stream progress, attach local files,
and expose AIRO's routing, diagnostics, usage, logs, and feedback commands.

## Requirements

- VS Code 1.106 or newer
- Node.js 22 or newer
- The `airo` CLI installed and available on `PATH`, or an absolute path configured
  in **AIRO: Command**
- At least one signed-in provider CLI (Claude Code or Codex CLI)

Open the AIRO view from the secondary sidebar. Use the extension settings to
choose routing mode, provider, tier, output detail, and the CLI executable.

The extension runs the CLI in the currently opened workspace; it does not upload
attached files or store provider credentials.

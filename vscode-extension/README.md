# AIRO for VS Code

AIRO brings the AIRO CLI into a stateful chat in the VS Code secondary sidebar.
It can continue the active repository chat, stream progress, attach local files,
and expose AIRO's routing, diagnostics, usage, logs, and feedback commands.

## Requirements

- VS Code 1.106 or newer
- Node.js 22 or newer
- The `airo` CLI installed and available on `PATH`, or an absolute path configured
  in **AIRO: Command**
- At least one signed-in provider CLI (Claude Code or Codex CLI)

Open the AIRO view from the secondary sidebar. Use the extension settings to
choose routing mode, provider, tier, output detail, and the CLI executable.

Use the `+` tab in the sidebar to keep multiple AIRO chats open. Each tab keeps
its own rendered conversation, draft, attachments, and AIRO chat context.
Stop an active run before switching tabs so progress and permission requests
remain attached to the chat that started them.

The extension runs the CLI in the currently opened workspace; it does not upload
attached files or store provider credentials.

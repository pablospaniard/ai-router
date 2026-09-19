# AIRO v0.7.0

**Adaptive Intelligence Routing & Orchestration** for Claude Code and Codex CLI.

AIRO accepts a task, chooses the right provider and model tier, and can coordinate a multi-phase workflow across agents. It runs locally with your existing CLI logins—no separate model API keys or proxy service required.

```text
request → route → analyze → implement → test → review
                    Claude     Codex      Codex   Claude
```

## Why AIRO

- Routes each request independently using task signals, custom rules, and prior feedback.
- Maps work onto configurable `fast`, `balanced`, and `deep` model tiers.
- Hands complex tasks between Claude Code and Codex through a shared working tree.
- Preserves logical session context even when the provider changes between turns.
- Streams structured progress while keeping hidden reasoning private.
- Separates live progress from the provider's final result.
- Persists phase logs, final output, routing history, and user feedback locally.
- Inserts a recovery phase when a workflow fails or reports an unresolved problem.

## Requirements

- Node.js 20 or newer.
- Claude Code and/or Codex CLI installed and authenticated.
- An active subscription or login supported by the corresponding CLI.

AIRO can fall back to the available provider during adaptive runs when one CLI is missing.

## Install

```bash
npm install --global airo-cli
airo doctor
```

To develop AIRO locally instead, clone the repository, run `npm install`, and use
`npm link` to expose the `airo` command.

The first interactive run launches model setup automatically. Run `airo setup` at any time to revisit it.

## Quick start

Open the interactive workspace:

```bash
airo
```

The workspace shows the active session, provider availability, routing preferences, and output mode. Type a task directly or use `/help` to discover commands. Tab completion is available for slash commands.

Start a session:

```bash
airo "review this PR for regressions"
```

Continue it with a newly routed follow-up:

```bash
airo --continue "fix the critical issue you found"
```

Force one agent or an adaptive workflow:

```bash
airo --single "rename this interface"
airo --adaptive "investigate and fix this intermittent failure"
```

Preview the decision without running an agent:

```bash
airo --dry-run --explain "migrate this legacy module"
```

## How routing works

AIRO scores the request for provider and complexity signals, applies matching configuration rules, and incorporates feedback from similar prior work. Complexity maps to a model tier rather than a hard-coded model ID.

The default Codex mapping is:

| Tier | Model | Effort |
| --- | --- | --- |
| `fast` | `gpt-5.6-luna` | `low` |
| `balanced` | `gpt-5.6-terra` | `medium` |
| `deep` | `gpt-5.6-sol` | `xhigh` |

Use `airo models` to inspect the active Claude and Codex mappings. These three tiers per provider are automatic routing defaults, not an allowlist: every model exposed by the installed provider CLI remains available. Override a default with `--model`, optionally with `--agent`, or ask for a recognizable model ID directly in the task (for example, `airo "use gpt-6-astra to review this"`).

Inspect the subscription/login context and the locally configured provider defaults:

```bash
airo account
```

Some provider CLIs report the authentication method but deliberately omit the account email. AIRO displays that limitation instead of reading or decoding stored credentials. If a default model cannot be detected from provider settings, run `airo setup` to provide the comparison model or set `defaultModel` inside that provider's AIRO configuration.

## Sessions and chat

```bash
airo
airo chat
airo session
airo sessions
airo session new "new task"
airo session clear
airo --session <session-id> "add tests for that fix"
```

Inside the interactive workspace, preferences persist for the current process:

```text
/mode auto|adaptive|single
/agent auto|claude|codex
/tier auto|fast|balanced|deep
/log compact|live|verbose
/status
/new [title]
/models
/sessions
/clear
/exit
```

Follow-ups preserve a compact summary of recent outcomes and are routed independently. AIRO does not imply that Claude and Codex share hidden conversation state.

If an agent needs a blocking decision, it can emit `AIROUTE_QUESTION:`. AIRO asks for input and resumes the same phase, with up to four clarification rounds per phase.

For Claude runs, answering exactly `approve` or `approved` resumes the same model and phase with `bypassPermissions` for that continuation attempt. Other answers preserve the configured permission mode.

The test suite enforces at least 95% line and function coverage. Run it with `npm test` or `npm run test:coverage`.

## Logs and feedback

Choose how much progress appears in the terminal:

```bash
airo --log compact "task"
airo --log live "task"
airo --log verbose "task"
```

- `compact` shows router and phase status.
- `live` adds streamed agent output and is the default.
- `verbose` also shows stderr and command metadata.

Inspect persisted runs:

```bash
airo logs
airo logs <run-id>
airo logs --follow <run-id>
airo history 20
airo usage 20
```

Teach the router from a completed run:

```bash
airo feedback good <run-id>
airo feedback bad <run-id> "used more reasoning than necessary"
```

In an interactive terminal, AIRO also asks a short question after every completed run:

```text
? Was this result helpful? [y/n, Enter to skip]
```

`yes` records positive feedback, `no` records negative feedback, and Enter skips the rating. Disable `history.learningEnabled` to turn off the prompt and feedback-based routing adjustments.

Each persisted run stores its combined log, individual phase logs, structured event streams, and a clean `final-output.txt` containing only the provider's terminal response. Set `logging.persist` to `false` to keep the terminal stream without writing run files.

`airo usage` reports provider-supplied token telemetry. Its savings percentage compares non-cached tokens against observed, comparable successful AIRO runs that used the locally configured default model for that provider. The command labels the result as a historical estimate and withholds it until enough baseline data exists; it does not infer token savings from model names.

## Configuration

The setup wizard writes global configuration to:

```text
~/.config/airo/config.json
```

Create a project-specific configuration with:

```bash
airo config init
```

This creates `.airo.json` in the current directory. Project configuration takes precedence over global configuration. See [`airo.config.example.json`](airo.config.example.json) for all available settings.

On the first command after upgrading, AIRO copies legacy global configuration and data into `~/.config/airo/` and `~/.local/share/airo/`. The old files remain untouched as a rollback path. Project-level `.ai-router.json` files continue to be discovered.

Claude runs use `permissionMode: "acceptEdits"` by default so headless implementation tasks can edit the working tree. Change it to `auto`, `manual`, `dontAsk`, or `plan` in configuration when a more restrictive mode is appropriate. The legacy `allowedModels` setting is accepted for configuration compatibility but no longer restricts model access.

## Command reference

| Command | Purpose |
| --- | --- |
| `airo` | Open the interactive workspace |
| `airo "task"` | Start a new logical session |
| `airo --continue "task"` | Continue the active repository session |
| `airo chat` | Start interactive mode |
| `airo --single "task"` | Force a single-agent run |
| `airo --adaptive "task"` | Force multi-phase orchestration |
| `airo setup` | Configure the three automatic model tiers |
| `airo models` | Show the active model mapping |
| `airo account` | Show provider login status and detected default models |
| `airo doctor` | Check provider commands and storage paths |
| `airo logs [run-id]` | List or print persisted logs |
| `airo history [limit]` | Show routing history |
| `airo usage [limit]` | Show measured token usage and default-model comparison |
| `airo feedback good\|bad ...` | Rate a completed run |
| `airo --version` | Print the installed version |

Set `NO_COLOR=1` to disable ANSI colors.

## Development

```bash
npm install
npm test
```

`npm test` compiles the TypeScript sources and runs the Node.js test suite. Generated files under `dist/` are intentionally ignored.

## Compatibility aliases

`ai-router`, `airoute`, and `ai-route` remain available as command aliases for existing users. New documentation and integrations should use `airo`.

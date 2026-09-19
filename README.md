# subscription-ai-router v0.7.0

Local adaptive router/orchestrator for Claude Code and Codex CLI using existing subscription-backed logins.

## Session-aware follow-ups

A follow-up keeps the logical session context but is **re-routed independently**. That means the provider/model can change every turn.

```text
review this PR
→ Claude / balanced

--continue "fix the critical issue you found"
→ Claude deep analysis → Codex implementation → Codex tests → Claude review

--continue "now fix only lint warnings"
→ Codex / fast
```

The router bridges vendors with the shared working tree plus compact summaries of recent turns. It does not pretend Claude and Codex share hidden internal conversation state.


## Live execution logs

Every run now streams progress and persists it under:

```text
~/.local/share/ai-router/logs/
  session-<session-id>/
    run-<run-id>/
      01-analyze-claude.log
      02-implement-codex.log
      03-test-codex.log
      04-review-claude.log
      combined.log
```

Logging levels:

```bash
airoute --log compact "task"
airoute --log live "task"
airoute --log verbose "task"
```

- `compact`: router/phase status only
- `live`: status + streamed AI CLI output (default)
- `verbose`: live output plus stderr markers and command metadata

List recent log runs:

```bash
airoute logs
```

Print a run:

```bash
airoute logs <run-id>
```

Follow a currently running or growing combined log:

```bash
airoute logs --follow <run-id>
```

The logger shows only output actually emitted by Claude Code/Codex and tool activity. It does not expose hidden chain-of-thought.

## Install

```bash
npm install
npm run build
npm link
airoute doctor
```

## Development

```bash
npm test
```

The test command compiles the TypeScript sources and runs the built-in Node.js test suite.

## Start a session

```bash
airoute "review this PR for regressions"
```

## Follow up

```bash
airoute --continue "fix the critical issue you found"
```

Or continue an explicit session:

```bash
airoute --session <session-id> "add tests for that fix"
```

## Interactive mode

```bash
airoute chat
```

Then type follow-ups naturally. Each turn can use a different provider/model.

## Session management

```bash
airoute session
airoute sessions
airoute session new "new task"
airoute session clear
```

Sessions are stored in `~/.local/share/ai-router/sessions/`. History remains in the existing history store.

## Feedback

```bash
airoute feedback good <runId>
airoute feedback bad <runId> "too much reasoning"
```


## Default Codex model mapping

- fast → `gpt-5.6-luna` / low
- balanced → `gpt-5.6-terra` / medium
- deep → `gpt-5.6-sol` / xhigh

## Clean final output

After the live progress stream, every completed run now prints a clean final response block:

```text
──────────────── Final answer ────────────────
<provider final response>
──────────────────────────────────────────────
```

The same response is saved at `final-output.txt` inside the run log directory. For adaptive runs, the orchestrator uses the last non-empty phase response (normally the final review/result phase).


## Terminal UX and interactive clarification

Agents can pause the workflow for a blocking decision by emitting `AIROUTE_QUESTION:`. The router shows a highlighted question, waits for your answer, and resumes the same phase with the answer and prior task context. Up to four clarification rounds are allowed per phase.

The CLI now uses ANSI colors when attached to a TTY, Unicode progress symbols (`→`, `✓`, `✗`, `…`, `◆`) and cleaner section dividers. Set `NO_COLOR=1` to disable colors. Font ligatures themselves are controlled by your terminal font/settings.

## v0.7.0 — full-color CLI and first-run model setup

On the first interactive run, AI Router launches a setup wizard automatically. You can also run it anytime with:

```bash
airoute setup
```

The wizard lets you select the Claude and Codex models the router is allowed to use, then map them to the `fast`, `balanced`, and `deep` tiers with per-tier effort levels.

Inspect the active mapping with:

```bash
airoute models
```

The global configuration is stored at:

```text
~/.config/ai-router/config.json
```

The generated JSON includes a `_comment` reminding users to review or change the model list with `airoute setup` or by editing the config directly.

The entire CLI now uses a consistent ANSI color theme for providers, tiers, commands, status icons, sessions, logs, prompts, errors, and final answers. Set `NO_COLOR=1` to disable colors.

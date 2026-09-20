import { compactSessionContext } from "./session.js";
import type { SessionState } from "./types.js";

export const LONG_RUNNING_PROCESS_PROTOCOL =
  "Long-running processes: If the user asks you to leave a server or other process running after this turn, do not rely on a foreground command, a tool-managed command session, or a plain background command such as `command &`; those processes may be terminated when the provider exits. For the durable launch, start it detached in the background using a durable detachment mechanism available on the host, with stdin disconnected and output redirected. Verify it in a separate tool call only after the launching shell has exited. A tool session ID is not evidence that the process will survive this turn. If durable detachment is unavailable or a post-detachment check fails, report that clearly instead of claiming the process is running.";

export function singleRunPrompt(task: string, session?: SessionState): string {
  const context = session?.turns.length
    ? `${compactSessionContext(session)}\n\nCurrent follow-up request: `
    : "";
  return `${context}${task}\n\nRespect the user's intent: requests to explain, inspect, review, or confirm are read-only unless they explicitly ask for changes.\n\nExecution contract: Complete the task in the current working tree and verify important results before claiming success. Only share URLs that you actually verified; clearly label localhost URLs as local-only. If you create or generate a user-visible file, persist it in the project (unless the user chose another location), verify that it exists, and link its absolute path. Render generated images with Markdown image syntax so compatible clients can preview them.\n\n${LONG_RUNNING_PROCESS_PROTOCOL}\n\nClarification protocol: If a required command is blocked by the sandbox or permissions, output exactly AIROUTE_QUESTION: Permission required to <describe the blocked action>. Approve? and stop; do not claim the task is complete. If you cannot safely continue without any other user decision, do not guess. Output exactly AIROUTE_QUESTION: <your concise question> and stop.`;
}

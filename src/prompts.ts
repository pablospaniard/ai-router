import { compactSessionContext } from "./session.js";
import type { SessionState } from "./types.js";

export function singleRunPrompt(task: string, session?: SessionState): string {
  const context = session?.turns.length
    ? `${compactSessionContext(session)}\n\nCurrent follow-up request: `
    : "";
  return `${context}${task}\n\nRespect the user's intent: requests to explain, inspect, review, or confirm are read-only unless they explicitly ask for changes.\n\nExecution contract: Complete the task in the current working tree and verify important results before claiming success. For a long-running development server, start it detached in the background, verify it responds, and report the exact local URL and process details. Only share URLs that you actually verified; clearly label localhost URLs as local-only. If you create or generate a user-visible file, persist it in the project (unless the user chose another location), verify that it exists, and link its absolute path. Render generated images with Markdown image syntax so compatible clients can preview them.\n\nClarification protocol: If a required command is blocked by the sandbox or permissions, output exactly AIROUTE_QUESTION: Permission required to <describe the blocked action>. Approve? and stop; do not claim the task is complete. If you cannot safely continue without any other user decision, do not guess. Output exactly AIROUTE_QUESTION: <your concise question> and stop.`;
}

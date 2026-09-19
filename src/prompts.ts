import { compactSessionContext } from "./session.js";
import type { SessionState } from "./types.js";

export function singleRunPrompt(task: string, session?: SessionState): string {
  const context = session?.turns.length
    ? `${compactSessionContext(session)}\n\nCurrent follow-up request: `
    : "";
  return `${context}${task}\n\nRespect the user's intent: requests to explain, inspect, review, or confirm are read-only unless they explicitly ask for changes.\n\nClarification protocol: If you cannot safely continue without a user decision, do not guess. Output exactly AIROUTE_QUESTION: <your concise question> and stop.`;
}

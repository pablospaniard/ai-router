import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendTurn, clearActiveSession, compactSessionContext, createSession, getActiveSession, listSessions, loadSession, saveSession, setActiveSession } from "../session.js";

test("manages the complete session lifecycle", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "airo-session-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const cwd = path.join(home, "repo");
  fs.mkdirSync(cwd);
  try {
    const session = createSession("original task", cwd);
    assert.equal(getActiveSession(cwd)?.sessionId, session.sessionId);
    assert.equal(loadSession(session.sessionId).originalTask, "original task");

    appendTurn(session, {
      turnId: "turn-1", runId: "run-1", timestamp: "2026-01-01T00:00:00.000Z",
      userPrompt: "follow up", routeSummary: "single:codex/model", phaseSummaries: ["first", "second"],
    });
    assert.match(compactSessionContext(session), /User follow-up: follow up/);
    saveSession(session);
    assert.equal(listSessions(cwd).length, 1);
    assert.equal(listSessions(path.join(home, "other")).length, 0);

    clearActiveSession(cwd);
    assert.equal(getActiveSession(cwd), undefined);
    setActiveSession(cwd, "missing");
    assert.equal(getActiveSession(cwd), undefined);
    assert.throws(() => loadSession("missing"), /Session not found/);

    const sessionsDir = path.join(home, ".local", "share", "airo", "sessions");
    fs.writeFileSync(path.join(sessionsDir, "bad.json"), "bad json");
    assert.equal(listSessions(cwd).length, 1);
    fs.writeFileSync(path.join(home, ".local", "share", "airo", "active-sessions.json"), "bad json");
    assert.equal(getActiveSession(cwd), undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

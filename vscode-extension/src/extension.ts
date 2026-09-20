import * as vscode from "vscode";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { renderHistoryWebview, renderWebview } from "./webview";

type Message = { type: string; text?: string; action?: string; sessionId?: string };
type RouteStatus = { provider: string; model: string; tier: string };
type SessionSummary = {
  sessionId: string;
  description: string;
  updatedAt: string;
  turnCount: number;
};
type ProtocolEvent = {
  type: string;
  provider?: string;
  model?: string;
  tier?: string;
  question?: string;
  text?: string;
  requiresApproval?: boolean;
  state?: "started" | "completed" | "failed";
  kind?: string;
  title?: string;
  phaseIndex?: number;
  phaseTotal?: number;
  exitCode?: number;
};

const extensions = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "pdf",
  "md",
  "markdown",
  "json",
];

export function activate(context: vscode.ExtensionContext): void {
  const chats = new Map<string, ChatPanel>();
  const openHistory = () => void HistoryPanel.open(openSession, chats);
  const openSession = (session: SessionSummary) => {
    const existing = chats.get(session.sessionId);
    if (existing) return existing.focus();
    ChatPanel.open(session, openHistory, chats);
  };
  const createChat = async () => {
    const result = await runCommand(["session", "new"]);
    if (result.code !== 0) {
      void vscode.window.showErrorMessage("AIRO could not create a new chat.");
      return;
    }
    const sessions = await listSessionSummaries();
    if (sessions[0]) openSession(sessions[0]);
  };
  const provider = new SidebarProvider(openHistory, undefined, createChat);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider("airo.sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("airo.runTask", () => provider.focus()),
    vscode.commands.registerCommand("airo.openHistory", openHistory),
    vscode.commands.registerCommand("airo.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:pablospaniard.airo-vscode",
      ),
    ),
    vscode.commands.registerCommand("airo.openTerminal", () => {
      const terminal = vscode.window.createTerminal("AIRO");
      terminal.show();
      terminal.sendText(vscode.workspace.getConfiguration("airo").get<string>("command", "airo"));
    }),
  );
}

class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  protected view?: vscode.WebviewView;
  protected panel?: vscode.WebviewPanel;
  private child?: ChildProcessWithoutNullStreams;
  private running = false;
  private stopping = false;
  private awaitingInput = false;
  protected activeSession = false;
  private attachments: string[] = [];

  constructor(
    private readonly onOpenHistory: () => void,
    protected session?: SessionSummary,
    private readonly onNewChat?: () => Promise<void>,
  ) {
    this.activeSession = Boolean(session);
  }

  dispose(): void {
    this.child?.kill();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.initializeWebview(view.webview);
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  protected initializeWebview(webview: vscode.Webview): void {
    webview.options = { enableScripts: true };
    webview.html = renderWebview([...Array(24)].map(() => Math.random().toString(36)[2]).join(""));
    webview.onDidReceiveMessage((message: Message) => void this.receive(message));
  }

  focus(): void {
    this.view?.show?.(true);
    this.panel?.reveal(undefined, true);
    this.post({ type: "focus" });
  }

  isRunning(): boolean {
    return this.running;
  }

  private async receive(message: Message): Promise<void> {
    if (message.type === "ready") {
      this.post({ type: "route", ...this.configuredRoute() });
      this.postState();
      if (!this.session) {
        const result = await this.run(["session", "--json"], false);
        try {
          const session = JSON.parse(result.output) as SessionSummary | null;
          if (session?.sessionId) this.session = session;
        } catch {
          // The regular session status below remains available for older AIRO installations.
        }
        this.activeSession = Boolean(this.session);
      }
      this.post({
        type: "session",
        value: this.session
          ? `Session — ${this.session.description}`
          : this.activeSession
            ? "Connected to the active AIRO session"
            : "New chat — send a task to begin",
      });
    } else if (message.type === "attach") await this.pickAttachments();
    else if (message.type === "action") await this.action(message.action ?? "", message.text);
    else if (message.type === "prompt" && message.text?.trim())
      await this.prompt(message.text.trim());
  }

  private async prompt(text: string): Promise<void> {
    if (this.running) {
      if (this.awaitingInput && this.child?.stdin.writable) {
        this.awaitingInput = false;
        this.postState();
        this.child.stdin.write(`${text}\n`);
      } else {
        this.notice("AIRO is already working on a request.");
      }
      return;
    }
    if (text.startsWith("/")) return this.slash(text);
    const attached = this.attachments.length
      ? "\n\nAttached local file(s) for inspection:\n" +
        this.attachments.map((file) => `- ${file}`).join("\n") +
        "\nUse the provider's local file inspection capability if available."
      : "";
    this.attachments = [];
    this.post({ type: "attachments", files: [] });
    const result = await this.run(this.taskArgs(text + attached), true, text);
    if (result.started) this.activeSession = true;
  }

  private async slash(input: string): Promise<void> {
    const [command, ...parts] = input.split(/\s+/);
    const argument = parts.join(" ");
    const commands: Record<string, string[]> = {
      "/status": ["session"],
      "/sessions": ["sessions"],
      "/models": ["models"],
      "/account": ["account"],
      "/usage": ["usage", ...(argument ? [argument] : [])],
      "/logs": ["logs"],
      "/doctor": ["doctor"],
    };
    if (command === "/help") return this.post({ type: "help" });
    if (command === "/clear") return this.post({ type: "clear" });
    if (command === "/attach") return this.pickAttachments();
    if (command === "/new") return this.onNewChat?.();
    if (command === "/exit" || command === "/quit")
      return this.notice("The sidebar stays available. Start a new chat whenever you like.");
    if (["/mode", "/agent", "/tier", "/log"].includes(command))
      return this.notice("Routing preferences are managed in VS Code Settings.");
    if (command === "/feedback") {
      if (!/^(good|bad)(\s|$)/.test(argument))
        return this.notice("Usage: /feedback good|bad [note]");
      await this.run(["feedback", ...parts], true, "Feedback");
      return;
    }
    if (commands[command]) {
      await this.run(
        command === "/sessions" ? ["sessions", "--limit", "5"] : commands[command],
        true,
        command.slice(1),
      );
      return;
    }
    this.notice(`Unknown command: ${command}. Type /help for available commands.`);
  }

  private async action(action: string, text?: string): Promise<void> {
    if (action === "settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:pablospaniard.airo-vscode",
      );
      return;
    }
    if (action === "new") return this.onNewChat?.();
    if (action === "history") return this.onOpenHistory();
    if (action === "stop") return this.stop();
    if (action === "feedback") {
      await this.run(["feedback", text === "bad" ? "bad" : "good"], true, "Feedback");
      return;
    }
    const commands: Record<string, string[]> = {
      models: ["models"],
      account: ["account"],
      usage: ["usage"],
      logs: ["logs"],
      doctor: ["doctor"],
    };
    if (commands[action]) await this.run(commands[action], true, action);
  }

  private stop(): void {
    if (!this.running || !this.child || this.stopping) return;
    this.stopping = this.child.kill();
    this.postState();
    if (!this.stopping) this.notice("AIRO could not stop the current run.");
  }

  private async pickAttachments(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      filters: { "AIRO attachments": extensions },
    });
    if (!files?.length) return;
    this.attachments.push(...files.map((file: vscode.Uri) => file.fsPath));
    this.post({ type: "attachments", files: this.attachments.map((file) => path.basename(file)) });
  }

  private taskArgs(task: string): string[] {
    const config = vscode.workspace.getConfiguration("airo");
    const mode = config.get<string>("mode", "auto");
    const agent = config.get<string>("agent", "auto");
    const tier = config.get<string>("tier", "auto");
    const log = config.get<string>("logLevel", "live");
    const args = this.session
      ? ["--session", this.session.sessionId]
      : this.activeSession
        ? ["--continue"]
        : [];
    if (mode === "adaptive") args.push("--adaptive");
    else if (mode === "single") args.push("--single");
    if (agent !== "auto") args.push("--agent", agent);
    if (tier !== "auto") args.push("--tier", tier);
    return [...args, "--log", log, task];
  }

  protected run(
    args: string[],
    showOutput: boolean,
    label = args.join(" "),
  ): Promise<{ code: number | null; output: string; started: boolean }> {
    if (this.running) {
      this.notice("AIRO is already working on a request.");
      return Promise.resolve({ code: null, output: "", started: false });
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.notice("Open a workspace folder before starting AIRO.");
      return Promise.resolve({ code: null, output: "", started: false });
    }
    if (showOutput) this.post({ type: "start", label });
    this.running = true;
    this.stopping = false;
    this.awaitingInput = false;
    this.postState();
    return new Promise((resolve) => {
      let output = "";
      let humanOutput = "";
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let hasFinal = false;
      let started = false;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(
          vscode.workspace.getConfiguration("airo").get<string>("command", "airo"),
          args,
          {
            cwd: folder.uri.fsPath,
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, NO_COLOR: "1", AIRO_STREAM_PROTOCOL: "1" },
          },
        );
        this.child = child;
        started = true;
      } catch (error) {
        this.running = false;
        this.postState();
        this.notice(`Could not start AIRO: ${String(error)}`);
        return resolve({ code: null, output, started });
      }

      const handleProtocol = (event: ProtocolEvent): void => {
        if (event.type === "route" && event.provider && event.model && event.tier) {
          this.post({
            type: "route",
            provider: event.provider,
            model: event.model,
            tier: event.tier,
          });
        } else if ((event.type === "input" || event.type === "permission") && event.question) {
          this.awaitingInput = true;
          this.post({
            type: event.type === "permission" ? "permission" : "interaction",
            text: event.question,
          });
          this.postState();
        } else if (event.type === "phase" && event.kind && event.state) {
          this.post({
            type: "phase",
            state: event.state,
            kind: event.kind,
            title: event.title,
            provider: event.provider,
            model: event.model,
            tier: event.tier,
            phaseIndex: event.phaseIndex,
            phaseTotal: event.phaseTotal,
          });
        } else if (event.type === "final" && event.text) {
          hasFinal = true;
          this.post({ type: "final", text: event.text });
        }
      };
      const handleLine = (line: string, newline: boolean): void => {
        if (line.startsWith("AIRO_EVENT ")) {
          try {
            handleProtocol(JSON.parse(line.slice("AIRO_EVENT ".length)) as ProtocolEvent);
            return;
          } catch {
            // Treat a malformed protocol line as ordinary diagnostic output.
          }
        }
        const text = line + (newline ? "\n" : "");
        humanOutput += text;
        if (showOutput) this.post({ type: "activity", text });
      };
      const write = (data: Buffer, stream: "stdout" | "stderr"): void => {
        const text = data.toString();
        output += text;
        const buffered = (stream === "stdout" ? stdoutBuffer : stderrBuffer) + text;
        const lines = buffered.split("\n");
        if (stream === "stdout") stdoutBuffer = lines.pop() ?? "";
        else stderrBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line, true);
      };
      child.stdout.on("data", (data: Buffer) => write(data, "stdout"));
      child.stderr.on("data", (data: Buffer) => write(data, "stderr"));
      child.on("error", (error) => this.notice(`Could not start AIRO: ${error.message}`));
      child.on("close", (code) => {
        const stopped = this.stopping;
        if (stdoutBuffer) handleLine(stdoutBuffer, false);
        if (stderrBuffer) handleLine(stderrBuffer, false);
        this.child = undefined;
        this.running = false;
        this.stopping = false;
        this.awaitingInput = false;
        this.postState();
        if (!stopped && showOutput && !hasFinal && humanOutput.trim()) {
          this.post({
            type: code === 0 ? "final" : "failure",
            text: this.plainText(humanOutput).trim(),
          });
        }
        if (showOutput) this.post({ type: "end", code, stopped });
        resolve({ code, output, started });
      });
    });
  }

  private configuredRoute(): RouteStatus {
    const config = vscode.workspace.getConfiguration("airo");
    const provider = config.get<string>("agent", "auto");
    return {
      provider: provider === "auto" ? "Auto" : provider,
      model: "Routing",
      tier: config.get<string>("tier", "auto"),
    };
  }

  private plainText(value: string): string {
    return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  }

  private postState(): void {
    this.post({
      type: "state",
      running: this.running,
      stopping: this.stopping,
      awaitingInput: this.awaitingInput,
    });
  }

  private notice(value: string): void {
    this.post({ type: "notice", value });
  }

  protected post(message: Record<string, unknown>): void {
    const webview = this.view?.webview ?? this.panel?.webview;
    if (webview) void webview.postMessage(message);
  }
}

class ChatPanel extends SidebarProvider {
  private constructor(
    session: SessionSummary,
    onOpenHistory: () => void,
    onNewChat: () => Promise<void>,
  ) {
    super(onOpenHistory, session, onNewChat);
  }

  static open(
    session: SessionSummary,
    onOpenHistory: () => void,
    chats: Map<string, ChatPanel>,
  ): void {
    const provider = new ChatPanel(session, onOpenHistory, async () => {
      const result = await runCommand(["session", "new"]);
      if (result.code !== 0)
        return void vscode.window.showErrorMessage("AIRO could not create a new chat.");
      const sessions = await listSessionSummaries();
      if (sessions[0]) {
        const existing = chats.get(sessions[0].sessionId);
        if (existing) existing.focus();
        else ChatPanel.open(sessions[0], onOpenHistory, chats);
      }
    });
    const panel = vscode.window.createWebviewPanel(
      "airo.chat",
      `AIRO: ${shortDescription(session.description)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    provider.panel = panel;
    chats.set(session.sessionId, provider);
    provider.initializeWebview(panel.webview);
    panel.onDidDispose(() => {
      chats.delete(session.sessionId);
      provider.dispose();
    });
  }
}

class HistoryPanel {
  static async open(
    onSelect: (session: SessionSummary) => void,
    chats: Map<string, ChatPanel>,
  ): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      "airo.history",
      "AIRO: Previous chats",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = renderHistoryWebview(
      [...Array(24)].map(() => Math.random().toString(36)[2]).join(""),
    );
    panel.webview.onDidReceiveMessage((message: Message) => {
      if (message.type === "restore" && message.sessionId) {
        const session = sessions.find((item) => item.sessionId === message.sessionId);
        if (session) onSelect(session);
      }
    });
    let sessions: SessionSummary[] = [];
    const result = await runCommand(["sessions", "--json"]);
    try {
      sessions = JSON.parse(result.output) as SessionSummary[];
      if (!Array.isArray(sessions)) throw new Error("Invalid session list");
      void panel.webview.postMessage({
        type: "sessions",
        sessions: sessions.map((session) => ({
          ...session,
          running: chats.get(session.sessionId)?.isRunning() ?? false,
          open: chats.has(session.sessionId),
        })),
      });
    } catch {
      void panel.webview.postMessage({
        type: "error",
        value: "Could not load previous AIRO sessions.",
      });
    }
  }
}

function shortDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 64) || "Untitled chat";
}

function listSessionSummaries(): Promise<SessionSummary[]> {
  return runCommand(["sessions", "--json"]).then((result) => {
    try {
      const sessions = JSON.parse(result.output) as SessionSummary[];
      return Array.isArray(sessions) ? sessions : [];
    } catch {
      return [];
    }
  });
}

function runCommand(args: string[]): Promise<{ code: number | null; output: string }> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return Promise.resolve({ code: null, output: "[]" });
  return new Promise((resolve) => {
    const child = spawn(
      vscode.workspace.getConfiguration("airo").get<string>("command", "airo"),
      args,
      {
        cwd: folder.uri.fsPath,
        shell: false,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    let output = "";
    child.stdout.on("data", (data: Buffer) => (output += data.toString()));
    child.on("error", () => resolve({ code: null, output: "[]" }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

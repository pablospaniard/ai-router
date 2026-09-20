import * as vscode from "vscode";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { renderWebview } from "./webview";

type Message = {
  type: string;
  text?: string;
  action?: string;
  sessionId?: string;
  chatId?: string;
};
type RouteStatus = { provider: string; model: string; tier: string };
type SessionSummary = {
  sessionId: string;
  description: string;
  updatedAt: string;
  turnCount: number;
};
type SidebarChat = {
  id: string;
  title: string;
  session?: SessionSummary;
  activeSession: boolean;
  attachments: string[];
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
  const provider = new SidebarProvider();
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider("airo.sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("airo.runTask", () => provider.focus()),
    vscode.commands.registerCommand("airo.openHistory", () => provider.openHistory()),
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
  private child?: ChildProcessWithoutNullStreams;
  private running = false;
  private stopping = false;
  private awaitingInput = false;
  protected activeSession = false;
  private attachments: string[] = [];
  private readonly sidebarChats = new Map<string, SidebarChat>();
  private activeChatId: string;

  constructor(private session?: SessionSummary) {
    this.activeSession = Boolean(session);
    const chat = this.createChatState(session);
    this.activeChatId = chat.id;
    this.sidebarChats.set(chat.id, chat);
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
    this.post({ type: "focus" });
  }

  openHistory(): void {
    void this.showHistory();
  }

  private async receive(message: Message): Promise<void> {
    if (message.type === "ready") {
      this.postTabs();
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
        this.saveActiveChat();
      }
      this.post({
        type: "session",
        value: this.session
          ? `Chat — ${chatTitle(this.session.description)}`
          : this.activeSession
            ? "Connected to the active AIRO chat"
            : "New chat — send a task to begin",
      });
    } else if (message.type === "newTab") await this.newTab();
    else if (message.type === "closeTab" && message.chatId) this.closeTab(message.chatId);
    else if (message.type === "openSession" && message.sessionId)
      await this.openSessionTab(message.sessionId);
    else if (message.type === "switchTab" && message.chatId) this.switchTab(message.chatId);
    else if (message.type === "attach") await this.pickAttachments();
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
    const chat = this.sidebarChats.get(this.activeChatId);
    if (chat?.title === "New chat") {
      chat.title = shortDescription(text);
      this.postTabs();
    }
    const attached = this.attachments.length
      ? "\n\nAttached local file(s) for inspection:\n" +
        this.attachments.map((file) => `- ${file}`).join("\n") +
        "\nUse the provider's local file inspection capability if available."
      : "";
    this.attachments = [];
    this.post({ type: "attachments", files: [] });
    const result = await this.run(this.taskArgs(text + attached), true, text);
    if (result.started) {
      this.activeSession = true;
      if (!this.session) {
        const sessionResult = await runCommand(["session", "--json"]);
        try {
          const session = JSON.parse(sessionResult.output) as SessionSummary | null;
          if (session?.sessionId) this.session = session;
        } catch {
          // Continue mode remains available as a fallback for older CLI versions.
        }
      }
      this.saveActiveChat();
    }
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
    if (command === "/new") return this.newTab();
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
    if (action === "new") return this.newTab();
    if (action === "history") return this.showHistory();
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
    this.saveActiveChat();
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

  private createChatState(session?: SessionSummary): SidebarChat {
    return {
      id: session?.sessionId ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: session ? chatTitle(session.description) : "New chat",
      session,
      activeSession: Boolean(session),
      attachments: [],
    };
  }

  private saveActiveChat(): void {
    const chat = this.sidebarChats.get(this.activeChatId);
    if (!chat) return;
    chat.session = this.session;
    chat.activeSession = this.activeSession;
    chat.attachments = [...this.attachments];
    if (this.session && chat.title === "New chat") {
      chat.title = chatTitle(this.session.description);
    }
    if (this.session && chat.id.startsWith("draft-")) {
      const oldId = chat.id;
      this.sidebarChats.delete(chat.id);
      chat.id = this.session.sessionId;
      this.activeChatId = chat.id;
      this.sidebarChats.set(chat.id, chat);
      this.post({ type: "replaceTabId", oldId, newId: chat.id });
      this.postTabs();
    }
  }

  private loadChat(chat: SidebarChat): void {
    this.activeChatId = chat.id;
    this.session = chat.session;
    this.activeSession = chat.activeSession;
    this.attachments = [...chat.attachments];
  }

  private async newTab(): Promise<void> {
    if (this.running) return this.notice("Stop the current run before opening another chat.");
    this.saveActiveChat();
    const chat = this.createChatState();
    this.sidebarChats.set(chat.id, chat);
    this.loadChat(chat);
    this.postTabs();
    this.post({ type: "activateTab", chatId: chat.id });
    this.post({ type: "session", value: "New chat — send a task to begin" });
    this.post({ type: "attachments", files: [] });
    this.post({ type: "route", ...this.configuredRoute() });
    this.postState();
  }

  private switchTab(chatId: string): void {
    if (chatId === this.activeChatId) return;
    if (this.running) return this.notice("Stop the current run before switching chats.");
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    this.saveActiveChat();
    this.activateChat(chat);
  }

  private closeTab(chatId: string): void {
    const chat = this.sidebarChats.get(chatId);
    if (!chat) return;
    if (chatId === this.activeChatId && this.running) {
      this.notice("Stop the current run before closing this chat.");
      return;
    }

    const chatIds = [...this.sidebarChats.keys()];
    const closedIndex = chatIds.indexOf(chatId);
    this.sidebarChats.delete(chatId);
    this.post({ type: "removeTab", chatId });

    if (chatId !== this.activeChatId) {
      this.postTabs();
      return;
    }

    const nextId = chatIds[closedIndex + 1] ?? chatIds[closedIndex - 1];
    const nextChat = nextId ? this.sidebarChats.get(nextId) : this.createChatState();
    if (!nextChat) return;
    if (!nextId) this.sidebarChats.set(nextChat.id, nextChat);
    this.loadChat(nextChat);
    this.postTabs();
    this.activateChat(nextChat);
  }

  private activateChat(chat: SidebarChat): void {
    this.loadChat(chat);
    this.post({ type: "activateTab", chatId: chat.id });
    this.post({
      type: "session",
      value: chat.session
        ? `Chat — ${chatTitle(chat.session.description)}`
        : "New chat — send a task to begin",
    });
    this.post({
      type: "attachments",
      files: chat.attachments.map((file) => path.basename(file)),
    });
    this.post({ type: "route", ...this.configuredRoute() });
    this.postState();
  }

  private async showHistory(): Promise<void> {
    const sessions = await listSessionSummaries();
    this.post({
      type: "history",
      sessions: sessions.map((session) => ({
        ...session,
        description: chatTitle(session.description),
        open: [...this.sidebarChats.values()].some(
          (chat) => chat.session?.sessionId === session.sessionId,
        ),
      })),
    });
  }

  private async openSessionTab(sessionId: string): Promise<void> {
    if (this.running) return this.notice("Stop the current run before opening another chat.");
    this.saveActiveChat();
    const existing = [...this.sidebarChats.values()].find(
      (chat) => chat.session?.sessionId === sessionId,
    );
    if (existing) {
      this.activateChat(existing);
      this.postTabs();
      return;
    }
    const session = (await listSessionSummaries()).find((item) => item.sessionId === sessionId);
    if (!session) return this.notice("That chat is no longer available.");
    const chat = this.createChatState(session);
    this.sidebarChats.set(chat.id, chat);
    this.activateChat(chat);
    this.postTabs();
  }

  private postTabs(): void {
    this.post({
      type: "tabs",
      activeChatId: this.activeChatId,
      tabs: [...this.sidebarChats.values()].map((chat) => ({ id: chat.id, title: chat.title })),
    });
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
    const webview = this.view?.webview;
    if (webview) void webview.postMessage(message);
  }
}

function shortDescription(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 64) || "Untitled chat";
}

function chatTitle(value: string): string {
  const title = shortDescription(value);
  return /^(?:new session|airo sidebar session)$/i.test(title) ? "New chat" : title;
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

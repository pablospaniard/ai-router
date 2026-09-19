import * as vscode from "vscode";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { renderWebview } from "./webview";

type Message = { type: string; text?: string; action?: string };
type RouteStatus = { provider: string; model: string; tier: string };
type ProtocolEvent = {
  type: string;
  provider?: string;
  model?: string;
  tier?: string;
  question?: string;
  text?: string;
  requiresApproval?: boolean;
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
  private view?: vscode.WebviewView;
  private child?: ChildProcessWithoutNullStreams;
  private running = false;
  private awaitingInput = false;
  private activeSession = false;
  private attachments: string[] = [];

  dispose(): void {
    this.child?.kill();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = renderWebview(
      [...Array(24)].map(() => Math.random().toString(36)[2]).join(""),
    );
    view.onDidDispose(() => {
      this.view = undefined;
    });
    view.webview.onDidReceiveMessage((message: Message) => void this.receive(message));
  }

  focus(): void {
    this.view?.show?.(true);
    this.post({ type: "focus" });
  }

  private async receive(message: Message): Promise<void> {
    if (message.type === "ready") {
      this.post({ type: "route", ...this.configuredRoute() });
      this.postState();
      const result = await this.run(["session"], false);
      this.activeSession =
        result.code === 0 && !/No active session for this repo\./.test(result.output);
      this.post({
        type: "session",
        value: this.activeSession
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
    if (command === "/new") return this.newSession(argument || "AIRO sidebar session");
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
      await this.run(commands[command], true, command.slice(1));
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
    if (action === "new") return this.newSession("AIRO sidebar session");
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

  private async newSession(title: string): Promise<void> {
    const result = await this.run(["session", "new", title], true, "New session");
    this.activeSession = result.code === 0;
    if (this.activeSession) this.post({ type: "session", value: "New AIRO session ready" });
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
    const args = this.activeSession ? ["--continue"] : [];
    if (mode === "adaptive") args.push("--adaptive");
    else if (mode === "single") args.push("--single");
    if (agent !== "auto") args.push("--agent", agent);
    if (tier !== "auto") args.push("--tier", tier);
    return [...args, "--log", log, task];
  }

  private run(
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
            env: { ...process.env, AIRO_COLOR: "1", AIRO_STREAM_PROTOCOL: "1" },
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
        if (stdoutBuffer) handleLine(stdoutBuffer, false);
        if (stderrBuffer) handleLine(stderrBuffer, false);
        this.child = undefined;
        this.running = false;
        this.awaitingInput = false;
        this.postState();
        if (showOutput && !hasFinal && humanOutput.trim()) {
          this.post({
            type: code === 0 ? "final" : "failure",
            text: this.plainText(humanOutput).trim(),
          });
        }
        if (showOutput) this.post({ type: "end", code });
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
    this.post({ type: "state", running: this.running, awaitingInput: this.awaitingInput });
  }

  private notice(value: string): void {
    this.post({ type: "notice", value });
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }
}

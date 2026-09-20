"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
const vscode = __importStar(require("vscode"));
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const webview_1 = require("./webview");
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
function activate(context) {
    const chats = new Map();
    const openHistory = () => void HistoryPanel.open(openSession, chats);
    const openSession = (session) => {
        const existing = chats.get(session.sessionId);
        if (existing)
            return existing.focus();
        ChatPanel.open(session, openHistory, chats);
    };
    const createChat = async () => {
        const result = await runCommand(["session", "new"]);
        if (result.code !== 0) {
            void vscode.window.showErrorMessage("AIRO could not create a new chat.");
            return;
        }
        const sessions = await listSessionSummaries();
        if (sessions[0])
            openSession(sessions[0]);
    };
    const provider = new SidebarProvider(openHistory, undefined, createChat);
    context.subscriptions.push(provider, vscode.window.registerWebviewViewProvider("airo.sidebar", provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }), vscode.commands.registerCommand("airo.runTask", () => provider.focus()), vscode.commands.registerCommand("airo.openHistory", openHistory), vscode.commands.registerCommand("airo.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:pablospaniard.airo-vscode")), vscode.commands.registerCommand("airo.openTerminal", () => {
        const terminal = vscode.window.createTerminal("AIRO");
        terminal.show();
        terminal.sendText(vscode.workspace.getConfiguration("airo").get("command", "airo"));
    }));
}
class SidebarProvider {
    onOpenHistory;
    session;
    onNewChat;
    view;
    panel;
    child;
    running = false;
    stopping = false;
    awaitingInput = false;
    activeSession = false;
    attachments = [];
    constructor(onOpenHistory, session, onNewChat) {
        this.onOpenHistory = onOpenHistory;
        this.session = session;
        this.onNewChat = onNewChat;
        this.activeSession = Boolean(session);
    }
    dispose() {
        this.child?.kill();
    }
    resolveWebviewView(view) {
        this.view = view;
        this.initializeWebview(view.webview);
        view.onDidDispose(() => {
            this.view = undefined;
        });
    }
    initializeWebview(webview) {
        webview.options = { enableScripts: true };
        webview.html = (0, webview_1.renderWebview)([...Array(24)].map(() => Math.random().toString(36)[2]).join(""));
        webview.onDidReceiveMessage((message) => void this.receive(message));
    }
    focus() {
        this.view?.show?.(true);
        this.panel?.reveal(undefined, true);
        this.post({ type: "focus" });
    }
    isRunning() {
        return this.running;
    }
    async receive(message) {
        if (message.type === "ready") {
            this.post({ type: "route", ...this.configuredRoute() });
            this.postState();
            if (!this.session) {
                const result = await this.run(["session", "--json"], false);
                try {
                    const session = JSON.parse(result.output);
                    if (session?.sessionId)
                        this.session = session;
                }
                catch {
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
        }
        else if (message.type === "attach")
            await this.pickAttachments();
        else if (message.type === "action")
            await this.action(message.action ?? "", message.text);
        else if (message.type === "prompt" && message.text?.trim())
            await this.prompt(message.text.trim());
    }
    async prompt(text) {
        if (this.running) {
            if (this.awaitingInput && this.child?.stdin.writable) {
                this.awaitingInput = false;
                this.postState();
                this.child.stdin.write(`${text}\n`);
            }
            else {
                this.notice("AIRO is already working on a request.");
            }
            return;
        }
        if (text.startsWith("/"))
            return this.slash(text);
        const attached = this.attachments.length
            ? "\n\nAttached local file(s) for inspection:\n" +
                this.attachments.map((file) => `- ${file}`).join("\n") +
                "\nUse the provider's local file inspection capability if available."
            : "";
        this.attachments = [];
        this.post({ type: "attachments", files: [] });
        const result = await this.run(this.taskArgs(text + attached), true, text);
        if (result.started)
            this.activeSession = true;
    }
    async slash(input) {
        const [command, ...parts] = input.split(/\s+/);
        const argument = parts.join(" ");
        const commands = {
            "/status": ["session"],
            "/sessions": ["sessions"],
            "/models": ["models"],
            "/account": ["account"],
            "/usage": ["usage", ...(argument ? [argument] : [])],
            "/logs": ["logs"],
            "/doctor": ["doctor"],
        };
        if (command === "/help")
            return this.post({ type: "help" });
        if (command === "/clear")
            return this.post({ type: "clear" });
        if (command === "/attach")
            return this.pickAttachments();
        if (command === "/new")
            return this.onNewChat?.();
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
            await this.run(command === "/sessions" ? ["sessions", "--limit", "5"] : commands[command], true, command.slice(1));
            return;
        }
        this.notice(`Unknown command: ${command}. Type /help for available commands.`);
    }
    async action(action, text) {
        if (action === "settings") {
            await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:pablospaniard.airo-vscode");
            return;
        }
        if (action === "new")
            return this.onNewChat?.();
        if (action === "history")
            return this.onOpenHistory();
        if (action === "stop")
            return this.stop();
        if (action === "feedback") {
            await this.run(["feedback", text === "bad" ? "bad" : "good"], true, "Feedback");
            return;
        }
        const commands = {
            models: ["models"],
            account: ["account"],
            usage: ["usage"],
            logs: ["logs"],
            doctor: ["doctor"],
        };
        if (commands[action])
            await this.run(commands[action], true, action);
    }
    stop() {
        if (!this.running || !this.child || this.stopping)
            return;
        this.stopping = this.child.kill();
        this.postState();
        if (!this.stopping)
            this.notice("AIRO could not stop the current run.");
    }
    async pickAttachments() {
        const files = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFiles: true,
            canSelectFolders: false,
            filters: { "AIRO attachments": extensions },
        });
        if (!files?.length)
            return;
        this.attachments.push(...files.map((file) => file.fsPath));
        this.post({ type: "attachments", files: this.attachments.map((file) => node_path_1.default.basename(file)) });
    }
    taskArgs(task) {
        const config = vscode.workspace.getConfiguration("airo");
        const mode = config.get("mode", "auto");
        const agent = config.get("agent", "auto");
        const tier = config.get("tier", "auto");
        const log = config.get("logLevel", "live");
        const args = this.session
            ? ["--session", this.session.sessionId]
            : this.activeSession
                ? ["--continue"]
                : [];
        if (mode === "adaptive")
            args.push("--adaptive");
        else if (mode === "single")
            args.push("--single");
        if (agent !== "auto")
            args.push("--agent", agent);
        if (tier !== "auto")
            args.push("--tier", tier);
        return [...args, "--log", log, task];
    }
    run(args, showOutput, label = args.join(" ")) {
        if (this.running) {
            this.notice("AIRO is already working on a request.");
            return Promise.resolve({ code: null, output: "", started: false });
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this.notice("Open a workspace folder before starting AIRO.");
            return Promise.resolve({ code: null, output: "", started: false });
        }
        if (showOutput)
            this.post({ type: "start", label });
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
            let child;
            try {
                child = (0, node_child_process_1.spawn)(vscode.workspace.getConfiguration("airo").get("command", "airo"), args, {
                    cwd: folder.uri.fsPath,
                    shell: false,
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                    env: { ...process.env, NO_COLOR: "1", AIRO_STREAM_PROTOCOL: "1" },
                });
                this.child = child;
                started = true;
            }
            catch (error) {
                this.running = false;
                this.postState();
                this.notice(`Could not start AIRO: ${String(error)}`);
                return resolve({ code: null, output, started });
            }
            const handleProtocol = (event) => {
                if (event.type === "route" && event.provider && event.model && event.tier) {
                    this.post({
                        type: "route",
                        provider: event.provider,
                        model: event.model,
                        tier: event.tier,
                    });
                }
                else if ((event.type === "input" || event.type === "permission") && event.question) {
                    this.awaitingInput = true;
                    this.post({
                        type: event.type === "permission" ? "permission" : "interaction",
                        text: event.question,
                    });
                    this.postState();
                }
                else if (event.type === "phase" && event.kind && event.state) {
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
                }
                else if (event.type === "final" && event.text) {
                    hasFinal = true;
                    this.post({ type: "final", text: event.text });
                }
            };
            const handleLine = (line, newline) => {
                if (line.startsWith("AIRO_EVENT ")) {
                    try {
                        handleProtocol(JSON.parse(line.slice("AIRO_EVENT ".length)));
                        return;
                    }
                    catch {
                        // Treat a malformed protocol line as ordinary diagnostic output.
                    }
                }
                const text = line + (newline ? "\n" : "");
                humanOutput += text;
                if (showOutput)
                    this.post({ type: "activity", text });
            };
            const write = (data, stream) => {
                const text = data.toString();
                output += text;
                const buffered = (stream === "stdout" ? stdoutBuffer : stderrBuffer) + text;
                const lines = buffered.split("\n");
                if (stream === "stdout")
                    stdoutBuffer = lines.pop() ?? "";
                else
                    stderrBuffer = lines.pop() ?? "";
                for (const line of lines)
                    handleLine(line, true);
            };
            child.stdout.on("data", (data) => write(data, "stdout"));
            child.stderr.on("data", (data) => write(data, "stderr"));
            child.on("error", (error) => this.notice(`Could not start AIRO: ${error.message}`));
            child.on("close", (code) => {
                const stopped = this.stopping;
                if (stdoutBuffer)
                    handleLine(stdoutBuffer, false);
                if (stderrBuffer)
                    handleLine(stderrBuffer, false);
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
                if (showOutput)
                    this.post({ type: "end", code, stopped });
                resolve({ code, output, started });
            });
        });
    }
    configuredRoute() {
        const config = vscode.workspace.getConfiguration("airo");
        const provider = config.get("agent", "auto");
        return {
            provider: provider === "auto" ? "Auto" : provider,
            model: "Routing",
            tier: config.get("tier", "auto"),
        };
    }
    plainText(value) {
        return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
    }
    postState() {
        this.post({
            type: "state",
            running: this.running,
            stopping: this.stopping,
            awaitingInput: this.awaitingInput,
        });
    }
    notice(value) {
        this.post({ type: "notice", value });
    }
    post(message) {
        const webview = this.view?.webview ?? this.panel?.webview;
        if (webview)
            void webview.postMessage(message);
    }
}
class ChatPanel extends SidebarProvider {
    constructor(session, onOpenHistory, onNewChat) {
        super(onOpenHistory, session, onNewChat);
    }
    static open(session, onOpenHistory, chats) {
        const provider = new ChatPanel(session, onOpenHistory, async () => {
            const result = await runCommand(["session", "new"]);
            if (result.code !== 0)
                return void vscode.window.showErrorMessage("AIRO could not create a new chat.");
            const sessions = await listSessionSummaries();
            if (sessions[0]) {
                const existing = chats.get(sessions[0].sessionId);
                if (existing)
                    existing.focus();
                else
                    ChatPanel.open(sessions[0], onOpenHistory, chats);
            }
        });
        const panel = vscode.window.createWebviewPanel("airo.chat", `AIRO: ${shortDescription(session.description)}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
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
    static async open(onSelect, chats) {
        const panel = vscode.window.createWebviewPanel("airo.history", "AIRO: Previous chats", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
        panel.webview.html = (0, webview_1.renderHistoryWebview)([...Array(24)].map(() => Math.random().toString(36)[2]).join(""));
        panel.webview.onDidReceiveMessage((message) => {
            if (message.type === "restore" && message.sessionId) {
                const session = sessions.find((item) => item.sessionId === message.sessionId);
                if (session)
                    onSelect(session);
            }
        });
        let sessions = [];
        const result = await runCommand(["sessions", "--json"]);
        try {
            sessions = JSON.parse(result.output);
            if (!Array.isArray(sessions))
                throw new Error("Invalid session list");
            void panel.webview.postMessage({
                type: "sessions",
                sessions: sessions.map((session) => ({
                    ...session,
                    running: chats.get(session.sessionId)?.isRunning() ?? false,
                    open: chats.has(session.sessionId),
                })),
            });
        }
        catch {
            void panel.webview.postMessage({
                type: "error",
                value: "Could not load previous AIRO sessions.",
            });
        }
    }
}
function shortDescription(value) {
    return value.replace(/\s+/g, " ").trim().slice(0, 64) || "Untitled chat";
}
function listSessionSummaries() {
    return runCommand(["sessions", "--json"]).then((result) => {
        try {
            const sessions = JSON.parse(result.output);
            return Array.isArray(sessions) ? sessions : [];
        }
        catch {
            return [];
        }
    });
}
function runCommand(args) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder)
        return Promise.resolve({ code: null, output: "[]" });
    return new Promise((resolve) => {
        const child = (0, node_child_process_1.spawn)(vscode.workspace.getConfiguration("airo").get("command", "airo"), args, {
            cwd: folder.uri.fsPath,
            shell: false,
            windowsHide: true,
            env: { ...process.env, NO_COLOR: "1" },
        });
        let output = "";
        child.stdout.on("data", (data) => (output += data.toString()));
        child.on("error", () => resolve({ code: null, output: "[]" }));
        child.on("close", (code) => resolve({ code, output }));
    });
}
//# sourceMappingURL=extension.js.map
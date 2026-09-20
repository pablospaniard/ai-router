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
    const provider = new SidebarProvider();
    context.subscriptions.push(provider, vscode.window.registerWebviewViewProvider("airo.sidebar", provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }), vscode.commands.registerCommand("airo.runTask", () => provider.focus()), vscode.commands.registerCommand("airo.openHistory", () => provider.openHistory()), vscode.commands.registerCommand("airo.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:pablospaniard.airo-vscode")), vscode.commands.registerCommand("airo.openTerminal", () => {
        const terminal = vscode.window.createTerminal("AIRO");
        terminal.show();
        terminal.sendText(vscode.workspace.getConfiguration("airo").get("command", "airo"));
    }));
}
class SidebarProvider {
    session;
    view;
    child;
    running = false;
    runningChatId;
    stopping = false;
    awaitingInput = false;
    activeSession = false;
    attachments = [];
    sidebarChats = new Map();
    activeChatId;
    constructor(session) {
        this.session = session;
        this.activeSession = Boolean(session);
        const chat = this.createChatState(session);
        this.activeChatId = chat.id;
        this.sidebarChats.set(chat.id, chat);
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
        for (const chat of this.sidebarChats.values())
            chat.hydrated = false;
        webview.options = { enableScripts: true };
        webview.html = (0, webview_1.renderWebview)([...Array(24)].map(() => Math.random().toString(36)[2]).join(""));
        webview.onDidReceiveMessage((message) => void this.receive(message));
    }
    focus() {
        this.view?.show?.(true);
        this.post({ type: "focus" });
    }
    openHistory() {
        void this.showHistory();
    }
    async receive(message) {
        if (message.type === "ready") {
            this.postTabs();
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
                this.saveActiveChat();
            }
            const chat = this.sidebarChats.get(this.activeChatId);
            if (chat?.session)
                await this.hydrateChat(chat);
            this.post({
                type: "session",
                value: this.session
                    ? `Chat — ${chatTitle(this.session.description)}`
                    : this.activeSession
                        ? "Connected to the active AIRO chat"
                        : "New chat — send a task to begin",
            });
        }
        else if (message.type === "newTab")
            await this.newTab();
        else if (message.type === "closeTab" && message.chatId)
            this.closeTab(message.chatId);
        else if (message.type === "openLink" && message.url)
            await this.openLink(message.url);
        else if (message.type === "openSession" && message.sessionId)
            await this.openSessionTab(message.sessionId);
        else if (message.type === "switchTab" && message.chatId)
            this.switchTab(message.chatId);
        else if (message.type === "attach")
            await this.pickAttachments();
        else if (message.type === "action")
            await this.action(message.action ?? "", message.text);
        else if (message.type === "prompt" && message.text?.trim())
            await this.prompt(message.text.trim());
    }
    async prompt(text) {
        if (this.running) {
            if (this.activeChatId === this.runningChatId &&
                this.awaitingInput &&
                this.child?.stdin.writable) {
                this.awaitingInput = false;
                this.postState(this.runningChatId);
                this.child.stdin.write(`${text}\n`);
            }
            else {
                this.notice("AIRO is already working on a request.");
            }
            return;
        }
        if (text.startsWith("/"))
            return this.slash(text);
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
        const chatId = this.activeChatId;
        const result = await this.run(this.taskArgs(text + attached), true, text);
        if (result.started) {
            const chat = this.sidebarChats.get(chatId);
            if (!chat)
                return;
            chat.activeSession = true;
            if (!chat.session) {
                const sessionResult = await runCommand(["session", "--json"]);
                try {
                    const session = JSON.parse(sessionResult.output);
                    if (session?.sessionId)
                        chat.session = session;
                }
                catch {
                    // Continue mode remains available as a fallback for older CLI versions.
                }
            }
            if (this.activeChatId === chatId) {
                this.session = chat.session;
                this.activeSession = chat.activeSession;
                this.saveActiveChat();
            }
            else {
                this.replaceDraftId(chatId, chat);
            }
            chat.hydrated = true;
        }
    }
    async openLink(value) {
        let uri;
        try {
            uri = vscode.Uri.parse(value, true);
        }
        catch {
            return;
        }
        if (uri.scheme !== "https" && uri.scheme !== "http")
            return;
        await vscode.env.openExternal(uri);
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
            return this.newTab();
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
            return this.newTab();
        if (action === "history")
            return this.showHistory();
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
        if (!this.running || this.activeChatId !== this.runningChatId || !this.child || this.stopping)
            return;
        this.stopping = this.child.kill();
        this.postState(this.runningChatId);
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
        this.saveActiveChat();
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
        const chatId = this.activeChatId;
        if (showOutput)
            this.postToChat(chatId, { type: "start", label });
        this.running = true;
        this.runningChatId = chatId;
        this.stopping = false;
        this.awaitingInput = false;
        this.postState(chatId);
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
                this.runningChatId = undefined;
                this.postState(chatId);
                this.notice(`Could not start AIRO: ${String(error)}`, chatId);
                return resolve({ code: null, output, started });
            }
            const handleProtocol = (event) => {
                if (event.type === "route" && event.provider && event.model && event.tier) {
                    this.postToChat(chatId, {
                        type: "route",
                        provider: event.provider,
                        model: event.model,
                        tier: event.tier,
                    });
                }
                else if ((event.type === "input" || event.type === "permission") && event.question) {
                    this.awaitingInput = true;
                    this.postToChat(chatId, {
                        type: event.type === "permission" ? "permission" : "interaction",
                        text: event.question,
                    });
                    this.postState(chatId);
                }
                else if (event.type === "phase" && event.kind && event.state) {
                    this.postToChat(chatId, {
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
                    this.postToChat(chatId, { type: "final", text: event.text });
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
                    this.postToChat(chatId, { type: "activity", text });
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
            child.on("error", (error) => this.notice(`Could not start AIRO: ${error.message}`, chatId));
            child.on("close", (code) => {
                const stopped = this.stopping;
                if (stdoutBuffer)
                    handleLine(stdoutBuffer, false);
                if (stderrBuffer)
                    handleLine(stderrBuffer, false);
                this.child = undefined;
                this.running = false;
                this.runningChatId = undefined;
                this.stopping = false;
                this.awaitingInput = false;
                this.postState(chatId);
                if (!stopped && showOutput && !hasFinal && humanOutput.trim()) {
                    this.postToChat(chatId, {
                        type: code === 0 ? "final" : "failure",
                        text: this.plainText(humanOutput).trim(),
                    });
                }
                if (showOutput)
                    this.postToChat(chatId, { type: "end", code, stopped });
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
    createChatState(session) {
        return {
            id: session?.sessionId ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            title: session ? chatTitle(session.description) : "New chat",
            session,
            activeSession: Boolean(session),
            attachments: [],
            hydrated: false,
        };
    }
    saveActiveChat() {
        const chat = this.sidebarChats.get(this.activeChatId);
        if (!chat)
            return;
        chat.session = this.session;
        chat.activeSession = this.activeSession;
        chat.attachments = [...this.attachments];
        if (this.session && chat.title === "New chat") {
            chat.title = chatTitle(this.session.description);
        }
        this.replaceDraftId(chat.id, chat);
    }
    replaceDraftId(oldId, chat) {
        if (!chat.session || !chat.id.startsWith("draft-"))
            return;
        this.sidebarChats.delete(oldId);
        chat.id = chat.session.sessionId;
        if (this.activeChatId === oldId)
            this.activeChatId = chat.id;
        this.sidebarChats.set(chat.id, chat);
        this.post({ type: "replaceTabId", oldId, newId: chat.id });
        this.postTabs();
    }
    loadChat(chat) {
        this.activeChatId = chat.id;
        this.session = chat.session;
        this.activeSession = chat.activeSession;
        this.attachments = [...chat.attachments];
    }
    async newTab() {
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
    switchTab(chatId) {
        if (chatId === this.activeChatId)
            return;
        const chat = this.sidebarChats.get(chatId);
        if (!chat)
            return;
        this.saveActiveChat();
        this.activateChat(chat);
    }
    closeTab(chatId) {
        const chat = this.sidebarChats.get(chatId);
        if (!chat)
            return;
        if (chatId === this.runningChatId) {
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
        if (!nextChat)
            return;
        if (!nextId)
            this.sidebarChats.set(nextChat.id, nextChat);
        this.loadChat(nextChat);
        this.postTabs();
        this.activateChat(nextChat);
    }
    activateChat(chat) {
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
            files: chat.attachments.map((file) => node_path_1.default.basename(file)),
        });
        this.post({ type: "route", ...this.configuredRoute() });
        this.postState();
    }
    async showHistory() {
        const sessions = await listSessionSummaries();
        this.post({
            type: "history",
            sessions: sessions.map((session) => ({
                ...session,
                description: chatTitle(session.description),
                open: [...this.sidebarChats.values()].some((chat) => chat.session?.sessionId === session.sessionId),
            })),
        });
    }
    async openSessionTab(sessionId) {
        this.saveActiveChat();
        const existing = [...this.sidebarChats.values()].find((chat) => chat.session?.sessionId === sessionId);
        if (existing) {
            this.activateChat(existing);
            this.postTabs();
            await this.hydrateChat(existing);
            return;
        }
        const session = (await listSessionSummaries()).find((item) => item.sessionId === sessionId);
        if (!session)
            return this.notice("That chat is no longer available.");
        const chat = this.createChatState(session);
        this.sidebarChats.set(chat.id, chat);
        this.activateChat(chat);
        this.postTabs();
        await this.hydrateChat(chat);
    }
    async hydrateChat(chat) {
        if (chat.hydrated || !chat.session)
            return;
        const result = await runCommand(["session", chat.session.sessionId, "--json"]);
        try {
            const transcript = JSON.parse(result.output);
            if (!transcript || !Array.isArray(transcript.turns))
                return;
            this.postToChat(chat.id, { type: "restore", turns: transcript.turns });
            chat.hydrated = true;
        }
        catch {
            this.notice("AIRO could not restore this chat's saved transcript.", chat.id);
        }
    }
    postTabs() {
        this.post({
            type: "tabs",
            activeChatId: this.activeChatId,
            tabs: [...this.sidebarChats.values()].map((chat) => ({ id: chat.id, title: chat.title })),
        });
    }
    plainText(value) {
        return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
    }
    postState(chatId = this.activeChatId) {
        const isRunningChat = this.running && this.runningChatId === chatId;
        this.postToChat(chatId, {
            type: "state",
            running: isRunningChat,
            stopping: isRunningChat && this.stopping,
            awaitingInput: isRunningChat && this.awaitingInput,
        });
    }
    notice(value, chatId = this.activeChatId) {
        this.postToChat(chatId, { type: "notice", value });
    }
    postToChat(chatId, message) {
        this.post({ ...message, chatId });
    }
    post(message) {
        const webview = this.view?.webview;
        if (webview)
            void webview.postMessage(message);
    }
}
function shortDescription(value) {
    return value.replace(/\s+/g, " ").trim().slice(0, 64) || "Untitled chat";
}
function chatTitle(value) {
    const title = shortDescription(value);
    return /^(?:new session|airo sidebar session)$/i.test(title) ? "New chat" : title;
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
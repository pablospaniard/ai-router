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
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("airo.sidebar", provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }), vscode.commands.registerCommand("airo.runTask", () => provider.focus()), vscode.commands.registerCommand("airo.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:pablospaniard.airo-vscode")), vscode.commands.registerCommand("airo.openTerminal", () => {
        const terminal = vscode.window.createTerminal("AIRO");
        terminal.show();
        terminal.sendText(vscode.workspace.getConfiguration("airo").get("command", "airo"));
    }));
}
class SidebarProvider {
    view;
    running = false;
    activeSession = false;
    attachments = [];
    resolveWebviewView(view) {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = this.html();
        view.onDidDispose(() => {
            this.view = undefined;
        });
        view.webview.onDidReceiveMessage((message) => void this.receive(message));
    }
    focus() {
        this.view?.show?.(true);
        this.post({ type: "focus" });
    }
    async receive(message) {
        if (message.type === "ready") {
            this.post({ type: "settings", value: this.settingSummary() });
            const result = await this.run(["session"], false);
            this.activeSession =
                result.code === 0 && !/No active session for this repo\./.test(result.output);
            this.post({
                type: "session",
                value: this.activeSession
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
        if (text.startsWith("/"))
            return this.slash(text);
        const attached = this.attachments.length
            ? "\n\nAttached local file(s) for inspection:\n" +
                this.attachments.map((file) => "- " + file).join("\n") +
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
            return this.newSession(argument || "AIRO sidebar session");
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
        this.notice("Unknown command: " + command + ". Type /help for available commands.");
    }
    async action(action, text) {
        if (action === "settings") {
            await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:pablospaniard.airo-vscode");
            return;
        }
        if (action === "new")
            return this.newSession("AIRO sidebar session");
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
    async newSession(title) {
        const result = await this.run(["session", "new", title], true, "New session");
        this.activeSession = result.code === 0;
        if (this.activeSession)
            this.post({ type: "session", value: "New AIRO session ready" });
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
        const mode = config.get("mode", "auto"), agent = config.get("agent", "auto"), tier = config.get("tier", "auto"), log = config.get("logLevel", "compact");
        const args = this.activeSession ? ["--continue"] : [];
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
        return new Promise((resolve) => {
            let output = "";
            let started = false;
            let child;
            try {
                child = (0, node_child_process_1.spawn)(vscode.workspace.getConfiguration("airo").get("command", "airo"), args, { cwd: folder.uri.fsPath, shell: false, windowsHide: true });
                started = true;
            }
            catch (error) {
                this.running = false;
                this.notice("Could not start AIRO: " + String(error));
                return resolve({ code: null, output, started });
            }
            const write = (data) => {
                const text = data.toString();
                output += text;
                if (showOutput)
                    this.post({ type: "output", text });
            };
            child.stdout.on("data", write);
            child.stderr.on("data", write);
            child.on("error", (error) => this.notice("Could not start AIRO: " + error.message));
            child.on("close", (code) => {
                this.running = false;
                if (showOutput)
                    this.post({ type: "end", code });
                resolve({ code, output, started });
            });
        });
    }
    settingSummary() {
        const config = vscode.workspace.getConfiguration("airo");
        return [
            config.get("mode", "auto"),
            config.get("agent", "auto"),
            config.get("tier", "auto"),
            config.get("logLevel", "compact"),
        ].join(" · ");
    }
    notice(value) {
        this.post({ type: "notice", value });
    }
    post(message) {
        void this.view?.webview.postMessage(message);
    }
    html() {
        const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join("");
        return ('<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-' +
            nonce +
            '\'"><style>*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size) var(--vscode-font-family)}header{padding:14px 12px 10px;border-bottom:1px solid var(--vscode-sideBar-border,transparent)}h1{font-size:14px;margin:0 0 5px}.muted,.notice{color:var(--vscode-descriptionForeground);font-size:12px}.toolbar,.quick,.sendrow{display:flex;gap:6px;flex-wrap:wrap}.toolbar{margin-top:10px}button{border:0;border-radius:3px;padding:5px 8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer;font:inherit}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}#chat{height:calc(100vh - 231px);min-height:180px;overflow:auto;padding:12px}.message{margin:0 0 13px}.label{font-size:11px;font-weight:600;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin-bottom:4px}.bubble{padding:8px 9px;border-radius:4px;background:var(--vscode-textBlockQuote-background);white-space:pre-wrap;word-break:break-word}.user .bubble{background:var(--vscode-input-background)}.assistant pre{margin:0;font:12px var(--vscode-editor-font-family,monospace);white-space:pre-wrap;word-break:break-word}.notice{padding:7px 0}.quick{padding:0 12px 10px}.quick button{font-size:12px;padding:4px 7px}footer{position:fixed;bottom:0;width:100%;padding:9px 12px 12px;border-top:1px solid var(--vscode-sideBar-border,transparent);background:var(--vscode-sideBar-background)}#attachments{margin:0 0 6px;font-size:12px;color:var(--vscode-descriptionForeground)}textarea{display:block;width:100%;min-height:68px;max-height:150px;resize:vertical;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);font:inherit}.sendrow{margin-top:7px}.sendrow button:first-child{flex:1}.hint{margin-top:7px;font-size:11px;color:var(--vscode-descriptionForeground)}</style></head><body><header><h1>AIRO</h1><div id="session" class="muted">Connecting…</div><div class="toolbar"><button class="secondary" data-action="new">New chat</button><button class="secondary" data-action="settings">Settings</button><span id="settings" class="muted"></span></div></header><main id="chat"></main><div class="quick"><button class="secondary" data-action="models">Models</button><button class="secondary" data-action="account">Accounts</button><button class="secondary" data-action="usage">Usage</button><button class="secondary" data-action="logs">Logs</button><button class="secondary" data-action="doctor">Doctor</button><button class="secondary" data-action="feedback" data-text="good">Helpful</button></div><footer><div id="attachments"></div><textarea id="prompt" placeholder="Ask AIRO anything…"></textarea><div class="sendrow"><button id="send">Send</button><button class="secondary" id="attach">Attach file</button></div><div class="hint">Enter sends · Shift+Enter adds a line · /help lists commands</div></footer><script nonce="' +
            nonce +
            "\">const vscode=acquireVsCodeApi(),chat=document.getElementById('chat'),prompt=document.getElementById('prompt'),attachments=document.getElementById('attachments');let active;const add=(role,text='')=>{const s=document.createElement('section');s.className='message '+role;const l=document.createElement('div');l.className='label';l.textContent=role==='user'?'You':'AIRO';const b=document.createElement(role==='assistant'?'pre':'div');b.className='bubble';b.textContent=text;s.append(l,b);chat.append(s);chat.scrollTop=chat.scrollHeight;return b};const send=()=>{const text=prompt.value.trim();if(!text)return;add('user',text);prompt.value='';vscode.postMessage({type:'prompt',text})};document.getElementById('send').onclick=send;prompt.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});document.getElementById('attach').onclick=()=>vscode.postMessage({type:'attach'});document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>vscode.postMessage({type:'action',action:b.dataset.action,text:b.dataset.text}));window.addEventListener('message',e=>{const m=e.data;if(m.type==='settings')document.getElementById('settings').textContent=m.value;if(m.type==='session')document.getElementById('session').textContent=m.value;if(m.type==='attachments')attachments.textContent=m.files.length?'Attached: '+m.files.join(', '):'';if(m.type==='start')active=add('assistant',m.label+'\\n\\n');if(m.type==='output'){if(!active)active=add('assistant','');active.textContent+=m.text;chat.scrollTop=chat.scrollHeight}if(m.type==='end'){if(active)active.textContent+='\\n\\n'+(m.code===0?'Finished.':'Finished with exit code '+m.code+'.');active=undefined}if(m.type==='notice')add('notice',m.value);if(m.type==='help')add('assistant','Commands: /new [title], /status, /sessions, /models, /account, /usage [limit], /logs, /doctor, /attach, /feedback good|bad [note], /clear.\\n\\nRouting mode, provider, tier, and log detail are configured in VS Code Settings.');if(m.type==='clear')chat.replaceChildren();if(m.type==='focus')prompt.focus()});vscode.postMessage({type:'ready'});</script></body></html>");
    }
}
//# sourceMappingURL=extension.js.map
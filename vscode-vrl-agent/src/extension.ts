/**
 * VS Code extension entry point for VRL Parser Agent.
 *
 * Commands:
 *   vrlAgent.generateParser      — generate VRL from selection or entire file
 *   vrlAgent.analyzeJsonFile     — batch-analyze a JSON/NDJSON events file
 *   vrlAgent.showPatternLibrary  — show the saved parsers table
 *   vrlAgent.selectModel         — fetch models from server, show dropdown picker
 *   vrlAgent.checkConnection     — test LLM server reachability
 *   vrlAgent.clearCache          — wipe the pattern DB
 */

import * as vscode from "vscode";
import * as fs from "fs";
import { PatternDB } from "./db";
import { LlmClient } from "./ollama";
import { VrlAgent } from "./agent";
import { VrlResultPanel } from "./panel";
import { checkVectorInstall, showDebugChannel, testVrl } from "./vector";

let db: PatternDB;
let llm: LlmClient;
let agent: VrlAgent;
let statusBarItem: vscode.StatusBarItem;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("vrlAgent");
}

function buildClient(): LlmClient {
  const c = getConfig();
  return new LlmClient(
    c.get("serverUrl", ""),
    c.get("apiToken", ""),
    c.get("model", ""),
    c.get("temperature", 0.1),
    c.get("maxTokens", null) as number | null,
  );
}

function getVectorPath(): string | undefined {
  const c = getConfig();
  if (!c.get("validateWithVector", true)) return undefined;
  return c.get("vectorPath", "vector") || undefined;
}

function ensureConfigured(): boolean {
  const c = getConfig();
  if (!c.get<string>("serverUrl")) {
    vscode.window.showWarningMessage(
      "VRL Agent: Server URL not configured. Go to Settings → VRL Parser Agent.",
      "Open Settings",
    ).then(choice => {
      if (choice === "Open Settings") {
        vscode.commands.executeCommand("workbench.action.openSettings", "vrlAgent.serverUrl");
      }
    });
    return false;
  }
  if (!c.get<string>("model")) {
    vscode.window.showWarningMessage(
      "VRL Agent: No model selected. Run 'VRL: Select LLM Model' first.",
      "Select Model",
    ).then(choice => {
      if (choice === "Select Model") {
        vscode.commands.executeCommand("vrlAgent.selectModel");
      }
    });
    return false;
  }
  return true;
}

// ── Activation ───────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Ensure storage directory exists
  const storagePath = context.globalStorageUri.fsPath;
  fs.mkdirSync(storagePath, { recursive: true });

  // Init DB (async — sql.js WASM init) and client
  db = new PatternDB(storagePath);
  await db.ensureReady();
  llm = buildClient();
  agent = new VrlAgent(llm, db);

  // React to config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("vrlAgent")) {
        const c = getConfig();
        llm.updateConfig({
          baseUrl: c.get("serverUrl", ""),
          apiToken: c.get("apiToken", ""),
          model: c.get("model", ""),
          temperature: c.get("temperature", 0.1),
          maxTokens: c.get("maxTokens", null) as number | null,
        });
        updateStatusBar();
      }
    }),
  );

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "vrlAgent.selectModel";
  updateStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("vrlAgent.generateParser", () => cmdGenerateParser(context)),
    vscode.commands.registerCommand("vrlAgent.analyzeJsonFile", (uri?: vscode.Uri) => cmdAnalyzeJsonFile(context, uri)),
    vscode.commands.registerCommand("vrlAgent.showPatternLibrary", () => cmdShowLibrary(context)),
    vscode.commands.registerCommand("vrlAgent.selectModel", cmdSelectModel),
    vscode.commands.registerCommand("vrlAgent.checkConnection", cmdCheckConnection),
    vscode.commands.registerCommand("vrlAgent.testVrl", () => cmdTestVrl(context)),
    vscode.commands.registerCommand("vrlAgent.showDebugLog", showDebugChannel),
    vscode.commands.registerCommand("vrlAgent.clearCache", cmdClearCache),
  );
}

export function deactivate(): void {
  db?.close();
}

// ── Status bar ───────────────────────────────────────────────────────────────

function updateStatusBar(): void {
  const count = db.parserCount();
  const model = getConfig().get<string>("model") || "(no model)";
  statusBarItem.text = `$(symbol-event) VRL: ${model} | ${count} parsers`;
  statusBarItem.tooltip = "Click to select model";
}

// ── Select Model (fetches from /v1/models, shows QuickPick) ─────────────────

async function cmdSelectModel(): Promise<void> {
  const serverUrl = getConfig().get<string>("serverUrl");
  if (!serverUrl) {
    vscode.window.showWarningMessage(
      "VRL Agent: Set a server URL first in Settings.",
      "Open Settings",
    ).then(choice => {
      if (choice === "Open Settings") {
        vscode.commands.executeCommand("workbench.action.openSettings", "vrlAgent.serverUrl");
      }
    });
    return;
  }

  const quickPick = vscode.window.createQuickPick();
  quickPick.title = "Select LLM Model";
  quickPick.placeholder = "Fetching models from server...";
  quickPick.busy = true;
  quickPick.show();

  try {
    const models = await llm.listModels(AbortSignal.timeout(15000));

    if (models.length === 0) {
      quickPick.dispose();
      vscode.window.showWarningMessage("No models available on the server.");
      return;
    }

    const currentModel = getConfig().get<string>("model");
    quickPick.items = models.map(m => ({
      label: m.id,
      description: `owned by: ${m.owned_by}`,
      detail: m.id === currentModel ? "(currently selected)" : undefined,
      picked: m.id === currentModel,
    }));
    quickPick.placeholder = `${models.length} models available — type to filter`;
    quickPick.busy = false;

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        await getConfig().update("model", selected.label, vscode.ConfigurationTarget.Global);
        llm.updateConfig({ model: selected.label });
        updateStatusBar();
        vscode.window.showInformationMessage(`VRL Agent: model set to ${selected.label}`);
      }
      quickPick.dispose();
    });

    quickPick.onDidHide(() => quickPick.dispose());
  } catch (e: unknown) {
    quickPick.dispose();
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Failed to fetch models: ${msg}`);
  }
}

// ── Check Connection ─────────────────────────────────────────────────────────

async function cmdCheckConnection(): Promise<void> {
  if (!getConfig().get<string>("serverUrl")) {
    vscode.window.showWarningMessage("VRL Agent: Set a server URL first.");
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "VRL Agent: checking connection..." },
    () => llm.healthCheck(),
  );

  if (result.ok) {
    vscode.window.showInformationMessage(`VRL Agent: connected. Model "${llm.currentModel}" is available.`);
  } else {
    vscode.window.showErrorMessage(`VRL Agent: ${result.error}`);
  }
}

// ── Generate Parser (from selection or full file) ────────────────────────────

async function cmdGenerateParser(context: vscode.ExtensionContext): Promise<void> {
  if (!ensureConfigured()) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor. Open a log file first.");
    return;
  }

  const selection = editor.selection;
  let input: string;
  if (!selection.isEmpty) {
    input = editor.document.getText(selection);
  } else {
    input = editor.document.getText();
  }

  input = input.trim();
  if (!input) {
    vscode.window.showWarningMessage("No text to process.");
    return;
  }

  // If input looks like JSON array/NDJSON with multiple events, offer batch mode
  if ((input.startsWith("[") || input.split("\n").filter(l => l.trim().startsWith("{")).length > 3)) {
    const choice = await vscode.window.showQuickPick(
      ["Single log line", "Batch analysis (multiple events)"],
      { placeHolder: "This looks like multiple events. How should I process it?" },
    );
    if (!choice) return;
    if (choice.startsWith("Batch")) {
      return cmdAnalyzeJsonContent(context, input);
    }
  }

  // For multi-line selection, let user choose
  const lines = input.split("\n").filter(l => l.trim());
  if (lines.length > 1) {
    const choice = await vscode.window.showQuickPick(
      [
        "Process first line as sample",
        "Process entire selection as one log message",
      ],
      { placeHolder: `Selection has ${lines.length} lines` },
    );
    if (!choice) return;
    if (choice.startsWith("Process first")) {
      input = lines[0];
    }
  }

  const panel = VrlResultPanel.show(context.extensionUri);
  const vectorPath = getVectorPath();

  panel.showLoading(`Generating VRL parser with ${llm.currentModel}...`);

  const result = await agent.processSingleLog(input, {
    vectorPath,
    onProgress: (msg) => panel.showLoading(msg),
  });

  if (result.action === "blocked") {
    panel.showError(`Blocked: ${result.message}`);
    return;
  }

  if (result.action === "error") {
    panel.showError(result.message);
    return;
  }

  // ALWAYS auto-test with Vector CLI to show the final parsed event
  let vectorOutput: string | undefined;
  let outputWarning: string | undefined;
  let validated: boolean | undefined;

  if (result.action === "cached" || result.action === "generated") {
    if (result.action === "generated" && result.vectorOutput) {
      vectorOutput = result.vectorOutput;
      validated = result.validated;
    }

    const vp = vectorPath || getConfig().get<string>("vectorPath", "vector");
    if (!vectorOutput && vp) {
      panel.showLoading("Running VRL against sample with Vector CLI...");
      const testResult = await testVrl(vp, result.vrl, input);
      if (testResult.success) {
        vectorOutput = testResult.output;
        outputWarning = testResult.outputWarning;
        validated = true;
      } else {
        validated = false;
        vectorOutput = undefined;
      }
    }
  }

  if (result.action === "cached") {
    panel.showResult({
      vrl: result.vrl,
      message: result.message,
      signature: result.signature,
      sampleLog: input,
      cached: true,
      variants: result.allVariants,
      validated,
      vectorOutput,
      outputWarning,
    });
    setupPanelCallbacks(panel, input);
    updateStatusBar();
    return;
  }

  // Generated
  panel.showResult({
    vrl: result.vrl,
    message: result.message,
    signature: result.signature,
    sampleLog: input,
    cached: false,
    validated,
    vectorOutput,
    outputWarning,
    fixAttempts: result.fixAttempts,
  });

  // Auto-save if configured
  if (getConfig().get("autoSave", false)) {
    agent.saveParser({
      signature: result.signature,
      vrlCode: result.vrl,
      sampleLog: input,
      label: "auto",
    });
    updateStatusBar();
  }

  setupPanelCallbacks(panel, input);
}

/** Wire up save + test callbacks on a result panel. */
function setupPanelCallbacks(panel: VrlResultPanel, sampleLog: string): void {
  panel.onSave = (data) => {
    agent.saveParser({
      signature: data.signature,
      vrlCode: data.vrl,
      sampleLog: data.sampleLog,
      label: data.label,
    });
    vscode.window.showInformationMessage(`Parser saved${data.label ? ` [${data.label}]` : ""}.`);
    updateStatusBar();
  };

  panel.onTestVrl = async (data) => {
    const vp = getConfig().get<string>("vectorPath", "vector");
    if (!vp) {
      vscode.window.showWarningMessage("VRL Agent: Set vectorPath in settings.");
      panel.showTestResult({ success: false, error: "vectorPath not configured" });
      return;
    }

    const result = await agent.testVrl(vp, data.vrl, data.sampleLog);

    if (result.success) {
      panel.showTestResult({ success: true, output: result.output });
    } else {
      // Ask user if they want to auto-fix
      const choice = await vscode.window.showWarningMessage(
        `VRL validation failed. Ask LLM to fix it?`,
        "Fix it", "Show error only",
      );

      if (choice === "Fix it") {
        panel.showLoading("Sending error to LLM for fix...");
        const fixResult = await agent.fixVrl(vp, data.vrl, data.sampleLog, {
          onProgress: (msg) => panel.showLoading(msg),
        });

        if (fixResult.validated) {
          vscode.window.showInformationMessage(
            `VRL fixed after ${fixResult.attempts} attempt${fixResult.attempts > 1 ? "s" : ""}!`,
          );
          // Re-show the panel with the fixed VRL
          panel.showResult({
            vrl: fixResult.vrl,
            message: `Parser fixed (${fixResult.attempts} attempt${fixResult.attempts > 1 ? "s" : ""})`,
            signature: "", // re-compute if needed
            sampleLog,
            cached: false,
            validated: true,
            vectorOutput: fixResult.vectorOutput,
            fixAttempts: fixResult.attempts,
          });
          setupPanelCallbacks(panel, sampleLog);
        } else {
          panel.showTestResult({
            success: false,
            error: `Could not fix after ${fixResult.attempts} attempts.\n\nLast error:\n${fixResult.error}`,
          });
        }
      } else {
        panel.showTestResult({ success: false, error: result.error });
      }
    }
  };

  panel.onReject = async (data) => {
    if (!ensureConfigured()) return;

    panel.showLoading(`Regenerating VRL with feedback: "${data.feedback}"...`);

    // Build a prompt that includes the current VRL, Vector output, and user feedback
    const vectorPath = getVectorPath() || getConfig().get<string>("vectorPath", "vector") || "";
    let vectorOutput = "";
    if (vectorPath) {
      const testResult = await agent.testVrl(vectorPath, data.vrl, data.sampleLog);
      if (testResult.success) {
        vectorOutput = testResult.output ?? "";
      }
    }

    const rejectPrompt = buildRejectPrompt(data.sampleLog, data.vrl, vectorOutput, data.feedback);

    try {
      const response = await (agent as any).llm.chat(rejectPrompt, []);
      const [vrl] = (await import("./injection")).validateModelOutput(response);

      // Auto-test the new result
      let newVectorOutput: string | undefined;
      let validated: boolean | undefined;
      let outputWarning: string | undefined;

      if (vectorPath) {
        const fixResult = await agent.fixVrl(vectorPath, vrl, data.sampleLog, {
          onProgress: (msg) => panel.showLoading(msg),
        });
        if (fixResult.validated) {
          newVectorOutput = fixResult.vectorOutput;
          validated = true;
        } else {
          validated = false;
        }
      }

      panel.showResult({
        vrl: validated ? (newVectorOutput ? vrl : vrl) : vrl,
        message: `Regenerated with feedback`,
        signature: "",
        sampleLog: data.sampleLog,
        cached: false,
        validated,
        vectorOutput: newVectorOutput,
      });
      setupPanelCallbacks(panel, data.sampleLog);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      panel.showError(`Retry failed: ${msg}`);
    }
  };
}

function buildRejectPrompt(sampleLog: string, currentVrl: string, vectorOutput: string, feedback: string): string {
  return `The VRL parser below compiles and runs, but the OUTPUT IS WRONG. The user rejected it.

ORIGINAL LOG MESSAGE:
${sampleLog}

CURRENT VRL PROGRAM:
\`\`\`vrl
${currentVrl}
\`\`\`

${vectorOutput ? `CURRENT VECTOR OUTPUT (what the VRL produces — THIS IS WRONG):\n${vectorOutput}\n` : ""}
USER FEEDBACK (what is wrong with the output):
${feedback}

Rewrite the VRL program to fix the issue described in the feedback.
Analyze the log message structure carefully before writing code.
Output ONLY the corrected \`\`\`vrl\`\`\` code block.`;
}

// ── Analyze JSON File ────────────────────────────────────────────────────────

async function cmdAnalyzeJsonFile(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  if (!ensureConfigured()) return;

  if (!uri) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "JSON files": ["json", "ndjson"] },
      title: "Select a JSON events file",
    });
    if (!uris || uris.length === 0) return;
    uri = uris[0];
  }

  const filePath = uri.fsPath;
  let events: unknown[];
  try {
    events = agent.loadEventsFile(filePath);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Failed to load events: ${msg}`);
    return;
  }

  if (events.length === 0) {
    vscode.window.showWarningMessage("No events found in file.");
    return;
  }

  const panel = VrlResultPanel.show(context.extensionUri);
  panel.showLoading(`Analyzing ${events.length} events from ${filePath.split("/").pop()}...`);

  try {
    const result = await agent.processBatchEvents(events, {
      vectorPath: getVectorPath(),
      onProgress: (msg) => panel.showLoading(msg),
    });

    panel.showBatchResult({
      vrl: result.vrl,
      eventCount: result.analysis.count,
      commonKeys: result.analysis.commonKeys,
      optionalKeys: result.analysis.optionalKeys,
      variantCount: result.analysis.variants.length,
      suspicious: result.suspicious,
      signature: result.signature,
      sampleEvent: JSON.stringify(events[0], null, 2),
    });

    const sampleEvent = JSON.stringify(events[0], null, 2);
    setupPanelCallbacks(panel, sampleEvent);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    panel.showError(`Failed to generate batch parser: ${msg}`);
  }
}

// ── Analyze JSON from editor content ─────────────────────────────────────────

async function cmdAnalyzeJsonContent(context: vscode.ExtensionContext, content: string): Promise<void> {
  let events: unknown[];
  try {
    if (content.trim().startsWith("[")) {
      events = JSON.parse(content);
    } else {
      events = content.split("\n")
        .map(l => l.trim())
        .filter(l => l)
        .map(l => JSON.parse(l));
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`Failed to parse events: ${msg}`);
    return;
  }

  if (events.length === 0) {
    vscode.window.showWarningMessage("No events found in selection.");
    return;
  }

  const panel = VrlResultPanel.show(context.extensionUri);
  panel.showLoading(`Analyzing ${events.length} events...`);

  try {
    const result = await agent.processBatchEvents(events, {
      vectorPath: getVectorPath(),
      onProgress: (msg) => panel.showLoading(msg),
    });

    panel.showBatchResult({
      vrl: result.vrl,
      eventCount: result.analysis.count,
      commonKeys: result.analysis.commonKeys,
      optionalKeys: result.analysis.optionalKeys,
      variantCount: result.analysis.variants.length,
      suspicious: result.suspicious,
      signature: result.signature,
      sampleEvent: JSON.stringify(events[0], null, 2),
    });

    const sampleEvent = JSON.stringify(events[0], null, 2);
    setupPanelCallbacks(panel, sampleEvent);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    panel.showError(`Failed to generate batch parser: ${msg}`);
  }
}

// ── Test VRL (standalone command) ────────────────────────────────────────────

async function cmdTestVrl(context: vscode.ExtensionContext): Promise<void> {
  const vp = getConfig().get<string>("vectorPath", "vector");
  if (!vp) {
    vscode.window.showWarningMessage("VRL Agent: Set vectorPath in settings.");
    return;
  }

  // Check vector is installed
  const check = await checkVectorInstall(vp);
  if (!check.ok) {
    vscode.window.showErrorMessage(`Vector CLI: ${check.error}`);
    return;
  }

  // Get VRL from active editor
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Open a file with VRL code first.");
    return;
  }

  const vrlCode = editor.selection.isEmpty
    ? editor.document.getText()
    : editor.document.getText(editor.selection);

  if (!vrlCode.trim()) {
    vscode.window.showWarningMessage("No VRL code to test.");
    return;
  }

  // Ask for sample log
  const sampleLog = await vscode.window.showInputBox({
    prompt: "Paste a sample log message to test against",
    placeHolder: 'e.g. {"message": "Mar 31 12:00:00 host app: test"}',
  });
  if (!sampleLog) return;

  const panel = VrlResultPanel.show(context.extensionUri);
  panel.showLoading("Testing VRL with Vector CLI...");

  const result = await agent.testVrl(vp, vrlCode.trim(), sampleLog);

  if (result.success) {
    panel.showResult({
      vrl: vrlCode.trim(),
      message: "VRL test passed",
      signature: "",
      sampleLog,
      cached: false,
      validated: true,
      vectorOutput: result.output,
    });
  } else {
    panel.showResult({
      vrl: vrlCode.trim(),
      message: "VRL test failed",
      signature: "",
      sampleLog,
      cached: false,
      validated: false,
    });
    panel.showTestResult({ success: false, error: result.error });
  }

  setupPanelCallbacks(panel, sampleLog);
}

// ── Show Pattern Library ─────────────────────────────────────────────────────

function cmdShowLibrary(context: vscode.ExtensionContext): void {
  const parsers = db.listParsers();
  const panel = VrlResultPanel.show(context.extensionUri);
  panel.showLibrary(parsers);
}

// ── Clear Cache ──────────────────────────────────────────────────────────────

async function cmdClearCache(): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    "Delete all saved parsers and sources?",
    { modal: true },
    "Delete All",
  );
  if (answer === "Delete All") {
    db.clearAll();
    updateStatusBar();
    vscode.window.showInformationMessage("Pattern library cleared.");
  }
}

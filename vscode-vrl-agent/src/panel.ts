/**
 * Webview panel for displaying VRL parser results.
 */

import * as vscode from "vscode";
import { Parser } from "./db";

export class VrlResultPanel {
  private static currentPanel: VrlResultPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  // Callbacks from webview
  public onSave?: (data: { signature: string; vrl: string; sampleLog: string; label: string }) => void;
  public onTestVrl?: (data: { vrl: string; sampleLog: string }) => void;
  public onReject?: (data: { vrl: string; sampleLog: string; feedback: string }) => void;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg.command === "save" && this.onSave) {
          this.onSave(msg.data);
        }
        if (msg.command === "testVrl" && this.onTestVrl) {
          this.onTestVrl(msg.data);
        }
        if (msg.command === "copy") {
          vscode.env.clipboard.writeText(msg.text);
          vscode.window.showInformationMessage("VRL code copied to clipboard.");
        }
        if (msg.command === "openInEditor") {
          const doc = vscode.workspace.openTextDocument({ content: msg.text, language: "rust" });
          doc.then(d => vscode.window.showTextDocument(d, vscode.ViewColumn.Beside));
        }
        if (msg.command === "showDebug") {
          vscode.commands.executeCommand("vrlAgent.showDebugLog");
        }
        if (msg.command === "reject" && this.onReject) {
          this.onReject(msg.data);
        }
      },
      null,
      this.disposables,
    );
  }

  static show(extensionUri: vscode.Uri): VrlResultPanel {
    if (VrlResultPanel.currentPanel) {
      VrlResultPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      // Clear stale callbacks from previous result
      VrlResultPanel.currentPanel.onSave = undefined;
      VrlResultPanel.currentPanel.onTestVrl = undefined;
      VrlResultPanel.currentPanel.onReject = undefined;
      return VrlResultPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "vrlResult",
      "VRL Parser Result",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    VrlResultPanel.currentPanel = new VrlResultPanel(panel);
    return VrlResultPanel.currentPanel;
  }

  // ── Content setters ──────────────────────────────────────────

  showLoading(message: string): void {
    this.panel.webview.html = this.buildHtml(`
      <div class="loading">
        <div class="spinner"></div>
        <p>${escapeHtml(message)}</p>
      </div>
    `);
  }

  showResult(opts: {
    vrl: string;
    message: string;
    signature: string;
    sampleLog: string;
    cached: boolean;
    variants?: Parser[];
    validated?: boolean;
    vectorOutput?: string;
    outputWarning?: string;
    fixAttempts?: number;
  }): void {
    const variantsHtml = opts.variants && opts.variants.length > 1
      ? `<div class="variants">
           <h3>Other variants (${opts.variants.length - 1})</h3>
           ${opts.variants.slice(1).map(v => `
             <details>
               <summary>${escapeHtml(v.variant)}${v.label ? ` — ${escapeHtml(v.label)}` : ""} (${v.hits} hits)</summary>
               <pre><code>${escapeHtml(v.vrl_code)}</code></pre>
             </details>
           `).join("")}
         </div>`
      : "";

    const saveButton = opts.cached
      ? ""
      : `<div class="save-section">
           <input type="text" id="label" placeholder="Label (optional, e.g. nginx-access)" />
           <button id="saveBtn">Save to Pattern Library</button>
         </div>`;

    const validationHtml = opts.validated === true
      ? `<div class="validation valid">&#9989; Validated with Vector CLI${opts.fixAttempts ? ` (fixed after ${opts.fixAttempts} attempt${opts.fixAttempts > 1 ? "s" : ""})` : ""}</div>`
      : opts.validated === false
        ? `<div class="validation invalid">&#10060; Vector validation failed${opts.fixAttempts ? ` after ${opts.fixAttempts} fix attempt${opts.fixAttempts > 1 ? "s" : ""}` : ""}</div>`
        : "";

    const warningHtml = opts.outputWarning
      ? `<div class="warning">${escapeHtml(opts.outputWarning)}</div>`
      : "";

    const rejectHtml = !opts.cached
      ? `<div class="reject-section">
           <input type="text" id="feedback" placeholder="What's wrong? e.g. 'timestamp not parsed', 'missing severity field'" />
           <button id="rejectBtn">Reject &amp; Retry</button>
         </div>`
      : "";

    let vectorOutputHtml: string;
    if (opts.vectorOutput) {
      vectorOutputHtml = `<div class="vector-output">
        <h3>Parsed Event Output</h3>
        <p class="hint">This is the final structured event after VRL processing:</p>
        ${warningHtml}
        <pre><code>${escapeHtml(opts.vectorOutput)}</code></pre>
        ${rejectHtml}
      </div>`;
    } else if (opts.validated === false) {
      vectorOutputHtml = `<div class="vector-output-missing">
        <h3>Vector Validation Failed</h3>
        <p>The VRL program did not compile or produced an error. Check the debug log for details.</p>
        <button id="debugBtnTop">Show Debug Log</button>
      </div>`;
    } else {
      vectorOutputHtml = `<div class="vector-output-na">
        <p><em>Vector CLI not configured — set <code>vrlAgent.vectorPath</code> in settings to see parsed event output.</em></p>
      </div>`;
    }

    // Extract model's expected output structure and analysis from VRL comments
    const commentLines = opts.vrl.split("\n")
      .filter(l => l.trim().startsWith("#"))
      .map(l => l.trim().replace(/^#\s*/, ""));

    // Separate expected structure (JSON-like block) from analysis text
    let expectedStructure = "";
    const analysisOnly: string[] = [];
    let inStructure = false;
    for (const line of commentLines) {
      if (line.startsWith("Expected output structure:") || line.startsWith("{")) {
        inStructure = true;
      }
      if (inStructure) {
        // Collect lines that look like JSON
        if (line.startsWith("{") || line.startsWith("}") || line.startsWith('"') || line === "" || line.includes(":")) {
          expectedStructure += line + "\n";
        }
        if (line.startsWith("}")) {
          inStructure = false;
        }
      } else if (!line.startsWith("Expected output")) {
        analysisOnly.push(line);
      }
    }
    const analysisText = analysisOnly.filter(l => l).join("\n") || "No analysis comments found.";

    // Parse input event structure
    const inputStructure = buildInputStructure(opts.sampleLog);

    // Build the structure panel
    const expectedHtml = expectedStructure.trim()
      ? `<div class="structure-col">
          <h4>Expected Parsed Event</h4>
          <pre class="expected-json">${escapeHtml(expectedStructure.trim())}</pre>
        </div>`
      : "";

    const structureHtml = `<div class="structure-panel">
      <h3>Structure Analysis</h3>
      <div class="structure-grid${expectedStructure.trim() ? " three-col" : ""}">
        <div class="structure-col">
          <h4>Input Event Fields</h4>
          <div class="field-list">${inputStructure}</div>
        </div>
        ${expectedHtml}
        <div class="structure-col">
          <h4>Model's Strategy</h4>
          <pre class="analysis-text">${escapeHtml(analysisText)}</pre>
        </div>
      </div>
    </div>`;

    this.panel.webview.html = this.buildHtml(`
      <div class="status ${opts.cached ? "cached" : "generated"}">
        ${opts.cached ? "&#9889;" : "&#10024;"} ${escapeHtml(opts.message)}
      </div>
      ${validationHtml}
      <div class="signature">Signature: <code>${escapeHtml(opts.signature)}</code></div>

      ${structureHtml}

      <div class="vrl-section">
        <div class="toolbar">
          <button id="copyBtn" title="Copy to clipboard">Copy</button>
          <button id="openBtn" title="Open in editor tab">Open in Editor</button>
          <button id="testBtn" title="Test with Vector CLI">Test VRL</button>
        </div>
        <pre><code id="vrlCode">${escapeHtml(opts.vrl)}</code></pre>
      </div>

      ${vectorOutputHtml}
      ${saveButton}
      ${variantsHtml}

      <details class="sample">
        <summary>Raw input</summary>
        <pre><code>${escapeHtml(opts.sampleLog.slice(0, 500))}</code></pre>
      </details>

      <div id="testResultArea"></div>

      <script>
        const vscode = acquireVsCodeApi();
        const vrlCode = document.getElementById('vrlCode').textContent;

        document.getElementById('copyBtn')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'copy', text: vrlCode });
        });
        document.getElementById('openBtn')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'openInEditor', text: vrlCode });
        });
        document.getElementById('debugBtnTop')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'showDebug' });
        });
        document.getElementById('testBtn')?.addEventListener('click', () => {
          document.getElementById('testBtn').textContent = 'Testing...';
          document.getElementById('testBtn').disabled = true;
          vscode.postMessage({
            command: 'testVrl',
            data: {
              vrl: vrlCode,
              sampleLog: ${JSON.stringify(opts.sampleLog.slice(0, 5000))},
            },
          });
        });

        // Listen for test results from extension
        window.addEventListener('message', (event) => {
          const msg = event.data;
          if (msg.command === 'testResult') {
            const area = document.getElementById('testResultArea');
            const btn = document.getElementById('testBtn');
            if (btn) { btn.textContent = 'Test VRL'; btn.disabled = false; }
            if (!area) return;
            const esc = (s) => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            if (msg.success) {
              area.innerHTML = '<div class="test-result success"><h3>&#9989; Vector output:</h3><pre><code>'
                + esc(msg.output) + '</code></pre></div>';
            } else {
              area.innerHTML = '<div class="test-result failure"><h3>&#10060; Vector error:</h3><pre><code>'
                + esc(msg.error)
                + '</code></pre><button id="debugBtn">Show Debug Log</button></div>';
              document.getElementById('debugBtn')?.addEventListener('click', () => {
                vscode.postMessage({ command: 'showDebug' });
              });
            }
          }
        });
        document.getElementById('saveBtn')?.addEventListener('click', () => {
          const label = document.getElementById('label')?.value || '';
          vscode.postMessage({
            command: 'save',
            data: {
              signature: ${JSON.stringify(opts.signature)},
              vrl: vrlCode,
              sampleLog: ${JSON.stringify(opts.sampleLog.slice(0, 2000))},
              label,
            },
          });
          document.getElementById('saveBtn').textContent = 'Saved!';
          document.getElementById('saveBtn').disabled = true;
        });

        document.getElementById('rejectBtn')?.addEventListener('click', () => {
          const feedback = document.getElementById('feedback')?.value || 'Output is incorrect';
          document.getElementById('rejectBtn').textContent = 'Retrying...';
          document.getElementById('rejectBtn').disabled = true;
          vscode.postMessage({
            command: 'reject',
            data: {
              vrl: vrlCode,
              sampleLog: ${JSON.stringify(opts.sampleLog.slice(0, 5000))},
              feedback: feedback,
            },
          });
        });
      </script>
    `);
  }

  showBatchResult(opts: {
    vrl: string;
    eventCount: number;
    commonKeys: string[];
    optionalKeys: string[];
    variantCount: number;
    suspicious: boolean;
    signature: string;
    sampleEvent: string;
  }): void {
    this.panel.webview.html = this.buildHtml(`
      <div class="status generated">
        &#128202; Batch analysis — ${opts.eventCount} events, ${opts.variantCount} variant(s)
      </div>
      ${opts.suspicious ? '<div class="warning">&#9888; Model response may be off-task</div>' : ""}

      <div class="analysis">
        <p><strong>Common keys:</strong> <code>${escapeHtml(opts.commonKeys.join(", "))}</code></p>
        ${opts.optionalKeys.length > 0
          ? `<p><strong>Optional keys:</strong> <code>${escapeHtml(opts.optionalKeys.join(", "))}</code></p>`
          : ""}
      </div>

      <div class="vrl-section">
        <div class="toolbar">
          <button id="copyBtn">Copy</button>
          <button id="openBtn">Open in Editor</button>
        </div>
        <pre><code id="vrlCode">${escapeHtml(opts.vrl)}</code></pre>
      </div>

      <div class="save-section">
        <input type="text" id="label" placeholder="Label (e.g. app-events-batch)" />
        <button id="saveBtn">Save to Pattern Library</button>
      </div>

      <script>
        const vscode = acquireVsCodeApi();
        const vrlCode = document.getElementById('vrlCode').textContent;

        document.getElementById('copyBtn')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'copy', text: vrlCode });
        });
        document.getElementById('openBtn')?.addEventListener('click', () => {
          vscode.postMessage({ command: 'openInEditor', text: vrlCode });
        });
        document.getElementById('saveBtn')?.addEventListener('click', () => {
          const label = document.getElementById('label')?.value || '';
          vscode.postMessage({
            command: 'save',
            data: {
              signature: ${JSON.stringify(opts.signature)},
              vrl: vrlCode,
              sampleLog: ${JSON.stringify(opts.sampleEvent.slice(0, 2000))},
              label,
            },
          });
          document.getElementById('saveBtn').textContent = 'Saved!';
          document.getElementById('saveBtn').disabled = true;
        });
      </script>
    `);
  }

  showLibrary(parsers: Parser[]): void {
    const rows = parsers.map(p => `
      <tr>
        <td>${p.id}</td>
        <td>${p.hits}</td>
        <td>${escapeHtml(p.variant)}</td>
        <td>${escapeHtml(p.label || "-")}</td>
        <td>${escapeHtml(p.ocsf_class || "-")}</td>
        <td>${escapeHtml(p.source_name || "-")}</td>
        <td><code>${escapeHtml(p.sample_log?.slice(0, 60) || "")}</code></td>
      </tr>
    `).join("");

    this.panel.webview.html = this.buildHtml(`
      <h2>Pattern Library (${parsers.length} parsers)</h2>
      ${parsers.length === 0
        ? "<p>No saved parsers yet. Generate a parser and click Save.</p>"
        : `<table>
            <thead><tr>
              <th>ID</th><th>Hits</th><th>Variant</th><th>Label</th><th>OCSF</th><th>Source</th><th>Sample</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    `);
  }

  showTestResult(result: { success: boolean; output?: string; error?: string }): void {
    // Post a message to the webview to update the test result area
    // Since we can't easily update partial HTML, we'll replace the full content
    // with the test result appended. Use postMessage approach instead.
    this.panel.webview.postMessage({
      command: "testResult",
      ...result,
    });
  }

  showError(message: string): void {
    this.panel.webview.html = this.buildHtml(`
      <div class="error">&#10060; ${escapeHtml(message)}</div>
    `);
  }

  // ── Internals ────────────────────────────────────────────────

  private buildHtml(body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-textLink-foreground);
      --code-bg: var(--vscode-textCodeBlock-background);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
    }
    body { font-family: var(--vscode-font-family); color: var(--fg); padding: 16px; line-height: 1.5; }
    h2, h3 { margin: 12px 0 8px; }
    code { background: var(--code-bg); padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
    pre { background: var(--code-bg); padding: 12px; border-radius: 6px; overflow-x: auto; }
    pre code { padding: 0; background: none; }

    .status { padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-weight: 600; }
    .status.cached { background: rgba(0,180,0,0.1); border-left: 3px solid #0b0; }
    .status.generated { background: rgba(0,120,255,0.1); border-left: 3px solid #08f; }
    .warning { padding: 8px 12px; background: rgba(255,200,0,0.15); border-left: 3px solid #fa0; margin-bottom: 12px; }
    .error { padding: 12px; background: rgba(255,60,60,0.1); border-left: 3px solid #f44; }
    .signature { font-size: 0.85em; opacity: 0.7; margin-bottom: 12px; }

    .toolbar { display: flex; gap: 8px; margin-bottom: 4px; }
    button {
      background: var(--btn-bg); color: var(--btn-fg); border: none;
      padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.85em;
    }
    button:hover { background: var(--btn-hover); }
    button:disabled { opacity: 0.5; cursor: default; }

    input[type="text"] {
      background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border);
      padding: 4px 8px; border-radius: 4px; font-size: 0.9em; width: 250px;
    }
    .save-section { display: flex; gap: 8px; align-items: center; margin: 12px 0; }

    .variants { margin-top: 16px; }
    details { margin: 4px 0; }
    summary { cursor: pointer; padding: 4px 0; }

    table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
    th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--border); }
    th { font-weight: 600; }

    .loading { text-align: center; padding: 40px; }
    .spinner {
      width: 32px; height: 32px; margin: 0 auto 12px;
      border: 3px solid var(--border); border-top-color: var(--accent);
      border-radius: 50%; animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .analysis { margin-bottom: 12px; }

    .validation { padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-weight: 600; }
    .validation.valid { background: rgba(0,180,0,0.1); border-left: 3px solid #0b0; }
    .validation.invalid { background: rgba(255,60,60,0.1); border-left: 3px solid #f44; }

    .vector-output { margin: 16px 0; padding: 12px; background: rgba(0,180,0,0.05); border: 1px solid rgba(0,180,0,0.2); border-radius: 6px; }
    .vector-output h3 { margin: 0 0 8px; color: #0b0; }
    .vector-output pre { border-left: 3px solid #0b0; margin: 0; }
    .vector-output .hint { font-size: 0.85em; opacity: 0.7; margin: 0 0 8px; }
    .vector-output-missing { margin: 12px 0; padding: 12px; background: rgba(255,60,60,0.05); border: 1px solid rgba(255,60,60,0.2); border-radius: 6px; }
    .vector-output-missing h3 { margin: 0 0 8px; color: #f44; }
    .vector-output-na { margin: 12px 0; opacity: 0.6; }
    .reject-section { display: flex; gap: 8px; align-items: center; margin: 12px 0 0; }
    .reject-section input { flex: 1; }
    .reject-section button { background: rgba(255,100,0,0.8); }

    .structure-panel { margin: 12px 0; padding: 12px; background: rgba(100,100,255,0.05); border: 1px solid rgba(100,100,255,0.15); border-radius: 6px; }
    .structure-panel h3 { margin: 0 0 10px; font-size: 1em; }
    .structure-panel h4 { margin: 0 0 6px; font-size: 0.9em; opacity: 0.8; }
    .structure-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .structure-grid.three-col { grid-template-columns: 1fr 1fr 1fr; }
    @media (max-width: 800px) { .structure-grid, .structure-grid.three-col { grid-template-columns: 1fr; } }
    .structure-col { min-width: 0; }
    .field-list { font-size: 0.85em; }
    .field-row { padding: 4px 0; border-bottom: 1px solid var(--border); }
    .field-name { font-weight: 600; color: var(--accent); margin-right: 6px; }
    .field-type { font-size: 0.8em; padding: 1px 5px; border-radius: 3px; background: rgba(128,128,128,0.15); margin-right: 4px; }
    .field-hint { font-size: 0.8em; color: #f80; font-style: italic; }
    .field-preview { font-size: 0.8em; opacity: 0.6; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .analysis-text { font-size: 0.85em; white-space: pre-wrap; margin: 0; background: transparent; padding: 4px; }
    .expected-json { font-size: 0.85em; white-space: pre-wrap; margin: 0; padding: 8px; background: rgba(0,180,0,0.05); border-left: 3px solid rgba(0,180,0,0.3); border-radius: 4px; }
    .test-result { margin-top: 12px; }
    .test-result.success { padding: 12px; background: rgba(0,180,0,0.05); border: 1px solid rgba(0,180,0,0.2); border-radius: 6px; }
    .test-result.success h3 { color: #0b0; }
    .test-result.success pre { border-left: 3px solid #0b0; }
    .test-result.failure pre { border-left: 3px solid #f44; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
  }

  private dispose(): void {
    VrlResultPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function buildInputStructure(sampleLog: string): string {
  try {
    const parsed = JSON.parse(sampleLog);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const rows = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
        const type = value === null ? "null"
          : Array.isArray(value) ? "array"
          : typeof value === "object" ? "object"
          : typeof value;
        const preview = typeof value === "string"
          ? (value.length > 80 ? value.slice(0, 80) + "..." : value)
          : JSON.stringify(value)?.slice(0, 80) ?? "null";

        // Detect if this field likely needs parsing
        let hint = "";
        if (typeof value === "string") {
          const v = value.trim();
          if (v.startsWith("{") || v.startsWith("[")) hint = " → JSON string, needs parse_json!";
          else if (v.match(/^<\d+>/)) hint = " → syslog, needs parse_syslog!";
          else if (v.includes("=") && v.includes(" ")) hint = " → likely key-value pairs";
          else if (v.includes(",") && !v.includes("=")) hint = " → possibly CSV";
          else if (v.match(/^\d{4}-\d{2}-\d{2}/)) hint = " → timestamp string";
          else if (v.length > 50) hint = " → long string, may need parsing";
        }

        const hintHtml = hint ? `<span class="field-hint">${escapeHtml(hint)}</span>` : "";
        return `<div class="field-row">
          <span class="field-name">.${escapeHtml(key)}</span>
          <span class="field-type">${escapeHtml(type)}</span>
          ${hintHtml}
          <div class="field-preview">${escapeHtml(preview)}</div>
        </div>`;
      });
      return rows.join("");
    }
  } catch {
    // Not JSON
  }
  // Fallback for non-JSON input
  return `<div class="field-row">
    <span class="field-name">.message</span>
    <span class="field-type">string</span>
    <div class="field-preview">${escapeHtml(sampleLog.slice(0, 120))}</div>
  </div>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

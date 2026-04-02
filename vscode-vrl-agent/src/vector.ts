/**
 * Vector CLI integration — validate VRL programs and show parsed output.
 *
 * Uses `vector vrl` subcommand:
 *   vector vrl --input events.json --program parser.vrl --print-object
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

/** Strip ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
  // Covers: CSI sequences, OSC sequences, simple escapes
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
          .replace(/\x1b\][^\x07]*\x07/g, "")
          .replace(/\x1b[^[\]()][^\x1b]*/g, "");
}

// ── Debug output channel (lazy-init) ─────────────────────────────────────────

let _channel: vscode.OutputChannel | undefined;

function log(msg: string): void {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel("VRL Agent");
  }
  const ts = new Date().toISOString().slice(11, 23);
  _channel.appendLine(`[${ts}] ${msg}`);
}

/** Show the debug output channel to the user. */
export function showDebugChannel(): void {
  _channel?.show(true);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface VrlTestResult {
  success: boolean;
  /** Parsed output object (JSON string) when successful */
  output?: string;
  /** Warning about output quality (e.g. no new fields extracted) */
  outputWarning?: string;
  /** Error message from Vector when VRL fails */
  error?: string;
  /** Raw stderr */
  stderr?: string;
  /** Exit code */
  exitCode: number;
  /** Debug info for troubleshooting */
  debug: {
    command: string;
    inputFile: string;
    inputContent: string;
    vrlFile: string;
    vrlContent: string;
    stdout: string;
    stderr: string;
  };
}

/**
 * Test a VRL program against a sample log line using the Vector CLI.
 */
export async function testVrl(
  vectorPath: string,
  vrlCode: string,
  sampleLog: string,
  timeoutMs: number = 15000,
): Promise<VrlTestResult> {
  const tmpDir = os.tmpdir();
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const vrlFile = path.join(tmpDir, `vrl-agent-${ts}.vrl`);
  const inputFile = path.join(tmpDir, `vrl-agent-input-${ts}.json`);

  // Prepare input event — pass through as-is if already JSON object, wrap in .message otherwise
  let inputEvent: string;
  try {
    const parsed = JSON.parse(sampleLog);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      // Already a JSON object — use as-is without adding redundant .message
      inputEvent = JSON.stringify(parsed);
    } else {
      inputEvent = JSON.stringify({ message: sampleLog });
    }
  } catch {
    // Raw log line — wrap in {"message": "..."}
    inputEvent = JSON.stringify({ message: sampleLog });
  }

  // Write temp files
  fs.writeFileSync(vrlFile, vrlCode, "utf-8");
  // Input must be NDJSON (one JSON object per line, with trailing newline)
  fs.writeFileSync(inputFile, inputEvent + "\n", "utf-8");

  const args = ["vrl", "--input", inputFile, "--program", vrlFile, "--print-object"];
  const cmdString = `${vectorPath} ${args.join(" ")}`;

  const debugInfo = {
    command: cmdString,
    inputFile,
    inputContent: inputEvent,
    vrlFile,
    vrlContent: vrlCode,
    stdout: "",
    stderr: "",
  };

  log("─".repeat(60));
  log(`COMMAND: ${cmdString}`);
  log(`INPUT FILE: ${inputFile}`);
  log(`INPUT CONTENT:\n${inputEvent}`);
  log(`VRL FILE: ${vrlFile}`);
  log(`VRL CONTENT:\n${vrlCode}`);

  try {
    const { stdout, stderr } = await execFileAsync(vectorPath, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024, // 1MB
      env: {
        ...process.env,
        RUST_LOG: "error",
        NO_COLOR: "1",
        TERM: "dumb",
        CLICOLOR: "0",
        CLICOLOR_FORCE: "0",
      },
    });

    const cleanStdout = stripAnsi(stdout);
    const cleanStderr = stripAnsi(stderr);
    debugInfo.stdout = cleanStdout;
    debugInfo.stderr = cleanStderr;

    log(`EXIT: 0`);
    log(`STDOUT:\n${cleanStdout}`);
    if (cleanStderr.trim()) {
      log(`STDERR:\n${cleanStderr}`);
    }

    // Filter out Vector's own log lines (INFO, WARN, DEBUG) from stderr
    const stderrLines = cleanStderr.trim().split("\n").filter(
      l => !l.match(/^\d{4}-\d{2}-\d{2}T\S+\s+(INFO|WARN|DEBUG)\s/)
    );
    const realStderr = stderrLines.join("\n").trim();

    // Check for actual runtime errors — use specific Vector error patterns
    if (realStderr && (
      realStderr.includes("function call error") ||
      realStderr.includes("runtime error") ||
      realStderr.includes("error[E") ||
      realStderr.match(/^error\b/m)
    )) {
      log(`RESULT: RUNTIME ERROR in stderr despite exit 0`);
      log(`STDERR ERRORS:\n${realStderr}`);
      return {
        success: false,
        error: `Runtime error: ${realStderr}`,
        stderr: realStderr,
        exitCode: 0,
        debug: debugInfo,
      };
    }

    const outputTrimmed = cleanStdout.trim();

    // Check if stdout is empty — means VRL produced no output
    if (!outputTrimmed) {
      log(`RESULT: FAILED — empty output (VRL may have aborted)`);
      return {
        success: false,
        error: "VRL produced empty output — the program may have aborted or the input didn't match.",
        stderr: realStderr || undefined,
        exitCode: 0,
        debug: debugInfo,
      };
    }

    // Validate output quality
    const qualityCheck = validateOutputQuality(inputEvent, outputTrimmed);
    if (qualityCheck) {
      log(`RESULT: VRL ran but output quality warning: ${qualityCheck}`);
    } else {
      log(`RESULT: VRL PARSED OK`);
    }

    return {
      success: true,
      output: outputTrimmed,
      outputWarning: qualityCheck ?? undefined,
      stderr: realStderr || undefined,
      exitCode: 0,
      debug: debugInfo,
    };
  } catch (err: unknown) {
    const e = err as {
      code?: string;
      exitCode?: number;
      status?: number;
      stderr?: string;
      stdout?: string;
      message?: string;
      killed?: boolean;
      signal?: string;
    };

    debugInfo.stdout = stripAnsi(e.stdout?.trim() ?? "");
    debugInfo.stderr = stripAnsi(e.stderr?.trim() ?? "");

    const exitCode = e.exitCode ?? e.status ?? 1;

    log(`EXIT: ${exitCode}${e.signal ? ` (signal: ${e.signal})` : ""}${e.killed ? " (killed/timeout)" : ""}`);
    if (debugInfo.stdout) log(`STDOUT:\n${debugInfo.stdout}`);
    if (debugInfo.stderr) log(`STDERR:\n${debugInfo.stderr}`);
    if (e.message && !e.stderr) log(`ERROR MESSAGE:\n${stripAnsi(e.message)}`);

    if (e.code === "ENOENT") {
      const msg = `Vector binary not found at: ${vectorPath}`;
      log(`RESULT: ENOENT — ${msg}`);
      return { success: false, error: msg, exitCode: -1, debug: debugInfo };
    }

    if (e.killed || e.signal === "SIGTERM") {
      const msg = `Vector timed out after ${timeoutMs}ms`;
      log(`RESULT: TIMEOUT`);
      return { success: false, error: msg, exitCode: -2, debug: debugInfo };
    }

    const stderr = debugInfo.stderr;
    const stdout = debugInfo.stdout;
    const errorMsg = stderr || stdout || stripAnsi(e.message ?? "") || "Unknown error";

    log(`RESULT: FAILED — ${errorMsg.slice(0, 200)}`);

    return {
      success: false,
      error: errorMsg,
      stderr,
      exitCode,
      debug: debugInfo,
    };
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(vrlFile); } catch { /* ignore */ }
    try { fs.unlinkSync(inputFile); } catch { /* ignore */ }
  }
}

/**
 * Check if the vector binary exists and is executable.
 */
export async function checkVectorInstall(vectorPath: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  log(`Checking Vector install: ${vectorPath}`);
  try {
    const { stdout } = await execFileAsync(vectorPath, ["--version"], { timeout: 5000 });
    const version = stdout.trim();
    log(`Vector version: ${version}`);
    return { ok: true, version };
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    const msg = e.code === "ENOENT"
      ? `Vector binary not found at: ${vectorPath}`
      : (e.message || "Unknown error");
    log(`Vector check failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

// ── Output quality validation ────────────────────────────────────────────────

/**
 * Check if the VRL output actually parsed something meaningful.
 * Returns a warning string if the output looks like it didn't parse, or null if OK.
 */
function validateOutputQuality(inputJson: string, outputStr: string): string | null {
  if (!outputStr) return "Output is empty";

  let inputObj: Record<string, unknown>;
  let outputObj: Record<string, unknown>;
  try {
    inputObj = JSON.parse(inputJson);
  } catch {
    return null; // Input wasn't JSON — can't compare
  }
  try {
    // Vector output uses non-standard syntax like t'timestamp' — normalize for parsing
    const normalized = outputStr
      .replace(/t'[^']*'/g, '"__timestamp__"')
      .replace(/r'[^']*'/g, '"__regex__"');
    outputObj = JSON.parse(normalized);
  } catch {
    return null; // Vector output isn't parseable — not a structural problem
  }

  const inputKeys = new Set(Object.keys(inputObj));
  const outputKeys = new Set(Object.keys(outputObj));

  // If output has ONLY the same keys as input, parsing didn't extract anything
  const newKeys = [...outputKeys].filter(k => !inputKeys.has(k));
  if (newKeys.length === 0 && outputKeys.size <= inputKeys.size) {
    return "Output has no new fields compared to input — VRL may not have parsed the message. The .message field might still be raw/unparsed.";
  }

  // If .message is still the only real field
  if (outputObj.message && outputKeys.size <= 2) {
    return "Output only has 'message' field — VRL did not extract structured fields from the log.";
  }

  return null;
}

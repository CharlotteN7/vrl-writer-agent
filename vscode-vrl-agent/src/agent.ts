/**
 * Core agent logic — process single log lines, batch event files,
 * and VRL validation with auto-fix retry loop.
 */

import * as fs from "fs";
import { PatternDB, Parser } from "./db";
import { checkInjection, sanitizeInput, validateModelOutput } from "./injection";
import { LlmClient, ChatMessage } from "./ollama";
import { buildBatchPrompt } from "./prompts";
import { computeSignature } from "./signatures";
import { testVrl, VrlTestResult } from "./vector";
import { lintVrl, formatLintIssues } from "./vrl-lint";
import { generateVrl, StructureDescription } from "./vrl-gen";

// ── Result types ─────────────────────────────────────────────────────────────

export type ProcessResult =
  | { action: "blocked"; message: string }
  | { action: "error"; message: string }
  | { action: "cached"; vrl: string; message: string; parserId: number; signature: string; allVariants: Parser[] }
  | { action: "generated"; vrl: string; message: string; signature: string; rawResponse: string; validated?: boolean; vectorOutput?: string; fixAttempts?: number };

export interface BatchAnalysis {
  count: number;
  commonKeys: string[];
  optionalKeys: string[];
  typeDistribution: Record<string, Record<string, number>>;
  variants: Array<{ keys: string[]; count: number }>;
}

export interface BatchResult {
  analysis: BatchAnalysis;
  vrl: string;
  suspicious: boolean;
  signature: string;
  validated?: boolean;
  vectorOutput?: string;
  fixAttempts?: number;
}

// ── Agent ────────────────────────────────────────────────────────────────────

const MAX_FIX_ATTEMPTS = 10;

export class VrlAgent {
  private history: ChatMessage[] = [];

  constructor(
    private llm: LlmClient,
    private db: PatternDB,
  ) {}

  /**
   * Process a single log line — check cache, then call LLM if needed.
   * If vectorPath is provided, validates with Vector CLI and retries on failure.
   */
  async processSingleLog(
    raw: string,
    opts?: { vectorPath?: string; signal?: AbortSignal; onProgress?: (msg: string) => void },
  ): Promise<ProcessResult> {
    const { vectorPath, signal, onProgress } = opts ?? {};

    // Clear stale history from previous unrelated generations
    this.history = [];

    const cleaned = sanitizeInput(raw);
    if (!cleaned) {
      return { action: "error", message: "Empty input." };
    }

    const injection = checkInjection(cleaned);
    if (injection) {
      return { action: "blocked", message: `Injection detected: ${injection}` };
    }

    const sig = computeSignature(cleaned);
    const cached = this.db.lookupParsers(sig);
    if (cached.length > 0) {
      const top = cached[0];
      const label = top.label ? ` [${top.label}]` : "";
      const variantInfo = cached.length > 1 ? ` (${cached.length} variants)` : "";
      return {
        action: "cached",
        vrl: top.vrl_code,
        message: `Cache hit: parser #${top.id}${label}${variantInfo} (used ${top.hits}x)`,
        parserId: top.id,
        signature: sig,
        allVariants: cached,
      };
    }

    // Generate + validate + retry loop
    let vrl: string;
    let rawResponse: string;
    let suspicious: boolean;
    let validated = false;
    let vectorOutput: string | undefined;
    let fixAttempts = 0;
    let lastError: string | undefined;

    // Initial generation
    onProgress?.(`Generating VRL parser...`);
    try {
      rawResponse = await this.llm.chat(cleaned, this.history, signal);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { action: "error", message: msg };
    }

    // Try Mode 1 (JSON structure description → template VRL) first
    const generated = this.tryGenerateFromDescription(rawResponse);
    if (generated) {
      vrl = generated;
      suspicious = false;
    } else {
      // Mode 2: extract raw VRL from model output
      [vrl, suspicious] = validateModelOutput(rawResponse);
    }

    // Validate: first static lint, then Vector CLI. Session history so model
    // remembers previous attempts and doesn't repeat the same mistakes.
    {
      // Build a session-scoped conversation for the fix loop
      const fixSession: ChatMessage[] = [
        { role: "user", content: cleaned },
        { role: "assistant", content: rawResponse },
      ];
      let prevVrl = "";

      for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
        // Step 1: Static lint — catch hallucinated functions, bad syntax, etc.
        onProgress?.(attempt === 0
          ? `Linting VRL...`
          : `Fix attempt ${attempt}/${MAX_FIX_ATTEMPTS} — linting...`);

        const lintIssues = lintVrl(vrl);
        const lintErrors = lintIssues.filter(i => i.severity === "error");

        if (lintErrors.length > 0) {
          // Lint found errors — fix without calling Vector
          lastError = formatLintIssues(lintIssues);

          if (attempt < MAX_FIX_ATTEMPTS) {
            fixAttempts = attempt + 1;
            onProgress?.(`Lint found ${lintErrors.length} error(s). Sending to LLM (attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS})...`);

            const fixPrompt = buildFixPrompt(cleaned, vrl, lastError, fixAttempts, prevVrl);
            fixSession.push({ role: "user", content: fixPrompt });
            prevVrl = vrl;

            try {
              rawResponse = await this.llm.chat(fixPrompt, fixSession.slice(0, -1), signal);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              return { action: "error", message: `Fix attempt failed: ${msg}` };
            }

            [vrl, suspicious] = validateModelOutput(rawResponse);
            fixSession.push({ role: "assistant", content: rawResponse });
            continue; // re-lint
          }
          break;
        }

        // Step 2: Lint passed — now validate with Vector CLI
        if (vectorPath) {
          onProgress?.(attempt === 0
            ? `Validating VRL with Vector CLI...`
            : `Fix attempt ${attempt}/${MAX_FIX_ATTEMPTS} — testing with Vector...`);

          const testResult = await testVrl(vectorPath, vrl, cleaned);

          if (testResult.success) {
            validated = true;
            vectorOutput = testResult.output;
            break;
          }

          // Vector failed
          lastError = testResult.error ?? "Unknown Vector error";

          if (attempt < MAX_FIX_ATTEMPTS) {
            fixAttempts = attempt + 1;
            onProgress?.(`Vector validation failed. Sending error to LLM (attempt ${fixAttempts}/${MAX_FIX_ATTEMPTS})...`);

            const fixPrompt = buildFixPrompt(cleaned, vrl, lastError, fixAttempts, prevVrl);
            fixSession.push({ role: "user", content: fixPrompt });
            prevVrl = vrl;

            try {
              rawResponse = await this.llm.chat(fixPrompt, fixSession.slice(0, -1), signal);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              return { action: "error", message: `Fix attempt failed: ${msg}` };
            }

            [vrl, suspicious] = validateModelOutput(rawResponse);
            fixSession.push({ role: "assistant", content: rawResponse });
          }
        } else {
          // No Vector CLI — lint passed, that's the best we can do
          validated = true;
          break;
        }
      }

      if (!validated) {
        const warning = ` (Vector validation failed after ${fixAttempts} fix attempts: ${lastError})`;
        this.pushHistory(cleaned, rawResponse);
        return {
          action: "generated",
          vrl,
          message: `Parser generated for sig ${sig}${warning}`,
          signature: sig,
          rawResponse,
          validated: false,
          fixAttempts,
        };
      }
    }

    this.pushHistory(cleaned, rawResponse);

    const warning = suspicious ? " (WARNING: model may be off-task)" : "";
    const validatedMsg = validated ? " [validated]" : "";

    return {
      action: "generated",
      vrl,
      message: `New parser generated for sig ${sig}${validatedMsg}${warning}`,
      signature: sig,
      rawResponse,
      validated,
      vectorOutput,
      fixAttempts: fixAttempts > 0 ? fixAttempts : undefined,
    };
  }

  /**
   * Test an existing VRL program against a sample log.
   */
  /**
   * Try to parse the LLM response as a JSON structure description (Mode 1).
   * If successful, generates VRL from the description using templates.
   * Returns the generated VRL string, or null if not a structure description.
   */
  private tryGenerateFromDescription(response: string): string | null {
    // Try to extract JSON from ```json ... ``` fence
    const jsonMatch = response.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    if (!jsonMatch) return null;

    try {
      const desc = JSON.parse(jsonMatch[1]) as StructureDescription;
      if (!desc.steps || !desc.fields) return null;
      if (desc.mode !== "structure") return null;

      const vrl = generateVrl(desc);
      return vrl; // null if regex step found (falls back to Mode 2)
    } catch {
      return null; // Not valid JSON, fall back to Mode 2
    }
  }

  async testVrl(vectorPath: string, vrlCode: string, sampleLog: string): Promise<VrlTestResult> {
    return testVrl(vectorPath, vrlCode, sampleLog);
  }

  /**
   * Test VRL and if it fails, ask the LLM to fix it. Returns the fixed VRL.
   */
  async fixVrl(
    vectorPath: string,
    vrlCode: string,
    sampleLog: string,
    opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void },
  ): Promise<{ vrl: string; validated: boolean; vectorOutput?: string; attempts: number; error?: string }> {
    const { signal, onProgress } = opts ?? {};

    const session: ChatMessage[] = [];
    let prevVrl = "";

    let currentVrl = vrlCode;
    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      // Step 1: Static lint
      const lintIssues = lintVrl(currentVrl);
      const lintErrors = lintIssues.filter(i => i.severity === "error");

      if (lintErrors.length > 0 && attempt < MAX_FIX_ATTEMPTS) {
        onProgress?.(`Lint: ${lintErrors.length} error(s). Fixing (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS})...`);
        const lintMsg = formatLintIssues(lintIssues);
        const fixPrompt = buildFixPrompt(sampleLog, currentVrl, lintMsg, attempt + 1, prevVrl);
        session.push({ role: "user", content: fixPrompt });
        prevVrl = currentVrl;
        try {
          const response = await this.llm.chat(fixPrompt, session.slice(0, -1), signal);
          const [fixed] = validateModelOutput(response);
          session.push({ role: "assistant", content: response });
          currentVrl = fixed;
        } catch (e: unknown) {
          return { vrl: currentVrl, validated: false, attempts: attempt + 1, error: String(e) };
        }
        continue;
      }

      // Step 2: Vector CLI
      onProgress?.(attempt === 0
        ? "Testing VRL with Vector..."
        : `Fix attempt ${attempt}/${MAX_FIX_ATTEMPTS}...`);

      const result = await testVrl(vectorPath, currentVrl, sampleLog);

      if (result.success) {
        return { vrl: currentVrl, validated: true, vectorOutput: result.output, attempts: attempt };
      }

      if (attempt < MAX_FIX_ATTEMPTS) {
        onProgress?.(`VRL failed. Asking LLM to fix (attempt ${attempt + 1}/${MAX_FIX_ATTEMPTS})...`);
        const fixPrompt = buildFixPrompt(sampleLog, currentVrl, result.error ?? "Unknown error", attempt + 1, prevVrl);
        session.push({ role: "user", content: fixPrompt });
        prevVrl = currentVrl;
        try {
          const response = await this.llm.chat(fixPrompt, session.slice(0, -1), signal);
          const [fixed] = validateModelOutput(response);
          session.push({ role: "assistant", content: response });
          currentVrl = fixed;
        } catch (e: unknown) {
          return { vrl: currentVrl, validated: false, attempts: attempt + 1, error: String(e) };
        }
      } else {
        return { vrl: currentVrl, validated: false, attempts: attempt, error: result.error };
      }
    }

    return { vrl: currentVrl, validated: false, attempts: MAX_FIX_ATTEMPTS, error: "Max attempts reached" };
  }

  /**
   * Save a generated parser to the pattern library.
   */
  saveParser(opts: {
    signature: string;
    vrlCode: string;
    sampleLog: string;
    label?: string;
    variant?: string;
    sourceId?: number | null;
    ocsfClass?: string;
  }): number {
    return this.db.saveParser(opts);
  }

  // ── JSON file / batch processing ────────────────────────────────────────

  loadEventsFile(filePath: string): unknown[] {
    const text = fs.readFileSync(filePath, "utf-8").trim();

    if (text.startsWith("[")) {
      const data = JSON.parse(text);
      if (!Array.isArray(data)) {
        throw new Error("Expected a JSON array of events");
      }
      return data;
    }

    const events: unknown[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Line ${i + 1} is not valid JSON: ${msg}`);
      }
    }
    return events;
  }

  analyzeEventsStructure(events: unknown[]): BatchAnalysis {
    if (events.length === 0) {
      return { count: 0, commonKeys: [], optionalKeys: [], typeDistribution: {}, variants: [] };
    }

    const keyCounts: Record<string, number> = {};
    const typeMap: Record<string, Record<string, number>> = {};
    let total = 0;

    for (const ev of events) {
      if (typeof ev !== "object" || ev === null || Array.isArray(ev)) continue;
      total++;
      const obj = ev as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        keyCounts[k] = (keyCounts[k] ?? 0) + 1;
        if (!typeMap[k]) typeMap[k] = {};
        const t = v === null ? "null" : typeof v;
        typeMap[k][t] = (typeMap[k][t] ?? 0) + 1;
      }
    }

    const commonKeys = Object.keys(keyCounts).filter(k => keyCounts[k] === total).sort();
    const optionalKeys = Object.keys(keyCounts).filter(k => keyCounts[k] < total).sort();

    const variantMap: Record<string, number> = {};
    for (const ev of events) {
      if (typeof ev !== "object" || ev === null || Array.isArray(ev)) continue;
      const keySet = Object.keys(ev as Record<string, unknown>).sort().join(",");
      variantMap[keySet] = (variantMap[keySet] ?? 0) + 1;
    }
    const variants = Object.entries(variantMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([keys, count]) => ({ keys: keys.split(","), count }));

    return { count: total, commonKeys, optionalKeys, typeDistribution: typeMap, variants };
  }

  async processBatchEvents(
    events: unknown[],
    opts?: { vectorPath?: string; signal?: AbortSignal; onProgress?: (msg: string) => void },
  ): Promise<BatchResult> {
    const { vectorPath, signal, onProgress } = opts ?? {};
    const analysis = this.analyzeEventsStructure(events);

    const maxSamples = 15;
    const step = Math.max(1, Math.floor(events.length / maxSamples));
    const samples: unknown[] = [];
    for (let i = 0; i < events.length && samples.length < maxSamples; i += step) {
      samples.push(events[i]);
    }

    const eventsBlock = samples.map(e => JSON.stringify(e)).join("\n");
    const prompt = buildBatchPrompt(events.length, eventsBlock);

    onProgress?.("Generating batch VRL parser...");
    const response = await this.llm.chat(prompt, [], signal);
    let [vrl, suspicious] = validateModelOutput(response);

    const firstEvent = typeof events[0] === "object" ? JSON.stringify(events[0]) : String(events[0]);
    const signature = computeSignature(firstEvent);

    // Validate + auto-fix with Vector if available
    let validated = false;
    let vectorOutput: string | undefined;
    let fixAttempts = 0;

    if (vectorPath) {
      const fixResult = await this.fixVrl(vectorPath, vrl, firstEvent, { signal, onProgress });
      vrl = fixResult.vrl;
      validated = fixResult.validated;
      vectorOutput = fixResult.vectorOutput;
      fixAttempts = fixResult.attempts;
    }

    return { analysis, vrl, suspicious, signature, validated, vectorOutput, fixAttempts };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private pushHistory(userMsg: string, assistantMsg: string): void {
    this.history.push({ role: "user", content: userMsg });
    this.history.push({ role: "assistant", content: assistantMsg });
    if (this.history.length > 6) {
      this.history = this.history.slice(-6);
    }
  }
}

// ── Fix prompt ───────────────────────────────────────────────────────────────

function buildFixPrompt(sampleLog: string, failedVrl: string, vectorError: string, attempt?: number, prevVrl?: string): string {
  const repeatWarning = prevVrl && prevVrl.trim() === failedVrl.trim()
    ? `\nWARNING: Your previous fix was IDENTICAL to the code that failed. You MUST make a DIFFERENT change this time. Try a completely different parsing approach if the current one is not working.\n`
    : "";

  const attemptInfo = attempt ? `\nThis is fix attempt ${attempt}. ` : "";

  return `The following VRL program has errors. Fix the FIRST error only.
${attemptInfo}${repeatWarning}
ORIGINAL LOG MESSAGE:
${sampleLog}

FAILED VRL PROGRAM:
\`\`\`vrl
${failedVrl}
\`\`\`

ERROR OUTPUT:
${vectorError}

INSTRUCTIONS:
1. Read the FIRST error and its line number.
2. Fix ONLY that error. Do NOT output the same code unchanged.
3. Common fixes:
   - E105 "undefined function" → check spelling, function may not exist
   - E110 "invalid argument type" → use string!(.field) to assert type
   - E100/E103 "unhandled fallible" → use , err = pattern: result, err = func(arg)
   - E204 "unexpected end of program" → missing closing }
   - "function call error" → the function ran but failed on the input data. Check what you're passing to it.
   - "could not find any pattern matches" → regex didn't match. Check the actual input carefully.
   - If log has KEY:'value' or KEY:"value" pairs → use parse_key_value! instead of regex
4. For error handling, use: result, err = function(arg)  then: if err != null { abort }
5. Output the COMPLETE fixed program as a \`\`\`vrl\`\`\` block.`;
}

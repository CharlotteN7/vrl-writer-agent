/**
 * Prompt injection detection and input sanitization.
 *
 * Defence-in-depth layers:
 *   1. Regex pattern matching on user input (this module)
 *   2. Strict system prompt pinning (prompts.ts)
 *   3. Output validation (model response check)
 */

interface InjectionRule {
  pattern: RegExp;
  description: string;
}

const INJECTION_RULES: InjectionRule[] = [
  { pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts)/i, description: "ignore previous instructions" },
  { pattern: /you\s+are\s+now\s+a/i, description: "role reassignment" },
  { pattern: /new\s+instructions?\s*:/i, description: "new instructions block" },
  { pattern: /system\s+prompt\s*:/i, description: "system prompt injection" },
  { pattern: /forget\s+(everything|your\s+(instructions|role|prompt))/i, description: "memory wipe" },
  { pattern: /disregard\s+(all|any|the)\s+(rules|instructions|guidelines)/i, description: "disregard rules" },
  { pattern: /override\s+(system|prompt|instructions)/i, description: "override attempt" },
  { pattern: /pretend\s+(you\s+are|to\s+be)/i, description: "persona hijack" },
  { pattern: /act\s+as\s+(if|though)\s+you/i, description: "persona hijack" },
  { pattern: /do\s+not\s+follow\s+(your|the)\s+(rules|instructions)/i, description: "rule bypass" },
  { pattern: /\bDAN\b.*\bmode\b/i, description: "DAN jailbreak" },
  { pattern: /(sudo|admin)\s+mode/i, description: "privilege escalation" },
  { pattern: /reveal\s+(your|the)\s+(system|initial)\s+prompt/i, description: "prompt exfiltration" },
];

/**
 * Check if text contains prompt injection patterns.
 * Returns the description of the matched rule, or null if clean.
 */
export function checkInjection(text: string): string | null {
  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(text)) {
      return rule.description;
    }
  }
  return null;
}

/**
 * Strip control characters and collapse excessive whitespace.
 */
export function sanitizeInput(text: string): string {
  let s = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const OFF_TASK_SIGNALS = [
  "as an ai", "as a language model", "i cannot", "i can't",
  "i'm sorry", "sure! here", "certainly!", "of course!",
  "i'd be happy to", "absolutely!",
];

/**
 * Validate and clean model output.
 * Returns [cleanedOutput, isSuspicious].
 */
export function validateModelOutput(output: string): [string, boolean] {
  let cleaned = output.trim();

  // Extract content between first ```vrl and its matching ``` (handles prose before/after)
  const fenceMatch = cleaned.match(/```(?:vrl|rust|toml)?\n([\s\S]*?)\n?```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1];
  } else {
    // Fallback: strip fences at start/end only
    cleaned = cleaned.replace(/^```(?:vrl|rust|toml)?\n?/, "");
    cleaned = cleaned.replace(/\n?```$/, "");
  }

  const lower = cleaned.toLowerCase();
  const suspicious = OFF_TASK_SIGNALS.some(s => lower.startsWith(s));

  return [cleaned, suspicious];
}

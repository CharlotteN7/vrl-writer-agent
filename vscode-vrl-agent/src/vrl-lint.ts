/**
 * Static VRL syntax linter — catches structural errors BEFORE sending to Vector CLI.
 *
 * Focuses on:
 *   1. Brace balancing { }
 *   2. String literal correctness (unclosed quotes, bad escapes)
 *   3. Regex literal correctness (r'...' syntax)
 *   4. Forbidden language constructs (let, var, ;, for, while)
 *   5. Common escape sequence errors
 */

export interface LintIssue {
  line: number;
  severity: "error" | "warning";
  message: string;
}

// Valid VRL string escape sequences
const VALID_STRING_ESCAPES = new Set(["\\n", "\\t", "\\r", "\\\\", '\\"', "\\0"]);

/**
 * Lint a VRL program and return issues found.
 */
export function lintVrl(code: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = code.split("\n");

  checkBraces(code, issues);
  checkForbiddenSyntax(lines, issues);
  checkStringLiterals(lines, issues);
  checkRegexLiterals(lines, issues);
  checkEscapeSequences(lines, issues);
  checkRegexCompilation(lines, issues);

  return issues;
}

// ── Brace balancing ──────────────────────────────────────────────────────────

function checkBraces(code: string, issues: LintIssue[]): void {
  let depth = 0;
  let inString = false;
  let inRegex = false;
  let inComment = false;
  let stringChar = "";
  let lineNum = 1;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1] ?? "";
    const prev = code[i - 1] ?? "";

    if (ch === "\n") {
      lineNum++;
      inComment = false;
      continue;
    }

    // Skip comments
    if (!inString && !inRegex && ch === "#") {
      inComment = true;
      continue;
    }
    if (inComment) continue;

    // Track string literals
    if (!inRegex && ch === '"' && prev !== "\\") {
      inString = !inString;
      if (inString) stringChar = '"';
      continue;
    }

    // Track regex literals r'...'
    if (!inString && !inRegex && ch === "r" && next === "'") {
      inRegex = true;
      i++; // skip the '
      continue;
    }
    if (inRegex && ch === "'" && prev !== "\\") {
      inRegex = false;
      continue;
    }

    // Track raw string literals s'...' and timestamp literals t'...'
    if (!inString && !inRegex && (ch === "s" || ch === "t") && next === "'") {
      // Skip until closing '
      i += 2;
      while (i < code.length && code[i] !== "'") {
        if (code[i] === "\n") lineNum++;
        i++;
      }
      continue;
    }

    if (inString || inRegex) continue;

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth < 0) {
        issues.push({ line: lineNum, severity: "error", message: "Unexpected closing '}' — no matching '{'" });
        depth = 0;
      }
    }
  }

  if (depth > 0) {
    issues.push({
      line: lineNum,
      severity: "error",
      message: `${depth} unclosed brace(s) — missing '}'`,
    });
  }

  // Check unclosed string
  if (inString) {
    issues.push({
      line: lineNum,
      severity: "error",
      message: "Unclosed string literal — missing closing '\"'",
    });
  }

  // Check unclosed regex
  if (inRegex) {
    issues.push({
      line: lineNum,
      severity: "error",
      message: "Unclosed regex literal — missing closing \"'\" for r'...'",
    });
  }
}

// ── Forbidden syntax ─────────────────────────────────────────────────────────

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /^\s*let\s+\w+/, message: "VRL does not use 'let' — write: variable_name = value" },
  { pattern: /^\s*var\s+\w+/, message: "VRL does not use 'var' — write: variable_name = value" },
  { pattern: /^\s*const\s+\w+/, message: "VRL does not use 'const' — write: variable_name = value" },
  { pattern: /\breturn\s/, message: "VRL does not use 'return' — the last expression is the return value" },
  { pattern: /;\s*$/, message: "VRL does not use semicolons — use newlines to separate statements" },
  { pattern: /^\s*for\s+/, message: "VRL does not have for loops" },
  { pattern: /^\s*while\s+/, message: "VRL does not have while loops" },
  { pattern: /^\s*fn\s+/, message: "VRL does not support custom function definitions" },
  { pattern: /^\s*def\s+/, message: "VRL does not support custom function definitions" },
  { pattern: /\bmatch\s*\{/, message: "VRL does not have match/switch — use if/else if/else" },
  { pattern: /\?\?/, message: "Do not use ?? operator — use ', err = ' error assignment pattern instead" },
];

function checkForbiddenSyntax(lines: string[], issues: LintIssue[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.replace(/#.*$/, ""); // remove comments

    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(stripped)) {
        issues.push({ line: i + 1, severity: "error", message: rule.message });
      }
    }
  }
}

// ── String literal checks ────────────────────────────────────────────────────

function checkStringLiterals(lines: string[], issues: LintIssue[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, ""); // remove comments

    // Check for single-quoted strings that aren't r'...' or s'...' or t'...'
    // VRL strings must use double quotes
    const singleQuoteStrings = line.matchAll(/(?<![rst])'([^'\\]|\\.)*'/g);
    for (const match of singleQuoteStrings) {
      // Skip if inside a regex or raw/timestamp literal context
      const before = line.substring(0, match.index ?? 0);
      if (before.match(/r\s*$/) || before.match(/s\s*$/) || before.match(/t\s*$/)) continue;

      issues.push({
        line: i + 1,
        severity: "warning",
        message: `Possible single-quoted string — VRL strings use double quotes "...". Single quotes are for r'regex', s'raw', t'timestamp' only.`,
      });
    }

    // Check for unmatched double quotes (odd count outside of escaped ones)
    let quoteCount = 0;
    let escaped = false;
    for (const ch of line) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === "#") break; // comment
      if (ch === '"') quoteCount++;
    }
    if (quoteCount % 2 !== 0) {
      issues.push({
        line: i + 1,
        severity: "error",
        message: "Unmatched double quote — unclosed string literal on this line",
      });
    }
  }
}

// ── Regex literal checks ─────────────────────────────────────────────────────

function checkRegexLiterals(lines: string[], issues: LintIssue[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, "");

    // Check for regex using double quotes: r"..." — should be r'...'
    const badRegex = line.match(/r"[^"]*"/);
    if (badRegex) {
      issues.push({
        line: i + 1,
        severity: "error",
        message: `Regex must use single quotes: r'pattern' — not r"pattern"`,
      });
    }

    // Check for regex without r prefix used in parse_regex context
    const parseRegexCall = line.match(/parse_regex!\s*\([^,]+,\s*"([^"]+)"\s*\)/);
    if (parseRegexCall) {
      issues.push({
        line: i + 1,
        severity: "error",
        message: `Regex pattern must use r'...' syntax — not a double-quoted string. Change "${parseRegexCall[1]}" to r'${parseRegexCall[1]}'`,
      });
    }

    // Check for JavaScript-style regex /pattern/
    const jsRegex = line.match(/[=,(\s]\/[^/\s][^/]*\/[gimsy]*/);
    if (jsRegex) {
      issues.push({
        line: i + 1,
        severity: "error",
        message: "VRL does not use /regex/ syntax — use r'pattern' instead",
      });
    }

    // Check named capture syntax: warn about (?<name>) vs (?P<name>)
    const regexLiterals = line.matchAll(/r'([^'\\]|\\.)*'/g);
    for (const match of regexLiterals) {
      const pattern = match[0];
      if (pattern.includes("(?<") && !pattern.includes("(?P<")) {
        issues.push({
          line: i + 1,
          severity: "error",
          message: "VRL named captures use (?P<name>...) syntax — not (?<name>...). Add the 'P' after '?'.",
        });
      }
    }
  }
}

// ── Escape sequence checks ───────────────────────────────────────────────────

function checkEscapeSequences(lines: string[], issues: LintIssue[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, "");

    // Find all string literals and check escape sequences
    const strings = line.matchAll(/"((?:[^"\\]|\\.)*)"/g);
    for (const match of strings) {
      const content = match[1];
      // Find all escape sequences in the string
      const escapes = content.matchAll(/\\(.)/g);
      for (const esc of escapes) {
        const full = "\\" + esc[1];
        if (!VALID_STRING_ESCAPES.has(full) && esc[1] !== "'" && esc[1] !== "/") {
          // Check for common mistakes
          if (esc[1] === "d" || esc[1] === "w" || esc[1] === "s" || esc[1] === "b") {
            issues.push({
              line: i + 1,
              severity: "error",
              message: `Escape '${full}' is a regex escape, not a string escape. If this is a regex pattern, use r'...' syntax instead of "..."`,
            });
          } else if (esc[1] === "x" || esc[1] === "u") {
            // Unicode/hex escapes — might be valid, just warn
            // Skip
          } else {
            issues.push({
              line: i + 1,
              severity: "warning",
              message: `Unknown string escape sequence '${full}'. Valid VRL string escapes: \\n \\t \\r \\\\ \\" \\0`,
            });
          }
        }
      }
    }

    // Check for double-escaped backslashes inside r'...' (not needed)
    const regexLiterals = line.matchAll(/r'((?:[^'\\]|\\.)*)'/g);
    for (const match of regexLiterals) {
      const content = match[1];
      if (content.includes("\\\\d") || content.includes("\\\\w") || content.includes("\\\\s")) {
        issues.push({
          line: i + 1,
          severity: "warning",
          message: "Double-escaped regex inside r'...' — backslashes in r'...' are regex escapes directly. Use \\d not \\\\d.",
        });
      }
    }
  }
}

/**
 * Format lint issues as a string for inclusion in fix prompts.
 */
// ── Regex compilation check ──────────────────────────────────────────────────

function checkRegexCompilation(lines: string[], issues: LintIssue[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*$/, "");

    // Extract all r'...' regex literals, handling \' escapes inside
    const regexMatches = line.matchAll(/r'((?:[^'\\]|\\.)*)'/g);
    for (const match of regexMatches) {
      const pattern = match[1];

      // Convert VRL regex to JS-compatible: replace \' with ' (VRL-specific escape)
      const jsPattern = pattern.replace(/\\'/g, "'");

      // Convert (?P<name>...) to (?<name>...) for JS regex engine
      const jsCompatible = jsPattern.replace(/\(\?P</g, "(?<");

      try {
        new RegExp(jsCompatible);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        issues.push({
          line: i + 1,
          severity: "error",
          message: `Regex r'${pattern.slice(0, 60)}${pattern.length > 60 ? "..." : ""}' is invalid: ${msg}`,
        });
      }
    }
  }
}

export function formatLintIssues(issues: LintIssue[]): string {
  if (issues.length === 0) return "";

  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");

  let out = "";
  if (errors.length > 0) {
    out += `STATIC ANALYSIS ERRORS (${errors.length}):\n`;
    for (const e of errors) {
      out += `  Line ${e.line}: ${e.message}\n`;
    }
  }
  if (warnings.length > 0) {
    out += `WARNINGS (${warnings.length}):\n`;
    for (const w of warnings) {
      out += `  Line ${w.line}: ${w.message}\n`;
    }
  }
  return out;
}

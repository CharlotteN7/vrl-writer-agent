/**
 * Log line fingerprinting — compute a structural signature so that
 * logs differing only in variable content produce the same hash.
 */

import * as crypto from "crypto";

/**
 * Sequential replacement rules applied to normalize a log line.
 */
const REPLACEMENTS: [RegExp, string][] = [
  // ISO-8601 timestamps
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<TS>"],
  // Common log / syslog dates
  [/\d{1,2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}\s*[+-]?\d{4}/g, "<TS>"],
  [/\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/g, "<TS>"],
  // Unix epoch (10 or 13 digits)
  [/\b\d{10,13}\b/g, "<EPOCH>"],
  // UUIDs
  [/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<UUID>"],
  // IPv4
  [/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "<IP>"],
  // IPv6 (simplified)
  [/([0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}/g, "<IP6>"],
  // Hex strings >= 8 chars (trace IDs, hashes)
  [/\b[0-9a-fA-F]{8,}\b/g, "<HEX>"],
  // Standalone numbers
  [/\b\d+\b/g, "<N>"],
  // Quoted strings — replace content but keep structure
  [/"[^"]*"/g, '"<STR>"'],
  [/'[^']*'/g, "'<STR>'"],
];

function applyReplacements(text: string): string {
  let s = text;
  for (const [pattern, replacement] of REPLACEMENTS) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

/**
 * Compute a 16-char hex signature from a log line's structural skeleton.
 */
export function computeSignature(logLine: string): string {
  const skeleton = applyReplacements(logLine);
  return crypto.createHash("sha256").update(skeleton).digest("hex").slice(0, 16);
}

/**
 * Return the human-readable skeleton (before hashing) for debugging.
 */
export function describeSkeleton(logLine: string): string {
  return applyReplacements(logLine);
}

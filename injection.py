"""
Prompt injection detection and input sanitization.

Defence-in-depth layers:
  1. Regex pattern matching on user input (this module)
  2. Strict system prompt pinning (prompts.py)
  3. Output validation (agent checks model response for off-task signals)
"""

import re

# Patterns that signal an attempt to override system instructions.
# Each tuple is (compiled regex, human-readable description).
INJECTION_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"ignore\s+(all\s+)?(previous|above|prior)\s+(instructions|prompts)", re.I),
     "ignore previous instructions"),
    (re.compile(r"you\s+are\s+now\s+a", re.I),
     "role reassignment"),
    (re.compile(r"new\s+instructions?\s*:", re.I),
     "new instructions block"),
    (re.compile(r"system\s*:\s*", re.I),
     "system prompt injection"),
    (re.compile(r"forget\s+(everything|your\s+(instructions|role|prompt))", re.I),
     "memory wipe"),
    (re.compile(r"disregard\s+(all|any|the)\s+(rules|instructions|guidelines)", re.I),
     "disregard rules"),
    (re.compile(r"override\s+(system|prompt|instructions)", re.I),
     "override attempt"),
    (re.compile(r"pretend\s+(you\s+are|to\s+be)", re.I),
     "persona hijack"),
    (re.compile(r"act\s+as\s+(if|though)\s+you", re.I),
     "persona hijack"),
    (re.compile(r"do\s+not\s+follow\s+(your|the)\s+(rules|instructions)", re.I),
     "rule bypass"),
    (re.compile(r"\bDAN\b.*\bmode\b", re.I),
     "DAN jailbreak"),
    (re.compile(r"(sudo|admin)\s+mode", re.I),
     "privilege escalation"),
    (re.compile(r"reveal\s+(your|the)\s+(system|initial)\s+prompt", re.I),
     "prompt exfiltration"),
]


def check_injection(text: str) -> str | None:
    """Return a description if injection is detected, else None."""
    for pattern, description in INJECTION_RULES:
        if pattern.search(text):
            return description
    return None


def sanitize_input(text: str) -> str:
    """Strip control characters and collapse excessive whitespace."""
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def validate_model_output(output: str) -> tuple[str, bool]:
    """
    Validate and clean model output.
    Returns (cleaned_output, is_suspicious).
    """
    # Strip markdown code fences
    cleaned = re.sub(r"^```(?:vrl|rust|toml)?\n?", "", output.strip())
    cleaned = re.sub(r"\n?```$", "", cleaned)

    off_task_signals = [
        "as an ai", "as a language model", "i cannot", "i can't",
        "i'm sorry", "sure! here", "certainly!", "of course!",
        "i'd be happy to", "absolutely!",
    ]
    lower = cleaned.lower()
    suspicious = any(lower.startswith(s) for s in off_task_signals)

    return cleaned, suspicious

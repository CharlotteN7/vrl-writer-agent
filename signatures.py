"""
Log line fingerprinting — compute a structural signature from a raw log line
so that logs differing only in variable content (IPs, timestamps, IDs, etc.)
produce the same hash.
"""

import hashlib
import re


def compute_signature(log_line: str) -> str:
    """
    Normalize a log line by replacing variable tokens with placeholders,
    then hash the skeleton to produce a 16-char hex signature.
    """
    s = log_line

    # ISO-8601 timestamps
    s = re.sub(
        r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?",
        "<TS>", s,
    )
    # Common log / syslog dates
    s = re.sub(
        r"\d{1,2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2}\s*[+-]?\d{4}", "<TS>", s,
    )
    s = re.sub(r"\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}", "<TS>", s)
    # Unix epoch (10 or 13 digits)
    s = re.sub(r"\b\d{10,13}\b", "<EPOCH>", s)
    # UUIDs
    s = re.sub(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        "<UUID>", s,
    )
    # IPv4
    s = re.sub(r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}", "<IP>", s)
    # IPv6 (simplified)
    s = re.sub(r"([0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}", "<IP6>", s)
    # Hex strings ≥ 8 chars (trace IDs, hashes)
    s = re.sub(r"\b[0-9a-fA-F]{8,}\b", "<HEX>", s)
    # Standalone numbers
    s = re.sub(r"\b\d+\b", "<N>", s)
    # Quoted strings — replace content but keep structure
    s = re.sub(r'"[^"]*"', '"<STR>"', s)
    s = re.sub(r"'[^']*'", "'<STR>'", s)

    return hashlib.sha256(s.encode()).hexdigest()[:16]


def describe_skeleton(log_line: str) -> str:
    """
    Return the human-readable skeleton (before hashing) for debugging.
    Useful for showing the user what structural pattern was detected.
    """
    s = log_line
    s = re.sub(
        r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?",
        "<TS>", s,
    )
    s = re.sub(
        r"\d{1,2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2}\s*[+-]?\d{4}", "<TS>", s,
    )
    s = re.sub(r"\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}", "<TS>", s)
    s = re.sub(r"\b\d{10,13}\b", "<EPOCH>", s)
    s = re.sub(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
        "<UUID>", s,
    )
    s = re.sub(r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}", "<IP>", s)
    s = re.sub(r"([0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}", "<IP6>", s)
    s = re.sub(r"\b[0-9a-fA-F]{8,}\b", "<HEX>", s)
    s = re.sub(r"\b\d+\b", "<N>", s)
    s = re.sub(r'"[^"]*"', '"<STR>"', s)
    s = re.sub(r"'[^']*'", "'<STR>'", s)
    return s

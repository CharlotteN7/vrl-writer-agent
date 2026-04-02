"""
VRL Parser Generator Agent — core logic.

Modes:
  - CLI interactive (default)
  - JSON file ingestion (--file <path>)

Connects to a custom LLM server (OpenAI-compatible API) via the openai SDK.
Stores approved parsers in SQLite with multi-variant support.
Output includes OCSF schema mapping.
"""

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

from openai import OpenAI

from db import (
    init_db, create_source, list_sources, delete_source,
    lookup_parsers, save_parser, list_parsers, get_parser,
    delete_parser, update_parser_label, parser_count,
)
from injection import check_injection, sanitize_input, validate_model_output
from prompts import SYSTEM_PROMPT, BATCH_ANALYSIS_PROMPT
from signatures import compute_signature, describe_skeleton

SERVER_URL = os.environ.get("LLM_SERVER_URL", "")
API_TOKEN = os.environ.get("LLM_API_TOKEN", "")
MODEL = os.environ.get("LLM_MODEL", "")

_client: OpenAI | None = None


def get_client() -> OpenAI:
    global _client
    if _client is None:
        if not SERVER_URL:
            raise RuntimeError("LLM_SERVER_URL not set. Use --server-url or env var.")
        _client = OpenAI(
            base_url=SERVER_URL.rstrip("/") + "/v1",
            api_key=API_TOKEN or "no-key",
        )
    return _client


# ============================================================
# LLM Client
# ============================================================

def chat(user_message: str, history: list[dict] | None = None) -> str:
    """Send a chat completion to the custom LLM server."""
    client = get_client()
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_message})

    completion = client.chat.completions.create(
        model=MODEL,
        messages=messages,
        temperature=0.1,
    )
    return completion.choices[0].message.content or ""


def list_models() -> list[dict]:
    """Fetch available models from the server."""
    client = get_client()
    models = client.models.list()
    return [{"id": m.id, "owned_by": m.owned_by} for m in models]


# ============================================================
# JSON File Ingestion — deduce structure from batch of events
# ============================================================

def load_events_file(path: Path) -> list[dict]:
    """
    Load events from a JSON file. Supports:
      - JSON array of objects: [{"ts":...}, {"ts":...}]
      - Newline-delimited JSON (NDJSON): one object per line
    """
    text = path.read_text(encoding="utf-8").strip()

    # Try JSON array first
    if text.startswith("["):
        data = json.loads(text)
        if not isinstance(data, list):
            raise ValueError("Expected a JSON array of events")
        return data

    # Try NDJSON
    events = []
    for i, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise ValueError(f"Line {i} is not valid JSON: {e}") from e
        events.append(obj)
    return events


def analyze_events_structure(events: list[dict]) -> dict:
    """
    Analyze a batch of events and return structural metadata:
    - common keys (present in all events)
    - optional keys (present in some)
    - value type distribution per key
    - detected variants (by presence/absence of keys)
    """
    if not events:
        return {"count": 0}

    key_counts: Counter = Counter()
    type_map: dict[str, Counter] = {}
    total = len(events)

    for ev in events:
        if not isinstance(ev, dict):
            continue
        for k, v in ev.items():
            key_counts[k] += 1
            type_map.setdefault(k, Counter())[type(v).__name__] += 1

    common = {k for k, c in key_counts.items() if c == total}
    optional = {k for k, c in key_counts.items() if c < total}

    # Detect variants by grouping events by their key-set
    variant_groups: Counter = Counter()
    for ev in events:
        if isinstance(ev, dict):
            variant_groups[frozenset(ev.keys())] += 1

    variants = [
        {"keys": sorted(ks), "count": c}
        for ks, c in variant_groups.most_common(10)
    ]

    return {
        "count": total,
        "common_keys": sorted(common),
        "optional_keys": sorted(optional),
        "type_distribution": {
            k: dict(v.most_common()) for k, v in type_map.items()
        },
        "variants": variants,
    }


def generate_batch_parser(events: list[dict]) -> str:
    """Send a batch of events to the LLM for a unified VRL parser."""
    # Send up to 15 representative events (sample evenly)
    sample_size = min(15, len(events))
    step = max(1, len(events) // sample_size)
    samples = [events[i] for i in range(0, len(events), step)][:sample_size]

    events_block = "\n".join(json.dumps(e, default=str) for e in samples)
    prompt = BATCH_ANALYSIS_PROMPT.format(count=len(events), events_block=events_block)

    return chat(prompt)


def process_json_file(path: Path, conn) -> None:
    """Full pipeline for JSON file ingestion."""
    print(f"\nLoading events from {path}...")
    events = load_events_file(path)
    print(f"Loaded {len(events)} events.")

    if not events:
        print("No events found in file.")
        return

    # Analyze structure
    analysis = analyze_events_structure(events)
    print(f"\n--- Structure Analysis ---")
    print(f"Total events: {analysis['count']}")
    print(f"Common keys:  {', '.join(analysis.get('common_keys', []))}")
    if analysis.get("optional_keys"):
        print(f"Optional keys: {', '.join(analysis['optional_keys'])}")
    print(f"Variants:     {len(analysis.get('variants', []))}")
    for i, v in enumerate(analysis.get("variants", []), 1):
        print(f"  Variant {i} ({v['count']}x): {', '.join(v['keys'][:10])}")

    # Generate parser
    print(f"\nGenerating VRL parser with {MODEL}...")
    try:
        response = chat(
            BATCH_ANALYSIS_PROMPT.format(
                count=len(events),
                events_block="\n".join(
                    json.dumps(e, default=str)
                    for e in events[:15]
                ),
            )
        )
    except Exception as e:
        print(f"ERROR: LLM request failed: {e}")
        return

    vrl, suspicious = validate_model_output(response)
    if suspicious:
        print("WARNING: model response looks off-task.")

    print(f"\n{vrl}\n")

    # Offer to save
    sig = compute_signature(json.dumps(events[0], default=str))
    try:
        save = input("Save this parser? [y/N/label text] ").strip()
    except (EOFError, KeyboardInterrupt):
        return

    if save.lower() in ("y", "yes"):
        pid = save_parser(conn, sig, vrl, json.dumps(events[0], default=str))
        print(f"Saved as parser #{pid}.\n")
    elif save and save.lower() not in ("n", "no", ""):
        pid = save_parser(conn, sig, vrl, json.dumps(events[0], default=str), label=save)
        print(f"Saved as parser #{pid} [{save}].\n")
    else:
        print("(not saved)\n")


# ============================================================
# Single-line processing (used by CLI and Mattermost bot)
# ============================================================

def process_single_log(raw: str, conn, history: list[dict] | None = None) -> dict:
    """
    Process a single log line. Returns a dict with:
      - action: "blocked" | "cached" | "generated" | "error"
      - vrl: the VRL code (if any)
      - message: status message
      - parser_id: DB id (if cached or saved)
      - signature: the computed signature
    """
    raw = sanitize_input(raw)
    if not raw:
        return {"action": "error", "message": "Empty input."}

    matched = check_injection(raw)
    if matched:
        return {"action": "blocked", "message": f"Injection detected: {matched}"}

    sig = compute_signature(raw)
    cached = lookup_parsers(conn, sig)
    if cached:
        top = cached[0]
        label = f" [{top['label']}]" if top["label"] else ""
        variants_info = f" ({len(cached)} variant{'s' if len(cached) > 1 else ''})" if len(cached) > 1 else ""
        return {
            "action": "cached",
            "vrl": top["vrl_code"],
            "message": f"Cache hit: parser #{top['id']}{label}{variants_info} (used {top['hits']}x)",
            "parser_id": top["id"],
            "signature": sig,
            "all_variants": cached,
        }

    try:
        response = chat(raw, history)
    except Exception as e:
        return {"action": "error", "message": str(e)}

    vrl, suspicious = validate_model_output(response)
    warning = " (WARNING: model may be off-task)" if suspicious else ""

    return {
        "action": "generated",
        "vrl": vrl,
        "message": f"New parser generated for sig {sig}{warning}",
        "signature": sig,
        "raw_response": response,
    }


# ============================================================
# CLI Interactive Loop
# ============================================================

HELP_TEXT = """
Commands:
  :list [source]     — show all saved parsers (optionally filter by source)
  :show <id>         — show a saved parser by ID
  :delete <id>       — delete a saved parser
  :label <id> text   — set a label on a saved parser
  :source add <name> — create a log source
  :source list       — list all sources
  :source rm <id>    — delete a source
  :file <path.json>  — ingest a JSON file of events
  :sig <log line>    — show the computed signature without querying the model
  :help              — show this help
  quit / exit / q    — exit
"""


def cli_main():
    parser = argparse.ArgumentParser(description="VRL Parser Generator Agent")
    parser.add_argument("--file", "-f", type=Path, help="JSON file of events to analyze")
    parser.add_argument("--server-url", "-s", default=SERVER_URL, help="LLM server base URL (or LLM_SERVER_URL env)")
    parser.add_argument("--api-token", "-t", default=API_TOKEN, help="Bearer token (or LLM_API_TOKEN env)")
    parser.add_argument("--model", "-m", default=MODEL, help="Model ID (or LLM_MODEL env)")
    parser.add_argument("--list-models", action="store_true", help="List available models and exit")
    args = parser.parse_args()

    global SERVER_URL, API_TOKEN, MODEL, _client
    SERVER_URL = args.server_url
    API_TOKEN = args.api_token
    MODEL = args.model
    _client = None  # force re-create with new params

    # List models mode
    if args.list_models:
        if not SERVER_URL:
            print("ERROR: --server-url or LLM_SERVER_URL required")
            sys.exit(1)
        try:
            models = list_models()
            print(f"Available models ({len(models)}):")
            for m in models:
                marker = " *" if m["id"] == MODEL else ""
                print(f"  {m['id']:<40} (owned by: {m['owned_by']}){marker}")
        except Exception as e:
            print(f"ERROR: {e}")
            sys.exit(1)
        return

    conn = init_db()

    # File mode — non-interactive
    if args.file:
        if not SERVER_URL:
            print("ERROR: --server-url or LLM_SERVER_URL required")
            sys.exit(1)
        if not args.file.exists():
            print(f"ERROR: file not found: {args.file}")
            sys.exit(1)
        process_json_file(args.file, conn)
        return

    # Interactive mode
    if not SERVER_URL:
        print("ERROR: --server-url or LLM_SERVER_URL required")
        sys.exit(1)
    if not MODEL:
        print("ERROR: --model or LLM_MODEL required. Use --list-models to see available models.")
        sys.exit(1)

    print("=== VRL Parser Generator Agent ===")
    print(f"Server: {SERVER_URL}")
    print(f"Model: {MODEL}")
    print(f"Pattern DB: {parser_count(conn)} saved parsers")
    print("Paste a raw log line to get a VRL parser. Type :help for commands.\n")

    history: list[dict] = []

    while True:
        try:
            raw = input("log> ")
        except (EOFError, KeyboardInterrupt):
            print("\nBye.")
            break

        stripped = raw.strip()
        if stripped.lower() in ("quit", "exit", "q"):
            break

        # ── Commands ──────────────────────────────────────────────
        if stripped == ":help":
            print(HELP_TEXT)
            continue

        if stripped.startswith(":sig "):
            line = stripped[5:]
            sig = compute_signature(line)
            skel = describe_skeleton(line)
            print(f"Signature: {sig}")
            print(f"Skeleton:  {skel}\n")
            continue

        if stripped.startswith(":file "):
            fpath = Path(stripped[6:].strip())
            if not fpath.exists():
                print(f"File not found: {fpath}\n")
                continue
            process_json_file(fpath, conn)
            continue

        if stripped.startswith(":list"):
            parts = stripped.split(maxsplit=1)
            source_filter = None
            if len(parts) > 1:
                # look up source by name
                sources = list_sources(conn)
                match = [s for s in sources if s["name"] == parts[1]]
                if match:
                    source_filter = match[0]["id"]
                else:
                    print(f"Source '{parts[1]}' not found.\n")
                    continue

            parsers = list_parsers(conn, source_id=source_filter)
            if not parsers:
                print("(no saved parsers)\n")
                continue
            print(f"\n{'ID':>4}  {'Hits':>4}  {'Var':<10}  {'Label':<16}  {'OCSF':<6}  {'Source':<12}  Sample")
            print("-" * 95)
            for p in parsers:
                label = p["label"] or "-"
                src = p["source_name"] or "-"
                ocsf = p["ocsf_class"] or "-"
                print(f"{p['id']:>4}  {p['hits']:>4}  {p['variant']:<10}  {label:<16}  {ocsf:<6}  {src:<12}  {p['sample']}")
            print()
            continue

        if stripped.startswith(":show "):
            try:
                pid = int(stripped.split()[1])
            except (ValueError, IndexError):
                print("Usage: :show <id>\n")
                continue
            p = get_parser(conn, pid)
            if not p:
                print(f"Parser {pid} not found.\n")
                continue
            print(f"\n--- Parser #{p['id']} (sig: {p['signature']}, variant: {p['variant']}, hits: {p['hits']}) ---")
            if p["label"]:
                print(f"Label:  {p['label']}")
            if p["source_name"]:
                print(f"Source: {p['source_name']}")
            if p["ocsf_class"]:
                print(f"OCSF:   {p['ocsf_class']}")
            print(f"Sample: {p['sample_log'][:120]}")
            print(f"\n{p['vrl_code']}\n")
            continue

        if stripped.startswith(":delete "):
            try:
                pid = int(stripped.split()[1])
            except (ValueError, IndexError):
                print("Usage: :delete <id>\n")
                continue
            if delete_parser(conn, pid):
                print(f"Deleted parser #{pid}.\n")
            else:
                print(f"Parser {pid} not found.\n")
            continue

        if stripped.startswith(":label "):
            parts = stripped.split(maxsplit=2)
            if len(parts) < 3:
                print("Usage: :label <id> <text>\n")
                continue
            try:
                pid = int(parts[1])
            except ValueError:
                print("Usage: :label <id> <text>\n")
                continue
            if update_parser_label(conn, pid, parts[2]):
                print(f"Labeled parser #{pid}: {parts[2]}\n")
            else:
                print(f"Parser {pid} not found.\n")
            continue

        if stripped.startswith(":source "):
            src_parts = stripped.split(maxsplit=2)
            if len(src_parts) < 2:
                print("Usage: :source add|list|rm ...\n")
                continue
            subcmd = src_parts[1]
            if subcmd == "list":
                sources = list_sources(conn)
                if not sources:
                    print("(no sources)\n")
                    continue
                print(f"\n{'ID':>4}  {'Name':<20}  {'Parsers':>7}  Description")
                print("-" * 60)
                for s in sources:
                    print(f"{s['id']:>4}  {s['name']:<20}  {s['parser_count']:>7}  {s['description']}")
                print()
            elif subcmd == "add" and len(src_parts) > 2:
                sid = create_source(conn, src_parts[2])
                print(f"Source '{src_parts[2]}' created (id={sid}).\n")
            elif subcmd == "rm" and len(src_parts) > 2:
                try:
                    sid = int(src_parts[2])
                except ValueError:
                    print("Usage: :source rm <id>\n")
                    continue
                if delete_source(conn, sid):
                    print(f"Source #{sid} deleted.\n")
                else:
                    print(f"Source #{sid} not found.\n")
            else:
                print("Usage: :source add <name> | :source list | :source rm <id>\n")
            continue

        if stripped.startswith(":"):
            print(f"Unknown command: {stripped.split()[0]}. Type :help\n")
            continue

        # ── Normal log input ──────────────────────────────────────
        result = process_single_log(raw, conn, history)

        if result["action"] == "blocked":
            print(f"BLOCKED: {result['message']}\n")
            continue

        if result["action"] == "error":
            print(f"ERROR: {result['message']}\n")
            continue

        if result["action"] == "cached":
            print(f"\n[CACHE HIT] {result['message']}")
            print(f"{result['vrl']}\n")
            if len(result.get("all_variants", [])) > 1:
                print(f"  Other variants: {', '.join(v['variant'] for v in result['all_variants'][1:])}")
                print()
            continue

        # action == "generated"
        print(f"\n[NEW] {result['message']}")
        print(f"{result['vrl']}\n")

        # Update conversation history
        history.append({"role": "user", "content": raw.strip()})
        history.append({"role": "assistant", "content": result.get("raw_response", result["vrl"])})
        history = history[-6:]

        # Ask to save
        try:
            save_input = input("Save? [y/N/label] source=[name] variant=[name]: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye.")
            break

        if not save_input or save_input.lower() in ("n", "no"):
            print("(not saved)\n")
            continue

        # Parse save options
        source_id = None
        variant = "default"
        label = ""
        ocsf_class = ""

        tokens = save_input.split()
        label_parts = []
        for tok in tokens:
            if tok.startswith("source="):
                sname = tok[7:]
                source_id = create_source(conn, sname)
            elif tok.startswith("variant="):
                variant = tok[8:]
            elif tok.startswith("ocsf="):
                ocsf_class = tok[5:]
            elif tok.lower() in ("y", "yes"):
                pass
            else:
                label_parts.append(tok)

        label = " ".join(label_parts)

        pid = save_parser(
            conn,
            result["signature"],
            result["vrl"],
            raw.strip(),
            label=label,
            variant=variant,
            source_id=source_id,
            ocsf_class=ocsf_class,
        )
        label_str = f" [{label}]" if label else ""
        print(f"Saved as parser #{pid}{label_str} (variant={variant}).\n")


if __name__ == "__main__":
    cli_main()

"""
SQLite pattern library with multi-variant parser support.

Each log "source" (e.g. nginx, syslog, app-payments) can have multiple
signatures, and each signature can have multiple parser variants — because
the same structural shape may need different parsing depending on context.
"""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "vrl_patterns.db"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db(db_path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS sources (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS parsers (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id   INTEGER REFERENCES sources(id) ON DELETE SET NULL,
            signature   TEXT NOT NULL,
            variant     TEXT NOT NULL DEFAULT 'default',
            label       TEXT NOT NULL DEFAULT '',
            vrl_code    TEXT NOT NULL,
            sample_log  TEXT NOT NULL,
            ocsf_class  TEXT NOT NULL DEFAULT '',
            hits        INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_parsers_sig
            ON parsers(signature);
        CREATE INDEX IF NOT EXISTS idx_parsers_source
            ON parsers(source_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_parsers_sig_variant
            ON parsers(signature, variant);
    """)
    conn.commit()
    return conn


# ── Sources ───────────────────────────────────────────────────────────────────

def create_source(conn: sqlite3.Connection, name: str, description: str = "") -> int:
    now = _now()
    cur = conn.execute(
        "INSERT OR IGNORE INTO sources (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (name, description, now, now),
    )
    conn.commit()
    if cur.lastrowid:
        return cur.lastrowid
    row = conn.execute("SELECT id FROM sources WHERE name = ?", (name,)).fetchone()
    return row["id"]


def list_sources(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """SELECT s.id, s.name, s.description, count(p.id) as parser_count
           FROM sources s LEFT JOIN parsers p ON p.source_id = s.id
           GROUP BY s.id ORDER BY s.name"""
    ).fetchall()
    return [dict(r) for r in rows]


def delete_source(conn: sqlite3.Connection, source_id: int) -> bool:
    cur = conn.execute("DELETE FROM sources WHERE id = ?", (source_id,))
    conn.commit()
    return cur.rowcount > 0


# ── Parsers ───────────────────────────────────────────────────────────────────

def lookup_parsers(conn: sqlite3.Connection, signature: str) -> list[dict]:
    """Return all parser variants for a given signature, ordered by hits."""
    rows = conn.execute(
        """SELECT p.id, p.signature, p.variant, p.label, p.vrl_code,
                  p.sample_log, p.ocsf_class, p.hits, p.source_id,
                  s.name as source_name
           FROM parsers p LEFT JOIN sources s ON p.source_id = s.id
           WHERE p.signature = ?
           ORDER BY p.hits DESC""",
        (signature,),
    ).fetchall()
    if not rows:
        return []
    # bump hit count on the top-used variant
    conn.execute(
        "UPDATE parsers SET hits = hits + 1, updated_at = ? WHERE id = ?",
        (_now(), rows[0]["id"]),
    )
    conn.commit()
    return [dict(r) for r in rows]


def save_parser(
    conn: sqlite3.Connection,
    signature: str,
    vrl_code: str,
    sample_log: str,
    label: str = "",
    variant: str = "default",
    source_id: int | None = None,
    ocsf_class: str = "",
) -> int:
    now = _now()
    # if variant already exists for this sig, update it
    existing = conn.execute(
        "SELECT id FROM parsers WHERE signature = ? AND variant = ?",
        (signature, variant),
    ).fetchone()
    if existing:
        conn.execute(
            """UPDATE parsers SET vrl_code = ?, sample_log = ?, label = ?,
               source_id = ?, ocsf_class = ?, updated_at = ? WHERE id = ?""",
            (vrl_code, sample_log, label, source_id, ocsf_class, now, existing["id"]),
        )
        conn.commit()
        return existing["id"]

    cur = conn.execute(
        """INSERT INTO parsers
           (signature, variant, label, vrl_code, sample_log, ocsf_class, hits, source_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
        (signature, variant, label, vrl_code, sample_log, ocsf_class, source_id, now, now),
    )
    conn.commit()
    return cur.lastrowid


def list_parsers(conn: sqlite3.Connection, source_id: int | None = None) -> list[dict]:
    if source_id is not None:
        rows = conn.execute(
            """SELECT p.id, p.signature, p.variant, p.label, p.ocsf_class,
                      p.hits, p.created_at, substr(p.sample_log, 1, 80) as sample,
                      s.name as source_name
               FROM parsers p LEFT JOIN sources s ON p.source_id = s.id
               WHERE p.source_id = ?
               ORDER BY p.hits DESC""",
            (source_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT p.id, p.signature, p.variant, p.label, p.ocsf_class,
                      p.hits, p.created_at, substr(p.sample_log, 1, 80) as sample,
                      s.name as source_name
               FROM parsers p LEFT JOIN sources s ON p.source_id = s.id
               ORDER BY p.hits DESC"""
        ).fetchall()
    return [dict(r) for r in rows]


def get_parser(conn: sqlite3.Connection, parser_id: int) -> dict | None:
    row = conn.execute(
        """SELECT p.*, s.name as source_name
           FROM parsers p LEFT JOIN sources s ON p.source_id = s.id
           WHERE p.id = ?""",
        (parser_id,),
    ).fetchone()
    return dict(row) if row else None


def delete_parser(conn: sqlite3.Connection, parser_id: int) -> bool:
    cur = conn.execute("DELETE FROM parsers WHERE id = ?", (parser_id,))
    conn.commit()
    return cur.rowcount > 0


def update_parser_label(conn: sqlite3.Connection, parser_id: int, label: str) -> bool:
    cur = conn.execute(
        "UPDATE parsers SET label = ?, updated_at = ? WHERE id = ?",
        (label, _now(), parser_id),
    )
    conn.commit()
    return cur.rowcount > 0


def parser_count(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT count(*) as c FROM parsers").fetchone()["c"]

/**
 * SQLite pattern library using sql.js (pure WASM, no native deps).
 * Cross-platform — works on macOS, Linux, Windows without recompilation.
 *
 * DB is persisted to disk in the extension's globalStorageUri.
 */

// Use the asm.js build — pure JS, no WASM file needed, works everywhere
import initSqlJs, { Database as SqlJsDatabase } from "sql.js/dist/sql-asm.js";
import * as fs from "fs";
import * as path from "path";

export interface Source {
  id: number;
  name: string;
  description: string;
  parser_count?: number;
}

export interface Parser {
  id: number;
  source_id: number | null;
  signature: string;
  variant: string;
  label: string;
  vrl_code: string;
  sample_log: string;
  ocsf_class: string;
  hits: number;
  created_at: string;
  updated_at: string;
  source_name?: string | null;
}

function now(): string {
  return new Date().toISOString();
}

export class PatternDB {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private ready: Promise<void>;

  constructor(storagePath: string) {
    this.dbPath = path.join(storagePath, "vrl_patterns.db");
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const SQL = await initSqlJs();

    // Load existing DB from disk if it exists
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sources (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `);
    this.db.run(`
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
      )
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_parsers_sig ON parsers(signature)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_parsers_source ON parsers(source_id)");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_parsers_sig_variant ON parsers(signature, variant)");

    this.persist();
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  private persist(): void {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  private queryAll(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    stmt.free();
    return rows;
  }

  private queryOne(sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
    const rows = this.queryAll(sql, params);
    return rows[0];
  }

  private run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params);
  }

  private lastInsertId(): number {
    const row = this.queryOne("SELECT last_insert_rowid() as id");
    return (row?.id as number) ?? 0;
  }

  // ── Sources ──────────────────────────────────────────────────

  createSource(name: string, description = ""): number {
    const ts = now();
    this.run(
      "INSERT OR IGNORE INTO sources (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [name, description, ts, ts],
    );
    const row = this.queryOne("SELECT id FROM sources WHERE name = ?", [name]);
    this.persist();
    return (row?.id as number) ?? 0;
  }

  listSources(): Source[] {
    return this.queryAll(`
      SELECT s.id, s.name, s.description, count(p.id) as parser_count
      FROM sources s LEFT JOIN parsers p ON p.source_id = s.id
      GROUP BY s.id ORDER BY s.name
    `) as unknown as Source[];
  }

  deleteSource(id: number): boolean {
    this.run("DELETE FROM sources WHERE id = ?", [id]);
    const changed = this.db.getRowsModified() > 0;
    if (changed) this.persist();
    return changed;
  }

  // ── Parsers ──────────────────────────────────────────────────

  lookupParsers(signature: string): Parser[] {
    const rows = this.queryAll(`
      SELECT p.*, s.name as source_name
      FROM parsers p LEFT JOIN sources s ON p.source_id = s.id
      WHERE p.signature = ?
      ORDER BY p.hits DESC
    `, [signature]) as unknown as Parser[];

    if (rows.length > 0) {
      this.run("UPDATE parsers SET hits = hits + 1, updated_at = ? WHERE id = ?", [now(), rows[0].id]);
      this.persist();
    }
    return rows;
  }

  saveParser(opts: {
    signature: string;
    vrlCode: string;
    sampleLog: string;
    label?: string;
    variant?: string;
    sourceId?: number | null;
    ocsfClass?: string;
  }): number {
    const {
      signature, vrlCode, sampleLog,
      label = "", variant = "default",
      sourceId = null, ocsfClass = "",
    } = opts;
    const ts = now();

    const existing = this.queryOne(
      "SELECT id FROM parsers WHERE signature = ? AND variant = ?",
      [signature, variant],
    );

    if (existing) {
      this.run(
        `UPDATE parsers SET vrl_code = ?, sample_log = ?, label = ?,
         source_id = ?, ocsf_class = ?, updated_at = ? WHERE id = ?`,
        [vrlCode, sampleLog, label, sourceId, ocsfClass, ts, existing.id],
      );
      this.persist();
      return existing.id as number;
    }

    this.run(
      `INSERT INTO parsers
        (signature, variant, label, vrl_code, sample_log, ocsf_class, hits, source_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [signature, variant, label, vrlCode, sampleLog, ocsfClass, sourceId, ts, ts],
    );
    const id = this.lastInsertId();
    this.persist();
    return id;
  }

  listParsers(sourceId?: number): Parser[] {
    if (sourceId !== undefined) {
      return this.queryAll(`
        SELECT p.*, substr(p.sample_log, 1, 80) as sample_log, s.name as source_name
        FROM parsers p LEFT JOIN sources s ON p.source_id = s.id
        WHERE p.source_id = ?
        ORDER BY p.hits DESC
      `, [sourceId]) as unknown as Parser[];
    }
    return this.queryAll(`
      SELECT p.*, substr(p.sample_log, 1, 80) as sample_log, s.name as source_name
      FROM parsers p LEFT JOIN sources s ON p.source_id = s.id
      ORDER BY p.hits DESC
    `) as unknown as Parser[];
  }

  getParser(id: number): Parser | undefined {
    return this.queryOne(`
      SELECT p.*, s.name as source_name
      FROM parsers p LEFT JOIN sources s ON p.source_id = s.id
      WHERE p.id = ?
    `, [id]) as unknown as Parser | undefined;
  }

  deleteParser(id: number): boolean {
    this.run("DELETE FROM parsers WHERE id = ?", [id]);
    const changed = this.db.getRowsModified() > 0;
    if (changed) this.persist();
    return changed;
  }

  updateLabel(id: number, label: string): boolean {
    this.run("UPDATE parsers SET label = ?, updated_at = ? WHERE id = ?", [label, now(), id]);
    const changed = this.db.getRowsModified() > 0;
    if (changed) this.persist();
    return changed;
  }

  parserCount(): number {
    const row = this.queryOne("SELECT count(*) as c FROM parsers");
    return (row?.c as number) ?? 0;
  }

  clearAll(): void {
    this.run("DELETE FROM parsers");
    this.run("DELETE FROM sources");
    this.persist();
  }

  close(): void {
    this.persist();
    this.db.close();
  }
}

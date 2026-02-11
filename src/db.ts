import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DB_DIR = process.env.ANTFARM_DB_DIR || path.join(os.homedir(), ".openclaw", "antfarm");
const DB_PATH = process.env.ANTFARM_DB_PATH || path.join(DB_DIR, "antfarm.db");

let _db: DatabaseSync | null = null;
let _dbOpenedAt = 0;
const DB_MAX_AGE_MS = 5000;

export function getDb(): DatabaseSync {
  const now = Date.now();
  if (_db && (now - _dbOpenedAt) < DB_MAX_AGE_MS) return _db;
  if (_db) { try { _db.close(); } catch {} }

  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new DatabaseSync(DB_PATH);
  _dbOpenedAt = now;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  migrate(_db);
  monitorRunCount(_db);
  return _db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL,
      expects TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backlog_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      target_workflow TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Add columns to steps table for backwards compat
  const cols = db.prepare("PRAGMA table_info(steps)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("type")) {
    db.exec("ALTER TABLE steps ADD COLUMN type TEXT NOT NULL DEFAULT 'single'");
  }
  if (!colNames.has("loop_config")) {
    db.exec("ALTER TABLE steps ADD COLUMN loop_config TEXT");
  }
  if (!colNames.has("current_story_id")) {
    db.exec("ALTER TABLE steps ADD COLUMN current_story_id TEXT");
  }
}

export function getDbPath(): string {
  return DB_PATH;
}

function getBackupsDir(): string {
  return path.join(DB_DIR, "backups");
}

function getRunCountStatePath(): string {
  return path.join(DB_DIR, "run-count-state.json");
}

function appendAlert(line: string): void {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.appendFileSync(path.join(DB_DIR, "alerts.log"), `${line}\n`, "utf-8");
  } catch {
    // best-effort
  }
}

/**
 * Create a timestamped snapshot of the Antfarm DB before risky operations.
 */
export function backupDatabaseSnapshot(reason: string): string | null {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    fs.mkdirSync(getBackupsDir(), { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeReason = reason.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
    const file = path.join(getBackupsDir(), `${ts}__${safeReason}.db`);

    fs.copyFileSync(DB_PATH, file);

    const wal = `${DB_PATH}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
      fs.copyFileSync(wal, `${file}-wal`);
    }

    const shm = `${DB_PATH}-shm`;
    if (fs.existsSync(shm) && fs.statSync(shm).size > 0) {
      fs.copyFileSync(shm, `${file}-shm`);
    }

    return file;
  } catch {
    return null;
  }
}

/**
 * Detect abrupt run-count drops and persist an alert for visibility.
 */
function monitorRunCount(db: DatabaseSync): void {
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM runs").get() as { cnt: number };
    const current = Number(row?.cnt ?? 0);
    const statePath = getRunCountStatePath();

    let previous = current;
    try {
      const prev = JSON.parse(fs.readFileSync(statePath, "utf-8")) as { count?: number };
      previous = Number(prev?.count ?? current);
    } catch {
      previous = current;
    }

    if (current < previous) {
      appendAlert(`[${new Date().toISOString()}] RUN_COUNT_DROP previous=${previous} current=${current} db=${DB_PATH}`);
      // Surface in stdout/stderr so operators notice immediately.
      console.warn(`⚠️  Antfarm run count dropped from ${previous} to ${current}. Snapshot/restore may be needed.`);
    }

    fs.writeFileSync(statePath, JSON.stringify({ count: current, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
  } catch {
    // best-effort
  }
}

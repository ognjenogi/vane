import Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scheduledJobs } from '@/lib/db/schema';

const REPO_MIGRATIONS_DIR = path.join(process.cwd(), 'drizzle');

/** SQL declared type that SQLite reports for each drizzle column type. */
const SQL_TYPE_BY_COLUMN_TYPE: Record<string, string> = {
  SQLiteText: 'TEXT',
  SQLiteTextJson: 'TEXT',
  SQLiteInteger: 'INTEGER',
};

/**
 * The contract for `scheduled_jobs`, column for column. The key order is the
 * declared column order; the values pin the SQL type, the NOT NULL flag and the
 * DEFAULT clause so the hand written migration cannot drift from the drizzle
 * schema.
 */
const EXPECTED_COLUMNS: Record<
  string,
  { type: string; notnull: number; dflt_value: string | null }
> = {
  id: { type: 'TEXT', notnull: 1, dflt_value: null },
  title: { type: 'TEXT', notnull: 1, dflt_value: null },
  prompt: { type: 'TEXT', notnull: 1, dflt_value: null },
  chatId: { type: 'TEXT', notnull: 1, dflt_value: null },
  intervalMinutes: { type: 'INTEGER', notnull: 1, dflt_value: null },
  endType: { type: 'TEXT', notnull: 1, dflt_value: "'never'" },
  maxRuns: { type: 'INTEGER', notnull: 0, dflt_value: null },
  runUntil: { type: 'TEXT', notnull: 0, dflt_value: null },
  status: { type: 'TEXT', notnull: 1, dflt_value: "'active'" },
  runCount: { type: 'INTEGER', notnull: 1, dflt_value: '0' },
  lastRunAt: { type: 'TEXT', notnull: 0, dflt_value: null },
  nextRunAt: { type: 'TEXT', notnull: 0, dflt_value: null },
  lastError: { type: 'TEXT', notnull: 0, dflt_value: null },
  optimizationMode: { type: 'TEXT', notnull: 1, dflt_value: "'balanced'" },
  sources: { type: 'TEXT', notnull: 0, dflt_value: `'["web"]'` },
  chatModel: { type: 'TEXT', notnull: 0, dflt_value: "'null'" },
  embeddingModel: { type: 'TEXT', notnull: 0, dflt_value: "'null'" },
  projectId: { type: 'TEXT', notnull: 0, dflt_value: null },
  createdAt: { type: 'TEXT', notnull: 1, dflt_value: null },
  updatedAt: { type: 'TEXT', notnull: 1, dflt_value: null },
};

describe('db migrations', () => {
  let tmpDir: string;
  let db: Database.Database;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalDataDir = process.env.DATA_DIR;

  beforeAll(async () => {
    // A throwaway DATA_DIR so the real data/db.sqlite is never touched.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-migrate-'));
    fs.mkdirSync(path.join(tmpDir, 'drizzle'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });

    for (const file of fs.readdirSync(REPO_MIGRATIONS_DIR)) {
      if (file.endsWith('.sql')) {
        fs.copyFileSync(
          path.join(REPO_MIGRATIONS_DIR, file),
          path.join(tmpDir, 'drizzle', file),
        );
      }
    }

    // migrate.ts resolves DATA_DIR at import time, so set it, drop the module
    // registry and import dynamically.
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('@/lib/db/migrate');

    db = new Database(path.join(tmpDir, 'data', 'db.sqlite'));
  });

  afterAll(() => {
    logSpy.mockRestore();
    db.close();
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const tableNames = () =>
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name);

  it('applies every migration to a fresh database', () => {
    const applied = (
      db.prepare('SELECT name FROM ran_migrations').all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    expect(applied).toEqual(
      expect.arrayContaining(['0000', '0001', '0002', '0003', '0004']),
    );
    // Regression: 0003 must still apply on top of the fresh database.
    expect(tableNames()).toContain('projects');
  });

  it('creates the scheduled_jobs table', () => {
    expect(tableNames()).toContain('scheduled_jobs');
  });

  it('gives scheduled_jobs the expected columns, types and defaults', () => {
    const columns = db.prepare('PRAGMA table_info(scheduled_jobs)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];

    expect(columns.map((c) => c.name)).toEqual(Object.keys(EXPECTED_COLUMNS));

    columns.forEach((column) => {
      expect({
        type: column.type,
        notnull: column.notnull,
        dflt_value: column.dflt_value,
      }).toEqual(EXPECTED_COLUMNS[column.name]);
    });

    const id = columns.find((c) => c.name === 'id')!;
    expect(id.pk).toBe(1);
  });

  it('matches the scheduledJobs drizzle schema column for column', () => {
    const config = getTableConfig(scheduledJobs);

    const columns = db.prepare('PRAGMA table_info(scheduled_jobs)').all() as {
      name: string;
      type: string;
      notnull: number;
    }[];

    expect(columns.map((c) => c.name)).toEqual(
      config.columns.map((c) => c.name),
    );

    columns.forEach((column, index) => {
      const schemaColumn = config.columns[index];
      expect({
        type: column.type,
        notNull: column.notnull === 1,
      }).toEqual({
        type: SQL_TYPE_BY_COLUMN_TYPE[schemaColumn.columnType],
        notNull: schemaColumn.notNull,
      });
    });
  });

  it('creates the scheduled_jobs next-run index', () => {
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_scheduled_jobs_next_run'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);

    expect(indexes).toEqual(['idx_scheduled_jobs_next_run']);

    const indexed = (
      db.prepare('PRAGMA index_info(idx_scheduled_jobs_next_run)').all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    expect(indexed).toEqual(['status', 'nextRunAt']);
  });

  it('applies column defaults when only the required fields are inserted', () => {
    const now = '2026-01-01T00:00:00.000Z';

    db.prepare(
      `INSERT INTO scheduled_jobs
        (id, title, prompt, chatId, intervalMinutes, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'job-1',
      'Daily digest',
      'Summarize the news',
      'chat-1',
      1440,
      now,
      now,
    );

    const row = db
      .prepare('SELECT * FROM scheduled_jobs WHERE id = ?')
      .get('job-1') as Record<string, any>;

    expect(row.endType).toBe('never');
    expect(row.status).toBe('active');
    expect(row.runCount).toBe(0);
    expect(row.optimizationMode).toBe('balanced');
    expect(row.sources).toBe('["web"]');
    expect(JSON.parse(row.sources)).toEqual(['web']);
    // `'null'` is stored so drizzle's json mode parses it back to `null`.
    expect(JSON.parse(row.chatModel)).toBeNull();
    expect(JSON.parse(row.embeddingModel)).toBeNull();
    expect(row.maxRuns).toBeNull();
    expect(row.runUntil).toBeNull();
    expect(row.lastRunAt).toBeNull();
    expect(row.nextRunAt).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.projectId).toBeNull();
  });
});

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InMemoryRepository, type Repository } from '../common/repository.js';
import { MIGRATIONS } from './migrations.js';

/** Factory for named collections. Services depend on this, never on a concrete database. */
export interface Storage {
  repo<T extends { id: string }>(collection: string): Repository<T>;
  close(): void;
}

export class InMemoryStorage implements Storage {
  private readonly repos = new Map<string, Repository<{ id: string }>>();
  repo<T extends { id: string }>(collection: string): Repository<T> {
    let r = this.repos.get(collection);
    if (!r) {
      r = new InMemoryRepository<{ id: string }>();
      this.repos.set(collection, r);
    }
    return r as unknown as Repository<T>;
  }
  close(): void {}
}

/**
 * Durable storage on SQLite via node:sqlite (experimental in Node 22; emits an ExperimentalWarning).
 * Documents are stored as JSON per collection. This is the interim durable store: the same
 * Repository port is the seam for a PostgreSQL/Prisma implementation (see README).
 */
export class SqliteStorage implements Storage {
  readonly db: DatabaseSync;

  constructor(path: string) {
    // A first start with DATABASE_FILE=./data/dev.db must not fail just because ./data does not exist yet.
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const done = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  schemaVersion(): number {
    return (this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
  }

  repo<T extends { id: string }>(collection: string): Repository<T> {
    return new SqliteRepository<T>(this.db, collection);
  }

  close(): void {
    this.db.close();
  }
}

class SqliteRepository<T extends { id: string }> implements Repository<T> {
  constructor(
    private readonly db: DatabaseSync,
    private readonly collection: string,
  ) {}

  async get(id: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT body FROM documents WHERE collection = ? AND id = ?').get(this.collection, id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : undefined;
  }

  async put(entity: T): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO documents (collection, id, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (collection, id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at',
      )
      .run(this.collection, entity.id, JSON.stringify(entity), new Date().toISOString());
  }

  async list(): Promise<T[]> {
    const rows = this.db.prepare('SELECT body FROM documents WHERE collection = ? ORDER BY rowid').all(this.collection) as { body: string }[];
    return rows.map((r) => JSON.parse(r.body) as T);
  }

  async find(pred: (e: T) => boolean): Promise<T[]> {
    return (await this.list()).filter(pred);
  }
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/persistence/migrations.js';
import { InMemoryStorage, SqliteStorage, type Storage } from '../src/persistence/storage.js';

interface Doc {
  id: string;
  n: number;
  nested?: { a: string };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpFile = () => {
  const d = mkdtempSync(join(tmpdir(), 'unbound-'));
  dirs.push(d);
  return join(d, 'test.db');
};

const impls: [string, () => Storage][] = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(':memory:')],
];

describe.each(impls)('Repository contract: %s', (_n, make) => {
  it('put/get/list/find with value semantics', async () => {
    const s = make();
    const r = s.repo<Doc>('docs');
    await r.put({ id: 'a', n: 1, nested: { a: 'x' } });
    await r.put({ id: 'b', n: 2 });
    const a = (await r.get('a'))!;
    a.n = 99; // mutating a read must not change stored data
    expect((await r.get('a'))!.n).toBe(1);
    expect((await r.list()).map((d) => d.id)).toEqual(['a', 'b']);
    expect((await r.find((d) => d.n > 1)).map((d) => d.id)).toEqual(['b']);
    expect(await r.get('missing')).toBeUndefined();
  });
  it('put replaces and collections are isolated', async () => {
    const s = make();
    await s.repo<Doc>('one').put({ id: 'a', n: 1 });
    await s.repo<Doc>('two').put({ id: 'a', n: 2 });
    await s.repo<Doc>('one').put({ id: 'a', n: 3 });
    expect((await s.repo<Doc>('one').get('a'))!.n).toBe(3);
    expect((await s.repo<Doc>('two').get('a'))!.n).toBe(2);
    expect(await s.repo<Doc>('one').list()).toHaveLength(1);
  });
});

describe('SqliteStorage durability and migrations', () => {
  it('data survives closing and reopening the database file', async () => {
    const file = tmpFile();
    const s1 = new SqliteStorage(file);
    await s1.repo<Doc>('docs').put({ id: 'a', n: 7 });
    s1.close();
    const s2 = new SqliteStorage(file);
    expect((await s2.repo<Doc>('docs').get('a'))!.n).toBe(7);
    s2.close();
  });
  it('applies migrations once and records the schema version', () => {
    const file = tmpFile();
    const s1 = new SqliteStorage(file);
    const v = s1.schemaVersion();
    s1.close();
    const s2 = new SqliteStorage(file);
    expect(s2.schemaVersion()).toBe(v);
    expect(v).toBe(MIGRATIONS.at(-1)!.version);
    expect((s2.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c).toBe(MIGRATIONS.length);
    s2.close();
  });
  it('migration versions are unique and ascending', () => {
    const vs = MIGRATIONS.map((m) => m.version);
    expect(vs).toEqual([...vs].sort((a, b) => a - b));
    expect(new Set(vs).size).toBe(vs.length);
  });
});

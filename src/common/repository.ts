/**
 * Persistence port. The only implementation today is InMemoryRepository (a labeled TEST/DEV
 * adapter): data is lost on restart. A PostgreSQL/Prisma implementation is future work (see README).
 */
export interface Repository<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(entity: T): Promise<void>;
  list(): Promise<T[]>;
  find(pred: (e: T) => boolean): Promise<T[]>;
}

export class InMemoryRepository<T extends { id: string }> implements Repository<T> {
  private readonly rows = new Map<string, T>();
  async get(id: string): Promise<T | undefined> {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async put(entity: T): Promise<void> {
    this.rows.set(entity.id, structuredClone(entity));
  }
  async list(): Promise<T[]> {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
  async find(pred: (e: T) => boolean): Promise<T[]> {
    return (await this.list()).filter(pred);
  }
}

/** Serializes async work per key so concurrent duplicate requests run one at a time. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(key, next.catch(() => undefined));
    return next;
  }
}

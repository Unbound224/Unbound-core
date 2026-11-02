/** Ordered, append-only schema migrations. Never edit an applied migration; add a new one. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'documents',
    sql: `
      CREATE TABLE documents (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX documents_by_collection ON documents (collection);
    `,
  },
];

import { createRequire } from "node:module";

export interface SqliteDb {
  exec(sql: string): void;
  queryAll(sql: string, params?: unknown[]): Record<string, unknown>[];
  close(): void;
}

const requireMod = createRequire(import.meta.url);

export function openSqlite(filename = ":memory:"): SqliteDb {
  if (typeof process !== "undefined" && process.versions && process.versions.bun) {
    const { Database } = requireMod("bun:sqlite") as {
      Database: new (path: string) => {
        exec(sql: string): void;
        query(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
        close(): void;
      };
    };
    const db = new Database(filename);
    return {
      exec(sql: string) {
        db.exec(sql);
      },
      queryAll(sql: string, params: unknown[] = []) {
        return db.query(sql).all(...params);
      },
      close() {
        db.close();
      }
    };
  }

  const { DatabaseSync } = requireMod("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
      close(): void;
    };
  };
  const db = new DatabaseSync(filename);
  return {
    exec(sql: string) {
      db.exec(sql);
    },
    queryAll(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...params);
    },
    close() {
      db.close();
    }
  };
}

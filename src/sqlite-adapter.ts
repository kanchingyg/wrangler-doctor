import { createRequire } from "node:module";

/**
 * Minimal synchronous SQLite database handle backed by `bun:sqlite` on Bun
 * or `node:sqlite` (`DatabaseSync`) on Node.js 22.5+.
 */
export interface SqliteDb {
  /** Executes one or more SQL statements without returning rows. */
  exec(sql: string): void;
  /** Executes a parameterized query and returns all matching rows as plain objects. */
  queryAll(sql: string, params?: unknown[]): Record<string, unknown>[];
  /** Closes the underlying SQLite database connection. */
  close(): void;
}

const requireMod = createRequire(import.meta.url);

/**
 * Opens a SQLite database file or `:memory:` instance using the runtime's
 * built-in SQLite driver (`bun:sqlite` or `node:sqlite`).
 *
 * @param filename - Path to the SQLite file or `":memory:"`.
 * @returns Synchronous `SqliteDb` wrapper.
 */
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

import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerConfig } from "../engines/env-matrix.js";
import { openSqlite, type SqliteDb } from "../sqlite-adapter.js";

export interface D1PreparedStatementLike {
  readonly query: string;
  readonly params: unknown[];
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: true;
    meta: { duration: number; rows_read: number; rows_written: number };
  }>;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run(): Promise<{
    results: [];
    success: true;
    meta: { duration: number; rows_read: number; rows_written: number };
  }>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = unknown>(
    statements: D1PreparedStatementLike[]
  ): Promise<
    Array<{
      results: T[];
      success: true;
      meta: { duration: number; rows_read: number; rows_written: number };
    }>
  >;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export function createD1BindingFromSqlite(db: SqliteDb): D1DatabaseLike {
  const makeStmt = (query: string, boundParams: unknown[] = []): D1PreparedStatementLike => {
    if (boundParams.length > 100) {
      throw new Error(
        `D1_ERROR: Too many bound parameters (${boundParams.length} > 100 limit; see workers-sdk#6226)`
      );
    }
    return {
      query,
      params: boundParams,
      bind(...values: unknown[]) {
        return makeStmt(query, values);
      },
      async all<T = Record<string, unknown>>() {
        const start = performance.now();
        const rows = db.queryAll(query, boundParams) as T[];
        return {
          results: rows,
          success: true as const,
          meta: {
            duration: performance.now() - start,
            rows_read: rows.length,
            rows_written: 0
          }
        };
      },
      async first<T = Record<string, unknown>>(colName?: string) {
        const rows = db.queryAll(query, boundParams);
        if (rows.length === 0) return null;
        const firstRow = rows[0];
        if (colName !== undefined) {
          return (firstRow[colName] as T) ?? null;
        }
        return firstRow as T;
      },
      async run() {
        const start = performance.now();
        db.queryAll(query, boundParams);
        return {
          results: [] as [],
          success: true as const,
          meta: {
            duration: performance.now() - start,
            rows_read: 0,
            rows_written: 1
          }
        };
      },
      async raw<T = unknown[]>() {
        const rows = db.queryAll(query, boundParams);
        return rows.map((r) => Object.values(r) as unknown as T);
      }
    };
  };

  return {
    prepare(query: string) {
      return makeStmt(query, []);
    },
    async batch<T = unknown>(statements: D1PreparedStatementLike[]) {
      const results: Array<{
        results: T[];
        success: true;
        meta: { duration: number; rows_read: number; rows_written: number };
      }> = [];
      db.exec("SAVEPOINT _d1_batch;");
      try {
        for (const stmt of statements) {
          const res = await stmt.all<T>();
          results.push(res);
        }
        db.exec("RELEASE SAVEPOINT _d1_batch;");
        return results;
      } catch (err) {
        db.exec("ROLLBACK TO SAVEPOINT _d1_batch;");
        db.exec("RELEASE SAVEPOINT _d1_batch;");
        throw err;
      }
    },
    async exec(query: string) {
      if (/\bBEGIN\s+(?:TRANSACTION|IMMEDIATE|DEFERRED|EXCLUSIVE)\b/i.test(query)) {
        throw new Error(
          "D1_EXEC_ERROR: Interactive transactions are not supported in D1 (see workers-sdk#2733)"
        );
      }
      const start = performance.now();
      db.exec(query);
      const count = query
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean).length;
      return { count, duration: performance.now() - start };
    }
  };
}

export interface D1SnapshotSeederOptions {
  migrationsDir: string;
  seedSql?: string;
  tmpPrefix?: string;
}

export interface ClonedD1Snapshot {
  sqlitePath: string;
  db: SqliteDb;
  d1: D1DatabaseLike;
  elapsedMs: number;
  cleanup(): void;
}

export interface D1SnapshotSeeder {
  readonly masterSqlitePath: string;
  readonly appliedMigrations: string[];
  cloneForTestFile(label?: string): ClonedD1Snapshot;
  cleanupAll(): void;
}

function copyFileFast(src: string, dest: string): void {
  try {
    copyFileSync(src, dest, fsConstants.COPYFILE_FICLONE);
  } catch {
    copyFileSync(src, dest);
  }
}

export function createD1SnapshotSeeder(
  options: D1SnapshotSeederOptions
): D1SnapshotSeeder {
  const workDir = mkdtempSync(join(tmpdir(), options.tmpPrefix ?? "wrangler-doctor-d1-"));
  const masterSqlitePath = join(workDir, "master-seed.sqlite");
  const appliedMigrations: string[] = [];

  const masterDb = openSqlite(masterSqlitePath);
  try {
    masterDb.exec("PRAGMA journal_mode = DELETE;");
    masterDb.exec("PRAGMA synchronous = OFF;");
    if (existsSync(options.migrationsDir)) {
      const files = readdirSync(options.migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const file of files) {
        const sql = readFileSync(join(options.migrationsDir, file), "utf8");
        masterDb.exec(sql);
        appliedMigrations.push(file);
      }
    }
    if (options.seedSql) {
      masterDb.exec(options.seedSql);
    }
  } finally {
    masterDb.close();
  }

  let cloneCounter = 0;

  return {
    masterSqlitePath,
    appliedMigrations,
    cloneForTestFile(label = "test"): ClonedD1Snapshot {
      const start = performance.now();
      cloneCounter++;
      const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
      const sqlitePath = join(workDir, `clone-${cloneCounter}-${safeLabel}.sqlite`);
      copyFileFast(masterSqlitePath, sqlitePath);
      const db = openSqlite(sqlitePath);
      const d1 = createD1BindingFromSqlite(db);
      const elapsedMs = performance.now() - start;

      return {
        sqlitePath,
        db,
        d1,
        elapsedMs,
        cleanup() {
          try {
            db.close();
          } catch {
            // ignore
          }
          try {
            rmSync(sqlitePath, { force: true });
          } catch {
            // ignore
          }
        }
      };
    },
    cleanupAll() {
      rmSync(workDir, { recursive: true, force: true });
    }
  };
}

export interface CreateCfTestEnvOptions {
  projectDir: string;
  env?: string;
  d1MigrationsDir?: string;
  seedSql?: string;
  vars?: Record<string, string>;
}

export interface CfTestEnvHandle<TEnv = Record<string, unknown>> {
  env: TEnv;
  sentQueueMessages: Record<string, unknown[]>;
  resetD1(): void;
  dispose(): void;
}

function createInMemoryKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string, type?: "text" | "json") {
      const val = store.get(key);
      if (val === undefined) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
    async put(key: string, value: string) {
      store.set(key, String(value));
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string }) {
      const keys = [...store.keys()]
        .filter((k) => (!opts?.prefix ? true : k.startsWith(opts.prefix)))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    }
  };
}

function createInMemoryR2() {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key: string, value: string | Uint8Array | ArrayBuffer) {
      if (typeof value === "string") {
        objects.set(key, new TextEncoder().encode(value));
      } else if (value instanceof ArrayBuffer) {
        objects.set(key, new Uint8Array(value));
      } else {
        objects.set(key, value);
      }
      return { key };
    },
    async get(key: string) {
      const buf = objects.get(key);
      if (!buf) return null;
      return {
        key,
        size: buf.byteLength,
        async text() {
          return new TextDecoder().decode(buf);
        },
        async json<T = unknown>() {
          return JSON.parse(new TextDecoder().decode(buf)) as T;
        },
        async arrayBuffer() {
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
      };
    },
    async delete(key: string) {
      objects.delete(key);
    }
  };
}

export function createCfTestEnv<TEnv = Record<string, unknown>>(
  options: CreateCfTestEnvOptions
): CfTestEnvHandle<TEnv> {
  const parsed = parseWorkerConfig(options.projectDir);
  const envObj: Record<string, unknown> = {};
  const sentQueueMessages: Record<string, unknown[]> = {};

  const migrationsDir =
    options.d1MigrationsDir ??
    (parsed?.d1Configs[0]?.migrations_dir
      ? join(options.projectDir, parsed.d1Configs[0].migrations_dir)
      : join(options.projectDir, "migrations"));

  const seeder = createD1SnapshotSeeder({
    migrationsDir,
    seedSql: options.seedSql
  });

  const activeClones: ClonedD1Snapshot[] = [];
  const d1Bindings: string[] = [];

  if (parsed) {
    const targetSet =
      options.env && parsed.envBindings[options.env]
        ? parsed.envBindings[options.env]
        : parsed.topLevelBindings;

    for (const [k, v] of Object.entries(parsed.varsValues)) {
      if (!k.includes(".")) envObj[k] = v;
    }
    if (options.env) {
      for (const [k, v] of Object.entries(parsed.varsValues)) {
        if (k.startsWith(`${options.env}.`)) {
          envObj[k.slice(options.env.length + 1)] = v;
        }
      }
    }

    for (const b of targetSet.d1_databases) {
      d1Bindings.push(b);
      const clone = seeder.cloneForTestFile(b);
      activeClones.push(clone);
      envObj[b] = clone.d1;
    }
    for (const b of targetSet.kv_namespaces) {
      envObj[b] = createInMemoryKv();
    }
    for (const b of targetSet.r2_buckets) {
      envObj[b] = createInMemoryR2();
    }
    for (const b of targetSet.queues_producers) {
      sentQueueMessages[b] = [];
      envObj[b] = {
        async send(body: unknown) {
          sentQueueMessages[b].push(body);
        },
        async sendBatch(messages: Array<{ body: unknown }>) {
          for (const m of messages) sentQueueMessages[b].push(m.body);
        }
      };
    }
  } else {
    // Fallback if only cloudflare.config.ts exists without wrangler.jsonc/toml
    const cfConfigPath = join(options.projectDir, "cloudflare.config.ts");
    if (existsSync(cfConfigPath)) {
      const raw = readFileSync(cfConfigPath, "utf8");
      const d1Match = raw.match(/binding\s*:\s*["']([A-Za-z0-9_]+)["']/);
      const bName = d1Match ? d1Match[1] : "DB";
      d1Bindings.push(bName);
      const clone = seeder.cloneForTestFile(bName);
      activeClones.push(clone);
      envObj[bName] = clone.d1;
    }
  }

  // Load .dev.vars if present
  const devVarsPath = join(options.projectDir, ".dev.vars");
  if (existsSync(devVarsPath)) {
    for (const line of readFileSync(devVarsPath, "utf8").split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m) envObj[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }

  if (options.vars) {
    Object.assign(envObj, options.vars);
  }

  return {
    env: envObj as TEnv,
    sentQueueMessages,
    resetD1() {
      for (const c of activeClones) c.cleanup();
      activeClones.length = 0;
      for (const b of d1Bindings) {
        const clone = seeder.cloneForTestFile(b);
        activeClones.push(clone);
        envObj[b] = clone.d1;
      }
    },
    dispose() {
      for (const c of activeClones) c.cleanup();
      seeder.cleanupAll();
    }
  };
}

export interface WorkflowStepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}

export interface WorkflowStepRecord {
  type: "do" | "sleep" | "sleepUntil" | "waitForEvent";
  name: string;
  attempts: number;
  output?: unknown;
  duration?: string | number;
  eventType?: string;
}

export interface WorkflowStepContext {
  do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<T> | T
  ): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number | string): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: string | number }
  ): Promise<{ payload: T; timestamp: Date; type: string }>;
}

export interface WorkflowEvent<TPayload = unknown> {
  payload: TPayload;
  timestamp: Date;
  instanceId: string;
}

export type WorkflowInstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "rollback"
  | "unknown";

export interface RunWorkflowHarnessOptions<TEnv = Record<string, unknown>> {
  instanceId?: string;
  env?: TEnv;
  ctx?: unknown;
  stepMocks?: Record<string, unknown | (() => unknown | Promise<unknown>)>;
  mockEvents?: Record<string, unknown>;
  simulateRollback?: boolean;
}

export interface WorkflowHarnessResult<TResult = unknown> {
  instanceId: string;
  status: WorkflowInstanceStatus;
  output?: TResult;
  error?: Error;
  steps: WorkflowStepRecord[];
  elapsedMs: number;
}

const WORKFLOW_ID_CONTRACT = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

function assertSerializableStepOutput(stepName: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error(
      `Workflow step "${stepName}" returned a non-serializable ${typeof value}. Cloudflare Workflows require structured/JSON-serializable step outputs.`
    );
  }
  try {
    JSON.stringify(value);
  } catch (err) {
    throw new Error(
      `Workflow step "${stepName}" returned non-serializable output: ${(err as Error).message}`
    );
  }
}

export async function runWorkflowHarness<
  TPayload = unknown,
  TResult = unknown,
  TEnv = Record<string, unknown>
>(
  WorkflowClass: new (
    ctx: unknown,
    env: TEnv
  ) => {
    run(
      event: Readonly<WorkflowEvent<TPayload>>,
      step: WorkflowStepContext
    ): Promise<TResult>;
  },
  payload: TPayload,
  options: RunWorkflowHarnessOptions<TEnv> = {}
): Promise<WorkflowHarnessResult<TResult>> {
  const start = performance.now();
  const instanceId = options.instanceId ?? "wf-test-instance-1";

  if (instanceId.length > 64 || !WORKFLOW_ID_CONTRACT.test(instanceId)) {
    throw new Error(
      `Invalid Workflow instanceId "${instanceId}": must match ^[a-zA-Z0-9_][a-zA-Z0-9-_]*$ and be <= 64 chars (got length ${instanceId.length}).`
    );
  }

  const steps: WorkflowStepRecord[] = [];

  const stepCtx: WorkflowStepContext = {
    async do<T>(
      name: string,
      configOrCb: WorkflowStepConfig | (() => Promise<T> | T),
      maybeCb?: () => Promise<T> | T
    ): Promise<T> {
      const config = typeof configOrCb === "function" ? undefined : configOrCb;
      const cb = typeof configOrCb === "function" ? configOrCb : maybeCb!;
      const maxAttempts = (config?.retries?.limit ?? 0) + 1;

      if (options.stepMocks && name in options.stepMocks) {
        const mockVal = options.stepMocks[name];
        const resolved =
          typeof mockVal === "function" ? await (mockVal as () => Promise<T>)() : (mockVal as T);
        assertSerializableStepOutput(name, resolved);
        steps.push({ type: "do", name, attempts: 1, output: resolved });
        return resolved;
      }

      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const out = await cb();
          assertSerializableStepOutput(name, out);
          steps.push({ type: "do", name, attempts: attempt, output: out });
          return out;
        } catch (err) {
          lastErr = err;
          if (attempt === maxAttempts) {
            steps.push({ type: "do", name, attempts: attempt });
            throw err;
          }
        }
      }
      throw lastErr;
    },

    async sleep(name: string, duration: string | number): Promise<void> {
      steps.push({ type: "sleep", name, attempts: 1, duration });
    },

    async sleepUntil(name: string, timestamp: Date | number | string): Promise<void> {
      const serialized = timestamp instanceof Date ? timestamp.toISOString() : String(timestamp);
      steps.push({ type: "sleepUntil", name, attempts: 1, duration: serialized });
    },

    async waitForEvent<T = unknown>(
      name: string,
      waitOpts: { type: string; timeout?: string | number }
    ): Promise<{ payload: T; timestamp: Date; type: string }> {
      if (options.mockEvents && waitOpts.type in options.mockEvents) {
        const evPayload = options.mockEvents[waitOpts.type] as T;
        steps.push({
          type: "waitForEvent",
          name,
          attempts: 1,
          eventType: waitOpts.type,
          output: evPayload
        });
        return {
          payload: evPayload,
          timestamp: new Date(),
          type: waitOpts.type
        };
      }
      steps.push({
        type: "waitForEvent",
        name,
        attempts: 1,
        eventType: waitOpts.type
      });
      throw new Error(
        `Workflow step.waitForEvent("${name}") timed out waiting for event type "${waitOpts.type}" (provide options.mockEvents["${waitOpts.type}"] in test).`
      );
    }
  };

  const instance = new WorkflowClass(options.ctx ?? {}, (options.env ?? {}) as TEnv);
  const eventObj: WorkflowEvent<TPayload> = {
    payload,
    timestamp: new Date(),
    instanceId
  };

  if (options.simulateRollback) {
    return {
      instanceId,
      status: "rollback",
      steps,
      elapsedMs: performance.now() - start
    };
  }

  try {
    const output = await instance.run(eventObj, stepCtx);
    assertSerializableStepOutput("__workflow_return__", output);
    return {
      instanceId,
      status: "complete",
      output,
      steps,
      elapsedMs: performance.now() - start
    };
  } catch (err) {
    return {
      instanceId,
      status: "errored",
      error: err as Error,
      steps,
      elapsedMs: performance.now() - start
    };
  }
}

/** Alias for `createD1SnapshotSeeder`. */
export const seedD1Snapshot = createD1SnapshotSeeder;

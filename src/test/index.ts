/**
 * Fast local D1 snapshot seeder (`createD1SnapshotSeeder`), Worker environment harness
 * (`createCfTestEnv`), and deterministic Workflow runner (`runWorkflowHarness`) for Cloudflare Workers tests.
 *
 * @example
 * ```ts
 * import { createCfTestEnv, createD1SnapshotSeeder, runWorkflowHarness } from "@kanchingyg/wrangler-doctor/test";
 *
 * const seeder = createD1SnapshotSeeder({ migrationsDir: "./migrations" });
 * const clone = seeder.cloneForTestFile("orders.test.ts");
 * clone.cleanup();
 * seeder.cleanupAll();
 * ```
 *
 * @module
 */
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

export { openSqlite, type SqliteDb };

/**
 * Execution metadata returned by D1 query operations (`all` and `run`).
 */
export interface D1ResultMeta {
  /** Execution duration in milliseconds. */
  duration: number;
  /** Number of rows read by the statement. */
  rows_read: number;
  /** Number of rows written by the statement. */
  rows_written: number;
}

/**
 * Result object returned by `D1PreparedStatementLike.all()` and `D1DatabaseLike.batch()`.
 */
export interface D1QueryResult<T = Record<string, unknown>> {
  /** Array of returned result rows. */
  results: T[];
  /** Indicates successful execution (`true`). */
  success: true;
  /** Statement execution metadata. */
  meta: D1ResultMeta;
}

/**
 * Result object returned by `D1DatabaseLike.exec()`.
 */
export interface D1ExecResult {
  /** Number of executed SQL statements. */
  count: number;
  /** Total execution duration in milliseconds. */
  duration: number;
}

/**
 * Cloudflare D1-compatible prepared statement interface backed by local SQLite.
 */
export interface D1PreparedStatementLike {
  /** SQL query string for this prepared statement. */
  readonly query: string;
  /** Bound parameter values (`<= 100` parameters enforced per `workers-sdk#6226`). */
  readonly params: unknown[];
  /** Returns a new prepared statement with the given positional parameters bound. */
  bind(...values: unknown[]): D1PreparedStatementLike;
  /** Executes the query and returns all matching rows with D1 metadata. */
  all<T = Record<string, unknown>>(): Promise<D1QueryResult<T>>;
  /** Executes the query and returns the first row (or column `colName`), or `null` if none matched. */
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  /** Executes a mutation query and returns execution metadata. */
  run(): Promise<D1QueryResult<never>>;
  /** Executes the query and returns rows as arrays of column values. */
  raw<T = unknown[]>(): Promise<T[]>;
}

/**
 * Cloudflare D1-compatible database binding interface backed by local SQLite.
 */
export interface D1DatabaseLike {
  /** Compiles a SQL query string into a prepared statement. */
  prepare(query: string): D1PreparedStatementLike;
  /** Executes a batch of prepared statements atomically inside a SQLite `SAVEPOINT`. */
  batch<T = unknown>(
    statements: D1PreparedStatementLike[]
  ): Promise<Array<D1QueryResult<T>>>;
  /** Executes raw multi-statement SQL while rejecting interactive transactions (`workers-sdk#2733`). */
  exec(query: string): Promise<D1ExecResult>;
}

/**
 * Wraps a synchronous `SqliteDb` instance in a Cloudflare D1-compatible binding (`prepare`, `batch`, `exec`).
 *
 * @param db - Underlying `SqliteDb` instance.
 * @returns D1-compatible database binding.
 */
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

/**
 * Configuration options for `createD1SnapshotSeeder`.
 */
export interface D1SnapshotSeederOptions {
  /** Directory containing ordered `.sql` migration files to apply once to the master database. */
  migrationsDir: string;
  /** Optional SQL seed script executed once after all migrations complete. */
  seedSql?: string;
  /** Optional prefix for the temporary directory holding snapshot files. */
  tmpPrefix?: string;
}

/**
 * Isolated per-test-file SQLite clone and D1 binding created from a `D1SnapshotSeeder`.
 */
export interface ClonedD1Snapshot {
  /** Absolute path to the cloned `.sqlite` file on disk. */
  sqlitePath: string;
  /** Underlying synchronous `SqliteDb` handle. */
  db: SqliteDb;
  /** Cloudflare D1-compatible binding wrapping `db`. */
  d1: D1DatabaseLike;
  /** Time taken to clone and open the snapshot in milliseconds. */
  elapsedMs: number;
  /** Closes `db` and removes the cloned `.sqlite` file from disk. */
  cleanup(): void;
}

/**
 * Master D1 SQLite snapshot manager that applies migrations once and clones isolated databases in milliseconds.
 */
export interface D1SnapshotSeeder {
  /** Absolute path to the pre-migrated master `.sqlite` file. */
  readonly masterSqlitePath: string;
  /** Ordered list of `.sql` migration filenames applied to the master database. */
  readonly appliedMigrations: string[];
  /** Clones the master SQLite file via `COPYFILE_FICLONE` (when supported) for an isolated test run. */
  cloneForTestFile(label?: string): ClonedD1Snapshot;
  /** Removes the temporary directory containing the master database and all clones. */
  cleanupAll(): void;
}

function copyFileFast(src: string, dest: string): void {
  try {
    copyFileSync(src, dest, fsConstants.COPYFILE_FICLONE);
  } catch {
    copyFileSync(src, dest);
  }
}

/**
 * Applies all `.sql` migrations in `options.migrationsDir` once to a master SQLite file and returns
 * a seeder that clones isolated D1 bindings per test file in 1 to 4 ms (`workers-sdk#16296`).
 *
 * @param options - Migrations directory and optional seed SQL.
 * @returns `D1SnapshotSeeder` handle.
 */
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

/**
 * Options for constructing an in-memory Worker test environment via `createCfTestEnv`.
 */
export interface CreateCfTestEnvOptions {
  /** Worker project directory containing `wrangler.jsonc`, `wrangler.toml`, or `cloudflare.config.ts`. */
  projectDir: string;
  /** Optional named environment (`[env.<name>]`) to load bindings from. */
  env?: string;
  /** Optional custom D1 migrations directory override. */
  d1MigrationsDir?: string;
  /** Optional SQL seed script executed once on the master D1 snapshot. */
  seedSql?: string;
  /** Optional environment variable overrides merged onto `env`. */
  vars?: Record<string, string>;
}

/**
 * Active Worker test environment handle returned by `createCfTestEnv`.
 */
export interface CfTestEnvHandle<TEnv = Record<string, unknown>> {
  /** Populated Worker `env` object containing D1, KV, R2, Queue, and `vars` bindings. */
  env: TEnv;
  /** Captured messages sent to each Queue producer binding (`sentQueueMessages[bindingName]`). */
  sentQueueMessages: Record<string, unknown[]>;
  /** Resets all D1 database bindings to a fresh clone of the pre-migrated snapshot. */
  resetD1(): void;
  /** Closes all SQLite connections and deletes temporary snapshot files. */
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

/**
 * Builds an isolated Worker `env` object (D1 snapshots, KV, R2, Queues, `.dev.vars`, and `vars`)
 * directly from `wrangler.jsonc`, `wrangler.toml`, or `cloudflare.config.ts` without spawning `workerd`.
 *
 * @param options - Project directory, environment name, and optional D1 seed overrides.
 * @returns `CfTestEnvHandle` with `env`, `sentQueueMessages`, `resetD1()`, and `dispose()`.
 */
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

/**
 * Retry policy configuration for a Cloudflare Workflow step.
 */
export interface WorkflowStepRetryConfig {
  /** Maximum number of retry attempts after the initial failure. */
  limit: number;
  /** Delay between retries (duration string or milliseconds). */
  delay: string | number;
  /** Optional retry backoff strategy (`constant`, `linear`, or `exponential`). */
  backoff?: "constant" | "linear" | "exponential";
}

/**
 * Configuration options for `step.do(name, config, callback)`.
 */
export interface WorkflowStepConfig {
  /** Optional retry policy for the step. */
  retries?: WorkflowStepRetryConfig;
  /** Optional execution timeout for the step. */
  timeout?: string | number;
}

/**
 * Recorded execution trace entry for a single Workflow step (`do`, `sleep`, `sleepUntil`, or `waitForEvent`).
 */
export interface WorkflowStepRecord {
  /** Step primitive type executed. */
  type: "do" | "sleep" | "sleepUntil" | "waitForEvent";
  /** Step name passed to `step.<type>(name, ...)`. */
  name: string;
  /** Number of attempts executed (`1` when succeeding on the first try). */
  attempts: number;
  /** JSON-serializable output returned by the step, if any. */
  output?: unknown;
  /** Sleep duration or target ISO timestamp recorded for `sleep` and `sleepUntil`. */
  duration?: string | number;
  /** Event type string awaited by `waitForEvent`. */
  eventType?: string;
}

/**
 * Options passed to `step.waitForEvent(name, options)`.
 */
export interface WorkflowWaitForEventOptions {
  /** Event type identifier to wait for. */
  type: string;
  /** Optional timeout duration. */
  timeout?: string | number;
}

/**
 * Event envelope returned by `step.waitForEvent(name, options)`.
 */
export interface WorkflowReceivedEvent<T = unknown> {
  /** Mocked event payload. */
  payload: T;
  /** Timestamp when the event was delivered. */
  timestamp: Date;
  /** Event type identifier. */
  type: string;
}

/**
 * Step execution context passed to `WorkflowEntrypoint.run(event, step)`.
 */
export interface WorkflowStepContext {
  /** Executes a named unit of work and validates that its return value is JSON-serializable. */
  do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
  /** Executes a named unit of work with explicit retry/timeout config. */
  do<T>(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<T> | T
  ): Promise<T>;
  /** Records a deterministic sleep step without blocking wall-clock time. */
  sleep(name: string, duration: string | number): Promise<void>;
  /** Records a deterministic sleepUntil step without blocking wall-clock time. */
  sleepUntil(name: string, timestamp: Date | number | string): Promise<void>;
  /** Resolves immediately with `options.mockEvents[options.type]` or throws a timeout error. */
  waitForEvent<T = unknown>(
    name: string,
    options: WorkflowWaitForEventOptions
  ): Promise<WorkflowReceivedEvent<T>>;
}

/**
 * Event object passed as the first argument to `WorkflowEntrypoint.run(event, step)`.
 */
export interface WorkflowEvent<TPayload = unknown> {
  /** Input payload supplied when creating the Workflow instance. */
  payload: TPayload;
  /** Creation timestamp of the Workflow event. */
  timestamp: Date;
  /** Workflow instance ID (`^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, `<= 64` characters). */
  instanceId: string;
}

/**
 * Lifecycle status of a Cloudflare Workflow instance, including `"rollback"` (`workers-sdk#16301`).
 */
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

/**
 * Options for executing a `WorkflowEntrypoint` class in `runWorkflowHarness`.
 */
export interface RunWorkflowHarnessOptions<TEnv = Record<string, unknown>> {
  /** Custom Workflow instance ID (validated against Cloudflare's 64-char regex contract). */
  instanceId?: string;
  /** Worker `env` bindings passed to the `WorkflowClass` constructor. */
  env?: TEnv;
  /** Execution context passed to the `WorkflowClass` constructor. */
  ctx?: unknown;
  /** Optional map of step name to mocked return value or factory function. */
  stepMocks?: Record<string, unknown | (() => unknown | Promise<unknown>)>;
  /** Optional map of event `type` to mocked payload for `step.waitForEvent()`. */
  mockEvents?: Record<string, unknown>;
  /** When `true`, simulates the `"rollback"` instance status (`workers-sdk#16301`). */
  simulateRollback?: boolean;
}

/**
 * Result returned by `runWorkflowHarness` after executing a Workflow.
 */
export interface WorkflowHarnessResult<TResult = unknown> {
  /** Validated Workflow instance ID. */
  instanceId: string;
  /** Final status of the Workflow instance (`complete`, `errored`, `rollback`, etc.). */
  status: WorkflowInstanceStatus;
  /** Return value of `workflow.run()`, if status is `complete`. */
  output?: TResult;
  /** Uncaught error thrown by `workflow.run()`, if status is `errored`. */
  error?: Error;
  /** Ordered trace of all executed `do`, `sleep`, `sleepUntil`, and `waitForEvent` steps. */
  steps: WorkflowStepRecord[];
  /** Total wall-clock execution duration in milliseconds. */
  elapsedMs: number;
}

/**
 * Instance interface of a Cloudflare `WorkflowEntrypoint` class.
 */
export interface WorkflowInstanceLike<TPayload = unknown, TResult = unknown> {
  /** Main entrypoint invoked by the Workflow runtime. */
  run(
    event: Readonly<WorkflowEvent<TPayload>>,
    step: WorkflowStepContext
  ): Promise<TResult>;
}

/**
 * Constructor signature for a Cloudflare `WorkflowEntrypoint` class.
 */
export type WorkflowClassConstructor<
  TPayload = unknown,
  TResult = unknown,
  TEnv = Record<string, unknown>
> = new (ctx: unknown, env: TEnv) => WorkflowInstanceLike<TPayload, TResult>;

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

/**
 * Executes a `WorkflowEntrypoint` class deterministically in memory without `workerd` timer freezes
 * (`workers-sdk#16056`), validating instance ID contracts, step retry limits, and JSON serializability.
 *
 * @param WorkflowClass - `WorkflowEntrypoint` class constructor.
 * @param payload - Input event payload passed to `run(event, step)`.
 * @param options - Optional step mocks, event mocks, `env`, and `instanceId`.
 * @returns `WorkflowHarnessResult` containing `status`, `output`, `steps`, and `elapsedMs`.
 */
export async function runWorkflowHarness<
  TPayload = unknown,
  TResult = unknown,
  TEnv = Record<string, unknown>
>(
  WorkflowClass: WorkflowClassConstructor<TPayload, TResult, TEnv>,
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

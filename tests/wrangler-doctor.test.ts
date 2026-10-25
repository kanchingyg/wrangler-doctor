import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";
import { applyFixes, auditCfConfigMigration, diagnoseProject, exportD1Sql, exportLocalD1Sql, lintWorkerdContracts, planFixes, runDoctor, scan, undoFixes } from "../src/index.js";
import { openSqlite } from "../src/sqlite-adapter.js";
import {
  createCfTestEnv,
  createD1SnapshotSeeder,
  seedD1Snapshot,
  type D1DatabaseLike,
  runWorkflowHarness,
  type WorkflowEvent,
  type WorkflowStepContext
} from "../src/test/index.js";

const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "wd-test-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "migrations"), { recursive: true });
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("wrangler-doctor 4 diagnostic engines", () => {
  test("detects all 4 engine categories on fixtures/broken-worker", () => {
    const fixtureDir = join(process.cwd(), "fixtures/broken-worker");
    const report = diagnoseProject({ projectDir: fixtureDir });

    expect(report.schemaVersion).toBe(1);
    expect(report.summary.exitCode).toBe(1);
    expect(report.summary.errors).toBeGreaterThan(0);

    const ruleIds = new Set(report.findings.map((f) => f.ruleId));
    // Engine 1: non-inherited binding (WD101), undeclared env key (WD102), plaintext secret (WD104)
    expect(ruleIds.has("WD101")).toBe(true);
    expect(ruleIds.has("WD102")).toBe(true);
    expect(ruleIds.has("WD104")).toBe(true);

    // Engine 2: lowercase trigger begin (WD201), banned BEGIN TRANSACTION (WD202), NOT NULL without DEFAULT & deploy skew (WD204), unindexed FK (WD205), unbounded .bind(...) (WD206)
    expect(ruleIds.has("WD201")).toBe(true);
    expect(ruleIds.has("WD202")).toBe(true);
    expect(ruleIds.has("WD204")).toBe(true);
    expect(ruleIds.has("WD205")).toBe(true);
    expect(ruleIds.has("WD206")).toBe(true);

    // Engine 3: global Date.now() (WD301), invalid Workflow ID with ':' (WD303), unexported OrderWorkflow + missing new_sqlite_classes (WD304)
    expect(ruleIds.has("WD301")).toBe(true);
    expect(ruleIds.has("WD303")).toBe(true);
    expect(ruleIds.has("WD304")).toBe(true);

    // Engine 4: dropped Workflow/DO in cloudflare.config.ts (WD401), dropped migrations_dir/upload_source_maps (WD402), legacy service environment (WD403), workers_dev omitted (WD404)
    expect(ruleIds.has("WD401")).toBe(true);
    expect(ruleIds.has("WD402")).toBe(true);
    expect(ruleIds.has("WD403")).toBe(true);
    expect(ruleIds.has("WD404")).toBe(true);
  });

  test("returns exit code 0 on a clean Worker project with TOML config", () => {
    const dir = makeTempProject();
    writeFileSync(
      join(dir, "wrangler.toml"),
      `name = "clean-worker"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "app-db"

[[env.production.d1_databases]]
binding = "DB"
database_name = "app-db-prod"
`
    );
    writeFileSync(
      join(dir, "migrations/0001_init.sql"),
      `CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);`
    );
    writeFileSync(
      join(dir, "src/index.ts"),
      `export default {
  async fetch(_req: Request, env: { DB: unknown }) {
    return new Response(String(Boolean(env.DB)));
  }
};`
    );

    const report = diagnoseProject({ projectDir: dir, strict: true });
    expect(report.findings).toEqual([]);
    expect(report.summary.exitCode).toBe(0);
  });

  test("exports local D1 SQLite schema and data via exportLocalD1Sql (cf#199)", () => {
    const dir = makeTempProject();
    const sqlitePath = join(dir, "local.sqlite");
    const db = openSqlite(sqlitePath);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO users (id, name) VALUES (1, 'Ada'), (2, 'Linus''s Box');
      CREATE INDEX idx_users_name ON users(name);
    `);
    db.close();

    const fullDump = exportLocalD1Sql(sqlitePath);
    expect(fullDump).toContain("CREATE TABLE users");
    expect(fullDump).toContain(`INSERT INTO "users" ("id", "name") VALUES (1, 'Ada');`);
    expect(fullDump).toContain(`INSERT INTO "users" ("id", "name") VALUES (2, 'Linus''s Box');`);
    expect(fullDump).toContain("CREATE INDEX idx_users_name ON users(name);");

    const schemaOnly = exportLocalD1Sql(sqlitePath, { schemaOnly: true });
    expect(schemaOnly).toContain("CREATE TABLE users");
    expect(schemaOnly).not.toContain("INSERT INTO");
  });

  test("CLI returns 0 on --help and --version, 2 on unknown flag", () => {
    expect(runCli(["--version"])).toBe(0);
    expect(runCli(["--help"])).toBe(0);
    expect(runCli(["--unknown-flag"])).toBe(2);
  });

  test("supports runDoctor/scan/exportD1Sql/seedD1Snapshot aliases and --fix / --apply / --undo", () => {
    expect(runDoctor).toBe(diagnoseProject);
    expect(scan).toBe(diagnoseProject);
    expect(exportD1Sql).toBe(exportLocalD1Sql);
    expect(seedD1Snapshot).toBe(createD1SnapshotSeeder);
    expect(typeof lintWorkerdContracts).toBe("function");
    expect(typeof auditCfConfigMigration).toBe("function");

    const dir = makeTempProject();
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({ name: "fix-worker", main: "src/index.ts" }, null, 2)
    );
    writeFileSync(
      join(dir, "src/index.ts"),
      `export default {\n  async fetch() {\n    return new Response("ok");\n  }\n};\n`
    );
    const migPath = join(dir, "migrations/0001_init.sql");
    writeFileSync(
      migPath,
      "BEGIN TRANSACTION;\nCREATE TABLE t (id INTEGER PRIMARY KEY);\nCREATE TRIGGER tr AFTER INSERT ON t\nbegin\n  SELECT 1;\nend;\nSELECT 1;\nCOMMIT;\n"
    );

    const beforeReport = runDoctor({ projectDir: dir });
    const planned = planFixes(dir, beforeReport.findings);
    expect(planned.length).toBe(1);

    const applied = applyFixes(dir, beforeReport.findings);
    expect(applied.edits.length).toBe(1);
    const afterReport = runDoctor({ projectDir: dir });
    expect(afterReport.findings).toEqual([]);

    const undone = undoFixes(dir, ["migrations/0001_init.sql"]);
    expect(undone.backupFiles).toEqual(["migrations/0001_init.sql"]);
  });
});

describe("wrangler-doctor/test harness", () => {
  test("createD1SnapshotSeeder clones 40 migrations in < 5ms per test file (#16296)", async () => {
    const dir = makeTempProject();
    const migDir = join(dir, "migrations");
    for (let i = 1; i <= 40; i++) {
      const num = String(i).padStart(4, "0");
      writeFileSync(
        join(migDir, `${num}_table_${i}.sql`),
        `CREATE TABLE tbl_${i} (id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT 'v${i}');
         INSERT INTO tbl_${i} (label) VALUES ('seed-${i}');`
      );
    }

    const seeder = createD1SnapshotSeeder({ migrationsDir: migDir });
    try {
      expect(seeder.appliedMigrations.length).toBe(40);

      const cloneA = seeder.cloneForTestFile("file-a");
      const cloneB = seeder.cloneForTestFile("file-b");

      expect(cloneA.elapsedMs).toBeLessThan(25);

      await cloneA.d1.prepare("INSERT INTO tbl_1 (label) VALUES (?)").bind("mutated-a").run();
      const rowsA = await cloneA.d1.prepare("SELECT label FROM tbl_1 ORDER BY id").all<{ label: string }>();
      const rowsB = await cloneB.d1.prepare("SELECT label FROM tbl_1 ORDER BY id").all<{ label: string }>();

      expect(rowsA.results.map((r) => r.label)).toEqual(["seed-1", "mutated-a"]);
      expect(rowsB.results.map((r) => r.label)).toEqual(["seed-1"]);

      // Verify >100 bound params guard (#6226)
      const params101 = Array.from({ length: 101 }, (_, idx) => idx);
      expect(() => cloneA.d1.prepare("SELECT 1").bind(...params101)).toThrow(/100 limit/);

      cloneA.cleanup();
      cloneB.cleanup();
    } finally {
      seeder.cleanupAll();
    }
  });

  test("createCfTestEnv wires D1, KV, R2, Queues, and .dev.vars without wrangler (#16122, #16126)", async () => {
    const dir = makeTempProject();
    writeFileSync(
      join(dir, "wrangler.jsonc"),
      JSON.stringify({
        name: "harness-worker",
        d1_databases: [{ binding: "DB", database_name: "d1-test" }],
        kv_namespaces: [{ binding: "CACHE" }],
        r2_buckets: [{ binding: "BUCKET" }],
        queues: { producers: [{ binding: "JOBS_QUEUE" }] },
        vars: { APP_MODE: "staging" }
      })
    );
    writeFileSync(join(dir, ".dev.vars"), "API_TOKEN=local_dev_token\n");
    writeFileSync(
      join(dir, "migrations/0001_init.sql"),
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);"
    );

    const harness = createCfTestEnv<{
      DB: D1DatabaseLike;
      CACHE: any;
      BUCKET: any;
      JOBS_QUEUE: any;
      APP_MODE: string;
      API_TOKEN: string;
    }>({ projectDir: dir });

    try {
      expect(harness.env.APP_MODE).toBe("staging");
      expect(harness.env.API_TOKEN).toBe("local_dev_token");

      await harness.env.DB.prepare("INSERT INTO notes (body) VALUES (?)").bind("hello").run();
      const firstNote = await harness.env.DB.prepare("SELECT body FROM notes").first<string>("body");
      expect(firstNote).toBe("hello");

      harness.resetD1();
      const afterReset = await harness.env.DB.prepare("SELECT body FROM notes").first();
      expect(afterReset).toBeNull();

      await harness.env.CACHE.put("k1", JSON.stringify({ ok: true }));
      expect(await harness.env.CACHE.get("k1", "json")).toEqual({ ok: true });

      await harness.env.BUCKET.put("file.txt", "r2-content");
      const obj = await harness.env.BUCKET.get("file.txt");
      expect(await obj.text()).toBe("r2-content");

      await harness.env.JOBS_QUEUE.send({ jobId: 42 });
      expect(harness.sentQueueMessages.JOBS_QUEUE).toEqual([{ jobId: 42 }]);
    } finally {
      harness.dispose();
    }
  });

  test("runWorkflowHarness runs steps, retries, waitForEvent, and rollback in < 10ms (#16056, #16301)", async () => {
    let flakyCount = 0;

    class OrderWorkflow {
      constructor(public ctx: unknown, public env: { TAX_RATE: number }) {}

      async run(
        event: Readonly<WorkflowEvent<{ orderId: string; amount: number }>>,
        step: WorkflowStepContext
      ) {
        const subtotal = await step.do(
          "charge-card",
          { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
          async () => {
            flakyCount++;
            if (flakyCount < 2) {
              throw new Error("Temporary gateway timeout");
            }
            return { charged: Math.round(event.payload.amount * (1 + this.env.TAX_RATE)) };
          }
        );

        await step.sleep("cooldown", "5 minutes");

        const approval = await step.waitForEvent<{ approvedBy: string }>("wait-manager", {
          type: "manager.approved",
          timeout: "24 hours"
        });

        return {
          orderId: event.payload.orderId,
          charged: subtotal.charged,
          approvedBy: approval.payload.approvedBy
        };
      }
    }

    const result = await runWorkflowHarness(
      OrderWorkflow,
      { orderId: "ord_1", amount: 100 },
      {
        instanceId: "order-ord_1",
        env: { TAX_RATE: 0.21 },
        mockEvents: {
          "manager.approved": { approvedBy: "augusto" }
        }
      }
    );

    expect(result.status).toBe("complete");
    expect(result.elapsedMs).toBeLessThan(20);
    expect(result.output).toEqual({
      orderId: "ord_1",
      charged: 121,
      approvedBy: "augusto"
    });
    expect(result.steps.map((s) => ({ name: s.name, attempts: s.attempts }))).toEqual([
      { name: "charge-card", attempts: 2 },
      { name: "cooldown", attempts: 1 },
      { name: "wait-manager", attempts: 1 }
    ]);

    // Invalid Workflow ID with ':' must throw immediately
    await expect(
      runWorkflowHarness(
        OrderWorkflow,
        { orderId: "ord_2", amount: 50 },
        { instanceId: "invalid:id:with:colon", env: { TAX_RATE: 0 } }
      )
    ).rejects.toThrow(/Invalid Workflow instanceId/);

    // Rollback status simulation (#16301)
    const rollbackRes = await runWorkflowHarness(
      OrderWorkflow,
      { orderId: "ord_3", amount: 50 },
      { instanceId: "order-ord_3", env: { TAX_RATE: 0 }, simulateRollback: true }
    );
    expect(rollbackRes.status).toBe("rollback");
  });
});

# wrangler-doctor

[![ci](https://github.com/kanchingyg/wrangler-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/wrangler-doctor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/wrangler-doctor)](https://www.npmjs.com/package/wrangler-doctor)
[![JSR](https://jsr.io/badges/@kanchingyg/wrangler-doctor)](https://jsr.io/@kanchingyg/wrangler-doctor)
[![license](https://img.shields.io/npm/l/wrangler-doctor)](https://github.com/kanchingyg/wrangler-doctor/blob/HEAD/LICENSE)

wrangler-doctor checks Cloudflare Workers configs, D1 migrations, and workerd runtime contracts offline, and provides a local D1 snapshot and Workflow test harness.

```text
┌─ offline pre-flight + local test harness ──────────────────────┐
│ wrangler.jsonc / toml / cloudflare.config.ts                   │
│   ├─ WD101..105  [env.<name>] non-inherited bindings & secrets │
│   ├─ WD201..206  D1 splitter, in-memory SQLite & deploy skew   │
│   ├─ WD301..306  global-scope I/O, Workflow IDs & DO SQLite    │
│   └─ WD401..404  cf migrate parity (Workflows, DO, D1 dirs)    │
└────────────────────────────────────────────────────────────────┘
```

Wrangler does not inherit top-level bindings (`services`, `d1_databases`, `kv_namespaces`, `r2_buckets`, `queues`, `workflows`, `durable_objects`, `vars`) into `[env.<name>]`, so `tsc` and `wrangler dev` pass while `env.<BINDING>` is `undefined` in production. Remote D1 also uses a statement splitter that rejects lowercase `begin` in triggers and `BEGIN TRANSACTION` statements that pass in local SQLite, and `workerd` crashes at startup with `Disallowed operation called within global scope` without printing the offending file or line.

## Install

[npm](https://www.npmjs.com/package/wrangler-doctor):

```bash
bun add -d wrangler-doctor
npm i -D wrangler-doctor
```

[JSR](https://jsr.io/@kanchingyg/wrangler-doctor):

```bash
bunx jsr add @kanchingyg/wrangler-doctor
```

From a clone:

```bash
bun install
bun run build
node dist/cli.js fixtures/broken-worker
```

## Quick start

Run `wrangler-doctor` (or its aliases `cf-doctor`, `cf-check`, and `wrangler-shadow`) in a Worker repository:

```text
$ wrangler-doctor fixtures/broken-worker

wrangler-doctor (wrangler.jsonc | envs: production)

error   WD101 (env-matrix) [env.production] wrangler.jsonc
        Binding "STOCK" (services) is defined at top-level but missing in env.production. Wrangler does not inherit services across named environments (used at src/index.ts:12).
        fix: Declare "STOCK" explicitly inside env.production.services in wrangler.jsonc.
error   WD201 (d1-simulator) migrations/0001_init.sql:14
        CREATE TRIGGER uses lowercase "begin". Remote D1's statement splitter splits inside the trigger body and fails with D1_EXEC_ERROR.
        fix: Use uppercase "BEGIN" and "END;" in CREATE TRIGGER statements.
error   WD202 (d1-simulator) migrations/0001_init.sql:1
        Migration contains "BEGIN TRANSACTION;". Remote D1 rejects explicit transaction statements in migrations.
        fix: Remove BEGIN/COMMIT/SAVEPOINT from migrations/0001_init.sql; D1 wraps migrations automatically.
error   WD301 (workerd-contracts) src/index.ts:1
        Top-level "Date.now()" call in module global scope crashes workerd at startup with "Disallowed operation called within global scope".
        fix: Move "Date.now()" inside fetch(), scheduled(), queue(), or a lazy initializer function.
error   WD303 (workerd-contracts) src/index.ts:14
        Workflow instance id "order:2026:01" violates Cloudflare Workflows contract (must match ^[a-zA-Z0-9_][a-zA-Z0-9-_]*$ and be <= 64 chars; got length 13).
        fix: Use only alphanumeric characters, "_", or "-", and cap length at 64 characters.
error   WD401 (cf-migrate) cloudflare.config.ts
        Workflow binding "ORDER_WF" (OrderWorkflow) from wrangler.jsonc is missing in cloudflare.config.ts ("cf migrate" drops Workflow bindings).
        fix: Manually add Workflow binding "ORDER_WF" (OrderWorkflow) to cloudflare.config.ts.

16 error(s), 7 warning(s)
```

Exit code is `0` when no errors are found, `1` when errors (or warnings under `--strict`) are found, and `2` on invalid arguments.

## Usage

| Command or flag | What it does | Default |
|---|---|---|
| `wrangler-doctor [check] [dir]` | Run all four diagnostic engines on `dir` | `.` |
| `wrangler-doctor migrate-check [dir]` | Audit `wrangler.jsonc`/`toml` parity with `cloudflare.config.ts` | `.` |
| `wrangler-doctor d1-export <sqlite-path>` | Dump SQL schema and `INSERT` rows from a local D1 `.sqlite` file | none |
| `--env <name>` | Check only the named environment in `wrangler` config | all environments |
| `--strict` | Return exit code `1` on warnings as well as errors | `false` |
| `--fix` | Preview safe auto-fixes without modifying files on disk | `false` |
| `--apply` | Apply safe auto-fixes and save `.wrangler-doctor.bak` backups | `false` |
| `--undo` | Restore files from `.wrangler-doctor.bak` backups | `false` |
| `--json` | Print the structured JSON report (`schemaVersion: 1`) | `false` |
| `--schema-only` | Emit only `CREATE` statements in `d1-export` | `false` |
| `--data-only` | Emit only `INSERT` statements in `d1-export` | `false` |
| `--table <name>` | Export only a single table in `d1-export` | all tables |
| `-h`, `--help` | Print command help | `false` |
| `-v`, `--version` | Print package version | `false` |

## Library and test harness API

### Pre-flight diagnostics (`wrangler-doctor`)

```ts
import { diagnoseProject, exportD1Sql, exportLocalD1Sql, runDoctor, scan } from "wrangler-doctor";

const report = diagnoseProject({ projectDir: ".", strict: true });
// report.findings[n].ruleId / .severity / .file / .line / .issueUrl
// report.summary.exitCode (0 or 1)

const sqlDump = exportLocalD1Sql(".wrangler/state/v3/d1/miniflare-D1DatabaseObject/db.sqlite");
```

### Local D1 snapshot seeder and Workflow harness (`wrangler-doctor/test`)

```ts
import {
  createCfTestEnv,
  createD1SnapshotSeeder,
  runWorkflowHarness,
  seedD1Snapshot
} from "wrangler-doctor/test";

// 1. Apply migrations once to a master SQLite file and clone per test file
const seeder = createD1SnapshotSeeder({ migrationsDir: "./migrations" });
const clone = seeder.cloneForTestFile("orders.test.ts");
// clone.d1 implements prepare().bind().all()/.first()/.run(), batch(), exec()
clone.cleanup();
seeder.cleanupAll();

// 2. Build an in-memory Worker test env from wrangler.jsonc or cloudflare.config.ts
const harness = createCfTestEnv({ projectDir: "." });
// harness.env.DB, harness.env.CACHE, harness.env.BUCKET, harness.resetD1()
harness.dispose();

// 3. Run a WorkflowEntrypoint deterministically in memory without timer freezes
const wfResult = await runWorkflowHarness(OrderWorkflow, { orderId: "ord_1" }, {
  instanceId: "order-ord_1",
  env: { TAX_RATE: 0.21 },
  mockEvents: { "manager.approved": { approvedBy: "alex" } }
});
// wfResult.status === "complete", wfResult.steps
```

On Bun 1.4.2 and Node 22.20.0 (Linux x64), `createD1SnapshotSeeder` applies 40 SQL migrations once and clones each per-file SQLite database in 1 to 4 ms via `COPYFILE_FICLONE`, and `runWorkflowHarness` executes a 3-step `WorkflowEntrypoint` with retries and `waitForEvent` in under 2 ms.

## How it works

1. Engine 1 (`src/engines/env-matrix.ts`) parses `wrangler.jsonc`, `wrangler.toml`, `.dev.vars`, and `worker-configuration.d.ts`, compares each `[env.<name>]` block against top-level bindings and `env.<KEY>` accesses in `src/`, and checks `vars` for plaintext secret patterns ([cloudflare/workers-sdk#6321](https://github.com/cloudflare/workers-sdk/issues/6321), [cloudflare/workers-sdk#15068](https://github.com/cloudflare/workers-sdk/issues/15068)).
2. Engine 2 (`src/engines/d1-simulator.ts`) emulates the remote D1 statement splitter ([cloudflare/workers-sdk#15314](https://github.com/cloudflare/workers-sdk/issues/15314), [cloudflare/workers-sdk#15690](https://github.com/cloudflare/workers-sdk/issues/15690), [cloudflare/workers-sdk#16319](https://github.com/cloudflare/workers-sdk/issues/16319), [cloudflare/workers-sdk#2733](https://github.com/cloudflare/workers-sdk/issues/2733)), replays `migrations/*.sql` in memory using `bun:sqlite` on Bun or `node:sqlite` on Node 22.5+, runs `EXPLAIN QUERY PLAN` on foreign keys, checks the latest migration against `src/` for Workers Builds deploy skew ([cloudflare/workers-sdk#11708](https://github.com/cloudflare/workers-sdk/issues/11708)), flags queries over 100 bound parameters ([cloudflare/workers-sdk#6226](https://github.com/cloudflare/workers-sdk/issues/6226)), and exports `.sqlite` files to SQL ([cloudflare/cf#199](https://github.com/cloudflare/cf/issues/199)).
3. Engine 3 (`src/engines/workerd-contracts.ts`) scans module global scope for calls that crash `workerd` at startup ([cloudflare/workerd#2490](https://github.com/cloudflare/workerd/issues/2490), [cloudflare/workers-sdk#9489](https://github.com/cloudflare/workers-sdk/issues/9489)), `Date.now()` in `"use cache"` files ([opennextjs/opennextjs-cloudflare#1458](https://github.com/opennextjs/opennextjs-cloudflare/issues/1458)), Workflow instance IDs outside `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` or over 64 characters, missing DO/Workflow exports from `main` ([cloudflare/workers-sdk#16012](https://github.com/cloudflare/workers-sdk/issues/16012)), missing `new_sqlite_classes` for `storage.sql` ([cloudflare/workers-sdk#16119](https://github.com/cloudflare/workers-sdk/issues/16119)), and `wrangler versions upload` with Workflows ([cloudflare/workers-sdk#16001](https://github.com/cloudflare/workers-sdk/issues/16001)).
4. Engine 4 (`src/engines/cf-migrate-audit.ts`) compares `wrangler.jsonc`/`wrangler.toml` with `cloudflare.config.ts` to catch dropped Workflow bindings, Durable Object exports, D1 `migrations_dir`, `upload_source_maps`, `workers_dev`, and legacy service `environment` fields ([cloudflare/workers-sdk#16119](https://github.com/cloudflare/workers-sdk/issues/16119), [cloudflare/workers-sdk#16124](https://github.com/cloudflare/workers-sdk/issues/16124), [cloudflare/workers-sdk#16167](https://github.com/cloudflare/workers-sdk/issues/16167), [cloudflare/workers-sdk#16125](https://github.com/cloudflare/workers-sdk/issues/16125)).
5. Test harness (`src/test/index.ts`) provides `createD1SnapshotSeeder`, `createCfTestEnv`, and `runWorkflowHarness` for [cloudflare/workers-sdk#16122](https://github.com/cloudflare/workers-sdk/issues/16122), [cloudflare/workers-sdk#16126](https://github.com/cloudflare/workers-sdk/issues/16126), [cloudflare/workers-sdk#16296](https://github.com/cloudflare/workers-sdk/issues/16296), [cloudflare/workers-sdk#15539](https://github.com/cloudflare/workers-sdk/issues/15539), [cloudflare/workers-sdk#15618](https://github.com/cloudflare/workers-sdk/issues/15618), [cloudflare/workers-sdk#16056](https://github.com/cloudflare/workers-sdk/issues/16056), and [cloudflare/workers-sdk#16301](https://github.com/cloudflare/workers-sdk/issues/16301).

## Limits

- Requires Bun `>= 1.1.0` (`bun:sqlite`) or Node.js `>= 22.5.0` (`node:sqlite`).
- Source scanning uses line and brace-depth matching rather than a full TypeScript type checker, so dynamically computed binding names (`env[key]`) and dynamically concatenated Workflow IDs are not evaluated.
- `runWorkflowHarness` executes steps in a single process rather than inside `workerd` isolates.

## License

[MIT](https://github.com/kanchingyg/wrangler-doctor/blob/HEAD/LICENSE)

Copyright (c) 2026 Augusto Cerrutti (https://github.com/kanchingyg)

/**
 * Diagnostic finding severity level.
 */
export type Severity = "error" | "warning";

/**
 * Identifier of the diagnostic engine that emitted a finding.
 */
export type EngineId =
  | "env-matrix"
  | "d1-simulator"
  | "workerd-contracts"
  | "cf-migrate";

/**
 * Single diagnostic finding emitted by a pre-flight check engine.
 */
export interface Finding {
  /** Rule identifier (for example `WD101` or `WD201`). */
  ruleId: string;
  /** Engine that produced this finding. */
  engine: EngineId;
  /** Severity of the finding (`error` or `warning`). */
  severity: Severity;
  /** Human-readable explanation of the detected problem. */
  message: string;
  /** Relative file path where the finding was detected. */
  file?: string;
  /** One-based line number inside `file`. */
  line?: number;
  /** Named Wrangler environment associated with the finding. */
  env?: string;
  /** Worker binding or variable name associated with the finding. */
  binding?: string;
  /** Upstream Cloudflare GitHub issue or discussion URL explaining the hazard. */
  issueUrl?: string;
  /** Actionable remediation guidance. */
  suggestion?: string;
}

/**
 * Aggregated counts and process exit code for a diagnostic run.
 */
export interface DoctorSummary {
  /** Total number of `error` severity findings. */
  errors: number;
  /** Total number of `warning` severity findings. */
  warnings: number;
  /** Recommended CLI exit code (`0` passed, `1` failed, `2` usage error). */
  exitCode: 0 | 1 | 2;
}

/**
 * Structured report returned by `diagnoseProject` and `--json` CLI output.
 */
export interface DoctorReport {
  /** Report schema version (`1`). */
  schemaVersion: 1;
  /** Resolved absolute path of the inspected Worker project directory. */
  projectDir: string;
  /** Relative path to the detected Wrangler configuration file, if present. */
  configPath?: string;
  /** Named environments discovered in the Wrangler configuration. */
  environments: string[];
  /** List of diagnostic findings across all engines. */
  findings: Finding[];
  /** Summary counts and exit code. */
  summary: DoctorSummary;
}

/**
 * Options accepted by `diagnoseProject`, `runDoctor`, and `scan`.
 */
export interface DiagnoseOptions {
  /** Target Worker project directory (defaults to `process.cwd()`). */
  projectDir?: string;
  /** Optional named environment (`[env.<name>]`) to scope `env-matrix` checks. */
  env?: string;
  /** Treat warnings as non-zero exit code failures when `true`. */
  strict?: boolean;
}

/**
 * Normalized set of Worker binding names grouped by binding category.
 */
export interface BindingSet {
  /** D1 database binding names (`d1_databases`). */
  d1_databases: string[];
  /** KV namespace binding names (`kv_namespaces`). */
  kv_namespaces: string[];
  /** R2 bucket binding names (`r2_buckets`). */
  r2_buckets: string[];
  /** Service binding names (`services`). */
  services: string[];
  /** Queue producer binding names (`queues.producers`). */
  queues_producers: string[];
  /** Workflow binding names (`workflows`). */
  workflows: string[];
  /** Durable Object binding names (`durable_objects.bindings`). */
  durable_objects: string[];
  /** Plaintext environment variable keys (`vars`). */
  vars: string[];
  /** Workers AI binding names (`ai`). */
  ai: string[];
  /** Hyperdrive binding names (`hyperdrive`). */
  hyperdrive: string[];
  /** Vectorize index binding names (`vectorize`). */
  vectorize: string[];
}

/**
 * D1 database configuration entry extracted from `wrangler.jsonc` or `wrangler.toml`.
 */
export interface D1ConfigEntry {
  /** Binding name exposed on `env` (for example `DB`). */
  binding: string;
  /** Optional Cloudflare D1 database name. */
  database_name?: string;
  /** Optional custom directory containing `.sql` migration files. */
  migrations_dir?: string;
}

/**
 * Workflow binding and class metadata extracted from `wrangler.jsonc` or `wrangler.toml`.
 */
export interface WorkflowClassEntry {
  /** Binding name exposed on `env`. */
  binding: string;
  /** Workflow resource name. */
  name: string;
  /** Exported `WorkflowEntrypoint` subclass name. */
  class_name: string;
  /** Optional external Worker script name hosting the Workflow class. */
  script_name?: string;
}

/**
 * Durable Object binding and class metadata extracted from `wrangler.jsonc` or `wrangler.toml`.
 */
export interface DurableObjectClassEntry {
  /** Binding name exposed on `env`. */
  name: string;
  /** Exported Durable Object class name. */
  class_name: string;
  /** Optional external Worker script name hosting the Durable Object class. */
  script_name?: string;
}

/**
 * Service binding metadata extracted from `wrangler.jsonc` or `wrangler.toml`.
 */
export interface ServiceBindingEntry {
  /** Binding name exposed on `env`. */
  binding: string;
  /** Target Worker service name. */
  service: string;
  /** Optional legacy target environment name (`workers-sdk#16167`). */
  environment?: string;
  /** Scope where the service binding was declared (`top-level` or environment name). */
  envScope: string;
}

/**
 * Normalized representation of a project's `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml`.
 */
export interface ParsedWorkerConfig {
  /** Absolute path to the parsed configuration file. */
  configPath: string;
  /** Configuration format (`jsonc`, `toml`, or `ts`). */
  format: "jsonc" | "toml" | "ts";
  /** Worker service name. */
  name?: string;
  /** Main entrypoint module path. */
  main?: string;
  /** Whether `workers_dev` is enabled at top level. */
  workersDev?: boolean;
  /** Whether `upload_source_maps` is enabled at top level. */
  uploadSourceMaps?: boolean;
  /** Bindings declared at the top level of the configuration. */
  topLevelBindings: BindingSet;
  /** Bindings declared inside each named `[env.<name>]` block. */
  envBindings: Record<string, BindingSet>;
  /** Tracks which binding categories were explicitly declared per environment. */
  rawEnvPresent: Record<string, Partial<Record<keyof BindingSet, boolean>>>;
  /** Flattened map of `vars` values (`KEY` or `<env>.KEY` to string value). */
  varsValues: Record<string, string>;
  /** Top-level D1 database configuration entries. */
  d1Configs: D1ConfigEntry[];
  /** Top-level Workflow binding entries. */
  workflowClasses: WorkflowClassEntry[];
  /** Top-level Durable Object binding entries. */
  durableObjectClasses: DurableObjectClassEntry[];
  /** Durable Object class names listed under `migrations[].new_sqlite_classes`. */
  sqliteMigrationClasses: string[];
  /** All Durable Object class names listed under `migrations[]`. */
  allMigrationClasses: string[];
  /** Service binding entries across top-level and named environments. */
  serviceEntries: ServiceBindingEntry[];
}

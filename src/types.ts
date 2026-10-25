export type Severity = "error" | "warning";

export type EngineId =
  | "env-matrix"
  | "d1-simulator"
  | "workerd-contracts"
  | "cf-migrate";

export interface Finding {
  ruleId: string;
  engine: EngineId;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  env?: string;
  binding?: string;
  issueUrl?: string;
  suggestion?: string;
}

export interface DoctorSummary {
  errors: number;
  warnings: number;
  exitCode: 0 | 1 | 2;
}

export interface DoctorReport {
  schemaVersion: 1;
  projectDir: string;
  configPath?: string;
  environments: string[];
  findings: Finding[];
  summary: DoctorSummary;
}

export interface DiagnoseOptions {
  projectDir?: string;
  env?: string;
  strict?: boolean;
}

export interface BindingSet {
  d1_databases: string[];
  kv_namespaces: string[];
  r2_buckets: string[];
  services: string[];
  queues_producers: string[];
  workflows: string[];
  durable_objects: string[];
  vars: string[];
  ai: string[];
  hyperdrive: string[];
  vectorize: string[];
}

export interface ParsedWorkerConfig {
  configPath: string;
  format: "jsonc" | "toml" | "ts";
  name?: string;
  main?: string;
  workersDev?: boolean;
  uploadSourceMaps?: boolean;
  topLevelBindings: BindingSet;
  envBindings: Record<string, BindingSet>;
  rawEnvPresent: Record<string, Partial<Record<keyof BindingSet, boolean>>>;
  varsValues: Record<string, string>;
  d1Configs: Array<{
    binding: string;
    database_name?: string;
    migrations_dir?: string;
  }>;
  workflowClasses: Array<{
    binding: string;
    name: string;
    class_name: string;
    script_name?: string;
  }>;
  durableObjectClasses: Array<{
    name: string;
    class_name: string;
    script_name?: string;
  }>;
  sqliteMigrationClasses: string[];
  allMigrationClasses: string[];
  serviceEntries: Array<{
    binding: string;
    service: string;
    environment?: string;
    envScope: string;
  }>;
}

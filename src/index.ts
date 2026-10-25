import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  auditCfConfigMigration,
  checkCfMigrate
} from "./engines/cf-migrate-audit.js";
import {
  exportD1Sql,
  exportLocalD1Sql,
  type ExportLocalD1Options,
  simulateD1Migrations
} from "./engines/d1-simulator.js";
import { checkEnvMatrix, parseWorkerConfig } from "./engines/env-matrix.js";
import {
  checkWorkerdContracts,
  lintWorkerdContracts
} from "./engines/workerd-contracts.js";
import {
  applyFixes,
  type FixEdit,
  type FixSummary,
  planFixes,
  undoFixes
} from "./fixer.js";
import type { DiagnoseOptions, DoctorReport, Finding } from "./types.js";

export type {
  BindingSet,
  DiagnoseOptions,
  DoctorReport,
  DoctorSummary,
  EngineId,
  Finding,
  ParsedWorkerConfig,
  Severity
} from "./types.js";

export {
  applyFixes,
  auditCfConfigMigration,
  checkCfMigrate,
  checkEnvMatrix,
  checkWorkerdContracts,
  exportD1Sql,
  exportLocalD1Sql,
  type ExportLocalD1Options,
  type FixEdit,
  type FixSummary,
  lintWorkerdContracts,
  parseWorkerConfig,
  planFixes,
  simulateD1Migrations,
  undoFixes
};

/**
 * Runs all four offline diagnostic engines (`env-matrix`, `d1-simulator`,
 * `workerd-contracts`, and `cf-migrate`) on a Cloudflare Worker project directory.
 */
export function diagnoseProject(options: DiagnoseOptions = {}): DoctorReport {
  const projectDir = resolve(options.projectDir ?? process.cwd());
  if (!existsSync(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }

  const parsedConfig = parseWorkerConfig(projectDir);
  const findings: Finding[] = [
    ...checkEnvMatrix(projectDir, parsedConfig, options.env),
    ...simulateD1Migrations(projectDir, parsedConfig),
    ...checkWorkerdContracts(projectDir, parsedConfig),
    ...checkCfMigrate(projectDir, parsedConfig)
  ];

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const shouldFail = errors > 0 || (Boolean(options.strict) && warnings > 0);

  return {
    schemaVersion: 1,
    projectDir,
    configPath: parsedConfig
      ? relative(projectDir, parsedConfig.configPath) || "wrangler.jsonc"
      : undefined,
    environments: parsedConfig ? Object.keys(parsedConfig.envBindings) : [],
    findings,
    summary: {
      errors,
      warnings,
      exitCode: shouldFail ? 1 : 0
    }
  };
}

/** Alias for `diagnoseProject`. */
export const runDoctor = diagnoseProject;

/** Alias for `diagnoseProject`. */
export const scan = diagnoseProject;

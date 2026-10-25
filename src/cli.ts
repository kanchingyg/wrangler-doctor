#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  applyFixes,
  checkCfMigrate,
  diagnoseProject,
  exportLocalD1Sql,
  parseWorkerConfig,
  planFixes,
  undoFixes
} from "./index.js";
import type { DoctorReport } from "./types.js";

const VERSION = "0.1.1";

function printHelp(): void {
  console.log(`wrangler-doctor v${VERSION}

Usage:
  wrangler-doctor [check] [dir] [options]
  wrangler-doctor migrate-check [dir] [options]
  wrangler-doctor d1-export <sqlite-path> [--schema-only] [--data-only] [--table <name>]

Options:
  --env <name>     Check only a specific named environment in wrangler config
  --strict         Exit with code 1 on warnings as well as errors
  --fix            Preview safe auto-fixes without modifying files (dry-run)
  --apply          Apply safe auto-fixes on disk (creates .wrangler-doctor.bak backups)
  --undo           Restore files from .wrangler-doctor.bak backups
  --json           Print structured JSON report (schemaVersion: 1)
  --schema-only    Export only CREATE statements in d1-export
  --data-only      Export only INSERT statements in d1-export
  --table <name>   Export only a single table in d1-export
  -h, --help       Show this help text
  -v, --version    Print version

Exit codes:
  0  No blocking issues found
  1  One or more errors found (or warnings with --strict)
  2  Invalid arguments or missing target path`);
}

function formatHumanReport(report: DoctorReport): string {
  const lines: string[] = [];
  const headerConfig = report.configPath ?? "no wrangler config";
  const envList =
    report.environments.length > 0 ? report.environments.join(", ") : "top-level only";
  lines.push(`wrangler-doctor (${headerConfig} | envs: ${envList})`);
  lines.push("");

  if (report.findings.length === 0) {
    lines.push("0 errors, 0 warnings");
    return lines.join("\n");
  }

  for (const f of report.findings) {
    const loc = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "";
    const scope = f.env ? ` [env.${f.env}]` : "";
    lines.push(
      `${f.severity.padEnd(7)} ${f.ruleId} (${f.engine})${scope} ${loc}`.trimEnd()
    );
    lines.push(`        ${f.message}`);
    if (f.suggestion) {
      lines.push(`        fix: ${f.suggestion}`);
    }
  }

  lines.push("");
  lines.push(
    `${report.summary.errors} error(s), ${report.summary.warnings} warning(s)`
  );
  return lines.join("\n");
}

function findBackupCandidates(projectDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".wrangler-doctor.bak")) {
        const orig = full.slice(0, -".wrangler-doctor.bak".length);
        results.push(relative(projectDir, orig));
      }
    }
  };
  walk(projectDir);
  return results;
}

/**
 * Executes the `wrangler-doctor` CLI with the given argument vector and returns the process exit code.
 */
export function runCli(argv: string[]): number {
  let json = false;
  let strict = false;
  let fixDryRun = false;
  let applyMode = false;
  let undoMode = false;
  let envName: string | undefined;
  let schemaOnly = false;
  let dataOnly = false;
  let tableName: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      return 0;
    }
    if (arg === "-v" || arg === "--version") {
      console.log(VERSION);
      return 0;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--fix") {
      fixDryRun = true;
      continue;
    }
    if (arg === "--apply") {
      applyMode = true;
      continue;
    }
    if (arg === "--undo") {
      undoMode = true;
      continue;
    }
    if (arg === "--schema-only") {
      schemaOnly = true;
      continue;
    }
    if (arg === "--data-only") {
      dataOnly = true;
      continue;
    }
    if (arg === "--table") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --table requires a table name.");
        return 2;
      }
      tableName = next;
      i++;
      continue;
    }
    if (arg === "--env") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --env requires an environment name.");
        return 2;
      }
      envName = next;
      i++;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Error: Unknown flag "${arg}". Run with --help for usage.`);
      return 2;
    }
    positionals.push(arg);
  }

  const firstPos = positionals[0];
  if (firstPos === "d1-export" || firstPos === "d1") {
    const sqliteTarget =
      firstPos === "d1" && positionals[1] === "export"
        ? positionals[2]
        : positionals[1];
    if (!sqliteTarget) {
      console.error("Error: d1-export requires a path to a .sqlite file.");
      return 2;
    }
    const resolvedSqlite = resolve(sqliteTarget);
    if (!existsSync(resolvedSqlite)) {
      console.error(`Error: SQLite file not found: ${resolvedSqlite}`);
      return 2;
    }
    try {
      const dump = exportLocalD1Sql(resolvedSqlite, {
        schemaOnly,
        dataOnly,
        table: tableName
      });
      process.stdout.write(dump);
      return 0;
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      return 2;
    }
  }

  let subcommand: "check" | "migrate-check" = "check";
  let dirArg = positionals[0];
  if (firstPos === "check" || firstPos === "migrate-check") {
    subcommand = firstPos;
    dirArg = positionals[1];
  }

  const targetDir = resolve(dirArg ?? process.cwd());
  if (!existsSync(targetDir)) {
    console.error(`Error: Target directory not found: ${targetDir}`);
    return 2;
  }

  try {
    if (undoMode) {
      const candidates = findBackupCandidates(targetDir);
      const summary = undoFixes(targetDir, candidates);
      if (json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`Restored ${summary.backupFiles.length} file(s) from backup.`);
      }
      return 0;
    }

    if (subcommand === "migrate-check") {
      const parsedConfig = parseWorkerConfig(targetDir);
      const findings = checkCfMigrate(targetDir, parsedConfig);
      const errors = findings.filter((f) => f.severity === "error").length;
      const warnings = findings.filter((f) => f.severity === "warning").length;
      const shouldFail = errors > 0 || (strict && warnings > 0);
      const report: DoctorReport = {
        schemaVersion: 1,
        projectDir: targetDir,
        configPath: parsedConfig
          ? relative(targetDir, parsedConfig.configPath) || "wrangler.jsonc"
          : undefined,
        environments: parsedConfig ? Object.keys(parsedConfig.envBindings) : [],
        findings,
        summary: { errors, warnings, exitCode: shouldFail ? 1 : 0 }
      };
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatHumanReport(report));
      }
      return report.summary.exitCode;
    }

    const report = diagnoseProject({
      projectDir: targetDir,
      env: envName,
      strict
    });

    if (fixDryRun) {
      const edits = planFixes(targetDir, report.findings);
      if (json) {
        console.log(JSON.stringify({ report, fixDryRun: edits }, null, 2));
      } else {
        console.log(formatHumanReport(report));
        console.log("");
        console.log(`Planned auto-fixes (dry-run): ${edits.length} file(s)`);
        for (const edit of edits) {
          console.log(`  - ${edit.file}: ${edit.description}`);
        }
      }
      return report.summary.exitCode;
    }

    if (applyMode) {
      const applied = applyFixes(targetDir, report.findings);
      if (json) {
        console.log(JSON.stringify({ report, applied }, null, 2));
      } else {
        console.log(formatHumanReport(report));
        console.log("");
        console.log(`Applied auto-fixes to ${applied.edits.length} file(s). Backups: ${applied.backupFiles.join(", ") || "none"}`);
      }
      return report.summary.exitCode;
    }

    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatHumanReport(report));
    }
    return report.summary.exitCode;
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  const code = runCli(process.argv.slice(2));
  process.exit(code);
}

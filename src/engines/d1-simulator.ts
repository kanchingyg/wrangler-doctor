import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { openSqlite } from "../sqlite-adapter.js";
import type { Finding, ParsedWorkerConfig } from "../types.js";
import { collectTsFiles } from "./env-matrix.js";

function findMigrationDirs(
  projectDir: string,
  parsedConfig: ParsedWorkerConfig | null
): string[] {
  const dirs = new Set<string>();
  if (parsedConfig) {
    for (const d1 of parsedConfig.d1Configs) {
      if (d1.migrations_dir) {
        const full = join(projectDir, d1.migrations_dir);
        if (existsSync(full)) dirs.add(full);
      }
    }
  }
  const defaultDir = join(projectDir, "migrations");
  if (existsSync(defaultDir)) dirs.add(defaultDir);
  const drizzleDir = join(projectDir, "drizzle");
  if (existsSync(drizzleDir)) dirs.add(drizzleDir);
  return [...dirs];
}

export function simulateD1Migrations(
  projectDir: string,
  parsedConfig: ParsedWorkerConfig | null
): Finding[] {
  const findings: Finding[] = [];
  const migrationDirs = findMigrationDirs(projectDir, parsedConfig);
  const srcDir = existsSync(join(projectDir, "src")) ? join(projectDir, "src") : projectDir;
  const tsFiles = collectTsFiles(srcDir);

  for (const migDir of migrationDirs) {
    const sqlFiles = readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (sqlFiles.length === 0) continue;

    const db = openSqlite(":memory:");
    const indexedColumns = new Set<string>();
    const foreignKeys: Array<{
      table: string;
      column: string;
      refTable: string;
      file: string;
      line: number;
    }> = [];
    const latestAddedColumns: Array<{
      table: string;
      column: string;
      file: string;
      line: number;
    }> = [];

    try {
      for (let fileIdx = 0; fileIdx < sqlFiles.length; fileIdx++) {
        const fileName = sqlFiles[fileIdx];
        const fullPath = join(migDir, fileName);
        const relFile = relative(projectDir, fullPath);
        const rawSql = readFileSync(fullPath, "utf8");
        const lines = rawSql.split(/\r?\n/);
        const isLatestMigration = fileIdx === sqlFiles.length - 1 && sqlFiles.length > 1;

        // WD201a: Trigger with lowercase 'begin' (#15314)
        const triggerRegex =
          /CREATE\s+(?:TEMP|TEMPORARY\s+)?TRIGGER\b[\s\S]*?\b(begin)\b[\s\S]*?\b(?:end|END)\s*;/g;
        let trigMatch: RegExpExecArray | null;
        while ((trigMatch = triggerRegex.exec(rawSql)) !== null) {
          if (trigMatch[1] === "begin") {
            const lineNum = rawSql.slice(0, trigMatch.index).split(/\r?\n/).length;
            findings.push({
              ruleId: "WD201",
              engine: "d1-simulator",
              severity: "error",
              file: relFile,
              line: lineNum,
              message: `CREATE TRIGGER uses lowercase "begin". Remote D1's statement splitter splits inside the trigger body and fails with D1_EXEC_ERROR.`,
              issueUrl: "https://github.com/cloudflare/workers-sdk/issues/15314",
              suggestion: `Use uppercase "BEGIN" and "END;" in CREATE TRIGGER statements.`
            });
          }
        }

        // WD201b: LF-only multi-statement file ending with a trigger (#15690)
        const statementsRough = rawSql
          .replace(/--.*$/gm, "")
          .trim()
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
        if (
          statementsRough.length > 1 &&
          !rawSql.includes("\r\n") &&
          /CREATE\s+(?:TEMP|TEMPORARY\s+)?TRIGGER\b/i.test(
            statementsRough[statementsRough.length - 1]
          ) &&
          !/;\s*\n\s*--\s*splittable/i.test(rawSql)
        ) {
          findings.push({
            ruleId: "WD201",
            engine: "d1-simulator",
            severity: "warning",
            file: relFile,
            line: lines.length,
            message: `LF-only multi-statement migration ends with a CREATE TRIGGER. Remote D1 /query can fail with "incomplete input" unless followed by a trailing statement or comment.`,
            issueUrl: "https://github.com/cloudflare/workers-sdk/issues/15690",
            suggestion: `Place CREATE TRIGGER in its own migration file or add a trailing "SELECT 1;" after END;.`
          });
        }

        // WD201c: Leading SQL comment at offset 0 in batch/migration statement (#16319)
        if (/^(?:--|\/\*)/.test(rawSql) && statementsRough.length > 1) {
          findings.push({
            ruleId: "WD201",
            engine: "d1-simulator",
            severity: "warning",
            file: relFile,
            line: 1,
            message: `Migration starts with a SQL comment at byte offset 0 across multiple statements, which diverges in remote D1 batch/statement parsing.`,
            issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16319",
            suggestion: `Remove or move the leading comment at offset 0 in ${relFile}.`
          });
        }

        // WD202: Banned interactive transaction statements (#2733)
        for (let i = 0; i < lines.length; i++) {
          const cleanLine = lines[i].replace(/--.*$/, "").trim();
          if (
            /^(BEGIN\s+(?:TRANSACTION|IMMEDIATE|DEFERRED|EXCLUSIVE)|BEGIN\s*;|COMMIT\b|ROLLBACK\b|SAVEPOINT\b)/i.test(
              cleanLine
            )
          ) {
            findings.push({
              ruleId: "WD202",
              engine: "d1-simulator",
              severity: "error",
              file: relFile,
              line: i + 1,
              message: `Migration contains "${cleanLine}". Remote D1 rejects explicit transaction statements in migrations.`,
              issueUrl: "https://github.com/cloudflare/workers-sdk/issues/2733",
              suggestion: `Remove BEGIN/COMMIT/SAVEPOINT from ${relFile}; D1 wraps migrations automatically.`
            });
          }

          // WD205b: PRAGMA foreign_keys = OFF instead of defer_foreign_keys = ON
          if (/^PRAGMA\s+foreign_keys\s*=\s*(?:OFF|0)/i.test(cleanLine)) {
            findings.push({
              ruleId: "WD205",
              engine: "d1-simulator",
              severity: "warning",
              file: relFile,
              line: i + 1,
              message: `"${cleanLine}" is a no-op or unsafe in remote D1 migrations.`,
              issueUrl: "https://github.com/cloudflare/workers-sdk/issues/11708",
              suggestion: `Use "PRAGMA defer_foreign_keys = ON;" for D1 table rebuild migrations.`
            });
          }

          // WD204a: ALTER TABLE ADD COLUMN NOT NULL without DEFAULT
          const addColMatch = cleanLine.match(
            /ALTER\s+TABLE\s+[`"']?([a-zA-Z0-9_]+)[`"']?\s+ADD\s+(?:COLUMN\s+)?[`"']?([a-zA-Z0-9_]+)[`"']?\s+(.+)/i
          );
          if (addColMatch) {
            const [, tbl, col, rest] = addColMatch;
            if (/\bNOT\s+NULL\b/i.test(rest) && !/\bDEFAULT\b/i.test(rest)) {
              findings.push({
                ruleId: "WD204",
                engine: "d1-simulator",
                severity: "error",
                file: relFile,
                line: i + 1,
                message: `ALTER TABLE ${tbl} ADD COLUMN ${col} is NOT NULL without a DEFAULT value, which fails on non-empty tables in D1.`,
                issueUrl: "https://github.com/cloudflare/workers-sdk/issues/11708",
                suggestion: `Add a DEFAULT clause or make column "${col}" nullable.`
              });
            }
            if (isLatestMigration) {
              latestAddedColumns.push({ table: tbl, column: col, file: relFile, line: i + 1 });
            }
          }
        }

        // Track CREATE INDEX and REFERENCES for WD205 row-read cost check
        const indexRegex =
          /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?[a-zA-Z0-9_]+[`"']?\s+ON\s+[`"']?([a-zA-Z0-9_]+)[`"']?\s*\(\s*[`"']?([a-zA-Z0-9_]+)[`"']?/gi;
        let idxMatch: RegExpExecArray | null;
        while ((idxMatch = indexRegex.exec(rawSql)) !== null) {
          indexedColumns.add(`${idxMatch[1].toLowerCase()}.${idxMatch[2].toLowerCase()}`);
        }

        const createTableRegex =
          /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_]+)[`"']?\s*\(([\s\S]*?)\);/gi;
        let tblMatch: RegExpExecArray | null;
        while ((tblMatch = createTableRegex.exec(rawSql)) !== null) {
          const tableName = tblMatch[1];
          const body = tblMatch[2];
          const baseLine = rawSql.slice(0, tblMatch.index).split(/\r?\n/).length;
          const bodyLines = body.split(/\r?\n/);
          for (let j = 0; j < bodyLines.length; j++) {
            const bLine = bodyLines[j].replace(/--.*$/, "").trim();
            const fkInline = bLine.match(
              /^[`"']?([a-zA-Z0-9_]+)[`"']?\s+[A-Z0-9()]+\s+.*?REFERENCES\s+[`"']?([a-zA-Z0-9_]+)[`"']?/i
            );
            if (fkInline && !/\bPRIMARY\s+KEY\b|\bUNIQUE\b/i.test(bLine)) {
              foreignKeys.push({
                table: tableName,
                column: fkInline[1],
                refTable: fkInline[2],
                file: relFile,
                line: baseLine + j
              });
            }
          }
        }

        // WD203: Execute migration in in-memory SQLite (stripping explicit BEGIN/COMMIT if present so we still validate DDL)
        const runnableSql = rawSql
          .replace(/^\s*BEGIN\s*(?:TRANSACTION|IMMEDIATE|DEFERRED|EXCLUSIVE)?\s*;/gim, "")
          .replace(/^\s*COMMIT\s*;/gim, "");
        try {
          db.exec(runnableSql);
        } catch (err) {
          findings.push({
            ruleId: "WD203",
            engine: "d1-simulator",
            severity: "error",
            file: relFile,
            line: 1,
            message: `In-memory SQLite migration execution failed: ${(err as Error).message}`,
            issueUrl: "https://github.com/cloudflare/workers-sdk/issues/11708",
            suggestion: `Fix SQL syntax or table ordering in ${relFile}.`
          });
        }
      }

      // WD205: Report unindexed foreign keys via EXPLAIN QUERY PLAN on in-memory SQLite
      for (const fk of foreignKeys) {
        const key = `${fk.table.toLowerCase()}.${fk.column.toLowerCase()}`;
        if (!indexedColumns.has(key)) {
          let planDetail = "SCAN";
          try {
            const plan = db.queryAll(
              `EXPLAIN QUERY PLAN SELECT 1 FROM "${fk.table}" WHERE "${fk.column}" = 1`
            );
            if (plan.length > 0 && typeof plan[0].detail === "string") {
              planDetail = plan[0].detail;
            }
          } catch {
            // ignore if table failed earlier
          }
          findings.push({
            ruleId: "WD205",
            engine: "d1-simulator",
            severity: "warning",
            file: fk.file,
            line: fk.line,
            message: `Foreign key "${fk.table}.${fk.column}" -> "${fk.refTable}" has no index (${planDetail}). Joins and deletes on "${fk.refTable}" trigger full table scans billed per row read in D1.`,
            issueUrl: "https://github.com/cloudflare/workers-sdk/issues/6226",
            suggestion: `Add "CREATE INDEX idx_${fk.table}_${fk.column} ON ${fk.table}(${fk.column});".`
          });
        }
      }

      // WD204b: Workers Builds Deploy Skew (latest migration N adds column queried in src/ without N-1 fallback)
      if (latestAddedColumns.length > 0) {
        for (const added of latestAddedColumns) {
          for (const tsFile of tsFiles) {
            const content = readFileSync(tsFile, "utf8");
            if (content.includes(added.column)) {
              findings.push({
                ruleId: "WD204",
                engine: "d1-simulator",
                severity: "warning",
                file: added.file,
                line: added.line,
                message: `Workers Builds deploy skew risk: latest migration adds "${added.table}.${added.column}", which is referenced in ${relative(projectDir, tsFile)}. If Worker code deploys before "d1 migrations apply --remote", queries selecting "${added.column}" fail with "D1_ERROR: no such column".`,
                issueUrl: "https://github.com/cloudflare/workers-sdk/issues/11708",
                suggestion: `Run "wrangler d1 migrations apply --remote" before deploying the Worker, or deploy the migration in release N-1 first.`
              });
              break;
            }
          }
        }
      }
    } finally {
      db.close();
    }
  }

  // WD206: Scan source files for >100 bound parameters in .bind(...) or SQL placeholders (#6226)
  for (const file of tsFiles) {
    const content = readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const qMarks = (line.match(/\?/g) ?? []).length;
      if (qMarks > 100) {
        findings.push({
          ruleId: "WD206",
          engine: "d1-simulator",
          severity: "error",
          file: relative(projectDir, file),
          line: i + 1,
          message: `SQL query contains ${qMarks} bound parameters, exceeding D1's hard limit of 100 parameters per query.`,
          issueUrl: "https://github.com/cloudflare/workers-sdk/issues/6226",
          suggestion: `Chunk parameter arrays into batches of <= 100 and execute with db.batch().`
        });
      }
      if (/\.bind\(\s*\.\.\.[a-zA-Z0-9_.]+\s*\)/.test(line) && !/slice|chunk/i.test(content)) {
        findings.push({
          ruleId: "WD206",
          engine: "d1-simulator",
          severity: "warning",
          file: relative(projectDir, file),
          line: i + 1,
          message: `Unbounded spread ".bind(...)" detected. Remote D1 throws D1_ERROR if the spread array exceeds 100 elements.`,
          issueUrl: "https://github.com/cloudflare/workers-sdk/issues/6226",
          suggestion: `Chunk dynamic arrays to <= 100 items before calling .bind(...).`
        });
      }
    }
  }

  return findings;
}

function escapeSqlValue(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number" || typeof val === "bigint") return String(val);
  if (typeof val === "boolean") return val ? "1" : "0";
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
    return `X'${Buffer.from(val).toString("hex")}'`;
  }
  return `'${String(val).replace(/'/g, "''")}'`;
}

export interface ExportLocalD1Options {
  schemaOnly?: boolean;
  dataOnly?: boolean;
  table?: string;
}

export function exportLocalD1Sql(
  sqlitePath: string,
  options: ExportLocalD1Options = {}
): string {
  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite database file not found: ${sqlitePath}`);
  }
  const db = openSqlite(sqlitePath);
  const out: string[] = ["PRAGMA defer_foreign_keys=TRUE;"];

  try {
    const objects = db.queryAll(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE sql IS NOT NULL
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_cf_%'
       ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 WHEN 'view' THEN 4 ELSE 5 END, name`
    );

    const tables = objects.filter((o) => o.type === "table" && (!options.table || o.name === options.table));
    const others = objects.filter((o) => o.type !== "table");

    if (!options.dataOnly) {
      for (const t of tables) {
        out.push(`${String(t.sql).trim().replace(/;$/, "")};`);
      }
    }

    if (!options.schemaOnly) {
      for (const t of tables) {
        const tableName = String(t.name);
        const rows = db.queryAll(`SELECT * FROM "${tableName.replace(/"/g, '""')}"`);
        for (const row of rows) {
          const cols = Object.keys(row)
            .map((c) => `"${c.replace(/"/g, '""')}"`)
            .join(", ");
          const vals = Object.values(row).map(escapeSqlValue).join(", ");
          out.push(`INSERT INTO "${tableName.replace(/"/g, '""')}" (${cols}) VALUES (${vals});`);
        }
      }
    }

    if (!options.dataOnly) {
      for (const o of others) {
        out.push(`${String(o.sql).trim().replace(/;$/, "")};`);
      }
    }

    return out.join("\n") + "\n";
  } finally {
    db.close();
  }
}

/** Alias for `exportLocalD1Sql`. */
export const exportD1Sql = exportLocalD1Sql;

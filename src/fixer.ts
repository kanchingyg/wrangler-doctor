import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Finding } from "./types.js";

/**
 * Single auto-fixable file transformation generated from a diagnostic finding.
 */
export interface FixEdit {
  /** Rule identifier that triggered the edit (`WD201`, `WD202`, etc.). */
  ruleId: string;
  /** Relative path of the file from `projectDir`. */
  file: string;
  /** Human-readable description of the transformation. */
  description: string;
  /** Original file content before the fix. */
  before: string;
  /** Transformed file content after the fix. */
  after: string;
}

/**
 * Result of running `planFixes`, `applyFixes`, or `undoFixes`.
 */
export interface FixSummary {
  /** Mode executed (`dry-run`, `applied`, or `undone`). */
  mode: "dry-run" | "applied" | "undone";
  /** Planned or applied file edits. */
  edits: FixEdit[];
  /** Relative paths of `.wrangler-doctor.bak` backup files created or restored. */
  backupFiles: string[];
}

/**
 * Computes safe, deterministic source transformations for auto-fixable findings
 * without modifying files on disk (`--fix` dry-run mode).
 */
export function planFixes(projectDir: string, findings: Finding[]): FixEdit[] {
  const editsByFile = new Map<string, FixEdit>();
  const targetFiles = new Set<string>();

  for (const f of findings) {
    if (f.file && (f.ruleId === "WD201" || f.ruleId === "WD202")) {
      targetFiles.add(f.file);
    }
  }

  for (const relFile of targetFiles) {
    const absPath = join(projectDir, relFile);
    if (!existsSync(absPath)) continue;
    const before = readFileSync(absPath, "utf8");
    let after = before;
    const reasons: string[] = [];

    // WD201: Uppercase lowercase 'begin' and 'end;' in CREATE TRIGGER blocks
    const triggerReplaced = after.replace(
      /(\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b[\s\S]*?\b)(begin)(\b[\s\S]*?\b)(end\s*;)/gi,
      (_match, prefix: string, bw: string, mid: string, ew: string) => {
        if (bw === "begin" || ew.toLowerCase().startsWith("end")) {
          return `${prefix}BEGIN${mid}END;`;
        }
        return _match;
      }
    );
    if (triggerReplaced !== after) {
      after = triggerReplaced;
      reasons.push("WD201: Normalize CREATE TRIGGER begin/end; to uppercase BEGIN/END;");
    }

    // WD202: Strip top-level BEGIN TRANSACTION / COMMIT / ROLLBACK statements in D1 migrations
    const txReplaced = after
      .replace(/^\s*BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?\s*;\s*\r?\n?/gim, "")
      .replace(/^\s*(?:COMMIT(?:\s+TRANSACTION)?|END\s+TRANSACTION|ROLLBACK(?:\s+TRANSACTION)?)\s*;\s*\r?\n?/gim, "");
    if (txReplaced !== after) {
      after = txReplaced;
      reasons.push("WD202: Remove explicit BEGIN/COMMIT transaction wrappers rejected by remote D1");
    }

    if (after !== before) {
      editsByFile.set(relFile, {
        ruleId: reasons.map((r) => r.split(":")[0]).join(","),
        file: relFile,
        description: reasons.join("; "),
        before,
        after
      });
    }
  }

  return [...editsByFile.values()];
}

/**
 * Writes planned fixes to disk after creating `<file>.wrangler-doctor.bak` backups (`--apply`).
 */
export function applyFixes(projectDir: string, findings: Finding[]): FixSummary {
  const edits = planFixes(projectDir, findings);
  const backupFiles: string[] = [];

  for (const edit of edits) {
    const absPath = join(projectDir, edit.file);
    const bakPath = `${absPath}.wrangler-doctor.bak`;
    copyFileSync(absPath, bakPath);
    writeFileSync(absPath, edit.after, "utf8");
    backupFiles.push(relative(projectDir, bakPath));
  }

  return {
    mode: "applied",
    edits,
    backupFiles
  };
}

/**
 * Restores any `<file>.wrangler-doctor.bak` files created by `applyFixes` (`--undo`).
 */
export function undoFixes(projectDir: string, candidateFiles: string[]): FixSummary {
  const restored: string[] = [];
  for (const relFile of candidateFiles) {
    const absPath = join(projectDir, relFile);
    const bakPath = `${absPath}.wrangler-doctor.bak`;
    if (existsSync(bakPath)) {
      copyFileSync(bakPath, absPath);
      unlinkSync(bakPath);
      restored.push(relFile);
    }
  }
  return {
    mode: "undone",
    edits: [],
    backupFiles: restored
  };
}

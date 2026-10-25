import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Finding, ParsedWorkerConfig } from "../types.js";
import { collectTsFiles } from "./env-matrix.js";

const WORKFLOW_ID_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

const GLOBAL_DISALLOWED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bfetch\s*\(/, label: "fetch()" },
  { pattern: /\bDate\.now\s*\(\)/, label: "Date.now()" },
  { pattern: /\bMath\.random\s*\(\)/, label: "Math.random()" },
  { pattern: /\bcrypto\.getRandomValues\s*\(/, label: "crypto.getRandomValues()" },
  { pattern: /\bcrypto\.randomUUID\s*\(\)/, label: "crypto.randomUUID()" },
  { pattern: /\bsetTimeout\s*\(/, label: "setTimeout()" },
  { pattern: /\bsetInterval\s*\(/, label: "setInterval()" }
];

function findTopLevelDisallowedOps(content: string): Array<{ line: number; label: string }> {
  const results: Array<{ line: number; label: string }> = [];
  const lines = content.split(/\r?\n/);
  let braceDepth = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    let clean = "";
    let inStr: string | null = null;

    for (let c = 0; c < rawLine.length; c++) {
      const ch = rawLine[c];
      const next = rawLine[c + 1];
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          c++;
        }
        continue;
      }
      if (inStr) {
        if (ch === "\\") {
          c++;
          continue;
        }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        c++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inStr = ch;
        continue;
      }
      clean += ch;
    }

    const isFnDecl =
      /\b(?:function|class)\b/.test(clean) ||
      /=>\s*\{?/.test(clean);

    if (braceDepth === 0 && !isFnDecl) {
      for (const item of GLOBAL_DISALLOWED_PATTERNS) {
        if (item.pattern.test(clean)) {
          results.push({ line: i + 1, label: item.label });
        }
      }
    }

    for (const ch of clean) {
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return results;
}

export function checkWorkerdContracts(
  projectDir: string,
  parsedConfig: ParsedWorkerConfig | null
): Finding[] {
  const findings: Finding[] = [];
  const srcDir = existsSync(join(projectDir, "src")) ? join(projectDir, "src") : projectDir;
  const tsFiles = collectTsFiles(srcDir);

  const classesUsingSqliteStorage = new Set<string>();

  for (const file of tsFiles) {
    const relFile = relative(projectDir, file);
    const content = readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);

    // WD301: Global scope disallowed operations (workerd#2490, workers-sdk#9489)
    for (const hit of findTopLevelDisallowedOps(content)) {
      findings.push({
        ruleId: "WD301",
        engine: "workerd-contracts",
        severity: "error",
        file: relFile,
        line: hit.line,
        message: `Top-level "${hit.label}" call in module global scope crashes workerd at startup with "Disallowed operation called within global scope".`,
        issueUrl: "https://github.com/cloudflare/workerd/issues/2490",
        suggestion: `Move "${hit.label}" inside fetch(), scheduled(), queue(), or a lazy initializer function.`
      });
    }

    // WD302: Next.js 16 "use cache" + Date.now() (opennextjs-cloudflare#1458)
    if (content.includes('"use cache"') || content.includes("'use cache'")) {
      for (let i = 0; i < lines.length; i++) {
        if (/\bDate\.now\s*\(\)/.test(lines[i])) {
          findings.push({
            ruleId: "WD302",
            engine: "workerd-contracts",
            severity: "error",
            file: relFile,
            line: i + 1,
            message: `Date.now() inside a "use cache" module breaks Next.js 16 Cache Components prerendering on Cloudflare Workers.`,
            issueUrl: "https://github.com/opennextjs/opennextjs-cloudflare/issues/1458",
            suggestion: `Avoid Date.now() inside cached components or pass request timestamps as props.`
          });
        }
      }
    }

    // WD303: Workflow.create({ id: ... }) invalid characters or > 64 chars
    // WD306: Floating promise in handler without await / return / ctx.waitUntil()
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const literalMatch = line.match(/\.create\s*\(\s*\{[^}]*\bid\s*:\s*(['"`])([^'"`]+)\1/);
      if (literalMatch) {
        const quote = literalMatch[1];
        const rawId = literalMatch[2];
        if (quote === "`") {
          const staticParts = rawId.replace(/\$\{[^}]+\}/g, "x");
          if (!WORKFLOW_ID_REGEX.test(staticParts)) {
            findings.push({
              ruleId: "WD303",
              engine: "workerd-contracts",
              severity: "error",
              file: relFile,
              line: i + 1,
              message: `Workflow instance id template "${rawId}" contains characters outside ^[a-zA-Z0-9_][a-zA-Z0-9-_]*$ (such as ":" or "/"), which throws a 500 error in Cloudflare Workflows.`,
              issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16001",
              suggestion: `Replace ":" or "/" with "-" or "_" and keep the id <= 64 characters.`
            });
          }
        } else {
          if (rawId.length > 64 || !WORKFLOW_ID_REGEX.test(rawId)) {
            findings.push({
              ruleId: "WD303",
              engine: "workerd-contracts",
              severity: "error",
              file: relFile,
              line: i + 1,
              message: `Workflow instance id "${rawId}" violates Cloudflare Workflows contract (must match ^[a-zA-Z0-9_][a-zA-Z0-9-_]*$ and be <= 64 chars; got length ${rawId.length}).`,
              issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16001",
              suggestion: `Use only alphanumeric characters, "_", or "-", and cap length at 64 characters.`
            });
          }
        }
      }

      // WD306: Standalone un-awaited async binding/fetch statement inside handler
      const trimmed = line.replace(/\/\/.*$/, "").trim();
      if (
        /^(?:fetch\s*\(|(?:c\.env|env)\.[A-Z0-9_]+\.(?:fetch|put|delete|send|sendBatch|create)\s*\()/.test(
          trimmed
        ) &&
        !trimmed.includes("waitUntil")
      ) {
        findings.push({
          ruleId: "WD306",
          engine: "workerd-contracts",
          severity: "warning",
          file: relFile,
          line: i + 1,
          message: `Un-awaited async call "${trimmed.slice(0, 48)}" may be canceled when the Worker returns a Response.`,
          issueUrl: "https://github.com/cloudflare/workerd/issues/2490",
          suggestion: `Use "await" or wrap background work in "ctx.waitUntil(...)".`
        });
      }
    }

    const simpleClassMatches = [
      ...content.matchAll(
        /class\s+([A-Za-z0-9_]+)\s+extends\s+(?:DurableObject|Server|Agent|AIChatAgent)/g
      )
    ];
    if (simpleClassMatches.length >= 1 && /\bstorage\.sql\b/.test(content)) {
      for (const m of simpleClassMatches) {
        classesUsingSqliteStorage.add(m[1]);
      }
    }
  }

  // WD304: Verify DO / Workflow class exports from main entrypoint and new_sqlite_classes migration
  if (parsedConfig) {
    const relConfig = relative(projectDir, parsedConfig.configPath) || "wrangler.jsonc";
    const mainFile = parsedConfig.main ? join(projectDir, parsedConfig.main) : null;
    const mainContent = mainFile && existsSync(mainFile) ? readFileSync(mainFile, "utf8") : null;

    for (const wf of parsedConfig.workflowClasses) {
      if (!wf.script_name && mainContent !== null) {
        const exported = new RegExp(
          `export\\s+(?:class|const|let|function)\\s+${wf.class_name}\\b|export\\s*\\{[^}]*\\b${wf.class_name}\\b[^}]*\\}`
        ).test(mainContent);
        if (!exported) {
          findings.push({
            ruleId: "WD304",
            engine: "workerd-contracts",
            severity: "error",
            binding: wf.binding,
            file: parsedConfig.main,
            message: `Workflow class "${wf.class_name}" (binding "${wf.binding}") is not exported from main entrypoint "${parsedConfig.main}".`,
            issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16012",
            suggestion: `Add "export { ${wf.class_name} }" to ${parsedConfig.main}.`
          });
        }
      }
    }

    for (const dobj of parsedConfig.durableObjectClasses) {
      if (!dobj.script_name && mainContent !== null) {
        const exported = new RegExp(
          `export\\s+(?:class|const|let|function)\\s+${dobj.class_name}\\b|export\\s*\\{[^}]*\\b${dobj.class_name}\\b[^}]*\\}`
        ).test(mainContent);
        if (!exported) {
          findings.push({
            ruleId: "WD304",
            engine: "workerd-contracts",
            severity: "error",
            binding: dobj.name,
            file: parsedConfig.main,
            message: `Durable Object class "${dobj.class_name}" (binding "${dobj.name}") is not exported from main entrypoint "${parsedConfig.main}".`,
            issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16012",
            suggestion: `Add "export { ${dobj.class_name} }" to ${parsedConfig.main}.`
          });
        }
      }

      if (
        classesUsingSqliteStorage.has(dobj.class_name) &&
        !parsedConfig.sqliteMigrationClasses.includes(dobj.class_name)
      ) {
        findings.push({
          ruleId: "WD304",
          engine: "workerd-contracts",
          severity: "error",
          binding: dobj.name,
          file: relConfig,
          message: `Durable Object "${dobj.class_name}" uses "storage.sql" but is missing from "migrations[].new_sqlite_classes" in ${relConfig}.`,
          issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16119",
          suggestion: `Add "${dobj.class_name}" to "new_sqlite_classes" in ${relConfig} migrations.`
        });
      }
    }

    // WD305: Workflows + wrangler versions upload trap (#16001)
    if (parsedConfig.workflowClasses.length > 0) {
      const pkgPath = join(projectDir, "package.json");
      if (existsSync(pkgPath)) {
        const pkgRaw = readFileSync(pkgPath, "utf8");
        if (pkgRaw.includes("versions upload")) {
          findings.push({
            ruleId: "WD305",
            engine: "workerd-contracts",
            severity: "warning",
            file: "package.json",
            message: `Project declares Cloudflare Workflows and runs "wrangler versions upload". Uploading a version binds Workflows without creating them, causing "workflow.not_found" at runtime until "wrangler deploy" runs.`,
            issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16001",
            suggestion: `Run "wrangler deploy" at least once when introducing a new Workflow binding before using "wrangler versions upload".`
          });
        }
      }
    }
    // WD307: Bundle size budget check (Free 3 MiB / Paid 10 MiB)
    const FREE_BUDGET_BYTES = 3 * 1024 * 1024;
    const PAID_BUDGET_BYTES = 10 * 1024 * 1024;
    const candidateBundles = [
      parsedConfig.main ? join(projectDir, parsedConfig.main) : null,
      join(projectDir, "dist/index.js"),
      join(projectDir, "dist/worker.js"),
      join(projectDir, ".open-next/worker.js")
    ].filter((p): p is string => Boolean(p));
    const checkedBundles = new Set<string>();
    for (const bundlePath of candidateBundles) {
      if (checkedBundles.has(bundlePath) || !existsSync(bundlePath)) continue;
      checkedBundles.add(bundlePath);
      const sizeBytes = statSync(bundlePath).size;
      const relBundle = relative(projectDir, bundlePath);
      if (sizeBytes > PAID_BUDGET_BYTES) {
        findings.push({
          ruleId: "WD307",
          engine: "workerd-contracts",
          severity: "error",
          file: relBundle,
          message: `Worker bundle "${relBundle}" is ${(sizeBytes / (1024 * 1024)).toFixed(2)} MiB, exceeding the 10 MiB Cloudflare Workers Paid plan size limit.`,
          issueUrl: "https://github.com/cloudflare/workers-sdk/issues/6321",
          suggestion: `Externalize large static assets to R2/Workers Assets and tree-shake heavy dependencies.`
        });
      } else if (sizeBytes > FREE_BUDGET_BYTES) {
        findings.push({
          ruleId: "WD307",
          engine: "workerd-contracts",
          severity: "warning",
          file: relBundle,
          message: `Worker bundle "${relBundle}" is ${(sizeBytes / (1024 * 1024)).toFixed(2)} MiB, exceeding the 3 MiB Cloudflare Workers Free plan limit (Paid limit is 10 MiB).`,
          issueUrl: "https://github.com/cloudflare/workers-sdk/issues/6321",
          suggestion: `Keep bundle under 3 MiB for Free plan deployments or verify Paid plan allocation.`
        });
      }
    }
  }

  return findings;
}

/** Alias for `checkWorkerdContracts`. */
export const lintWorkerdContracts = checkWorkerdContracts;

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Finding, ParsedWorkerConfig } from "../types.js";

export function checkCfMigrate(
  projectDir: string,
  parsedConfig: ParsedWorkerConfig | null
): Finding[] {
  const findings: Finding[] = [];
  if (!parsedConfig) return findings;

  const relWrangler = relative(projectDir, parsedConfig.configPath) || "wrangler.jsonc";

  // WD403: Service bindings with legacy "environment" field (#16167)
  for (const svc of parsedConfig.serviceEntries) {
    if (svc.environment) {
      findings.push({
        ruleId: "WD403",
        engine: "cf-migrate",
        severity: "warning",
        binding: svc.binding,
        env: svc.envScope === "top-level" ? undefined : svc.envScope,
        file: relWrangler,
        message: `Service binding "${svc.binding}" sets legacy property environment="${svc.environment}". The "cf deploy" comparator flags this as destructive (environment__deleted) while "--dry-run" silently passes.`,
        issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16167",
        suggestion: `Target the environment-specific Worker name directly in "service" instead of using the legacy "environment" field.`
      });
    }
  }

  // If cloudflare.config.ts is present, audit migration parity (#16119, #16124, #16125)
  const cfConfigPath = join(projectDir, "cloudflare.config.ts");
  if (!existsSync(cfConfigPath)) return findings;

  const cfContent = readFileSync(cfConfigPath, "utf8");

  // WD401: Workflows or Durable Objects dropped during cf migrate (#16119)
  for (const wf of parsedConfig.workflowClasses) {
    if (!cfContent.includes(wf.binding) || !cfContent.includes(wf.class_name)) {
      findings.push({
        ruleId: "WD401",
        engine: "cf-migrate",
        severity: "error",
        binding: wf.binding,
        file: "cloudflare.config.ts",
        message: `Workflow binding "${wf.binding}" (${wf.class_name}) from ${relWrangler} is missing in cloudflare.config.ts ("cf migrate" drops Workflow bindings).`,
        issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16119",
        suggestion: `Manually add Workflow binding "${wf.binding}" (${wf.class_name}) to cloudflare.config.ts.`
      });
    }
  }

  for (const dobj of parsedConfig.durableObjectClasses) {
    if (!cfContent.includes(dobj.name) || !cfContent.includes(dobj.class_name)) {
      findings.push({
        ruleId: "WD401",
        engine: "cf-migrate",
        severity: "error",
        binding: dobj.name,
        file: "cloudflare.config.ts",
        message: `Durable Object "${dobj.name}" (${dobj.class_name}) from ${relWrangler} is missing in cloudflare.config.ts.`,
        issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16119",
        suggestion: `Declare Durable Object "${dobj.name}" (${dobj.class_name}) in cloudflare.config.ts.`
      });
    }
  }

  // WD402: D1 migrations_dir and upload_source_maps dropped (#16124)
  for (const d1 of parsedConfig.d1Configs) {
    if (d1.migrations_dir && !cfContent.includes(d1.migrations_dir)) {
      findings.push({
        ruleId: "WD402",
        engine: "cf-migrate",
        severity: "warning",
        binding: d1.binding,
        file: "cloudflare.config.ts",
        message: `D1 binding "${d1.binding}" uses custom migrations_dir "${d1.migrations_dir}" in ${relWrangler}, which D1BindingOptions in @cloudflare/config drops.`,
        issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16124",
        suggestion: `Pass explicit migrations directory when running D1 migration tooling or keep ${relWrangler} for D1 migrations.`
      });
    }
  }

  if (parsedConfig.uploadSourceMaps === true && !/uploadSourceMaps|upload_source_maps/.test(cfContent)) {
    findings.push({
      ruleId: "WD402",
      engine: "cf-migrate",
      severity: "warning",
      file: "cloudflare.config.ts",
      message: `"upload_source_maps: true" from ${relWrangler} is missing in cloudflare.config.ts.`,
      issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16124",
      suggestion: `Enable source maps in your build/deploy pipeline when migrating to cloudflare.config.ts.`
    });
  }

  // WD404: workers_dev parity (#16125)
  if (parsedConfig.workersDev === true && !/workersDev|workers_dev/.test(cfContent)) {
    findings.push({
      ruleId: "WD404",
      engine: "cf-migrate",
      severity: "warning",
      file: "cloudflare.config.ts",
      message: `${relWrangler} sets "workers_dev: true", but cloudflare.config.ts omits it (risking disabling the *.workers.dev subdomain on deploy).`,
      issueUrl: "https://github.com/cloudflare/workers-sdk/issues/16125",
      suggestion: `Set workers_dev/workersDev explicitly in cloudflare.config.ts.`
    });
  }

  return findings;
}

/** Alias for `checkCfMigrate`. */
export const auditCfConfigMigration = checkCfMigrate;

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { BindingSet, Finding, ParsedWorkerConfig } from "../types.js";

export function emptyBindingSet(): BindingSet {
  return {
    d1_databases: [],
    kv_namespaces: [],
    r2_buckets: [],
    services: [],
    queues_producers: [],
    workflows: [],
    durable_objects: [],
    vars: [],
    ai: [],
    hyperdrive: [],
    vectorize: []
  };
}

export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let stringChar = '"';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        if (input[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function extractBindingsFromRawObj(obj: Record<string, unknown>): {
  set: BindingSet;
  present: Partial<Record<keyof BindingSet, boolean>>;
} {
  const set = emptyBindingSet();
  const present: Partial<Record<keyof BindingSet, boolean>> = {};

  const arrayNameKey = (
    prop: string,
    field: "binding" | "name",
    targetKey: keyof BindingSet
  ) => {
    if (Array.isArray(obj[prop])) {
      present[targetKey] = true;
      for (const item of obj[prop] as Record<string, unknown>[]) {
        const val = item?.[field] ?? item?.binding ?? item?.name;
        if (typeof val === "string") set[targetKey].push(val);
      }
    }
  };

  arrayNameKey("d1_databases", "binding", "d1_databases");
  arrayNameKey("kv_namespaces", "binding", "kv_namespaces");
  arrayNameKey("r2_buckets", "binding", "r2_buckets");
  arrayNameKey("services", "binding", "services");
  arrayNameKey("workflows", "binding", "workflows");
  arrayNameKey("hyperdrive", "binding", "hyperdrive");
  arrayNameKey("vectorize", "binding", "vectorize");

  if (obj.queues && typeof obj.queues === "object") {
    const q = obj.queues as Record<string, unknown>;
    if (Array.isArray(q.producers)) {
      present.queues_producers = true;
      for (const p of q.producers as Record<string, unknown>[]) {
        const b = p?.binding;
        if (typeof b === "string") set.queues_producers.push(b);
      }
    }
  }

  if (obj.durable_objects && typeof obj.durable_objects === "object") {
    const d = obj.durable_objects as Record<string, unknown>;
    if (Array.isArray(d.bindings)) {
      present.durable_objects = true;
      for (const b of d.bindings as Record<string, unknown>[]) {
        const name = b?.name ?? b?.binding;
        if (typeof name === "string") set.durable_objects.push(name);
      }
    }
  }

  if (obj.vars && typeof obj.vars === "object" && !Array.isArray(obj.vars)) {
    present.vars = true;
    for (const k of Object.keys(obj.vars as Record<string, unknown>)) {
      set.vars.push(k);
    }
  }

  if (obj.ai && typeof obj.ai === "object" && !Array.isArray(obj.ai)) {
    present.ai = true;
    const b = (obj.ai as Record<string, unknown>).binding;
    if (typeof b === "string") set.ai.push(b);
  }

  return { set, present };
}

function parseTomlMinimal(content: string, configPath: string): ParsedWorkerConfig {
  const topLevel = emptyBindingSet();
  const envBindings: Record<string, BindingSet> = {};
  const rawEnvPresent: Record<string, Partial<Record<keyof BindingSet, boolean>>> = {};
  const varsValues: Record<string, string> = {};
  const d1Configs: ParsedWorkerConfig["d1Configs"] = [];
  const workflowClasses: ParsedWorkerConfig["workflowClasses"] = [];
  const durableObjectClasses: ParsedWorkerConfig["durableObjectClasses"] = [];
  const sqliteMigrationClasses: string[] = [];
  const allMigrationClasses: string[] = [];
  const serviceEntries: ParsedWorkerConfig["serviceEntries"] = [];

  let name: string | undefined;
  let main: string | undefined;
  let workersDev: boolean | undefined;
  let uploadSourceMaps: boolean | undefined;

  let currentSection = "";
  let currentArrayBlock: {
    envName?: string;
    type: string;
    record: Record<string, string | string[]>;
  } | null = null;

  const flushBlock = () => {
    if (!currentArrayBlock) return;
    const { envName, type, record } = currentArrayBlock;
    const target = envName ? (envBindings[envName] ??= emptyBindingSet()) : topLevel;
    const present = envName ? (rawEnvPresent[envName] ??= {}) : {};

    const b = typeof record.binding === "string" ? record.binding : typeof record.name === "string" ? record.name : undefined;
    if (type === "d1_databases" && b) {
      target.d1_databases.push(b);
      present.d1_databases = true;
      if (!envName) {
        d1Configs.push({
          binding: b,
          database_name: typeof record.database_name === "string" ? record.database_name : undefined,
          migrations_dir: typeof record.migrations_dir === "string" ? record.migrations_dir : undefined
        });
      }
    } else if (type === "kv_namespaces" && b) {
      target.kv_namespaces.push(b);
      present.kv_namespaces = true;
    } else if (type === "r2_buckets" && b) {
      target.r2_buckets.push(b);
      present.r2_buckets = true;
    } else if (type === "services" && b) {
      target.services.push(b);
      present.services = true;
      serviceEntries.push({
        binding: b,
        service: typeof record.service === "string" ? record.service : "",
        environment: typeof record.environment === "string" ? record.environment : undefined,
        envScope: envName ?? "top-level"
      });
    } else if (type === "workflows" && b) {
      target.workflows.push(b);
      present.workflows = true;
      if (!envName && typeof record.class_name === "string") {
        workflowClasses.push({
          binding: b,
          name: typeof record.name === "string" ? record.name : b,
          class_name: record.class_name,
          script_name: typeof record.script_name === "string" ? record.script_name : undefined
        });
      }
    } else if (type === "queues.producers" && b) {
      target.queues_producers.push(b);
      present.queues_producers = true;
    } else if (type === "durable_objects.bindings" && b) {
      target.durable_objects.push(b);
      present.durable_objects = true;
      if (!envName && typeof record.class_name === "string") {
        durableObjectClasses.push({
          name: b,
          class_name: record.class_name,
          script_name: typeof record.script_name === "string" ? record.script_name : undefined
        });
      }
    } else if (type === "migrations") {
      const sqliteList = Array.isArray(record.new_sqlite_classes) ? record.new_sqlite_classes : [];
      const newList = Array.isArray(record.new_classes) ? record.new_classes : [];
      sqliteMigrationClasses.push(...sqliteList);
      allMigrationClasses.push(...sqliteList, ...newList);
    }
    currentArrayBlock = null;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    if (line.startsWith("[[") && line.endsWith("]]")) {
      flushBlock();
      const header = line.slice(2, -2).trim();
      const envMatch = header.match(/^env\.([a-zA-Z0-9_-]+)\.(.+)$/);
      if (envMatch) {
        envBindings[envMatch[1]] ??= emptyBindingSet();
        rawEnvPresent[envMatch[1]] ??= {};
        currentArrayBlock = { envName: envMatch[1], type: envMatch[2], record: {} };
      } else {
        currentArrayBlock = { type: header, record: {} };
      }
      currentSection = "";
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      flushBlock();
      currentSection = line.slice(1, -1).trim();
      const envOnly = currentSection.match(/^env\.([a-zA-Z0-9_-]+)$/);
      if (envOnly) {
        envBindings[envOnly[1]] ??= emptyBindingSet();
        rawEnvPresent[envOnly[1]] ??= {};
      }
      const envSub = currentSection.match(/^env\.([a-zA-Z0-9_-]+)\.vars$/);
      if (envSub) {
        envBindings[envSub[1]] ??= emptyBindingSet();
        (rawEnvPresent[envSub[1]] ??= {}).vars = true;
      }
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const rawVal = kvMatch[2].trim();
    const strVal = rawVal.replace(/^["']|["']$/g, "");

    if (currentArrayBlock) {
      if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        const items = rawVal
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        currentArrayBlock.record[key] = items;
      } else {
        currentArrayBlock.record[key] = strVal;
      }
      continue;
    }

    if (currentSection === "") {
      if (key === "name") name = strVal;
      if (key === "main") main = strVal;
      if (key === "workers_dev") workersDev = rawVal === "true";
      if (key === "upload_source_maps") uploadSourceMaps = rawVal === "true";
    } else if (currentSection === "vars") {
      topLevel.vars.push(key);
      varsValues[key] = strVal;
    } else if (currentSection === "ai" && key === "binding") {
      topLevel.ai.push(strVal);
    } else {
      const envVarsMatch = currentSection.match(/^env\.([a-zA-Z0-9_-]+)\.vars$/);
      if (envVarsMatch) {
        const envName = envVarsMatch[1];
        envBindings[envName] ??= emptyBindingSet();
        envBindings[envName].vars.push(key);
        varsValues[`${envName}.${key}`] = strVal;
      }
    }
  }
  flushBlock();

  return {
    configPath,
    format: "toml",
    name,
    main,
    workersDev,
    uploadSourceMaps,
    topLevelBindings: topLevel,
    envBindings,
    rawEnvPresent,
    varsValues,
    d1Configs,
    workflowClasses,
    durableObjectClasses,
    sqliteMigrationClasses,
    allMigrationClasses,
    serviceEntries
  };
}

export function parseWorkerConfig(projectDir: string): ParsedWorkerConfig | null {
  const jsoncPath = join(projectDir, "wrangler.jsonc");
  const jsonPath = join(projectDir, "wrangler.json");
  const tomlPath = join(projectDir, "wrangler.toml");

  const targetJson = existsSync(jsoncPath) ? jsoncPath : existsSync(jsonPath) ? jsonPath : null;
  if (targetJson) {
    const raw = readFileSync(targetJson, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
    const top = extractBindingsFromRawObj(parsed);
    const envBindings: Record<string, BindingSet> = {};
    const rawEnvPresent: Record<string, Partial<Record<keyof BindingSet, boolean>>> = {};
    const varsValues: Record<string, string> = {};
    const serviceEntries: ParsedWorkerConfig["serviceEntries"] = [];

    if (parsed.vars && typeof parsed.vars === "object") {
      for (const [k, v] of Object.entries(parsed.vars as Record<string, unknown>)) {
        varsValues[k] = String(v);
      }
    }

    if (Array.isArray(parsed.services)) {
      for (const s of parsed.services as Record<string, unknown>[]) {
        if (typeof s?.binding === "string") {
          serviceEntries.push({
            binding: s.binding,
            service: typeof s.service === "string" ? s.service : "",
            environment: typeof s.environment === "string" ? s.environment : undefined,
            envScope: "top-level"
          });
        }
      }
    }

    if (parsed.env && typeof parsed.env === "object") {
      for (const [envName, envObj] of Object.entries(parsed.env as Record<string, unknown>)) {
        if (envObj && typeof envObj === "object") {
          const extracted = extractBindingsFromRawObj(envObj as Record<string, unknown>);
          envBindings[envName] = extracted.set;
          rawEnvPresent[envName] = extracted.present;
          const envRec = envObj as Record<string, unknown>;
          if (envRec.vars && typeof envRec.vars === "object") {
            for (const [k, v] of Object.entries(envRec.vars as Record<string, unknown>)) {
              varsValues[`${envName}.${k}`] = String(v);
            }
          }
          if (Array.isArray(envRec.services)) {
            for (const s of envRec.services as Record<string, unknown>[]) {
              if (typeof s?.binding === "string") {
                serviceEntries.push({
                  binding: s.binding,
                  service: typeof s.service === "string" ? s.service : "",
                  environment: typeof s.environment === "string" ? s.environment : undefined,
                  envScope: envName
                });
              }
            }
          }
        }
      }
    }

    const d1Configs: ParsedWorkerConfig["d1Configs"] = [];
    if (Array.isArray(parsed.d1_databases)) {
      for (const d of parsed.d1_databases as Record<string, unknown>[]) {
        if (typeof d?.binding === "string") {
          d1Configs.push({
            binding: d.binding,
            database_name: typeof d.database_name === "string" ? d.database_name : undefined,
            migrations_dir: typeof d.migrations_dir === "string" ? d.migrations_dir : undefined
          });
        }
      }
    }

    const workflowClasses: ParsedWorkerConfig["workflowClasses"] = [];
    if (Array.isArray(parsed.workflows)) {
      for (const w of parsed.workflows as Record<string, unknown>[]) {
        if (typeof w?.binding === "string" && typeof w?.class_name === "string") {
          workflowClasses.push({
            binding: w.binding,
            name: typeof w.name === "string" ? w.name : w.binding,
            class_name: w.class_name,
            script_name: typeof w.script_name === "string" ? w.script_name : undefined
          });
        }
      }
    }

    const durableObjectClasses: ParsedWorkerConfig["durableObjectClasses"] = [];
    if (parsed.durable_objects && typeof parsed.durable_objects === "object") {
      const dobj = parsed.durable_objects as Record<string, unknown>;
      if (Array.isArray(dobj.bindings)) {
        for (const b of dobj.bindings as Record<string, unknown>[]) {
          const name = typeof b?.name === "string" ? b.name : typeof b?.binding === "string" ? b.binding : undefined;
          if (name && typeof b?.class_name === "string") {
            durableObjectClasses.push({
              name,
              class_name: b.class_name,
              script_name: typeof b.script_name === "string" ? b.script_name : undefined
            });
          }
        }
      }
    }

    const sqliteMigrationClasses: string[] = [];
    const allMigrationClasses: string[] = [];
    if (Array.isArray(parsed.migrations)) {
      for (const m of parsed.migrations as Record<string, unknown>[]) {
        if (Array.isArray(m?.new_sqlite_classes)) {
          for (const c of m.new_sqlite_classes) {
            if (typeof c === "string") {
              sqliteMigrationClasses.push(c);
              allMigrationClasses.push(c);
            }
          }
        }
        if (Array.isArray(m?.new_classes)) {
          for (const c of m.new_classes) {
            if (typeof c === "string") allMigrationClasses.push(c);
          }
        }
      }
    }

    return {
      configPath: targetJson,
      format: "jsonc",
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      main: typeof parsed.main === "string" ? parsed.main : undefined,
      workersDev: typeof parsed.workers_dev === "boolean" ? parsed.workers_dev : undefined,
      uploadSourceMaps: typeof parsed.upload_source_maps === "boolean" ? parsed.upload_source_maps : undefined,
      topLevelBindings: top.set,
      envBindings,
      rawEnvPresent,
      varsValues,
      d1Configs,
      workflowClasses,
      durableObjectClasses,
      sqliteMigrationClasses,
      allMigrationClasses,
      serviceEntries
    };
  }

  if (existsSync(tomlPath)) {
    return parseTomlMinimal(readFileSync(tomlPath, "utf8"), tomlPath);
  }

  return null;
}

export function flattenBindings(set: BindingSet): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(set)) {
    for (const item of list) out.add(item);
  }
  return out;
}

export function collectTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === ".wrangler") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsFiles(full, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function parseDtsEnvKeys(projectDir: string): { file: string; keys: Set<string> } | null {
  const candidates = ["worker-configuration.d.ts", "env.d.ts", "cloudflare-env.d.ts"];
  for (const name of candidates) {
    const p = join(projectDir, name);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    const keys = new Set<string>();
    const blockMatch = content.match(/interface\s+(?:Env|CloudflareEnv)\s*\{([\s\S]*?)\}/);
    if (blockMatch) {
      const body = blockMatch[1];
      for (const line of body.split(/\r?\n/)) {
        const m = line.trim().match(/^([a-zA-Z0-9_]+)\??\s*:/);
        if (m) keys.add(m[1]);
      }
      return { file: name, keys };
    }
  }
  return null;
}

function parseDevVarsKeys(filePath: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(filePath)) return keys;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z0-9_]+)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const SECRET_KEY_RE = /(SECRET|PRIVATE_KEY|PASSWORD|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|WEBHOOK_SECRET)/i;
const SECRET_VAL_RE = /^(sk_live_|rk_live_|ghp_[A-Za-z0-9]{20,}|xoxb-[0-9]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;

export function checkEnvMatrix(
  projectDir: string,
  parsedConfig: ParsedWorkerConfig | null,
  targetEnv?: string
): Finding[] {
  const findings: Finding[] = [];
  if (!parsedConfig) return findings;

  const relConfig = relative(projectDir, parsedConfig.configPath) || "wrangler.jsonc";
  const topKeys = flattenBindings(parsedConfig.topLevelBindings);
  const devVarsKeys = parseDevVarsKeys(join(projectDir, ".dev.vars"));

  // Scan source files for env.<BINDING> and c.env.<BINDING>
  const srcDir = existsSync(join(projectDir, "src")) ? join(projectDir, "src") : projectDir;
  const tsFiles = collectTsFiles(srcDir);
  const referencedInCode = new Map<string, { file: string; line: number }>();

  for (const file of tsFiles) {
    const content = readFileSync(file, "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const regex = /\b(?:c\.env|env)\.([A-Z][A-Z0-9_]*)\b/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const key = match[1];
        if (!referencedInCode.has(key)) {
          referencedInCode.set(key, { file: relative(projectDir, file), line: i + 1 });
        }
      }
    }
  }

  // WD101: Non-inherited bindings in [env.<name>]
  const bindingCategories: Array<keyof BindingSet> = [
    "d1_databases",
    "kv_namespaces",
    "r2_buckets",
    "services",
    "queues_producers",
    "workflows",
    "durable_objects",
    "vars",
    "ai",
    "hyperdrive",
    "vectorize"
  ];

  const envNames = targetEnv
    ? Object.keys(parsedConfig.envBindings).filter((e) => e === targetEnv)
    : Object.keys(parsedConfig.envBindings);

  for (const envName of envNames) {
    const envSet = parsedConfig.envBindings[envName];
    for (const category of bindingCategories) {
      const topList = parsedConfig.topLevelBindings[category];
      const envList = envSet[category];
      for (const bindingName of topList) {
        if (!envList.includes(bindingName)) {
          const codeRef = referencedInCode.get(bindingName);
          findings.push({
            ruleId: "WD101",
            engine: "env-matrix",
            severity: "error",
            env: envName,
            binding: bindingName,
            file: relConfig,
            message: `Binding "${bindingName}" (${category}) is defined at top-level but missing in env.${envName}. Wrangler does not inherit ${category} across named environments${codeRef ? ` (used at ${codeRef.file}:${codeRef.line})` : ""}.`,
            issueUrl: "https://github.com/cloudflare/workers-sdk/issues/6321",
            suggestion: `Declare "${bindingName}" explicitly inside env.${envName}.${category} in ${relConfig}.`
          });
        }
      }
    }
  }

  // WD102: Code accesses env.<KEY> that does not exist anywhere in config or .dev.vars
  const allKnownKeys = new Set<string>([...topKeys, ...devVarsKeys]);
  for (const envSet of Object.values(parsedConfig.envBindings)) {
    for (const k of flattenBindings(envSet)) allKnownKeys.add(k);
  }

  for (const [key, loc] of referencedInCode.entries()) {
    if (!allKnownKeys.has(key)) {
      findings.push({
        ruleId: "WD102",
        engine: "env-matrix",
        severity: "error",
        binding: key,
        file: loc.file,
        line: loc.line,
        message: `Code accesses env.${key}, but "${key}" is not declared in ${relConfig} or .dev.vars.`,
        issueUrl: "https://github.com/cloudflare/workers-sdk/issues/6321",
        suggestion: `Add binding "${key}" to ${relConfig} or add ${key}=... to .dev.vars.`
      });
    }
  }

  // WD103: worker-configuration.d.ts drift against config
  const dts = parseDtsEnvKeys(projectDir);
  if (dts) {
    for (const topKey of topKeys) {
      if (!dts.keys.has(topKey)) {
        findings.push({
          ruleId: "WD103",
          engine: "env-matrix",
          severity: "warning",
          binding: topKey,
          file: dts.file,
          message: `Binding "${topKey}" is in ${relConfig} but missing from ${dts.file}.`,
          issueUrl: "https://github.com/cloudflare/workers-sdk/issues/6321",
          suggestion: `Run "wrangler types" to regenerate ${dts.file}.`
        });
      }
    }
    for (const dtsKey of dts.keys) {
      if (!allKnownKeys.has(dtsKey)) {
        findings.push({
          ruleId: "WD103",
          engine: "env-matrix",
          severity: "warning",
          binding: dtsKey,
          file: dts.file,
          message: `Type definition ${dts.file} declares "${dtsKey}" on Env, which is missing from ${relConfig} and .dev.vars.`,
          issueUrl: "https://github.com/cloudflare/workers-sdk/issues/6321",
          suggestion: `Remove stale key "${dtsKey}" or run "wrangler types".`
        });
      }
    }
  }

  // WD104: Plaintext secret committed inside wrangler vars
  for (const [rawKey, val] of Object.entries(parsedConfig.varsValues)) {
    const cleanKey = rawKey.includes(".") ? rawKey.split(".").pop()! : rawKey;
    const isSecretKey = SECRET_KEY_RE.test(cleanKey);
    const isSecretVal = SECRET_VAL_RE.test(val);
    if ((isSecretKey && val.length > 0 && !val.startsWith("http")) || isSecretVal) {
      findings.push({
        ruleId: "WD104",
        engine: "env-matrix",
        severity: "error",
        binding: cleanKey,
        file: relConfig,
        message: `Plaintext secret candidate "${rawKey}" found in ${relConfig} vars.`,
        issueUrl: "https://github.com/cloudflare/workers-sdk/discussions/16328",
        suggestion: `Move "${cleanKey}" to .dev.vars for local dev and "wrangler secret put ${cleanKey}" for production.`
      });
    }
  }

  // WD105: .dev.vars vs .dev.vars.example drift
  const exampleVarsPath = join(projectDir, ".dev.vars.example");
  if (existsSync(exampleVarsPath) && devVarsKeys.size > 0) {
    const exampleKeys = parseDevVarsKeys(exampleVarsPath);
    for (const k of devVarsKeys) {
      if (!exampleKeys.has(k)) {
        findings.push({
          ruleId: "WD105",
          engine: "env-matrix",
          severity: "warning",
          binding: k,
          file: ".dev.vars.example",
          message: `Secret "${k}" is present in .dev.vars but undocumented in .dev.vars.example.`,
          issueUrl: "https://github.com/cloudflare/workers-sdk/issues/15068",
          suggestion: `Add "${k}=" to .dev.vars.example.`
        });
      }
    }
  }

  return findings;
}

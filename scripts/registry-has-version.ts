#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
export type Registry = "npm" | "jsr";

export interface ProbeResult {
  exists: boolean;
  error: string | null;
}

export async function probeNpm(name: string, version: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`);
    if (res.status === 404) return { exists: false, error: null };
    if (!res.ok) return { exists: false, error: `npm HTTP ${res.status}` };
    const body = (await res.json()) as { version?: string };
    return { exists: body.version === version, error: null };
  } catch (error) {
    return { exists: false, error: String(error) };
  }
}

export async function probeJsr(name: string, version: string): Promise<ProbeResult> {
  const path = name.startsWith("@") ? name : `@${name}`;
  try {
    const res = await fetch(`https://jsr.io/${path}/meta.json`);
    if (res.status === 404) return { exists: false, error: null };
    if (!res.ok) return { exists: false, error: `JSR HTTP ${res.status}` };
    const body = (await res.json()) as { versions?: Record<string, unknown> };
    return { exists: Boolean(body.versions?.[version]), error: null };
  } catch (error) {
    return { exists: false, error: String(error) };
  }
}

async function main(argv: string[]): Promise<number> {
  const registry = argv[0] as Registry | undefined;
  const name = argv[1];
  const version = argv[2];
  if ((registry !== "npm" && registry !== "jsr") || !name || !version) {
    console.error("usage: registry-has-version.ts <npm|jsr> <name> <version>");
    return 2;
  }
  const result = registry === "npm" ? await probeNpm(name, version) : await probeJsr(name, version);
  if (result.error !== null) {
    console.error(result.error);
    return 2;
  }
  if (result.exists) {
    console.log(`${registry} has ${name}@${version}`);
    return 0;
  }
  console.log(`${registry} missing ${name}@${version}`);
  return 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

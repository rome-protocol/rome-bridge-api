import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OPENAPI_DOC } from "../../src/routes/openapi";

/**
 * Code → doc conformance (the spec, made enforceable): every route
 * literal registered in src/routes/*.ts must appear in the served OpenAPI
 * document. Greppable-literal pattern, same as the step-kind dispatcher gate.
 */
const ROUTES_DIR = join(__dirname, "..", "..", "src", "routes");

function registeredRoutes(): Array<{ file: string; method: string; path: string }> {
  const out: Array<{ file: string; method: string; path: string }> = [];
  // The OpenAPI doc covers the versioned /v1 API only.
  const NON_API_FILES = new Set<string>([]);
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts") && !NON_API_FILES.has(f))) {
    const text = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const m of text.matchAll(/app\.(get|post|put|delete|patch)(?:<[^>]*>)?\(\s*"([^"]+)"/gs)) {
      out.push({ file, method: m[1]!, path: m[2]! });
    }
  }
  return out;
}

describe("OpenAPI conformance — code → doc", () => {
  it("every registered route literal is documented", () => {
    const documented = new Set<string>();
    for (const [path, ops] of Object.entries(OPENAPI_DOC.paths)) {
      for (const method of Object.keys(ops as object)) documented.add(`${method} ${path}`);
    }
    const missing = registeredRoutes()
      .map((r) => ({ ...r, key: `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}` }))
      .filter((r) => !documented.has(r.key));
    expect(missing, `undocumented routes: ${missing.map((m) => `${m.key} (${m.file})`).join(", ")}`).toEqual([]);
  });

  it("finds a sane number of routes (the grep itself works)", () => {
    expect(registeredRoutes().length).toBeGreaterThanOrEqual(10);
  });

  it("states the trust model where integrators can see it (custody, sponsor, verification, settle)", () => {
    const desc = OPENAPI_DOC.info.description as string;
    expect(desc).toMatch(/Trust model/i);
    expect(desc).toMatch(/no .*keys|holds no/i);       // service custody
    expect(desc).toMatch(/credit.*never.*debit/i);      // sponsor bound
    expect(desc).toMatch(/derived from .*identity/i);   // destinations
    expect(desc).toMatch(/sign/i);                      // user-signed settle
    expect(desc).toMatch(/API namespace|API version/i); // v1-URL vs CCTP-version note
  });
});
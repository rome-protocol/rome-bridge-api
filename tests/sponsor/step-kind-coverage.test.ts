import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SPONSOR_KINDS = new Set<string>([
  "cctp-receive-message",
  "wormhole-complete-transfer-wrapped",
  "settle-inbound-bridge-sponsored",
  "ensure-ata",
]);

const CALLER_KINDS = new Set<string>([
  "cctp-approve-and-deposit",
  "cctp-burn-usdc",
  "cctp-claim-on-destination",
  "wormhole-wrap-and-transfer-eth",
  "wormhole-approve-burn-eth",
  "wormhole-burn-eth",
  "wormhole-claim-on-ethereum",
  "solana-spl-transfer",
  "solana-wsol-transfer",
  "spl-erc20-bridge-out",
  "native-withdraw",
  "claim-as-gas",
  // Generic Wormhole egress (token-wormhole-outbound): user signs approve+burn on
  // Rome, then redeems the VAA on the destination — all caller-driven, no sponsor.
  "wormhole-approve-burn",
  "wormhole-burn-token",
  "wormhole-claim-on-destination",
]);

const NON_STEP_KIND_LITERALS = new Set<string>([
  "solana-instructions",
  "gas",
  "wrapper",
]);

const BUILDERS_DIR = join(__dirname, "..", "..", "src", "route-builders");

function extractStepKinds(): { file: string; kind: string; line: number }[] {
  const out: { file: string; kind: string; line: number }[] = [];
  const files = readdirSync(BUILDERS_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts" && f !== "route-keys.ts");
  for (const file of files) {
    const text = readFileSync(join(BUILDERS_DIR, file), "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /\bkind:\s*"([^"]+)"/.exec(lines[i]!);
      if (!m) continue;
      const kind = m[1]!;
      if (NON_STEP_KIND_LITERALS.has(kind)) continue;
      out.push({ file, kind, line: i + 1 });
    }
  }
  return out;
}

describe("step.kind dispatcher coverage", () => {
  it("every step.kind emitted by a route-builder is sponsor-owned OR explicitly caller-owned", () => {
    const stamped = extractStepKinds();
    expect(stamped.length).toBeGreaterThan(0);

    const ownedKinds = new Set([...SPONSOR_KINDS, ...CALLER_KINDS]);
    const orphans = stamped.filter((s) => !ownedKinds.has(s.kind));
    if (orphans.length > 0) {
      const detail = orphans
        .map((o) => `  - ${o.file}:${o.line} stamps kind="${o.kind}"`)
        .join("\n");
      throw new Error(
        `Unowned step.kind values stamped by route-builders:\n${detail}\n\n` +
        `Add the kind to either SPONSOR_KINDS + the dispatcher at src/sponsor/bridge-sponsor.ts, ` +
        `OR to CALLER_KINDS if the user drives that step on-chain.`,
      );
    }
  });

  it("every SPONSOR_KIND is actually dispatched by BridgeSponsor.tickOnce", () => {
    const dispatcherPath = join(__dirname, "..", "..", "src", "sponsor", "bridge-sponsor.ts");
    const dispatcherText = readFileSync(dispatcherPath, "utf8");
    for (const kind of SPONSOR_KINDS) {
      expect(dispatcherText).toContain(`"${kind}"`);
    }
  });
});

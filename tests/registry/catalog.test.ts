import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BridgeLike,
  SourceEvmEntry,
  assetFor,
  cctpDomainFor,
  cctpVersionFor,
  entryFor,
  isPureV2Entry,
  mergedCatalog,
  resolveCctpAddresses,
} from "../../src/registry/catalog";

const hadrian: BridgeLike = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "registry", "chains", "200010-hadrian", "bridge.json"), "utf8"),
);

const sepolia = () => entryFor(hadrian)!;
const monad = () => entryFor(hadrian, 10143)!;

describe("mergedCatalog — hybrid published shape", () => {
  it("prepends the legacy sourceEvm as the default source, then the sourceEvms[] catalog", () => {
    const catalog = mergedCatalog(hadrian);
    expect(catalog.length).toBeGreaterThanOrEqual(6);
    expect(catalog[0]!.chainId).toBe(11155111);
    expect(catalog.map((e) => e.chainId)).toEqual(expect.arrayContaining([10143, 80002, 421614, 84532, 43113]));
  });

  it("dedups by chainId, first wins", () => {
    const dupe: BridgeLike = {
      sourceEvm: { chainId: 10143, name: "legacy-wins" },
      sourceEvms: [{ chainId: 10143, name: "catalog-dupe" }, { chainId: 1, name: "kept" }],
    };
    const catalog = mergedCatalog(dupe);
    expect(catalog).toHaveLength(2);
    expect(catalog[0]!.name).toBe("legacy-wins");
  });

  it("tolerates catalog-only and legacy-only shapes", () => {
    expect(mergedCatalog({ sourceEvms: [{ chainId: 7 }] })[0]!.chainId).toBe(7);
    expect(mergedCatalog({ sourceEvm: { chainId: 8 } })[0]!.chainId).toBe(8);
    expect(mergedCatalog(undefined)).toEqual([]);
  });
});

describe("entryFor", () => {
  it("omitted chainId resolves the default source", () => {
    expect(sepolia().chainId).toBe(11155111);
  });
  it("unknown chainId resolves undefined (fail closed at the caller)", () => {
    expect(entryFor(hadrian, 424242)).toBeUndefined();
  });
});

describe("assetFor — per-asset sourceEvm.chainId join", () => {
  it("default-source asset rows omit chainId", () => {
    const usdc = assetFor(hadrian, { symbol: "USDC" })!;
    expect(usdc.id).toBe("usdc");
    expect(usdc.sourceEvm?.chainId).toBeUndefined();
  });
  it("catalog assets bind via chainId", () => {
    expect(assetFor(hadrian, { symbol: "USDC", sourceChainId: 10143 })!.id).toBe("usdc-monad");
    expect(assetFor(hadrian, { symbol: "USDC", sourceChainId: 84532 })!.id).toBe("usdc-base");
  });
  it("misses fail closed", () => {
    expect(assetFor(hadrian, { symbol: "USDC", sourceChainId: 424242 })).toBeUndefined();
    expect(assetFor(hadrian, { symbol: "DOGE" })).toBeUndefined();
  });
});

describe("version + address resolution — version-keyed, never name-keyed", () => {
  it("Sepolia (V1 history): NOT pure-V2; v1 resolves the real V1 contracts (drain path)", () => {
    expect(isPureV2Entry(sepolia())).toBe(false);
    const v1 = resolveCctpAddresses(sepolia(), 1);
    expect(v1.tokenMessenger).toBe("0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5");
    expect(v1.messageTransmitter).toBe("0x7865fAfC2db2093669d92c0F33AeEF291086BEFD");
  });

  it("Sepolia v2: V2 messenger present; V2 transmitter is absent at registry 0.22.x (the gap a registry fix closes)", () => {
    const v2 = resolveCctpAddresses(sepolia(), 2);
    expect(v2.tokenMessenger).toBe("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
    expect(v2.messageTransmitter ?? sepolia().cctpMessageTransmitterV2).toBe(sepolia().cctpMessageTransmitterV2);
  });

  it("Monad (pure V2, legacy names carry V2 values): v2 resolves; v1 refuses — Monad never had V1", () => {
    expect(isPureV2Entry(monad())).toBe(true);
    const v2 = resolveCctpAddresses(monad(), 2);
    expect(v2.tokenMessenger).toBe("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
    expect(v2.messageTransmitter).toBe("0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275");
    expect(resolveCctpAddresses(monad(), 1)).toEqual({});
  });

  it("cctpVersionFor: asset override > entry default > 1; out-of-range refused", () => {
    expect(cctpVersionFor(sepolia(), assetFor(hadrian, { symbol: "USDC" }))).toBe(2);
    expect(cctpVersionFor(monad(), assetFor(hadrian, { symbol: "USDC", sourceChainId: 10143 }))).toBe(2);
    const legacy: SourceEvmEntry = { chainId: 5, cctpTokenMessenger: "0x1" };
    expect(cctpVersionFor(legacy)).toBe(1);
    expect(() => cctpVersionFor({ chainId: 5, cctpVersion: 3 })).toThrow(/unsupported cctpVersion 3/);
  });
});

describe("cctpDomainFor — absent-domain default is only safe on the default source", () => {
  it("published entries carry explicit domains", () => {
    expect(cctpDomainFor(hadrian, sepolia())).toBe(0);
    expect(cctpDomainFor(hadrian, monad())).toBe(15);
  });
  it("default source without a domain gets the registry-documented 0; catalog entries refuse", () => {
    const b: BridgeLike = { sourceEvm: { chainId: 11155111 }, sourceEvms: [{ chainId: 10143 }] };
    expect(cctpDomainFor(b, entryFor(b)!)).toBe(0);
    expect(cctpDomainFor(b, entryFor(b, 10143)!)).toBeUndefined();
  });
});

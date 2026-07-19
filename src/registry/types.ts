import { z } from "zod";

/**
 * programs/index.json layout. Authoritative for "which rome-evm programs exist + their roles."
 * Per-program chain registrations (and gas mints) come from on-chain OwnerInfo (src/chains/owner-info-reader.ts);
 * this index is the discovery seed.
 */
export const ProgramRole = z.enum(["primary", "secondary", "retired", "closed"]);
export type ProgramRoleT = z.infer<typeof ProgramRole>;

export const ProgramKind = z.enum(["rome-evm", "meta-hook"]);

export const ProgramEntry = z.object({
  cluster: z.string(),
  network: z.string(),
  role: ProgramRole,
  kind: ProgramKind,
  chainsHosted: z.array(z.string()),
});
export type ProgramEntryT = z.infer<typeof ProgramEntry>;

export const ProgramsIndex = z.object({
  schemaVersion: z.string(),
  primary: z.record(z.string(), z.string().nullable()),
  programs: z.record(z.string(), ProgramEntry),
});
export type ProgramsIndexT = z.infer<typeof ProgramsIndex>;

export interface ProgramListEntry extends ProgramEntryT {
  id: string;
}

/**
 * Loose schemas for the per-chain JSON files. The real registry's chain.json and bridge.json carry
 * many more fields than v1.0's strict ChainSchema captured; these loose variants tolerate the actual
 * shape (e.g. `chainId: 200010` as a number, presence of nativeCurrency, etc.) while extracting
 * the fields the discovery endpoint needs.
 */
export const ChainJsonLoose = z.object({
  chainId: z.union([z.string(), z.number()]).optional(),
  name: z.string().optional(),
  network: z.string().optional(),
  rpcUrl: z.string().optional(),
  romeEvmProgramId: z.string().optional(),
  nativeCurrency: z.object({
    name: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.number().optional(),
  }).optional(),
}).passthrough();
export type ChainJsonLooseT = z.infer<typeof ChainJsonLoose>;

export const BridgeAssetLoose = z.object({
  id: z.string().optional(),
  symbol: z.string(),
  solanaMint: z.string(),
  decimals: z.number().optional(),
  sourceEvm: z.unknown().optional(),
}).passthrough();
export type BridgeAssetLooseT = z.infer<typeof BridgeAssetLoose>;

export const BridgeJsonLoose = z.object({
  sourceEvm: z.unknown().optional(),
  cctpIrisApiBase: z.string().optional(),
  wormholescanBaseUrl: z.string().optional(),
  assets: z.array(BridgeAssetLoose).optional(),
}).passthrough();
export type BridgeJsonLooseT = z.infer<typeof BridgeJsonLoose>;

/**
 * The registry AS PUBLISHED (registry schema/*.schema.json, verified against
 * origin main). chain.json has a NUMERIC chainId and no slug field; the bridge
 * block lives in a separate bridge.json; the gas token in tokens.json
 * (kind=gas). Schemas are .passthrough() so additive registry minors never
 * break parsing; required-field validation stays strict.
 */
export const PublishedChainJson = z
  .object({
    chainId: z.union([z.number(), z.string()]).transform(String),
    name: z.string().optional(),
    network: z.string().optional(),
    status: z.string(),
    rpcUrl: z.string().optional(),
    explorerUrl: z.string().optional(),
    romeEvmProgramId: z.string().optional(),
    nativeCurrency: z
      .object({ name: z.string().optional(), symbol: z.string().optional(), decimals: z.number().optional() })
      .passthrough()
      .optional(),
    solana: z
      .object({ cluster: z.string().optional(), rpc: z.string().optional(), explorerUrl: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type PublishedChainJsonT = z.infer<typeof PublishedChainJson>;

export const SourceEvmEntrySchema = z
  .object({
    chainId: z.number(),
    name: z.string().optional(),
    rpcUrl: z.string().optional(),
    explorerUrl: z.string().optional(),
    cctpVersion: z.number().optional(),
    cctpDomain: z.number().optional(),
    cctpTokenMessenger: z.string().optional(),
    cctpTokenMessengerV2: z.string().optional(),
    cctpMessageTransmitter: z.string().optional(),
    cctpMessageTransmitterV2: z.string().optional(),
    wormholeChainId: z.number().optional(),
    wormholeTokenBridge: z.string().optional(),
    wormholeCoreBridge: z.string().optional(),
  })
  .passthrough();
export type SourceEvmEntryT = z.infer<typeof SourceEvmEntrySchema>;

export const BridgeAssetSchema = z
  .object({
    id: z.string().optional(),
    symbol: z.string(),
    name: z.string().optional(),
    decimals: z.number().optional(),
    solanaMint: z.string(),
    sourceEvm: z
      .object({
        chainId: z.number().optional(),
        address: z.string().optional(),
        protocol: z.string().optional(),
        cctpVersion: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const BridgeConfigSchema = z
  .object({
    sourceEvm: SourceEvmEntrySchema.optional(),
    sourceEvms: z.array(SourceEvmEntrySchema).optional(),
    assets: z.array(BridgeAssetSchema).optional(),
    solana: z
      .object({
        cctpDomain: z.number().optional(),
        cctpMessageTransmitterProgram: z.string().optional(),
        cctpTokenMessengerMinterProgram: z.string().optional(),
        cctpMessageTransmitterProgramV2: z.string().optional(),
        cctpTokenMessengerMinterProgramV2: z.string().optional(),
      })
      .passthrough()
      .optional(),
    cctpIrisApiBase: z.string().optional(),
    wormholescanBaseUrl: z.string().optional(),
  })
  .passthrough();
export type BridgeConfigT = z.infer<typeof BridgeConfigSchema>;

export const TokenEntrySchema = z
  .object({
    address: z.string().optional(),
    mintId: z.string().optional(),
    gasPool: z.string().optional(),
    symbol: z.string().optional(),
    name: z.string().optional(),
    decimals: z.number().optional(),
    kind: z.string(),
    assetRef: z.string().optional(),
  })
  .passthrough();
export type TokenEntryT = z.infer<typeof TokenEntrySchema>;

export const ContractVersionSchema = z
  .object({ address: z.string().optional(), version: z.string().optional(), status: z.string().optional() })
  .passthrough();
export const ContractEntrySchema = z
  .object({ name: z.string().optional(), versions: z.array(ContractVersionSchema).optional() })
  .passthrough();
export type ContractEntryT = z.infer<typeof ContractEntrySchema>;

/** chain.json + bridge.json + tokens.json + contracts.json merged per chain; slug = registry directory name. */
export interface ChainConfig extends PublishedChainJsonT {
  slug: string;
  bridge?: BridgeConfigT | undefined;
  tokens?: TokenEntryT[] | undefined;
  /** tokens.json entry with kind=gas; its mintId is the chain's gas mint. */
  gasToken?: TokenEntryT | undefined;
  /** contracts.json — deployed contract version history; resolve via liveContractAddress(). */
  contracts?: ContractEntryT[] | undefined;
}

import { z } from "zod";
import { ROUTE_KEYS } from "../route-builders/route-keys.js";

export const StepStatus = z.enum(["blocked", "ready", "submitted", "confirmed", "failed", "expired"]);
export type StepStatusT = z.infer<typeof StepStatus>;

export const TransferStep = z.object({
  n: z.number(),
  chain: z.string(),
  kind: z.string(),
  status: StepStatus,
  txHashes: z.array(z.string()).optional(),
  unsignedTx: z.unknown().optional(),
  /** Multi-tx steps (approve + depositForBurn) — served back to Tier-1 callers. */
  unsignedTxs: z.array(z.unknown()).optional(),
  userSigns: z.boolean().optional(),
  sponsorPaysFees: z.boolean().optional(),
  attestation: z.string().optional(),
  /** V2: the 0x-hex wire message delivered alongside the attestation (receive consumes both). */
  message: z.string().optional(),
  vaa: z.string().optional(),
  /** Sponsor receive/ensure-ata metadata, stamped by the route-builder. */
  programs: z.record(z.string(), z.string()).optional(),
  recipientAta: z.string().optional(),
  recipientPdaOwner: z.string().optional(),
  /** Sponsor attribution (user-signed vs Rome/partner-sponsored). */
  sponsor: z.enum(["user", "rome", "partner"]).optional(),
  /** True when a terminal sponsor decision skipped this step (record.degradation says why). */
  skipped: z.boolean().optional(),
  /** Outbound: Solana signature(s) of the Rome burn (cached after first resolve). */
  solanaSigs: z.array(z.string()).optional(),
  /** Settle metadata (quote-time; sourceTxHash stamped at registration). */
  chainId: z.string().optional(),
  user: z.string().optional(),
  bridgedAmount: z.string().optional(),
  sourceChain: z.string().optional(),
  sourceTxHash: z.string().optional(),
  rollupProgramId: z.string().optional(),
  mintAddress: z.string().optional(),
  expiresAt: z.string().optional(),
  blockedBy: z.union([z.string(), z.array(z.string())]).optional(),
  url: z.string().optional(),
  confirmedAt: z.string().optional(),
}).passthrough();
export type TransferStepT = z.infer<typeof TransferStep>;

/**
 * Per-record transport stamp — the resolved tuple frozen at registration
 *. Downstream branches on this, never live config.
 */
export const RecordStamp = z.object({
  sourceChainId: z.number(),
  cctpVersion: z.union([z.literal(1), z.literal(2)]),
  cctpDomain: z.number(),
  irisBase: z.string(),
  cctpTokenMessenger: z.string().optional(),
  cctpMessageTransmitter: z.string().optional(),
  burnToken: z.string().optional(),
  /** Registry-derived burn selectors (outbound: RomeBridgeWithdraw v6; inbound defaults per version). */
  expectedSelectors: z.array(z.string()).optional(),
  /** Outbound: the Rome chain's RPC — the burn tx lives there; sigs resolve via rome_solanaTxForEvmTx. */
  romeRpcUrl: z.string().optional(),
});
export type RecordStampT = z.infer<typeof RecordStamp>;

export const TransferRecord = z.object({
  id: z.string(),
  route: z.enum(ROUTE_KEYS),
  direction: z.enum(["to-rome", "from-rome"]),
  amountIn: z.string(),
  amountOut: z.string(),
  fee: z.object({ bps: z.number(), absolute: z.string(), asset: z.string() }).optional(),
  sender: z.object({ ethereum: z.string().optional(), solana: z.string().optional(), rome: z.string().optional() }),
  recipient: z.string(),
  outcome: z.enum(["pending", "complete", "failed", "expired"]),
  steps: z.array(TransferStep),
  stamp: RecordStamp.optional(),
  /** Terminal degradation qualifier — outcome stays "complete" (additive-within-/v1). */
  degradation: z.string().nullable().optional(),
  degradationReason: z.string().nullable().optional(),
  /** Reserved for the trustless-settle path (trustless settle) — never populated in this arc. */
  userSettleSig: z.string().nullable().optional(),
  settleDeadline: z.number().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type TransferRecordT = z.infer<typeof TransferRecord>;

export type CreateInput = Omit<TransferRecordT, "id" | "createdAt" | "updatedAt" | "completedAt" | "error">;

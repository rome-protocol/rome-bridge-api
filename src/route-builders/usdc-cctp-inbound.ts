import { encodeFunctionData, parseAbi } from "viem";
import { PublicKey } from "@solana/web3.js";
import { ChainConfig } from "../registry/types.js";
import { ROUTE_SPECS, RouteKey, assertAmountInRange } from "./route-keys.js";
import { assetFor, cctpVersionFor, entryFor, resolveCctpAddresses } from "../registry/catalog.js";
import type { FastQuote } from "../cctp/fees.js";
import { deriveExternalAuthorityPda } from "../lib/pda.js";
import { deriveUserPdaAta } from "../lib/ata.js";
import { bridgeError } from "../errors.js";

const ERC20_APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);
const TOKEN_MESSENGER_V1_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64)",
]);
const TOKEN_MESSENGER_V2_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);
const ZERO_BYTES32 = ("0x" + "0".repeat(64)) as `0x${string}`;
/** CCTP V2 finality thresholds (Circle: ≤1000 ⇒ fast/confirmed, 2000 ⇒ standard/finalized). */
const MIN_FINALITY_STANDARD = 2000;
const MIN_FINALITY_FAST = 1000;

export interface QuoteInput {
  amount: string;
  sender: { ethereum?: string | undefined; solana?: string | undefined; rome?: string | undefined };
  recipient: string;
  chain: ChainConfig;
  programId: string;
  /** Catalog source selection; omitted = the chain's default source (entry 0). */
  sourceChainId?: number | undefined;
  /** Outbound destination selection (from-rome routes); omitted = the default entry. */
  destinationChainId?: number | undefined;
  /** V2-only speed mode. Fast is honored only when `fast.available` (the route resolves the Circle fees probe). */
  speed?: "standard" | "fast" | undefined;
  /** Circle fees probe result for (source → solana), resolved by the route when speed=fast. */
  fast?: FastQuote | undefined;
  /**
   * Binary intent (v1.0.1):
   *   - "gas"     → emit step 3 (sponsor-paid settle_inbound_bridge); outputs[0].kind = "gas"
   *   - "wrapper" → omit step 3; outputs[0].kind = "wrapper"
   * Defaults to "gas" for backward-compat with v1.0 callers.
   * Per the API spec
   */
  intent?: "gas" | "wrapper" | undefined;
  /**
   * The chain's GAS MINT (base58) as resolved from the rome-evm program's
   * on-chain OwnerInfo PDA by the quote handler — the authoritative source for
   * gas-vs-wrapper decisions (the registry `chain.gasToken.mintId` is a mirror
   * that can drift). Builders MUST prefer this over the registry field; it is
   * `undefined` only when SOLANA_RPC_URL is unset or the on-chain read failed,
   * in which case builders fall back to the registry mirror.
   */
  onchainGasMint?: string | undefined;
  /**
   * Asset-agnostic SPL rail selector (routes `spl-solana-*`). Carries the
   * concrete Solana mint + decimals of ANY SPL (LSTs like mSOL/bSOL, or any
   * factory-minted token) so one builder pair bridges every mint. The mint is
   * bound into transferChecked (in) and RomeBridgeWithdraw's 3-arg egress (out);
   * decimals binds transferChecked to prevent mint-substitution. Absent for the
   * fixed USDC/ETH/SOL rails.
   */
  splAsset?: { mint: string; decimals: number; symbol?: string | undefined;
    /** ERC20-SPL wrapper address on Rome. Required for the Wormhole egress rail
     *  (burnToWormhole takes a wrapper address, not a raw mint). */
    wrapper?: string | undefined } | undefined;
}

export interface UnsignedEvmTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  estimatedGas: string;
  description: string;
  /** simulate: true preflight result (route-level enrichment). */
  simulation?: { ok: boolean; revertReason?: string };
}

export interface QuoteStep {
  n: number;
  chain: string;
  kind: string;
  unsignedTxs?: UnsignedEvmTx[];
  unsignedTx?: string | null;
  blockedBy?: string[];
  /** v1.0.1: true = user's wallet signs this step; false = sponsor signs. */
  userSigns?: boolean;
  /** v1.0.1: true = sponsor pays the on-chain fee for this step (Solana, Rome gas, etc.). */
  sponsorPaysFees?: boolean;
  /**
   * Sponsor-step metadata — stamped by route-builders on steps the sponsor
   * processes (CCTP receive, Wormhole complete, settle). Opaque to the
   * caller; passed through to the sponsor worker's handler hooks.
   */
  programs?: Record<string, string>;
  recipientAta?: string;
  recipientPdaOwner?: string;
  /** CAIP-2 identity emitted alongside the legacy chain label (route-level enrichment). */
  chainRef?: string;
  chainName?: string;
  /** First-class sponsor attribution (route-level enrichment from userSigns). */
  sponsor?: "user" | "rome" | "partner";
  /** cctp-claim-on-destination metadata (outbound): the destination's V2 transmitter + domain. */
  claimTransmitter?: string;
  claimDomain?: number;
  /** wormhole-claim metadata (outbound): destination token bridge + redeem method; romeRpcUrl stamped at registration. */
  claimTokenBridge?: string;
  claimMethod?: "completeTransfer" | "completeTransferAndUnwrapETH";
  romeRpcUrl?: string;
  vaa?: string;
  /** settle-inbound-bridge-sponsored metadata (stamped at quote; sourceTxHash at registration). */
  chainId?: string;
  user?: string;
  bridgedAmount?: string;
  sourceChain?: string;
  sourceTxHash?: string;
  rollupProgramId?: string;
  mintAddress?: string;
}

/**
 * v1.0.1: machine-readable "what the user gets when this completes."
 * Exactly one entry per quote in v1.0.1 (no splits). Integrator UI MUST surface this to the user before they sign step 1.
 */
export interface QuoteOutput {
  kind: "gas" | "wrapper";
  amount: string;
  /**
   * The Rome chain id the credit lands on — BOTH modes. Registration's
   * resolveStamp anchors on it; on wrapper quotes (no rome-<id> settle step)
   * it is the only anchor, so omitting it strands the record unstamped.
   */
  chainId?: string;
  /** Wrapper-mode only: the Solana mint of the asset held in the user's PDA-ATA. */
  solanaMint?: string;
  /** Wrapper-mode only: the user's PDA-ATA address (base58) where the SPL lands. */
  destinationAta?: string;
}

export interface QuoteFeeLine {
  type: string;
  bps: number;
  amount: string;
  asset: string;
  paidTo: string;
}

export interface Quote {
  route: RouteKey;
  direction: "to-rome" | "from-rome";
  amountIn: string;
  amountOut: string;
  fee: { bps: number; absolute: string; asset: string };
  /** Zero-protocol-fee guarantee, machine-readable (network/vendor costs are line items in fees[]). */
  protocolFee?: string;
  /** Fee breakdown lines (fast-transfer cost is a visible line item). Absent = no fees. */
  fees?: QuoteFeeLine[];
  /** Observed p90 completion seconds — null until measured data exists (honest, not a marketing constant). */
  etaP90Seconds?: number | null;
  /** CCTP transport facts the record stamp freezes at registration. */
  cctpVersion?: 1 | 2;
  sourceChainId?: number;
  /** The speed actually quoted (fast requests fail closed to standard). */
  speed?: "standard" | "fast";
  /** CAIP-2 form of sourceChainId (route-level enrichment). */
  sourceChainRef?: string;
  /** Outbound: the resolved destination chain. */
  destinationChainId?: number;
  /**
   * Outbound: the Rome-side ERC-20 that is actually burned/bridged (e.g. the
   * 6-dec wUSDC spl_wrapper), distinct from the 18-dec native gas token. The
   * page reads balanceOf(burnToken) so the shown "from Rome" balance is the
   * bridgeable one, not gas — over-entering gas would revert the burn.
   */
  burnToken?: string | undefined;
  /**
   * On-chain decimals of `burnToken` (the wrapper ERC-20). MAY DIFFER from the
   * route's advertised decimals: wETH is 8-dec on-chain but the ETH route's
   * amountIn is 18-dec wei. A client formats balanceOf(burnToken) with THIS,
   * never the route decimals.
   */
  burnTokenDecimals?: number | undefined;
  /**
   * The base-unit amount (in burnTokenDecimals) actually pulled by the burn —
   * the value a client compares against balanceOf(burnToken) to gate the transfer.
   * Equals amountIn when the route decimals match the wrapper's (USDC/SOL/SPL);
   * scaled down for ETH (18-dec wei → 8-dec wETH).
   */
  burnAmount?: string | undefined;
  /**
   * Typed-data artifacts a wallet signs alongside/instead of transactions —
   * the intent-compatibility seam. First member
   * will be the EIP-712 SettleAuthorization; ERC-7683 order objects
   * join the same array when an intent surface ships. Always [] in this arc.
   */
  signatureRequests?: Array<{ kind: string; typedData: Record<string, unknown> }>;
  /**
   * Request echo (route-level, stamped by /v1/quote — builders never set these).
   * POST /v1/transfers copies them onto the record, and the store's
   * address-lookup index is built from them; a quote without the echo registers
   * records invisible to GET /v1/transfers?address=.
   */
  sender?: { ethereum?: string | undefined; solana?: string | undefined; rome?: string | undefined };
  recipient?: string;
  etaSeconds: number;
  steps: QuoteStep[];
  /**
   * v1.0.1: outputs[] is OPTIONAL on the Quote type during the rollout — only the USDC CCTP inbound
   * builder emits it today. Once all 8 route builders are updated to the v1.0.1 contract, promote to
   * required and remove this caveat.
   */
  outputs?: QuoteOutput[];
}

export function buildUsdcCctpInboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["usdc-cctp-to-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.ethereum) {
    throw bridgeError("rome.bridge.sender-incomplete", "USDC CCTP inbound requires sender.ethereum");
  }
  const entry = input.sourceChainId === undefined ? entryFor(input.chain.bridge) : entryFor(input.chain.bridge, input.sourceChainId);
  if (!entry) {
    throw bridgeError("rome.bridge.asset-not-supported",
      input.sourceChainId === undefined
        ? "no source chain configured in the registry bridge catalog"
        : `source chain ${input.sourceChainId} is not in the registry bridge catalog`);
  }

  const usdcRow = assetFor(input.chain.bridge, { symbol: "USDC", ...(input.sourceChainId !== undefined ? { sourceChainId: input.sourceChainId } : {}) });
  const usdcAddr = usdcRow?.sourceEvm?.address as `0x${string}` | undefined;
  if (!usdcAddr) throw bridgeError("rome.bridge.asset-not-supported", `no USDC asset row for source ${entry.chainId}`);

  let cctpVersion: 1 | 2;
  try { cctpVersion = cctpVersionFor(entry, usdcRow); }
  catch (e) { throw bridgeError("rome.bridge.asset-not-supported", (e as Error).message); }
  if (cctpVersion === 1 && process.env.BRIDGE_REFUSE_V1_QUOTES === "1") {
    throw bridgeError("rome.bridge.v1-phased-out", `source ${entry.chainId} is CCTP V1 — V1 quote emission is disabled (Circle phase-out)`);
  }

  const tokenMessenger = resolveCctpAddresses(entry, cctpVersion).tokenMessenger as `0x${string}` | undefined;
  if (!tokenMessenger) throw bridgeError("rome.bridge.asset-not-supported", `source ${entry.chainId} has no V${cctpVersion} tokenMessenger configured`);

  const destinationDomain = input.chain.bridge?.solana?.cctpDomain;
  if (destinationDomain === undefined) throw bridgeError("rome.bridge.asset-not-supported", "solana.cctpDomain not configured");

  const gasMintId = input.chain.gasToken?.mintId;
  if (!gasMintId) throw bridgeError("rome.bridge.asset-not-supported", "chain has no gas token (tokens.json kind=gas)");

  // Fast is V2-only and fails CLOSED to standard: probe unavailable, route
  // absent, endpoint down — the user always gets a valid standard quote.
  const wantFast = input.speed === "fast" && cctpVersion === 2 && input.fast?.available === true;
  const fastBps = wantFast && input.fast?.available ? input.fast.bps : 0;
  // Circle's fast `minimumFee` is fractional on some routes (Arbitrum/Base
  // Sepolia return ~1.3 bps) — BigInt(1.3) throws. Scale the bps to integer
  // hundredths so bigint math is exact, then ceil-divide by the scaled
  // denominator (10_000 * 100). ceil keeps the "never underquote Circle"
  // invariant. Integer bps are unaffected (bps*100 is exact).
  const SCALE = 100n;
  const fastBpsScaled = BigInt(Math.round(fastBps * 100)); // hundredths of a bps
  const feeDenom = 10_000n * SCALE;
  const maxFee = wantFast ? (amount * fastBpsScaled + (feeDenom - 1n)) / feeDenom : 0n;
  const minFinalityThreshold = wantFast ? MIN_FINALITY_FAST : MIN_FINALITY_STANDARD;

  const programId = new PublicKey(input.programId);
  const [userPda] = deriveExternalAuthorityPda(input.recipient, programId);
  const gasMint = new PublicKey(gasMintId);
  const recipientAta = deriveUserPdaAta(userPda, gasMint);
  const mintRecipientBytes32 = "0x" + recipientAta.toBuffer().toString("hex") as `0x${string}`;

  // Invariant (approve target == burn target, both from the same catalog
  // entry): the approve spender below IS the depositForBurn `to`.
  const approveData = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [tokenMessenger, amount] });
  const depositData = cctpVersion === 2
    ? encodeFunctionData({
        abi: TOKEN_MESSENGER_V2_ABI, functionName: "depositForBurn",
        // destinationCaller = 0: receive stays permissionless (sponsor is a payer, never an authority).
        args: [amount, destinationDomain, mintRecipientBytes32, usdcAddr, ZERO_BYTES32, maxFee, minFinalityThreshold],
      })
    : encodeFunctionData({
        abi: TOKEN_MESSENGER_V1_ABI, functionName: "depositForBurn",
        args: [amount, destinationDomain, mintRecipientBytes32, usdcAddr],
      });

  const intent = input.intent ?? "gas";
  const gasMode = intent === "gas";

  // V2 receive is its own tx (message+attestation overflow 1232B with an
  // inline ATA create), so the idempotent ATA ensure precedes it as an
  // explicit sponsor step; V1 keeps the inline create inside receive.
  const hasEnsureAta = cctpVersion === 2;
  const receiveN = hasEnsureAta ? 3 : 2;

  const steps: QuoteStep[] = [
    {
      // Default source keeps the legacy "ethereum" label (step-1 index compat);
      // catalog sources use evm-<chainId> (the Rome app convention).
      n: 1, chain: entry.chainId === entryFor(input.chain.bridge)?.chainId ? "ethereum" : `evm-${entry.chainId}`, kind: "cctp-approve-and-deposit",
      userSigns: true, sponsorPaysFees: false,
      unsignedTxs: [
        { to: usdcAddr,       data: approveData, value: "0", estimatedGas: "60000",  description: "Approve TokenMessenger to spend USDC" },
        { to: tokenMessenger, data: depositData, value: "0", estimatedGas: "180000", description: "Burn USDC via CCTP, mintRecipient = user's Rome PDA-ATA" },
      ],
    },
    ...(hasEnsureAta ? [{
      n: 2, chain: "solana", kind: "ensure-ata",
      userSigns: false, sponsorPaysFees: true,
      unsignedTx: null, blockedBy: ["step-1"],
      programs: {
        splTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        usdcMint: gasMintId,
      },
      recipientAta: recipientAta.toBase58(),
      recipientPdaOwner: userPda.toBase58(),
    } satisfies QuoteStep] : []),
    {
      n: receiveN, chain: "solana", kind: "cctp-receive-message",
      userSigns: false, sponsorPaysFees: true,
      unsignedTx: null, blockedBy: hasEnsureAta ? ["step-1", "step-2", "circle-attestation"] : ["step-1", "circle-attestation"],
      // Stamped here so the sponsor doesn't re-derive on a possibly-stale
      // chain config later. Solana program ids + the recipient ATA/owner
      // the sponsor needs to pre-create (the receive ix does not auto-
      // create — required for first-time bridge users).
      programs: cctpVersion === 2
        ? {
            // Registry solana-block program ids; the Circle
            // V2 defaults die once that merges + fixtures regen.
            messageTransmitterProgram:    input.chain.bridge?.solana?.cctpMessageTransmitterProgramV2    ?? "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
            tokenMessengerMinterProgram:  input.chain.bridge?.solana?.cctpTokenMessengerMinterProgramV2 ?? "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
            splTokenProgram:              "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            usdcMint:                     gasMintId,
          }
        : {
            messageTransmitterProgram:    input.chain.bridge?.solana?.cctpMessageTransmitterProgram    ?? "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
            tokenMessengerMinterProgram:  input.chain.bridge?.solana?.cctpTokenMessengerMinterProgram ?? "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
            splTokenProgram:              "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            usdcMint:                     gasMintId,
          },
      recipientAta:      recipientAta.toBase58(),
      recipientPdaOwner: userPda.toBase58(),
    },
  ];

  if (gasMode) {
    steps.push({
      n: receiveN + 1, chain: `rome-${input.chain.chainId}`, kind: "settle-inbound-bridge-sponsored",
      userSigns: false, sponsorPaysFees: true,
      unsignedTx: null, blockedBy: [`step-${receiveN}`],
      // Everything the sponsor's settle needs, stamped at quote time.
      // sourceChain = the source EVM chain id (the Rome app replay-key parity —
      // both workers must derive the same BridgeProcessed PDA for a burn);
      // sourceTxHash is stamped at registration when step-1's hash is known.
      chainId: input.chain.chainId,
      user: input.recipient,
      bridgedAmount: undefined as never, // set below once amountOut is known
      sourceChain: String(entry.chainId),
      rollupProgramId: input.programId,
      mintAddress: gasMintId,
    });
  }

  const outputs: QuoteOutput[] = gasMode
    ? [{ kind: "gas", chainId: input.chain.chainId, amount: input.amount }]
    // chainId on the wrapper output too: wrapper quotes have no settle step
    // (no rome-<id> step.chain), so registration's resolveStamp anchors the
    // Rome chain EXCLUSIVELY on outputs[].chainId — without it the record
    // registers unstamped, backfills V1, and the poller 404s a V2 burn forever.
    : [{ kind: "wrapper", chainId: input.chain.chainId, solanaMint: gasMint.toBase58(), destinationAta: recipientAta.toBase58(), amount: input.amount }];

  // Fast deducts up to maxFee in transit (Circle refunds unexecuted fee, so
  // amountOut is the conservative worst case). Standard is amount-exact.
  const amountOut = wantFast ? (amount - maxFee).toString() : input.amount;
  if (wantFast) {
    for (const out of outputs) out.amount = amountOut;
  }
  const settleStep = steps.find((s) => s.kind === "settle-inbound-bridge-sponsored");
  if (settleStep) settleStep.bridgedAmount = amountOut;

  // Per-source honest ETA hints (upgraded to observed percentiles later):
  // fast ≈ attestation seconds; standard ≈ source finality (Sepolia ~18 min;
  // fast-finality chains like Monad attest standard burns in ~30 s).
  const etaSeconds = wantFast ? 40 : entry.chainId === 10143 ? 30 : 1100;

  return {
    route: "usdc-cctp-to-rome",
    direction: "to-rome",
    amountIn: input.amount,
    amountOut,
    fee: { bps: 0, absolute: "0", asset: "USDC" },
    protocolFee: "0",
    etaP90Seconds: null,
    ...(wantFast
      ? { fees: [{ type: "circle-fast-transfer", bps: fastBps, amount: maxFee.toString(), asset: "USDC", paidTo: "circle" }] }
      : {}),
    cctpVersion,
    sourceChainId: entry.chainId,
    speed: wantFast ? "fast" as const : "standard" as const,
    etaSeconds,
    steps,
    outputs,
  };
}

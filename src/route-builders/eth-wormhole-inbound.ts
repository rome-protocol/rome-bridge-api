import { encodeFunctionData, parseAbi } from "viem";
import { PublicKey } from "@solana/web3.js";
import { ROUTE_SPECS, assertAmountInRange } from "./route-keys.js";
import { deriveExternalAuthorityPda } from "../lib/pda.js";
import { deriveUserPdaAta } from "../lib/ata.js";
import { bridgeError } from "../errors.js";
import { assetFor, entryFor } from "../registry/catalog.js";
import type { Quote, QuoteInput, QuoteStep } from "./usdc-cctp-inbound.js";

const SOLANA_WORMHOLE_CHAIN_ID = 1;

// Wormhole Token Bridge + Core Bridge program IDs on Solana.
// Devnet defaults; prefer chain.bridge.solana.* from registry when present.
const DEFAULT_WORMHOLE_TOKEN_BRIDGE_SOL = "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe";
const DEFAULT_WORMHOLE_CORE_BRIDGE_SOL  = "3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5";
const DEFAULT_SPL_TOKEN_PROGRAM         = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const TOKEN_BRIDGE_ABI = parseAbi([
  "function wrapAndTransferETH(uint16 recipientChain, bytes32 recipient, uint256 arbiterFee, uint32 nonce) payable returns (uint64 sequence)",
]);

export function buildEthWormholeInboundQuote(input: QuoteInput): Quote {
  const spec = ROUTE_SPECS["eth-wormhole-to-rome"];
  const amount = BigInt(input.amount);
  assertAmountInRange(spec, input);
  if (!input.sender.ethereum) {
    throw bridgeError("rome.bridge.sender-incomplete", "ETH Wormhole inbound requires sender.ethereum");
  }
  // No sender.solana requirement: the destination ATA derives from `recipient`
  // below, and the Solana completion leg is sponsor-executed — EVM-only
  // wallets can take this route.

  // Published flat field on the source entry (never the phantom nested shape).
  const tokenBridge = entryFor(input.chain.bridge)?.wormholeTokenBridge as `0x${string}` | undefined;
  if (!tokenBridge) throw bridgeError("rome.bridge.asset-not-supported", "wormholeTokenBridge not configured on the source entry");

  const wrappedEthMintAddr = assetFor(input.chain.bridge, { symbol: "ETH" })?.solanaMint;
  if (!wrappedEthMintAddr) throw bridgeError("rome.bridge.asset-not-supported", "no ETH asset row (solanaMint) in bridge.json");

  const programId = new PublicKey(input.programId);
  const [userPda] = deriveExternalAuthorityPda(input.recipient, programId);
  const wrappedEthMint = new PublicKey(wrappedEthMintAddr);
  const recipientAta = deriveUserPdaAta(userPda, wrappedEthMint);
  const recipientBytes32 = "0x" + recipientAta.toBuffer().toString("hex") as `0x${string}`;

  const wrapData = encodeFunctionData({
    abi: TOKEN_BRIDGE_ABI, functionName: "wrapAndTransferETH",
    args: [SOLANA_WORMHOLE_CHAIN_ID, recipientBytes32, 0n, 0],
  });

  const steps: QuoteStep[] = [
    {
      n: 1, chain: "ethereum", kind: "wormhole-wrap-and-transfer-eth",
      unsignedTxs: [
        {
          to: tokenBridge, data: wrapData, value: input.amount,
          estimatedGas: "250000",
          description: "Wrap ETH → wETH and transfer to Solana via Wormhole TokenBridge",
        },
      ],
    },
    {
      n: 2, chain: "solana", kind: "wormhole-complete-transfer-wrapped",
      unsignedTx: null, blockedBy: ["step-1", "wormhole-vaa"],
      // Stamped here so the sponsor doesn't re-derive on a possibly-stale
      // chain config later. Includes Solana program ids + the recipient
      // ATA/owner the sponsor needs to pre-create the ATA (the receive ix
      // does not auto-create — required for first-time bridge users).
      programs: {
        coreBridgeProgram:  (input.chain.bridge as any)?.solana?.wormholeCoreProgram        ?? DEFAULT_WORMHOLE_CORE_BRIDGE_SOL,
        tokenBridgeProgram: (input.chain.bridge as any)?.solana?.wormholeTokenBridgeProgram ?? DEFAULT_WORMHOLE_TOKEN_BRIDGE_SOL,
        splTokenProgram:    (input.chain.bridge as any)?.solana?.splTokenProgram            ?? DEFAULT_SPL_TOKEN_PROGRAM,
        wrappedMint:        wrappedEthMintAddr,
      },
      recipientAta:      recipientAta.toBase58(),
      recipientPdaOwner: userPda.toBase58(),
    },
  ];

  return {
    route: "eth-wormhole-to-rome",
    direction: "to-rome",
    amountIn: input.amount,
    amountOut: input.amount,
    fee: { bps: 0, absolute: "0", asset: "ETH" },
    etaSeconds: 900, // Wormhole VAA finality is slow
    steps,
  };
}

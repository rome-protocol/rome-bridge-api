/**
 * `complete_transfer_wrapped` instruction builder — Wormhole Token Bridge
 * receive-leg helper for the bridge sponsor.
 *
 * Ported from the Rome app's `src/server/bridge/solana/completeTransfer.ts`
 * (kept registry-driven: the caller threads the Token Bridge + Core program
 * IDs through opts.tokenBridgePid + opts.wormholeCorePid, sourced from
 * `chain.bridge.solana.wormholeTokenBridgeProgram` / `wormholeCoreProgram`).
 *
 * Caller responsibility:
 *   - `vaaBase64` is the signed VAA from the Wormhole guardian network,
 *     base64-encoded. Fetch via the Wormholescan API once the source-side
 *     wrapAndTransferETH (or equivalent) has been signed and guardian-
 *     attested.
 *   - `payer` is the sponsor's keypair pubkey. Pays the rent for any new
 *     PDA accounts (`PostedVAA`, `Claim`) created during the receive.
 *
 * The SDK's `createCompleteTransferWrappedInstruction` mints
 * Wormhole-wrapped SPL to the destination address encoded inside the VAA's
 * payload (`to` field — 32-byte Solana pubkey). For the rome-evm inbound
 * path, that destination is the user's `getATA(external_auth(user, programId), wrappedMint)`
 * — set at source-side send time by the bridge UI / SDK constructing the
 * Sepolia `wrapAndTransferETH` call.
 */
import type { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { deserialize } from "@wormhole-foundation/sdk-connect";
import { createCompleteTransferWrappedInstruction } from "@wormhole-foundation/sdk-solana-tokenbridge";

export interface BuildCompleteTransferWrappedParams {
  payer: PublicKey;
  vaaBase64: string;
  connection: Connection;
  /**
   * Wormhole Token Bridge program id for the target Solana cluster.
   * Required — caller MUST source from
   * `chain.bridge.solana.wormholeTokenBridgeProgram` (registry-driven).
   * Hardcoding here would silently submit `complete_transfer_wrapped`
   * against the wrong cluster's program when chain config points
   * elsewhere (e.g. mainnet config + devnet builder = VAA never lands).
   *
   * - Devnet:  DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe
   * - Mainnet: wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb
   */
  tokenBridgePid: PublicKey;
  /**
   * Wormhole Core bridge program id for the same Solana cluster as
   * `tokenBridgePid`. Required — sourced from
   * `chain.bridge.solana.wormholeCoreProgram` upstream. Same drift
   * risk as the Token Bridge id.
   *
   * - Devnet:  3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5
   * - Mainnet: worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth
   */
  wormholeCorePid: PublicKey;
}

export async function buildCompleteTransferWrappedInstruction(
  p: BuildCompleteTransferWrappedParams,
): Promise<TransactionInstruction> {
  const vaaBytes = Buffer.from(p.vaaBase64, "base64");
  const vaa = deserialize("TokenBridge:Transfer", new Uint8Array(vaaBytes));

  return createCompleteTransferWrappedInstruction(
    p.connection,
    p.tokenBridgePid,
    p.wormholeCorePid,
    p.payer,
    vaa,
  );
}

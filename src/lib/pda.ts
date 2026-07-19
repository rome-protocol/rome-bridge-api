import { PublicKey } from "@solana/web3.js";
import { normalizeEvmAddress } from "./encoding.js";

const EXTERNAL_AUTHORITY_SEED = Buffer.from("EXTERNAL_AUTHORITY");

export function deriveExternalAuthorityPda(evmAddress: string, programId: PublicKey): [PublicKey, number] {
  const norm = normalizeEvmAddress(evmAddress);
  const addrBytes = Buffer.from(norm.replace(/^0x/, ""), "hex");
  if (addrBytes.length !== 20) throw new Error(`invalid evm address length: ${evmAddress}`);
  return PublicKey.findProgramAddressSync([EXTERNAL_AUTHORITY_SEED, addrBytes], programId);
}

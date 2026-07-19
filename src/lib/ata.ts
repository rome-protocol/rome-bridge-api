import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export function deriveUserPdaAta(userPda: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, userPda, true);
}

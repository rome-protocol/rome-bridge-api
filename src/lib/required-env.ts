/**
 * Fail-closed env access: endpoints whose silent public-default fallback has
 * bitten us (rate-limited public Solana RPC presenting as a broken bridge)
 * must throw at boot instead of degrading.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (fail-closed: no public-endpoint default)`);
  }
  return value;
}

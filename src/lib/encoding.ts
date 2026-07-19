export function evmAddressToBytes32(addr: string): string {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`invalid evm address: ${addr}`);
  return "0x" + "00".repeat(12) + hex;
}

export function bytes32ToEvmAddress(b: string): string {
  const hex = b.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid bytes32: ${b}`);
  return "0x" + hex.slice(24);
}

export function normalizeEvmAddress(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "");
}

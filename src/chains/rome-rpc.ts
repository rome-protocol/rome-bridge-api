/**
 * Rome proxy JSON-RPC extension: rome_solanaTxForEvmTx maps a Rome EVM tx
 * hash to the Solana signature(s) that executed it (field-proven by the
 * shipped outbound bridge worker).
 */
import { withTimeout } from "../lib/fetch-timeout.js";

export async function solanaTxForEvmTx(romeRpcUrl: string, evmTxHash: string, fetchFn: typeof fetch = globalThis.fetch): Promise<string[]> {
  const res = await withTimeout(fetchFn, 10_000)(romeRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rome_solanaTxForEvmTx", params: [evmTxHash] }),
  });
  if (!res.ok) throw new Error(`rome rpc ${res.status}`);
  const body = (await res.json()) as { result?: string[]; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "rome rpc error");
  return body.result ?? [];
}

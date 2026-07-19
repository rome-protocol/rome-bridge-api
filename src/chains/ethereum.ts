import { createPublicClient, http, PublicClient } from "viem";
import { sepolia, mainnet } from "viem/chains";

export interface EthereumReaderOpts {
  rpcUrl?: string;
  chain?: "sepolia" | "mainnet";
  transport?: PublicClient["getTransaction"];
  getTransactionReceipt?: PublicClient["getTransactionReceipt"];
}

export class EthereumReader {
  private getTransaction: PublicClient["getTransaction"];
  private getTransactionReceipt: PublicClient["getTransactionReceipt"];

  constructor(opts: EthereumReaderOpts) {
    if (opts.transport && opts.getTransactionReceipt) {
      this.getTransaction = opts.transport;
      this.getTransactionReceipt = opts.getTransactionReceipt;
    } else {
      const client = createPublicClient({
        chain: opts.chain === "mainnet" ? mainnet : sepolia,
        transport: http(opts.rpcUrl),
      });
      this.getTransaction = opts.transport ?? client.getTransaction.bind(client);
      this.getTransactionReceipt = opts.getTransactionReceipt ?? client.getTransactionReceipt.bind(client);
    }
  }

  async readTx(hash: string) {
    try {
      const tx = await this.getTransaction({ hash: hash as `0x${string}` });
      if (!tx) return null;
      return {
        to: tx.to ?? "0x0000000000000000000000000000000000000000",
        data: tx.input,
        value: tx.value.toString(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Read the tx's logs (Wormhole inbound poller uses this to find the
   * `LogMessagePublished` event emitted by the source-chain Core Bridge).
   * Returns [] if the tx isn't mined yet or doesn't exist.
   */
  async getTxLogs(hash: string): Promise<ReadonlyArray<{ address: string; topics: readonly string[]; data: string }>> {
    try {
      const receipt = await this.getTransactionReceipt({ hash: hash as `0x${string}` });
      if (!receipt) return [];
      return receipt.logs.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
      }));
    } catch {
      return [];
    }
  }
}

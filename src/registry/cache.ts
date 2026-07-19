import { ChainConfig } from "./types.js";
import { RegistryClient } from "./client.js";

interface Entry { value: ChainConfig[]; expiresAt: number; }

export class CachedRegistry {
  private cache: Entry | null = null;
  constructor(private client: RegistryClient, private ttlMs = 60_000) {}

  async listChains(): Promise<ChainConfig[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;
    const value = await this.client.listChains();
    this.cache = { value, expiresAt: now + this.ttlMs };
    return value;
  }
}

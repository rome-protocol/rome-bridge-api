import pino from "pino";
import type { Config } from "../config";

export function makeLogger(cfg: Config) {
  return pino({
    level: cfg.logLevel,
    base: { service: "rome-bridge-api", env: cfg.env },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof makeLogger>;

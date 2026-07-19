import { timingSafeEqual } from "node:crypto";

/**
 * Gate for worker-internal endpoints (pending list, settle material,
 * heartbeat). Compares x-worker-token against WORKER_INTERNAL_TOKEN in
 * constant time; unset token ⇒ endpoints disabled (404, indistinguishable
 * from absent).
 */
export function workerAuthorized(req: { headers: Record<string, unknown> }): boolean {
  const expected = process.env.WORKER_INTERNAL_TOKEN;
  if (!expected) return false;
  const raw = req.headers["x-worker-token"];
  const got = Array.isArray(raw) ? raw[0] : raw;
  if (typeof got !== "string") return false;
  const a = Buffer.from(got, "utf8"), b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Persisted snapshot store — the thing that makes a COLD open instant.
//
// The in-memory cache only lives as long as one serverless instance, and the
// edge cache is per-region and wiped by every deploy. So the "first request
// through the door" (new instance, new region, or right after a deploy) had to
// rebuild the whole cross-league slate — 1-2 minutes. This stores the finished
// slate somewhere permanent, so any such request just reads it back instantly.
//
// Backed by a Redis REST API (Vercel KV / Upstash Redis from the Vercel
// Marketplace). Deliberately uses plain fetch against the REST endpoint so there
// is NO new npm dependency to install or trace into the serverless bundle.
//
// SAFE BY DEFAULT: if the env vars aren't set, everything here no-ops and the app
// behaves exactly as before. Adding the store later switches it on with no code
// change.

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const snapshotEnabled = () => Boolean(REST_URL && REST_TOKEN);

// One POST per command: the REST API takes the command as a JSON array, which
// (unlike the path form) handles payloads of a few hundred KB fine.
async function command(args, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(REST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${REST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json?.result ?? null;
  } catch {
    return null; // never let the store break a request
  } finally {
    clearTimeout(t);
  }
}

// Read a snapshot back. Returns the stored value, or null when missing/disabled.
export async function loadSnapshot(key) {
  if (!snapshotEnabled()) return null;
  const raw = await command(["GET", key]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Store a snapshot with a TTL, so a stale slate can never outlive its usefulness.
// Fire-and-forget at the call site — a store failure must never fail the request.
export async function saveSnapshot(key, value, ttlSeconds) {
  if (!snapshotEnabled()) return false;
  const body = JSON.stringify(value);
  const ok = await command(["SETEX", key, String(Math.max(60, ttlSeconds | 0)), body], 8000);
  return ok !== null;
}

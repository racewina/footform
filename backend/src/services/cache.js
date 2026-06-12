import NodeCache from "node-cache";

export const TTL = {
  LEAGUES: 24 * 60 * 60,
  FIXTURES: 30 * 60,
  TEAM_FORM: 6 * 60 * 60,
};

const cache = new NodeCache({ stdTTL: TTL.FIXTURES, checkperiod: 120 });

export function cacheGet(key) {
  return cache.get(key);
}

export function cacheSet(key, value, ttl) {
  return cache.set(key, value, ttl);
}

export function cacheStats() {
  return { keys: cache.keys().length, ...cache.getStats() };
}

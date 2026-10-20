// Leagues the Telegram bot features, in three categories (user spec 2026-10-19):
//
//   ⭐ Europe top 5 — UEFA club competitions + the top 5 leagues and their second
//                     tiers (no domestic cups, no 3rd tier or below).
//   🇪🇺 Europe       — every league in the app from any OTHER European country.
//   🌎 South America — CONMEBOL Libertadores/Sudamericana + each country's top flight
//                     (no domestic cups, no lower tiers).
//
// Everything else (MLS, Saudi, Asia, Africa, top-5 cups and lower tiers…) is left out
// of the bot; the web app still covers all leagues. Every bot search, acca, props
// lookup and daily push is limited to BOT_FEATURED.

import { LEAGUES, continentFor } from "./leagues.js";

export const TOP5_COUNTRIES = ["England", "Spain", "Italy", "Germany", "France"];
export const UEFA_IDS = ["2", "3", "848"]; // Champions, Europa, Conference League
export const CONMEBOL_IDS = ["13", "11"]; // Libertadores, Sudamericana
// Top-5 top flight + second tier: PL/Championship, La Liga/La Liga 2, Serie A/B,
// Bundesliga/2. Bundesliga, Ligue 1/Ligue 2.
const TOP5_LEAGUE_IDS = ["39", "40", "140", "141", "135", "136", "78", "79", "61", "62"];
const CUP_RX = /\b(cup|copa|pokal|coupe|coppa|beker)\b|taça/i;

const existing = (ids) => ids.filter((id) => LEAGUES.some((l) => String(l.id) === id));

export const EUROPE_TOP5_IDS = existing([...UEFA_IDS, ...TOP5_LEAGUE_IDS]);
export const EUROPE_OTHER_IDS = LEAGUES
  .filter((l) => continentFor(l.country) === "Europe" && l.country !== "Europe" && !TOP5_COUNTRIES.includes(l.country))
  .map((l) => String(l.id));
export const SA_TOP_IDS = existing([
  ...CONMEBOL_IDS,
  ...LEAGUES
    .filter((l) => continentFor(l.country) === "South America" && l.country !== "South America" && l.tier === 1 && !CUP_RX.test(l.name))
    .map((l) => String(l.id)),
]);

export const BOT_FEATURED = new Set([...EUROPE_TOP5_IDS, ...EUROPE_OTHER_IDS, ...SA_TOP_IDS]);

// code → the parser scope it maps to, its label and its league ids.
export const BOT_REGIONS = [
  { code: "e5", scope: "europe-top5", phrase: "europe top 5", label: "⭐ Europe top 5", ids: EUROPE_TOP5_IDS },
  { code: "eu", scope: "europe-other", phrase: "rest of europe", label: "🇪🇺 Europe", ids: EUROPE_OTHER_IDS },
  { code: "sa", scope: "south-america", phrase: "south america", label: "🌎 South America", ids: SA_TOP_IDS },
];

// The "countries" of a region, in a stable order (so buttons can carry an index):
// the club competition group first (UEFA / CONMEBOL), then countries A–Z.
// Each entry: { name, flag, ids, phrase } — phrase is the parser filter that selects it.
export function regionCountries(code) {
  const region = BOT_REGIONS.find((r) => r.code === code);
  if (!region) return [];
  const leagues = region.ids.map((id) => LEAGUES.find((l) => String(l.id) === id)).filter(Boolean);
  const groups = [];
  const comps = leagues.filter((l) => l.country === "Europe" || l.country === "South America");
  if (comps.length) {
    const uefa = code === "e5";
    groups.push({ name: uefa ? "UEFA competitions" : "CONMEBOL cups", flag: uefa ? "🇪🇺" : "🌎", ids: comps.map((l) => String(l.id)), phrase: uefa ? "only uefa" : "only conmebol cups" });
  }
  const byCountry = new Map();
  for (const l of leagues) {
    if (l.country === "Europe" || l.country === "South America") continue;
    if (!byCountry.has(l.country)) byCountry.set(l.country, { name: l.country, flag: l.flag, ids: [] });
    byCountry.get(l.country).ids.push(String(l.id));
  }
  for (const c of [...byCountry.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    groups.push({ ...c, phrase: `only ${c.name.toLowerCase()}` });
  }
  return groups;
}

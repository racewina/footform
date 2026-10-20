// Cross-league competitions (UEFA / CONMEBOL club cups) need a league-strength edge.
//
// The model rates every team by its DOMESTIC form, so in a Champions League tie a side
// that dominates a weak league looks as strong as one that dominates the Premier League.
// Study 2026-10-19 on 214 finished cross-league matches (Aug 15–Oct 18, leak-free
// pre-kickoff predictions):
//   UEFA  top-5 v other:    model 1.45 xG / 34% win → actual 2.44 goals / 64% win
//         other v top-5:    model 1.57 xG / 39% win → actual 1.09 goals / 22% win
//   CONMEBOL BRA/ARG v other: model 33% win → actual 53%; other v BRA/ARG: 36% → 11%
// A two-group goal edge (top-5 countries in UEFA cups; Brazil/Argentina in CONMEBOL
// cups) fitted before Oct 1 and scored on Oct 1–18 cut 1X2 log loss 1.018 → 0.969 and
// Over 2.5 0.671 → 0.649; the fitted edge was stable across both windows. Fitted on all
// 214: UEFA ×1.60 goals (log 0.471), CONMEBOL ×1.56 (log 0.444). With bookmaker odds the
// market is far better informed here (1X2 log loss: current 60/40 blend 0.899, 90%
// market 0.814, market only 0.806), so cross-league matches lean 90% on the market.

import { LEAGUES_BY_ID, continentFor } from "../data/leagues.js";

const TOP5 = new Set(["England", "Spain", "Italy", "Germany", "France"]);
const BRA_ARG = new Set(["Brazil", "Argentina"]);
const UEFA = { edge: 0.471, strong: TOP5 };
const CONMEBOL = { edge: 0.444, strong: BRA_ARG };
export const CROSS_LEAGUE = { "2": UEFA, "3": UEFA, "848": UEFA, "13": CONMEBOL, "11": CONMEBOL };
export const CROSS_MARKET_WEIGHT = 0.9;

// Competitions that mix leagues (and friendlies/internationals) — never a team's home league.
const NOT_DOMESTIC = new Set(["2", "3", "848", "13", "11", "772", "1", "10", "667", "4", "5", "531", "15"]);

export const isCrossLeague = (leagueId) => Boolean(CROSS_LEAGUE[String(leagueId)]);

// A team's home league = the most frequent non-cross competition in its recent fixtures.
export function domesticCountry(events) {
  const counts = {};
  for (const e of events || []) {
    const id = String(e.leagueId ?? "");
    if (id && !NOT_DOMESTIC.has(id)) counts[id] = (counts[id] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  // Every top-5 and Brazil/Argentina league is in LEAGUES; an unknown league simply
  // means "not one of the strong group", which is all the edge needs to know.
  return top ? LEAGUES_BY_ID[top[0]]?.country || null : null;
}

// Log goal multiplier for the HOME side (the away side gets the negative). 0 when the
// competition isn't cross-league or both teams are in the same group.
export function crossLeagueTilt(leagueId, homeEvents, awayEvents) {
  const cfg = CROSS_LEAGUE[String(leagueId)];
  if (!cfg) return 0;
  const h = cfg.strong.has(domesticCountry(homeEvents)) ? 1 : 0;
  const a = cfg.strong.has(domesticCountry(awayEvents)) ? 1 : 0;
  return cfg.edge * (h - a);
}

// Same edge for a bare matchup with no competition context (/analyze, /predict):
// two teams from different domestic leagues on the same continent are treated as a
// UEFA / CONMEBOL tie. Same-league or cross-continent pairs get no tilt.
export function matchupTilt(homeEvents, awayEvents) {
  const hc = domesticCountry(homeEvents), ac = domesticCountry(awayEvents);
  if (!hc || !ac || hc === ac) return 0;
  const cont = continentFor(hc);
  if (cont !== continentFor(ac)) return 0;
  const cfg = cont === "Europe" ? UEFA : cont === "South America" ? CONMEBOL : null;
  if (!cfg) return 0;
  return cfg.edge * ((cfg.strong.has(hc) ? 1 : 0) - (cfg.strong.has(ac) ? 1 : 0));
}

// Rule-based natural-language parser for the prediction chatbot. Turns a free-
// text query ("list teams in the europe top to score O2.5 and BTTS above 60%")
// into structured filters the /ask route runs through the SAME prediction engine
// (buildLeagueDay) the rest of the app uses — no external LLM, all our own data.

// Markets the chatbot understands. `aliases` are matched case-insensitively as
// whole-ish phrases; longer/more-specific families are ordered first so
// "over 2.5" doesn't also trip "over 1.5", and "score 2+" beats "to score".
export const CHAT_MARKETS = [
  { key: "over35", label: "Over 3.5 Goals", aliases: ["over 3.5", "o3.5", "3.5 goals", "3.5+ goals"] },
  { key: "over25", label: "Over 2.5 Goals", aliases: ["over 2.5", "o2.5", "o25", "2.5 goals", "2.5+ goals", "3+ goals", "three or more goals"] },
  { key: "over15", label: "Over 1.5 Goals", aliases: ["over 1.5", "o1.5", "1.5 goals"] },
  { key: "btts", label: "Both Teams to Score", aliases: ["btts", "both teams to score", "both to score", "gg", "both team to score"] },
  { key: "dc", label: "Double Chance", aliases: ["double chance", "dc", "or draw", "not to lose", "won't lose", "wont lose"] },
  { key: "team2plus", label: "Team to Score 2+", aliases: ["score 2+", "2+ goals", "to score 2", "two or more goals", "2 plus goals", "brace", "score two"] },
  { key: "team1plus", label: "Team to Score", aliases: ["team to score", "1+ goals", "score a goal", "anytime scorer", "to score 1"] },
  { key: "win", label: "To Win", aliases: ["to win", "win", "winner", "match winner", "1x2", "outright", "victory"] },
];

// Continent / grouping scopes. TOP_EUROPE = the marquee European competitions.
export const CHAT_SCOPES = [
  { key: "top-europe", label: "Top Europe", aliases: ["top europe", "europe top", "top european", "big leagues", "top leagues", "top 5", "top five", "elite leagues", "major leagues", "top flight"] },
  { key: "europe", label: "Europe", aliases: ["europe", "european"] },
  { key: "south-america", label: "South America", aliases: ["south america", "conmebol", "latin america"] },
  { key: "north-america", label: "North America", aliases: ["north america", "concacaf"] },
  { key: "asia", label: "Asia", aliases: ["asia", "asian"] },
  { key: "africa", label: "Africa", aliases: ["africa", "african"] },
];
export const CONTINENT_OF_SCOPE = {
  europe: "Europe", "south-america": "South America", "north-america": "North America",
  asia: "Asia", africa: "Africa",
};
// CL, EL, Conference, Premier League, La Liga, Serie A, Bundesliga, Ligue 1.
export const TOP_EUROPE_IDS = ["2", "3", "848", "39", "140", "135", "78", "61"];

const hasPhrase = (q, phrase) => {
  // Whole-ish match: phrase surrounded by non-alphanumerics (so "win" doesn't
  // match "winter", but "o2.5" and "2.5" still work).
  const p = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${p}([^a-z0-9]|$)`, "i").test(q);
};

// Parse a free-text query into { markets, scope, leagueId, leagueName, minProb,
// oddsMin, oddsMax, within, date }. `leagues` is the day's league list
// [{id,name,country,flag}] so a query can name a specific competition.
export function parseQuery(raw, leagues = []) {
  const q = ` ${(raw || "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ")} `;

  // Markets (dedup, first-match-wins order handles over/team families).
  const markets = [];
  for (const m of CHAT_MARKETS) {
    if (markets.includes(m.key)) continue;
    if (m.aliases.some((a) => hasPhrase(q, a))) markets.push(m.key);
  }
  // Scope: an explicit continent/top-europe, else a named league, else all.
  let scope = "all", leagueId = null, leagueName = null;
  const scopeHit = CHAT_SCOPES.find((s) => s.aliases.some((a) => hasPhrase(q, a)));
  if (scopeHit) scope = scopeHit.key;
  // Named league (longest name match wins), only if no strong continent scope.
  if (scope === "all" || scope === "europe") {
    const named = [...leagues]
      .filter((l) => l.name && hasPhrase(q, l.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (named) { scope = "league"; leagueId = String(named.id); leagueName = named.name; }
  }

  // Minimum model probability.
  let minProb = 55;
  const pctM = q.match(/(\d{2})\s*(?:%|percent|pct)/);
  if (pctM) minProb = Math.min(95, Math.max(30, Number(pctM[1])));
  else if (hasPhrase(q, "very likely") || hasPhrase(q, "very safe") || hasPhrase(q, "banker")) minProb = 72;
  else if (hasPhrase(q, "safe") || hasPhrase(q, "strong")) minProb = 65;
  else if (hasPhrase(q, "likely") || hasPhrase(q, "probable")) minProb = 60;

  // Odds range: "between 1.5 and 2", "over 1.5 odds", "1.5+ odds", "under 2 odds".
  let oddsMin = null, oddsMax = null;
  const between = q.match(/(?:odds\s*)?(?:between|from)\s*(\d(?:\.\d+)?)\s*(?:to|and|-)\s*(\d(?:\.\d+)?)/);
  if (between) { oddsMin = Number(between[1]); oddsMax = Number(between[2]); }
  else {
    const over = q.match(/(?:odds\s*(?:over|above|of|from)\s*|over\s*)(\d(?:\.\d+)?)\s*(?:\+)?\s*(?:odds)?/);
    const plus = q.match(/(\d(?:\.\d+)?)\s*\+\s*odds/);
    const under = q.match(/(?:odds\s*(?:under|below)\s*|under\s*)(\d(?:\.\d+)?)\s*odds?/);
    if (plus) oddsMin = Number(plus[1]);
    else if (over && /odd/.test(q)) oddsMin = Number(over[1]);
    if (under) oddsMax = Number(under[1]);
  }

  // Time window + day.
  let within = "all";
  const win = q.match(/(?:next|within|in the next)\s*(\d)\s*h(?:ours?|rs?)?/);
  if (win && ["1", "3", "6"].includes(win[1])) within = win[1];
  else if (hasPhrase(q, "soon") || hasPhrase(q, "kicking off")) within = "3";
  const date = hasPhrase(q, "tomorrow") ? "tomorrow" : "today";

  return { markets, scope, leagueId, leagueName, minProb, oddsMin, oddsMax, within, date };
}

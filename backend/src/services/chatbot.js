// Rule-based natural-language parser for the prediction chatbot. Turns a free-
// text query ("list teams in the europe top to score O2.5 and BTTS above 60%")
// into structured filters the /ask route runs through the SAME prediction engine
// (buildLeagueDay) the rest of the app uses — no external LLM, all our own data.

// Markets the chatbot understands. `aliases` are matched case-insensitively as
// whole-ish phrases; longer/more-specific families are ordered first so
// "over 2.5" doesn't also trip "over 1.5", and "score 2+" beats "to score".
export const CHAT_MARKETS = [
  // Under markets first so "under 2.5" never trips the over aliases.
  { key: "under35", label: "Under 3.5 Goals", aliases: ["under 3.5", "u3.5", "below 3.5", "under four goals"] },
  { key: "under25", label: "Under 2.5 Goals", aliases: ["under 2.5", "u2.5", "below 2.5", "less than 3 goals", "fewer than 3", "under three goals"] },
  { key: "under15", label: "Under 1.5 Goals", aliases: ["under 1.5", "u1.5", "below 1.5", "under two goals"] },
  { key: "over35", label: "Over 3.5 Goals", aliases: ["over 3.5", "o3.5", "3.5+ goals", "4+ goals", "four or more goals"] },
  { key: "over25", label: "Over 2.5 Goals", aliases: ["over 2.5", "o2.5", "o25", "2.5+ goals", "3+ goals", "three or more goals"] },
  { key: "over15", label: "Over 1.5 Goals", aliases: ["over 1.5", "o1.5", "1.5+ goals", "two or more goals in the match", "at least 2 goals in the match"] },
  { key: "btts", label: "Both Teams to Score", aliases: ["btts", "both teams to score", "both to score", "gg", "both team to score"] },
  { key: "dc", label: "Double Chance", aliases: ["double chance", "dc", "or draw", "not to lose", "won't lose", "wont lose"] },
  { key: "team2plus", label: "Team to Score 2+", aliases: ["score 2+", "2+ goals", "to score 2", "two or more goals", "2 plus goals", "brace", "score two"] },
  { key: "team1plus", label: "Team to Score", aliases: ["team to score", "teams to score", "1+ goals", "score a goal", "anytime scorer", "to score 1"] },
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

  // Markets (dedup, first-match-wins order handles over/team families). Detect
  // against `qm`, a copy with odds phrases blanked out, so an odds number that
  // happens to be a goal line ("to win at odds under 1.5") can't trip a goals
  // market ("Under 1.5 Goals"). Odds/scope/day parsing below still use `q`.
  const CMP = "(?:of\\s*)?(?:over|under|above|below|up to|from|at least|at most|greater than|less than|more than|higher than|lower than|no less than|no more than|of at least|of at most|=|>=|<=|>|<|≥|≤)*";
  const qm = q
    .replace(new RegExp(`\\b(?:odds?|price)\\s*${CMP}\\s*\\d+(?:\\.\\d+)?\\s*\\+?`, "g"), " odds ")
    .replace(/\d+(?:\.\d+)?\s*\+?\s*(?:odds?|price)\b/g, " odds ");
  const markets = [];
  for (const m of CHAT_MARKETS) {
    if (markets.includes(m.key)) continue;
    if (m.aliases.some((a) => hasPhrase(qm, a))) markets.push(m.key);
  }
  // "team to score 2+" trips both team1plus ("team to score") and team2plus
  // ("score 2+"); 2+ implies 1+, so keep only the stronger ask.
  if (markets.includes("team2plus") && markets.includes("team1plus")) {
    markets.splice(markets.indexOf("team1plus"), 1);
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

  // Odds bounds. Parsed only when the query is actually about odds ("odd(s)",
  // "price", or a decimal "1.46+"), so plain goal lines don't leak in.
  //
  // The hard case is that goal markets are written with the SAME words as odds
  // comparators ("over 2.5" the market vs "over 1.8" the odds floor). Two guards:
  //   • `N` ends with `(?![\d.])` so it always grabs the WHOLE number — it can't
  //     scrape "2" out of "2.5" and pass a bare-integer check.
  //   • "over/above/under/below/from/up to" are AMBIGUOUS: they only count as odds
  //     when glued to "odds/price", or when the number isn't a goal line (X.5).
  //     Unambiguous comparators ("greater than", "at least", "less than"…) never
  //     appear in a goal-market phrase, so they match bare.
  let oddsMin = null, oddsMax = null;
  const mentionsOdds = /\bodds?\b|\bprices?\b|\d\.\d+\s*\+/.test(q);
  if (mentionsOdds) {
    const N = "(\\d+(?:\\.\\d+)?)(?![\\d.])";       // a whole number, no trailing digit/dot
    const noGL = "(?!\\s*(?:%|percent|pct|goals?|\\+ goals))"; // not a %/goal number
    const OD = "(?:odds?|price)";
    const GOAL_LINES = new Set([0.5, 1.5, 2.5, 3.5, 4.5]);
    const take = (body) => { const mm = q.match(new RegExp(body)); return mm ? Number(mm[1]) : null; };
    // Ambiguous comparator → odds only if odds-adjacent or the number isn't a goal line.
    const takeAmbig = (cmp) => {
      const adj = take(`${OD}\\s*(?:of\\s*)?${cmp}\\s*${N}${noGL}`) ?? take(`${cmp}\\s*${N}\\s*(?:\\+\\s*)?${OD}`);
      if (adj != null) return adj;
      const bare = take(`${cmp}\\s*${N}${noGL}`);
      return bare != null && !GOAL_LINES.has(bare) ? bare : null;
    };

    // Range: "between 1.5 and 2", "1.5 to 2 odds", "1.5-2 odds".
    const range = q.match(new RegExp(`${OD}\\s*(?:between|from)\\s*${N}\\s*(?:to|and|-|–|through)\\s*${N}${noGL}`))
      || q.match(new RegExp(`${N}\\s*(?:to|-|–)\\s*${N}\\s*${OD}`));
    if (range) { oddsMin = Number(range[1]); oddsMax = Number(range[2]); }
    else {
      const MIN = "(?:greater than|more than|higher than|bigger than|no less than|not less than|at least|minimum(?: of)?|min(?: of)?|of at least|>=|>|≥)";
      const MAX = "(?:less than|lower than|smaller than|no more than|not more than|at most|maximum(?: of)?|max(?: of)?|of at most|<=|<|≤)";
      // Floor: unambiguous comparator, else "1.46+" (decimal only), else ambiguous over/above/from.
      let mn = take(`${MIN}\\s*${N}${noGL}`);
      if (mn == null) mn = take(`(\\d+\\.\\d+)\\s*\\+`);
      if (mn == null) mn = take(`${N}\\s*or\\s*(?:higher|more|above|greater|better)`) ;
      if (mn == null) mn = takeAmbig("(?:over|above|from)");
      // Ceiling: unambiguous comparator, else ambiguous under/below/up to.
      let mx = take(`${MAX}\\s*${N}${noGL}`);
      if (mx == null) mx = take(`${N}\\s*or\\s*(?:lower|less|below|under)`);
      if (mx == null) mx = takeAmbig("(?:under|below|up to)");
      // Fallback: a bare "odds of 1.46" is a floor (a target price).
      if (mn == null && mx == null) mn = take(`${OD}\\s*(?:of|at|=)?\\s*${N}${noGL}`);
      oddsMin = mn; oddsMax = mx;
    }
    // Sanity: odds are >= 1.01; drop anything that parsed to a goal/percent-like value.
    if (oddsMin != null && (oddsMin < 1.01 || oddsMin > 1000)) oddsMin = null;
    if (oddsMax != null && (oddsMax < 1.01 || oddsMax > 1000)) oddsMax = null;
    if (oddsMin != null && oddsMax != null && oddsMin > oddsMax) { const t = oddsMin; oddsMin = oddsMax; oddsMax = t; }
  }

  // Time window + day.
  let within = "all";
  const win = q.match(/(?:next|within|in the next)\s*(\d)\s*h(?:ours?|rs?)?/);
  if (win && ["1", "3", "6"].includes(win[1])) within = win[1];
  else if (hasPhrase(q, "soon") || hasPhrase(q, "kicking off")) within = "3";
  // Day the query is about. A token the /ask route resolves to concrete date(s)
  // using the caller's timezone: "today" | "tomorrow" | "weekend" | a weekday
  // name ("saturday"…). Weekday/weekend win over the "today" default; explicit
  // "today"/"tonight" wins over a bare weekday if both appear.
  const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  let date = "today";
  if (hasPhrase(q, "tomorrow")) date = "tomorrow";
  else if (hasPhrase(q, "today") || hasPhrase(q, "tonight")) date = "today";
  else if (hasPhrase(q, "weekend")) date = "weekend";
  else { const d = DAY_NAMES.find((day) => hasPhrase(q, day)); if (d) date = d; }

  return { markets, scope, leagueId, leagueName, minProb, oddsMin, oddsMax, within, date };
}

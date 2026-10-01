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
  { key: "top-europe", label: "Top Europe", aliases: ["top europe", "europe top", "top european", "big leagues", "top leagues", "top 5 leagues", "top five leagues", "big 5 leagues", "big five leagues", "elite leagues", "major leagues", "top flight"] },
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

// ---- Include / exclude filters ---------------------------------------------
// "exclude friendlies", "without arsenal", "only germany and england",
// "national league only", "no cups". Each term resolves to a league, country,
// continent, friendlies, cups, or (fallback) a team name matched against the
// fixtures at scan time. Clauses are CUT from the query before anything else is
// parsed, so "exclude national league" can't be read as the league to search.

export const normText = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DEMONYMS = {
  english: "England", german: "Germany", spanish: "Spain", italian: "Italy", french: "France",
  dutch: "Netherlands", holland: "Netherlands", portuguese: "Portugal", scottish: "Scotland",
  belgian: "Belgium", turkish: "Turkey", brazilian: "Brazil", argentine: "Argentina",
  argentinian: "Argentina", american: "USA", us: "USA", "united states": "USA", mexican: "Mexico",
  japanese: "Japan", swedish: "Sweden", norwegian: "Norway", danish: "Denmark", austrian: "Austria",
  swiss: "Switzerland", greek: "Greece", polish: "Poland", irish: "Ireland", croatian: "Croatia",
  serbian: "Serbia", czech: "Czech Republic", romanian: "Romania", bulgarian: "Bulgaria",
  hungarian: "Hungary", finnish: "Finland", icelandic: "Iceland", chinese: "China",
  korean: "South Korea", "south korean": "South Korea", saudi: "Saudi Arabia", egyptian: "Egypt",
  colombian: "Colombia", chilean: "Chile", uruguayan: "Uruguay", paraguayan: "Paraguay",
  ecuadorian: "Ecuador", bolivian: "Bolivia", venezuelan: "Venezuela", canadian: "Canada",
  cypriot: "Cyprus", slovak: "Slovakia", estonian: "Estonia", "south african": "South Africa",
};
const CONTINENT_WORDS = {
  europe: "Europe", european: "Europe", asia: "Asia", asian: "Asia", africa: "Africa", african: "Africa",
  "south america": "South America", "south american": "South America", "latin america": "South America",
  conmebol: "South America", "north america": "North America", "north american": "North America",
  concacaf: "North America",
};
export const CUP_RX = /\b(cup|copa|pokal|coupe|coppa|beker)\b|taça|taca de/i;

const EXCL = "exclude|excluding|except|without|skip|ignore|but not|other than|apart from";
const INCL = "only|include|including|limited to|restricted to";
// Query grammar that ends a filter clause (a market, day, odds, count, another clause…).
const STOP = `odds?|prices?|with|for|at|over|under|above|below|between|tomorrow|today|tonight|this|next|on|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|top|best|btts|gg|both|double|dc|to win|win|winner|team to|teams to|to score|goals?|safe|safest|strong|strongest|likely|likeliest|probable|banker|bankers|very|\\d|${EXCL}|${INCL}`;
const CLAUSE_RX = new RegExp(`\\b(${EXCL}|${INCL})\\s+(?!(?:${STOP})\\b)(.+?)(?=[.;!?]|\\s+(?:${STOP})\\b|\\s*$)`, "g");
const EXCL_RX = new RegExp(`^(?:${EXCL})$`);
// Single words that stop the backward walk of a postfix "… only".
const BACK_STOP_RX = new RegExp(`^(?:odds?|prices?|with|for|at|over|under|above|below|between|tomorrow|today|tonight|this|next|on|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|top|best|btts|gg|both|double|dc|win|winner|score|goals?|to|in|from|of|safe|safest|strong|strongest|likely|likeliest|probable|banker|bankers|very|${EXCL}|${INCL})$|[\\d%+]`);

const cleanTerm = (t) => {
  let x = t.replace(/["“”‘’()]/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    const y = x.replace(/^(?:the|any|all|games?|matches|fixtures|teams?|clubs?|from|in|of)\s+/, "")
               .replace(/\s+(?:games?|matches|fixtures|teams?|leagues|clubs?|sides|football|soccer)$/, "");
    if (y === x) break;
    x = y;
  }
  x = x.trim();
  return /^(?:the|any|all|games?|matches|fixtures|teams?|clubs?|picks?|tips?|bets?|from|in|of)$/.test(x) ? "" : x;
};

function resolveFilterTerm(term, leagues) {
  const n = normText(cleanTerm(term));
  if (!n || /^[\d.\s%+]+$/.test(n)) return null;
  if (/^(?:club |international )?friendl(?:y|ies)$/.test(n)) return { kind: "friendlies", label: "friendlies" };
  if (/^cups?$|^cup (?:games|matches|competitions)$|^domestic cups?$/.test(n)) return { kind: "cups", label: "cups" };
  if (CONTINENT_WORDS[n]) return { kind: "continent", value: CONTINENT_WORDS[n], label: CONTINENT_WORDS[n] };
  if (CHAT_SCOPES[0].aliases.some((a) => normText(a) === n)) return { kind: "league", ids: [...TOP_EUROPE_IDS], label: "Top Europe" };

  const countries = [...new Set(leagues.map((l) => l.country))];
  const countryOf = (w) => countries.find((c) => normText(c) === w) || (DEMONYMS[w] && countries.includes(DEMONYMS[w]) ? DEMONYMS[w] : null);
  const whole = countryOf(n);
  if (whole) return { kind: "country", value: whole, label: whole };

  // Optional country qualifier: "english premier league" → England's only.
  let country = null, rest = n;
  const prefixes = [...countries.map(normText), ...Object.keys(DEMONYMS)].sort((a, b) => b.length - a.length);
  for (const w of prefixes) {
    if (n.startsWith(`${w} `) && countryOf(w)) { country = countryOf(w); rest = n.slice(w.length + 1); break; }
  }
  const pool = country ? leagues.filter((l) => l.country === country) : leagues;
  let hits = pool.filter((l) => normText(l.name) === rest);
  if (!hits.length && rest.length >= 3) {
    const rx = new RegExp(`\\b${escRx(rest)}\\b`); // whole words: "inter" ≠ "International"
    hits = pool.filter((l) => rx.test(normText(l.name)));
  }
  if (hits.length) {
    const names = [...new Set(hits.map((l) => l.name))];
    const label = names.length === 1
      ? (hits.length > 1 || country ? `${names[0]} (${[...new Set(hits.map((l) => l.country))].join("/")})` : names[0])
      : names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
    return { kind: "league", ids: hits.map((l) => String(l.id)), label };
  }
  return { kind: "team", value: n, label: `“${cleanTerm(term)}”` };
}

const splitTerms = (text) => text.split(/\s*(?:,|\/|&|\band\b|\bor\b|\bnor\b)\s*/).map((t) => t.trim()).filter(Boolean);

// → { q: query with the filter clauses cut out, include: [...], exclude: [...] }
function extractFilters(q, leagues) {
  const include = [], exclude = [], spans = [];
  const take = (list, text, start, end) => {
    const terms = splitTerms(text).map((t) => resolveFilterTerm(t, leagues)).filter(Boolean);
    if (!terms.length) return; // e.g. "only 5 games" — leave it for the count parser
    list.push(...terms);
    spans.push([start, end]);
  };
  for (const m of q.matchAll(CLAUSE_RX)) {
    take(EXCL_RX.test(m[1]) ? exclude : include, m[2], m.index, m.index + m[0].length);
  }
  for (const m of q.matchAll(/\bno\s+((?:club |international )?friendl\w*|cups?)\b/g)) {
    take(exclude, m[1], m.index, m.index + m[0].length);
  }
  // Postfix: "national league only", "german teams only" — walk back up to 4 words.
  for (const m of q.matchAll(new RegExp(`\\bonly\\b(?=\\s*(?:[.;!?,]|$)|\\s+(?:${STOP})\\b)`, "g"))) {
    const before = q.slice(0, m.index).replace(/\s+$/, "");
    const words = before.split(" ");
    const picked = [];
    while (words.length && picked.length < 4 && words[words.length - 1] && !BACK_STOP_RX.test(words[words.length - 1])) picked.unshift(words.pop());
    if (picked.length) {
      const text = picked.join(" ");
      take(include, text, before.length - text.length, m.index + 4);
    }
  }
  let out = q;
  for (const [a, b] of spans.sort((x, y) => y[0] - x[0])) out = `${out.slice(0, a)} ${out.slice(b)}`;
  // Same term twice (e.g. two clauses) → keep one.
  const dedup = (list) => list.filter((t, i) => list.findIndex((u) => u.label === t.label && u.kind === t.kind) === i);
  return { q: ` ${out.replace(/\s+/g, " ").trim()} `, include: dedup(include), exclude: dedup(exclude) };
}

// Parse a free-text query into { markets, scope, leagueId, leagueName, minProb,
// oddsMin, oddsMax, within, date }. `leagues` is the day's league list
// [{id,name,country,flag}] so a query can name a specific competition.
export function parseQuery(raw, leagues = []) {
  const q0 = ` ${(raw || "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ")} `;
  // Include/exclude clauses are cut out first; everything below parses what's left.
  const { q, include, exclude } = extractFilters(q0, leagues);

  // Markets (dedup, first-match-wins order handles over/team families). Detect
  // against `qm`, a copy with odds phrases blanked out, so an odds number that
  // happens to be a goal line ("to win at odds under 1.5") can't trip a goals
  // market ("Under 1.5 Goals"). Odds/scope/day parsing below still use `q`.
  const CMP = "(?:of\\s*)?(?:over|under|above|below|up to|from|at least|at most|greater than|less than|more than|higher than|lower than|no less than|no more than|of at least|of at most|=|>=|<=|>|<|≥|≤)*";
  const qm = q
    .replace(new RegExp(`\\b(?:odds?|price)\\s*${CMP}\\s*\\d+(?:\\.\\d+)?\\s*\\+?`, "g"), " odds ")
    .replace(/\d+\.\d+\s*\+?\s*(?:odds?|price)\b/g, " odds "); // decimals only: "score 2+ odds…" keeps its 2+
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
  else if (["safe", "safest", "strong", "strongest"].some((w) => hasPhrase(q, w))) minProb = 65;
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
  // Day(s) the query is about — a LIST of tokens the /ask route resolves to
  // concrete date(s) in the caller's timezone and unions: "today" | "tomorrow" |
  // "weekend" | weekday names. Every one mentioned counts, so "Friday and
  // Saturday" scans both days. Empty → today.
  const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const days = [];
  if (hasPhrase(q, "today") || hasPhrase(q, "tonight")) days.push("today");
  if (hasPhrase(q, "tomorrow")) days.push("tomorrow");
  if (hasPhrase(q, "weekend")) days.push("weekend");
  for (const day of DAY_NAMES) if (hasPhrase(q, day)) days.push(day);
  const uniqDays = [...new Set(days)];
  if (!uniqDays.length) uniqDays.push("today");
  const date = uniqDays[0]; // back-compat: primary day

  // How many picks to return: "5 games", "three picks", "top 5", "best 10".
  // Null = everything that qualifies. "top 5 leagues" is the SCOPE, not a count,
  // and numbers glued to goals/odds/% ("2+", "2.5", "60%") are never a count.
  const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
  const CNT = `(\\d{1,2}|${Object.keys(WORD_NUM).join("|")})`;
  const UNIT = "(?:games?|matches|match|fixtures?|picks?|teams?|selections?|bets?|tips?|options?)";
  let limit = null;
  const lm = q.match(new RegExp(`\\b${CNT}\\s+(?:(?:best|top|strongest|safest|likeliest)\\s+)?${UNIT}\\b`))
    || q.match(new RegExp(`\\b(?:top|best|strongest|safest|only|just)\\s+${CNT}\\b(?!\\s*(?:leagues?|\\+|%|\\.\\d|goals?))`));
  if (lm) {
    const v = WORD_NUM[lm[1]] ?? Number(lm[1]);
    if (v >= 1 && v <= 60) limit = v;
  }

  return { markets, scope, leagueId, leagueName, minProb, oddsMin, oddsMax, within, date, days: uniqDays, limit, include, exclude };
}

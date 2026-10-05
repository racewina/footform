// Claude as the Telegram bot's LANGUAGE layer — never its tipster.
//
//   understand()  free-form message (+ the last results as context) → a structured
//                 intent the bot executes with its OWN engine (runAsk / slips).
//   explain()     a follow-up about specific matches, answered ONLY from the model
//                 numbers we pass in (probabilities, form, goals, xG, book odds).
//
// Picks, probabilities and odds always come from our model + API-Football; Claude
// only fills in a validated form or narrates numbers it was given. Off entirely
// unless ANTHROPIC_API_KEY is set — the rule-based bot works without it.

import Anthropic from "@anthropic-ai/sdk";

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
const model = () => process.env.TELEGRAM_AI_MODEL || "claude-opus-5-5";

let client = null;
const ai = () => (client ||= new Anthropic({ timeout: 60 * 1000, maxRetries: 1 })); // key: ANTHROPIC_API_KEY

// Per-model request features. Server-side refusal fallback ("default" routing) and
// the effort knob aren't accepted by every model, so only send them where they are.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);
const supportsEffort = (m) => !/haiku-4-5|sonnet-4-5/.test(m);

// Best-effort runaway guard (per serverless instance, per day).
const DAILY_LIMIT = Number(process.env.TELEGRAM_AI_DAILY_LIMIT || 200);
let budgetDay = "", used = 0;
function spend() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) { budgetDay = today; used = 0; }
  if (used >= DAILY_LIMIT) throw new Error(`AI daily limit reached (${DAILY_LIMIT}) — the menu and typed searches still work`);
  used++;
}

async function call({ system, user, effort, schema = null }) {
  spend();
  const m = model();
  const req = {
    model: m,
    max_tokens: 16000,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  };
  const outputConfig = {};
  if (supportsEffort(m)) outputConfig.effort = effort;
  if (schema) outputConfig.format = { type: "json_schema", schema };
  if (Object.keys(outputConfig).length) req.output_config = outputConfig;

  const res = FALLBACK_MODELS.has(m)
    ? await ai().beta.messages.create({ ...req, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
    : await ai().messages.create(req);

  console.log(`[ai] ${res.model} in=${res.usage?.input_tokens} cached=${res.usage?.cache_read_input_tokens || 0} out=${res.usage?.output_tokens} stop=${res.stop_reason}`);
  if (res.stop_reason === "refusal") throw new Error("the AI declined that one — try rephrasing, or use the menu");
  if (res.stop_reason === "max_tokens") throw new Error("the AI's answer was cut off — try a shorter question");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error("the AI returned nothing — try again");
  return text;
}

// ---- understand() -------------------------------------------------------------

export const MARKET_KEYS = ["over15", "over25", "over35", "under15", "under25", "under35", "btts", "win", "dc", "team2plus", "team1plus"];
export const REGIONS = ["all", "top-europe", "europe", "south-america", "north-america", "asia", "africa"];
export const DAY_KEYS = ["today", "tomorrow", "weekend", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const INTENTS = ["search", "acca", "save_daily", "explain", "slips", "results", "menu", "chat"];

const SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    markets: { type: "array", items: { type: "string", enum: MARKET_KEYS } },
    region: { type: "string", enum: REGIONS },
    days: { type: "array", items: { type: "string", enum: DAY_KEYS } },
    count: { type: "integer" },
    min_prob: { type: "integer" },
    odds_min: { type: "number" },
    odds_max: { type: "number" },
    only: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
  },
  required: ["markets", "region", "days", "count", "min_prob", "odds_min", "odds_max", "only", "exclude"],
};
const UNDERSTAND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: INTENTS },
    search: { anyOf: [{ type: "null" }, SEARCH_SCHEMA] },
    slip: {
      anyOf: [{ type: "null" }, {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["vip", "safe", "blend", "blend_high", "value", "europe"] },
          day: { type: "string", enum: ["yesterday", "today", "tomorrow"] },
        },
        required: ["kind", "day"],
      }],
    },
    acca: {
      anyOf: [{ type: "null" }, {
        type: "object",
        additionalProperties: false,
        properties: {
          target_odds: { type: "number" },
          max_odds: { type: "number" },
          legs: { type: "integer" },
          max_legs: { type: "integer" },
        },
        required: ["target_odds", "max_odds", "legs", "max_legs"],
      }],
    },
    match_refs: { type: "array", items: { type: "integer" } },
    reply: { type: "string" },
  },
  required: ["intent", "search", "slip", "acca", "match_refs", "reply"],
};

const UNDERSTAND_SYSTEM = `You are the language layer of FootForm, a private Telegram bot for one football bettor. FootForm has its own prediction model (Dixon–Coles + Elo) and live bookmaker odds from API-Football. You never pick matches, quote probabilities or odds, or give tips yourself — you only work out what the user wants, as JSON, and the bot runs it on its own engine.

Do EXACTLY what the user asked — never substitute a different product because it seems close. If no intent below does what they asked, use "chat" and say plainly what you can't do and the nearest thing you can.

Choose exactly one intent:
- "search": list matches for one or more betting markets ("over 2.5 games tomorrow", "5 btts picks"). Fill "search".
- "acca": BUILD an accumulator / slip / multiple / parlay / combo to a target COMBINED price — any request about games whose odds add up / multiply / "amount to" / "come to" a total ("a few games that make 3+ odds", "a 5 odds acca", "4-fold around 10/1", "safe double at evens or better", "slip of 3 games paying 3.0"). Fill "acca" with target_odds (decimal combined odds wanted; fractional 10/1 = 11.0, evens = 2.0; "3+ odds" = 3.0), max_odds (upper bound if they give a range like "3 to 5 odds" → 5.0, else 0) and legs (number of games: "a few" = 3, "a couple"/"double" = 2, "treble" = 3, "4-fold" = 4, not stated = 0 = let the bot pick the count with the best chance) and max_legs (an upper limit: "not more than 4 games", "max 4", "up to 4", "4 games or fewer" → legs 0, max_legs 4; otherwise 0). "Banker(s)"/"very safe"/"sure" legs → search.min_prob 72; "safe" → 65. ALSO fill "search" with the scope: days, region, only/exclude, min_prob, and markets ONLY if they named markets for the legs ("over 2.5 acca" → ["over25"]; otherwise []). Leave count 0 and odds_min/odds_max 0 in "search" — the combined target lives in "acca".
- "save_daily": the user wants a search saved to their daily morning list ("send me this every day", "save that"). Fill "search" with the search to save (if they mean the previous search, rebuild it from the context).
- "explain": a question about matches already shown ("why is #2 in there?", "tell me more about the Tamworth game", "is the first one safe?", "compare 1 and 3"). Put the 1-based numbers of the matches they mean, from the LAST RESULTS list, in "match_refs" (by number, team name or position). If no results are in context, or you can't tell which match, use "chat" and ask them to reply to the results message.
- "slips": ONLY when they name one of the bot's ready-made products — VIP, safe bets/safe accumulators, Blend, value bets, Europe Strongest. A request to build games up to an odds target is "acca", NEVER "slips". Fill "slip": kind vip (VIP slips), safe (safe accumulators), blend (Blend bets: accumulators on real bookmaker prices, 3–10x), blend_high (Blend bets at bigger odds, 10–50x — "big blend", "long shot acca"), value (value bets: book price above the model's fair price), europe (Europe Strongest); day today or tomorrow.
- "results": how a slip did / graded results. Fill "slip" with kind vip, safe, blend, blend_high or europe and day yesterday or today.
- "menu": they want to see what the bot can do.
- "chat": anything else (thanks, small talk, unsupported requests, clarifying questions). Put a short, friendly reply (max 2 sentences) in "reply"; if useful, point them to the menu. Never invent football facts.

"search" fields:
- markets (one or more; ALL must hold for a match to be listed):
  over15 / over25 / over35 = total match goals over 1.5 / 2.5 / 3.5 ("2+ goals in the match" = over15, "3+ goals" = over25, "4+ goals" = over35)
  under15 / under25 / under35 = total match goals under 1.5 / 2.5 / 3.5 ("low scoring", "few goals" = under25)
  btts = both teams to score (GG); win = the favourite to win (1X2, "home win", "away win", "banker win");
  dc = double chance / favourite not to lose; team2plus = a team to score 2+ goals ("brace for a team", "team over 1.5"); team1plus = a team to score.
  Unsupported markets (corners, cards, correct score, handicap, draw no bet, player props): use "chat" and say which markets are supported.
- region: all (default), top-europe (the big five leagues + Champions/Europa/Conference League), europe, south-america, north-america, asia, africa.
- days: any of today, tomorrow, weekend, or weekday names (= the next such day). [] if the user didn't name a day (the bot uses today, rolling on to tomorrow if today has nothing left). "tonight" = today. "this weekend" = weekend.
- count: how many matches they want (e.g. "5 games", "a few" = 5, "a couple" = 2); 0 = all that qualify.
- min_prob: a minimum model probability in % if they say one ("above 70%"). "safe"/"strong"/"likely" = 65, "very safe"/"banker"/"very likely" = 72. 0 = default.
- odds_min / odds_max: decimal bookmaker odds bounds ("odds over 1.5" → odds_min 1.5; "under evens" → odds_max 2.0; "between 1.4 and 1.8"). 0 = no bound. Convert fractional odds to decimal (1/2 → 1.5, evens → 2.0).
- only: things to restrict to — competition names ("Premier League", "La Liga", "Serie A", "Bundesliga", "Ligue 1", "Eredivisie", "Major League Soccer", "Championship", "National League"), countries ("Germany", "England"), "friendlies", "cups", or team names. Use the full official team name a data feed would use ("Manchester United" not "Man Utd", "Tottenham" not "Spurs", "Paris Saint Germain" not "PSG", "Barcelona" not "Barca", "Bayern München" not "Bayern"). For a named league, put it here and keep region "all".
- exclude: same kinds of things to leave out ("no friendlies" → ["friendlies"], "not England" → ["England"]).
If the user refines the previous search ("same but Sunday", "only Germany", "now for BTTS", "make it 10"), rebuild the WHOLE search from the previous one with the change applied.
Always fill every field; use null for "search"/"slip"/"acca" when not used, [] for match_refs when not explaining, "" for reply unless intent is chat.`;

const clampInt = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : 0);
const cleanTerm = (s) => String(s || "").replace(/[^\p{L}\p{N} .'&-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40);

// Validated search → the plain-English query the rule parser reads (the same
// grammar the tap-through builder produces).
// allowNoMarket: for accas the markets are optional (none = any market), so the
// query only carries the scope (days / region / filters / bar).
export function composeQuery(s, { allowNoMarket = false } = {}) {
  if (!s) return "";
  const PHRASE = {
    over15: "over 1.5", over25: "over 2.5", over35: "over 3.5", under15: "under 1.5", under25: "under 2.5",
    under35: "under 3.5", btts: "btts", win: "to win", dc: "double chance", team2plus: "team to score 2+", team1plus: "team to score",
  };
  const REGION = { all: "", "top-europe": "top europe", europe: "europe", "south-america": "south america", "north-america": "north america", asia: "asia", africa: "africa" };
  const markets = [...new Set((s.markets || []).filter((k) => PHRASE[k]))];
  if (!markets.length && !allowNoMarket) return "";
  const days = [...new Set((s.days || []).filter((d) => DAY_KEYS.includes(d)))].map((d) => (d === "weekend" ? "this weekend" : d));
  const count = clampInt(s.count, 0, 60);
  const minProb = clampInt(s.min_prob, 0, 95);
  const oMin = s.odds_min >= 1.01 && s.odds_min <= 1000 ? Number(s.odds_min) : 0;
  const oMax = s.odds_max >= 1.01 && s.odds_max <= 1000 ? Number(s.odds_max) : 0;
  const only = (s.only || []).map(cleanTerm).filter(Boolean).slice(0, 6);
  const exclude = (s.exclude || []).map(cleanTerm).filter(Boolean).slice(0, 6);
  return [
    count ? `${count} games` : "",
    markets.map((k) => PHRASE[k]).join(" and "),
    REGION[s.region] || "",
    (days.length ? days : ["today"]).join(" and "),
    minProb >= 30 ? `above ${minProb}%` : "",
    oMin ? `odds greater than ${oMin}` : "",
    oMax ? `odds less than ${oMax}` : "",
    only.length ? `only ${only.join(" and ")}` : "",
    exclude.length ? `exclude ${exclude.join(" and ")}` : "",
  ].filter(Boolean).join(" ");
}

// ctx: { now: "Wednesday 2026-09-30 (America/Toronto)", lastQuery, lastResults: [lines], repliedTo }
export async function understand(text, ctx = {}) {
  const parts = [`NOW: ${ctx.now}`];
  if (ctx.lastQuery) parts.push(`PREVIOUS SEARCH: ${ctx.lastQuery}`);
  if (ctx.lastResults?.length) parts.push(`LAST RESULTS (numbered):\n${ctx.lastResults.join("\n")}`);
  if (ctx.repliedTo) parts.push(`THE USER IS REPLYING TO THIS BOT MESSAGE:\n${ctx.repliedTo.slice(0, 1500)}`);
  parts.push(`USER MESSAGE: ${text}`);
  const raw = await call({ system: UNDERSTAND_SYSTEM, user: parts.join("\n\n"), effort: "medium", schema: UNDERSTAND_SCHEMA });
  let out;
  try { out = JSON.parse(raw); } catch { throw new Error("couldn't read the AI's answer — try again"); }
  if (!INTENTS.includes(out?.intent)) throw new Error("the AI's answer didn't make sense — try again");
  return {
    intent: out.intent,
    search: out.search && typeof out.search === "object" ? out.search : null,
    slip: out.slip && typeof out.slip === "object" ? out.slip : null,
    acca: out.acca && typeof out.acca === "object" && Number(out.acca.target_odds) > 1 ? out.acca : null,
    matchRefs: Array.isArray(out.match_refs) ? out.match_refs.filter(Number.isInteger) : [],
    reply: typeof out.reply === "string" ? out.reply.slice(0, 600) : "",
  };
}

// ---- explain() ------------------------------------------------------------------

const EXPLAIN_SYSTEM = `You explain FootForm's football predictions to its owner in a Telegram chat. You get the model's own numbers for one or more matches and the user's question. Use ONLY those numbers — never add outside facts (injuries, news, lineups, head-to-head, league tables) and never claim certainty. Field meanings: home/draw/away = model 1X2 win probabilities in %; homeForm/awayForm = last results, most recent last (W/D/L); homeGoalsFor/homeGoalsAgainst/awayGoalsFor/awayGoalsAgainst = recent goals per game; xgHome/xgAway = the model's expected goals for this match; over25/btts = model % for those markets; markets = the selections shown to the user with the model % and best bookmaker odds (null = not priced).
Be blunt and concrete: say what drives the pick (e.g. "both sides average 1.9+ goals a game; model xG 1.96 v 1.42"), the main risk in the numbers, and — when odds are given — compare the model % with the bookmaker's implied % (100 / odds): if the model % is higher, the price is in the user's favour; if lower, it isn't. Plain text, no markdown, at most 120 words per match, no betting advice beyond reading these numbers.`;

export async function explain(question, matches) {
  const data = matches.map((m) => ({
    match: `${m.home} v ${m.away}`, league: m.league, kickoff: m.kickoffLabel,
    markets: Object.values(m.markets || {}).map((l) => ({ selection: l.selection, modelPct: l.prob, bookOdds: l.odds })),
    ...m.model,
  }));
  return call({
    system: EXPLAIN_SYSTEM,
    user: `MATCH DATA:\n${JSON.stringify(data, null, 1)}\n\nQUESTION: ${question}`,
    effort: "medium",
  });
}

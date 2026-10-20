// Interactive layer of the FootForm Telegram bot: a main menu of tasks, a tap-
// through pick builder, today's slips, graded results and the daily list — all
// on inline buttons, plus the shared "run a query and show it" path.
//
// No session store: every button carries its own state in callback_data (≤64
// bytes), e.g. "fp|o25|te|tm" = Find picks › Over 2.5 › Top Europe › Tomorrow.
// Steps EDIT the same message, so a whole flow stays one tidy message.
//
// The builder composes a plain-English query and runs it through runAsk(), so a
// tapped search and a typed one are answered by exactly the same engine — and
// the query is shown, which teaches the typed syntax for free.

import { runAsk, runAcca, toolsPass } from "./fixtures.js";
import { parseQuery, CHAT_MARKETS, CHAT_SCOPES, TOP_EUROPE_IDS, normText } from "../services/chatbot.js";
import { aiEnabled, understand, explain, composeQuery } from "../services/ai.js";
import { LEAGUES } from "../data/leagues.js";
import { BOT_FEATURED, BOT_REGIONS, regionCountries } from "../data/botLeagues.js";
import {
  tg, esc, sendText, sendChunks, editText, keyboard, botTz, pushHours,
  readDailyPin, writeDaily, formatAsk, MAX_DAILY,
} from "../services/telegram.js";

const HOME = ["🏠 Menu", "m"];

// Value bets is switched off (2026-10-13): rebuilt for Oct 6–12 at real bookmaker odds,
// its 1,558 picks won 37.4% vs the 40.2% the prices implied — ROI −9.3%, and bigger
// claimed edges did no better (the "edges" were noise). Flip to re-enable once a model
// shows a real edge at bookmaker prices. The /api/value feed itself is untouched.
const VALUE_BETS_ENABLED = false;
const VALUE_OFF_MSG = "📉 Value bets is switched off. Rebuilt for last week at real bookmaker prices, its picks lost about 9% of stake and the claimed edges didn't hold up — so I won't recommend them. Try 🧮 Build an acca or the slips instead.";
const hoursLabel = () => pushHours().map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");

// ---- Main menu ----------------------------------------------------------------

const menuText = () => [
  "⚽ <b>FootForm</b> — here's what I can do:",
  "<i>Covers ⭐ Europe top 5 (UEFA + top 5 leagues & their 2nd tiers), 🇪🇺 the rest of Europe and 🌎 South America's top flights.</i>",
  "",
  "🔎 <b>Find picks</b> — tap through market › region › day › how many",
  "🧮 <b>Build an acca</b> — pick a target price (3+, 5+, 10+…) and I find the legs with the best chance",
  "🎯 <b>Player props</b> — goalscorer, shots, cards, fouls, tackles, saves: the top 5 players for any market",
  `🎫 <b>Today's slips</b> — VIP, Safe, Blend (3–10x / 10–50x)${VALUE_BETS_ENABLED ? ", Value bets" : ""}, Europe Strongest`,
  "📊 <b>Results</b> — how the slips did (✅/❌ per leg)",
  "🗓 <b>My daily list</b> — searches sent to you every morning",
  aiEnabled()
    ? "💬 <b>Just talk to me</b> — ask anything in your own words, or reply to a result with “why this one?”"
    : "✍️ <b>Ask in my own words</b> — type any question instead",
].join("\n");
const MENU_KB = keyboard([
  [["🔎 Find picks", "fp"], ["🧮 Build an acca", "ac"]],
  [["🎯 Player props", "pp"], ["🎫 Today's slips", "sl"]],
  [["📊 Results", "rs"], ["🗓 My daily list", "dl"]],
  [["✍️ Ask in my own words", "aw"], ["❓ How to ask", "hw"]],
]);

const MENU_RX = /^(?:\/?(?:start|menu)|hi+|hello|hey|yo|hiya|help me|options|commands|tasks|main menu|show menu|show me the menu)[!.?\s]*$/;
const MENU_PHRASES = ["what can you do", "what do you do", "what can i ask", "what can i do", "how does this work", "how do i use", "what are your options", "what are you able"];
export const isMenuIntent = (text) => {
  const t = text.toLowerCase().trim();
  return MENU_RX.test(t) || MENU_PHRASES.some((p) => t.includes(p));
};

export const showMenu = (chatId, messageId = null) =>
  messageId ? editText(chatId, messageId, menuText(), MENU_KB) : sendText(chatId, menuText(), { reply_markup: MENU_KB });

export function helpText() {
  return [
    "✍️ <b>Ask in plain English</b> — I run the prediction model:",
    "• <i>5 games over 2.5 tomorrow exclude friendlies</i>",
    "• <i>europe friday and saturday team to score 2+ odds over 1.46</i>",
    "• <i>top europe over 2.5 and btts this weekend above 60%</i>",
    "• <i>btts saturday only germany and england</i> · <i>without arsenal</i>",
    "• <i>a few games that come to 3+ odds tomorrow</i> · <i>3-leg acca around 5.0, no friendlies</i> (or tap 🧮 Build an acca)",
    "• <i>top 5 goalscorers in the Premier League tomorrow</i> · <i>who's most likely to get booked in Arsenal v Chelsea</i> (or tap 🎯 Player props)",
    "",
    "<b>Markets</b>: over/under 1.5·2.5·3.5, BTTS, to win, double chance, team to score / 2+.",
    "<b>Where</b>: top Europe, a continent, a league or country.",
    "<b>When</b>: today, tomorrow, weekend, weekday names.",
    "<b>How many</b>: “5 games”, “top 10”.",
    "<b>Filters</b>: only / exclude / without + league, country, continent, team, friendlies, cups.",
    "<b>Bar</b>: “above 60%”, “safe”, “very likely”; odds: “odds over 1.5”, “between 1.5 and 2”.",
    "",
    `<b>Daily push</b> at ${esc(hoursLabel())} (${esc(botTz())}): tap 💾 on any result, or /daily <i>query</i>.`,
    "/menu — the task menu · /now — send the daily list now",
  ].join("\n");
}

// ---- Running a query (typed or tapped) --------------------------------------------

const RESULT_KB = keyboard([[["💾 Save as daily", "sv"], ["🔎 New search", "fp"]], [HOME]]);
const NOTE_KB = keyboard([[["🔎 Find picks", "fp"], ["🎯 Player props", "pp"]], [["📋 Menu", "m"]]]);
const FOOTER = "🔎 ";

// Show `chunks` starting by editing `messageId` (the "⏳ …" placeholder); the
// keyboard rides on the last chunk so it sits under the results.
async function deliver(chatId, messageId, chunks, markup) {
  const last = chunks.length - 1;
  const first = await editText(chatId, messageId, chunks[0], last === 0 ? markup : null);
  if (!first) await sendText(chatId, chunks[0], last === 0 && markup ? { reply_markup: markup } : {});
  for (let i = 1; i <= last; i++) await sendText(chatId, chunks[i], i === last && markup ? { reply_markup: markup } : {});
}

// Last results per chat, so "why #2?" / "same but Sunday" have context. In-memory
// (per serverless instance) — a reply to a results message rebuilds it from the
// message's "🔎 query" footer if this instance never saw it.
const memory = new Map();
const MEMORY_MS = 6 * 3600 * 1000;
function remember(chatId, query, result) {
  const entry = { query, at: Date.now(), matches: (result.matches || []).slice(0, 15).map((m) => ({ ...m, kickoffLabel: ko(m.kickoff) })) };
  memory.set(String(chatId), entry);
  if (memory.size > 50) memory.delete(memory.keys().next().value);
  return entry;
}
const recall = (chatId) => {
  const e = memory.get(String(chatId));
  return e && Date.now() - e.at < MEMORY_MS ? e : null;
};

export async function answerQuery(chatId, query, messageId = null, { title = null } = {}) {
  const tz = botTz();
  const id = messageId || (await sendText(chatId, `⏳ Running: <i>${esc(query)}</i>…`))?.message_id;
  if (messageId) await editText(chatId, messageId, `⏳ Running: <i>${esc(query)}</i>…`);
  let result, chunks;
  try {
    result = await runAsk(query, tz, BOT_SCOPE);
    if (!result.note) remember(chatId, query, result);
    chunks = formatAsk(result, tz, result.note ? {} : { footer: `${FOOTER}${query}`, title });
  } catch (e) {
    chunks = [`⚠️ Something went wrong: ${esc(e.message)}`];
  }
  const markup = result?.note ? NOTE_KB : RESULT_KB;
  if (result?.note) chunks[chunks.length - 1] += "\n\nOr tap your way there:";
  if (id) return deliver(chatId, id, chunks, markup);
  return sendChunks(chatId, chunks);
}

// ---- Pick builder -----------------------------------------------------------------

const MARKETS = [
  ["o25", "Over 2.5", "over 2.5"], ["o15", "Over 1.5", "over 1.5"],
  ["o35", "Over 3.5", "over 3.5"], ["u25", "Under 2.5", "under 2.5"],
  ["bt", "BTTS", "btts"], ["ob", "Over 2.5 + BTTS", "over 2.5 and btts"],
  ["w", "To win", "to win"], ["dc", "Double chance", "double chance"],
  ["t2", "Team 2+ goals", "team to score 2+"], ["t1", "Team to score", "team to score"],
];
// ---- Featured leagues: region › country (see data/botLeagues.js) --------------------
// The bot only covers ⭐ Europe top 5, 🇪🇺 Europe (other countries) and 🌎 South
// America's top flights. A region pick turns into a parser scope phrase, a country
// pick into an "only <country>" clause — so taps, typed queries and saved dailies all
// run the same text, and BOT_SCOPE keeps every scan inside the featured leagues.
const BOT_SCOPE = { allow: BOT_FEATURED };
const regionOf = (code) => BOT_REGIONS.find((r) => r.code === code);
function regionParts(rg, ct) { // → { scope, only, label } or null if stale
  if (rg === "all") return { scope: "", only: "", label: "🌍 All featured" };
  const r = regionOf(rg);
  if (!r) return null;
  if (ct === "*") return { scope: r.phrase, only: "", label: r.label };
  const c = regionCountries(rg)[Number(ct)];
  return c ? { scope: r.phrase, only: c.phrase, label: `${r.label} › ${c.flag} ${c.name}` } : null;
}
const validRegion = (rg, ct) => !rg || rg === "all" || (regionOf(rg) && (!ct || regionParts(rg, ct)));
const regionRows = (to) => [[["🌍 All featured", to("all", "-")]], ...grid(BOT_REGIONS.map((r) => [r.label, to(r.code)]), 3)];
const countryRows = (rg, to) => [[[`All of ${regionOf(rg).label}`, to("*")]], ...grid(regionCountries(rg).map((c, i) => [`${c.flag} ${c.name}`, to(String(i))]), 2)];

const DAYS = [["td", "Today", "today"], ["tm", "Tomorrow", "tomorrow"], ["we", "This weekend", "this weekend"]];
const COUNTS = [["5", "Top 5"], ["10", "Top 10"], ["0", "All"]];
const find = (list, code) => list.find((x) => x[0] === code);
const grid = (buttons, per) => buttons.reduce((rows, b, i) => (i % per ? rows[rows.length - 1].push(b) : rows.push([b]), rows), []);

// Home / Away step — only for markets that have a side (to win, double chance,
// team to score 1+/2+). Totals and BTTS skip it ("e" = either).
const SIDES = [["h", "🏠 Home", "home"], ["a", "✈️ Away", "away"], ["e", "Either side", ""]];
const SIDE_MK = new Set(["w", "dc", "t2", "t1"]);

export function builderQuery(mk, sd, rg, ct, dy, n, x) {
  const r = regionParts(rg, ct) || { scope: "", only: "" };
  return [
    n && n !== "0" ? `${n} games` : "",
    find(SIDES, sd)?.[2], find(MARKETS, mk)?.[2], r.scope, find(DAYS, dy)?.[2], r.only,
    x === "1" ? "exclude friendlies" : "",
  ].filter(Boolean).join(" ");
}

async function builder(chatId, messageId, parts) {
  const [mk, sd, rg, ct, dy, n, x] = parts;
  if ((mk && !find(MARKETS, mk)) || (sd && !find(SIDES, sd)) || !validRegion(rg, ct) || (dy && !find(DAYS, dy)) || (n && !find(COUNTS, n))) {
    return showMenu(chatId, messageId); // stale/garbled button
  }
  const sideLabel = sd && sd !== "e" ? find(SIDES, sd)[1] : null;
  const crumbs = [find(MARKETS, mk)?.[1], sideLabel, ct ? regionParts(rg, ct)?.label : regionOf(rg)?.label, find(DAYS, dy)?.[1], find(COUNTS, n)?.[1]].filter(Boolean);
  const head = `🔎 <b>Find picks</b>${crumbs.length ? `\n${esc(crumbs.join(" › "))}` : ""}\n\n`;
  const at = (...p) => ["fp", ...p].join("|");
  // Back skips steps that were never shown: the side step for totals/BTTS, and the
  // country step after "All featured".
  const prev = parts.slice(0, -1);
  if (prev.length === 1 && !SIDE_MK.has(prev[0])) prev.length = 0;
  if (prev.length === 3 && prev[2] === "all") prev.length = 2;
  const nav = [["⬅️ Back", parts.length ? at(...prev) : "m"], HOME];

  if (!mk) {
    return editText(chatId, messageId, `${head}Which market?`,
      keyboard([...grid(MARKETS.map(([c, l]) => [l, SIDE_MK.has(c) ? at(c) : at(c, "e")]), 2), [HOME]]));
  }
  if (!sd) return editText(chatId, messageId, `${head}Home or away team?`, keyboard([SIDES.map(([c, l]) => [l, at(mk, c)]), nav]));
  if (!rg) return editText(chatId, messageId, `${head}Which region?`, keyboard([...regionRows((...p) => at(mk, sd, ...p)), nav]));
  if (!ct) return editText(chatId, messageId, `${head}Which country?`, keyboard([...countryRows(rg, (c) => at(mk, sd, rg, c)), nav]));
  if (!dy) return editText(chatId, messageId, `${head}Which day?`, keyboard([DAYS.map(([c, l]) => [l, at(mk, sd, rg, ct, c)]), nav]));
  if (!n) return editText(chatId, messageId, `${head}How many matches?`, keyboard([COUNTS.map(([c, l]) => [l, at(mk, sd, rg, ct, dy, c)]), nav]));
  if (x == null) {
    return editText(chatId, messageId, `${head}Exclude friendlies?`, keyboard([
      [["🚫 Exclude friendlies", at(mk, sd, rg, ct, dy, n, "1")], ["Keep them", at(mk, sd, rg, ct, dy, n, "0")]], nav,
    ]));
  }
  return answerQuery(chatId, builderQuery(mk, sd, rg, ct, dy, n, x), messageId);
}

// ---- Slips + results (read from the app's own API, which is edge-cached) ----------

const apiBase = () =>
  process.env.TELEGRAM_INTERNAL_BASE
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${process.env.PORT || 3001}`);

// `gated` feeds (Blend) get the tools code as a header, server-side only — the bot
// is locked to TELEGRAM_ALLOWED_CHAT_IDS, and app.js marks code-carrying requests
// private/no-store so these responses never land in the shared CDN cache.
async function apiGet(path, { gated = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 240 * 1000);
  try {
    const res = await fetch(`${apiBase()}/api${path}`, { signal: ctrl.signal, headers: gated ? { "x-odds-pass": toolsPass() } : {} });
    if (!res.ok) throw new Error(`the ${path.split("?")[0]} feed returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const ymd = (addDays) => new Intl.DateTimeFormat("en-CA", { timeZone: botTz(), year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(Date.now() + addDays * 86400000));
const DAY_OFFSET = { y: -1, t: 0, tm: 1 };
const DAY_LABEL = { y: "yesterday", t: "today", tm: "tomorrow" };

const ko = (ts) => (ts ? new Intl.DateTimeFormat("en-US", { timeZone: botTz(), weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(ts * 1000)) : "");
const mark = (hit, graded) => (!graded ? "•" : hit === true ? "✅" : hit === false ? "❌" : "⏳");
const at2 = (o) => (o != null ? ` @${Number(o).toFixed(2)}` : "");
const pct = (p) => (p == null ? "" : ` ${Math.round(p <= 1 ? p * 100 : p)}%`);
const scoreOf = (l) => (l && l.homeScore != null && l.awayScore != null ? ` <b>${l.homeScore}-${l.awayScore}</b>` : "");
const matchLine = (x) => `${esc(x.home)} v ${esc(x.away)} · ${x.leagueFlag || ""} ${esc(x.league || "")} · ${ko(x.kickoff)}`;

function chunkLines(head, lines, tail = "") {
  const out = [];
  let cur = head;
  for (const ln of lines) {
    if (cur.length + ln.length + 2 > 3800) { out.push(cur); cur = ln; } else cur += `\n\n${ln}`;
  }
  out.push(cur + tail);
  return out;
}

function fmtVip(d, graded, dayLabel) {
  const seen = new Set();
  const slips = [...(d.featured || []), ...(d.slips || []), ...(d.southAmerica || [])].filter((s) => !seen.has(s.matchId) && seen.add(s.matchId));
  const head = `👑 <b>VIP slips</b> · ${dayLabel}`;
  if (!slips.length) return [`${head}\n\nNo VIP slips for ${dayLabel}.`];
  const done = slips.filter((s) => s.won != null);
  const tally = graded && done.length ? `\n${done.filter((s) => s.won).length}/${done.length} slips won` : "";
  const lines = slips.map((s, i) => {
    const res = graded && s.won != null ? (s.won ? " — ✅ WON" : ` — ❌ ${s.legHits ?? 0}/${s.legCount}`) : "";
    const legs = (s.legs || []).map((l) => `   ${mark(l.hit, graded)} ${esc(l.selection)}${pct(l.probability)}${at2(l.odds)}`).join("\n");
    return `${i + 1}. <b>${esc(s.home)} v ${esc(s.away)}</b>${graded ? scoreOf(s.legs?.[0]) : ""}\n   ${s.leagueFlag || ""} ${esc(s.league)} · ${ko(s.kickoff)} · <i>${esc(s.lean || "")}</i>\n${legs}\n   Combined${at2(s.combinedOdds)}${res}`;
  });
  return chunkLines(`${head}${tally}`, lines);
}

function fmtSafe(d, graded, dayLabel) {
  const slips = d.slips || [];
  const head = `🛡 <b>Safe accumulators</b> · ${dayLabel}`;
  if (!slips.length) return [`${head}\n\nNo safe accumulators for ${dayLabel}.`];
  const lines = slips.map((s, i) => {
    const res = graded && s.won != null ? (s.won ? " — ✅ WON" : ` — ❌ ${s.legHits ?? 0}/${s.legCount}`) : "";
    const target = s.target ? ` (target ${s.target.lo}–${s.target.hi}x)` : "";
    const legs = (s.legs || []).map((l) => `   ${mark(l.hit, graded)} ${esc(l.selection)}${pct(l.probability ?? l.prob)}${at2(l.odds)}\n      ${matchLine(l)}${graded ? scoreOf(l) : ""}`).join("\n");
    return `<b>Slip ${i + 1}</b>${target} · combined${at2(s.combinedOdds)} ·${pct(s.combinedProbability)}${res}\n${legs}`;
  });
  return chunkLines(head, lines);
}

function fmtValue(d, dayLabel) {
  const bets = (d.bets || []).slice(0, 15);
  const head = `💎 <b>Value bets</b> · ${dayLabel}\n<i>book price above the model's fair price</i>`;
  if (!bets.length) return [`${head}\n\nNo value bets for ${dayLabel}.`];
  const lines = bets.map((b, i) =>
    `${i + 1}. <b>${esc(b.selection)}</b>${at2(b.bookOdds)} (fair${at2(b.fairOdds)}${b.edgePct != null ? `, +${b.edgePct}% edge` : ""}) · model ${b.modelProb}%\n   ${matchLine(b)}`);
  const more = d.bets.length > bets.length ? `\n\n…${d.bets.length - bets.length} more in the app.` : "";
  return chunkLines(head, lines, more);
}

const EU_CATS = [["win", "🏆 To win"], ["dc", "🛡 Double chance"], ["over25", "⚽ Over 2.5"], ["btts", "🔁 BTTS"], ["team2plus", "🎯 Team 2+ goals"]];
function fmtEurope(d, graded, dayLabel) {
  const cats = d.categories || {};
  const head = `🇪🇺 <b>Europe Strongest</b> · ${dayLabel}${d.minOdds ? ` · odds ≥${d.minOdds}` : ""}`;
  const blocks = EU_CATS.filter(([k]) => cats[k]?.length).map(([k, label]) =>
    `<b>${label}</b>\n${cats[k].map((p) => `${mark(p.hit, graded)} ${esc(p.selection)}${pct(p.probability)}${at2(p.odds)}\n   ${matchLine(p)}${graded ? scoreOf(p) : ""}`).join("\n")}`);
  if (!blocks.length) return [`${head}\n\nNo Europe Strongest picks for ${dayLabel}.`];
  return chunkLines(head, blocks);
}

function fmtBlend(d, graded, dayLabel, title) {
  const slips = (d.slips || []).filter((x) => x.legCount > 0);
  const head = `${title} · ${dayLabel}\n<i>real bookmaker prices · model probability</i>`;
  if (!slips.length) return [`${head}\n\nNo Blend slips for ${dayLabel} — not enough priced legs left.`];
  const lines = slips.map((s, i) => {
    const res = graded && s.won != null ? (s.won ? " — ✅ WON" : ` — ❌ ${s.legHits ?? 0}/${s.legCount}`) : "";
    const target = s.target ? ` (target ${s.target.lo}–${s.target.hi}x)` : "";
    const legs = (s.legs || []).map((l) => `   ${mark(l.hit, graded)} ${esc(l.selection)}${pct(l.probability)}${at2(l.bookOdds ?? l.odds)}${l.bookmaker ? ` ${esc(l.bookmaker)}` : ""}\n      ${matchLine(l)}${graded ? scoreOf(l) : ""}`).join("\n");
    return `<b>Slip ${i + 1}</b>${target} · book${at2(s.combinedBookOdds)} (fair${at2(s.combinedFairOdds)}) ·${pct(s.combinedProbability)}${res}\n${legs}`;
  });
  return chunkLines(head, lines);
}

// code → label, live path, results path (null = not graded), formatter, extra
// query, and whether the feed is behind the tools code.
const ALL_SLIPS = [
  { code: "vip", label: "👑 VIP slips", live: "/vip", results: "/vip/results", fmt: fmtVip },
  { code: "sf", label: "🛡 Safe accumulators", live: "/accumulators", results: "/accumulators/results", fmt: fmtSafe },
  { code: "bb", label: "🧪 Blend 3–10x", live: "/blend-bets", results: "/blend-bets/results", gated: true,
    fmt: (d, g, lbl) => fmtBlend(d, g, lbl, "🧪 <b>Blend bets</b> 3–10x") },
  { code: "bh", label: "🚀 Blend 10–50x", live: "/blend-bets", results: "/blend-bets/results", gated: true, extra: "&band=high",
    fmt: (d, g, lbl) => fmtBlend(d, g, lbl, "🚀 <b>Blend bets</b> 10–50x") },
  { code: "vb", label: "💎 Value bets", live: "/value", results: null, fmt: (d, _g, lbl) => fmtValue(d, lbl) },
  { code: "eu", label: "🇪🇺 Europe Strongest", live: "/europe-strongest", results: "/europe-strongest", resultsExtra: "&includeFinished=1", fmt: fmtEurope },
];
const SLIPS = ALL_SLIPS.filter((x) => x.code !== "vb" || VALUE_BETS_ENABLED);
const BACK_TO = (code) => ["⬅️ Back", code];
const feedQuery = (day, extra = "") => `?date=${ymd(DAY_OFFSET[day])}&tz=${encodeURIComponent(botTz())}${extra}`;

export async function slipsFlow(chatId, messageId, [kind, day], { title = null } = {}) {
  if (!kind) {
    return editText(chatId, messageId, "🎫 <b>Today's slips</b> — which one?",
      keyboard([...grid(SLIPS.map((x) => [x.label, `sl|${x.code}`]), 2), [BACK_TO("m"), HOME]]));
  }
  const slip = SLIPS.find((x) => x.code === kind);
  if (!slip) return showMenu(chatId, messageId);
  if (!day) {
    return editText(chatId, messageId, `${slip.label} — which day?`,
      keyboard([[["Today", `sl|${kind}|t`], ["Tomorrow", `sl|${kind}|tm`]], [BACK_TO("sl"), HOME]]));
  }
  if (!(day in DAY_OFFSET)) return showMenu(chatId, messageId);
  const label = DAY_LABEL[day];
  await editText(chatId, messageId, `⏳ Loading ${slip.label} for ${label}… (a cold day can take a minute or two)`);
  let chunks;
  try {
    const d = await apiGet(`${slip.live}${feedQuery(day, slip.extra)}`, { gated: slip.gated });
    chunks = slip.fmt(d, false, label);
    if (title) chunks[0] = `${title}\n${chunks[0]}`;
  } catch (e) {
    chunks = [`⚠️ Couldn't load ${slip.label}: ${esc(e.message)}`];
  }
  return deliver(chatId, messageId, chunks, keyboard([[["🎫 Other slips", "sl"], HOME]]));
}

const RESULT_SLIPS = SLIPS.filter((x) => x.results);
export async function resultsFlow(chatId, messageId, [kind, day], { title = null } = {}) {
  if (!kind) {
    return editText(chatId, messageId, "📊 <b>Results</b> — which slips?",
      keyboard([...grid(RESULT_SLIPS.map((x) => [x.label, `rs|${x.code}`]), 2), [BACK_TO("m"), HOME]]));
  }
  const slip = RESULT_SLIPS.find((x) => x.code === kind);
  if (!slip) return showMenu(chatId, messageId);
  if (!day) {
    return editText(chatId, messageId, `📊 ${slip.label} — which day?`,
      keyboard([[["Yesterday", `rs|${kind}|y`], ["Today so far", `rs|${kind}|t`]], [BACK_TO("rs"), HOME]]));
  }
  if (!(day in DAY_OFFSET)) return showMenu(chatId, messageId);
  const label = DAY_LABEL[day];
  await editText(chatId, messageId, `⏳ Grading ${slip.label} for ${label}…`);
  let chunks;
  try {
    const d = await apiGet(`${slip.results}${feedQuery(day, `${slip.extra || ""}${slip.resultsExtra || ""}`)}`, { gated: slip.gated });
    chunks = slip.fmt(d, true, label);
    if (title) chunks[0] = `${title}\n${chunks[0]}`;
  } catch (e) {
    chunks = [`⚠️ Couldn't load results: ${esc(e.message)}`];
  }
  return deliver(chatId, messageId, chunks, keyboard([[["📊 Other results", "rs"], HOME]]));
}

// ---- Custom accumulators -----------------------------------------------------------

const fmtOdds = (x) => Number(x).toFixed(2);
function formatAcca(r, title = null) {
  const spec = r.spec || {};
  const target = `${fmtOdds(spec.target)}${spec.max ? `–${fmtOdds(spec.max)}` : "+"}`;
  const legsTxt = spec.legs ? `${spec.legs} legs` : spec.maxLegs ? `best chance, max ${spec.maxLegs} legs` : "best chance";
  const bar = spec.minProb > 55 ? ` · legs ${spec.minProb}%+` : "";
  const side = spec.side ? ` · ${spec.side === "home" ? "🏠 home" : "✈️ away"} teams` : "";
  const f = r.filters || {};
  const lines = [
    ...(title ? [title] : []),
    `🧮 <b>Acca to ${target}</b> · ${esc(r.date)} · ${legsTxt}${bar}${side}`,
    `<i>${esc(spec.markets?.length ? spec.markets.join(" + ") : "any market")} · one leg per match · real bookmaker prices</i>`,
    ...(f.include?.length ? [`Only: ${esc(f.include.join(", "))}`] : []),
    ...(f.exclude?.length ? [`Excluding: ${esc(f.exclude.join(", "))}`] : []),
    ...(r.filterNotes || []).map((n) => `⚠️ ${esc(n)}`),
  ];
  if (!r.slips?.length) return [`${lines.join("\n")}\n\n${esc(r.note || "Couldn't build that one.")}`];
  const blocks = r.slips.map((sl, i) => {
    const legs = sl.legs.map((l) => `   • ${esc(l.selection)} <b>${l.probability}%</b> @${fmtOdds(l.bookOdds)}${l.bookmaker ? ` ${esc(l.bookmaker)}` : ""}\n      ${matchLine(l)}`).join("\n");
    return `<b>${i ? "Alternative" : "Best chance"}</b> · <b>@${fmtOdds(sl.combinedBookOdds)}</b> · model: ${Math.round(sl.combinedProbability)}% all legs win\n${legs}`;
  });
  return chunkLines(lines.join("\n"), blocks);
}

// Acca legs as match entries, so "why is #2 in there?" can be explained afterwards.
const accaAsMatches = (r) => (r.slips || []).flatMap((sl) => sl.legs).map((l) => ({
  ...l, markets: { leg: { selection: l.selection, prob: l.probability, odds: l.bookOdds } },
}));

// rollToTomorrow: the user named no day — if today has nothing left to build from
// (late evening), build tomorrow's instead and say so.
export async function answerAcca(chatId, query, acca, messageId = null, { title = null, rollToTomorrow = false } = {}) {
  const label = `acca to ${acca.target}${acca.max ? `–${acca.max}` : "+"}${acca.legs ? ` · ${acca.legs} legs` : ""}${query ? ` · ${query}` : ""}`;
  const id = messageId || (await sendText(chatId, `⏳ Building: <i>${esc(label)}</i>…`))?.message_id;
  if (messageId) await editText(chatId, messageId, `⏳ Building: <i>${esc(label)}</i>…`);
  let chunks;
  try {
    let r = await runAcca(query, acca, botTz(), BOT_SCOPE);
    if (!r.slips?.length && rollToTomorrow && /\btoday\b/.test(query)) {
      const r2 = await runAcca(query.replace(/\btoday\b/, "tomorrow"), acca, botTz(), BOT_SCOPE);
      if (r2.slips?.length) {
        r = r2;
        title = `${title ? `${title}\n` : ""}🌙 <i>Nothing left to build from today — here's tomorrow.</i>`;
      }
    }
    if (r.slips?.length) remember(chatId, label, { matches: accaAsMatches(r) });
    chunks = formatAcca(r, title);
  } catch (e) {
    chunks = [`⚠️ Couldn't build that acca: ${esc(e.message)}`];
  }
  const markup = keyboard([[["🧮 New acca", "ac"], HOME]]);
  return id ? deliver(chatId, id, chunks, markup) : sendChunks(chatId, chunks);
}

const ACCA_TARGETS = [["2", "2.0+"], ["3", "3.0+"], ["5", "5.0+"], ["10", "10+"], ["20", "20+"]];
const ACCA_LEGS = [["0", "🎯 Best chance"], ["2", "2 legs"], ["3", "3 legs"], ["4", "4 legs"], ["5", "5 legs"]];

const ACCA_SIDES = [["h", "🏠 Home teams", "home teams"], ["a", "✈️ Away teams", "away teams"], ["e", "Any", ""]];

async function accaFlow(chatId, messageId, parts) {
  const [tg_, sd, rg, ct, dy, lg] = parts;
  if ((tg_ && !find(ACCA_TARGETS, tg_)) || (sd && !find(ACCA_SIDES, sd)) || !validRegion(rg, ct) || (dy && !find(DAYS, dy)) || (lg && !find(ACCA_LEGS, lg))) return showMenu(chatId, messageId);
  const crumbs = [tg_ && `target ${find(ACCA_TARGETS, tg_)[1]}`, sd && sd !== "e" ? find(ACCA_SIDES, sd)[1] : null, ct ? regionParts(rg, ct)?.label : regionOf(rg)?.label, find(DAYS, dy)?.[1], find(ACCA_LEGS, lg)?.[1]].filter(Boolean);
  const head = `🧮 <b>Build an acca</b>${crumbs.length ? `\n${esc(crumbs.join(" › "))}` : ""}\n\n`;
  const at = (...p) => ["ac", ...p].join("|");
  const prev = parts.slice(0, -1);
  if (prev.length === 3 && prev[2] === "all") prev.length = 2;
  const nav = [["⬅️ Back", parts.length ? at(...prev) : "m"], HOME];
  if (!tg_) return editText(chatId, messageId, `${head}What combined odds are you after?`, keyboard([ACCA_TARGETS.map(([c, l]) => [l, at(c)]), [HOME]]));
  if (!sd) {
    return editText(chatId, messageId, `${head}Legs on home teams, away teams, or any?\n<i>Home/away picks use to win, double chance and team-to-score legs.</i>`,
      keyboard([ACCA_SIDES.map(([c, l]) => [l, at(tg_, c)]), nav]));
  }
  if (!rg) return editText(chatId, messageId, `${head}Which region?`, keyboard([...regionRows((...p) => at(tg_, sd, ...p)), nav]));
  if (!ct) return editText(chatId, messageId, `${head}Which country?`, keyboard([...countryRows(rg, (c) => at(tg_, sd, rg, c)), nav]));
  if (!dy) return editText(chatId, messageId, `${head}Which day?`, keyboard([DAYS.map(([c, l]) => [l, at(tg_, sd, rg, ct, c)]), nav]));
  if (lg == null) {
    return editText(chatId, messageId, `${head}How many legs? “Best chance” lets me pick the count with the highest chance of landing.`,
      keyboard([...grid(ACCA_LEGS.map(([c, l]) => [l, at(tg_, sd, rg, ct, dy, c)]), 3), nav]));
  }
  const r = regionParts(rg, ct);
  const scopeQ = [find(ACCA_SIDES, sd)[2], r.scope, find(DAYS, dy)[2], r.only].filter(Boolean).join(" ");
  return answerAcca(chatId, scopeQ, { target: Number(tg_), max: 0, legs: Number(lg) }, messageId);
}

// ---- Player props -----------------------------------------------------------------
//
// Market › tier (1+/2+/3+) › day › league (or ⭐ Top Europe) → the TOP 5 players by
// the model's probability, read from the app's own Props Finder feed (each player's
// club-season per-90 rates × expected minutes, opponent-aware for shots/fouls/saves).
// The feed only builds props for a chosen league/match (each match's squad stats are
// costly), so the flow always narrows to one before ranking.

// [code, button label, tiers key in the feed, tiers offered, short name]
const PROP_MARKETS = [
  ["g", "⚽ Goalscorer", "score", [1, 2], "to score"],
  ["ga", "🅰️ Score or assist", "scoreOrAssist", [1, 2], "goal or assist"],
  ["st", "🎯 Shots on target", "shotOnTarget", [1, 2, 3], "shots on target"],
  ["sh", "👟 Shots", "shots", [1, 2, 3], "shots"],
  ["yc", "🟨 Yellow card", "yellow", [1], "booked"],
  ["fc", "🦵 Fouls committed", "foul", [1, 2, 3], "fouls committed"],
  ["fd", "🤕 Fouled", "fouled", [1, 2, 3], "fouls drawn"],
  ["tk", "🛡 Tackles", "tackle", [1, 2, 3], "tackles"],
  ["sv", "🧤 GK saves", "saves", [1, 2, 3], "saves"],
];
export const PROP_MARKET_KEYS = PROP_MARKETS.map((x) => x[2]);
const PROP_DAYS = [["td", "Today", 0], ["tm", "Tomorrow", 1]];
const POS_NAME = { G: "GK", D: "DEF", M: "MID", F: "FWD" };
const LEAGUES_PER_PAGE = 10;

const propLabel = (pm, tier) => (pm[3].length > 1 ? `${pm[1]} ${tier}+` : pm[1]);

// The day's featured leagues/matches that have player data.
async function propsLeagues(dayCode) {
  const d = await apiGet(`/props-finder?date=${ymd(find(PROP_DAYS, dayCode)[2])}&tz=${encodeURIComponent(botTz())}`);
  const leagues = (d.leagues || []).filter((l) => BOT_FEATURED.has(String(l.id)));
  const matches = (d.matches || []).filter((m) => BOT_FEATURED.has(String(m.leagueId)));
  const count = (ids) => matches.filter((m) => ids.includes(String(m.leagueId))).length;
  return { leagues, matches, count };
}
const PROPS_ALL_MAX = 15; // "All of <region>" only when it's this many matches or fewer (cold props are slow)

// Rank one league (or several, or one match) and format the top 5.
export async function answerProps(chatId, messageId, { mk, tier, dayCode, leagueIds = [], matchId = null, title = null, scopeLabel = null, back = null }) {
  const pm = find(PROP_MARKETS, mk);
  const day = find(PROP_DAYS, dayCode);
  const dayLabel = day[1].toLowerCase();
  const label = propLabel(pm, tier);
  await editText(chatId, messageId, `⏳ Ranking players for ${esc(label)} · ${dayLabel}… (a cold league takes ~10–40s)`);
  let chunks;
  try {
    const date = ymd(day[2]);
    const qs = (extra) => `/props-finder?date=${date}&tz=${encodeURIComponent(botTz())}&${extra}`;
    const feeds = matchId ? [await apiGet(qs(`match=${matchId}`))] : [];
    for (const id of leagueIds) feeds.push(await apiGet(qs(`league=${id}`)));
    const players = feeds.flatMap((f) => f.players || []);
    const scope = matchId
      ? (() => { const m = players[0]; return m ? `${m.home} v ${m.away}` : "that match"; })()
      : scopeLabel || players[0]?.league || "that league";
    const ranked = players
      .map((p) => ({ ...p, prob: p.tiers?.[pm[2]]?.[tier] ?? 0 }))
      .filter((p) => p.prob > 0)
      .sort((a, b) => b.prob - a.prob);
    const top = ranked.slice(0, 5);
    const head = `${title ? `${title}\n` : ""}<b>${esc(label)}</b> · ${esc(scope)} · ${dayLabel}\n<i>Top ${top.length} of ${ranked.length} players · model chance</i>`;
    if (!top.length) {
      chunks = [`${head}\n\nNo player data for that ${matchId ? "match" : "league"} ${dayLabel} — props need upcoming fixtures with squad stats.`];
    } else {
      // Player's team first, then the real fixture (home v away) — never reversed.
      const lines = top.map((p, i) =>
        `${i + 1}. <b>${esc(p.name)}</b>${p.pos ? ` (${POS_NAME[p.pos] || POS_NAME[String(p.pos)[0].toUpperCase()] || esc(p.pos)})` : ""} — <b>${p.prob}%</b>\n   ${esc(p.team)} · ${esc(p.home)} v ${esc(p.away)} · ${p.leagueFlag || ""} ${esc(p.league)} · ${ko(p.kickoff)}`);
      chunks = chunkLines(head, lines, "\n\n<i>From club-season rates × expected minutes — lineups aren't confirmed, so check they start.</i>");
    }
  } catch (e) {
    chunks = [`⚠️ Couldn't load player props: ${esc(e.message)}`];
  }
  return deliver(chatId, messageId, chunks, keyboard([[["🌍 Another country", back || `pp|${mk}|${tier}|${dayCode}`], ["🎯 Another market", "pp"]], [HOME]]));
}

async function propsFlow(chatId, messageId, parts) {
  const [mk, tierRaw, dayCode, rg, ct] = parts;
  const pm = mk && find(PROP_MARKETS, mk);
  if (mk && !pm) return showMenu(chatId, messageId);
  const at = (...p) => ["pp", ...p].join("|");
  // Single-tier markets skip the tier step.
  const tier = tierRaw ? Number(tierRaw) : pm && pm[3].length === 1 ? pm[3][0] : null;
  if (tier && pm && !pm[3].includes(tier)) return showMenu(chatId, messageId);
  if (dayCode && !find(PROP_DAYS, dayCode)) return showMenu(chatId, messageId);
  if (rg && !regionOf(rg)) return showMenu(chatId, messageId);
  const crumbs = [pm?.[1], tier && pm?.[3].length > 1 ? `${tier}+` : null, find(PROP_DAYS, dayCode)?.[1], regionOf(rg)?.label].filter(Boolean);
  const head = `🎯 <b>Player props</b>${crumbs.length ? `\n${esc(crumbs.join(" › "))}` : ""}\n\n`;

  if (!pm) return editText(chatId, messageId, `${head}Which market?`, keyboard([...grid(PROP_MARKETS.map(([c, l]) => [l, at(c)]), 2), [HOME]]));
  if (!tier) {
    return editText(chatId, messageId, `${head}How many?`,
      keyboard([pm[3].map((t) => [`${t}+`, at(mk, t)]), [["⬅️ Back", "pp"], HOME]]));
  }
  const tierBack = pm[3].length > 1 ? at(mk) : "pp";
  if (!dayCode) return editText(chatId, messageId, `${head}Which day?`, keyboard([PROP_DAYS.map(([c, l]) => [l, at(mk, tier, c)]), [["⬅️ Back", tierBack], HOME]]));

  await editText(chatId, messageId, `${head}⏳ Finding fixtures with player data…`);
  let info;
  try { info = await propsLeagues(dayCode); } catch (e) { return editText(chatId, messageId, `⚠️ Couldn't load fixtures: ${esc(e.message)}`, keyboard([[HOME]])); }
  const dayWord = find(PROP_DAYS, dayCode)[1].toLowerCase();

  if (!rg) {
    const regions = BOT_REGIONS.map((r) => ({ r, n: info.count(r.ids) })).filter((x) => x.n);
    if (!regions.length) return editText(chatId, messageId, `${head}No featured fixtures with player data ${dayWord}.`, keyboard([[["⬅️ Back", at(mk, tier)], HOME]]));
    return editText(chatId, messageId, `${head}Which region? <i>(matches in brackets)</i>`,
      keyboard([...grid(regions.map(({ r, n }) => [`${r.label} (${n})`, at(mk, tier, dayCode, r.code)]), 1), [["⬅️ Back", at(mk, tier)], HOME]]));
  }

  const region = regionOf(rg);
  const countries = regionCountries(rg).map((c, i) => ({ c, i, ids: c.ids.filter((id) => info.leagues.some((l) => String(l.id) === id)) }))
    .map((x) => ({ ...x, n: info.count(x.ids) })).filter((x) => x.n);
  if (!ct) {
    if (!countries.length) return editText(chatId, messageId, `${head}No ${region.label} fixtures with player data ${dayWord}.`, keyboard([[["⬅️ Back", at(mk, tier, dayCode)], HOME]]));
    const total = countries.reduce((s, x) => s + x.n, 0);
    const rows = [
      ...(total <= PROPS_ALL_MAX ? [[[`All of ${region.label} (${total})`, at(mk, tier, dayCode, rg, "*")]]] : []),
      ...grid(countries.map(({ c, i, n }) => [`${c.flag} ${c.name} (${n})`, at(mk, tier, dayCode, rg, String(i))]), 2),
      [["⬅️ Back", at(mk, tier, dayCode)], HOME],
    ];
    return editText(chatId, messageId, `${head}Which country? <i>(matches in brackets)</i>`, keyboard(rows));
  }

  const pick = ct === "*" ? { ids: countries.flatMap((x) => x.ids), label: region.label } : (() => {
    const x = countries.find((y) => String(y.i) === ct);
    return x ? { ids: x.ids, label: `${x.c.flag} ${x.c.name}` } : null;
  })();
  if (!pick || !pick.ids.length) return showMenu(chatId, messageId);
  return answerProps(chatId, messageId, { mk, tier, dayCode, leagueIds: pick.ids, scopeLabel: pick.label, back: at(mk, tier, dayCode, rg) });
}

// ---- Daily list -------------------------------------------------------------------

// Save a query to the pinned daily list. Returns the reply text.
export async function addDaily(chatId, query) {
  const q = String(query || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!q || !parseQuery(q, LEAGUES).markets.length) {
    return "I couldn't spot a market in that, so I didn't save it. Try e.g. <i>top europe over 2.5 tomorrow</i>.";
  }
  const { messageId, queries } = await readDailyPin(chatId);
  if (queries.some((x) => x.toLowerCase() === q.toLowerCase())) return "That one's already on your daily list.";
  if (queries.length >= MAX_DAILY) return `You already have ${MAX_DAILY} (the max). Remove one first — 🗓 My daily list.`;
  const next = [...queries, q];
  const ok = await writeDaily(chatId, next, messageId);
  return ok
    ? `✅ Saved — sent every day at ${esc(hoursLabel())}.\n${next.map((x, i) => `${i + 1}. ${esc(x)}`).join("\n")}`
    : "⚠️ Couldn't save that — try again.";
}

// Run each saved query and send the results. Stops starting new ones past the deadline.
export async function runDaily(chatId, { deadline, manual = false } = {}) {
  const tz = botTz();
  const { queries } = await readDailyPin(chatId);
  if (!queries.length) {
    if (manual) await sendText(chatId, "No daily searches saved yet. Run any search and tap 💾 Save as daily.", { reply_markup: keyboard([[["🔎 Find picks", "fp"], HOME]]) });
    return 0;
  }
  let sent = 0;
  for (const [i, q] of queries.entries()) {
    if (Date.now() > deadline) {
      await sendText(chatId, `⏱ Ran out of time before “${esc(q)}” — send /now to retry.`);
      break;
    }
    try {
      const r = await runAsk(q, tz, BOT_SCOPE);
      await sendChunks(chatId, formatAsk(r, tz, { title: `🗓 <b>Daily ${i + 1}:</b> <i>${esc(q)}</i>` }));
      sent++;
    } catch (e) {
      await sendText(chatId, `⚠️ “${esc(q)}” failed: ${esc(e.message)}`);
    }
  }
  return sent;
}

async function dailyView(chatId, messageId, note = "") {
  const { queries } = await readDailyPin(chatId);
  const list = queries.length ? queries.map((q, i) => `${i + 1}. ${esc(q)}`).join("\n") : "<i>(empty)</i>";
  const text = `${note ? `${note}\n\n` : ""}🗓 <b>My daily list</b> — sent at ${esc(hoursLabel())} (${esc(botTz())})\n${list}\n\nAdd one: run any search and tap 💾 <b>Save as daily</b>.`;
  const rows = queries.length
    ? [[["▶️ Send them now", "dl|run"]], queries.map((_, i) => [`🗑 Remove ${i + 1}`, `dl|rm|${i}`]), [["🧹 Clear all", "dl|clr"], HOME]]
    : [[["🔎 Find picks", "fp"], HOME]];
  return editText(chatId, messageId, text, keyboard(rows));
}

async function dailyFlow(chatId, messageId, [action, arg], deadline) {
  if (action === "run") {
    await editText(chatId, messageId, "▶️ Sending your daily list…");
    return runDaily(chatId, { deadline, manual: true });
  }
  if (action === "rm" || action === "clr") {
    const { messageId: pinId, queries } = await readDailyPin(chatId);
    const idx = Number(arg);
    if (action === "rm" && !(idx >= 0 && idx < queries.length)) return dailyView(chatId, messageId);
    const next = action === "clr" ? [] : queries.filter((_, i) => i !== idx);
    await writeDaily(chatId, next, pinId);
    return dailyView(chatId, messageId, action === "clr" ? "🧹 Cleared." : `🗑 Removed “${esc(queries[idx])}”.`);
  }
  return dailyView(chatId, messageId);
}

// ---- Button dispatcher --------------------------------------------------------------

export async function handleCallback(cq, { deadline }) {
  const chatId = String(cq.message.chat.id);
  const messageId = cq.message.message_id;
  const [code, ...parts] = String(cq.data || "").split("|");
  // Ack first so the button stops spinning; the work may take a while.
  await tg("answerCallbackQuery", { callback_query_id: cq.id });

  switch (code) {
    case "m": return showMenu(chatId, messageId);
    case "fp": return builder(chatId, messageId, parts);
    case "ac": return accaFlow(chatId, messageId, parts);
    case "pp": return propsFlow(chatId, messageId, parts);
    case "sl": return slipsFlow(chatId, messageId, parts);
    case "rs": return resultsFlow(chatId, messageId, parts);
    case "dl": return dailyFlow(chatId, messageId, parts, deadline);
    case "hw": return editText(chatId, messageId, helpText(), keyboard([[HOME]]));
    case "aw":
      return editText(chatId, messageId,
        aiEnabled()
          ? "💬 Just talk to me, e.g.\n• <i>any decent over 2.5 games in Germany this weekend?</i>\n• <i>give me a few safe bankers for tomorrow, no friendlies</i>\n• <i>a few games that come to 3+ odds tomorrow</i>\n• <i>how did yesterday's VIP do?</i>\nThen follow up: <i>why is #2 in there?</i> · <i>same but Sunday</i> · <i>save that</i>"
          : "✍️ Just type your question as a message, e.g.\n• <i>5 games over 2.5 tomorrow exclude friendlies</i>\n• <i>btts saturday only germany and england above 60%</i>\n• <i>team to score 2+ this weekend odds over 1.5</i>",
        keyboard([[["❓ Full guide", "hw"], HOME]]));
    case "sv": {
      // The query is the result's footer line ("🔎 …"), read back from the message.
      const text = cq.message.text || "";
      const q = text.split("\n").reverse().find((l) => l.startsWith(FOOTER))?.slice(FOOTER.length);
      return sendText(chatId, q ? await addDaily(chatId, q) : "Couldn't read that search — type /daily <i>query</i> instead.",
        { reply_markup: keyboard([[["🗓 My daily list", "dl"], HOME]]) });
    }
    default: return showMenu(chatId, messageId);
  }
}

// ---- Free text: rules first, Claude for the rest ---------------------------------

// Follow-ups the rule parser can't answer even when a market word is present
// ("what about btts?" needs the previous region/day; "why is #2 in?" needs results).
const FOLLOWUP_RX = /^(?:why|explain|how come|what about|how about|same\b|instead|compare|which (?:one|of)|is (?:it|that|this|the)\b|are (?:they|these|those)\b|should i|tell me|more (?:on|about)|what do you think|thoughts|save (?:that|this|it)\b)/i;
const DAILY_TITLE_RX = /^🗓 Daily \d+: (.+)$/;
const SLIP_CODE = { vip: "vip", safe: "sf", blend: "bb", blend_high: "bh", value: "vb", europe: "eu" };
const SLIP_NAME = { vip: "VIP slips", sf: "Safe accumulators", bb: "Blend 3–10x", bh: "Blend 10–50x", vb: "Value bets", eu: "Europe Strongest" };


const nowLabel = () => new Intl.DateTimeFormat("en-US", { timeZone: botTz(), weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()) + ` (${botTz()})`;
const resultLine = (m, i) => `${i + 1}. ${m.home} v ${m.away} · ${m.league} · ${m.kickoffLabel} · ${Object.values(m.markets || {}).map((l) => `${l.selection} ${l.prob}%${l.odds != null ? ` @${l.odds}` : ""}`).join(", ")}`;

// Context for Claude: the replied-to results (rebuilt from its footer if needed),
// else this chat's last results.
async function contextFor(chatId, msg) {
  const replied = msg?.reply_to_message?.from?.is_bot ? msg.reply_to_message.text || "" : "";
  const lines = replied.split("\n");
  const q = lines.reverse().map((l) => (l.startsWith(FOOTER) ? l.slice(FOOTER.length) : l.match(DAILY_TITLE_RX)?.[1])).find(Boolean);
  let mem = recall(chatId);
  if (q && mem?.query !== q) {
    const r = await runAsk(q, botTz(), BOT_SCOPE).catch(() => null);
    if (r && !r.note) mem = remember(chatId, q, r);
  }
  return { mem, replied };
}

async function aiReply(chatId, text, msg) {
  const ph = await sendText(chatId, "🤔 On it…");
  const id = ph?.message_id;
  const say = (t, markup = NOTE_KB) => (id ? editText(chatId, id, t, markup) : sendText(chatId, t, { reply_markup: markup }));
  try {
    const { mem, replied } = await contextFor(chatId, msg);
    const u = await understand(text, {
      now: nowLabel(),
      lastQuery: mem?.query,
      lastResults: mem ? mem.matches.map(resultLine) : [],
      repliedTo: replied,
    });

    switch (u.intent) {
      case "search": {
        const q = composeQuery(u.search);
        if (!q || !parseQuery(q, LEAGUES).markets.length) return say(`${esc(u.reply || "I couldn't turn that into a search.")}\n\nOr tap your way there:`);
        return answerQuery(chatId, q, id, { title: `🧠 <i>Understood as:</i> ${esc(q)}` });
      }
      case "props": {
        const pr = u.props || {};
        const pm = PROP_MARKETS.find((x) => x[2] === pr.market) || PROP_MARKETS[0];
        const tier = pm[3].includes(Number(pr.tier)) ? Number(pr.tier) : pm[3][0];
        const dayCode = pr.day === "tomorrow" ? "tm" : "td";
        const desc = `${propLabel(pm, tier)} · ${pr.team || pr.league || "pick a league"} · ${dayCode === "tm" ? "tomorrow" : "today"}`;
        const title = `🧠 <i>Understood as:</i> ${esc(desc)}`;
        const info = await propsLeagues(dayCode).catch(() => ({ leagues: [], matches: [] }));
        if (pr.team) {
          const t = normText(pr.team);
          const m = info.matches.find((x) => normText(x.home).includes(t) || normText(x.away).includes(t) || t.includes(normText(x.home)) || t.includes(normText(x.away)));
          if (m) return answerProps(chatId, id, { mk: pm[0], tier, dayCode, matchId: String(m.id), title });
          await sendText(chatId, `I couldn't find a ${dayCode === "tm" ? "tomorrow" : "today"} match with player data for “${esc(pr.team)}” in the bot's featured leagues — pick a region instead:`);
        } else if (pr.league) {
          const l = normText(pr.league);
          if (/top europe|europe top 5|top 5 leagues|big leagues/.test(l)) {
            const e5 = new Set(regionOf("e5").ids);
            const ids = info.leagues.map((x) => String(x.id)).filter((x) => e5.has(x));
            if (ids.length) return answerProps(chatId, id, { mk: pm[0], tier, dayCode, leagueIds: ids, title, scopeLabel: "⭐ Europe top 5" });
          }
          const hits = info.leagues.filter((x) => normText(x.name) === l || normText(x.name).includes(l) || l.includes(normText(x.name)));
          const pick = hits.find((x) => TOP_EUROPE_IDS.includes(String(x.id))) || hits[0];
          if (pick) return answerProps(chatId, id, { mk: pm[0], tier, dayCode, leagueIds: [String(pick.id)], title });
          await sendText(chatId, `No ${dayCode === "tm" ? "tomorrow" : "today"} fixtures with player data in “${esc(pr.league)}” among the bot's featured leagues — pick a region:`);
        }
        return propsFlow(chatId, id, [pm[0], String(tier), dayCode]);
      }
      case "acca": {
        if (!u.acca) return say(`${esc(u.reply || "What combined odds are you after?")}\n\nOr tap your way there:`, keyboard([[["🧮 Build an acca", "ac"], HOME]]));
        const scopeQ = composeQuery(u.search, { allowNoMarket: true }) || "today";
        const acca = {
          target: Math.round(Number(u.acca.target_odds) * 100) / 100,
          max: Number(u.acca.max_odds) > Number(u.acca.target_odds) ? Math.round(Number(u.acca.max_odds) * 100) / 100 : 0,
          legs: Math.max(0, Math.min(12, Math.round(Number(u.acca.legs) || 0))),
          maxLegs: Math.max(0, Math.min(12, Math.round(Number(u.acca.max_legs) || 0))),
        };
        const count = acca.legs ? `${acca.legs} legs` : acca.maxLegs ? `best chance, max ${acca.maxLegs} legs` : "best chance";
        const desc = `acca to ${acca.target}${acca.max ? `–${acca.max}` : "+"} · ${count} · ${scopeQ}`;
        const dayless = !(u.search?.days || []).length;
        return answerAcca(chatId, scopeQ, acca, id, { title: `🧠 <i>Understood as:</i> ${esc(desc)}`, rollToTomorrow: dayless });
      }
      case "save_daily": {
        const q = composeQuery(u.search) || mem?.query;
        return say(q ? await addDaily(chatId, q) : "Which search should I save? Run one first, then say “save that”.",
          keyboard([[["🗓 My daily list", "dl"], HOME]]));
      }
      case "explain": {
        const picked = [...new Set(u.matchRefs)].map((n) => mem?.matches[n - 1]).filter(Boolean).slice(0, 3);
        if (!picked.length) {
          return say("Which match? Reply to the results message and ask again (e.g. “why is #2 in there?”).", keyboard([[["🔎 Find picks", "fp"], HOME]]));
        }
        await editText(chatId, id, `🤔 Looking at ${esc(picked.map((m) => `${m.home} v ${m.away}`).join(", "))}…`);
        const answer = await explain(text, picked);
        return say(`💬 ${esc(answer)}`, keyboard([[["🔎 New search", "fp"], HOME]]));
      }
      case "slips": {
        if (u.slip?.kind === "value" && !VALUE_BETS_ENABLED) return say(VALUE_OFF_MSG, keyboard([[["🧮 Build an acca", "ac"], ["🎫 Slips", "sl"]], [HOME]]));
        const code = SLIP_CODE[u.slip?.kind] || "vip";
        const day = u.slip?.day === "tomorrow" ? "tm" : "t";
        return slipsFlow(chatId, id, [code, day], { title: `🧠 <i>Understood as:</i> ${SLIP_NAME[code]} for ${day === "tm" ? "tomorrow" : "today"}` });
      }
      case "results": {
        if (u.slip?.kind === "value") return say(VALUE_BETS_ENABLED ? "Value bets aren't graded here — results cover VIP, Safe, Blend and Europe Strongest." : VALUE_OFF_MSG, keyboard([[["📊 Results", "rs"], HOME]]));
        const code = SLIP_CODE[u.slip?.kind] || "vip";
        const day = u.slip?.day === "today" ? "t" : "y";
        return resultsFlow(chatId, id, [code, day], { title: `🧠 <i>Understood as:</i> ${SLIP_NAME[code]} results for ${day === "t" ? "today" : "yesterday"}` });
      }
      case "menu":
        return showMenu(chatId, id);
      default:
        return say(esc(u.reply || "👍"), keyboard([[["📋 Menu", "m"]]]));
    }
  } catch (e) {
    console.error(`[telegram] ai: ${e.message}`);
    return say(`⚠️ ${esc(e.message)}`);
  }
}

// Words the rule grammar knows. If a message has a market but ALSO words outside
// this set (a country, team, typo, "in Germany"…) that the parse didn't consume,
// the rules would silently drop them — so with AI on, Claude takes it instead.
const GRAMMAR = new Set([
  ...CHAT_MARKETS.flatMap((m) => m.aliases), ...CHAT_SCOPES.flatMap((x) => x.aliases),
  "today tonight tomorrow weekend monday tuesday wednesday thursday friday saturday sunday this next on",
  "home away hosts host visitors visitor visiting road either side sides",
  "odds odd price prices over under above below between greater more less than higher lower bigger smaller least most min max minimum maximum of up to from and or",
  "only include including exclude excluding except without skip ignore but not no other apart limited restricted friendlies friendly cups cup club international",
  "safe safest strong strongest likely likeliest probable very banker bankers sure solid percent pct",
  "games game matches match fixtures fixture picks pick tips tip bets bet selections selection options teams team goals goal sides side clubs",
  "give show list find get generate want need looking please pls me us i for with in at the a an any some decent good nice great best top all every across play playing bookmaker bookie bookies",
  "score scores scoring win wins winner winners draw double chance both gg btts plus leagues league",
].join(" ").split(/[^a-z]+/).filter(Boolean));

function unknownWords(text, parsed) {
  const consumed = new Set([parsed.leagueName, ...(parsed.include || []).map((t) => t.label), ...(parsed.exclude || []).map((t) => t.label)]
    .filter(Boolean).flatMap((l) => normText(l).split(/[^a-z]+/)));
  return normText(text).split(/[^a-z]+/).filter((w) => w.length >= 3 && !GRAMMAR.has(w) && !consumed.has(w));
}

// "rules" = answer free with the parser; "ai" = hand to Claude (only if enabled).
export function routeFor(text, isReply = false) {
  if (!aiEnabled()) return "rules";
  const parsed = parseQuery(text, LEAGUES);
  const rulesCan = parsed.markets.length > 0 && !isReply && !FOLLOWUP_RX.test(text.trim()) && unknownWords(text, parsed).length === 0;
  return rulesCan ? "rules" : "ai";
}

export async function handleText(chatId, text, msg) {
  const isReply = Boolean(msg?.reply_to_message?.from?.is_bot);
  return routeFor(text, isReply) === "rules" ? answerQuery(chatId, text) : aiReply(chatId, text, msg);
}

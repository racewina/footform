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

import { runAsk } from "./fixtures.js";
import { parseQuery, CHAT_MARKETS, CHAT_SCOPES, normText } from "../services/chatbot.js";
import { aiEnabled, understand, explain, composeQuery } from "../services/ai.js";
import { LEAGUES } from "../data/leagues.js";
import {
  tg, esc, sendText, sendChunks, editText, keyboard, botTz, pushHours,
  readDailyPin, writeDaily, formatAsk, MAX_DAILY,
} from "../services/telegram.js";

const HOME = ["🏠 Menu", "m"];
const hoursLabel = () => pushHours().map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");

// ---- Main menu ----------------------------------------------------------------

const menuText = () => [
  "⚽ <b>FootForm</b> — here's what I can do:",
  "",
  "🔎 <b>Find picks</b> — tap through market › region › day › how many",
  "🎫 <b>Today's slips</b> — VIP, Safe accumulators, Value bets, Europe Strongest",
  "📊 <b>Results</b> — how the slips did (✅/❌ per leg)",
  "🗓 <b>My daily list</b> — searches sent to you every morning",
  aiEnabled()
    ? "💬 <b>Just talk to me</b> — ask anything in your own words, or reply to a result with “why this one?”"
    : "✍️ <b>Ask in my own words</b> — type any question instead",
].join("\n");
const MENU_KB = keyboard([
  [["🔎 Find picks", "fp"], ["🎫 Today's slips", "sl"]],
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
const NOTE_KB = keyboard([[["🔎 Find picks", "fp"], ["📋 Menu", "m"]]]);
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
    result = await runAsk(query, tz);
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
const SCOPES = [
  ["al", "🌍 All leagues", ""], ["te", "⭐ Top Europe", "top europe"],
  ["eu", "🇪🇺 Europe", "europe"], ["sa", "🌎 South America", "south america"],
  ["na", "🌎 North America", "north america"], ["as", "🌏 Asia", "asia"],
  ["af", "🌍 Africa", "africa"],
];
const DAYS = [["td", "Today", "today"], ["tm", "Tomorrow", "tomorrow"], ["we", "This weekend", "this weekend"]];
const COUNTS = [["5", "Top 5"], ["10", "Top 10"], ["0", "All"]];
const find = (list, code) => list.find((x) => x[0] === code);
const grid = (buttons, per) => buttons.reduce((rows, b, i) => (i % per ? rows[rows.length - 1].push(b) : rows.push([b]), rows), []);

export function builderQuery(mk, sc, dy, n, x) {
  return [
    n && n !== "0" ? `${n} games` : "",
    find(MARKETS, mk)?.[2], find(SCOPES, sc)?.[2], find(DAYS, dy)?.[2],
    x === "1" ? "exclude friendlies" : "",
  ].filter(Boolean).join(" ");
}

async function builder(chatId, messageId, parts) {
  const [mk, sc, dy, n, x] = parts;
  if ((mk && !find(MARKETS, mk)) || (sc && !find(SCOPES, sc)) || (dy && !find(DAYS, dy)) || (n && !find(COUNTS, n))) {
    return showMenu(chatId, messageId); // stale/garbled button
  }
  const crumbs = [find(MARKETS, mk)?.[1], find(SCOPES, sc)?.[1], find(DAYS, dy)?.[1], find(COUNTS, n)?.[1]].filter(Boolean);
  const head = `🔎 <b>Find picks</b>${crumbs.length ? `\n${esc(crumbs.join(" › "))}` : ""}\n\n`;
  const at = (...p) => ["fp", ...p].join("|");
  const nav = [["⬅️ Back", parts.length ? at(...parts.slice(0, -1)) : "m"], HOME];

  if (!mk) return editText(chatId, messageId, `${head}Which market?`, keyboard([...grid(MARKETS.map(([c, l]) => [l, at(c)]), 2), [HOME]]));
  if (!sc) return editText(chatId, messageId, `${head}Which region?`, keyboard([...grid(SCOPES.map(([c, l]) => [l, at(mk, c)]), 2), nav]));
  if (!dy) return editText(chatId, messageId, `${head}Which day?`, keyboard([DAYS.map(([c, l]) => [l, at(mk, sc, c)]), nav]));
  if (!n) return editText(chatId, messageId, `${head}How many matches?`, keyboard([COUNTS.map(([c, l]) => [l, at(mk, sc, dy, c)]), nav]));
  if (x == null) {
    return editText(chatId, messageId, `${head}Exclude friendlies?`, keyboard([
      [["🚫 Exclude friendlies", at(mk, sc, dy, n, "1")], ["Keep them", at(mk, sc, dy, n, "0")]], nav,
    ]));
  }
  return answerQuery(chatId, builderQuery(mk, sc, dy, n, x), messageId);
}

// ---- Slips + results (read from the app's own API, which is edge-cached) ----------

const apiBase = () =>
  process.env.TELEGRAM_INTERNAL_BASE
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${process.env.PORT || 3001}`);

async function apiGet(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 240 * 1000);
  try {
    const res = await fetch(`${apiBase()}/api${path}`, { signal: ctrl.signal });
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

// [code, label, live path, results path, formatter]
const SLIPS = [
  ["vip", "👑 VIP slips", "/vip", "/vip/results", fmtVip],
  ["sf", "🛡 Safe accumulators", "/accumulators", "/accumulators/results", fmtSafe],
  ["vb", "💎 Value bets", "/value", null, (d, _g, lbl) => fmtValue(d, lbl)],
  ["eu", "🇪🇺 Europe Strongest", "/europe-strongest", "/europe-strongest", fmtEurope],
];
const BACK_TO = (code) => ["⬅️ Back", code];

export async function slipsFlow(chatId, messageId, [kind, day]) {
  if (!kind) {
    return editText(chatId, messageId, "🎫 <b>Today's slips</b> — which one?",
      keyboard([...grid(SLIPS.map(([c, l]) => [l, `sl|${c}`]), 2), [BACK_TO("m"), HOME]]));
  }
  const slip = SLIPS.find((s) => s[0] === kind);
  if (!slip) return showMenu(chatId, messageId);
  if (!day) {
    return editText(chatId, messageId, `${slip[1]} — which day?`,
      keyboard([[["Today", `sl|${kind}|t`], ["Tomorrow", `sl|${kind}|tm`]], [BACK_TO("sl"), HOME]]));
  }
  if (!(day in DAY_OFFSET)) return showMenu(chatId, messageId);
  const label = DAY_LABEL[day];
  await editText(chatId, messageId, `⏳ Loading ${slip[1]} for ${label}… (a cold day can take a minute or two)`);
  let chunks;
  try {
    const d = await apiGet(`${slip[2]}?date=${ymd(DAY_OFFSET[day])}&tz=${encodeURIComponent(botTz())}`);
    chunks = slip[4](d, false, label);
  } catch (e) {
    chunks = [`⚠️ Couldn't load ${slip[1]}: ${esc(e.message)}`];
  }
  return deliver(chatId, messageId, chunks, keyboard([[["🎫 Other slips", "sl"], HOME]]));
}

const RESULT_SLIPS = SLIPS.filter((s) => s[3]);
export async function resultsFlow(chatId, messageId, [kind, day]) {
  if (!kind) {
    return editText(chatId, messageId, "📊 <b>Results</b> — which slips?",
      keyboard([...grid(RESULT_SLIPS.map(([c, l]) => [l, `rs|${c}`]), 2), [BACK_TO("m"), HOME]]));
  }
  const slip = RESULT_SLIPS.find((s) => s[0] === kind);
  if (!slip) return showMenu(chatId, messageId);
  if (!day) {
    return editText(chatId, messageId, `📊 ${slip[1]} — which day?`,
      keyboard([[["Yesterday", `rs|${kind}|y`], ["Today so far", `rs|${kind}|t`]], [BACK_TO("rs"), HOME]]));
  }
  if (!(day in DAY_OFFSET)) return showMenu(chatId, messageId);
  const label = DAY_LABEL[day];
  await editText(chatId, messageId, `⏳ Grading ${slip[1]} for ${label}…`);
  let chunks;
  try {
    const extra = kind === "eu" ? "&includeFinished=1" : "";
    const d = await apiGet(`${slip[3]}?date=${ymd(DAY_OFFSET[day])}&tz=${encodeURIComponent(botTz())}${extra}`);
    chunks = slip[4](d, true, label);
  } catch (e) {
    chunks = [`⚠️ Couldn't load results: ${esc(e.message)}`];
  }
  return deliver(chatId, messageId, chunks, keyboard([[["📊 Other results", "rs"], HOME]]));
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
      const r = await runAsk(q, tz);
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
    case "sl": return slipsFlow(chatId, messageId, parts);
    case "rs": return resultsFlow(chatId, messageId, parts);
    case "dl": return dailyFlow(chatId, messageId, parts, deadline);
    case "hw": return editText(chatId, messageId, helpText(), keyboard([[HOME]]));
    case "aw":
      return editText(chatId, messageId,
        aiEnabled()
          ? "💬 Just talk to me, e.g.\n• <i>any decent over 2.5 games in Germany this weekend?</i>\n• <i>give me a few safe bankers for tomorrow, no friendlies</i>\n• <i>how did yesterday's VIP do?</i>\nThen follow up: <i>why is #2 in there?</i> · <i>same but Sunday</i> · <i>save that</i>"
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
const SLIP_CODE = { vip: "vip", safe: "sf", value: "vb", europe: "eu" };

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
    const r = await runAsk(q, botTz()).catch(() => null);
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
        const code = SLIP_CODE[u.slip?.kind] || "vip";
        return slipsFlow(chatId, id, [code, u.slip?.day === "tomorrow" ? "tm" : "t"]);
      }
      case "results": {
        if (u.slip?.kind === "value") return say("Value bets aren't graded here — results cover VIP, Safe and Europe Strongest.", keyboard([[["📊 Results", "rs"], HOME]]));
        const code = SLIP_CODE[u.slip?.kind] || "vip";
        return resultsFlow(chatId, id, [code, u.slip?.day === "today" ? "t" : "y"]);
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

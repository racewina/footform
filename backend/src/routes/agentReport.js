// Research agent: scheduled betting-research reports to the paired Telegram chat.
//
//   GET /api/cron/agent-report   Vercel cron at :15 and :35 every hour (UTC). It
//                                works out which report slot (if any) is due in
//                                AGENT_TZ (default America/Toronto, DST-aware) and
//                                runs it:
//                                  • every day 00:35 → the full day
//                                  • Sat + Sun 02:15, 05:15 … 23:15 → kickoffs from
//                                    the slot up to (excluding) the next slot (3h)
//                                A late run keeps its slot's window and drops games
//                                that already kicked off.
//
// One run: list every FootForm fixture kicking off in the window → build the
// league-days (model, odds) under a time budget → rank and build dossiers for the
// strongest (history, home/away, rest, H2H, injuries, lineups, Betano/best prices)
// → Claude researches + picks (services/researchAgent.js) → recheck kickoff status
// → format → send. Prices and combined odds are always computed here, never by
// the model. Analysis only: nothing here can place a bet.
//
// Duplicates: each slot is claimed in Vercel's runtime cache (shared across
// instances) before it runs and marked sent after delivery; a failed slot is
// retried once on the next tick (20–40 min later) and then given up.

import express from "express";
import crypto from "node:crypto";
import { getCache } from "@vercel/functions";
import {
  buildLeagueDay, getFixtureOdds, getTeamEvents, getFixtureInjuryRows, fixturesOnDateCached, formatDate,
} from "./fixtures.js";
import { fetchHeadToHeadLast, fetchFixtureLineups, fetchFixtureStatuses } from "../services/apifootball.js";
import { LEAGUES_BY_ID, NO_BET_COUNTRIES, NO_BET_LEAGUES } from "../data/leagues.js";
import { blendCandidates } from "../services/blend.js";
import { bestBookOddsForLeg } from "../services/valuebets.js";
import { runResearch, agentEnabled } from "../services/researchAgent.js";
import { telegramEnabled, allowedChatIds, sendText, esc } from "../services/telegram.js";

const router = express.Router();

export const agentTz = () => process.env.AGENT_TZ || "America/Toronto";
const DEEP = Number(process.env.AGENT_DEEP || 14);            // fixtures given full dossiers (3h window)
const DEEP_DAY = Number(process.env.AGENT_DEEP_DAY || 20);     // … and on a full-day report
const PRICE_MAX = 80;                                          // fixtures we fetch odds for
const BOOK = process.env.AGENT_BOOK || "Betano";               // preferred bookmaker
const RUN_MS = Number(process.env.AGENT_RUN_MS || 740 * 1000); // under the 800s function cap
const SCREEN_MS = 150 * 1000;
const LATE_MS = 60 * 60 * 1000; // a slot can still start up to 60 min late (one retry tick)

// ---- Time in the report timezone --------------------------------------------------

function zoned(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), m: Number(p.minute), s: Number(p.second), dow: p.weekday };
}
// Local wall-clock time on a date → epoch ms (two passes settle the DST offset).
function localToMs(ymd, h, m, tz) {
  const [y, mo, d] = ymd.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m);
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const z = zoned(t, tz);
    const [zy, zmo, zd] = z.ymd.split("-").map(Number);
    t = wall - (Date.UTC(zy, zmo - 1, zd, z.h, z.m, z.s) - t);
  }
  return t;
}
const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); };
const tzAbbr = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value || tz;
const fmtTime = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
const fmtDay = (ms, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(ms));

const WEEKEND_HOURS = [2, 5, 8, 11, 14, 17, 20, 23]; // :15, every 3h from 02:15

// Every slot scheduled on a local date: { id, startMs, endMs, label }.
function slotsOn(ymd, tz) {
  const out = [{
    id: `${ymd}:day`, kind: "day", startMs: localToMs(ymd, 0, 35, tz), endMs: localToMs(addDays(ymd, 1), 0, 0, tz), label: "Full-day report",
  }];
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  if (dow === 6 || dow === 0) {
    for (const h of WEEKEND_HOURS) {
      const startMs = localToMs(ymd, h, 15, tz);
      out.push({ id: `${ymd}:w${h}`, kind: "window", startMs, endMs: startMs + 3 * 3600 * 1000, label: `Weekend ${String(h).padStart(2, "0")}:15 report` });
    }
  }
  return out;
}

// The slot due now: scheduled at or before now, by at most LATE_MS. Yesterday's
// late slots are included so a 23:15 run delayed past midnight still counts.
export function dueSlot(nowMs, tz) {
  const today = zoned(nowMs, tz).ymd;
  const all = [...slotsOn(addDays(today, -1), tz), ...slotsOn(today, tz)];
  return all.filter((s) => s.startMs <= nowMs && nowMs - s.startMs < LATE_MS).sort((a, b) => b.startMs - a.startMs)[0] || null;
}

// ---- Slot ledger (dedupe) -----------------------------------------------------------

const ledger = () => getCache({ namespace: "agent-report" });
const LEDGER_TTL = 3 * 24 * 3600;
async function readSlot(id) { try { return (await ledger().get(id)) || null; } catch { return null; } }
async function writeSlot(id, v) { try { await ledger().set(id, v, { ttl: LEDGER_TTL }); } catch (e) { console.error(`[agent] ledger: ${e.message}`); } }
async function rememberRun(entry) {
  try {
    const list = ((await ledger().get("recent")) || []).filter((r) => r.id !== entry.id);
    await ledger().set("recent", [entry, ...list].slice(0, 12), { ttl: 14 * 24 * 3600 });
  } catch { /* status list is best-effort */ }
}
export async function recentRuns() { try { return (await ledger().get("recent")) || []; } catch { return []; } }

// ---- Screening -----------------------------------------------------------------------

const betSafeLeague = (lg) => lg && !lg.friendly && !/friendl/i.test(lg.name) && !NO_BET_COUNTRIES.has(lg.country) && !NO_BET_LEAGUES.has(String(lg.id));

// Every FootForm fixture kicking off in [from, to): the fixtures-by-date feed over
// the UTC dates the window touches.
async function windowFixtures(fromMs, toMs) {
  const dates = new Set();
  for (let t = fromMs - 86400000; t <= toMs + 86400000; t += 86400000) dates.add(new Date(t).toISOString().slice(0, 10));
  const lists = await Promise.all([...dates].map((d) => fixturesOnDateCached(d).catch(() => [])));
  const seen = new Set(), out = [];
  for (const fx of lists.flat()) {
    const lg = LEAGUES_BY_ID[String(fx.leagueId)];
    if (!lg || seen.has(fx.id) || !fx.startTimestamp) continue;
    const ko = fx.startTimestamp * 1000;
    if (ko < fromMs || ko >= toMs) continue;
    seen.add(fx.id);
    out.push({ ...fx, league: lg });
  }
  return out;
}

// Candidate selections for one fixture: Blend's menu (result, team goals, totals,
// BTTS, double chance) plus over/under 1.5 and 3.5.
function candidatesFor(fx) {
  const m = fx.prediction?.markets || {};
  const sided = (p, yes, no) => (p >= 50 ? { selection: yes, prob: p } : { selection: no, prob: 100 - p });
  const extra = [];
  if (typeof m.over15 === "number") extra.push({ marketKey: "over15", market: "Total Goals", ...sided(m.over15, "Over 1.5 goals", "Under 1.5 goals") });
  if (typeof m.over35 === "number") extra.push({ marketKey: "over35", market: "Total Goals", ...sided(m.over35, "Over 3.5 goals", "Under 3.5 goals") });
  return [...blendCandidates(fx), ...extra].filter((c) => typeof c.prob === "number" && c.prob >= 50);
}

function priceCandidates(fx, odds) {
  const side = fx.prediction?.markets?.winner;
  const bookName = odds?.byBook ? Object.keys(odds.byBook).find((b) => b.toLowerCase() === BOOK.toLowerCase()) : null;
  const pref = bookName ? Object.fromEntries(Object.entries(odds.byBook[bookName]).map(([k, o]) => [k, { odd: o, book: bookName }])) : null;
  const out = [];
  for (const c of candidatesFor(fx)) {
    const best = odds?.best ? bestBookOddsForLeg(odds.best, c, side) : null;
    const preferred = pref ? bestBookOddsForLeg(pref, c, side) : null;
    if (!best && !preferred) continue;
    out.push({ ...c, preferred, best });
  }
  return out;
}

// Results line + record from a team's finished events, newest first.
function teamHistory(events, teamId, beforeSec, venue) {
  const done = (events || [])
    .filter((e) => e.status?.type === "finished" && e.startTimestamp < beforeSec && e.homeScore?.current != null)
    .sort((a, b) => b.startTimestamp - a.startTimestamp);
  const row = (e) => {
    const home = e.homeTeam?.id === teamId;
    const gf = home ? e.homeScore.current : e.awayScore.current, ga = home ? e.awayScore.current : e.homeScore.current;
    return { home, gf, ga, res: gf > ga ? "W" : gf < ga ? "L" : "D", opp: home ? e.awayTeam?.name : e.homeTeam?.name, comp: e.leagueName, ts: e.startTimestamp };
  };
  const rows = done.map(row);
  const fmt = (r) => `${r.res} ${r.gf}-${r.ga} ${r.home ? "v" : "@"} ${r.opp} (${r.comp})`;
  const rec = (rs) => {
    const c = { W: 0, D: 0, L: 0 }; let gf = 0, ga = 0;
    for (const r of rs) { c[r.res]++; gf += r.gf; ga += r.ga; }
    return rs.length ? `W${c.W} D${c.D} L${c.L}, scored ${gf} conceded ${ga} in ${rs.length}` : "no data";
  };
  const atVenue = rows.filter((r) => r.home === (venue === "home")).slice(0, 6);
  return {
    last6: rows.slice(0, 6).map(fmt),
    last6Record: rec(rows.slice(0, 6)),
    [`last6${venue === "home" ? "Home" : "Away"}`]: rec(atVenue),
    scoredInLast10: rows.slice(0, 10).filter((r) => r.gf > 0).length + "/" + Math.min(10, rows.length),
    restDays: rows[0] ? Math.round((beforeSec - rows[0].ts) / 86400) : null,
  };
}

const r1 = (x) => (typeof x === "number" ? Math.round(x * 10) / 10 : null);

async function dossier(ref, fx, lg, priced, tz) {
  const p = fx.prediction || {}, m = p.markets || {};
  const hId = fx.homeTeam.id, aId = fx.awayTeam.id, ko = fx.startTimestamp;
  const soon = ko * 1000 - Date.now() < 90 * 60 * 1000;
  const [hEv, aEv, h2h, inj, lineups] = await Promise.all([
    getTeamEvents(hId).catch(() => []),
    getTeamEvents(aId).catch(() => []),
    fetchHeadToHeadLast(hId, aId, 5).catch(() => null),
    getFixtureInjuryRows(fx.id).catch(() => null),
    soon ? fetchFixtureLineups(fx.id).catch(() => []) : Promise.resolve(null),
  ]);
  const absent = (teamId) => (inj || []).filter((r) => r.teamId === teamId).map((r) => `${r.playerName} (${/quest/i.test(r.type || "") ? "doubtful" : "out"}: ${r.reason || "n/a"})`);
  const xi = (teamId) => lineups?.find((l) => l.teamId === teamId)?.startXI?.map((x) => x.name);
  return {
    ref,
    fixture: `${fx.homeTeam.name} v ${fx.awayTeam.name}`,
    competition: `${lg.name} (${lg.country})`,
    kickoff: `${fmtDay(ko * 1000, tz)} ${fmtTime(ko * 1000, tz)} ${tzAbbr(ko * 1000, tz)}`,
    venue: fx.venue || null,
    footformModel: {
      note: "FootForm's own model — evidence only, do not copy",
      homeWinPct: p.home, drawPct: p.draw, awayWinPct: p.away,
      xG: [r1(m.xgHome), r1(m.xgAway)], over25Pct: m.over25, bttsPct: m.btts,
      goalsPerGame: { home: [r1(p.homeGoalsFor), r1(p.homeGoalsAgainst)], away: [r1(p.awayGoalsFor), r1(p.awayGoalsAgainst)], note: "[scored, conceded] recent average" },
    },
    home: { team: fx.homeTeam.name, ...teamHistory(hEv, hId, ko, "home"), absences: inj ? absent(hId) : "feed unavailable", startingXI: xi(hId) || null },
    away: { team: fx.awayTeam.name, ...teamHistory(aEv, aId, ko, "away"), absences: inj ? absent(aId) : "feed unavailable", startingXI: xi(aId) || null },
    lineups: lineups?.length ? "official lineups published (startingXI above)" : soon ? "not published yet" : "not published yet (usually ~40 min before kickoff)",
    headToHead: h2h ? h2h.map((g) => `${g.date} ${g.home} ${g.score ?? "?"} ${g.away} (${g.league})`) : "feed unavailable",
    candidates: priced.map((c, i) => ({
      id: `${ref}-${String.fromCharCode(97 + i)}`,
      selection: c.selection,
      market: c.market,
      [BOOK]: c.preferred ? c.preferred.odds : null,
      bestPrice: c.best ? `${c.best.odds} (${c.best.book})` : null,
    })),
  };
}

// Build the window's fixtures under a time budget and pick the dossier set.
async function screen(win, tz, deadline) {
  const nowMs = Date.now();
  const from = Math.max(win.startMs, nowMs + 2 * 60 * 1000); // drop anything about to start / started
  const all = await windowFixtures(from, win.endMs);
  const eligible = all.filter((f) => f.status === "notstarted" && betSafeLeague(f.league));
  const excludedLeagues = all.length - eligible.length;

  // League-days to build (a window can span two local dates).
  const jobs = new Map();
  for (const f of eligible) {
    const date = formatDate(new Date(f.startTimestamp * 1000), tz);
    jobs.set(`${f.league.id}|${date}`, { leagueId: String(f.league.id), date });
  }
  const built = new Map();
  const tasks = [...jobs.entries()].map(([k, j]) => buildLeagueDay(j.leagueId, j.date, tz).then((g) => built.set(k, g)).catch(() => {}));
  await Promise.race([Promise.all(tasks), new Promise((r) => setTimeout(r, Math.max(5000, deadline - Date.now())))]);

  const wanted = new Set(eligible.map((f) => String(f.id)));
  const screened = [];
  const missingLeagues = new Set();
  for (const [k, j] of jobs) {
    const g = built.get(k);
    if (!g) { missingLeagues.add(LEAGUES_BY_ID[j.leagueId]?.name || j.leagueId); continue; }
    for (const fx of g.fixtures || []) {
      if (!wanted.has(String(fx.id)) || fx.status !== "notstarted") continue;
      if (!fx.prediction?.markets || !fx.homeTeam?.id || !fx.awayTeam?.id) continue;
      screened.push({ fx, lg: g.league });
    }
  }

  // Price the strongest by the model, then rank by the strongest selection priced
  // in the 1.30–3.00 band (the legs a 5–15 accumulator is built from).
  const byModel = screened
    .map((s) => ({ ...s, top: Math.max(0, ...candidatesFor(s.fx).map((c) => c.prob)) }))
    .sort((a, b) => b.top - a.top)
    .slice(0, PRICE_MAX);
  for (let i = 0; i < byModel.length && Date.now() < deadline + 30000; i += 10) {
    await Promise.all(byModel.slice(i, i + 10).map(async (s) => { s.priced = priceCandidates(s.fx, await getFixtureOdds(s.fx.id).catch(() => null)); }));
  }
  const ranked = byModel
    .filter((s) => s.priced?.length)
    .map((s) => {
      const band = s.priced.filter((c) => { const o = (c.preferred || c.best).odds; return o >= 1.3 && o <= 3; });
      return { ...s, score: band.length ? Math.max(...band.map((c) => c.prob)) : 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.fx.startTimestamp - b.fx.startTimestamp);

  const deep = ranked.slice(0, win.kind === "day" ? DEEP_DAY : DEEP);
  const dossiers = await Promise.all(deep.map((s, i) => {
    // Up to 6 selections per fixture: the 4 strongest, plus the 2 strongest priced
    // 1.60+ (short legs alone rarely reach a 5–15 accumulator in few legs).
    const ok = s.priced.filter((c) => (c.preferred || c.best).odds >= 1.15).sort((a, b) => b.prob - a.prob);
    const top = ok.slice(0, 4);
    const longer = ok.slice(4).filter((c) => (c.preferred || c.best).odds >= 1.6).slice(0, 2);
    s.cands = [...top, ...longer];
    return dossier(`F${i + 1}`, s.fx, s.lg, s.cands, tz);
  }));

  return {
    dossiers,
    lookup: Object.fromEntries(deep.map((s, i) => [`F${i + 1}`, s])),
    coverage: {
      inWindow: all.length,
      eligible: eligible.length,
      excludedLeagues,
      screened: screened.length,
      priced: ranked.length,
      deepResearched: dossiers.length,
      leaguesNotLoaded: [...missingLeagues],
    },
  };
}

// ---- Report assembly -------------------------------------------------------------------

const round2 = (x) => Math.round(x * 100) / 100;
const LIMIT = 3800;

// Validate Claude's picks against the dossiers and attach code-side prices.
function resolvePicks(report, scr) {
  const cands = new Map();
  for (const d of scr.dossiers) {
    const s = scr.lookup[d.ref];
    d.candidates.forEach((c, i) => cands.set(c.id, { fx: s.fx, lg: s.lg, cand: s.cands[i] }));
  }
  const picks = [], seenFx = new Set(), rejected = [];
  for (const p of report.picks || []) {
    const hit = cands.get(p.candidate_id);
    if (!hit?.cand) { rejected.push(`${p.candidate_id} (unknown selection)`); continue; }
    if (seenFx.has(hit.fx.id)) { rejected.push(`${p.candidate_id} (second pick on the same match)`); continue; }
    seenFx.add(hit.fx.id);
    const o = p.price_override;
    const override = o && o.odds >= 1.01 && o.odds <= 100 && /^https?:\/\//.test(o.source_url || "") ? o : null;
    const price = override
      ? { odds: round2(override.odds), book: override.bookmaker, kind: "reported", url: override.source_url }
      : hit.cand.preferred
        ? { odds: hit.cand.preferred.odds, book: hit.cand.preferred.book, kind: "feed" }
        : { odds: hit.cand.best.odds, book: hit.cand.best.book, kind: "feed" };
    picks.push({ ...p, id: p.candidate_id, fx: hit.fx, lg: hit.lg, selection: hit.cand.selection, market: hit.cand.market, price });
  }
  return { picks, rejected };
}

function accumulatorOf(report, picks) {
  const ids = report.accumulator?.candidate_ids || [];
  const legs = ids.map((id) => picks.find((p) => p.id === id)).filter(Boolean);
  if (legs.length < 2) return null;
  const total = round2(legs.reduce((x, l) => x * l.price.odds, 1));
  const books = new Set(legs.map((l) => l.price.book));
  const verified = books.size === 1 && legs.every((l) => l.price.kind === "feed");
  return { legs, total, inTarget: total >= 5 && total <= 15, verified, book: books.size === 1 ? [...books][0] : null, rationale: report.accumulator.rationale || "" };
}

function formatReport({ win, tz, scr, report, picks, acca, dropped, rejected, usage, checkedAt }) {
  const z = tzAbbr(win.startMs, tz);
  const winTxt = `${fmtDay(win.startMs, tz)} ${fmtTime(win.startMs, tz)} – ${win.kind === "day" ? "midnight" : fmtTime(win.endMs, tz)} ${z}`;
  const c = scr.coverage;
  const out = [];
  out.push(`🧠 <b>FootForm research report</b> · ${esc(win.label)}\n📅 ${esc(fmtDay(win.startMs, tz))} · ${esc(tz)} (${esc(z)})\n⏱ Window: ${esc(winTxt)} (kickoffs from the start up to, not including, the end)`);
  const missing = c.leaguesNotLoaded.length ? `\n⚠️ Incomplete: ${c.leaguesNotLoaded.length} league${c.leaguesNotLoaded.length === 1 ? "" : "s"} didn't load in time (${esc(c.leaguesNotLoaded.slice(0, 8).join(", "))}${c.leaguesNotLoaded.length > 8 ? "…" : ""}) — their games were not screened.` : "";
  out.push(`🔎 <b>Coverage</b>: ${c.inWindow} FootForm fixtures in the window · ${c.eligible} eligible (friendlies + no-bet leagues excluded) · ${c.screened} screened on model data · ${c.priced} with bookmaker prices · ${c.deepResearched} researched in depth${usage?.searches != null ? ` · ${usage.searches} web searches` : ""}${missing}`);

  if (!picks.length) {
    out.push(`📭 <b>No selections</b> in this window.${report.limitation ? `\n${esc(report.limitation)}` : ""}`);
  } else {
    out.push(`<b>Selections</b> (${picks.length})`);
    picks.forEach((p, i) => {
      const ko = p.fx.startTimestamp * 1000;
      const priceTag = p.price.kind === "feed"
        ? `✅ ${esc(p.price.book)} price from the odds feed (checked ${esc(checkedAt)})`
        : `ℹ️ reported ${esc(p.price.book)} price — <a href="${esc(p.price.url)}">source</a>, not verified by the feed`;
      const src = (p.sources || []).filter((s) => /^https?:\/\//.test(s.url)).slice(0, 4).map((s) => `<a href="${esc(s.url)}">${esc(s.title.slice(0, 40) || "link")}</a>`).join(" · ");
      out.push([
        `<b>${i + 1}. ${esc(p.fx.homeTeam.name)} v ${esc(p.fx.awayTeam.name)}</b>`,
        `${p.lg.flag || ""} ${esc(p.lg.name)} · ${esc(fmtDay(ko, tz))} ${esc(fmtTime(ko, tz))} ${esc(tzAbbr(ko, tz))}`,
        `🎯 <b>${esc(p.selection)}</b> @ <b>${p.price.odds.toFixed(2)}</b> — ${priceTag}`,
        `📈 ${esc(p.reasoning)}`,
        `⚠️ Risk: ${esc(p.key_risk)}`,
        p.lineup_note ? `👥 ${esc(p.lineup_note)}` : "",
        src ? `🔗 ${src}` : "",
      ].filter(Boolean).join("\n"));
    });
  }

  if (acca) {
    const legs = acca.legs.map((l) => `• ${esc(l.selection)} (${esc(l.fx.homeTeam.name)} v ${esc(l.fx.awayTeam.name)}) @ ${l.price.odds.toFixed(2)} ${esc(l.price.book)}`).join("\n");
    const label = acca.verified ? `${esc(acca.book)} feed prices` : "INDICATIVE — mixes bookmakers and/or reported prices";
    const target = acca.inTarget ? "within the 5.00–15.00 target" : `⚠️ outside the 5.00–15.00 target`;
    out.push(`🧾 <b>Accumulator</b> (${acca.legs.length} legs)\n${legs}\n<b>Combined odds: ${acca.total.toFixed(2)}</b> (${label}; ${target})${acca.rationale ? `\n${esc(acca.rationale)}` : ""}`);
  } else if (picks.length) {
    out.push(`🧾 <b>Accumulator</b>: no defensible 5.00–15.00 accumulator in this window — the picks above are individual selections.`);
  }
  if (report.limitation && picks.length) out.push(`ℹ️ ${esc(report.limitation)}`);
  if (report.lineup_uncertainties) out.push(`👥 <b>Lineup watch</b>: ${esc(report.lineup_uncertainties)}`);
  if (report.exclusions?.length) out.push(`🚫 <b>Left out</b>\n${report.exclusions.slice(0, 8).map((e) => `• ${esc(e.fixture)} — ${esc(e.reason)}`).join("\n")}`);
  if (dropped.length) out.push(`⏰ Removed at the final kickoff check: ${esc(dropped.join("; "))}`);
  if (rejected.length) console.warn(`[agent] rejected picks: ${rejected.join(", ")}`);
  out.push(`<i>Analysis only — no bets placed. Predictions are uncertain; prices move — check them before betting.</i>`);

  // Pack sections into Telegram-sized messages.
  const chunks = [];
  let cur = "";
  for (const s of out) {
    const piece = s.length > LIMIT ? `${s.slice(0, LIMIT - 1)}…` : s;
    if (cur && cur.length + piece.length + 2 > LIMIT) { chunks.push(cur); cur = piece; }
    else cur = cur ? `${cur}\n\n${piece}` : piece;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---- One run ---------------------------------------------------------------------------

async function deliver(chunks) {
  const chats = [...allowedChatIds()];
  if (!chats.length) return { ok: false, error: "no paired chat (TELEGRAM_ALLOWED_CHAT_IDS is empty)" };
  for (const chatId of chats) {
    for (const [i, c] of chunks.entries()) {
      let sent = await sendText(chatId, c);
      if (!sent) sent = await sendText(chatId, c); // one retry (rate limit / blip)
      if (!sent) return { ok: false, error: `Telegram rejected message ${i + 1}/${chunks.length}`, partial: i };
    }
  }
  return { ok: true, messages: chunks.length * chats.length };
}

export async function runReport(win, tz, { startedAt = Date.now(), notifyFailure = true } = {}) {
  const deadline = startedAt + RUN_MS;
  const scr = await screen(win, tz, Math.min(startedAt + SCREEN_MS, deadline - 300 * 1000));
  const context = {
    window: {
      label: win.label,
      timezone: tz,
      from: `${fmtDay(win.startMs, tz)} ${fmtTime(win.startMs, tz)} ${tzAbbr(win.startMs, tz)}`,
      toExclusive: `${fmtDay(win.endMs, tz)} ${fmtTime(win.endMs, tz)} ${tzAbbr(win.endMs, tz)}`,
      now: `${fmtDay(Date.now(), tz)} ${fmtTime(Date.now(), tz)}`,
      preferredBookmaker: BOOK,
    },
    coverage: scr.coverage,
    dossiers: scr.dossiers,
  };

  let research = { report: { picks: [], accumulator: null, exclusions: [], lineup_uncertainties: "", limitation: "", researched_fixture_refs: [] }, usage: null };
  if (scr.dossiers.length) {
    research = await runResearch(context, { timeoutMs: deadline - Date.now() - 30 * 1000 });
  } else {
    research.report.limitation = scr.coverage.eligible
      ? "No fixture in the window had both model data and bookmaker prices in the selection range, so there was nothing to research."
      : "No eligible fixtures kick off in this window.";
  }

  let { picks, rejected } = resolvePicks(research.report, scr);
  // Final kickoff check, live from the feed (never cached).
  const dropped = [];
  if (picks.length) {
    const st = await fetchFixtureStatuses(picks.map((p) => p.fx.id)).catch(() => null);
    if (st) {
      picks = picks.filter((p) => {
        const s = st[p.fx.id];
        const startsOk = s && s.short && ["NS", "TBD"].includes(s.short) && s.kickoff * 1000 > Date.now();
        if (!startsOk) dropped.push(`${p.fx.homeTeam.name} v ${p.fx.awayTeam.name} (${s?.short || "status unknown"})`);
        if (startsOk && s.kickoff !== p.fx.startTimestamp) p.fx = { ...p.fx, startTimestamp: s.kickoff };
        return startsOk;
      });
    } else {
      research.report.limitation = `${research.report.limitation ? `${research.report.limitation} ` : ""}The final kickoff-status check failed — confirm kickoff times before betting.`;
    }
  }
  const acca = accumulatorOf(research.report, picks);
  const checkedAt = `${fmtTime(Date.now(), tz)} ${tzAbbr(Date.now(), tz)}`;
  const chunks = formatReport({ win, tz, scr, report: research.report, picks, acca, dropped, rejected, usage: research.usage, checkedAt });
  const delivery = telegramEnabled() ? await deliver(chunks) : { ok: false, error: "TELEGRAM_BOT_TOKEN not set" };
  if (!delivery.ok && notifyFailure) console.error(`[agent] delivery failed: ${delivery.error}`);
  return { chunks, delivery, coverage: scr.coverage, picks: picks.length, acca: acca ? acca.total : null, usage: research.usage };
}

// Tell the chat a slot failed (best-effort; the failure is also in the run log).
async function notifyFailure(win, tz, err) {
  if (!telegramEnabled()) return;
  for (const chatId of allowedChatIds()) {
    await sendText(chatId, `⚠️ <b>Research report failed</b> · ${esc(win.label)} (${esc(fmtDay(win.startMs, tz))} ${esc(fmtTime(win.startMs, tz))})\n${esc(String(err.message || err).slice(0, 300))}`);
  }
}

// Claim → run → record. `force` skips the ledger (manual runs).
export async function runSlot(win, tz, { force = false } = {}) {
  const startedAt = Date.now();
  if (!force) {
    const prev = await readSlot(win.id);
    if (prev?.state === "sent") return { skipped: "already sent", slot: win.id };
    if (prev?.state === "running" && startedAt - prev.at < 15 * 60 * 1000) return { skipped: "already running", slot: win.id };
    if (prev?.attempts >= 2) return { skipped: "gave up after 2 attempts", slot: win.id };
    await writeSlot(win.id, { state: "running", at: startedAt, attempts: (prev?.attempts || 0) + 1 });
  }
  const attempts = force ? 1 : ((await readSlot(win.id))?.attempts || 1);
  try {
    const r = await runReport(win, tz, { startedAt });
    const state = r.delivery.ok ? "sent" : "failed";
    if (!force) await writeSlot(win.id, { state, at: Date.now(), attempts });
    await rememberRun({ id: win.id, label: win.label, state, at: Date.now(), picks: r.picks, acca: r.acca, error: r.delivery.ok ? null : r.delivery.error, screened: r.coverage.screened, deep: r.coverage.deepResearched });
    return { slot: win.id, state, delivery: r.delivery, coverage: r.coverage, picks: r.picks, acca: r.acca, usage: r.usage, ms: Date.now() - startedAt, report: r.chunks.join("\n\n") };
  } catch (e) {
    console.error(`[agent] ${win.id}: ${e.message}`);
    if (!force) await writeSlot(win.id, { state: "failed", at: Date.now(), attempts });
    await rememberRun({ id: win.id, label: win.label, state: "failed", at: Date.now(), error: e.message });
    // Only tell the chat once the retry is used up (or on a manual run).
    if (force || attempts >= 2) await notifyFailure(win, tz, e).catch(() => {});
    return { slot: win.id, state: "failed", error: e.message, attempts, ms: Date.now() - startedAt };
  }
}

// A manual window: now → the end of today (or `hours` ahead).
export function manualWindow(tz, hours = 0) {
  const now = Date.now();
  const end = hours > 0 ? now + hours * 3600 * 1000 : localToMs(addDays(zoned(now, tz).ymd, 1), 0, 0, tz);
  return { id: `manual:${now}`, kind: hours > 0 ? "window" : "day", startMs: now, endMs: end, label: hours > 0 ? `On-demand report (next ${hours}h)` : "On-demand report (rest of today)" };
}

// ---- Route -----------------------------------------------------------------------------

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

router.get("/cron/agent-report", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(503).json({ error: "Set CRON_SECRET to enable the research agent." });
  if (!safeEqual(req.headers.authorization, `Bearer ${cronSecret}`)) return res.status(401).json({ error: "unauthorized" });
  if (!agentEnabled()) return res.json({ skipped: "ANTHROPIC_API_KEY not set" });
  if (!telegramEnabled()) return res.json({ skipped: "TELEGRAM_BOT_TOKEN not set" });

  const tz = agentTz();
  const manual = req.query.manual != null;
  const win = manual ? manualWindow(tz, Number(req.query.hours) || 0) : dueSlot(Date.now(), tz);
  if (!win) {
    const z = zoned(Date.now(), tz);
    return res.json({ skipped: `no report due at ${String(z.h).padStart(2, "0")}:${String(z.m).padStart(2, "0")} ${tz}` });
  }
  const out = await runSlot(win, tz, { force: manual });
  res.json(out);
});

export default router;

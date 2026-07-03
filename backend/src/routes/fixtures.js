import express from "express";
import { cacheGet, cacheSet, TTL } from "../services/cache.js";
import {
  fetchLeagueSeason,
  fetchScheduledEvents,
  fetchPastEvents,
  fetchTeamLastMatches,
  fetchFixtureLineups,
  fetchPlayerSeasonStats,
  fetchFixtureTeams,
  fetchTeamSquadByMinutes,
  fetchFixtureStats,
  fetchFixtureOdds,
  fetchFixtureInjuries,
  fetchLiveFixtures,
  fetchFixturesByDate,
} from "../services/apifootball.js";
import { computePrediction, parseFormFromEvents, blendPrediction, leagueBaselines } from "../services/predictions.js";
import { playerProps } from "../services/players.js";
import { foulMatchups } from "../services/positional.js";
import { teamCornerRates, computeCornerPrediction } from "../services/corners.js";
import {
  reconstructFormBefore,
  gradeMatch,
  summarizeAccuracy,
} from "../services/backtest.js";
import { buildAccumulators, buildLegPool } from "../services/accumulator.js";
import { buildVipSlips, goalWinCandidates, VIP_MIN_PROB, VIP_MAX_PROB, MARQUEE_LEAGUES } from "../services/vipbet.js";
import { settleSlips, settleSingles, dayProfit } from "../services/roi.js";
import { buildValueBets, bestBookOddsForLeg } from "../services/valuebets.js";
import { buildEloModel } from "../services/elo.js";
import { LEAGUES, LEAGUES_BY_ID } from "../data/leagues.js";

const router = express.Router();

router.get("/leagues", (req, res) => {
  res.json({ leagues: LEAGUES });
});

// Live scores across every league in ONE upstream call (/fixtures?live=all),
// cached ~25s so the whole audience polling every 30s collapses to roughly one
// upstream request per cycle. A short edge cache (set here; /live is exempt from
// the default long cache) does the same at the CDN.
router.get("/live", async (req, res) => {
  res.set("Cache-Control", "public, s-maxage=25, stale-while-revalidate=30");
  const cacheKey = "live:all";
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ live: cached, count: cached.length, fromCache: true });
  try {
    const live = await fetchLiveFixtures();
    cacheSet(cacheKey, live, 25); // seconds
    res.json({ live, count: live.length, fromCache: false });
  } catch (err) {
    console.error(`[live] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Per-league match counts for a date, so the sidebar can show how many games
// each league (and country) has that day. One upstream /fixtures?date call per
// UTC day; we pull the target day plus its neighbours so tz-shifted kickoffs are
// counted under the right local date. Only our covered leagues are counted.
router.get("/counts", async (req, res) => {
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);

  const cacheKey = `counts:${targetDate}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  const shiftYmd = (ymd, days) => {
    const [y, m, d] = ymd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  };

  try {
    const utcDates = [shiftYmd(targetDate, -1), targetDate, shiftYmd(targetDate, 1)];
    const lists = await Promise.all(utcDates.map((d) => fetchFixturesByDate(d).catch(() => [])));
    const counts = {};
    for (const fx of lists.flat()) {
      const id = String(fx.leagueId);
      if (!LEAGUES_BY_ID[id] || !fx.startTimestamp) continue;
      if (formatDate(new Date(fx.startTimestamp * 1000), tz) !== targetDate) continue;
      counts[id] = (counts[id] || 0) + 1;
    }
    const result = { date: targetDate, counts };
    cacheSet(cacheKey, result, TTL.FIXTURES);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[counts] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

async function getCurrentSeason(tournamentId) {
  const cacheKey = `season:${tournamentId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await fetchLeagueSeason(tournamentId);
  const seasons = data?.seasons || [];
  const current = seasons[0];
  if (current) cacheSet(cacheKey, current, TTL.LEAGUES);
  return current;
}

async function getTeamForm(teamId) {
  const cacheKey = `form:${teamId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await fetchTeamLastMatches(teamId);
  const events = data?.events || [];
  const form = parseFormFromEvents(events, teamId);
  cacheSet(cacheKey, form, TTL.TEAM_FORM);
  return form;
}

// Batch + dedup team-form fetches for a whole matchday (Phase 2 batch fetch).
// Each team is fetched at most once; getTeamForm caches per team for 6h.
async function getFormsForTeams(teamIds) {
  const unique = [...new Set(teamIds.filter(Boolean))];
  const entries = await Promise.all(
    unique.map(async (id) => [id, await getTeamForm(id).catch(() => [])])
  );
  return Object.fromEntries(entries);
}

// Raw finished events for a team (NOT parsed to form). Backtesting needs the
// dated history so it can rebuild form as of any past kickoff.
async function getTeamEvents(teamId) {
  const cacheKey = `events:${teamId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await fetchTeamLastMatches(teamId);
  const events = data?.events || [];
  cacheSet(cacheKey, events, TTL.TEAM_FORM);
  return events;
}

async function getEventsForTeams(teamIds) {
  const unique = [...new Set(teamIds.filter(Boolean))];
  const entries = await Promise.all(
    unique.map(async (id) => [id, await getTeamEvents(id).catch(() => [])])
  );
  return Object.fromEntries(entries);
}

// Whole-season events for a league, used to replay Elo. API-Football returns
// the full season in a single response, so one call suffices. We cache only the
// PLAIN events array (NodeCache useClones would corrupt anything with
// functions/Maps), so the Elo model is rebuilt cheaply from this on each call.
async function getLeaguePastEvents(leagueId, seasonId) {
  const cacheKey = `past-events:${leagueId}:${seasonId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await fetchPastEvents(leagueId, seasonId, 0).catch(() => ({ events: [] }));
  const events = data.events || [];
  cacheSet(cacheKey, events, TTL.TEAM_FORM);
  return events;
}

// Build (or rebuild) the league's Elo model from its cached season events. The
// model holds functions/Maps so it is NEVER cached directly — only the plain
// events feeding it are. The O(n) replay is cheap.
async function getLeagueElo(leagueId, seasonId) {
  const events = await getLeaguePastEvents(leagueId, seasonId);
  return buildEloModel(events);
}

// The league's own home/away goal baselines (per-league calibration), from its
// cached season events. Cheap to recompute; reuses the same cached events as Elo.
async function getLeagueBaselines(leagueId, seasonId) {
  const events = await getLeaguePastEvents(leagueId, seasonId);
  return leagueBaselines(events);
}

// One player's summed season stats, cached per player+season (these are stable,
// so a long TTL keeps the player-props fan-out cheap). For World Cup props the
// caller passes a CLUB season; if that season has no minutes (e.g. a league
// that runs on the calendar year) we fall back to the prior season so the rate
// isn't silently zero. Resolved value is cached under the requested season key.
async function getPlayerSeasonStats(playerId, season) {
  const cacheKey = `player-stats:${playerId}:${season}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let stat = await fetchPlayerSeasonStats(playerId, season).catch(() => null);
  if (!stat || !stat.minutes) {
    const prev = await fetchPlayerSeasonStats(playerId, season - 1).catch(() => null);
    if (prev && prev.minutes) stat = prev;
  }
  cacheSet(cacheKey, stat || null, TTL.TEAM_FORM);
  return stat;
}

// A team's most-used players when no official lineup exists yet (for a national
// team, the most-capped regulars). Returns a POOL of 16 so the caller can drop
// injured/suspended players and still field a projected XI of 11. Cached per
// team+season.
async function getProjectedXI(teamId, season) {
  const cacheKey = `squad-pool:${teamId}:${season}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const squad = await fetchTeamSquadByMinutes(teamId, season).catch(() => []);
  const xi = squad.slice(0, 16).map((p) => ({ id: p.id, name: p.name, number: null, pos: p.pos }));
  cacheSet(cacheKey, xi, TTL.TEAM_FORM);
  return xi;
}

// Per-team corner counts for one finished fixture. Finished-match stats never
// change, so this is cached aggressively and reused across every team that
// played in the fixture and across days.
async function getFixtureStats(fixtureId) {
  const cacheKey = `fx-stats:${fixtureId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const stats = await fetchFixtureStats(fixtureId).catch(() => null);
  cacheSet(cacheKey, stats || null, TTL.LEAGUES);
  return stats;
}

// A team's recent corners-for / corners-against averages, built from the corner
// totals of its last finished matches (those that actually carry stats). Reuses
// the already-cached team event history; only the per-fixture stats are new
// calls, and those are cached for a day. Cached per team for the form TTL.
async function getTeamCornerRates(teamId) {
  const cacheKey = `corner-rates:${teamId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const events = await getTeamEvents(teamId);
  const recent = [...events]
    .filter((e) => e.status?.type === "finished" && e.id)
    .sort((a, b) => (b.startTimestamp ?? 0) - (a.startTimestamp ?? 0))
    .slice(0, 8);

  const samples = [];
  for (const e of recent) {
    const isHome = e.homeTeam?.id === teamId;
    const oppId = isHome ? e.awayTeam?.id : e.homeTeam?.id;
    const stats = await getFixtureStats(e.id);
    const cf = stats?.[teamId];
    const ca = oppId != null ? stats?.[oppId] : null;
    if (cf != null && ca != null) samples.push({ for: cf, against: ca });
  }

  const rates = teamCornerRates(samples);
  cacheSet(cacheKey, rates, TTL.TEAM_FORM);
  return rates;
}

// Best-price bookmaker odds for one fixture (parsed to the markets the model
// prices). Cached per fixture for the fixtures TTL — odds drift, but a short
// cache keeps the day's value scan from re-hitting the feed for every viewer.
// Returns null (also cached) when no odds are published for the fixture.
async function getFixtureOdds(fixtureId) {
  const cacheKey = `odds:${fixtureId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const odds = await fetchFixtureOdds(fixtureId).catch(() => null);
  cacheSet(cacheKey, odds || null, TTL.FIXTURES);
  return odds;
}

// Injured/suspended players for a fixture, grouped by side. Cached per fixture
// for the form TTL (injury news moves slowly). Returns { home:[], away:[] } of
// players who are definitely OUT ("Missing Fixture"); doubtful players are kept
// separately under `.doubtful`.
// Raw injury rows for a fixture (with player ids), cached. Used both to display
// the unavailable list and to drop those players from a projected XI.
async function getFixtureInjuryRows(fixtureId) {
  const cacheKey = `injuries:${fixtureId}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;
  const rows = await fetchFixtureInjuries(fixtureId).catch(() => []);
  cacheSet(cacheKey, rows, TTL.TEAM_FORM);
  return rows;
}

// Player ids who are DEFINITELY out for a fixture (injured/suspended, not merely
// doubtful) — used to exclude them from the projected XI.
async function getFixtureOutIds(fixtureId) {
  const rows = await getFixtureInjuryRows(fixtureId).catch(() => []);
  return new Set(rows.filter((r) => !/quest/i.test(r.type || "")).map((r) => r.playerId));
}

async function getFixtureInjuries(fixtureId, homeId, awayId) {
  const rows = await getFixtureInjuryRows(fixtureId);
  if (!rows.length) return null;
  const out = { home: [], away: [], doubtful: { home: [], away: [] } };
  for (const r of rows) {
    const side = r.teamId === homeId ? "home" : r.teamId === awayId ? "away" : null;
    if (!side) continue;
    const entry = { name: r.playerName, reason: r.reason };
    if (/quest/i.test(r.type || "")) out.doubtful[side].push(entry);
    else out[side].push(entry);
  }
  if (!out.home.length && !out.away.length && !out.doubtful.home.length && !out.doubtful.away.length) return null;
  return out;
}

// Decorate each leg of a set of slips with the best bookmaker price for its
// market, so the UI can show real odds next to the model's fair odds. Fetches
// odds once per unique fixture in the slips (cached), then maps each leg to its
// market via bestBookOddsForLeg. Legs whose market isn't in the feed (corners)
// or whose fixture has no published odds are simply left without book prices.
async function attachBookOddsToSlips(slips, leagues) {
  const fxById = {};
  for (const g of leagues || []) for (const fx of g.fixtures || []) fxById[fx.id] = fx;

  const ids = new Set();
  for (const slip of slips || []) for (const leg of slip.legs || []) ids.add(leg.matchId);

  const oddsById = {};
  for (const id of ids) {
    const o = await getFixtureOdds(id).catch(() => null);
    if (o) oddsById[id] = o;
  }

  for (const slip of slips || []) {
    for (const leg of slip.legs || []) {
      const odds = oddsById[leg.matchId];
      const fx = fxById[leg.matchId];
      if (!odds || !fx) continue;
      const best = bestBookOddsForLeg(odds.best, leg, fx.prediction?.markets?.winner);
      if (best) {
        leg.bookOdds = best.odds;
        leg.bookmaker = best.book;
      }
    }
  }
}

// Pull each starter's club-season stats and keep the lineup fields (grid/pos)
// the positional foul model needs. Sequential to respect the rate gate.
async function gatherStarters(starters, clubSeason) {
  const out = [];
  for (const pl of starters) {
    if (!pl.id) continue;
    const stat = await getPlayerSeasonStats(pl.id, clubSeason);
    const dribbles90 = stat && stat.minutes ? stat.dribbles / (stat.minutes / 90) : 0;
    out.push({
      id: pl.id,
      name: stat?.name || pl.name,
      number: pl.number ?? null,
      pos: pl.pos || stat?.pos || null,
      grid: pl.grid || null,
      photo: stat?.photo || `https://media.api-sports.io/football/players/${pl.id}.png`,
      stat,
      dribbles90,
    });
  }
  return out;
}

// Turn gathered starters into prop rows, applying any positional foul multiplier
// (keyed by player id) from foulMatchups().
function rowsFromStarters(starters, matchups = {}) {
  return starters.map((p) => {
    const m = matchups[p.id] || null;
    return {
      id: p.id,
      name: p.name,
      number: p.number,
      pos: p.pos,
      photo: p.photo,
      props: playerProps(p.stat, { foulMultiplier: m?.foulMultiplier }),
      // Only the opponent name ships — the multiplier/dribbles metrics that
      // reveal the model stay server-side.
      foulMatchup: m ? { opponent: m.opponent } : null,
    };
  });
}

// Format a Date as YYYY-MM-DD. When an IANA timezone is given (e.g.
// "America/New_York"), the calendar day is resolved IN THAT ZONE rather than
// in the server's local time. This matters because Vercel runs functions in
// UTC: without it, a late-evening US match (which is already past midnight UTC)
// gets bucketed onto the next day for the viewer.
function formatDate(d, tz) {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(d);
      const get = (t) => parts.find((p) => p.type === t)?.value;
      return `${get("year")}-${get("month")}-${get("day")}`;
    } catch {
      // Invalid/unknown timezone — fall through to server-local formatting.
    }
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Build one league's fixtures (with form-based predictions) for a single day.
// Shared by /fixtures/:leagueId and the cross-league /today aggregation, with
// a per-league-per-day cache so /today reuses anything already fetched.
async function buildLeagueDay(leagueId, targetDate, tz) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league) return null;

  const cacheKey = `fixtures:${leagueId}:${targetDate}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const season = await getCurrentSeason(leagueId);
  if (!season) return { league, date: targetDate, season: null, fixtures: [], fromCache: false };

  const data = await fetchScheduledEvents(leagueId, season.id);
  const allEvents = data?.events || [];

  const isTodayTarget = targetDate === formatDate(new Date(), tz);
  const LIVE_LOOKBACK_MS = 4 * 3600 * 1000; // ~a match's length + stoppage/ET
  const dayEvents = allEvents.filter((e) => {
    if (!e.startTimestamp) return false;
    if (formatDate(new Date(e.startTimestamp * 1000), tz) === targetDate) return true;
    // A late game that kicked off shortly before this day may still be in play
    // (running past midnight). Its kickoff date is "yesterday", so it would
    // otherwise vanish from today's slate. Keep recently-started, not-finished
    // matches when viewing the current day; the frontend classifies them live.
    if (!isTodayTarget) return false;
    const age = Date.now() - e.startTimestamp * 1000;
    return age > 0 && age < LIVE_LOOKBACK_MS && e.status?.type !== "finished";
  });

  const fixtures = dayEvents.map((e) => ({
    id: e.id,
    homeTeam: { id: e.homeTeam?.id, name: e.homeTeam?.name, shortName: e.homeTeam?.shortName, logo: e.homeTeam?.id ? `https://media.api-sports.io/football/teams/${e.homeTeam.id}.png` : null },
    awayTeam: { id: e.awayTeam?.id, name: e.awayTeam?.name, shortName: e.awayTeam?.shortName, logo: e.awayTeam?.id ? `https://media.api-sports.io/football/teams/${e.awayTeam.id}.png` : null },
    startTimestamp: e.startTimestamp,
    status: e.status?.type,
    homeScore: e.homeScore?.current ?? null,
    awayScore: e.awayScore?.current ?? null,
    venue: e.venue?.name || null,
    round: e.roundInfo?.round || null,
  }));

  // Attach a form-based prediction (incl. goal markets) to every fixture. We
  // reconstruct each team's form AS OF KICKOFF — not "current" form — so the
  // prediction is FROZEN: once a match kicks off, its numbers can never change,
  // and in particular a match that finishes today can't pull its own result
  // into the teams' recent form. This is the exact leak-free computation the
  // results/record views use, so a fixture reads identically before and after
  // it's played.
  const eventsMap = await getEventsForTeams(
    fixtures.flatMap((f) => [f.homeTeam.id, f.awayTeam.id])
  );
  // Season Elo ratings (second model) for the blend. Failure falls back to the
  // form-only prediction so one bad upstream never blanks the matchday.
  const elo = await getLeagueElo(leagueId, season.id).catch(() => null);
  const baselines = await getLeagueBaselines(leagueId, season.id).catch(() => null);
  // Per-fixture enrichment, gated to skip calls that add no value (cold-build
  // cost control):
  //   • odds — bookmakers don't price friendlies or the very lowest tiers, so a
  //     call there just wastes a rate-gate slot. Skip noProps + tier ≥ 4.
  //   • injuries — only meaningful/available for the top competitions, so limit
  //     to the marquee leagues rather than fetching for every fixture everywhere.
  const wantOdds = !league.noProps && (league.tier ?? 1) < 4;
  const wantInjuries = MARQUEE_LEAGUES.has(String(leagueId));
  const oddsMap = {};
  const injMap = {};
  await Promise.all(
    fixtures
      .filter((f) => f.status !== "finished" && f.homeTeam.id && f.awayTeam.id)
      .flatMap((f) => {
        const tasks = [];
        if (wantOdds) tasks.push(getFixtureOdds(f.id).then((o) => { oddsMap[f.id] = o; }).catch(() => {}));
        if (wantInjuries) tasks.push(getFixtureInjuries(f.id, f.homeTeam.id, f.awayTeam.id).then((i) => { injMap[f.id] = i; }).catch(() => {}));
        return tasks;
      })
  );
  for (const fx of fixtures) {
    if (!fx.homeTeam.id || !fx.awayTeam.id) {
      fx.prediction = null;
      continue;
    }
    const homeForm = reconstructFormBefore(eventsMap[fx.homeTeam.id] || [], fx.homeTeam.id, fx.startTimestamp);
    const awayForm = reconstructFormBefore(eventsMap[fx.awayTeam.id] || [], fx.awayTeam.id, fx.startTimestamp);
    const eloRatings = elo
      ? { home: elo.ratingBefore(fx.homeTeam.id, fx.startTimestamp), away: elo.ratingBefore(fx.awayTeam.id, fx.startTimestamp) }
      : null;
    fx.prediction = computePrediction(homeForm, awayForm, eloRatings, baselines);
    if (oddsMap[fx.id]) fx.prediction = blendPrediction(fx.prediction, oddsMap[fx.id]);
    if (injMap[fx.id]) fx.injuries = injMap[fx.id];
  }

  const result = { league, date: targetDate, season: season.name, fixtures };
  cacheSet(cacheKey, result, TTL.FIXTURES);
  return { ...result, fromCache: false };
}

// Build one league's FINISHED matches for a day, each graded: the model's
// prediction (rebuilt from pre-kickoff form) vs the real result. Shared by
// /results/:leagueId and the cross-league /results aggregation.
async function buildLeagueResults(leagueId, targetDate, tz) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league) return null;

  const cacheKey = `results:${leagueId}:${targetDate}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  const season = await getCurrentSeason(leagueId);
  if (!season) return { league, date: targetDate, season: null, matches: [], accuracy: null, fromCache: false };

  // Past matches feed (page 0 covers the most recent; page 1 for safety near
  // the boundary of a busy day).
  const [p0, p1] = await Promise.all([
    fetchPastEvents(leagueId, season.id, 0).catch(() => ({ events: [] })),
    fetchPastEvents(leagueId, season.id, 1).catch(() => ({ events: [] })),
  ]);
  const allEvents = [...(p0.events || []), ...(p1.events || [])];

  const dayEvents = allEvents.filter((e) => {
    if (!e.startTimestamp || e.status?.type !== "finished") return false;
    if (e.homeScore?.current == null || e.awayScore?.current == null) return false;
    return formatDate(new Date(e.startTimestamp * 1000), tz) === targetDate;
  });

  const eventsMap = await getEventsForTeams(
    dayEvents.flatMap((e) => [e.homeTeam?.id, e.awayTeam?.id])
  );
  // Season Elo for the blend, with leak-free pre-kickoff rating snapshots.
  const elo = await getLeagueElo(leagueId, season.id).catch(() => null);
  const baselines = await getLeagueBaselines(leagueId, season.id).catch(() => null);

  const matches = dayEvents.map((e) => {
    const homeId = e.homeTeam?.id;
    const awayId = e.awayTeam?.id;
    const homeScore = e.homeScore.current;
    const awayScore = e.awayScore.current;

    const base = {
      id: e.id,
      homeTeam: { id: homeId, name: e.homeTeam?.name, shortName: e.homeTeam?.shortName, logo: homeId ? `https://media.api-sports.io/football/teams/${homeId}.png` : null },
      awayTeam: { id: awayId, name: e.awayTeam?.name, shortName: e.awayTeam?.shortName, logo: awayId ? `https://media.api-sports.io/football/teams/${awayId}.png` : null },
      startTimestamp: e.startTimestamp,
      homeScore,
      awayScore,
      round: e.roundInfo?.round || null,
    };

    if (!homeId || !awayId) return { ...base, prediction: null, grade: null };

    const homeForm = reconstructFormBefore(eventsMap[homeId] || [], homeId, e.startTimestamp);
    const awayForm = reconstructFormBefore(eventsMap[awayId] || [], awayId, e.startTimestamp);
    const eloRatings = elo
      ? { home: elo.ratingBefore(homeId, e.startTimestamp), away: elo.ratingBefore(awayId, e.startTimestamp) }
      : null;
    const prediction = computePrediction(homeForm, awayForm, eloRatings, baselines);
    const grade = prediction.markets
      ? gradeMatch(prediction.markets, homeScore, awayScore)
      : null;

    return { ...base, prediction, grade };
  });

  const graded = matches.filter((m) => m.grade).map((m) => m.grade);
  const accuracy = graded.length ? summarizeAccuracy(graded) : null;

  const result = { league, date: targetDate, season: season.name, matches, accuracy };
  cacheSet(cacheKey, result, TTL.FIXTURES);
  return { ...result, fromCache: false };
}

// One league's fixtures for ANY date in a single { league, season, fixtures }
// shape. Upcoming/today come from the live matchday feed; PAST dates come from
// the results engine (leak-free pre-kickoff predictions + grading) mapped into
// the same fixture shape, so the matchday UI can browse backwards through
// history and show how each call actually landed.
async function buildLeagueDayAny(leagueId, targetDate, tz) {
  const today = formatDate(new Date(), tz);
  if (targetDate >= today) return buildLeagueDay(leagueId, targetDate, tz);

  const r = await buildLeagueResults(leagueId, targetDate, tz);
  if (!r) return null;
  const fixtures = (r.matches || []).map((m) => ({
    id: m.id,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    startTimestamp: m.startTimestamp,
    status: "finished",
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    round: m.round,
    prediction: m.prediction,
    grade: m.grade, // carries per-market hit/miss so the card can show outcomes
  }));
  return { league: r.league, date: targetDate, season: r.season, fixtures, fromCache: r.fromCache };
}

// Build a league's graded finished matches across a WINDOW of days at once.
// Unlike calling buildLeagueResults per day, this fetches the league's season
// events a single time (getLeaguePastEvents is cached) and buckets matches by
// day locally, so a 14- or 30-day summary costs roughly the same upstream as a
// single day. Returns { perDay: {date -> [grades]}, grades: [all grades] }.
async function buildLeagueWindow(leagueId, dateSet, tz) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league) return null;

  const season = await getCurrentSeason(leagueId);
  if (!season) return null;

  const events = await getLeaguePastEvents(leagueId, season.id);

  // Keep only finished, scored matches whose day falls inside the window.
  const inWindow = events.filter((e) => {
    if (!e.startTimestamp || e.status?.type !== "finished") return false;
    if (e.homeScore?.current == null || e.awayScore?.current == null) return false;
    return dateSet.has(formatDate(new Date(e.startTimestamp * 1000), tz));
  });
  if (!inWindow.length) return { perDay: {}, grades: [] };

  const eventsMap = await getEventsForTeams(
    inWindow.flatMap((e) => [e.homeTeam?.id, e.awayTeam?.id])
  );
  const elo = await getLeagueElo(leagueId, season.id).catch(() => null);
  const baselines = await getLeagueBaselines(leagueId, season.id).catch(() => null);

  const perDay = {};
  const grades = [];
  for (const e of inWindow) {
    const homeId = e.homeTeam?.id;
    const awayId = e.awayTeam?.id;
    if (!homeId || !awayId) continue;

    const homeForm = reconstructFormBefore(eventsMap[homeId] || [], homeId, e.startTimestamp);
    const awayForm = reconstructFormBefore(eventsMap[awayId] || [], awayId, e.startTimestamp);
    const eloRatings = elo
      ? { home: elo.ratingBefore(homeId, e.startTimestamp), away: elo.ratingBefore(awayId, e.startTimestamp) }
      : null;
    const prediction = computePrediction(homeForm, awayForm, eloRatings, baselines);
    if (!prediction.markets) continue;

    const grade = gradeMatch(prediction.markets, e.homeScore.current, e.awayScore.current);
    const day = formatDate(new Date(e.startTimestamp * 1000), tz);
    (perDay[day] ||= []).push(grade);
    grades.push(grade);
  }

  return { perDay, grades };
}

// Like buildLeagueWindow, but buckets full graded MATCH objects (teams +
// prediction + grade) per day instead of bare grades — enough for the ROI
// tracker to rebuild that day's Safe Bets slips and single Top Picks. Still one
// season fetch per league (cached), so a 30-day window stays cheap upstream.
async function buildLeagueResultsWindow(leagueId, dateSet, tz) {
  const league = LEAGUES_BY_ID[leagueId];
  if (!league) return null;

  const season = await getCurrentSeason(leagueId);
  if (!season) return null;

  const events = await getLeaguePastEvents(leagueId, season.id);
  const inWindow = events.filter((e) => {
    if (!e.startTimestamp || e.status?.type !== "finished") return false;
    if (e.homeScore?.current == null || e.awayScore?.current == null) return false;
    if (!e.homeTeam?.id || !e.awayTeam?.id) return false;
    return dateSet.has(formatDate(new Date(e.startTimestamp * 1000), tz));
  });
  if (!inWindow.length) return { league, perDay: {} };

  const eventsMap = await getEventsForTeams(
    inWindow.flatMap((e) => [e.homeTeam?.id, e.awayTeam?.id])
  );
  const elo = await getLeagueElo(leagueId, season.id).catch(() => null);
  const baselines = await getLeagueBaselines(leagueId, season.id).catch(() => null);

  const perDay = {};
  for (const e of inWindow) {
    const homeId = e.homeTeam.id;
    const awayId = e.awayTeam.id;
    const homeForm = reconstructFormBefore(eventsMap[homeId] || [], homeId, e.startTimestamp);
    const awayForm = reconstructFormBefore(eventsMap[awayId] || [], awayId, e.startTimestamp);
    const eloRatings = elo
      ? { home: elo.ratingBefore(homeId, e.startTimestamp), away: elo.ratingBefore(awayId, e.startTimestamp) }
      : null;
    const prediction = computePrediction(homeForm, awayForm, eloRatings, baselines);
    if (!prediction.markets) continue;
    const grade = gradeMatch(prediction.markets, e.homeScore.current, e.awayScore.current);

    const match = {
      id: e.id,
      startTimestamp: e.startTimestamp,
      homeScore: e.homeScore.current,
      awayScore: e.awayScore.current,
      homeTeam: { id: homeId, name: e.homeTeam.name, shortName: e.homeTeam.shortName, logo: `https://media.api-sports.io/football/teams/${homeId}.png` },
      awayTeam: { id: awayId, name: e.awayTeam.name, shortName: e.awayTeam.shortName, logo: `https://media.api-sports.io/football/teams/${awayId}.png` },
      prediction,
      grade,
    };
    const day = formatDate(new Date(e.startTimestamp * 1000), tz);
    (perDay[day] ||= []).push(match);
  }

  return { league, perDay };
}

// Multi-day aggregate accuracy: pool every league's graded finished matches
// over a trailing window so Brier/calibration are read off hundreds of calls
// instead of one noisy day. Also returns a per-day trend. The window ENDS
// yesterday (today's matches may be unfinished).
router.get("/results/summary", async (req, res) => {
  const tz = req.query.tz;
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 30);

  // Build the set of in-window day strings, ending yesterday.
  const dates = [];
  const dateSet = new Set();
  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = formatDate(d, tz);
    dates.push(key);
    dateSet.add(key);
  }
  dates.sort(); // ascending for the trend

  const cacheKey = `results-summary:${days}:${dates[0]}:${dates[dates.length - 1]}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // Sequential per-league so we stay under the upstream rate gate; each
    // league fetches its season feed once.
    const windows = [];
    for (const l of LEAGUES) {
      const w = await buildLeagueWindow(l.id, dateSet, tz).catch((e) => {
        console.error(`[results-summary] ${l.id}: ${e.message}`);
        return null;
      });
      if (w) windows.push(w);
    }

    const allGrades = windows.flatMap((w) => w.grades);
    const accuracy = allGrades.length ? summarizeAccuracy(allGrades) : null;

    // Per-day trend: hit-rate + Brier for each day in the window.
    const byDay = {};
    for (const w of windows) {
      for (const [day, grades] of Object.entries(w.perDay)) {
        (byDay[day] ||= []).push(...grades);
      }
    }
    const trend = dates.map((date) => {
      const grades = byDay[date] || [];
      const s = grades.length ? summarizeAccuracy(grades) : null;
      return {
        date,
        matches: grades.length,
        pct: s?.overall.pct ?? null,
        brier: s?.overall.brier ?? null,
      };
    });

    const totalMatches = allGrades.length;
    const result = { window: { days, from: dates[0], to: dates[dates.length - 1] }, totalMatches, accuracy, trend };
    cacheSet(cacheKey, result, TTL.TEAM_FORM);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[results-summary] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Betting P&L over a trailing window: rebuild each past day's Safe Bets slips and
// single Top Picks, grade them against real results, and settle at fair odds for
// an honest (conservative) ROI. Window ENDS yesterday — today may be unfinished.
router.get("/roi", async (req, res) => {
  const tz = req.query.tz;
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 30);

  const dates = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(formatDate(d, tz));
  }
  dates.sort();

  const dateSet = new Set(dates);
  const cacheKey = `roi:${days}:${dates[0]}:${dates[dates.length - 1]}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // One season fetch per league (cached), bucketed by day. Sequential per
    // league to respect the upstream rate gate.
    const windows = [];
    for (const l of LEAGUES) {
      const w = await buildLeagueResultsWindow(l.id, dateSet, tz).catch((e) => {
        console.error(`[roi] ${l.id}: ${e.message}`);
        return null;
      });
      if (w) windows.push(w);
    }

    const allSlips = [];
    const allSingles = [];
    const perDay = {};

    // Rebuild each day's slips/singles from every league that played that day.
    for (const date of dates) {
      const leagues = windows
        .map((w) => ({ league: w.league, fixtures: w.perDay[date] || [] }))
        .filter((g) => g.fixtures.length);

      if (!leagues.length) { perDay[date] = { profit: 0, bets: 0 }; continue; }

      const slips = buildAccumulators(leagues);
      const singles = buildLegPool(leagues);
      allSlips.push(...slips);
      allSingles.push(...singles);
      perDay[date] = dayProfit(slips);
    }

    const safeBets = settleSlips(allSlips);
    const topPicks = settleSingles(allSingles);

    // Cumulative Safe Bets profit per day, for the trend line.
    let cum = 0;
    const trend = dates.map((date) => {
      const d = perDay[date] || { profit: 0, bets: 0 };
      cum = Math.round((cum + d.profit) * 100) / 100;
      return { date, profit: d.profit, cumulative: cum, bets: d.bets };
    });

    const result = {
      window: { days, from: dates[0], to: dates[dates.length - 1] },
      products: { safeBets, topPicks },
      trend,
    };
    cacheSet(cacheKey, result, TTL.TEAM_FORM);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[roi] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get("/fixtures/:leagueId", async (req, res) => {
  const { leagueId } = req.params;
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);

  if (!LEAGUES_BY_ID[leagueId]) return res.status(404).json({ error: "League not found" });

  try {
    const result = await buildLeagueDayAny(leagueId, targetDate, tz);
    res.json(result);
  } catch (err) {
    console.error(`[fixtures] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get("/results/:leagueId", async (req, res) => {
  const { leagueId } = req.params;
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);

  if (!LEAGUES_BY_ID[leagueId]) return res.status(404).json({ error: "League not found" });

  try {
    const result = await buildLeagueResults(leagueId, targetDate, tz);
    res.json(result);
  } catch (err) {
    console.error(`[results] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Cross-league results/track-record view: every league's graded finished
// matches for one day, plus an aggregate accuracy across all of them.
router.get("/results", async (req, res) => {
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);

  const cacheKey = `results-all:${targetDate}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const groups = await Promise.all(
      LEAGUES.map((l) =>
        buildLeagueResults(l.id, targetDate, tz).catch((e) => {
          console.error(`[results-all] ${l.id}: ${e.message}`);
          return null;
        })
      )
    );

    const leagues = groups
      .filter((g) => g && g.matches && g.matches.length)
      .map((g) => ({ league: g.league, season: g.season, matches: g.matches, accuracy: g.accuracy }))
      .sort((a, b) => b.matches.length - a.matches.length);

    const allGrades = leagues.flatMap((g) => g.matches.filter((m) => m.grade).map((m) => m.grade));
    const totalMatches = leagues.reduce((n, g) => n + g.matches.length, 0);
    const accuracy = allGrades.length ? summarizeAccuracy(allGrades) : null;

    const result = { date: targetDate, totalMatches, accuracy, leagues };
    cacheSet(cacheKey, result, TTL.FIXTURES);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[results-all] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Cross-league "today" view: every league's fixtures for one day, grouped by
// league and ordered by match count. Per-league failures are skipped so one
// bad upstream doesn't sink the whole page.
router.get("/today", async (req, res) => {
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);

  const cacheKey = `today:${targetDate}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const groups = await Promise.all(
      LEAGUES.map((l) =>
        buildLeagueDayAny(l.id, targetDate, tz).catch((e) => {
          console.error(`[today] ${l.id}: ${e.message}`);
          return null;
        })
      )
    );

    const leagues = groups
      .filter((g) => g && g.fixtures && g.fixtures.length)
      .map((g) => ({ league: g.league, season: g.season, fixtures: g.fixtures }))
      .sort((a, b) => b.fixtures.length - a.fixtures.length);

    const totalMatches = leagues.reduce((n, g) => n + g.fixtures.length, 0);
    const result = { date: targetDate, totalMatches, leagues };
    cacheSet(cacheKey, result, TTL.FIXTURES);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[today] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Cross-league "safe bets" view: from every scheduled match today, take the
// single market the model is most confident in, then stack the safest of those
// into accumulators that land in preset combined-odds ranges (3-5, 7-10).
router.get("/accumulators", async (req, res) => {
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);

  const cacheKey = `acca:${targetDate}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // buildLeagueDay is cached per league-day, so this reuses anything the
    // /today view already fetched.
    const groups = await Promise.all(
      LEAGUES.map((l) =>
        buildLeagueDay(l.id, targetDate, tz).catch((e) => {
          console.error(`[acca] ${l.id}: ${e.message}`);
          return null;
        })
      )
    );

    const leagues = groups
      .filter((g) => g && g.fixtures && g.fixtures.length)
      .map((g) => ({ league: g.league, fixtures: g.fixtures }));

    const totalMatches = leagues.reduce((n, g) => n + g.fixtures.length, 0);
    const slips = buildAccumulators(leagues);
    await attachBookOddsToSlips(slips, leagues);

    const result = { date: targetDate, totalMatches, slips };
    cacheSet(cacheKey, result, TTL.FIXTURES);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[acca] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Track record for the "safe bets" slips: rebuild the same accumulators from a
// past day's FINISHED matches (predictions reconstructed from pre-kickoff form)
// and grade each leg against the real result, so a slip reads as won/lost.
router.get("/accumulators/results", async (req, res) => {
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);

  const cacheKey = `acca-results:${targetDate}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const groups = await Promise.all(
      LEAGUES.map((l) =>
        buildLeagueResults(l.id, targetDate, tz).catch((e) => {
          console.error(`[acca-results] ${l.id}: ${e.message}`);
          return null;
        })
      )
    );

    const leagues = groups
      .filter((g) => g && g.matches && g.matches.length)
      .map((g) => ({ league: g.league, fixtures: g.matches }));

    const totalMatches = leagues.reduce((n, g) => n + g.fixtures.length, 0);
    const slips = buildAccumulators(leagues);

    const result = { date: targetDate, totalMatches, slips };
    cacheSet(cacheKey, result, TTL.FIXTURES);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[acca-results] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Cross-league "VIP" view: a small, high-odds curated slip. Unlike Safe Bets
// (one safest market per game, stacked deep), VIP picks the BEST-ODDS qualifying
// market per game — including first-half corner legs — and keeps only a handful.
// Corner legs cost upstream calls, so they're fetched for a bounded shortlist:
// the most confident goal/result fixtures of the day, capped.
router.get("/vip", async (req, res) => {
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);

  const cacheKey = `vip:${targetDate}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // Reuses the per-league-day cache shared with /today and /accumulators.
    const groups = await Promise.all(
      LEAGUES.map((l) =>
        buildLeagueDay(l.id, targetDate, tz).catch((e) => {
          console.error(`[vip] ${l.id}: ${e.message}`);
          return null;
        })
      )
    );

    const leagues = groups
      .filter((g) => g && g.fixtures && g.fixtures.length)
      .map((g) => ({ league: g.league, fixtures: g.fixtures }));

    const totalMatches = leagues.reduce((n, g) => n + g.fixtures.length, 0);

    // Shortlist for corner enrichment: upcoming fixtures whose best goal/result
    // pick already clears the confidence floor, most confident first, capped so
    // the corner fan-out stays bounded regardless of how busy the day is.
    const CORNER_SHORTLIST = 14;
    const ranked = [];
    for (const g of leagues) {
      for (const fx of g.fixtures) {
        if (fx.status === "finished") continue;
        if (!fx.homeTeam?.id || !fx.awayTeam?.id) continue;
        const best = goalWinCandidates(fx)
          .filter((c) => c.prob >= VIP_MIN_PROB && c.prob <= VIP_MAX_PROB)
          .reduce((a, b) => (!a || b.prob > a.prob ? b : a), null);
        if (best) ranked.push({ fx, prob: best.prob });
      }
    }
    ranked.sort((a, b) => b.prob - a.prob);
    const shortlist = ranked.slice(0, CORNER_SHORTLIST);

    const cornerMap = {};
    for (const { fx } of shortlist) {
      const [hRates, aRates] = await Promise.all([
        getTeamCornerRates(fx.homeTeam.id).catch(() => ({ for: null, against: null, games: 0 })),
        getTeamCornerRates(fx.awayTeam.id).catch(() => ({ for: null, against: null, games: 0 })),
      ]);
      if (hRates.games + aRates.games > 0) {
        cornerMap[fx.id] = computeCornerPrediction(hRates, aRates);
      }
    }

    // Two batches: a "Top Matches" slate from the marquee competitions (so the
    // headline games always feature, even when a high-scoring minor league
    // out-scores them on interest), and the general slate across every league.
    const marqueeLeagues = leagues.filter((g) => MARQUEE_LEAGUES.has(String(g.league.id)));
    const featured = buildVipSlips(marqueeLeagues, cornerMap, 6);
    const slips = buildVipSlips(leagues, cornerMap);
    await attachBookOddsToSlips(featured, marqueeLeagues);
    await attachBookOddsToSlips(slips, leagues);

    const result = { date: targetDate, totalMatches, featured, slips };
    cacheSet(cacheKey, result, TTL.FIXTURES);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[vip] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});


// Cross-league "value bets" view: for every scheduled match today, compare the
// model's probabilities against the best bookmaker price across all books and
// surface the positive-edge selections (model thinks it's likelier than the
// odds imply). One odds call per upcoming fixture, cached; finished matches are
// skipped. Sorted best-edge first.
router.get("/value", async (req, res) => {
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);

  const cacheKey = `value:${targetDate}:${tz || "server"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // Reuses the per-league-day cache shared with /today, /accumulators, /vip.
    const groups = await Promise.all(
      LEAGUES.map((l) =>
        buildLeagueDay(l.id, targetDate, tz).catch((e) => {
          console.error(`[value] ${l.id}: ${e.message}`);
          return null;
        })
      )
    );

    const leagues = groups
      .filter((g) => g && g.fixtures && g.fixtures.length)
      .map((g) => ({ league: g.league, fixtures: g.fixtures }));

    const totalMatches = leagues.reduce((n, g) => n + g.fixtures.length, 0);

    // Fetch odds only for upcoming, predictable fixtures (skip finished and any
    // without a prediction). getFixtureOdds is cached per fixture; the upstream
    // rate limiter serializes the calls so this stays within budget.
    const oddsMap = {};
    for (const g of leagues) {
      for (const fx of g.fixtures) {
        if (fx.status === "finished") continue;
        if (!fx.prediction?.markets || fx.prediction.home == null) continue;
        const odds = await getFixtureOdds(fx.id);
        if (odds) oddsMap[fx.id] = odds;
      }
    }

    const bets = buildValueBets(leagues, oddsMap);
    const result = {
      date: targetDate,
      totalMatches,
      pricedMatches: Object.keys(oddsMap).length,
      bets,
    };
    cacheSet(cacheKey, result, TTL.FIXTURES);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[value] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get("/fixtures/:leagueId/range", async (req, res) => {
  const { leagueId } = req.params;
  const { from, days = 7, tz } = req.query;

  const league = LEAGUES_BY_ID[leagueId];
  if (!league) return res.status(404).json({ error: "League not found" });

  const startDate = from ? new Date(from) : new Date();
  const results = [];

  try {
    const season = await getCurrentSeason(leagueId);
    if (!season) return res.status(404).json({ error: "No active season found" });

    const cacheKey = `range:${leagueId}:${formatDate(startDate, tz)}:${days}:${tz || "server"}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json({ ...cached, fromCache: true });

    const [page0, page1] = await Promise.all([
      fetchScheduledEvents(leagueId, season.id, 0).catch(() => ({ events: [] })),
      fetchScheduledEvents(leagueId, season.id, 1).catch(() => ({ events: [] })),
    ]);

    const allEvents = [...(page0.events || []), ...(page1.events || [])];
    const dateMap = {};

    for (let i = 0; i < Number(days); i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const key = formatDate(d, tz);
      dateMap[key] = [];
    }

    for (const e of allEvents) {
      if (!e.startTimestamp) continue;
      const d = formatDate(new Date(e.startTimestamp * 1000), tz);
      if (d in dateMap) {
        dateMap[d].push({
          id: e.id,
          homeTeam: { id: e.homeTeam?.id, name: e.homeTeam?.name, shortName: e.homeTeam?.shortName, logo: e.homeTeam?.id ? `https://media.api-sports.io/football/teams/${e.homeTeam.id}.png` : null },
          awayTeam: { id: e.awayTeam?.id, name: e.awayTeam?.name, shortName: e.awayTeam?.shortName, logo: e.awayTeam?.id ? `https://media.api-sports.io/football/teams/${e.awayTeam.id}.png` : null },
          startTimestamp: e.startTimestamp,
          status: e.status?.type,
          homeScore: e.homeScore?.current ?? null,
          awayScore: e.awayScore?.current ?? null,
          venue: e.venue?.name || null,
          round: e.roundInfo?.round || null,
        });
      }
    }

    const response = { league, season: season.name, range: { from: formatDate(startDate, tz), days: Number(days) }, days: dateMap };
    cacheSet(cacheKey, response, TTL.FIXTURES);
    res.json({ ...response, fromCache: false });
  } catch (err) {
    console.error(`[range] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get("/match/:matchId/prediction", async (req, res) => {
  const { matchId } = req.params;
  const { homeTeamId, awayTeamId } = req.query;

  if (!homeTeamId || !awayTeamId) {
    return res.status(400).json({ error: "homeTeamId and awayTeamId required" });
  }

  const cacheKey = `prediction:${homeTeamId}:${awayTeamId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const [homeData, awayData] = await Promise.all([
      fetchTeamLastMatches(homeTeamId).catch(() => ({ events: [] })),
      fetchTeamLastMatches(awayTeamId).catch(() => ({ events: [] })),
    ]);

    const homeForm = parseFormFromEvents(homeData.events || [], Number(homeTeamId));
    const awayForm = parseFormFromEvents(awayData.events || [], Number(awayTeamId));
    const prediction = computePrediction(homeForm, awayForm);

    cacheSet(cacheKey, prediction, TTL.TEAM_FORM);
    res.json({ ...prediction, fromCache: false });
  } catch (err) {
    console.error(`[prediction] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Player prop markets for one fixture (anytime scorer / to commit a foul / to
// be fouled / player tackle), built from the projected lineup and each
// starter's club-season per-90 rates. Aimed at World Cup matches, where the
// `season` query param is the CLUB season feeding the rates (e.g. 2025 for the
// 2026 tournament). This is LAZY: the UI only calls it when the player-props
// section is expanded, because it fans out to one /players request per starter.
// Build the player-prop markets for one fixture (cached). Official lineup XI
// when available, else a projected XI; the positional foul model runs across
// both sides in three phases — gather stats, compute matchups, price props.
// Shared by the /players route and the Props Finder.
async function getFixturePlayerProps(fixtureId, season) {
  const cacheKey = `player-props:${fixtureId}:${season}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const lineups = await fetchFixtureLineups(fixtureId);
  const hasLineups = lineups.length && lineups.some((l) => l.startXI.length);

  let meta = []; // [{ teamId, teamName, formation, starters }]
  let projected;
  if (hasLineups) {
    projected = false;
    for (const side of lineups) {
      meta.push({
        teamId: side.teamId,
        teamName: side.teamName,
        formation: side.formation,
        starters: await gatherStarters(side.startXI, season),
      });
    }
  } else {
    projected = true;
    const teams = await fetchFixtureTeams(fixtureId);
    if (!teams || (!teams.home.id && !teams.away.id)) {
      const out = { available: false, reason: "Lineup and squad data aren't available for this match yet." };
      cacheSet(cacheKey, out, TTL.FIXTURES);
      return out;
    }
    // Drop injured/suspended players from the projected XI so we never price a
    // player who won't be on the pitch (the official-lineup path already omits
    // them). Refilled to 11 from the next most-used players in the pool.
    const outIds = await getFixtureOutIds(fixtureId);
    for (const t of [teams.home, teams.away]) {
      if (!t.id) { meta.push(null); continue; }
      const pool = await getProjectedXI(t.id, season);
      const xi = pool.filter((p) => !outIds.has(p.id)).slice(0, 11);
      meta.push({ teamId: t.id, teamName: t.name, formation: null, starters: await gatherStarters(xi, season) });
    }
  }

  // Positional foul model — only fires with official lineups (grid present); a
  // projected XI has no grid, so foulMatchups returns {} (no adjustment).
  const matchups = foulMatchups(meta[0]?.starters || [], meta[1]?.starters || []);
  const sides = meta.map((s) =>
    s ? { teamId: s.teamId, teamName: s.teamName, formation: s.formation, players: rowsFromStarters(s.starters, matchups) } : null
  );

  const hasAny = sides.some((s) => s && s.players.some((p) => p.props));
  if (!hasAny) {
    const out = { available: false, reason: "Player stats aren't available for these squads yet." };
    cacheSet(cacheKey, out, TTL.FIXTURES);
    return out;
  }

  const out = { available: true, projected, season, home: sides[0] || null, away: sides[1] || null };
  cacheSet(cacheKey, out, TTL.FIXTURES);
  return out;
}

// Player prop markets for one fixture (anytime scorer / shots on target / fouls
// / tackles), each carrying its 1+/2+/3+ probabilities. LAZY — the UI only calls
// it when the player-props section is expanded.
router.get("/match/:fixtureId/players", async (req, res) => {
  const { fixtureId } = req.params;
  const season = parseInt(req.query.season, 10);
  if (!Number.isFinite(season)) {
    return res.status(400).json({ error: "season (club season year) required" });
  }
  try {
    const out = await getFixturePlayerProps(fixtureId, season);
    res.json({ ...out, fromCache: false });
  } catch (err) {
    console.error(`[player-props] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Props Finder: every starter across the day's upcoming matches with their
// 1+/2+/3+ probabilities, so the UI can rank by any stat + threshold without
// refetching. Heavy on a cold day (one player-props build per fixture) but
// cached per day, and each fixture's props are cached and shared with the cards.
//
// `within` (hours) and `match` (a fixture id) both narrow the fan-out BEFORE the
// expensive per-fixture props build: `within` keeps only matches kicking off
// within that horizon, `match` restricts to a single fixture. Narrowing here —
// not just in the UI — is what makes the view cheap (one props build per kept
// fixture), so the filters are part of the cache key.
router.get("/props-finder", async (req, res) => {
  const tz = req.query.tz;
  const targetDate = req.query.date || formatDate(new Date(), tz);
  const withinH = Number(req.query.within);
  const within = Number.isFinite(withinH) && withinH > 0 ? withinH : null;
  const matchId = req.query.match ? String(req.query.match) : null;
  const leagueId = req.query.league ? String(req.query.league) : null;
  // Upper bound only: a finite horizon keeps imminent + already-live matches and
  // drops ones that kick off many hours later. A single-match pick overrides the
  // horizon so a match outside the window can still be opened directly.
  const cutoff = within && !matchId ? Date.now() / 1000 + within * 3600 : Infinity;

  const cacheKey = `props-finder:${targetDate}:${tz || "server"}:${within || "all"}:${matchId || "all"}:${leagueId || "all"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const groups = await Promise.all(
      LEAGUES.map((l) =>
        buildLeagueDay(l.id, targetDate, tz).catch((e) => {
          console.error(`[props-finder] ${l.id}: ${e.message}`);
          return null;
        })
      )
    );
    // Leagues that opt out of player props (e.g. club friendlies) never appear
    // in the Props Finder — not in the selectors, not in the fan-out.
    const leagues = groups.filter((g) => g && g.fixtures && g.fixtures.length && !g.league.noProps);

    // Full list of today's upcoming matches and leagues (cheap — no props build),
    // so the UI can populate the match + league selectors with every fixture,
    // including ones outside the current time window.
    const matches = [];
    const leagueMap = new Map();
    for (const g of leagues) {
      let leagueHasUpcoming = false;
      for (const fx of g.fixtures) {
        if (!fx.id || fx.status === "finished") continue;
        leagueHasUpcoming = true;
        matches.push({
          id: fx.id,
          home: fx.homeTeam?.name,
          away: fx.awayTeam?.name,
          league: g.league.name,
          leagueId: g.league.id,
          leagueFlag: g.league.flag,
          kickoff: fx.startTimestamp,
        });
      }
      if (leagueHasUpcoming && !leagueMap.has(g.league.id)) {
        leagueMap.set(g.league.id, { id: g.league.id, name: g.league.name, flag: g.league.flag });
      }
    }
    matches.sort((a, b) => (a.kickoff ?? 0) - (b.kickoff ?? 0));
    const leagueList = [...leagueMap.values()].sort((a, b) => a.name.localeCompare(b.name));

    // No league or match chosen yet → return only the selector lists, skipping
    // the expensive per-fixture player-props fan-out. Players load once the user
    // narrows to a league or a single match.
    if (!leagueId && !matchId) {
      const result = { date: targetDate, within: within || null, match: null, league: null, count: 0, matches, leagues: leagueList, players: [] };
      cacheSet(cacheKey, result, TTL.FIXTURES);
      return res.json({ ...result, fromCache: false });
    }

    const players = [];
    for (const g of leagues) {
      if (leagueId && String(g.league.id) !== leagueId) continue;
      const isWC = String(g.league.id) === "1";
      const propsSeason = isWC ? Number(g.season) - 1 : Number(g.season);
      if (!Number.isFinite(propsSeason)) continue;
      for (const fx of g.fixtures) {
        if (!fx.id || fx.status === "finished") continue;
        if (matchId && String(fx.id) !== matchId) continue;
        if (fx.startTimestamp && fx.startTimestamp > cutoff) continue;
        const pp = await getFixturePlayerProps(fx.id, propsSeason).catch(() => null);
        if (!pp || !pp.available) continue;
        for (const side of [pp.home, pp.away]) {
          if (!side) continue;
          for (const pl of side.players) {
            if (!pl.props?.tiers) continue;
            players.push({
              id: pl.id,
              name: pl.name,
              photo: pl.photo,
              pos: pl.pos,
              team: side.teamName,
              teamId: side.teamId,
              league: g.league.name,
              leagueFlag: g.league.flag,
              matchId: fx.id,
              home: fx.homeTeam?.name,
              away: fx.awayTeam?.name,
              kickoff: fx.startTimestamp,
              tiers: pl.props.tiers,
              foulMatchup: pl.foulMatchup || null,
            });
          }
        }
      }
    }

    const result = { date: targetDate, within: within || null, match: matchId || null, league: leagueId || null, count: players.length, matches, leagues: leagueList, players };
    cacheSet(cacheKey, result, TTL.FIXTURES);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[props-finder] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Team corner markets for one fixture: per-team first-half 2+/3+ probabilities
// and a projected full-match corner count for each side (plus the match total).
// LAZY — fetched only when the UI expands the corners section, because it reads
// the corner totals of each team's recent matches (one stats call per match,
// cached for a day). Team ids are passed in to avoid an extra fixture lookup.
router.get("/match/:fixtureId/corners", async (req, res) => {
  const { fixtureId } = req.params;
  const homeTeamId = Number(req.query.homeTeamId);
  const awayTeamId = Number(req.query.awayTeamId);
  if (!homeTeamId || !awayTeamId) {
    return res.status(400).json({ error: "homeTeamId and awayTeamId required" });
  }

  const cacheKey = `corners:${homeTeamId}:${awayTeamId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const [homeRates, awayRates] = await Promise.all([
      getTeamCornerRates(homeTeamId).catch(() => ({ for: null, against: null, games: 0 })),
      getTeamCornerRates(awayTeamId).catch(() => ({ for: null, against: null, games: 0 })),
    ]);

    const prediction = computeCornerPrediction(homeRates, awayRates);
    // With zero corner history on both sides the numbers are pure baseline — be
    // honest and mark it unavailable rather than presenting a fabricated edge.
    const available = homeRates.games + awayRates.games > 0;

    const out = { available, prediction };
    cacheSet(cacheKey, out, TTL.FIXTURES);
    res.json({ ...out, fromCache: false });
  } catch (err) {
    console.error(`[corners] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;

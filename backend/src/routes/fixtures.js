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
} from "../services/apifootball.js";
import { computePrediction, parseFormFromEvents } from "../services/predictions.js";
import { playerProps } from "../services/players.js";
import { teamCornerRates, computeCornerPrediction } from "../services/corners.js";
import {
  reconstructFormBefore,
  gradeMatch,
  summarizeAccuracy,
} from "../services/backtest.js";
import { buildAccumulators, buildLegPool } from "../services/accumulator.js";
import { buildVipSlips, goalWinCandidates, VIP_MIN_PROB, VIP_MAX_PROB } from "../services/vipbet.js";
import { settleSlips, settleSingles, dayProfit } from "../services/roi.js";
import { buildValueBets, bestBookOddsForLeg } from "../services/valuebets.js";
import { buildEloModel } from "../services/elo.js";
import { LEAGUES, LEAGUES_BY_ID } from "../data/leagues.js";

const router = express.Router();

router.get("/leagues", (req, res) => {
  res.json({ leagues: LEAGUES });
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

// A team's likely starting XI when no official lineup exists yet: the 11
// players with the most minutes for that team in `season` (for a national team,
// the most-capped regulars). Cached per team+season.
async function getProjectedXI(teamId, season) {
  const cacheKey = `squad-xi:${teamId}:${season}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const squad = await fetchTeamSquadByMinutes(teamId, season).catch(() => []);
  const xi = squad.slice(0, 11).map((p) => ({ id: p.id, name: p.name, number: null, pos: p.pos }));
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

// Turn a list of starters ({id,name,number,pos}) into player-prop rows by
// pulling each one's club-season rates. Sequential to respect the rate gate.
async function buildPlayerRows(starters, clubSeason) {
  const rows = [];
  for (const pl of starters) {
    if (!pl.id) continue;
    const stat = await getPlayerSeasonStats(pl.id, clubSeason);
    rows.push({
      id: pl.id,
      name: stat?.name || pl.name,
      number: pl.number ?? null,
      pos: pl.pos || stat?.pos || null,
      photo: stat?.photo || `https://media.api-sports.io/football/players/${pl.id}.png`,
      props: playerProps(stat),
    });
  }
  return rows;
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

  const dayEvents = allEvents.filter((e) => {
    if (!e.startTimestamp) return false;
    return formatDate(new Date(e.startTimestamp * 1000), tz) === targetDate;
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

  // Attach a form-based prediction (incl. goal markets) to every fixture so
  // the UI can show market badges and filter by prediction type without an
  // expand round-trip.
  const formMap = await getFormsForTeams(
    fixtures.flatMap((f) => [f.homeTeam.id, f.awayTeam.id])
  );
  // Season Elo ratings (second model) for the blend. Failure falls back to the
  // form-only prediction so one bad upstream never blanks the matchday.
  const elo = await getLeagueElo(leagueId, season.id).catch(() => null);
  for (const fx of fixtures) {
    if (!fx.homeTeam.id || !fx.awayTeam.id) {
      fx.prediction = null;
      continue;
    }
    const eloRatings = elo
      ? { home: elo.ratingBefore(fx.homeTeam.id, fx.startTimestamp), away: elo.ratingBefore(fx.awayTeam.id, fx.startTimestamp) }
      : null;
    fx.prediction = computePrediction(
      formMap[fx.homeTeam.id] || [],
      formMap[fx.awayTeam.id] || [],
      eloRatings
    );
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
    const prediction = computePrediction(homeForm, awayForm, eloRatings);
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
    const prediction = computePrediction(homeForm, awayForm, eloRatings);
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

  const perDay = {};
  for (const e of inWindow) {
    const homeId = e.homeTeam.id;
    const awayId = e.awayTeam.id;
    const homeForm = reconstructFormBefore(eventsMap[homeId] || [], homeId, e.startTimestamp);
    const awayForm = reconstructFormBefore(eventsMap[awayId] || [], awayId, e.startTimestamp);
    const eloRatings = elo
      ? { home: elo.ratingBefore(homeId, e.startTimestamp), away: elo.ratingBefore(awayId, e.startTimestamp) }
      : null;
    const prediction = computePrediction(homeForm, awayForm, eloRatings);
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
    const result = await buildLeagueDay(leagueId, targetDate, tz);
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
        buildLeagueDay(l.id, targetDate, tz).catch((e) => {
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

    const slips = buildVipSlips(leagues, cornerMap);
    await attachBookOddsToSlips(slips, leagues);

    const result = { date: targetDate, totalMatches, slips };
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
router.get("/match/:fixtureId/players", async (req, res) => {
  const { fixtureId } = req.params;
  const season = parseInt(req.query.season, 10);
  if (!Number.isFinite(season)) {
    return res.status(400).json({ error: "season (club season year) required" });
  }

  const cacheKey = `player-props:${fixtureId}:${season}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    // Prefer the official lineup (exact XI). API-Football publishes it ~40 min
    // before kickoff; until then we fall back to a projected XI built from each
    // squad's most-used players so the section is still useful pre-match.
    const lineups = await fetchFixtureLineups(fixtureId);
    const hasLineups = lineups.length && lineups.some((l) => l.startXI.length);

    let sides;
    let projected;
    if (hasLineups) {
      projected = false;
      sides = [];
      for (const side of lineups) {
        sides.push({
          teamId: side.teamId,
          teamName: side.teamName,
          formation: side.formation,
          players: await buildPlayerRows(side.startXI, season),
        });
      }
    } else {
      projected = true;
      const teams = await fetchFixtureTeams(fixtureId);
      if (!teams || (!teams.home.id && !teams.away.id)) {
        const out = { available: false, reason: "Lineup and squad data aren't available for this match yet." };
        cacheSet(cacheKey, out, TTL.FIXTURES);
        return res.json({ ...out, fromCache: false });
      }
      // Rank likely starters by their minutes for the national team in the
      // club season (most-capped regulars), then price each off club rates.
      sides = [];
      for (const t of [teams.home, teams.away]) {
        if (!t.id) { sides.push(null); continue; }
        const xi = await getProjectedXI(t.id, season);
        sides.push({
          teamId: t.id,
          teamName: t.name,
          formation: null,
          players: await buildPlayerRows(xi, season),
        });
      }
    }

    const hasAny = sides.some((s) => s && s.players.some((p) => p.props));
    if (!hasAny) {
      const out = { available: false, reason: "Player stats aren't available for these squads yet." };
      cacheSet(cacheKey, out, TTL.FIXTURES);
      return res.json({ ...out, fromCache: false });
    }

    const out = { available: true, projected, season, home: sides[0] || null, away: sides[1] || null };
    cacheSet(cacheKey, out, TTL.FIXTURES);
    res.json({ ...out, fromCache: false });
  } catch (err) {
    console.error(`[player-props] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
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

// Public, shareable VIP prediction endpoint.
//
// Resolve two team names to their NEXT scheduled meeting and return the VIP
// builder's ranked betting events — the SAME buildVipSlips logic + floors used
// across the app, not a separate model — each with its real bookmaker price. Powers
// the crawlable /predict share pages (see seo.js). The prediction itself comes from
// analyzeMatchup (form + shared-league Elo + baselines), which is window-independent
// so it works even for fixtures weeks out; the real bookmaker odds come from the
// resolved fixture id.
import { Router } from "express";
import { fetchTeamByName, fetchHeadToHead, fetchFixtureOdds, fetchTeamSuggestions } from "../services/apifootball.js";
import { analyzeMatchup } from "./analyze.js";
import { buildVipSlips, goalWinCandidates } from "../services/vipbet.js";
import { bestBookOddsForLeg } from "../services/valuebets.js";
import { LEAGUES_BY_ID } from "../data/leagues.js";
import { leagueSlug, matchSlug, slugify } from "./seo.js";

const router = Router();
const round2 = (x) => Math.round(x * 100) / 100;

// Private gate — same code as the app's other tools, held server-side only. The
// /predict pages forward it (header) after their cookie check; a direct caller
// must present it too. Accepts the x-odds-pass header, ?pass=, or the ff_tools
// cookie the unlock flow sets.
const TOOLS_PASS = process.env.ODDS_GEN_PASS || "1211";
function toolsAuthed(req) {
  const c = (req.headers.cookie || "").match(/(?:^|;\s*)ff_tools=([^;]+)/);
  const fromCookie = c ? decodeURIComponent(c[1]) : "";
  return fromCookie === TOOLS_PASS || (req.get("x-odds-pass") || req.query.pass || "") === TOOLS_PASS;
}

// Shape analyzeMatchup output into the fixture object the VIP builder expects.
function toFixture(result, h2h) {
  const P = result.probabilities;
  const winner = (P.home ?? 0) >= (P.away ?? 0) ? "home" : "away";
  return {
    id: h2h.fixtureId,
    homeTeam: { id: result.home.id, name: result.home.name, shortName: result.home.name, logo: result.home.logo },
    awayTeam: { id: result.away.id, name: result.away.name, shortName: result.away.name, logo: result.away.logo },
    startTimestamp: h2h.startTimestamp,
    status: "notstarted",
    prediction: {
      home: P.home, draw: P.draw, away: P.away,
      markets: { ...result.markets, win: Math.max(P.home ?? 0, P.away ?? 0), winner, expectedGoals: result.expectedGoals },
    },
  };
}

// Ranked VIP events for a fixture. Prefers the VIP builder slip (floors + overlap
// dedup); falls back to the raw candidate menu when it doesn't clear the floors, so
// there's always a read. `vip` flags which path produced the events.
function vipEvents(fx, league) {
  const slips = buildVipSlips([{ league, fixtures: [fx] }], {}, 1);
  if (slips[0]?.legs?.length) return { legs: slips[0].legs, vip: true };
  const legs = goalWinCandidates(fx)
    .filter((c) => typeof c.prob === "number" && c.prob > 0)
    .map((c) => ({ market: c.market, marketKey: c.marketKey, selection: c.selection, probability: Math.round(c.prob) }));
  return { legs, vip: false };
}

// Team-name typeahead for the /predict search box (gated, same code). Returns up
// to 8 matches for a 3+ char fragment. The browser sends the ff_tools cookie
// automatically, so no header is needed from the page's script.
router.get("/teams/suggest", async (req, res) => {
  if (!toolsAuthed(req)) return res.status(401).json({ error: "This tool is private." });
  const q = String(req.query.q || "").trim();
  if (q.length < 3) return res.json({ teams: [] });
  try {
    const teams = await fetchTeamSuggestions(q, 8);
    res.set("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.json({ teams });
  } catch (err) {
    console.error(`[teams/suggest] ${err.message}`);
    res.status(500).json({ error: err.message, teams: [] });
  }
});

router.get("/predict", async (req, res) => {
  if (!toolsAuthed(req)) return res.status(401).json({ error: "This tool is private." });
  const home = String(req.query.home || "").trim();
  const away = String(req.query.away || "").trim();
  if (!home || !away) {
    return res.status(400).json({ error: "home and away query params are required (team names)." });
  }

  try {
    const [homeTeam, awayTeam] = await Promise.all([
      fetchTeamByName(home).catch(() => null),
      fetchTeamByName(away).catch(() => null),
    ]);
    if (!homeTeam || !awayTeam) {
      return res.status(404).json({
        error: "Couldn't find one or both teams.",
        resolved: { home: homeTeam?.name || null, away: awayTeam?.name || null },
      });
    }

    const h2h = await fetchHeadToHead(homeTeam.id, awayTeam.id);
    if (!h2h?.fixtureId) {
      return res.status(404).json({
        error: "No upcoming fixture is scheduled between these teams.",
        resolved: { home: homeTeam.name, away: awayTeam.name },
      });
    }
    const league = h2h.leagueId && LEAGUES_BY_ID[h2h.leagueId];
    if (!league) {
      return res.status(422).json({
        error: "Their next meeting is in a competition this service doesn't cover yet.",
        fixture: { league: h2h.leagueName, kickoff: h2h.startTimestamp },
      });
    }

    // Prediction for the real fixture orientation (home advantage on the true home
    // side). analyzeMatchup is window-independent, so far-out fixtures still work.
    const result = await analyzeMatchup(h2h.home, h2h.away);
    const fx = toFixture(result, h2h);

    const { legs, vip } = vipEvents(fx, league);
    const odds = await fetchFixtureOdds(h2h.fixtureId).catch(() => null);
    const winnerSide = fx.prediction.markets.winner;

    const events = legs
      .map((l) => {
        const priced = odds?.best
          ? bestBookOddsForLeg(odds.best, { marketKey: l.marketKey, selection: l.selection }, winnerSide)
          : null;
        return {
          market: l.market, selection: l.selection,
          probability: l.probability,
          bookOdds: priced ? priced.odds : null,
          bookmaker: priced ? priced.book : null,
        };
      })
      .sort((a, b) => b.probability - a.probability);

    const slug = `${slugify(fx.homeTeam.name)}-vs-${slugify(fx.awayTeam.name)}`;
    res.set("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
    res.json({
      match: {
        home: fx.homeTeam.name, away: fx.awayTeam.name,
        homeLogo: fx.homeTeam.logo, awayLogo: fx.awayTeam.logo,
        league: league.name, leagueFlag: league.flag, leagueId: league.id,
        kickoff: fx.startTimestamp,
      },
      vip,
      recommended: events[0] || null,
      events,
      slug,
      sharePath: `/predict/${slug}`,
      analysisPath: `/league/${leagueSlug(league)}/${matchSlug(fx)}`,
      note: "Model estimates — not betting advice.",
    });
  } catch (err) {
    if (err.status === 422) {
      return res.status(422).json({ error: err.message, resolved: err.resolved });
    }
    console.error(`[predict] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;

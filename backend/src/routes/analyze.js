// Public "analyze a matchup by name" entry point.
//
// The web app always has a fixture id in hand, but an external caller (e.g. a
// published Capafy agent) only has free text — "Real Madrid vs Barcelona". This
// route resolves both names to teams, pulls each side's recent form, and returns
// the model's probability output for the hypothetical match, so the agent can
// send a matchup and get analysis back in ONE call.
//
// It returns the SAME numbers the app shows (win/draw/loss, goal markets, xG,
// confidence) but never the method behind them — the Dixon–Coles/Elo/decay model
// stays server-side. Rate-limited and cached so a busy agent can't run up the
// upstream bill.

import express from "express";
import rateLimit from "express-rate-limit";
import { fetchTeamByName, fetchTeamLastMatches, fetchTeamLeagues, fetchLeagueSeason, fetchPastEvents } from "../services/apifootball.js";
import { computePrediction, parseFormFromEvents, leagueBaselines, topScorelines, FORM_HALF_LIFE_DAYS } from "../services/predictions.js";
import { buildEloModel } from "../services/elo.js";
import { cacheGet, cacheSet, TTL } from "../services/cache.js";

const router = express.Router();

// Access gate. This endpoint is the published agent's data source, so it isn't
// meant to be openly callable — the agent presents a shared key and everyone
// else is refused. The key lives in ANALYZE_API_KEY (Vercel env), never in code.
// Accepts it as `Authorization: Bearer <key>`, an `x-api-key` header, or `?key=`.
// Fails CLOSED: if no key is configured on the server, the endpoint is disabled.
function requireKey(req, res, next) {
  const configured = process.env.ANALYZE_API_KEY;
  if (!configured) return res.status(503).json({ error: "Analyze API is not configured." });
  const provided =
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() ||
    req.get("x-api-key") ||
    req.query.key ||
    "";
  if (provided !== configured) {
    return res.status(401).json({ error: "Unauthorized — a valid API key is required." });
  }
  next();
}

// Tighter than the general API limiter: this endpoint fans out to several
// upstream calls per request, and it's the one exposed to third-party agents.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Rate limit reached — try again shortly." },
});

const decayFor = (refTs) => ({ decay: { refTs, halfLifeDays: FORM_HALF_LIFE_DAYS } });

// Recover the model's per-side expected goals from the prediction's public
// marginals (each side's 1+ prob for the split, expected-goals for the total) so
// we can rebuild the scoreline grid for top-scoreline scenarios — same approach
// the VIP builder uses, no new model internals exposed.
function reconstructLambdas(m) {
  const clampP = (p) => Math.min(0.995, Math.max(0.02, (p ?? 0) / 100));
  const lh = -Math.log(1 - clampP(m.home1Plus));
  const la = -Math.log(1 - clampP(m.away1Plus));
  const total = typeof m.expectedGoals === "number" && m.expectedGoals > 0 ? m.expectedGoals : lh + la;
  const scale = lh + la > 0 ? total / (lh + la) : 1;
  return { lambdaHome: lh * scale, lambdaAway: la * scale };
}

// Cache name→team resolution hard (team ids are stable) to spare the upstream
// search on repeat matchups.
async function resolveTeam(name) {
  const key = `team-name:${String(name).trim().toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const team = await fetchTeamByName(name);
  if (team) cacheSet(key, team, 30 * 24 * 60 * 60); // 30 days
  return team;
}

// The domestic leagues a team plays this season (cached a week — stable within a
// season). Only "League"-type competitions, since Elo is a within-league rating.
async function teamLeagues(teamId) {
  const key = `az-team-leagues:${teamId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const leagues = (await fetchTeamLeagues(teamId).catch(() => [])).filter((l) => l.type === "League");
  cacheSet(key, leagues, 7 * 24 * 60 * 60);
  return leagues;
}

// Whole-season events for a league, for building Elo + baselines. Cached 6h.
async function leagueEvents(leagueId) {
  const sKey = `az-season:${leagueId}`;
  let seasonId = cacheGet(sKey);
  if (!seasonId) {
    seasonId = (await fetchLeagueSeason(leagueId))?.seasons?.[0]?.id ?? null;
    if (seasonId) cacheSet(sKey, seasonId, TTL.TEAM_FORM);
  }
  if (!seasonId) return [];
  const eKey = `az-events:${leagueId}:${seasonId}`;
  const hit = cacheGet(eKey);
  if (hit) return hit;
  const events = (await fetchPastEvents(leagueId, seasonId).catch(() => ({ events: [] }))).events || [];
  cacheSet(eKey, events, TTL.TEAM_FORM);
  return events;
}

// Full-model context for a matchup when both teams share a domestic league:
// that league's Elo ratings (current strength) + goal baselines, exactly what
// the app blends into its fixture predictions. Returns null when there's no
// shared league (cross-division / cross-country hypotheticals) → form-only.
async function leagueContext(homeId, awayId) {
  const [hl, al] = await Promise.all([teamLeagues(homeId), teamLeagues(awayId)]);
  const shared = hl.find((h) => al.some((a) => a.id === h.id));
  if (!shared) return null;

  const events = await leagueEvents(shared.id);
  if (events.length < 30) return null; // too thin for a trustworthy Elo/baseline

  const elo = buildEloModel(events);
  const baselines = leagueBaselines(events);
  return {
    league: shared.name,
    baselines,
    eloRatings: { home: elo.current(homeId), away: elo.current(awayId) },
  };
}

router.get("/analyze", requireKey, analyzeLimiter, async (req, res) => {
  const home = String(req.query.home || "").trim();
  const away = String(req.query.away || "").trim();
  if (!home || !away) {
    return res.status(400).json({ error: "home and away query params are required (team names)." });
  }

  const cacheKey = `analyze:${home.toLowerCase()}::${away.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const [homeTeam, awayTeam] = await Promise.all([resolveTeam(home), resolveTeam(away)]);
    if (!homeTeam || !awayTeam) {
      return res.status(404).json({
        error: "Could not resolve one or both teams.",
        resolved: { home: homeTeam?.name || null, away: awayTeam?.name || null },
      });
    }

    const [homeData, awayData] = await Promise.all([
      fetchTeamLastMatches(homeTeam.id).catch(() => ({ events: [] })),
      fetchTeamLastMatches(awayTeam.id).catch(() => ({ events: [] })),
    ]);

    const homeForm = parseFormFromEvents(homeData.events || [], homeTeam.id);
    const awayForm = parseFormFromEvents(awayData.events || [], awayTeam.id);
    if (!homeForm.length || !awayForm.length) {
      return res.status(422).json({
        error: "Not enough recent match data to analyze one or both teams.",
        resolved: { home: homeTeam.name, away: awayTeam.name },
      });
    }

    // Full model when both teams share a domestic league (Elo + goal baselines,
    // same as the app's fixture predictions); form-only fallback otherwise.
    const ctx = await leagueContext(homeTeam.id, awayTeam.id).catch(() => null);
    const p = computePrediction(
      homeForm, awayForm,
      ctx?.eloRatings || null,
      ctx?.baselines || null,
      decayFor(Math.floor(Date.now() / 1000)),
    );
    const m = p.markets || {};

    // Model's headline scoreline scenarios (top 5), labelled with the team names.
    const { lambdaHome, lambdaAway } = reconstructLambdas(m);
    const scorelines = topScorelines(lambdaHome, lambdaAway, 5).map((s) => ({
      score: `${s.home}-${s.away}`,
      home: s.home,
      away: s.away,
      prob: Math.round(s.prob * 100),
    }));

    const result = {
      home: { id: homeTeam.id, name: homeTeam.name, logo: homeTeam.logo },
      away: { id: awayTeam.id, name: awayTeam.name, logo: awayTeam.logo },
      probabilities: { home: p.home, draw: p.draw, away: p.away },
      expectedGoals: m.expectedGoals ?? null,
      scorelines,
      markets: {
        over15: m.over15, over25: m.over25, btts: m.btts,
        home1Plus: m.home1Plus, home2Plus: m.home2Plus,
        away1Plus: m.away1Plus, away2Plus: m.away2Plus,
      },
      confidence: p.confidence,
      form: { home: p.homeForm, away: p.awayForm },
      context: {
        league: ctx?.league || null,
        model: ctx ? "form + season strength + league baselines" : "recent form only",
      },
      note: "Model-based estimates. Football analysis only — not betting advice.",
    };

    cacheSet(cacheKey, result, TTL.TEAM_FORM);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[analyze] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;

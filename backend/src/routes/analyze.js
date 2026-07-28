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
import { fetchTeamByName, fetchTeamLastMatches } from "../services/apifootball.js";
import { computePrediction, parseFormFromEvents, topScorelines, FORM_HALF_LIFE_DAYS } from "../services/predictions.js";
import { cacheGet, cacheSet, TTL } from "../services/cache.js";

const router = express.Router();

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

router.get("/analyze", analyzeLimiter, async (req, res) => {
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

    // No league context for a free-text matchup, so no Elo/baselines blend — the
    // form model with recency decay, same as the app's on-demand prediction path.
    const p = computePrediction(homeForm, awayForm, null, null, decayFor(Math.floor(Date.now() / 1000)));
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
      note: "Model-based estimates from recent form. Football analysis only — not betting advice.",
    };

    cacheSet(cacheKey, result, TTL.TEAM_FORM);
    res.json({ ...result, fromCache: false });
  } catch (err) {
    console.error(`[analyze] ${err.message}`);
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;

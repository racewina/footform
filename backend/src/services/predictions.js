// ---- Dixon–Coles-style bivariate Poisson model ------------------------------
//
// Every market is read off ONE scoreline distribution P(i,j) instead of pricing
// the match result with one formula and the goal markets with another. The old
// 1X2 was an untuned strength-ratio heuristic that could disagree with its own
// goal numbers; backtest calibration showed it (and the independence-assuming
// BTTS) were the weak links. Here:
//   • Expected goals use the Dixon–Coles multiplicative form, opponent-adjusted
//     with each side's venue-specific scoring/conceding rates.
//   • The low-score dependence correction τ(i,j;ρ) fixes independent Poisson's
//     well-known under-counting of 0-0/1-1 and over-counting of 1-0/0-1.
//   • Match result, Over 2.5, BTTS and team-goals all come from the same grid,
//     so they are mutually consistent by construction.
//
// CAVEAT: textbook Dixon–Coles fits attack/defence ratings for every team by
// maximum likelihood across a whole league. We don't persist league data (no
// DB), so we approximate each team's ratings from its own recent form, shrunk
// toward the league average for small samples. Same model structure, lighter
// inputs — an honest step up from the heuristic, not the full league fit.
//
// SECOND MODEL: when season Elo ratings are supplied (see elo.js), we derive a
// second pair of expected goals from the rating gap and BLEND it 50/50 with the
// form-based λ before building the grid. The two models see strength
// differently — form looks only at the last 6 games, Elo carries the whole
// season's results forward — so averaging them smooths the blind spots of each.

import { eloExpectedGoals } from "./elo.js";

// Average goals scored by the HOME side and the AWAY side of a match. They
// double as the conceding baselines (a home side's goals-for equals the away
// side's goals-against), and the home/away gap encodes home advantage directly
// — so no separate home-advantage multiplier is needed (it would double-count).
const HOME_BASE = 1.45;
const AWAY_BASE = 1.15;
const RHO = -0.13; // Dixon–Coles low-score dependence parameter
const SHRINK_K = 3; // pseudo-games pulling thin samples toward the baseline
const MAX_GOALS = 10; // scoreline grid truncation
const BLEND_FORM_WEIGHT = 0.5; // form vs Elo λ weighting when both available
const FORM_WINDOW = 10; // recent games kept for form (older ones down-weighted)
// Recency half-life for form: a game this many days before kickoff counts half
// as much as one played at kickoff. Chosen by backtest — 45d beat 30/60/90 and
// improved Brier in- and out-of-sample. Exported so callers set decay uniformly.
export const FORM_HALF_LIFE_DAYS = 45;

function poissonP(k, lambda) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Pull a per-game rate toward a baseline: with few games the estimate leans on
// the prior, with many it trusts the data.
function shrunkRate(avgPerGame, games, baseline) {
  return (games * avgPerGame + SHRINK_K * baseline) / (games + SHRINK_K);
}

// A league's own average home/away goals, from its finished matches — the
// per-league calibration. Falls back to the global default until the league has
// enough games (early season), and clamps to a sane band so a freak run of
// blowouts can't distort the prior. Pass the result to computePrediction.
export function leagueBaselines(events) {
  const finished = (events || []).filter(
    (e) => e.status?.type === "finished" && e.homeScore?.current != null && e.awayScore?.current != null
  );
  if (finished.length < 30) return { home: HOME_BASE, away: AWAY_BASE };
  const n = finished.length;
  const h = finished.reduce((s, e) => s + e.homeScore.current, 0) / n;
  const a = finished.reduce((s, e) => s + e.awayScore.current, 0) / n;
  return { home: clamp(h, 0.9, 2.4), away: clamp(a, 0.6, 2.1) };
}

// Dixon–Coles correction for the four low-score cells independent Poisson
// misprices. With ρ<0 it lifts 0-0/1-1 and trims 1-0/0-1, matching real games.
function tau(i, j, lh, la, rho) {
  if (i === 0 && j === 0) return 1 - lh * la * rho;
  if (i === 0 && j === 1) return 1 + lh * rho;
  if (i === 1 && j === 0) return 1 + la * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

// Build the full P(i,j) scoreline grid for the two expected-goal rates and read
// every market off it, guaranteeing match-result and goal markets agree.
function marketsFromGoals(lambdaHome, lambdaAway) {
  const ph = [];
  const pa = [];
  for (let k = 0; k <= MAX_GOALS; k++) {
    ph[k] = poissonP(k, lambdaHome);
    pa[k] = poissonP(k, lambdaAway);
  }

  let sum = 0, homeWin = 0, draw = 0, awayWin = 0, over15 = 0, over25 = 0, btts = 0;
  let home1 = 0, home2 = 0, away1 = 0, away2 = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = ph[i] * pa[j] * tau(i, j, lambdaHome, lambdaAway, RHO);
      sum += p;
      if (i > j) homeWin += p;
      else if (i === j) draw += p;
      else awayWin += p;
      if (i + j >= 2) over15 += p;
      if (i + j >= 3) over25 += p;
      if (i >= 1 && j >= 1) btts += p;
      if (i >= 1) home1 += p;
      if (i >= 2) home2 += p;
      if (j >= 1) away1 += p;
      if (j >= 2) away2 += p;
    }
  }

  const norm = (x) => x / sum;
  const pct = (x) => Math.round(clamp(norm(x), 0, 1) * 100);
  const homePct = norm(homeWin);
  const awayPct = norm(awayWin);

  return {
    probs: {
      home: Math.round(homePct * 100),
      draw: Math.round(norm(draw) * 100),
      away: Math.round(awayPct * 100),
    },
    markets: {
      win: Math.round(Math.max(homePct, awayPct) * 100), // favourite's win prob (%)
      winner: homePct >= awayPct ? "home" : "away",
      home1Plus: pct(home1),
      home2Plus: pct(home2),
      away1Plus: pct(away1),
      away2Plus: pct(away2),
      over15: pct(over15),
      over25: pct(over25),
      btts: pct(btts),
      expectedGoals: +(lambdaHome + lambdaAway).toFixed(2),
    },
  };
}

function parseFormFromEvents(events, teamId, limit = FORM_WINDOW) {
  // Provider order isn't guaranteed; sort most-recent-first so we take the
  // genuine last N, not the oldest N.
  const ordered = [...events].sort(
    (a, b) => (b.startTimestamp ?? 0) - (a.startTimestamp ?? 0)
  );
  const results = [];
  for (const event of ordered) {
    if (event.status?.type !== "finished") continue;
    const isHome = event.homeTeam?.id === teamId;
    const homeScore = event.homeScore?.current ?? 0;
    const awayScore = event.awayScore?.current ?? 0;
    const goalsFor = isHome ? homeScore : awayScore;
    const goalsAgainst = isHome ? awayScore : homeScore;
    let outcome;
    if (goalsFor > goalsAgainst) outcome = "W";
    else if (goalsFor < goalsAgainst) outcome = "L";
    else outcome = "D";
    // ts retained so an optional time-decay weighting can down-weight older
    // games relative to the fixture's kickoff (see calcTeamScore).
    results.push({ outcome, goalsFor, goalsAgainst, isHome, ts: event.startTimestamp ?? 0 });
    if (results.length >= limit) break;
  }
  return results;
}

function calcTeamScore(form, venueFilter, decay = null) {
  const relevant = venueFilter
    ? form.filter((m) => m.isHome === venueFilter.isHome)
    : form;

  if (relevant.length === 0) return { score: 0.5, form: form.slice(0, 6), goalsFor: 0, goalsAgainst: 0, gamesPlayed: 0, effGames: 0 };

  // Optional exponential time-decay: a match `daysAgo` old counts 0.5^(daysAgo /
  // halfLife) as much as one played today. With no decay every weight is 1, so
  // this reduces EXACTLY to the old flat average (sum of ones == count).
  const weightOf = (m) => {
    if (!decay?.halfLifeDays || !decay?.refTs || !m.ts) return 1;
    const daysAgo = Math.max(0, (decay.refTs - m.ts) / 86400);
    return Math.pow(0.5, daysAgo / decay.halfLifeDays);
  };

  let wSum = 0, wPoints = 0, wFor = 0, wAgainst = 0;
  for (const m of relevant) {
    const w = weightOf(m);
    wSum += w;
    wPoints += w * (m.outcome === "W" ? 3 : m.outcome === "D" ? 1 : 0);
    wFor += w * m.goalsFor;
    wAgainst += w * m.goalsAgainst;
  }

  const ppg = wSum > 0 ? wPoints / (wSum * 3) : 0;
  const goalsFor = wFor / wSum;
  const goalsAgainst = wAgainst / wSum;

  const attackScore = Math.min(goalsFor / 2.5, 1);
  const defenseScore = Math.max(1 - goalsAgainst / 2.5, 0);

  const score = ppg * 0.5 + attackScore * 0.25 + defenseScore * 0.25;

  // gamesPlayed = raw count (drives the confidence label); effGames = summed
  // weight (the effective sample size shrinkage should trust).
  return { score, form: form.slice(0, 6), goalsFor, goalsAgainst, gamesPlayed: relevant.length, effGames: wSum };
}

export function computePrediction(homeTeamForm, awayTeamForm, elo = null, baselines = null, opts = {}) {
  // opts.decay = { refTs, halfLifeDays } enables exponential recency weighting of
  // each team's form. Omitted → flat average (current production behaviour).
  const decay = opts.decay ?? null;
  // Per-league goal baselines when supplied (a high-scoring league expects more
  // goals than a defensive one); otherwise the global default. These are the
  // priors that shrinkage pulls thin samples toward and the pivots that set the
  // league's average scoreline.
  const homeBase = baselines?.home ?? HOME_BASE;
  const awayBase = baselines?.away ?? AWAY_BASE;

  const homeStats = calcTeamScore(homeTeamForm, { isHome: true }, decay);
  const awayStats = calcTeamScore(awayTeamForm, { isHome: false }, decay);

  // Venue-specific, opponent-adjusted expected goals (Dixon–Coles form). Each
  // rate is shrunk toward its baseline so thin samples don't run wild:
  //   • a side's goals-for shrinks toward how much that side normally scores,
  //   • its goals-against toward how much that side normally concedes,
  // where home-scoring ≈ away-conceding (homeBase) and vice versa (awayBase).
  const hFor = shrunkRate(homeStats.goalsFor, homeStats.effGames, homeBase);
  const hAga = shrunkRate(homeStats.goalsAgainst, homeStats.effGames, awayBase);
  const aFor = shrunkRate(awayStats.goalsFor, awayStats.effGames, awayBase);
  const aAga = shrunkRate(awayStats.goalsAgainst, awayStats.effGames, homeBase);

  // home attack × away defence, pivoted on the home-side baseline (and likewise
  // for the away side). Dividing by the baseline keeps an average match at the
  // league's typical split, with home advantage already baked in.
  let lambdaHome = (hFor * aAga) / homeBase;
  let lambdaAway = (aFor * hAga) / awayBase;

  // Blend in the Elo view when season ratings are supplied. Both models output
  // a (λhome, λaway) pair; we weight-average them so the final grid reflects
  // recent form AND season-long strength.
  if (elo && elo.home != null && elo.away != null) {
    const eloLambdas = eloExpectedGoals(elo.home, elo.away, homeBase + awayBase);
    const w = BLEND_FORM_WEIGHT;
    lambdaHome = w * lambdaHome + (1 - w) * eloLambdas.lambdaHome;
    lambdaAway = w * lambdaAway + (1 - w) * eloLambdas.lambdaAway;
  }

  lambdaHome = clamp(lambdaHome, 0.2, 4);
  lambdaAway = clamp(lambdaAway, 0.2, 4);

  const { probs, markets } = marketsFromGoals(lambdaHome, lambdaAway);

  const totalGames = homeStats.gamesPlayed + awayStats.gamesPlayed;
  const confidence = totalGames >= 8 ? "high" : totalGames >= 4 ? "medium" : "low";

  return {
    ...probs,
    confidence,
    homeForm: homeStats.form.map((m) => m.outcome),
    awayForm: awayStats.form.map((m) => m.outcome),
    homeGoalsFor: +homeStats.goalsFor.toFixed(1),
    homeGoalsAgainst: +homeStats.goalsAgainst.toFixed(1),
    awayGoalsFor: +awayStats.goalsFor.toFixed(1),
    awayGoalsAgainst: +awayStats.goalsAgainst.toFixed(1),
    markets,
  };
}

export { parseFormFromEvents };

// Blend a model prediction with the bookmaker market. The market prices in team
// quality, injuries and news the form/Elo model can't see, so a modest blend
// (default 60% model / 40% market) corrects the model's biggest blind spots —
// especially in lopsided internationals where form alone badly misreads strength.
//
// Each market is de-vigged (the bookmaker margin removed by normalising the
// complementary prices) before blending, and only blended when both sides of the
// price exist. Markets with no odds keep the pure-model number. NOTE: odds only
// exist before kickoff, so this is applied on the live matchday path only; a
// finished match falls back to the pure model until predictions are persisted.
export function blendPrediction(prediction, odds, marketWeight = 0.4) {
  if (!prediction || !odds?.best) return prediction;
  const b = odds.best;
  // fetchFixtureOdds stores each price as { odd, book }; pull the decimal odd.
  const oddOf = (x) => (x && typeof x.odd === "number" ? x.odd : null);
  const w = marketWeight, mw = 1 - marketWeight;
  const out = { ...prediction, markets: { ...prediction.markets } };

  // 1X2: de-vig the three-way price, then blend home/draw/away.
  const hw = oddOf(b.homeWin), dr = oddOf(b.draw), aw = oddOf(b.awayWin);
  if (hw > 1 && dr > 1 && aw > 1) {
    const ph = 1 / hw, pd = 1 / dr, pa = 1 / aw;
    const s = ph + pd + pa;
    out.home = Math.round(mw * prediction.home + w * (ph / s) * 100);
    out.draw = Math.round(mw * prediction.draw + w * (pd / s) * 100);
    out.away = Math.round(mw * prediction.away + w * (pa / s) * 100);
    out.markets.win = Math.max(out.home, out.away);
    out.markets.winner = out.home >= out.away ? "home" : "away";
  }

  // Two-way markets: de-vig (yes vs no) and blend the model's % for that key.
  const blendTwo = (key, yes, no) => {
    const yo = oddOf(yes), no_ = oddOf(no);
    if (!(yo > 1) || !(no_ > 1)) return;
    if (typeof prediction.markets[key] !== "number") return;
    const py = 1 / yo, pn = 1 / no_;
    out.markets[key] = Math.round(mw * prediction.markets[key] + w * (py / (py + pn)) * 100);
  };
  blendTwo("over25", b.over25, b.under25);
  blendTwo("btts", b.bttsYes, b.bttsNo);
  blendTwo("home1Plus", b.homeToScore, b.homeNoScore);
  blendTwo("away1Plus", b.awayToScore, b.awayNoScore);
  blendTwo("home2Plus", b.home2Plus, b.homeUnder2);
  blendTwo("away2Plus", b.away2Plus, b.awayUnder2);

  return out;
}

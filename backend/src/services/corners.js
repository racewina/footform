// ---- Team corner markets ----------------------------------------------------
//
// Projected corners per team, built the SAME way predictions.js builds expected
// goals: an opponent-adjusted, shrinkage-stabilised multiplicative rate, then
// Poisson tail probabilities read off it. The markets are:
//   • full      — projected full-match corners for the team (a number, e.g. 5.4)
//   • fh2Plus   — P(team wins 2+ corners in the FIRST HALF)
//   • fh3Plus   — P(team wins 3+ corners in the FIRST HALF)
// plus a projected match total (home + away).
//
// HONEST CAVEAT ON THE FIRST HALF: API-Football reports only a full-match corner
// total — there is no per-half corner data in the feed (the events endpoint
// doesn't even emit corners). So the first-half rate is MODELED as a fixed share
// of the projected full-match rate. Empirically a little under half of a match's
// corners come before the break; FIRST_HALF_SHARE encodes that. These first-half
// numbers are therefore an estimate layered on an estimate — treat them as
// directional, not precise.

const CORNER_BASE_HOME = 5.4; // avg corners the HOME side wins per match
const CORNER_BASE_AWAY = 4.6; // avg corners the AWAY side wins per match
const SHRINK_K = 3; // pseudo-games pulling thin samples toward the baseline
const FIRST_HALF_SHARE = 0.47; // fraction of full-match corners modeled in H1

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function poissonP(k, lambda) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact;
}

function shrunkRate(avgPerGame, games, baseline) {
  return (games * avgPerGame + SHRINK_K * baseline) / (games + SHRINK_K);
}

// Average corners FOR and AGAINST per game from a team's recent matches. Only
// matches with real corner data count toward `games` (coverage is patchy), so a
// team with no usable history returns games:0 and leans entirely on the baseline.
export function teamCornerRates(samples) {
  const valid = (samples || []).filter((s) => s && s.for != null && s.against != null);
  const games = valid.length;
  if (!games) return { for: null, against: null, games: 0 };
  const f = valid.reduce((a, s) => a + s.for, 0) / games;
  const a = valid.reduce((a, s) => a + s.against, 0) / games;
  return { for: f, against: a, games };
}

// First-half corner tail probabilities + the full-match projection for one side.
function teamCornerMarkets(lambdaFull) {
  const l1 = lambdaFull * FIRST_HALF_SHARE;
  const p0 = poissonP(0, l1);
  const p1 = poissonP(1, l1);
  const p2 = poissonP(2, l1);
  return {
    full: +lambdaFull.toFixed(1),
    firstHalf: +l1.toFixed(1),
    fh2Plus: Math.round(clamp(1 - p0 - p1, 0, 1) * 100),
    fh3Plus: Math.round(clamp(1 - p0 - p1 - p2, 0, 1) * 100),
  };
}

// Combine both teams' corner rates into the corner prediction. `home`/`away` are
// the { for, against, games } objects from teamCornerRates.
export function computeCornerPrediction(home, away) {
  // home corners-won × away corners-conceded, pivoted on the home baseline so an
  // average match lands at ~CORNER_BASE_HOME / ~CORNER_BASE_AWAY (home edge baked
  // in). Each input is shrunk toward its baseline so thin samples can't run wild.
  const hFor = shrunkRate(home.for ?? CORNER_BASE_HOME, home.games, CORNER_BASE_HOME);
  const aAga = shrunkRate(away.against ?? CORNER_BASE_HOME, away.games, CORNER_BASE_HOME);
  const aFor = shrunkRate(away.for ?? CORNER_BASE_AWAY, away.games, CORNER_BASE_AWAY);
  const hAga = shrunkRate(home.against ?? CORNER_BASE_AWAY, home.games, CORNER_BASE_AWAY);

  let lambdaHome = (hFor * aAga) / CORNER_BASE_HOME;
  let lambdaAway = (aFor * hAga) / CORNER_BASE_AWAY;
  lambdaHome = clamp(lambdaHome, 1, 12);
  lambdaAway = clamp(lambdaAway, 1, 12);

  const minGames = Math.min(home.games, away.games);
  const confidence = minGames >= 6 ? "high" : minGames >= 3 ? "medium" : "low";

  return {
    home: teamCornerMarkets(lambdaHome),
    away: teamCornerMarkets(lambdaAway),
    matchTotal: +(lambdaHome + lambdaAway).toFixed(1),
    firstHalfTotal: +((lambdaHome + lambdaAway) * FIRST_HALF_SHARE).toFixed(1),
    confidence,
    sample: { home: home.games, away: away.games },
  };
}

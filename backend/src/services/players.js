// ---- Player prop markets ----------------------------------------------------
//
// Four player-level markets for a single fixture, all read off ONE intensity
// formula so they stay mutually consistent (same idea as predictions.js pricing
// every match market off one scoreline grid):
//
//     P(stat >= 1) = 1 - exp(-rate90 * expMin/90)
//
// where rate90 is the player's per-90 rate for that count and expMin is how long
// we expect them on the pitch. The markets differ only in which count feeds it:
//   • score   -> goals
//   • foul    -> fouls committed
//   • fouled  -> fouls drawn
//   • tackle  -> tackles
//   • shotOnTarget -> shots on target
//
// CAVEAT: this is a "1+ occurrence" model under a Poisson assumption for each
// count. It deliberately ignores opponent strength and game state — for a World
// Cup match those would need national-team history we don't have. The rates come
// from each player's most recent CLUB season (summed across competitions in
// apifootball.fetchPlayerSeasonStats), which is form, not destiny. Treat the
// numbers as projected-lineup guidance, consistent with the rest of the app.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Poisson ≥1 / ≥2 / ≥3 probabilities for a per-90 rate over expected minutes.
// One occurrence is 1 - p0; the tails subtract the lower exact terms, the same
// way corners.js prices 2+/3+ corners. Zero/negative rate -> all zero.
function tierProbs(rate90, expMin) {
  const lambda = (rate90 > 0 ? rate90 : 0) * (expMin / 90);
  if (!(lambda > 0)) return { p1: 0, p2: 0, p3: 0 };
  const p0 = Math.exp(-lambda);
  const e1 = lambda * p0;
  const e2 = ((lambda * lambda) / 2) * p0;
  return {
    p1: 1 - p0,
    p2: clamp(1 - p0 - e1, 0, 1),
    p3: clamp(1 - p0 - e1 - e2, 0, 1),
  };
}

// Minutes a starter is expected to play, from their season minutes-per-app,
// clamped to a sane band: a fringe starter who averages 30 min still gets at
// least a half, and nobody is credited beyond a full match.
function expectedMinutes(stat) {
  if (!stat || !stat.apps) return 80;
  return clamp(stat.minutes / stat.apps, 45, 90);
}

const pct = (x) => Math.round(clamp(x, 0, 1) * 100);

// Turn one player's summed season counts into the per-market percentages.
// Returns null when the player has no minutes (no usable rate to project from).
//
// Each market now carries its 1+/2+/3+ probabilities (under `tiers`) so the
// Props Finder can rank by any threshold; the flat `score`/`foul`/… fields keep
// the 1+ value the existing card table reads. `opts.foulMultiplier` lets the
// positional foul model (wide defender vs a dribbling winger) shade the foul
// rate up — default 1 (no adjustment).
export function playerProps(stat, opts = {}) {
  if (!stat || !stat.minutes) return null;
  const per90 = (n) => n / (stat.minutes / 90);
  const expMin = expectedMinutes(stat);
  const foulMult = opts.foulMultiplier > 0 ? opts.foulMultiplier : 1;

  const mk = (rate90) => {
    const t = tierProbs(rate90, expMin);
    return { 1: pct(t.p1), 2: pct(t.p2), 3: pct(t.p3) };
  };
  const tiers = {
    score: mk(per90(stat.goals)),
    shots: mk(per90(stat.shots)),
    shotOnTarget: mk(per90(stat.shotsOnTarget)),
    foul: mk(per90(stat.foulsCommitted) * foulMult),
    fouled: mk(per90(stat.foulsDrawn)),
    tackle: mk(per90(stat.tackles)),
    yellow: mk(per90(stat.yellow)),
  };

  return {
    minutes: stat.minutes,
    expMin: Math.round(expMin),
    score: tiers.score[1],
    foul: tiers.foul[1],
    fouled: tiers.fouled[1],
    tackle: tiers.tackle[1],
    shotOnTarget: tiers.shotOnTarget[1],
    tiers,
  };
}

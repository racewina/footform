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

// Probability of at least one occurrence given a per-90 rate and expected
// minutes. Zero/negative rate -> 0 (a player who never does X won't start now).
function onePlus(rate90, expMin) {
  if (!(rate90 > 0)) return 0;
  const lambda = rate90 * (expMin / 90);
  return 1 - Math.exp(-lambda);
}

// Minutes a starter is expected to play, from their season minutes-per-app,
// clamped to a sane band: a fringe starter who averages 30 min still gets at
// least a half, and nobody is credited beyond a full match.
function expectedMinutes(stat) {
  if (!stat || !stat.apps) return 80;
  return clamp(stat.minutes / stat.apps, 45, 90);
}

const pct = (x) => Math.round(clamp(x, 0, 1) * 100);

// Turn one player's summed season counts into the four prop percentages.
// Returns null when the player has no minutes (no usable rate to project from).
export function playerProps(stat) {
  if (!stat || !stat.minutes) return null;
  const per90 = (n) => n / (stat.minutes / 90);
  const expMin = expectedMinutes(stat);
  return {
    minutes: stat.minutes,
    expMin: Math.round(expMin),
    score: pct(onePlus(per90(stat.goals), expMin)),
    foul: pct(onePlus(per90(stat.foulsCommitted), expMin)),
    fouled: pct(onePlus(per90(stat.foulsDrawn), expMin)),
    tackle: pct(onePlus(per90(stat.tackles), expMin)),
    shotOnTarget: pct(onePlus(per90(stat.shotsOnTarget), expMin)),
  };
}

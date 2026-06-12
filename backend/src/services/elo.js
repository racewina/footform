// ---- Elo rating model (World-Football-Elo style) ----------------------------
//
// A second, independent view of team strength to blend with the form-based
// Dixon–Coles inputs. Where the form model only ever sees a team's own last 6
// games, Elo carries strength forward across the WHOLE season: every result
// nudges a team's rating up or down relative to the opponent it actually faced,
// so a side that beat strong teams is rated above one that beat weak teams even
// if both have the same recent W/D/L shape.
//
// We replay the season's finished matches in chronological order, updating both
// teams after each. Crucially we SNAPSHOT each team's rating just before every
// match, so a backtest can ask "what was this team's rating the moment before
// kickoff?" without leaking the result we're grading (see ratingBefore).
//
// The rating is then mapped to expected goals (eloExpectedGoals) and fed into
// the SAME scoreline grid the form model uses, so the blend stays internally
// consistent across every market.

const START = 1500; // every team enters at the league-average rating
const K = 20; // update step; standard for football season replays
const HFA = 65; // home-field advantage, in Elo points (~0.32 goals worth)
const RATING_PER_GOAL = 200; // rating gap that equals one goal of supremacy

// Margin-of-victory multiplier: a 3-0 should move ratings more than a 1-0, but
// with diminishing returns so blowouts don't whipsaw the table. Standard
// World-Football-Elo goal-difference index.
function gdMultiplier(gd) {
  if (gd <= 1) return 1;
  if (gd === 2) return 1.5;
  return (11 + gd) / 8;
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// Replay finished matches oldest-first, updating ratings and recording a
// pre-match snapshot for each team at each kickoff. Returns helpers to read a
// team's rating as of any timestamp, plus the final standings.
export function buildEloModel(matches) {
  const finished = (matches || [])
    .filter(
      (m) =>
        m.startTimestamp &&
        m.status?.type === "finished" &&
        m.homeScore?.current != null &&
        m.awayScore?.current != null &&
        m.homeTeam?.id &&
        m.awayTeam?.id
    )
    .sort((a, b) => (a.startTimestamp ?? 0) - (b.startTimestamp ?? 0));

  const ratings = new Map(); // teamId -> current rating
  // teamId -> [{ ts, rating }] ascending by ts: rating held going INTO that ts.
  const history = new Map();

  const get = (id) => (ratings.has(id) ? ratings.get(id) : START);
  const snapshot = (id, ts, rating) => {
    if (!history.has(id)) history.set(id, []);
    history.get(id).push({ ts, rating });
  };

  for (const m of finished) {
    const homeId = m.homeTeam.id;
    const awayId = m.awayTeam.id;
    const hs = m.homeScore.current;
    const as = m.awayScore.current;

    const rHome = get(homeId);
    const rAway = get(awayId);

    // Record the rating each side carried INTO this match before we update it.
    snapshot(homeId, m.startTimestamp, rHome);
    snapshot(awayId, m.startTimestamp, rAway);

    // Home advantage applies only to the win-probability expectation, not to
    // the stored rating (which stays a venue-neutral strength estimate).
    const expHome = expectedScore(rHome + HFA, rAway);
    const expAway = 1 - expHome;

    const scoreHome = hs > as ? 1 : hs < as ? 0 : 0.5;
    const scoreAway = 1 - scoreHome;

    const mult = gdMultiplier(Math.abs(hs - as));

    ratings.set(homeId, rHome + K * mult * (scoreHome - expHome));
    ratings.set(awayId, rAway + K * mult * (scoreAway - expAway));
  }

  // Rating a team carried into the last match BEFORE `ts` (strict <, so the
  // match being graded is never included). Binary search the ascending history.
  function ratingBefore(teamId, ts) {
    const hist = history.get(teamId);
    if (!hist || !hist.length) return START;
    let lo = 0;
    let hi = hist.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (hist[mid].ts < ts) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans === -1) return START; // no prior match — league-average default
    return hist[ans].rating;
  }

  return {
    ratingBefore,
    current: (teamId) => get(teamId),
    teams: ratings,
    matchesUsed: finished.length,
  };
}

// Map two Elo ratings to a pair of expected goals that sum to `totalBase` (the
// league's typical home+away goal total). Rating supremacy is split evenly
// around half the total: the stronger side's λ rises and the weaker side's
// falls by the same amount, so the total goal expectation is preserved while
// the SPREAD reflects the rating gap. HFA is added to the home rating so an
// even matchup still tilts slightly home, matching the form model's baselines.
export function eloExpectedGoals(homeRating, awayRating, totalBase) {
  const dr = homeRating + HFA - awayRating;
  const supremacy = dr / RATING_PER_GOAL; // expected home-minus-away goals
  const half = totalBase / 2;
  return {
    lambdaHome: half + supremacy / 2,
    lambdaAway: half - supremacy / 2,
  };
}

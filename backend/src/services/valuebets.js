// Value bets — where our model thinks an outcome is MORE likely than the
// bookmaker's best price implies.
//
// For a selection with model probability p (0–1) and a bookmaker's best decimal
// odds O, a flat unit stake returns:
//
//     EV = p * O - 1
//
// EV > 0 means positive expected value — the book is paying more than the true
// chance (as our model sees it) warrants. We express it as an edge percentage,
// edgePct = (p * O - 1) * 100. Equivalently, O beats our fair price 1/p.
//
// We only compare the three markets the model prices directly off its one
// scoreline grid (so the probabilities are internally consistent): Match Winner
// (1X2), Over/Under 2.5 goals, and Both Teams Score. Each candidate selection
// pairs a model probability with the best book price for the same selection.

const round2 = (x) => Math.round(x * 100) / 100;

// Only surface meaningful, plausible edges. A floor filters noise from the
// book's margin and model wobble; a ceiling drops the implausible edges that
// almost always mean stale odds or a mispriced match rather than real value.
export const MIN_EDGE_PCT = 4;
export const MAX_EDGE_PCT = 25;

// Pair each comparable selection's model probability (%) with its odds key.
function candidates(fx) {
  const m = fx.prediction?.markets;
  if (!m || fx.prediction?.home == null) return [];
  const home = fx.homeTeam?.shortName || fx.homeTeam?.name;
  const away = fx.awayTeam?.shortName || fx.awayTeam?.name;
  return [
    { market: "Match Result", selection: `${home} to win`, oddsKey: "homeWin", prob: fx.prediction.home },
    { market: "Match Result", selection: "Draw", oddsKey: "draw", prob: fx.prediction.draw },
    { market: "Match Result", selection: `${away} to win`, oddsKey: "awayWin", prob: fx.prediction.away },
    { market: "Total Goals", selection: "Over 2.5 goals", oddsKey: "over25", prob: m.over25 },
    { market: "Total Goals", selection: "Under 2.5 goals", oddsKey: "under25", prob: 100 - m.over25 },
    { market: "BTTS", selection: "Both teams to score", oddsKey: "bttsYes", prob: m.btts },
    { market: "BTTS", selection: "Both teams NOT to score", oddsKey: "bttsNo", prob: 100 - m.btts },
  ].filter((c) => typeof c.prob === "number" && c.prob > 0 && c.prob < 100);
}

// All positive-edge selections for one fixture, given the parsed best-price odds
// (apifootball.fetchFixtureOdds output). Returns [] when no odds or no edge.
export function fixtureValueBets(fx, odds) {
  const best = odds?.best;
  if (!best) return [];
  const out = [];
  for (const c of candidates(fx)) {
    const priced = best[c.oddsKey];
    if (!priced) continue;
    const p = c.prob / 100;
    const edgePct = Math.round((p * priced.odd - 1) * 1000) / 10; // one decimal
    if (edgePct < MIN_EDGE_PCT || edgePct > MAX_EDGE_PCT) continue;
    out.push({
      matchId: fx.id,
      home: fx.homeTeam?.name,
      away: fx.awayTeam?.name,
      homeLogo: fx.homeTeam?.logo,
      awayLogo: fx.awayTeam?.logo,
      league: fx._league?.name,
      leagueFlag: fx._league?.flag,
      kickoff: fx.startTimestamp,
      market: c.market,
      selection: c.selection,
      modelProb: c.prob,
      fairOdds: round2(100 / c.prob),
      bookOdds: round2(priced.odd),
      bookmaker: priced.book,
      edgePct,
    });
  }
  return out;
}

// Assemble the day's value bets across every league group, best edge first.
// `oddsMap` is { [fixtureId]: parsedOdds }. Each group carries its league on
// fixture._league so a flat list can still name the competition.
export function buildValueBets(leagues, oddsMap = {}) {
  const all = [];
  for (const g of leagues || []) {
    for (const fx of g.fixtures || []) {
      const withLeague = { ...fx, _league: g.league };
      all.push(...fixtureValueBets(withLeague, oddsMap[fx.id]));
    }
  }
  all.sort((a, b) => b.edgePct - a.edgePct);
  return all;
}

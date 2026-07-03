// Build "safest selection" accumulators from a day's fixtures.
//
// The prediction model emits a probability per market; we treat the model's
// fair decimal odds for a selection as 100/prob. An accumulator's combined
// odds is the product of its legs' odds — which equals 1 / (product of the
// leg probabilities) — so higher combined odds means a lower combined
// probability, i.e. more risk. To stay "safe" we take at most ONE selection
// per match (the market the model is most confident in, picking the safer
// side of two-way markets) and add the safest legs first until the running
// odds reach the requested range.

const round2 = (x) => Math.round(x * 100) / 100;

// Candidate selections for a fixture — each the safer side of its market.
function fixtureCandidates(fx) {
  const m = fx.prediction?.markets;
  if (!m || !fx.homeTeam?.id || !fx.awayTeam?.id) return [];
  const home = fx.homeTeam.shortName || fx.homeTeam.name;
  const away = fx.awayTeam.shortName || fx.awayTeam.name;

  const sided = (p, yes, no) =>
    p >= 50 ? { selection: yes, prob: p } : { selection: no, prob: 100 - p };

  const fav = m.winner === "home" ? home : away;
  // marketKey matches the keys produced by gradeMatch() so a leg can be graded
  // against an actual result via grade.grades[marketKey].hit.
  const cands = [
    { marketKey: "winner", market: "Match Result", selection: `${fav} to win`, prob: m.win },
    { marketKey: "home1Plus", market: "Team Goals", ...sided(m.home1Plus, `${home} to score`, `${home} not to score`) },
    { marketKey: "away1Plus", market: "Team Goals", ...sided(m.away1Plus, `${away} to score`, `${away} not to score`) },
    { marketKey: "home2Plus", market: "Team Goals", ...sided(m.home2Plus, `${home} 2+ goals`, `${home} under 2 goals`) },
    { marketKey: "away2Plus", market: "Team Goals", ...sided(m.away2Plus, `${away} 2+ goals`, `${away} under 2 goals`) },
    { marketKey: "over25", market: "Total Goals", ...sided(m.over25, "Over 2.5 goals", "Under 2.5 goals") },
    { marketKey: "btts", market: "BTTS", ...sided(m.btts, "Both teams to score", "Both teams not to score") },
  ];
  return cands.filter((c) => c.prob > 0 && c.prob < 100);
}

// One leg per fixture: the market the model is most confident in.
export function buildLegPool(leagues) {
  const pool = [];
  for (const g of leagues || []) {
    if (g.league?.friendly) continue; // friendlies are too unpredictable to stake
    for (const fx of g.fixtures || []) {
      const cands = fixtureCandidates(fx);
      if (!cands.length) continue;
      const best = cands.reduce((a, b) => (b.prob > a.prob ? b : a));
      const leg = {
        matchId: fx.id,
        home: fx.homeTeam?.name,
        away: fx.awayTeam?.name,
        homeLogo: fx.homeTeam?.logo,
        awayLogo: fx.awayTeam?.logo,
        league: g.league?.name,
        leagueFlag: g.league?.flag,
        kickoff: fx.startTimestamp,
        market: best.market,
        marketKey: best.marketKey,
        selection: best.selection,
        probability: best.prob,
        odds: round2(100 / best.prob),
      };
      // When the source fixture is a graded past result, carry the leg outcome
      // and the real score so the slip can be shown as won/lost.
      if (fx.grade?.grades?.[best.marketKey]) {
        leg.hit = !!fx.grade.grades[best.marketKey].hit;
      }
      if (fx.homeScore != null && fx.awayScore != null) {
        leg.homeScore = fx.homeScore;
        leg.awayScore = fx.awayScore;
      }
      pool.push(leg);
    }
  }
  return pool;
}

// Greedily stack the safest legs until the combined odds reach [lo, hi].
// Safest-first keeps each multiplier small, so the running product creeps up
// to the target rather than leaping past it.
export function buildAccumulator(pool, lo, hi) {
  const sorted = [...pool].sort((a, b) => b.probability - a.probability);
  const legs = [];
  let odds = 1;
  for (const leg of sorted) {
    if (odds >= lo) break;
    odds *= leg.odds;
    legs.push(leg);
    if (odds >= lo) break;
  }
  const combinedOdds = round2(odds);
  // If every leg carries a graded outcome, the slip is gradeable: it wins only
  // when all legs hit. Otherwise (live, ungraded) these stay null.
  const graded = legs.length > 0 && legs.every((l) => typeof l.hit === "boolean");
  const legHits = graded ? legs.filter((l) => l.hit).length : null;
  return {
    target: { lo, hi },
    legs,
    legCount: legs.length,
    combinedOdds,
    combinedProbability: legs.length ? round2(100 / odds) : null,
    inRange: legs.length > 0 && combinedOdds >= lo && combinedOdds <= hi,
    legHits,
    won: graded ? legHits === legs.length : null,
  };
}

export const ACCA_TARGETS = [
  { lo: 3, hi: 5 },
  { lo: 7, hi: 10 },
];

export function buildAccumulators(leagues, targets = ACCA_TARGETS) {
  const pool = buildLegPool(leagues);
  return targets.map((t) => buildAccumulator(pool, t.lo, t.hi));
}

// Blend Bets — accumulators that fuse the Safe Bets and VIP selection menus and
// are gated on REAL bookmaker odds, not the model's fair price.
//
// Per fixture we consider the safer side of every two-way market both models
// draw from (match result, each team to score / to score 2+, over 2.5, BTTS).
// Each candidate is then priced against the bookmaker feed; only selections whose
// DISPLAYED book odds are >= 1.20 qualify, and the combined target (3-5 / 7-10)
// is the product of those book odds — a genuinely placeable slip.

const round2 = (x) => Math.round(x * 100) / 100;

// When one side is far likelier to bag 2+ goals than the other, we prefer that
// team's "2+ goals" leg over the opposing team's weaker "to score" (1+) leg.
// EDGE = the gap (percentage points) between the two teams' 2+ probabilities that
// counts as "significant"; FLOOR = the favored side's own 2+ prob must clear this
// so we never stake a sub-even-money prop just because the opponent is worse.
const BLEND_2PLUS_EDGE = 20;
const BLEND_2PLUS_FLOOR = 50;

// Candidate selections for a fixture — the safer side of each market. No fair-odds
// floor here (unlike Safe Bets); the blend filters on bookmaker odds downstream.
export function blendCandidates(fx) {
  const m = fx.prediction?.markets;
  if (!m || !fx.homeTeam?.id || !fx.awayTeam?.id) return [];
  const home = fx.homeTeam.shortName || fx.homeTeam.name;
  const away = fx.awayTeam.shortName || fx.awayTeam.name;
  const sided = (p, yes, no) => (p >= 50 ? { selection: yes, prob: p } : { selection: no, prob: 100 - p });
  const fav = m.winner === "home" ? home : away;
  const cands = [
    { marketKey: "winner", market: "Match Result", selection: `${fav} to win`, prob: m.win },
    { marketKey: "home1Plus", market: "Team Goals", ...sided(m.home1Plus, `${home} to score`, `${home} not to score`) },
    { marketKey: "away1Plus", market: "Team Goals", ...sided(m.away1Plus, `${away} to score`, `${away} not to score`) },
    { marketKey: "home2Plus", market: "Team Goals", ...sided(m.home2Plus, `${home} 2+ goals`, `${home} under 2 goals`) },
    { marketKey: "away2Plus", market: "Team Goals", ...sided(m.away2Plus, `${away} 2+ goals`, `${away} under 2 goals`) },
    { marketKey: "over25", market: "Total Goals", ...sided(m.over25, "Over 2.5 goals", "Under 2.5 goals") },
    { marketKey: "btts", market: "BTTS", ...sided(m.btts, "Both teams to score", "Both teams not to score") },
  ];

  // Decisive 2+ scorer: when one team is far likelier to score 2+ than the other
  // (and clears the absolute floor), flag that team's "2+ goals" leg as preferred
  // so the pool takes it ahead of the opposing team's mere "to score" (1+) leg.
  const h2 = m.home2Plus, a2 = m.away2Plus;
  if (typeof h2 === "number" && typeof a2 === "number") {
    let key = null;
    if (h2 - a2 >= BLEND_2PLUS_EDGE && h2 >= BLEND_2PLUS_FLOOR) key = "home2Plus";
    else if (a2 - h2 >= BLEND_2PLUS_EDGE && a2 >= BLEND_2PLUS_FLOOR) key = "away2Plus";
    if (key) {
      const c = cands.find((x) => x.marketKey === key);
      if (c) c.priority = 1;
    }
  }

  return cands.filter((c) => c.prob > 0 && c.prob < 100);
}

// Stack legs by model confidence (safest first) into an accumulator in [lo, hi].
// Default: stop as soon as the product first reaches `lo` (the safest slip that
// clears the floor). `fill` mode instead keeps adding legs while they stay under
// `hi` — the BIGGEST slip that fits the ceiling — so adjacent tiers use different
// leg counts and don't collapse onto the same slip when leg odds are chunky (e.g.
// the team-2+ market, where one leg can vault past a whole odds band).
// Each leg must carry `bookOdds` and `odds`; one leg per fixture is the caller's job.
export function buildBookAccumulator(pool, lo, hi, { fill = false } = {}) {
  const sorted = [...pool].sort((a, b) => b.probability - a.probability);
  const legs = [];
  let book = 1, fair = 1, prob = 1;
  for (const leg of sorted) {
    if (fill) {
      if (book * leg.bookOdds > hi) break; // adding this leg would overshoot the ceiling
    } else if (book >= lo) {
      break; // safest slip that clears the floor
    }
    book *= leg.bookOdds;
    fair *= leg.odds;
    prob *= leg.probability / 100;
    legs.push(leg);
    if (!fill && book >= lo) break;
  }
  const combinedBookOdds = round2(book);
  const graded = legs.length > 0 && legs.every((l) => typeof l.hit === "boolean");
  const legHits = graded ? legs.filter((l) => l.hit).length : null;
  return {
    target: { lo, hi },
    legs,
    legCount: legs.length,
    combinedBookOdds,
    combinedFairOdds: round2(fair),
    combinedProbability: legs.length ? round2(prob * 100) : null,
    inRange: legs.length > 0 && combinedBookOdds >= lo && combinedBookOdds <= hi,
    legHits,
    won: graded ? legHits === legs.length : null,
  };
}

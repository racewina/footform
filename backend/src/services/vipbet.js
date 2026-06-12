// Build "VIP" accumulators — a SMALL, high-odds curated slip, deliberately
// different from Safe Bets.
//
// Safe Bets takes the single SAFEST market per match (highest probability,
// safer side of two-way markets) and stacks many ~90% legs until the running
// odds creep into a low band (3-5, 7-10). The legs are dull on purpose.
//
// VIP flips that philosophy:
//   • it draws from JUICIER markets — team 2+ goals, value wins, over 2.5, both
//     teams to score, and first-half corner 2+/3+ — things that pay more;
//   • for each match it picks the BEST-ODDS selection that still clears a
//     confidence floor, instead of the safest one. (The user noticed odds vary
//     across a match's markets; VIP backs the bigger price when the model is
//     still confident enough to justify it.)
//   • it keeps the slip SHORT — a handful of legs — for a bigger combined price.
//
// The model's probability is the gate: a leg must sit inside [MIN_PROB, MAX_PROB]
// — likely enough to back, but not a no-value near-certainty.

const round2 = (x) => Math.round(x * 100) / 100;

export const VIP_MIN_PROB = 55; // a leg must be at least this likely to qualify
export const VIP_MAX_PROB = 88; // skip near-certainties — no price, no point

// Goal / result candidate selections for a fixture. VIP only backs things TO
// happen (the "yes" side), never lays them, so these are one-directional.
export function goalWinCandidates(fx) {
  const m = fx.prediction?.markets;
  if (!m || !fx.homeTeam?.id || !fx.awayTeam?.id) return [];
  const home = fx.homeTeam.shortName || fx.homeTeam.name;
  const away = fx.awayTeam.shortName || fx.awayTeam.name;
  const fav = m.winner === "home" ? home : away;
  return [
    { marketKey: "winner", market: "Match Result", selection: `${fav} to win`, prob: m.win },
    { marketKey: "home2Plus", market: "Team Goals", selection: `${home} 2+ goals`, prob: m.home2Plus },
    { marketKey: "away2Plus", market: "Team Goals", selection: `${away} 2+ goals`, prob: m.away2Plus },
    { marketKey: "home1Plus", market: "Team Goals", selection: `${home} to score`, prob: m.home1Plus },
    { marketKey: "away1Plus", market: "Team Goals", selection: `${away} to score`, prob: m.away1Plus },
    { marketKey: "over25", market: "Total Goals", selection: "Over 2.5 goals", prob: m.over25 },
    { marketKey: "btts", market: "BTTS", selection: "Both teams to score", prob: m.btts },
  ].filter((c) => typeof c.prob === "number");
}

// First-half corner candidate selections, derived from a computed corner
// prediction (computeCornerPrediction output). Corner legs aren't gradeable
// (the feed has no per-half corner data), so they never carry a `hit`.
export function cornerCandidates(fx, corner) {
  const c = corner?.prediction || corner;
  if (!c) return [];
  const home = fx.homeTeam.shortName || fx.homeTeam.name;
  const away = fx.awayTeam.shortName || fx.awayTeam.name;
  const out = [];
  if (c.home) {
    out.push({ marketKey: "cornerHomeFh2", market: "1H Corners", selection: `${home} 2+ corners (1st half)`, prob: c.home.fh2Plus });
    out.push({ marketKey: "cornerHomeFh3", market: "1H Corners", selection: `${home} 3+ corners (1st half)`, prob: c.home.fh3Plus });
  }
  if (c.away) {
    out.push({ marketKey: "cornerAwayFh2", market: "1H Corners", selection: `${away} 2+ corners (1st half)`, prob: c.away.fh2Plus });
    out.push({ marketKey: "cornerAwayFh3", market: "1H Corners", selection: `${away} 3+ corners (1st half)`, prob: c.away.fh3Plus });
  }
  return out.filter((x) => typeof x.prob === "number");
}

// One VIP leg per fixture: among every qualifying market, the one with the BEST
// ODDS (lowest probability inside the confidence band = juiciest price). This is
// the "check the best odds market while making the selection" rule.
export function buildVipPool(leagues, cornerMap = {}) {
  const pool = [];
  for (const g of leagues || []) {
    for (const fx of g.fixtures || []) {
      const corner = cornerMap[fx.id] || null;
      const cands = [...goalWinCandidates(fx), ...cornerCandidates(fx, corner)]
        .filter((c) => c.prob >= VIP_MIN_PROB && c.prob <= VIP_MAX_PROB);
      if (!cands.length) continue;

      // Best odds = lowest probability still inside the band.
      const pick = cands.reduce((a, b) => (b.prob < a.prob ? b : a));
      const leg = {
        matchId: fx.id,
        home: fx.homeTeam?.name,
        away: fx.awayTeam?.name,
        homeLogo: fx.homeTeam?.logo,
        awayLogo: fx.awayTeam?.logo,
        league: g.league?.name,
        leagueFlag: g.league?.flag,
        kickoff: fx.startTimestamp,
        market: pick.market,
        marketKey: pick.marketKey,
        selection: pick.selection,
        probability: pick.prob,
        odds: round2(100 / pick.prob),
      };
      // For the track-record path: carry the graded outcome when the source is a
      // finished, gradeable goal/result market. Corner legs have no grade key.
      if (fx.grade?.grades?.[pick.marketKey]) {
        leg.hit = !!fx.grade.grades[pick.marketKey].hit;
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

// Two VIP products from the same pool. They differ in size AND ranking key so
// they're genuinely distinct slips, not nested subsets:
//   • VIP        — the most CONFIDENT few of the high-odds picks (value first)
//   • VIP Boost  — the few BIGGEST-ODDS picks (long-shot, max combined price)
export const VIP_TIERS = [
  { name: "VIP", subtitle: "Most confident value picks of the day", maxLegs: 5, sort: "prob" },
  { name: "VIP Boost", subtitle: "Fewer legs, biggest combined price", maxLegs: 3, sort: "odds" },
];

function assembleSlip(pool, tier) {
  const sorted = [...pool].sort((a, b) =>
    tier.sort === "odds" ? b.odds - a.odds : b.probability - a.probability
  );
  const legs = sorted.slice(0, tier.maxLegs);

  let odds = 1;
  for (const l of legs) odds *= l.odds;
  const combinedOdds = round2(odds);

  // A slip is gradeable only when EVERY leg carries a boolean outcome (so a slip
  // that includes a corner leg stays ungraded — honest, since corners can't be
  // checked against the feed).
  const graded = legs.length > 0 && legs.every((l) => typeof l.hit === "boolean");
  const legHits = graded ? legs.filter((l) => l.hit).length : null;

  return {
    tier: { name: tier.name, subtitle: tier.subtitle },
    legs,
    legCount: legs.length,
    combinedOdds,
    combinedProbability: legs.length ? round2(100 / odds) : null,
    legHits,
    won: graded ? legHits === legs.length : null,
  };
}

export function buildVipSlips(leagues, cornerMap = {}, tiers = VIP_TIERS) {
  const pool = buildVipPool(leagues, cornerMap);
  return tiers.map((t) => assembleSlip(pool, t));
}

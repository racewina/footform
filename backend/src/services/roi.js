// ROI tracker — turns the model's graded picks into a betting P&L.
//
// HONEST BASIS. API-Football serves no odds for past fixtures, and the app has
// no database to record live prices, so we cannot replay the real bookmaker
// prices a Value Bet was struck at. What we CAN reconstruct deterministically is
// every pick's outcome (from the graded result) and the model's own FAIR odds
// (100 / probability). So everything here is settled at fair odds — a deliberate
// CONSERVATIVE FLOOR: a user taking the best available book price (always ≥ fair)
// would do at least as well, usually better. We never overstate returns.
//
// Two products are tracked, both fully reconstructable and gradeable:
//   • Safe Bets   — the accumulator slips (won only if every leg lands)
//   • Top Picks   — the single most-confident market per match, bet flat
// Stakes are 1 unit flat. ROI% = net profit / total staked × 100.

const round2 = (x) => Math.round(x * 100) / 100;

// Settle a set of graded accumulator slips (buildAccumulator outputs). Only slips
// whose every leg carries a real outcome (won is a boolean) are counted.
export function settleSlips(slips) {
  const graded = (slips || []).filter((s) => s.legCount > 0 && typeof s.won === "boolean");
  let staked = 0, returned = 0, wins = 0;
  for (const s of graded) {
    staked += 1;
    if (s.won) { returned += s.combinedOdds; wins += 1; }
  }
  return summarize(graded.length, wins, staked, returned);
}

// Settle single legs (buildLegPool outputs) flat at their fair odds. A leg counts
// only when it carries a graded outcome (.hit is a boolean).
export function settleSingles(legs) {
  const graded = (legs || []).filter((l) => typeof l.hit === "boolean");
  let staked = 0, returned = 0, wins = 0;
  for (const l of graded) {
    staked += 1;
    if (l.hit) { returned += l.odds; wins += 1; }
  }
  return summarize(graded.length, wins, staked, returned);
}

function summarize(bets, wins, staked, returned) {
  return {
    bets,
    wins,
    losses: bets - wins,
    winRate: bets ? Math.round((wins / bets) * 100) : null,
    staked: round2(staked),
    returned: round2(returned),
    profit: round2(returned - staked),
    roiPct: staked ? round2(((returned - staked) / staked) * 100) : null,
  };
}

// Net profit (units) for a day's Safe Bets slips — drives the trend line.
export function dayProfit(slips) {
  let profit = 0, bets = 0;
  for (const s of slips || []) {
    if (s.legCount > 0 && typeof s.won === "boolean") {
      bets += 1;
      profit += s.won ? s.combinedOdds - 1 : -1;
    }
  }
  return { profit: round2(profit), bets };
}

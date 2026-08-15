// Odds Generator — for one fixture, enumerate every market that has BOTH a model
// confidence and a REAL bookmaker price, then let the route keep whichever land in
// the user's chosen odds range and surface the single highest-confidence one.
//
// Two families of candidate:
//   • goal/result — probability straight from the Dixon–Coles markets, price from
//     the parsed odds feed (`best`): to score, team/total Over 1.5/2.5/3.5, BTTS,
//     Double Chance, the favourite to win.
//   • corners — the corner model is Poisson, so P(≥ k) is read off the projected
//     rate for any Over line the book publishes (total, 1st-half total, per-team
//     full, per-team 1st-half). Only clean .5 lines are used (no push ambiguity).
//
// Every candidate carries a real `bookOdds`; nothing here is priced at the model's
// own fair odds. That's the whole point — the range filter is on money you can
// actually bet.

const round2 = (x) => Math.round(x * 100) / 100;

function poissonPmf(k, lambda) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / fact;
}
// P(X >= k) for a Poisson rate — the model probability of an Over (k-1).5 line.
function poissonAtLeast(k, lambda) {
  if (k <= 0) return 1;
  let cdf = 0;
  for (let i = 0; i < k; i++) cdf += poissonPmf(i, lambda);
  return Math.max(0, Math.min(1, 1 - cdf));
}

// Goal/result markets: [oddKey in `best`, model probability, selection label].
function goalCandidates(fx, best) {
  const m = fx.prediction?.markets;
  if (!m) return [];
  const home = fx.homeTeam?.shortName || fx.homeTeam?.name || "Home";
  const away = fx.awayTeam?.shortName || fx.awayTeam?.name || "Away";
  const p = fx.prediction || {};
  const favKey = m.winner === "home" ? "homeWin" : "awayWin";
  const favTeam = m.winner === "home" ? home : away;

  const defs = [
    { key: "winner", group: "Match Result", selection: `${favTeam} to win`, oddKey: favKey, prob: m.win },
    { key: "dc1x", group: "Double Chance", selection: `${home} or draw`, oddKey: "dc1x", prob: (p.home ?? 0) + (p.draw ?? 0) },
    { key: "dc12", group: "Double Chance", selection: `${home} or ${away}`, oddKey: "dc12", prob: (p.home ?? 0) + (p.away ?? 0) },
    { key: "dcx2", group: "Double Chance", selection: `Draw or ${away}`, oddKey: "dcx2", prob: (p.draw ?? 0) + (p.away ?? 0) },
    { key: "home1Plus", group: "Team Goals", selection: `${home} to score`, oddKey: "homeToScore", prob: m.home1Plus },
    { key: "away1Plus", group: "Team Goals", selection: `${away} to score`, oddKey: "awayToScore", prob: m.away1Plus },
    { key: "home2Plus", group: "Team Goals", selection: `${home} over 1.5 goals`, oddKey: "home2Plus", prob: m.home2Plus },
    { key: "away2Plus", group: "Team Goals", selection: `${away} over 1.5 goals`, oddKey: "away2Plus", prob: m.away2Plus },
    { key: "over15", group: "Total Goals", selection: "Over 1.5 goals", oddKey: "over15", prob: m.over15 },
    { key: "over25", group: "Total Goals", selection: "Over 2.5 goals", oddKey: "over25", prob: m.over25 },
    { key: "over35", group: "Total Goals", selection: "Over 3.5 goals", oddKey: "over35", prob: m.over35 },
    { key: "under15", group: "Total Goals", selection: "Under 1.5 goals", oddKey: "under15", prob: typeof m.over15 === "number" ? 100 - m.over15 : undefined },
    { key: "under25", group: "Total Goals", selection: "Under 2.5 goals", oddKey: "under25", prob: typeof m.over25 === "number" ? 100 - m.over25 : undefined },
    { key: "under35", group: "Total Goals", selection: "Under 3.5 goals", oddKey: "under35", prob: typeof m.over35 === "number" ? 100 - m.over35 : undefined },
    { key: "btts", group: "BTTS", selection: "Both teams to score", oddKey: "bttsYes", prob: m.btts },
  ];

  const out = [];
  for (const d of defs) {
    const priced = best?.[d.oddKey];
    if (!priced || !(priced.odd > 1)) continue;
    if (typeof d.prob !== "number") continue;
    out.push({
      group: d.group, marketKey: d.key, selection: d.selection,
      probability: Math.round(d.prob), bookOdds: round2(priced.odd), bookmaker: priced.book,
    });
  }
  return out;
}

// Corner markets: read P(>= k) off the Poisson rate for the bucket, priced against
// each .5 Over line the book carries. `cornerPred` is computeCornerPrediction().
function cornerCandidates(fx, cornerPred, corners) {
  if (!cornerPred || !corners) return [];
  const home = fx.homeTeam?.shortName || fx.homeTeam?.name || "Home";
  const away = fx.awayTeam?.shortName || fx.awayTeam?.name || "Away";

  // bucket -> { lambda, label(threshold) }
  const buckets = {
    totalFull: { lambda: cornerPred.matchTotal, label: (k) => `Over ${k - 0.5} total corners` },
    total1H: { lambda: cornerPred.firstHalfTotal, label: (k) => `Over ${k - 0.5} corners (1st half)` },
    homeFull: { lambda: cornerPred.home?.full, label: (k) => `${home} ${k}+ corners` },
    awayFull: { lambda: cornerPred.away?.full, label: (k) => `${away} ${k}+ corners` },
    home1H: { lambda: cornerPred.home?.firstHalf, label: (k) => `${home} ${k}+ corners (1st half)` },
    away1H: { lambda: cornerPred.away?.firstHalf, label: (k) => `${away} ${k}+ corners (1st half)` },
  };

  const out = [];
  for (const [bucket, lines] of Object.entries(corners)) {
    const def = buckets[bucket];
    if (!def || !(def.lambda > 0)) continue;
    for (const [lineStr, row] of Object.entries(lines)) {
      if (!/\.5$/.test(lineStr)) continue;          // clean two-way lines only
      const over = row.over;
      if (!over || !(over.odd > 1)) continue;
      const k = Math.ceil(parseFloat(lineStr));      // Over (k-.5) ⇔ X >= k
      out.push({
        group: "Corners", marketKey: `corner:${bucket}:${lineStr}`, selection: def.label(k),
        probability: Math.round(poissonAtLeast(k, def.lambda) * 100),
        bookOdds: round2(over.odd), bookmaker: over.book,
      });
    }
  }
  return out;
}

// All priced candidates for a fixture (goal/result + corners).
export function oddsCandidates(fx, cornerPred, odds) {
  return [
    ...goalCandidates(fx, odds?.best),
    ...cornerCandidates(fx, cornerPred, odds?.corners),
  ];
}

// Narrow a fixture's candidates to one market family (the /odds-generator market
// filter). "all" or anything unrecognised → unchanged. Over/Under cover TOTAL
// goals; corners split by half; "goals" is the team-scoring + BTTS markets.
export function filterByMarket(cands, market) {
  switch (market) {
    case "goals":       return cands.filter((c) => c.group === "Team Goals" || c.group === "BTTS");
    case "over":        return cands.filter((c) => c.group === "Total Goals" && /\bOver\b/.test(c.selection));
    case "under":       return cands.filter((c) => c.group === "Total Goals" && /\bUnder\b/.test(c.selection));
    case "corner1h":    return cands.filter((c) => c.group === "Corners" && /1st half/.test(c.selection));
    case "cornertotal": return cands.filter((c) => c.group === "Corners" && !/1st half/.test(c.selection));
    case "dc":          return cands.filter((c) => c.group === "Double Chance");
    default:            return cands; // all
  }
}

// The single highest-confidence candidate whose real book odds fall in [min, max].
// Returns null when nothing qualifies.
export function bestInRange(candidates, min, max) {
  let pick = null;
  for (const c of candidates) {
    if (c.bookOdds < min || c.bookOdds > max) continue;
    if (!pick || c.probability > pick.probability) pick = c;
  }
  return pick;
}

// The odds-range ladder the UI offers (0.10-wide buckets). Kept here so the route
// and any client share one definition.
export function oddsRangeLadder() {
  const rungs = [];
  for (let lo = 1.1; lo < 5.0001; lo += 0.1) {
    const l = round2(lo);
    rungs.push({ key: `${l.toFixed(2)}-${round2(l + 0.09).toFixed(2)}`, min: l, max: round2(l + 0.099) });
  }
  return rungs;
}

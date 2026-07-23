// VIP — a "bet builder" browser for the day's favourable teams.
//
// For every fixture with a clear favourite, we surface that team's full menu of
// CORRELATED picks — to win, to score (1+), to score 2+, the match over 2.5, and
// to win first-half corners — each with its model probability and fair price, and
// a combined price if you took the lot. Several teams are listed (most dominant
// first) so you can browse the day's possibilities and build your own slip.
//
// Why one team per card: these picks are positively correlated — when a strong
// side controls a game they tend to land together — so stacking within ONE match
// is a real edge, whereas combining different matches just needs two dominations
// at once (the flaw that sank the old VIP).

const round2 = (x) => Math.round(x * 100) / 100;

// Kept for the route's corner-shortlist ranking (which fixtures deserve a corner
// fetch). The goal/result candidate menu for a fixture.
export const VIP_MIN_PROB = 55;
export const VIP_MAX_PROB = 88;
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
    { marketKey: "over25", market: "Total Goals", selection: "Over 2.5 goals", prob: m.over25 },
    { marketKey: "btts", market: "BTTS", selection: "Both teams to score", prob: m.btts },
  ].filter((c) => typeof c.prob === "number");
}

const BUILDER_MAX = 8; // up to this many matches listed as builders
// Per-pick floors: a pick must be at least this likely to make the menu.
const FLOOR = { win: 50, score1: 65, twoPlus: 50, over25: 52, btts: 55, corner2: 52, corner3: 40 };

// Some picks logically CONTAIN others, so multiplying all their prices would
// count the same outcome twice and inflate the combined odds. Given the set of
// qualifying pick keys, drop the redundant (implied) one in each overlap and
// return the keys that should actually be priced:
//   • scoring 2+ implies scoring 1+                → drop the 1+ leg.
//   • BTTS ≡ (home scores) AND (away scores). If both team-to-score legs are
//     already in, BTTS adds nothing → drop BTTS. If only one side is present,
//     BTTS implies that 1+ leg → drop the 1+ leg and keep BTTS (the correct
//     joint the model already prices with its scoreline correlation).
//   • Over 2.5 is guaranteed once the kept goal legs already force 3+ goals
//     (e.g. a 2+ leg on one side and any scoring leg on the other) → drop it.
function priceableKeys(keys) {
  const s = new Set(keys);
  if (s.has("home2Plus")) s.delete("home1Plus");
  if (s.has("away2Plus")) s.delete("away1Plus");

  if (s.has("btts")) {
    const homeScores = s.has("home1Plus") || s.has("home2Plus");
    const awayScores = s.has("away1Plus") || s.has("away2Plus");
    if (homeScores && awayScores) s.delete("btts");
    else { s.delete("home1Plus"); s.delete("away1Plus"); }
  }

  const minHome = s.has("home2Plus") ? 2 : (s.has("home1Plus") || s.has("btts")) ? 1 : 0;
  const minAway = s.has("away2Plus") ? 2 : (s.has("away1Plus") || s.has("btts")) ? 1 : 0;
  if (s.has("over25") && minHome + minAway >= 3) s.delete("over25");

  return s;
}

// A whole-match bet-builder: every correlated pick the model rates likely across
// BOTH teams — the favourite to win, either side to score / score 2+, over 2.5,
// both teams to score, and first-half corners for the stronger side. Returns null
// when fewer than two picks qualify (nothing worth building on).
function matchBuilder(fx, g, corner) {
  const p = fx.prediction;
  const m = p?.markets;
  if (!m || !fx.homeTeam?.id || !fx.awayTeam?.id) return null;

  const home = fx.homeTeam.shortName || fx.homeTeam.name;
  const away = fx.awayTeam.shortName || fx.awayTeam.name;
  const homeFav = (p.home ?? 0) >= (p.away ?? 0);
  const favWin = Math.max(p.home ?? 0, p.away ?? 0) || m.win || 0;
  const favTeam = homeFav ? home : away;
  const c = corner?.prediction || corner;
  const cTeam = c ? (homeFav ? c.home : c.away) : null;

  const cands = [
    { ok: favWin >= FLOOR.win, marketKey: "winner", market: "Match Result", selection: `${favTeam} to win`, prob: favWin },
    { ok: m.home1Plus >= FLOOR.score1, marketKey: "home1Plus", market: "Team Goals", selection: `${home} to score`, prob: m.home1Plus },
    { ok: m.away1Plus >= FLOOR.score1, marketKey: "away1Plus", market: "Team Goals", selection: `${away} to score`, prob: m.away1Plus },
    { ok: m.home2Plus >= FLOOR.twoPlus, marketKey: "home2Plus", market: "Team Goals", selection: `${home} 2+ goals`, prob: m.home2Plus },
    { ok: m.away2Plus >= FLOOR.twoPlus, marketKey: "away2Plus", market: "Team Goals", selection: `${away} 2+ goals`, prob: m.away2Plus },
    { ok: m.over25 >= FLOOR.over25, marketKey: "over25", market: "Total Goals", selection: "Over 2.5 goals", prob: m.over25 },
    { ok: m.btts >= FLOOR.btts, marketKey: "btts", market: "BTTS", selection: "Both teams to score", prob: m.btts },
    cTeam && { ok: cTeam.fh2Plus >= FLOOR.corner2, marketKey: homeFav ? "cornerHomeFh2" : "cornerAwayFh2", market: "1H Corners", selection: `${favTeam} 2+ corners (1st half)`, prob: cTeam.fh2Plus },
  ].filter((x) => x && x.ok && typeof x.prob === "number");

  // Drop picks that are logically implied by others (e.g. BTTS when both teams
  // are already backed to score), so overlapping markets aren't priced twice.
  const keep = priceableKeys(cands.map((c) => c.marketKey));
  const picks = cands.filter((c) => keep.has(c.marketKey));

  if (picks.length < 2) return null;

  const legs = picks.map((cand) => {
    const leg = {
      matchId: fx.id,
      home: fx.homeTeam?.name,
      away: fx.awayTeam?.name,
      homeLogo: fx.homeTeam?.logo,
      awayLogo: fx.awayTeam?.logo,
      league: g.league?.name,
      leagueFlag: g.league?.flag,
      kickoff: fx.startTimestamp,
      market: cand.market,
      marketKey: cand.marketKey,
      selection: cand.selection,
      probability: cand.prob,
      odds: round2(100 / cand.prob),
    };
    if (fx.grade?.grades?.[cand.marketKey]) leg.hit = !!fx.grade.grades[cand.marketKey].hit;
    if (fx.homeScore != null && fx.awayScore != null) { leg.homeScore = fx.homeScore; leg.awayScore = fx.awayScore; }
    return leg;
  });

  let odds = 1;
  for (const l of legs) odds *= l.odds;
  const combinedOdds = round2(odds);
  const graded = legs.length > 0 && legs.every((l) => typeof l.hit === "boolean");
  const legHits = graded ? legs.filter((l) => l.hit).length : null;

  // How appealing the match is to build on — a clear favourite OR a high-scoring
  // game both rank highly (1+ markets excluded since they're near-certain).
  const interest = Math.max(favWin, m.over25 || 0, m.btts || 0, m.home2Plus || 0, m.away2Plus || 0);
  const lean = favWin >= 58 ? `${favTeam} favoured` : (m.over25 >= 58 || m.btts >= 60) ? "High-scoring" : "Even, goals likely";

  return {
    matchId: fx.id,
    tier: { name: `${fx.homeTeam?.name} v ${fx.awayTeam?.name}`, subtitle: lean },
    lean,
    home: fx.homeTeam?.name,
    away: fx.awayTeam?.name,
    homeLogo: fx.homeTeam?.logo,
    awayLogo: fx.awayTeam?.logo,
    league: g.league?.name,
    leagueFlag: g.league?.flag,
    kickoff: fx.startTimestamp,
    interest,
    legs,
    legCount: legs.length,
    combinedOdds,
    combinedProbability: round2(100 / odds),
    legHits,
    won: graded ? legHits === legs.length : null,
  };
}

// Marquee competitions for the "Top Matches" VIP batch — the World Cup, the
// European cups and the big domestic leagues. These get their own slate so a
// high-scoring minor league can't crowd the headline games out of the VIP.
export const MARQUEE_LEAGUES = new Set([
  "1",   // World Cup
  "2",   // Champions League
  "3",   // Europa League
  "848", // Conference League
  "39",  // Premier League
  "140", // La Liga
  "135", // Serie A
  "78",  // Bundesliga
  "61",  // Ligue 1
  "71",  // Brasileirão Série A
]);

// The day's match bet-builders, most appealing first. (cornerMap optional; the
// record path passes none, so those builders carry no corner picks.) `maxSlips`
// caps the list — the general slate uses the default, the Top Matches batch a
// smaller number.
export function buildVipSlips(leagues, cornerMap = {}, maxSlips = BUILDER_MAX) {
  const builders = [];
  for (const g of leagues || []) {
    if (g.league?.friendly) continue; // friendlies are too unpredictable for VIP slips
    for (const fx of g.fixtures || []) {
      const b = matchBuilder(fx, g, cornerMap[fx.id] || null);
      if (b) builders.push(b);
    }
  }
  builders.sort((a, b) => b.interest - a.interest);
  // `interest` is only the internal ranking score — strip it from what ships.
  return builders.slice(0, maxSlips).map(({ interest, ...slip }) => slip);
}

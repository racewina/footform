// ---- Positional foul model (EXPERIMENTAL) -----------------------------------
//
// Observation: wide defenders (full-backs / wing-backs) commit more fouls when
// the opponent fields a winger who runs at them with the ball. So a wide
// defender's base foul rate is shaded UP by the dribbling threat of the wide
// attacker they'll face on their flank.
//
// HARD REQUIREMENT: this needs the official lineup `grid` ("row:col" on the
// pitch) to know who is wide and on which side — it does NOT run on a projected
// XI. It's a first-pass, lineup-gated experiment: treat the boost as a hypothesis
// to validate, not a settled number.
//
// Method, per fixture:
//   • A team's WIDE DEFENDERS = the leftmost & rightmost players in its back
//     line (pos "D"); its WIDE ATTACKERS = the leftmost & rightmost of its
//     forward/wide players (pos "F"/"M").
//   • Flanks mirror across the halfway line, so a home LEFT defender faces the
//     away RIGHT attacker, and so on.
//   • The defender's foul multiplier scales with how much that winger dribbles
//     relative to a baseline, capped so it can't run away.

const BASE_DRIBBLE = 2.5; // ~ an average wide attacker's dribble attempts per 90
const FOUL_K = 0.25; // how hard the dribble threat pushes the foul rate
const FOUL_MULT_CAP = 1.5; // never more than +50%

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function parseGrid(g) {
  if (!g || typeof g !== "string") return null;
  const [row, col] = g.split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  return { row, col };
}

// Extreme-column players among a position group: { left, right } (may be the
// same player, or null when the group is empty / has no grid).
function widePair(starters, posSet) {
  const withGrid = starters
    .map((p) => ({ ...p, g: parseGrid(p.grid) }))
    .filter((p) => p.g && posSet.has(p.pos));
  if (!withGrid.length) return { left: null, right: null };
  let left = withGrid[0], right = withGrid[0];
  for (const p of withGrid) {
    if (p.g.col < left.g.col) left = p;
    if (p.g.col > right.g.col) right = p;
  }
  return { left, right };
}

const dribbleMult = (dribbles90) => {
  if (!(dribbles90 > 0)) return 1;
  return clamp(1 + FOUL_K * (dribbles90 / BASE_DRIBBLE - 1), 1, FOUL_MULT_CAP);
};

// Given both teams' starters (each { id, pos, grid, dribbles90, name }), return
// a map { [defenderId]: { foulMultiplier, opponent, opponentDribbles90 } } for
// the wide defenders that have a winger to mark. Empty when no grid (projected
// XI) — callers then apply no adjustment.
export function foulMatchups(homeStarters, awayStarters) {
  const out = {};
  const ATT = new Set(["F", "M"]);
  const DEF = new Set(["D"]);

  const homeDef = widePair(homeStarters, DEF);
  const awayDef = widePair(awayStarters, DEF);
  const homeAtt = widePair(homeStarters, ATT);
  const awayAtt = widePair(awayStarters, ATT);

  // Flanks mirror: a team's LEFT defender meets the opponent's RIGHT attacker.
  const pair = (defender, winger) => {
    if (!defender || !winger || defender.id == null) return;
    const d90 = winger.dribbles90 || 0;
    const mult = dribbleMult(d90);
    if (mult <= 1) return; // nothing to add
    out[defender.id] = { foulMultiplier: +mult.toFixed(3), opponent: winger.name || null, opponentDribbles90: +d90.toFixed(2) };
  };

  pair(homeDef.left, awayAtt.right);
  pair(homeDef.right, awayAtt.left);
  pair(awayDef.left, homeAtt.right);
  pair(awayDef.right, homeAtt.left);

  return out;
}

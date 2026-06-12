// Backtesting: grade a finished match's model prediction against the real
// result. The prediction itself is produced by the SAME engine the live app
// uses (computePrediction), but fed only with each team's form as it stood
// BEFORE kickoff (see reconstructFormBefore) — so this is a faithful "what
// would we have called?" check, not hindsight.

import { parseFormFromEvents } from "./predictions.js";

// Rebuild a team's form using only matches that finished before `beforeTs`
// (the graded match's kickoff). Prevents leaking the result we're grading, or
// any later games, into the inputs.
export function reconstructFormBefore(events, teamId, beforeTs) {
  const prior = (events || []).filter(
    (e) => (e.startTimestamp ?? 0) < beforeTs
  );
  return parseFormFromEvents(prior, teamId);
}

// A market is graded as a binary YES/NO call at the 50% threshold (the model
// "backs" YES when its probability is >= 50%), except the winner market which
// backs the favourite outright. Each grade records the call, what happened, and
// whether they agree.
export function gradeMatch(markets, homeScore, awayScore) {
  const total = homeScore + awayScore;
  const winner = homeScore > awayScore ? "home" : homeScore < awayScore ? "away" : "draw";
  const bttsActual = homeScore >= 1 && awayScore >= 1;
  const over25Actual = total >= 3;

  const yesNo = (pct, actual) => {
    const call = pct >= 50; // model backs YES
    return { call: call ? "Yes" : "No", actual: actual ? "Yes" : "No", hit: call === actual };
  };

  const grades = {
    winner: {
      call: markets.winner, // "home" | "away"
      actual: winner,
      hit: winner === markets.winner,
      pct: markets.win,
    },
    home1Plus: { pct: markets.home1Plus, ...yesNo(markets.home1Plus, homeScore >= 1) },
    home2Plus: { pct: markets.home2Plus, ...yesNo(markets.home2Plus, homeScore >= 2) },
    away1Plus: { pct: markets.away1Plus, ...yesNo(markets.away1Plus, awayScore >= 1) },
    away2Plus: { pct: markets.away2Plus, ...yesNo(markets.away2Plus, awayScore >= 2) },
    over25: { pct: markets.over25, ...yesNo(markets.over25, over25Actual) },
    btts: { pct: markets.btts, ...yesNo(markets.btts, bttsActual) },
  };

  const keys = Object.keys(grades);
  const hits = keys.filter((k) => grades[k].hit).length;

  return {
    actual: { homeScore, awayScore, winner, btts: bttsActual, over25: over25Actual, totalGoals: total },
    grades,
    hits,
    total: keys.length,
  };
}

// The market keys we track, in display order, with human labels.
export const GRADED_MARKETS = [
  { key: "winner", label: "Winner" },
  { key: "home1Plus", label: "Home 1+" },
  { key: "away1Plus", label: "Away 1+" },
  { key: "home2Plus", label: "Home 2+" },
  { key: "away2Plus", label: "Away 2+" },
  { key: "over25", label: "Over 2.5" },
  { key: "btts", label: "BTTS" },
];

// The confidence (0..1) the model placed on the call it actually backed, plus
// whether that call landed. Hit-rate only tells us how often we were right;
// this lets us score HOW SURE we were against what happened — the basis for
// both Brier and calibration. For yes/no markets the backed side is "Yes" when
// pct>=50 else "No", so its confidence is the side with the larger probability.
// The winner market backs the favourite, whose pct is already that side's prob.
function callConfidence(cell) {
  if (!cell || cell.pct == null) return null;
  const conf = cell.call === "No" ? 100 - cell.pct : cell.pct;
  return { p: conf / 100, correct: cell.hit ? 1 : 0 };
}

// Confidence buckets for the calibration table. The backed-side confidence is
// always >=50, so we bin from 50 up. The last bin's hi is 101 to include 100%.
const CALIB_BINS = [
  { lo: 50, hi: 60 },
  { lo: 60, hi: 70 },
  { lo: 70, hi: 80 },
  { lo: 80, hi: 90 },
  { lo: 90, hi: 101 },
];

// Roll a list of graded matches up into per-market and overall hit rates, plus
// a Brier score (mean squared error of the backed-call confidence vs outcome —
// 0 is perfect, 0.25 is a coin-flip guess; lower is better) and a calibration
// table (within each confidence band, the mean stated confidence vs the real
// hit frequency — they should match if the probabilities are trustworthy).
export function summarizeAccuracy(graded) {
  const perMarket = Object.fromEntries(
    GRADED_MARKETS.map((m) => [m.key, { hits: 0, total: 0, brierSum: 0 }])
  );
  let hits = 0;
  let total = 0;
  let brierSum = 0;
  const bins = CALIB_BINS.map((b) => ({ ...b, n: 0, confSum: 0, hitSum: 0 }));

  for (const g of graded) {
    for (const m of GRADED_MARKETS) {
      const cell = g.grades[m.key];
      if (!cell) continue;
      const pm = perMarket[m.key];
      pm.total += 1;
      total += 1;
      if (cell.hit) {
        pm.hits += 1;
        hits += 1;
      }

      const cc = callConfidence(cell);
      if (cc) {
        const b = (cc.p - cc.correct) ** 2;
        pm.brierSum += b;
        brierSum += b;
        const confPct = cc.p * 100;
        const bin = bins.find((x) => confPct >= x.lo && confPct < x.hi);
        if (bin) {
          bin.n += 1;
          bin.confSum += confPct;
          bin.hitSum += cc.correct;
        }
      }
    }
  }

  for (const k of Object.keys(perMarket)) {
    const c = perMarket[k];
    c.pct = c.total ? Math.round((c.hits / c.total) * 100) : null;
    c.brier = c.total ? +(c.brierSum / c.total).toFixed(3) : null;
    delete c.brierSum;
  }

  const calibration = bins
    .filter((b) => b.n > 0)
    .map((b) => ({
      lo: b.lo,
      hi: b.hi === 101 ? 100 : b.hi,
      n: b.n,
      avgConf: Math.round(b.confSum / b.n),
      hitRate: Math.round((b.hitSum / b.n) * 100),
    }));

  return {
    overall: {
      hits,
      total,
      pct: total ? Math.round((hits / total) * 100) : null,
      brier: total ? +(brierSum / total).toFixed(3) : null,
    },
    perMarket,
    calibration,
  };
}

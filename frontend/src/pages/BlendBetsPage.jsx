import { useQuery } from "@tanstack/react-query";
import { getToolPass, clearToolPass } from "../components/ToolGate";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchBlendBets(scope, band, kind) {
  const base = kind === "team2plus" ? "/api/team-2plus" : "/api/blend-bets";
  let q = `?tz=${encodeURIComponent(TZ)}`;
  if (scope === "england") q += "&scope=england";
  if (kind !== "team2plus" && band === "high") q += "&band=high";
  const res = await fetch(`${base}${q}`, { headers: { "x-odds-pass": getToolPass() } });
  if (res.status === 401) { clearToolPass(); throw new Error("This tool is private."); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

function oddsColor(prob) {
  if (prob == null) return "var(--text3)";
  if (prob >= 75) return "#2ecc71";
  if (prob >= 60) return "#9acd32";
  if (prob >= 50) return "#f1c40f";
  return "#e74c3c";
}

export default function BlendBetsPage({ onOpenFixture, scope, band, kind }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["blend-bets", scope || "all", band || "low", kind || "blend"],
    queryFn: () => fetchBlendBets(scope, band, kind),
  });
  const targets = band === "high" ? "10–20 and 20–50" : "3–5 and 7–10";

  const slips = data?.slips || [];
  const hasLegs = slips.some((s) => s.legCount > 0);

  return (
    <div style={styles.page}>
      <div style={styles.note}>
        <span aria-hidden="true">ⓘ</span>
        {kind === "team2plus" ? (
          <span>
            {scope === "england" && <strong>🏴󠁧󠁢󠁥󠁮󠁧󠁿 English leagues only. </strong>}
            Each leg is a <strong>team to score 2+ goals</strong> — the side the model
            rates likeliest — priced at <strong>real bookmaker odds of 1.30 or higher</strong>;
            teams priced below 1.30 don't qualify. Two accumulators combined to 10–15 and
            15–50 odds, strongest events first. Estimates only — not betting advice, and
            never guaranteed.
          </span>
        ) : (
          <span>
            {scope === "england" && <strong>🏴󠁧󠁢󠁥󠁮󠁧󠁿 English leagues only. </strong>}
            {band === "high" && <strong>Higher-risk. </strong>}
            Two accumulators that blend the Safe Bets and VIP selection models,
            combined to a {targets} odds target. <strong>Every leg is priced at
            real bookmaker odds of 1.20 or higher</strong> (Bet365 and other supported
            books) — selections priced below 1.20 don't qualify. Estimates only —
            not betting advice, and never guaranteed.
          </span>
        )}
      </div>

      <div style={styles.list}>
        {isLoading && <Spinner />}
        {isError && <p style={styles.error}>{error.message}</p>}
        {!isLoading && !isError && !hasLegs && (
          <p style={styles.empty}>
            No qualifying selections today — not enough matches with bookmaker odds at
            1.20 or above to build a slip.
          </p>
        )}
        {!isLoading && !isError && hasLegs &&
          slips.map((slip) => <SlipCard key={`${slip.target.lo}-${slip.target.hi}`} slip={slip} onOpenFixture={onOpenFixture} />)}
      </div>
    </div>
  );
}

function SlipCard({ slip, onOpenFixture }) {
  const { target, legs, combinedBookOdds, combinedFairOdds, combinedProbability, inRange, legCount } = slip;
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <div>
          <div style={styles.cardTitle}>Target {target.lo} – {target.hi} odds</div>
          <div style={styles.cardSub}>
            {legCount} leg{legCount === 1 ? "" : "s"}
            {combinedProbability != null && <> · {combinedProbability}% model chance</>}
            {combinedFairOdds != null && <> · fair {combinedFairOdds.toFixed(2)}</>}
          </div>
        </div>
        <div style={styles.oddsBox}>
          <span style={styles.oddsValue}>{combinedBookOdds.toFixed(2)}</span>
          <span style={styles.oddsLabel}>book odds</span>
        </div>
      </div>

      {!inRange && legCount > 0 && (
        <div style={styles.warn}>
          Couldn't land exactly in the target band with today's priced fixtures —
          this is the closest stack ({combinedBookOdds.toFixed(2)}).
        </div>
      )}
      {legCount === 0 && (
        <div style={styles.warn}>Not enough matches priced at 1.20+ today to reach this range.</div>
      )}

      {legs.map((leg) => <Leg key={leg.matchId} leg={leg} onOpenFixture={onOpenFixture} />)}
    </div>
  );
}

function Leg({ leg, onOpenFixture }) {
  const kickoff = leg.kickoff
    ? new Date(leg.kickoff * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "--:--";
  const clickable = !!(onOpenFixture && leg.leagueId);
  const open = () => clickable && onOpenFixture(leg.leagueId, leg.kickoff, leg.matchId);
  return (
    <div
      style={{ ...styles.leg, ...(clickable ? { cursor: "pointer" } : {}) }}
      {...(clickable ? { role: "button", tabIndex: 0, onClick: open, onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }, title: "Open this fixture" } : {})}
    >
      <div style={styles.legMain}>
        <div style={styles.legMatch}>
          <span style={styles.legTeams}>{leg.home} v {leg.away}</span>
          <span style={styles.legMeta}>{leg.leagueFlag} {leg.league} · {kickoff}</span>
        </div>
        <div style={styles.legPick}>
          <span style={styles.legSelection}>{leg.selection}</span>
          <span style={styles.legMarket}>{leg.market}</span>
        </div>
      </div>
      <div style={styles.legNums}>
        <span style={styles.legBookOdds}>{leg.bookOdds.toFixed(2)}</span>
        <span style={styles.legBookmaker}>{leg.bookmaker}</span>
        <span style={{ ...styles.legProb, color: oddsColor(leg.probability) }}>{leg.probability}% · fair {leg.odds.toFixed(2)}</span>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
      <div style={{ width: 28, height: 28, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
    </div>
  );
}

const styles = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "10px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  list: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 820, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", flexShrink: 0 },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--border)" },
  cardTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, color: "var(--text)" },
  cardSub: { fontSize: 12, color: "var(--text3)", marginTop: 2 },
  oddsBox: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  oddsValue: { fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 800, color: "var(--accent)" },
  oddsLabel: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5 },

  warn: { fontSize: 12, color: "#f1c40f", padding: "8px 16px", borderBottom: "1px solid var(--border)" },

  leg: { display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border)" },
  legMain: { flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  legMatch: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
  legTeams: { fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  legMeta: { fontSize: 11, color: "var(--text3)" },
  legPick: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  legSelection: { fontSize: 13, fontWeight: 600, color: "var(--accent)" },
  legMarket: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, background: "var(--bg3)", borderRadius: 4, padding: "1px 6px" },
  legNums: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, flexShrink: 0 },
  legBookOdds: { fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 800, color: "var(--text)" },
  legBookmaker: { fontSize: 10, color: "var(--text3)" },
  legProb: { fontSize: 11, fontWeight: 600 },
};

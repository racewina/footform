import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function yesterday() {
  const d = startOfToday();
  d.setDate(d.getDate() - 1);
  return d;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchSafeResults(date) {
  const res = await fetch(`/api/accumulators/results?date=${date}&tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

export default function SafeBetsResultsPage() {
  const [date, setDate] = useState(() => yesterday());
  const dateStr = ymd(date);
  const isToday = dateStr === ymd(startOfToday());

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["safe-results", dateStr],
    queryFn: () => fetchSafeResults(dateStr),
    keepPreviousData: true,
  });

  const shift = (days) =>
    setDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + days);
      return next;
    });

  const prettyDate = date.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });

  const slips = data?.slips || [];
  const hasSlips = slips.some((s) => s.legCount > 0);

  return (
    <div style={styles.page}>
      <div style={styles.dateBar}>
        <button style={styles.navBtn} onClick={() => shift(-1)}>‹</button>
        <div style={styles.dateLabel}>
          {prettyDate}
          {isToday && <span style={styles.todayTag}>Today</span>}
        </div>
        <button
          style={{ ...styles.navBtn, ...(isToday ? styles.navBtnDisabled : {}) }}
          onClick={() => !isToday && shift(1)}
          disabled={isToday}
        >
          ›
        </button>
      </div>

      <div style={styles.note}>
        <span aria-hidden="true">ⓘ</span>
        <span>
          How the safe-bet slips would have done. We rebuilt each slip from that
          day's finished matches (predictions from each team's form <em>before</em>{" "}
          kickoff) and graded every leg. A slip wins only if <strong>all</strong> legs land.
        </span>
      </div>

      <div style={styles.list}>
        {isLoading && <Spinner />}
        {isError && <p style={styles.error}>{error.message}</p>}
        {!isLoading && !isError && !hasSlips && (
          <p style={styles.empty}>No finished matches to build a slip from on this date.</p>
        )}
        {!isLoading && !isError && hasSlips &&
          slips.map((slip) => <SlipCard key={`${slip.target.lo}-${slip.target.hi}`} slip={slip} />)}
      </div>
    </div>
  );
}

function SlipCard({ slip }) {
  const { target, legs, combinedOdds, legCount, legHits, won } = slip;
  if (legCount === 0) return null;
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <div>
          <div style={styles.cardTitle}>Target {target.lo.toFixed(2)} – {target.hi.toFixed(2)} odds</div>
          <div style={styles.cardSub}>
            {legHits}/{legCount} legs landed · {combinedOdds.toFixed(2)} odds
          </div>
        </div>
        <span style={{ ...styles.resultBadge, ...(won ? styles.wonBadge : styles.lostBadge) }}>
          {won ? "WON" : "LOST"}
        </span>
      </div>
      {legs.map((leg) => <Leg key={leg.matchId} leg={leg} />)}
    </div>
  );
}

function Leg({ leg }) {
  return (
    <div style={styles.leg}>
      <span style={styles.legIcon}>{leg.hit ? "✅" : "❌"}</span>
      <div style={styles.legMain}>
        <div style={styles.legMatch}>
          <span style={styles.legTeams}>{leg.home} v {leg.away}</span>
          <span style={styles.legMeta}>{leg.leagueFlag} {leg.league}</span>
        </div>
        <span style={{ ...styles.legSelection, color: leg.hit ? "var(--accent)" : "var(--text3)" }}>
          {leg.selection}
        </span>
      </div>
      <div style={styles.legNums}>
        <span style={styles.legScore}>{leg.homeScore}–{leg.awayScore}</span>
        <span style={styles.legOdds}>{leg.odds.toFixed(2)}</span>
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
  dateBar: { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "14px 24px", borderBottom: "1px solid var(--border)" },
  navBtn: { fontSize: 22, color: "var(--text2)", padding: "2px 14px", borderRadius: 8, background: "var(--bg2)" },
  navBtnDisabled: { opacity: 0.3, cursor: "not-allowed" },
  dateLabel: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 15, minWidth: 180, justifyContent: "center" },
  todayTag: { fontSize: 11, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 4, padding: "1px 6px" },
  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "8px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  list: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 820, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", flexShrink: 0 },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--border)" },
  cardTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, color: "var(--text)" },
  cardSub: { fontSize: 12, color: "var(--text3)", marginTop: 2 },
  resultBadge: { fontSize: 13, fontWeight: 800, letterSpacing: 0.5, borderRadius: 8, padding: "4px 12px" },
  wonBadge: { color: "#04121f", background: "#2ecc71" },
  lostBadge: { color: "#fff", background: "#e74c3c" },

  leg: { display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border)" },
  legIcon: { fontSize: 15, flexShrink: 0 },
  legMain: { flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
  legMatch: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
  legTeams: { fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  legMeta: { fontSize: 11, color: "var(--text3)" },
  legSelection: { fontSize: 13, fontWeight: 600 },
  legNums: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 },
  legScore: { fontSize: 14, fontWeight: 700, color: "var(--text)" },
  legOdds: { fontSize: 12, color: "var(--text2)" },
};

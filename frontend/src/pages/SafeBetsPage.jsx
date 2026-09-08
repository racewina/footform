import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import DateBar, { ymd, startOfToday } from "../components/DateBar";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchAccumulators(dateStr, isToday) {
  const url = isToday
    ? `/api/accumulators?tz=${encodeURIComponent(TZ)}`
    : `/api/accumulators/results?date=${dateStr}&tz=${encodeURIComponent(TZ)}`;
  const res = await fetch(url);
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

export default function SafeBetsPage({ onOpenFixture }) {
  const [date, setDate] = useState(() => startOfToday());
  const dateStr = ymd(date);
  const isToday = dateStr === ymd(startOfToday());

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["accumulators", dateStr],
    queryFn: () => fetchAccumulators(dateStr, isToday),
    keepPreviousData: true,
  });
  const shift = (days) => setDate((p) => { const n = new Date(p); n.setDate(n.getDate() + days); return n; });

  const slips = data?.slips || [];
  const hasSlips = slips.some((s) => s.legCount > 0);

  return (
    <div style={styles.page}>
      <DateBar date={date} onShift={shift} />
      <div style={styles.note}>
        <span aria-hidden="true">ⓘ</span>
        <span>
          Two accumulators built from the model's most confident selections, combined to a
          target odds range. Where a price exists, the best bookmaker odds are shown alongside.
          {isToday ? " Estimates only — not betting advice." : " Stepped back to a past day — each leg is graded against the result."}
        </span>
      </div>

      <div style={styles.list}>
        {isLoading && <Spinner />}
        {isError && <p style={styles.error}>{error.message}</p>}
        {!isLoading && !isError && !hasSlips && (
          <p style={styles.empty}>
            {isToday ? "No scheduled matches today to build a slip from."
                     : "No qualifying finished matches to build a slip from on this date."}
          </p>
        )}
        {!isLoading && !isError && hasSlips &&
          slips.map((slip) => <SlipCard key={`${slip.target.lo}-${slip.target.hi}`} slip={slip} onOpenFixture={onOpenFixture} />)}
      </div>
    </div>
  );
}

function SlipCard({ slip, onOpenFixture }) {
  const { target, legs, combinedOdds, combinedProbability, inRange, legCount, legHits, won } = slip;
  const graded = won != null;
  if (graded && legCount === 0) return null;
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <div>
          <div style={styles.cardTitle}>Target {target.lo.toFixed(2)} – {target.hi.toFixed(2)} odds</div>
          <div style={styles.cardSub}>
            {graded
              ? <>{legHits}/{legCount} legs landed · {combinedOdds.toFixed(2)} odds</>
              : <>{legCount} leg{legCount === 1 ? "" : "s"}{combinedProbability != null && <> · {combinedProbability}% combined chance</>}</>}
          </div>
        </div>
        {graded ? (
          <span style={{ ...styles.badge, ...(won ? styles.won : styles.lost) }}>{won ? "WON" : "LOST"}</span>
        ) : (
          <div style={styles.oddsBox}>
            <span style={styles.oddsValue}>{combinedOdds.toFixed(2)}</span>
            <span style={styles.oddsLabel}>combined</span>
          </div>
        )}
      </div>

      {!graded && !inRange && legCount > 0 && (
        <div style={styles.warn}>
          Couldn't land exactly in the target band with today's fixtures — this is
          the closest safe stack ({combinedOdds.toFixed(2)}).
        </div>
      )}
      {!graded && legCount === 0 && (
        <div style={styles.warn}>Not enough matches today to reach this range.</div>
      )}

      {legs.map((leg) => <Leg key={leg.matchId} leg={leg} onOpenFixture={onOpenFixture} />)}
    </div>
  );
}

function Leg({ leg, onOpenFixture }) {
  const graded = leg.hit != null;
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
      {graded && <span style={styles.legIcon}>{leg.hit ? "✅" : "❌"}</span>}
      <div style={styles.legMain}>
        <div style={styles.legMatch}>
          <span style={styles.legTeams}>{leg.home} v {leg.away}</span>
          <span style={styles.legMeta}>{leg.leagueFlag} {leg.league}{!graded && <> · {kickoff}</>}</span>
        </div>
        <div style={styles.legPick}>
          <span style={{ ...styles.legSelection, ...(graded && !leg.hit ? { color: "var(--text3)" } : {}) }}>{leg.selection}</span>
          <span style={styles.legMarket}>{leg.market}</span>
        </div>
        {!graded && leg.bookOdds != null && (
          <span style={styles.legBook}>Best {leg.bookOdds.toFixed(2)} @ {leg.bookmaker}</span>
        )}
      </div>
      <div style={styles.legNums}>
        {graded ? (
          <>
            <span style={styles.legScore}>{leg.homeScore}–{leg.awayScore}</span>
            <span style={styles.legOdds}>{leg.odds.toFixed(2)}</span>
          </>
        ) : (
          <>
            <span style={{ ...styles.legProb, color: oddsColor(leg.probability) }}>{leg.probability}%</span>
            <span style={styles.legOdds}>{leg.bookOdds != null ? <>fair {leg.odds.toFixed(2)}</> : leg.odds.toFixed(2)}</span>
          </>
        )}
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
  badge: { fontSize: 13, fontWeight: 800, letterSpacing: 0.5, borderRadius: 8, padding: "4px 12px" },
  won: { color: "#04121f", background: "#2ecc71" },
  lost: { color: "#fff", background: "#e74c3c" },

  warn: { fontSize: 12, color: "#f1c40f", padding: "8px 16px", borderBottom: "1px solid var(--border)" },

  leg: { display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border)" },
  legIcon: { fontSize: 15, flexShrink: 0 },
  legMain: { flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  legMatch: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
  legTeams: { fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  legMeta: { fontSize: 11, color: "var(--text3)" },
  legPick: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  legSelection: { fontSize: 13, fontWeight: 600, color: "var(--accent)" },
  legMarket: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, background: "var(--bg3)", borderRadius: 4, padding: "1px 6px" },
  legBook: { fontSize: 11, color: "var(--text2)" },
  legNums: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 },
  legProb: { fontSize: 14, fontWeight: 700 },
  legScore: { fontSize: 14, fontWeight: 700, color: "var(--text)" },
  legOdds: { fontSize: 12, color: "var(--text2)" },
};

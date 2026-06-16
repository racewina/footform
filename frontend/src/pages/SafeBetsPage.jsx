import { useQuery } from "@tanstack/react-query";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchAccumulators() {
  const res = await fetch(`/api/accumulators?tz=${encodeURIComponent(TZ)}`);
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

export default function SafeBetsPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["accumulators"],
    queryFn: fetchAccumulators,
  });

  const slips = data?.slips || [];

  return (
    <div style={styles.page}>
      <div style={styles.note}>
        <span aria-hidden="true">ⓘ</span>
        <span>
          Two accumulators built from today's matches. For each game we take the
          single market the model is most confident in, then stack the safest of
          those picks until the combined odds reach the target band. Where the
          market has a price, we show the best bookmaker odds next to our fair
          odds. Model estimates only — not betting advice, and never guaranteed.
        </span>
      </div>

      <div style={styles.list}>
        {isLoading && <Spinner />}
        {isError && <p style={styles.error}>{error.message}</p>}
        {!isLoading && !isError && data?.totalMatches === 0 && (
          <p style={styles.empty}>No scheduled matches today to build a slip from.</p>
        )}
        {!isLoading && !isError && data?.totalMatches > 0 &&
          slips.map((slip) => <SlipCard key={`${slip.target.lo}-${slip.target.hi}`} slip={slip} />)}
      </div>
    </div>
  );
}

function SlipCard({ slip }) {
  const { target, legs, combinedOdds, combinedProbability, inRange, legCount } = slip;
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <div>
          <div style={styles.cardTitle}>Target {target.lo.toFixed(2)} – {target.hi.toFixed(2)} odds</div>
          <div style={styles.cardSub}>
            {legCount} leg{legCount === 1 ? "" : "s"}
            {combinedProbability != null && <> · {combinedProbability}% combined chance</>}
          </div>
        </div>
        <div style={styles.oddsBox}>
          <span style={styles.oddsValue}>{combinedOdds.toFixed(2)}</span>
          <span style={styles.oddsLabel}>combined</span>
        </div>
      </div>

      {!inRange && legCount > 0 && (
        <div style={styles.warn}>
          Couldn't land exactly in the target band with today's fixtures — this is
          the closest safe stack ({combinedOdds.toFixed(2)}).
        </div>
      )}
      {legCount === 0 && (
        <div style={styles.warn}>Not enough matches today to reach this range.</div>
      )}

      {legs.map((leg) => <Leg key={leg.matchId} leg={leg} />)}
    </div>
  );
}

function Leg({ leg }) {
  const kickoff = leg.kickoff
    ? new Date(leg.kickoff * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "--:--";
  return (
    <div style={styles.leg}>
      <div style={styles.legMain}>
        <div style={styles.legMatch}>
          <span style={styles.legTeams}>{leg.home} v {leg.away}</span>
          <span style={styles.legMeta}>
            {leg.leagueFlag} {leg.league} · {kickoff}
          </span>
        </div>
        <div style={styles.legPick}>
          <span style={styles.legSelection}>{leg.selection}</span>
          <span style={styles.legMarket}>{leg.market}</span>
        </div>
        {leg.bookOdds != null && (
          <span style={styles.legBook}>Best {leg.bookOdds.toFixed(2)} @ {leg.bookmaker}</span>
        )}
      </div>
      <div style={styles.legNums}>
        <span style={{ ...styles.legProb, color: oddsColor(leg.probability) }}>{leg.probability}%</span>
        <span style={styles.legOdds}>
          {leg.bookOdds != null
            ? <>fair {leg.odds.toFixed(2)}</>
            : leg.odds.toFixed(2)}
        </span>
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
  legBook: { fontSize: 11, color: "var(--text2)" },
  legNums: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 },
  legProb: { fontSize: 14, fontWeight: 700 },
  legOdds: { fontSize: 12, color: "var(--text2)" },
};

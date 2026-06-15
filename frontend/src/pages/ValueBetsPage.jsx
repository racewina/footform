import { useQuery } from "@tanstack/react-query";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchValueBets() {
  const res = await fetch(`/api/value?tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

function edgeColor(edge) {
  if (edge >= 15) return "#2ecc71";
  if (edge >= 8) return "#9acd32";
  return "#f1c40f";
}

export default function ValueBetsPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["value-bets"],
    queryFn: fetchValueBets,
  });

  const bets = data?.bets || [];

  return (
    <div style={styles.page}>
      <div style={styles.note}>
        <span aria-hidden="true">📈</span>
        <span>
          Where our model rates an outcome <strong>more likely</strong> than the
          best bookmaker price implies — a positive expected-value "edge." We
          compare our probability to the highest price across every book for the
          match-result, over/under 2.5, and both-teams-to-score markets. Edge is
          the model's opinion vs. the market, not a guarantee — odds move and
          models are wrong. Not betting advice.
        </span>
      </div>

      <div style={styles.list}>
        {isLoading && <Spinner />}
        {isError && <p style={styles.error}>{error.message}</p>}
        {!isLoading && !isError && bets.length === 0 && (
          <p style={styles.empty}>
            No positive-edge bets right now.
            {data?.pricedMatches === 0
              ? " No bookmaker odds are published for today's matches yet — they usually appear a few days out."
              : ` Scanned ${data?.pricedMatches || 0} priced match${data?.pricedMatches === 1 ? "" : "es"}; the market and our model agree for now.`}
          </p>
        )}
        {!isLoading && !isError && bets.length > 0 && (
          <>
            <div style={styles.summary}>
              {bets.length} value pick{bets.length === 1 ? "" : "s"} from{" "}
              {data.pricedMatches} priced match{data.pricedMatches === 1 ? "" : "es"} today
            </div>
            {bets.map((b) => <ValueRow key={`${b.matchId}-${b.selection}`} bet={b} />)}
          </>
        )}
      </div>
    </div>
  );
}

function ValueRow({ bet }) {
  const kickoff = bet.kickoff
    ? new Date(bet.kickoff * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "--:--";
  const color = edgeColor(bet.edgePct);
  return (
    <div style={styles.card}>
      <div style={styles.cardLeft}>
        <div style={styles.match}>
          <span style={styles.teams}>{bet.home} v {bet.away}</span>
          <span style={styles.meta}>{bet.leagueFlag} {bet.league} · {kickoff}</span>
        </div>
        <div style={styles.pick}>
          <span style={styles.selection}>{bet.selection}</span>
          <span style={styles.marketTag}>{bet.market}</span>
        </div>
        <div style={styles.priceLine}>
          <span style={styles.priceItem}>Model <strong>{bet.modelProb}%</strong> (fair {bet.fairOdds.toFixed(2)})</span>
          <span style={styles.priceArrow}>→</span>
          <span style={styles.priceItem}>Best <strong style={{ color: "var(--text)" }}>{bet.bookOdds.toFixed(2)}</strong> @ {bet.bookmaker}</span>
        </div>
      </div>
      <div style={styles.edgeBox}>
        <span style={{ ...styles.edgeValue, color }}>+{bet.edgePct}%</span>
        <span style={styles.edgeLabel}>edge</span>
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
  list: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12, maxWidth: 820, width: "100%", margin: "0 auto" },
  summary: { fontSize: 12, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5, paddingBottom: 2 },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40, lineHeight: 1.5 },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  card: { display: "flex", alignItems: "center", gap: 12, background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 16px", flexShrink: 0 },
  cardLeft: { flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
  match: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
  teams: { fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { fontSize: 11, color: "var(--text3)" },
  pick: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  selection: { fontSize: 14, fontWeight: 700, color: "var(--accent)" },
  marketTag: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, background: "var(--bg3)", borderRadius: 4, padding: "1px 6px" },
  priceLine: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: "var(--text3)" },
  priceItem: { whiteSpace: "nowrap" },
  priceArrow: { color: "var(--text3)" },
  edgeBox: { display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 },
  edgeValue: { fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 800 },
  edgeLabel: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5 },
};

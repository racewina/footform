import { useQuery } from "@tanstack/react-query";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchVip() {
  const res = await fetch(`/api/vip?tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

function oddsColor(prob) {
  if (prob == null) return "var(--text3)";
  if (prob >= 75) return "#2ecc71";
  if (prob >= 65) return "#9acd32";
  if (prob >= 55) return "#f1c40f";
  return "#e74c3c";
}

export default function VipBetPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["vip"],
    queryFn: fetchVip,
  });

  // Two batches: the headline "Top Matches" from the marquee competitions, then
  // the general slate. The general list drops any match already featured up top
  // so a headline game never appears twice.
  const featured = (data?.featured || []).filter((s) => s.legCount > 0);
  const featuredIds = new Set(featured.map((s) => s.matchId));
  const others = (data?.slips || []).filter((s) => s.legCount > 0 && !featuredIds.has(s.matchId));
  const hasAny = featured.length > 0 || others.length > 0;

  return (
    <div style={styles.page}>
      <div style={styles.note}>
        <span aria-hidden="true">💎</span>
        <span>
          A <strong>bet builder</strong> per match. Each card lists every pick the
          model rates likely — the favourite to win, either side to score or score
          2+, over 2.5, both teams to score, first-half corners — with its % and
          fair price, plus a combined price for the lot. Picks in a game are
          correlated (a high-scoring match tends to hit several at once), so build
          your own from the menu. <strong>Top Matches</strong> features the headline
          competitions; the rest follows. Model estimates, not advice.
        </span>
      </div>

      <div style={styles.list}>
        {isLoading && <Spinner />}
        {isError && <p style={styles.error}>{error.message}</p>}
        {!isLoading && !isError && data?.totalMatches === 0 && (
          <p style={styles.empty}>No scheduled matches today to build a VIP slip from.</p>
        )}
        {!isLoading && !isError && data?.totalMatches > 0 && !hasAny && (
          <p style={styles.empty}>
            No clear favourites to build on today. Check back closer to kickoff.
          </p>
        )}

        {featured.length > 0 && (
          <SectionTitle icon="⭐" title="Top Matches" subtitle="Headline competitions" />
        )}
        {featured.map((slip) => <SlipCard key={`f-${slip.matchId}`} slip={slip} />)}

        {featured.length > 0 && others.length > 0 && (
          <SectionTitle icon="💎" title="More VIP Builders" subtitle="Across all leagues" />
        )}
        {others.map((slip) => <SlipCard key={slip.matchId} slip={slip} />)}
      </div>
    </div>
  );
}

function SectionTitle({ icon, title, subtitle }) {
  return (
    <div style={styles.sectionTitle}>
      <span style={styles.sectionIcon} aria-hidden="true">{icon}</span>
      <span style={styles.sectionName}>{title}</span>
      {subtitle && <span style={styles.sectionSub}>{subtitle}</span>}
    </div>
  );
}

function SlipCard({ slip }) {
  const { lean, home, away, leagueFlag, league, kickoff, legs, combinedOdds, legCount } = slip;
  const ko = kickoff
    ? new Date(kickoff * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "--:--";
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <div style={{ minWidth: 0 }}>
          <div style={styles.cardTitle}>
            <span style={styles.diamond}>💎</span> {home} v {away}
          </div>
          <div style={styles.cardSub}>
            {leagueFlag} {league} · {ko} · {legCount} pick{legCount === 1 ? "" : "s"}
            {lean ? <> · {lean}</> : null}
          </div>
        </div>
        <div style={styles.oddsBox}>
          <span style={styles.oddsValue}>{combinedOdds.toFixed(2)}</span>
          <span style={styles.oddsLabel}>all legs</span>
        </div>
      </div>

      {legs.map((leg) => <Leg key={leg.marketKey} leg={leg} />)}
    </div>
  );
}

function Leg({ leg }) {
  return (
    <div style={styles.leg}>
      <div style={styles.legMain}>
        <span style={styles.legSelection}>{leg.selection}</span>
        <div style={styles.legMetaRow}>
          <span style={styles.legMarket}>{leg.market}</span>
          {leg.bookOdds != null && (
            <span style={styles.legBook}>Best {leg.bookOdds.toFixed(2)} @ {leg.bookmaker}</span>
          )}
        </div>
      </div>
      <div style={styles.legNums}>
        <span style={{ ...styles.legProb, color: oddsColor(leg.probability) }}>{leg.probability}%</span>
        <span style={styles.legOdds}>
          {leg.bookOdds != null ? <>fair {leg.odds.toFixed(2)}</> : leg.odds.toFixed(2)}
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

  sectionTitle: { display: "flex", alignItems: "baseline", gap: 8, padding: "4px 2px", marginTop: 4 },
  sectionIcon: { fontSize: 15 },
  sectionName: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, color: "var(--text)" },
  sectionSub: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },

  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", flexShrink: 0 },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--border)" },
  cardTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, color: "var(--text)", display: "flex", alignItems: "center", gap: 6 },
  diamond: { fontSize: 14 },
  cardSub: { fontSize: 12, color: "var(--text3)", marginTop: 2 },
  oddsBox: { display: "flex", flexDirection: "column", alignItems: "flex-end" },
  oddsValue: { fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 800, color: "var(--accent)" },
  oddsLabel: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5 },

  leg: { display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border)" },
  legMain: { flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  legMatch: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
  legTeams: { fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  legMeta: { fontSize: 11, color: "var(--text3)" },
  legPick: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  legMetaRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  legSelection: { fontSize: 14, fontWeight: 600, color: "var(--accent)" },
  legMarket: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, background: "var(--bg3)", borderRadius: 4, padding: "1px 6px" },
  legBook: { fontSize: 11, color: "var(--text2)" },
  legNums: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 },
  legProb: { fontSize: 14, fontWeight: 700 },
  legOdds: { fontSize: 12, color: "var(--text2)" },
};

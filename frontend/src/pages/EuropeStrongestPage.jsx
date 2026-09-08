import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import DateBar, { ymd, startOfToday } from "../components/DateBar";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchStrongest(dateStr, isToday) {
  const url = isToday
    ? `/api/europe-strongest?tz=${encodeURIComponent(TZ)}`
    : `/api/europe-strongest?includeFinished=1&date=${dateStr}&tz=${encodeURIComponent(TZ)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

const CATEGORIES = [
  { key: "win", icon: "🔥", title: "Likely to Win", sub: "Strongest result picks" },
  { key: "btts", icon: "⚽", title: "Likely BTTS", sub: "Both teams to score" },
  { key: "over25", icon: "🎯", title: "Over 2.5 Goals", sub: "3+ total goals" },
  { key: "team2plus", icon: "🥅", title: "Team to Score 2+", sub: "A side to bag two" },
];

function kickoffLabel(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function EuropeStrongestPage() {
  const [date, setDate] = useState(() => startOfToday());
  const dateStr = ymd(date);
  const isToday = dateStr === ymd(startOfToday());

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["europe-strongest", dateStr],
    queryFn: () => fetchStrongest(dateStr, isToday),
    keepPreviousData: true,
  });
  const shift = (days) => setDate((p) => { const n = new Date(p); n.setDate(n.getDate() + days); return n; });

  const cats = data?.categories || {};
  const rows = CATEGORIES.flatMap((c) => cats[c.key] || []);
  const total = rows.length;
  const graded = rows.some((r) => r.hit != null);
  const landed = rows.filter((r) => r.hit === true).length;
  const gradedCount = rows.filter((r) => r.hit != null).length;

  return (
    <div style={styles.page}>
      <div style={styles.head}>
        <div style={styles.title}><span aria-hidden="true">🌍</span> Europe Strongest Matches</div>
      </div>
      <DateBar date={date} onShift={shift} />

      <div style={styles.note}>
        <span aria-hidden="true">📌</span>
        <span>
          The strongest European predictions that pay <strong>{(data?.minOdds || 1.5).toFixed(2)}+</strong>,
          ranked by model probability across four categories. Netherlands, Finland, Estonia and
          Iceland excluded.{" "}
          {isToday
            ? "Generated once and frozen for the day."
            : graded ? <>Graded against results — <strong>{landed}/{gradedCount} landed ({gradedCount ? Math.round(100 * landed / gradedCount) : 0}%)</strong>.</>
                     : "Past day."}
        </span>
      </div>

      <div style={styles.list}>
        {isLoading && <Spinner />}
        {isError && <p style={styles.error}>{error.message}</p>}
        {!isLoading && !isError && total === 0 && (
          <p style={styles.empty}>
            {isToday ? "No qualifying European matches meet the 1.50+ bar right now."
                     : "No qualifying European matches on this date."}
          </p>
        )}

        {!isLoading && !isError && total > 0 && CATEGORIES.map((c) => {
          const list = cats[c.key] || [];
          if (!list.length) return null;
          const catLanded = list.filter((r) => r.hit === true).length;
          const catGraded = list.filter((r) => r.hit != null).length;
          return (
            <div key={c.key} style={styles.section}>
              <div style={styles.sectionTitle}>
                <span style={styles.sectionIcon} aria-hidden="true">{c.icon}</span>
                <span style={styles.sectionName}>{c.title}</span>
                <span style={styles.sectionSub}>{c.sub}</span>
                <span style={styles.count}>{catGraded ? `${catLanded}/${list.length}` : list.length}</span>
              </div>
              <div style={styles.card}>
                {list.map((r, i) => <Row key={`${r.matchId}-${c.key}`} r={r} rank={i + 1} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ r, rank }) {
  const graded = r.hit != null;
  return (
    <div style={styles.row}>
      {graded ? <span style={styles.icon}>{r.hit ? "✅" : "❌"}</span> : <span style={styles.rank}>{rank}</span>}
      <div style={styles.main}>
        <div style={{ ...styles.selection, ...(graded && !r.hit ? { color: "var(--text3)" } : {}) }}>{r.selection}</div>
        <div style={styles.meta}>
          <span style={styles.match}>{r.home} v {r.away}</span>
          <span style={styles.dot}>·</span>
          <span>{r.leagueFlag} {r.league}</span>
          {!graded && r.kickoff && <><span style={styles.dot}>·</span><span>{kickoffLabel(r.kickoff)}</span></>}
        </div>
      </div>
      <div style={styles.nums}>
        {graded && r.homeScore != null && <span style={styles.score}>{r.homeScore}–{r.awayScore}</span>}
        <span style={styles.odds}>{Number(r.odds).toFixed(2)}</span>
        <span style={styles.prob}>{r.probability}%</span>
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
  head: { padding: "14px 24px 8px" },
  title: { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 20, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 },
  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "8px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  list: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 20, maxWidth: 860, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  section: { display: "flex", flexDirection: "column", gap: 8 },
  sectionTitle: { display: "flex", alignItems: "baseline", gap: 8, padding: "0 2px" },
  sectionIcon: { fontSize: 16 },
  sectionName: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, color: "var(--text)" },
  sectionSub: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  count: { marginLeft: "auto", fontSize: 12, color: "var(--text3)", background: "var(--bg3)", borderRadius: 10, padding: "1px 8px" },

  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" },
  row: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--border)" },
  rank: { flexShrink: 0, width: 22, textAlign: "center", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 14, color: "var(--text3)" },
  icon: { flexShrink: 0, width: 22, textAlign: "center", fontSize: 15 },
  main: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  selection: { fontSize: 14, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { fontSize: 11, color: "var(--text3)", display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" },
  match: { color: "var(--text2)" },
  dot: { opacity: 0.5 },
  nums: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, flexShrink: 0 },
  score: { fontSize: 13, fontWeight: 700, color: "var(--text)" },
  odds: { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, color: "var(--accent)" },
  prob: { fontSize: 11, color: "var(--text3)" },
};

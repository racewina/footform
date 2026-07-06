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

async function fetchResults(date) {
  const res = await fetch(`/api/results?date=${date}&tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

async function fetchSummary(days) {
  const res = await fetch(`/api/results/summary?days=${days}&tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

// View modes: a single day, or a pooled trailing window. Pooling hundreds of
// graded calls makes Brier/calibration far less noisy than any one day.
const MODES = [
  { key: "day", label: "Day" },
  { key: "14", label: "14 days" },
  { key: "30", label: "30 days" },
];

// Market columns shown per match, in display order. H/A = home/away team.
const MARKETS = [
  { key: "winner", label: "Winner" },
  { key: "home1Plus", label: "H 1+" },
  { key: "away1Plus", label: "A 1+" },
  { key: "home2Plus", label: "H 2+" },
  { key: "away2Plus", label: "A 2+" },
  { key: "over25", label: "O2.5" },
  { key: "btts", label: "BTTS" },
];

function pctColor(p) {
  if (p == null) return "var(--text3)";
  if (p >= 70) return "#2ecc71";
  if (p >= 50) return "#9acd32";
  if (p >= 35) return "#f1c40f";
  return "#e74c3c";
}

// Brier score: 0 = perfect, 0.25 ≈ a 50/50 guess. Lower is better.
function brierColor(b) {
  if (b == null) return "var(--text3)";
  if (b <= 0.18) return "#2ecc71";
  if (b <= 0.24) return "#9acd32";
  if (b <= 0.3) return "#f1c40f";
  return "#e74c3c";
}

// Calibration gap: how far the real hit-rate strayed from the stated confidence
// in a band. Small gap = trustworthy probabilities.
function gapColor(gap) {
  if (gap <= 7) return "#2ecc71";
  if (gap <= 15) return "#f1c40f";
  return "#e74c3c";
}

export default function ResultsPage() {
  const [mode, setMode] = useState("day");
  const [date, setDate] = useState(() => yesterday());
  const dateStr = ymd(date);
  const isToday = dateStr === ymd(startOfToday());
  const isDay = mode === "day";

  const dayQuery = useQuery({
    queryKey: ["results", dateStr],
    queryFn: () => fetchResults(dateStr),
    keepPreviousData: true,
    enabled: isDay,
  });

  const summaryQuery = useQuery({
    queryKey: ["results-summary", mode],
    queryFn: () => fetchSummary(mode),
    keepPreviousData: true,
    enabled: !isDay,
    staleTime: 60 * 60 * 1000,
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

  return (
    <div style={styles.page}>
      <div style={styles.modeBar}>
        {MODES.map((m) => (
          <button
            key={m.key}
            style={{ ...styles.modeBtn, ...(mode === m.key ? styles.modeBtnActive : {}) }}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {isDay && (
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
      )}

      <div style={styles.note}>
        <span aria-hidden="true">ⓘ</span>
        <span>
          Track record: for each finished match we rebuilt the prediction from
          each team's form <em>before</em> kickoff (same engine as the live app)
          and graded it against the real result. ✅ = the model's call was right.
          {" "}<strong>Brier</strong> scores how well-calibrated our confidence was
          (lower is better); the calibration strip checks whether a stated
          confidence actually matched how often we were right.
          {!isDay && " Pooling many days makes these numbers far more reliable than any single day."}
        </span>
      </div>

      {isDay ? <DayView query={dayQuery} /> : <SummaryView query={summaryQuery} />}
    </div>
  );
}

function DayView({ query }) {
  const { data, isLoading, isError, error } = query;
  const leagues = data?.leagues || [];
  const acc = data?.accuracy;

  return (
    <div style={styles.list}>
      {isLoading && <Spinner />}
      {isError && <p style={styles.error}>{error.message}</p>}
      {!isLoading && !isError && leagues.length === 0 && (
        <p style={styles.empty}>No finished matches to grade on this date.</p>
      )}

      {!isLoading && !isError && acc && (
        <AccuracyBanner accuracy={acc} totalMatches={data.totalMatches} />
      )}

      {!isLoading && !isError && leagues.map((g) => (
        <div key={g.league.id} style={styles.leagueGroup}>
          <div style={styles.groupHeader}>
            <span style={{ fontSize: 16 }}>{g.league.flag}</span>
            <span style={styles.groupTitle}>{g.league.name}</span>
            <span style={styles.groupCount}>{g.matches.length}</span>
            {g.accuracy && (
              <span style={{ ...styles.groupAcc, color: pctColor(g.accuracy.overall.pct) }}>
                {g.accuracy.overall.pct}%
              </span>
            )}
          </div>
          {g.matches.map((m) => <ResultCard key={m.id} match={m} />)}
        </div>
      ))}
    </div>
  );
}

function SummaryView({ query }) {
  const { data, isLoading, isError, error } = query;
  const acc = data?.accuracy;
  const trend = data?.trend || [];

  return (
    <div style={styles.list}>
      {isLoading && (
        <>
          <Spinner />
          <p style={styles.loadingNote}>
            Pooling graded matches across the whole window — this can take a
            minute the first time, then it's cached.
          </p>
        </>
      )}
      {isError && <p style={styles.error}>{error.message}</p>}
      {!isLoading && !isError && !acc && (
        <p style={styles.empty}>No finished matches to grade in this window.</p>
      )}

      {!isLoading && !isError && acc && (
        <>
          <AccuracyBanner accuracy={acc} totalMatches={data.totalMatches} />
          <TrendStrip trend={trend} />
        </>
      )}
    </div>
  );
}

function TrendStrip({ trend }) {
  const days = trend.filter((t) => t.matches > 0);
  if (!days.length) return null;
  const briers = days.map((d) => d.brier).filter((b) => b != null);
  const maxB = Math.max(0.3, ...briers);
  const minB = Math.min(0.15, ...briers);
  const span = maxB - minB || 1;

  return (
    <div style={styles.banner}>
      <div style={styles.calibTitle}>Daily Brier trend (shorter bar = better)</div>
      <div style={styles.trendRow}>
        {days.map((d) => {
          const h = d.brier != null ? Math.round(((maxB - d.brier) / span) * 100) : 0;
          const label = d.date.slice(5); // MM-DD
          return (
            <div key={d.date} style={styles.trendCol} title={`${d.date}: ${d.matches} matches · ${d.pct}% calls · Brier ${d.brier ?? "–"}`}>
              <div style={styles.trendBarTrack}>
                <div style={{ ...styles.trendBarFill, height: `${Math.max(h, 4)}%`, background: brierColor(d.brier) }} />
              </div>
              <span style={styles.trendDate}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AccuracyBanner({ accuracy, totalMatches }) {
  const o = accuracy.overall;
  const calib = accuracy.calibration || [];
  return (
    <div style={styles.banner}>
      <div style={styles.bannerTop}>
        <div style={styles.bannerHeadline}>
          <span style={{ ...styles.bannerPct, color: pctColor(o.pct) }}>{o.pct}%</span>
          <span style={styles.bannerSub}>
            {o.hits} of {o.total} calls correct · {totalMatches} match{totalMatches === 1 ? "" : "es"}
          </span>
        </div>
        {o.brier != null && (
          <span
            style={{ ...styles.brierChip, color: brierColor(o.brier) }}
            title="Brier score: mean squared error of our stated confidence vs what happened. 0 = perfect, 0.25 ≈ a coin-flip guess. Lower is better."
          >
            Brier {o.brier.toFixed(3)}
          </span>
        )}
      </div>
      <div style={styles.bannerMarkets}>
        {MARKETS.map((m) => {
          const c = accuracy.perMarket[m.key];
          if (!c) return null;
          return (
            <div key={m.key} style={styles.bannerMarket}>
              <span style={styles.bannerMarketLabel}>{m.label}</span>
              <span style={{ ...styles.bannerMarketPct, color: pctColor(c.pct) }}>{c.pct}%</span>
              <span style={styles.bannerMarketFrac}>{c.hits}/{c.total}</span>
            </div>
          );
        })}
      </div>

      {calib.length > 0 && (
        <div style={styles.calib}>
          <div style={styles.calibTitle}>
            Calibration — when we sounded this sure, how often were we right?
          </div>
          <div style={styles.calibRow}>
            {calib.map((b) => {
              const gap = Math.abs(b.avgConf - b.hitRate);
              return (
                <div key={b.lo} style={styles.calibCell}>
                  <span style={styles.calibBand}>{b.lo}–{b.hi}%</span>
                  <span style={{ ...styles.calibHit, color: gapColor(gap) }}>{b.hitRate}%</span>
                  <span style={styles.calibMeta}>said {b.avgConf}% · n={b.n}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultCard({ match: m }) {
  const kickoff = m.startTimestamp
    ? new Date(m.startTimestamp * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "--:--";
  const g = m.grade?.grades;
  const homeWon = m.homeScore > m.awayScore;
  const awayWon = m.awayScore > m.homeScore;

  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <span style={styles.kickoff}>{kickoff}</span>
        <div style={styles.teams}>
          <TeamRow team={m.homeTeam} score={m.homeScore} won={homeWon} />
          <TeamRow team={m.awayTeam} score={m.awayScore} won={awayWon} />
        </div>
        {m.grade && (
          <span style={styles.hitBadge}>{m.grade.hits}/{m.grade.total}</span>
        )}
      </div>

      {g && (
        <div style={styles.grid}>
          {MARKETS.map((mk) => {
            const cell = g[mk.key];
            if (!cell) return null;
            // Show the side the model actually backed, so the % and the ✓ agree.
            // For a Yes/No market the model backs "No" when its % is below 50 —
            // display that as "No <market>" with the complementary confidence
            // (e.g. BTTS 37% → the model backed "No BTTS" at 63%).
            const backedNo = mk.key !== "winner" && cell.call === "No";
            const label = backedNo ? `No ${mk.label}` : mk.label;
            const pct = backedNo ? 100 - cell.pct : cell.pct;
            return (
              <div key={mk.key} style={styles.gradeCell}>
                <span style={styles.gradeLabel}>{label}</span>
                <span style={styles.gradeIcon}>{cell.hit ? "✅" : "❌"}</span>
                <span style={{ ...styles.gradePct, color: pctColor(pct) }}>{pct}%</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeamRow({ team, score, won }) {
  return (
    <div style={styles.teamRow}>
      {team?.logo && <img src={team.logo} alt="" width={18} height={18} style={styles.logo} onError={(e) => (e.target.style.visibility = "hidden")} />}
      <span style={{ ...styles.teamName, ...(won ? styles.teamWon : {}) }}>{team?.name || "TBD"}</span>
      <span style={{ ...styles.score, ...(won ? styles.teamWon : {}) }}>{score}</span>
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
  modeBar: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "12px 24px 0" },
  modeBtn: { fontSize: 13, fontWeight: 600, color: "var(--text2)", padding: "6px 16px", borderRadius: 999, background: "var(--bg2)", border: "1px solid var(--border)" },
  modeBtnActive: { background: "var(--accent)", color: "#04121f", border: "1px solid var(--accent)" },
  loadingNote: { color: "var(--text3)", textAlign: "center", fontSize: 13, padding: "0 20px", lineHeight: 1.5 },
  trendRow: { display: "flex", alignItems: "flex-end", gap: 3, height: 90 },
  trendCol: { flex: "1 1 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 0 },
  trendBarTrack: { width: "100%", height: 70, display: "flex", alignItems: "flex-end", justifyContent: "center" },
  trendBarFill: { width: "70%", maxWidth: 18, borderRadius: "3px 3px 0 0" },
  trendDate: { fontSize: 8, color: "var(--text3)", whiteSpace: "nowrap", transform: "rotate(-45deg)", transformOrigin: "center", marginTop: 4 },
  dateBar: { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "14px 24px", borderBottom: "1px solid var(--border)" },
  navBtn: { fontSize: 22, color: "var(--text2)", padding: "2px 14px", borderRadius: 8, background: "var(--bg2)" },
  navBtnDisabled: { opacity: 0.3, cursor: "not-allowed" },
  dateLabel: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 15, minWidth: 180, justifyContent: "center" },
  todayTag: { fontSize: 11, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 4, padding: "1px 6px" },
  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "8px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  list: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 820, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  banner: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 },
  bannerTop: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  bannerHeadline: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
  bannerPct: { fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 800 },
  bannerSub: { fontSize: 13, color: "var(--text2)" },
  bannerMarkets: { display: "flex", gap: 6, flexWrap: "wrap" },
  bannerMarket: { flex: "1 1 0", minWidth: 70, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, padding: "6px 4px", borderRadius: 8, background: "var(--bg3)" },
  bannerMarketLabel: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  bannerMarketPct: { fontSize: 15, fontWeight: 700 },
  bannerMarketFrac: { fontSize: 10, color: "var(--text3)" },
  brierChip: { fontSize: 12, fontWeight: 700, background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 10px", whiteSpace: "nowrap", cursor: "help" },

  calib: { display: "flex", flexDirection: "column", gap: 8, paddingTop: 12, borderTop: "1px solid var(--border)" },
  calibTitle: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  calibRow: { display: "flex", gap: 6, flexWrap: "wrap" },
  calibCell: { flex: "1 1 0", minWidth: 76, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "6px 4px", borderRadius: 8, background: "var(--bg3)" },
  calibBand: { fontSize: 10, color: "var(--text3)" },
  calibHit: { fontSize: 16, fontWeight: 800 },
  calibMeta: { fontSize: 9, color: "var(--text3)" },

  leagueGroup: { display: "flex", flexDirection: "column", gap: 10 },
  groupHeader: { display: "flex", alignItems: "center", gap: 8, padding: "2px 2px 4px" },
  groupTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--text)" },
  groupCount: { fontSize: 12, color: "var(--text3)", background: "var(--bg3)", borderRadius: 10, padding: "1px 8px" },
  groupAcc: { fontSize: 12, fontWeight: 700, marginLeft: "auto" },

  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" },
  cardHead: { display: "flex", alignItems: "center", gap: 16, padding: "12px 16px" },
  kickoff: { fontSize: 13, color: "var(--text3)", width: 44, flexShrink: 0 },
  teams: { flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
  teamRow: { display: "flex", alignItems: "center", gap: 8 },
  logo: { flexShrink: 0, objectFit: "contain" },
  teamName: { fontSize: 14, color: "var(--text2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  teamWon: { color: "var(--text)", fontWeight: 700 },
  score: { fontSize: 14, fontWeight: 700, color: "var(--text2)" },
  hitBadge: { fontSize: 12, fontWeight: 700, color: "var(--text2)", background: "var(--bg3)", borderRadius: 10, padding: "2px 9px", flexShrink: 0 },

  grid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, padding: "0 12px 12px" },
  gradeCell: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "6px 2px", background: "var(--bg3)", borderRadius: 8 },
  gradeLabel: { fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.3 },
  gradeIcon: { fontSize: 13 },
  gradePct: { fontSize: 11, fontWeight: 700 },
};

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getToolPass, clearToolPass } from "../components/ToolGate";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The day's leagues (from the props-finder selector feed — leagues with matches).
async function fetchLeagues(dateStr) {
  const res = await fetch(`/api/props-finder?date=${dateStr}&tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) throw new Error(`Failed (${res.status})`);
  return res.json();
}

async function fetchBoard({ league, dateStr }) {
  const res = await fetch(`/api/corner-board?leagues=${league}&date=${dateStr}&tz=${encodeURIComponent(TZ)}`, {
    headers: { "x-odds-pass": getToolPass() },
  });
  if (res.status === 401) { clearToolPass(); throw new Error("This tool is private."); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

const LINES = [
  { key: "fh2Plus", label: "2+" },
  { key: "fh3Plus", label: "3+" },
  { key: "fh4Plus", label: "4+" },
];

function koTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function pctColor(p) {
  if (p >= 65) return "#2ecc71";
  if (p >= 45) return "#9acd32";
  if (p >= 30) return "#f1c40f";
  return "#e74c3c";
}
function tint(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.16)`;
}

const WINDOWS = [
  { key: "all", label: "All day" },
  { key: "1", label: "Next 1h" },
  { key: "3", label: "Next 3h" },
  { key: "6", label: "Next 6h" },
];

export default function CornerGeneratorPage({ date, onDateChange, onOpenLeague }) {
  const [viewDate, setViewDate] = useState(() => {
    const d = date instanceof Date ? new Date(date) : new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const dateStr = ymd(viewDate);
  const isToday = dateStr === ymd(new Date());
  const [league, setLeague] = useState("");
  const [within, setWithin] = useState("all");
  const [generated, setGenerated] = useState(null);

  // "Within" window cutoff — only today narrows by hours; future days show all.
  const withinCutoff = isToday && within !== "all" ? Date.now() + Number(within) * 3600 * 1000 : Infinity;
  const inWindow = (ts) => withinCutoff === Infinity || !ts || ts * 1000 <= withinCutoff;

  const { data: sel } = useQuery({
    queryKey: ["corner-leagues", dateStr],
    queryFn: () => fetchLeagues(dateStr),
  });
  // Leagues offered in the dropdown. "All day" lists every league with a match
  // today — finished OR upcoming. A time window narrows to only leagues with an
  // UPCOMING match inside it (derived from the feed's per-match kickoffs).
  const leagues = within === "all"
    ? (sel?.allLeagues || sel?.leagues || [])
    : (() => {
        const seen = new Map();
        for (const m of sel?.matches || []) {
          if (!inWindow(m.kickoff)) continue;
          if (!seen.has(m.leagueId)) seen.set(m.leagueId, { id: m.leagueId, name: m.league, flag: m.leagueFlag });
        }
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
      })();

  // If the current pick falls out of the window (or day), clear it so a stale
  // league isn't left selected.
  useEffect(() => {
    if (league && !leagues.some((l) => String(l.id) === String(league))) setLeague("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [within, dateStr, sel]);

  const board = useQuery({
    queryKey: ["corner-board", generated?.key],
    queryFn: () => fetchBoard(generated),
    enabled: !!generated,
  });

  const onGenerate = () => {
    if (!league) return;
    setGenerated({ league, dateStr, key: `${league}:${dateStr}` });
  };

  // Open the board's league on the fixtures page for the full predictions +
  // analysis. Sync the app-wide date to the viewed day first (future included)
  // so the league page lands on the same date the corners were generated for.
  const openLeagueFixtures = () => {
    if (!generated?.league) return;
    onDateChange?.(new Date(viewDate));
    onOpenLeague?.(String(generated.league));
  };

  // Move the viewed day (future included — the › button is never capped). If a
  // league is already picked, re-generate for the new date so the board follows.
  const shiftDay = (days) => {
    const next = new Date(viewDate);
    next.setDate(next.getDate() + days);
    next.setHours(0, 0, 0, 0);
    setViewDate(next);
    setGenerated(league ? { league, dateStr: ymd(next), key: `${league}:${ymd(next)}` } : null);
  };

  const data = board.data;
  const prettyDate = viewDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  // Narrow the board to matches kicking off inside the same window.
  const matches = (data?.matches || []).filter((m) => inWindow(m.kickoff));

  return (
    <div style={styles.page}>
      <div style={styles.dateBar}>
        <button style={styles.navBtn} onClick={() => shiftDay(-1)} aria-label="Previous day">‹</button>
        <div style={styles.dateLabel}>
          {prettyDate}
          {isToday && <span style={styles.todayTag}>Today</span>}
        </div>
        <button style={styles.navBtn} onClick={() => shiftDay(1)} aria-label="Next day">›</button>
      </div>

      <div style={styles.note}>
        <span aria-hidden="true">⛳</span>
        <span>
          Pick a league playing <strong>{prettyDate}</strong> and hit Generate to project each
          team's <strong>first-half corners</strong> — the chance of 2+, 3+ and 4+. Model
          estimates from each team's recent corner rates.
        </span>
      </div>

      <div style={styles.controls}>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>League</span>
          <select style={styles.select} value={league} onChange={(e) => setLeague(e.target.value)}>
            <option value="">
              {leagues.length ? "Select a league…" : "No leagues playing this date"}
            </option>
            {leagues.map((l) => (
              <option key={l.id} value={l.id}>{l.flag} {l.name}</option>
            ))}
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>Within</span>
          <select
            style={{ ...styles.select, minWidth: 120, ...(isToday ? {} : styles.selectOff) }}
            value={within}
            onChange={(e) => setWithin(e.target.value)}
            disabled={!isToday}
            title={isToday ? "Only show matches kicking off within this window" : "Time window applies to today's matches"}
          >
            {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </label>
        <button
          style={{ ...styles.genBtn, ...(league ? {} : styles.genBtnOff) }}
          disabled={!league}
          onClick={onGenerate}
        >
          ⛳ Generate
        </button>
      </div>

      <div style={styles.board}>
        {!generated && <p style={styles.empty}>Pick a league above and press Generate.</p>}
        {generated && board.isLoading && (
          <>
            <Spinner />
            <p style={styles.loadingNote}>Reading each team's recent corner rates…</p>
          </>
        )}
        {generated && board.isError && <p style={styles.error}>{board.error.message}</p>}
        {generated && data && matches.length === 0 && (
          <p style={styles.empty}>
            {data.count === 0
              ? "No matches for this league on this date."
              : "No matches kicking off within this window."}
          </p>
        )}
        {generated && data && matches.map((m) => (
          <div
            key={m.id}
            role="button"
            tabIndex={0}
            style={{ ...styles.card, ...styles.cardClickable }}
            onClick={openLeagueFixtures}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLeagueFixtures(); } }}
            title="Open full predictions & analysis on the league fixtures page"
          >
            <div style={styles.cardHead}>
              <span style={styles.league}>{m.leagueFlag} {m.league}</span>
              <span style={styles.meta}>
                {koTime(m.kickoff)}
                <span style={styles.fhTotal} title="Projected first-half corners (both teams)">~{m.firstHalfTotal} 1H</span>
                {!m.available && <span style={styles.baseTag} title="No recent corner data for these teams — baseline estimate">baseline</span>}
              </span>
            </div>
            <TeamRow name={m.home.name} logo={m.home.logo} c={m.home.corners} />
            <TeamRow name={m.away.name} logo={m.away.logo} c={m.away.corners} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamRow({ name, logo, c }) {
  return (
    <div style={styles.row}>
      {logo && <img src={logo} alt="" width={22} height={22} style={styles.logo} onError={(e) => (e.target.style.visibility = "hidden")} />}
      <span style={styles.teamName}>{name}</span>
      <div style={styles.chips}>
        {LINES.map((ln) => {
          const v = c?.[ln.key] ?? 0;
          const color = pctColor(v);
          return (
            <span key={ln.key} style={styles.lineChip}>
              <span style={styles.lineLabel}>{ln.label}</span>
              <span style={{ ...styles.lineVal, background: tint(color), color }}>{v}%</span>
            </span>
          );
        })}
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
  dateBar: { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "12px 24px", borderBottom: "1px solid var(--border)" },
  navBtn: { fontSize: 22, color: "var(--text2)", padding: "2px 14px", borderRadius: 8, background: "var(--bg2)", cursor: "pointer" },
  dateLabel: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 15, minWidth: 180, justifyContent: "center" },
  todayTag: { fontSize: 11, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 4, padding: "1px 6px" },
  selectOff: { opacity: 0.45, cursor: "not-allowed" },
  cardClickable: { cursor: "pointer" },
  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "10px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  controls: { display: "flex", gap: 12, alignItems: "flex-end", padding: "14px 24px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  fieldLabel: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  select: { background: "var(--bg2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 14, minWidth: 220 },
  genBtn: { fontSize: 14, fontWeight: 700, color: "#04121f", background: "var(--accent)", border: "none", borderRadius: 8, padding: "9px 16px" },
  genBtnOff: { opacity: 0.4 },

  board: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 10, maxWidth: 820, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  loadingNote: { color: "var(--text3)", fontSize: 12, textAlign: "center" },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  league: { fontSize: 12, color: "var(--text3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text3)", flexShrink: 0 },
  fhTotal: { color: "var(--text2)", fontWeight: 600 },
  baseTag: { fontSize: 10, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px" },

  row: { display: "flex", alignItems: "center", gap: 10 },
  logo: { borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "var(--bg3)" },
  teamName: { flex: 1, fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  chips: { display: "flex", gap: 6, flexShrink: 0 },
  lineChip: { display: "flex", alignItems: "center", gap: 4 },
  lineLabel: { fontSize: 11, color: "var(--text3)" },
  lineVal: { fontSize: 13, fontWeight: 700, borderRadius: 6, padding: "3px 7px", minWidth: 40, textAlign: "center" },
};

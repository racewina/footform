import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getToolPass, clearToolPass } from "../components/ToolGate";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const WINDOWS = [
  { key: "all", label: "All day" },
  { key: "1", label: "Next 1h" },
  { key: "3", label: "Next 3h" },
  { key: "6", label: "Next 6h" },
];

// Leagues that have upcoming fixtures for the date + window (drives the picker).
async function fetchScanLeagues({ dateStr, within }) {
  const res = await fetch(`/api/team-2plus/leagues?date=${dateStr}&within=${within}&tz=${encodeURIComponent(TZ)}`, {
    headers: { "x-odds-pass": getToolPass() },
  });
  if (res.status === 401) { clearToolPass(); throw new Error("This tool is private."); }
  if (!res.ok) throw new Error("Failed to load leagues");
  return res.json();
}

async function fetchScan({ leagues, mode, dateStr, within }) {
  const extra = mode === "upcoming" ? `&date=${dateStr}&within=${within}` : "";
  const res = await fetch(`/api/team-2plus/scan?leagues=${leagues}&mode=${mode}${extra}&tz=${encodeURIComponent(TZ)}`, {
    headers: { "x-odds-pass": getToolPass() },
  });
  if (res.status === 401) { clearToolPass(); throw new Error("This tool is private."); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

function koTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function prettyDay(ds) {
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function probColor(p) {
  if (p >= 55) return "#2ecc71";
  if (p >= 45) return "#9acd32";
  if (p >= 35) return "#f1c40f";
  return "#e67e22";
}
function tint(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.16)`;
}

export default function Team2PlusScanPage() {
  const [within, setWithin] = useState("all");
  const [viewDate, setViewDate] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [selected, setSelected] = useState(() => new Set());   // league ids (strings)
  const [collapsed, setCollapsed] = useState(() => new Set());  // collapsed country groups
  const [generated, setGenerated] = useState(null); // { leagues, mode, dateStr, within, key }

  const dateStr = ymd(viewDate);
  const isToday = dateStr === ymd(new Date());
  const effWithin = isToday ? within : "all"; // the time window only applies to today
  const prettyDate = viewDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  // League list, refetched whenever the date or window changes → auto-narrows.
  const lgQuery = useQuery({
    queryKey: ["t2p-leagues", dateStr, effWithin],
    queryFn: () => fetchScanLeagues({ dateStr, within: effWithin }),
    staleTime: 60 * 1000,
  });
  const avail = lgQuery.data?.leagues || [];
  const availKey = avail.map((l) => l.id).join(",");

  // Drop any selection that no longer has fixtures in the current date/window.
  useEffect(() => {
    const ids = new Set(avail.map((l) => String(l.id)));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availKey]);

  const groups = useMemo(() => {
    const by = {};
    for (const l of avail) (by[l.country] ||= []).push(l);
    return Object.entries(by).sort(([a], [b]) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availKey]);

  const toggleLeague = (id) => setSelected((p) => {
    const n = new Set(p); const k = String(id); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const toggleCountry = (c) => setCollapsed((p) => {
    const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n;
  });
  const setCountry = (items, on) => setSelected((p) => {
    const n = new Set(p); items.forEach((l) => on ? n.add(String(l.id)) : n.delete(String(l.id))); return n;
  });
  const selectAll = () => setSelected(new Set(avail.map((l) => String(l.id))));
  const clearAll = () => setSelected(new Set());

  const selCount = selected.size;

  const run = (mode) => {
    if (!selCount) return;
    const ids = [...selected].join(",");
    setGenerated({
      leagues: ids, mode, dateStr, within: effWithin,
      key: `${ids}:${mode}:${mode === "upcoming" ? `${dateStr}:${effWithin}` : "bt"}`,
    });
  };

  const shiftDay = (days) => {
    const next = new Date(viewDate); next.setDate(next.getDate() + days); next.setHours(0, 0, 0, 0);
    setViewDate(next);
    setGenerated(null);
  };

  const scan = useQuery({
    queryKey: ["t2p-scan", generated?.key],
    queryFn: () => fetchScan(generated),
    enabled: !!generated,
  });
  const data = scan.data;
  const rows = data?.rows || [];
  const multi = (data?.leagues?.length || 0) > 1;
  const scopeLabel = data
    ? (data.leagues?.length === 1 ? `${data.leagues[0].flag} ${data.leagues[0].name}` : `${data.leagues?.length} leagues`)
    : "";

  return (
    <div style={styles.page}>
      <div style={styles.dateBar}>
        <button style={styles.navBtn} onClick={() => shiftDay(-1)} aria-label="Previous day">‹</button>
        <div style={styles.dateLabel}>{prettyDate}{isToday && <span style={styles.todayTag}>Today</span>}</div>
        <button style={styles.navBtn} onClick={() => shiftDay(1)} aria-label="Next day">›</button>
      </div>

      <div style={styles.note}>
        <span aria-hidden="true">⚽</span>
        <span>
          Tick one or more leagues, then <strong>Generate</strong> for each upcoming fixture's
          "team to score 2+ goals" pick with real bookmaker prices, or <strong>Backtest</strong> to
          see how the pick has landed across past finished matches. The list only shows leagues with
          fixtures for the chosen date and <strong>Within</strong> window. Estimates only.
        </span>
      </div>

      <div style={styles.controls}>
        <label style={styles.fieldNarrow}>
          <span style={styles.fieldLabel}>Within</span>
          <select
            style={{ ...styles.select, ...(isToday ? {} : styles.selectOff) }}
            value={within}
            onChange={(e) => { setWithin(e.target.value); setGenerated(null); }}
            disabled={!isToday}
            title={isToday ? "Only leagues with a fixture kicking off within this window" : "Time window applies to today only"}
          >
            {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </label>
        <div style={styles.spacer} />
        <button style={{ ...styles.btn, ...styles.btnAlt, ...(selCount ? {} : styles.btnOff) }} disabled={!selCount} onClick={() => run("backtest")}>
          📊 Backtest{selCount ? ` (${selCount})` : ""}
        </button>
        <button style={{ ...styles.btn, ...(selCount ? {} : styles.btnOff) }} disabled={!selCount} onClick={() => run("upcoming")}>
          ⚡ Generate{selCount ? ` (${selCount})` : ""}
        </button>
      </div>

      <div style={styles.pickerHead}>
        <span style={styles.pickerTitle}>
          Leagues{avail.length ? ` · ${avail.length}` : ""}
          {selCount ? <span style={styles.selBadge}>{selCount} selected</span> : null}
        </span>
        <span>
          <button style={styles.linkBtn} onClick={selectAll} disabled={!avail.length}>Select all</button>
          <button style={styles.linkBtn} onClick={clearAll} disabled={!selCount}>Clear</button>
        </span>
      </div>

      <div style={styles.pickerWrap}>
        {lgQuery.isLoading ? (
          <p style={styles.pickerNote}>Loading leagues…</p>
        ) : lgQuery.isError ? (
          <p style={styles.pickerNote}>{lgQuery.error.message}</p>
        ) : groups.length === 0 ? (
          <p style={styles.pickerNote}>
            No leagues have upcoming fixtures {effWithin === "all" ? "on this date" : `in the next ${effWithin}h`}.
          </p>
        ) : (
          groups.map(([country, items]) => {
            const open = !collapsed.has(country);
            const total = items.reduce((n, l) => n + (l.count || 0), 0);
            const allSel = items.every((l) => selected.has(String(l.id)));
            const someSel = items.some((l) => selected.has(String(l.id)));
            return (
              <div key={country} style={styles.cGroup}>
                <div style={styles.cRow}>
                  <input
                    type="checkbox"
                    checked={allSel}
                    ref={(el) => { if (el) el.indeterminate = !allSel && someSel; }}
                    onChange={() => setCountry(items, !allSel)}
                    style={styles.cbox}
                    aria-label={`Select all ${country}`}
                  />
                  <button style={styles.cToggle} onClick={() => toggleCountry(country)} aria-expanded={open}>
                    <span style={styles.cName}>{items[0].flag} {country}</span>
                    <span style={styles.cMeta}>
                      <span style={styles.cCount}>{total}</span>
                      <span style={{ ...styles.chev, transform: open ? "rotate(90deg)" : "none" }}>›</span>
                    </span>
                  </button>
                </div>
                {open && items.map((l) => {
                  const on = selected.has(String(l.id));
                  return (
                    <label key={l.id} style={{ ...styles.lRow, ...(on ? styles.lRowOn : {}) }}>
                      <input type="checkbox" checked={on} onChange={() => toggleLeague(l.id)} style={styles.cbox} />
                      <span style={styles.lName}>{l.name}</span>
                      <span style={styles.lCount}>{l.count}</span>
                    </label>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      <div style={styles.board}>
        {!generated && <p style={styles.empty}>Tick leagues above, then Backtest or Generate.</p>}
        {generated && scan.isLoading && (
          <>
            <Spinner />
            <p style={styles.loadingNote}>
              {generated.mode === "backtest" ? "Rebuilding past predictions and grading each pick…" : "Reading upcoming fixtures and prices…"}
            </p>
          </>
        )}
        {generated && scan.isError && <p style={styles.error}>{scan.error.message}</p>}

        {generated && data && data.mode === "backtest" && (
          <>
            {data.summary?.total ? (
              <div style={styles.summary}>
                <div style={styles.summHead}>{scopeLabel} · last {data.days} days</div>
                <div style={styles.summStats}>
                  <Stat label="Hit rate" value={`${data.summary.hitRate}%`} big color={probColor(data.summary.hitRate)} />
                  <Stat label="Picks landed" value={`${data.summary.hits}/${data.summary.total}`} />
                  <Stat label="Avg model prob" value={`${data.summary.avgProb}%`} />
                </div>
                <div style={styles.summNote}>How often the model's picked team actually scored 2+ goals.</div>
              </div>
            ) : (
              <p style={styles.empty}>No finished matches with a prediction for the selected leagues in the window.</p>
            )}
            {rows.map((r) => (
              <div key={`${r.leagueId}-${r.matchId}`} style={styles.row}>
                <span style={styles.rowDate}>{prettyDay(r.date)}</span>
                {multi && <span style={styles.rowFlag} title={r.leagueName}>{r.leagueFlag}</span>}
                <span style={styles.rowMatch}>
                  {r.home} <b style={styles.score}>{r.homeScore}-{r.awayScore}</b> {r.away}
                </span>
                <span style={styles.rowPick}>
                  <span style={{ ...styles.pickTeam, background: tint(probColor(r.prob)), color: probColor(r.prob) }}>{r.team} 2+ · {r.prob}%</span>
                </span>
                <span style={{ ...styles.hitBadge, ...(r.hit ? styles.hitWon : styles.hitLost) }}>{r.hit ? "✓" : "✗"}</span>
              </div>
            ))}
          </>
        )}

        {generated && data && data.mode === "upcoming" && (
          rows.length === 0 ? (
            <p style={styles.empty}>No upcoming fixtures for the selected leagues in this window.</p>
          ) : (
            <>
              <div style={styles.resultHead}>{scopeLabel} · {rows.length} upcoming — likeliest to score 2+</div>
              {rows.map((r) => (
                <div key={`${r.leagueId}-${r.matchId}`} style={styles.card}>
                  <div style={styles.cardHead}>
                    <span style={styles.teams}>
                      {multi && <span style={styles.cardFlag} title={r.leagueName}>{r.leagueFlag}</span>}
                      {r.home} v {r.away}
                    </span>
                    <span style={styles.ko}>{koTime(r.kickoff)}</span>
                  </div>
                  <div style={styles.sides}>
                    <SideRow name={r.home} prob={r.homeProb} odds={r.homeOdds} book={r.homeBook} picked={r.side === "home"} />
                    <SideRow name={r.away} prob={r.awayProb} odds={r.awayOdds} book={r.awayBook} picked={r.side === "away"} />
                  </div>
                </div>
              ))}
            </>
          )
        )}
      </div>
    </div>
  );
}

// One team's "to score 2+" strength: model probability + its own book price.
// The picked side (the higher probability) is marked and bolded.
function SideRow({ name, prob, odds, book, picked }) {
  const hasP = typeof prob === "number";
  return (
    <div style={styles.sideRow}>
      <span style={{ ...styles.sideName, ...(picked ? { fontWeight: 700 } : {}) }}>
        {picked && <span style={styles.pickDot}>◆</span>}{name}
      </span>
      <span style={styles.sideRight}>
        {hasP && (
          <span style={{ ...styles.sideProb, background: tint(probColor(prob)), color: probColor(prob) }}>2+ {prob}%</span>
        )}
        <span style={styles.sideOdds}>
          {odds != null ? <>@{odds.toFixed(2)} <span style={styles.book}>{book}</span></> : <span style={styles.book}>no price</span>}
        </span>
      </span>
    </div>
  );
}

function Stat({ label, value, big, color }) {
  return (
    <div style={styles.stat}>
      <span style={{ ...styles.statVal, ...(big ? { fontSize: 26 } : {}), ...(color ? { color } : {}) }}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
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
  controls: { display: "flex", gap: 12, alignItems: "flex-end", padding: "14px 24px 12px", flexWrap: "wrap" },
  fieldLabel: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  select: { background: "var(--bg2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 14, width: "100%" },
  fieldNarrow: { display: "flex", flexDirection: "column", gap: 4, minWidth: 130 },
  selectOff: { opacity: 0.45, cursor: "not-allowed" },
  spacer: { flex: 1 },
  dateBar: { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "12px 24px", borderBottom: "1px solid var(--border)" },
  navBtn: { fontSize: 22, color: "var(--text2)", padding: "2px 14px", borderRadius: 8, background: "var(--bg2)", cursor: "pointer" },
  dateLabel: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 15, minWidth: 180, justifyContent: "center" },
  todayTag: { fontSize: 11, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 4, padding: "1px 6px" },
  btn: { fontSize: 14, fontWeight: 700, color: "#04121f", background: "var(--accent)", border: "none", borderRadius: 8, padding: "9px 16px", cursor: "pointer" },
  btnAlt: { background: "#3a86ff", color: "#fff" },
  btnOff: { opacity: 0.4, cursor: "not-allowed" },

  pickerHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px 6px", maxWidth: 860, width: "100%", margin: "0 auto" },
  pickerTitle: { fontSize: 12, fontWeight: 700, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 0.4, display: "flex", alignItems: "center", gap: 8 },
  selBadge: { fontSize: 11, fontWeight: 700, color: "var(--accent)", background: "rgba(46,204,113,0.14)", borderRadius: 20, padding: "2px 9px", textTransform: "none", letterSpacing: 0 },
  linkBtn: { fontSize: 12, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" },
  pickerWrap: { maxHeight: 230, overflowY: "auto", padding: "0 24px 8px", maxWidth: 860, width: "100%", margin: "0 auto", borderBottom: "1px solid var(--border)" },
  pickerNote: { color: "var(--text3)", fontSize: 13, textAlign: "center", padding: 24 },
  cGroup: { borderBottom: "1px solid var(--border)" },
  cRow: { display: "flex", alignItems: "center", gap: 8 },
  cToggle: { flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "none", border: "none", cursor: "pointer", padding: "8px 0", color: "var(--text)", fontSize: 14, fontWeight: 600 },
  cName: { display: "flex", alignItems: "center", gap: 6 },
  cMeta: { display: "flex", alignItems: "center", gap: 8, color: "var(--text3)" },
  cCount: { fontSize: 12, fontWeight: 700, background: "var(--bg2)", borderRadius: 20, padding: "1px 8px", minWidth: 20, textAlign: "center" },
  chev: { fontSize: 16, display: "inline-block", transition: "transform .15s" },
  lRow: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0 6px 26px", cursor: "pointer", fontSize: 13.5, color: "var(--text2)" },
  lRowOn: { color: "var(--text)" },
  lName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  lCount: { fontSize: 11, color: "var(--text3)", fontWeight: 700 },
  cbox: { width: 15, height: 15, accentColor: "#2ecc71", cursor: "pointer", flexShrink: 0 },

  board: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 8, maxWidth: 860, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  loadingNote: { color: "var(--text3)", fontSize: 12, textAlign: "center" },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },
  resultHead: { fontSize: 13, color: "var(--text3)", padding: "0 2px 2px" },

  summary: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px", marginBottom: 6 },
  summHead: { fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 12 },
  summStats: { display: "flex", gap: 24, flexWrap: "wrap" },
  stat: { display: "flex", flexDirection: "column", gap: 2 },
  statVal: { fontSize: 18, fontWeight: 800, color: "var(--text)" },
  statLabel: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  summNote: { fontSize: 12, color: "var(--text3)", marginTop: 10 },

  row: { display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10 },
  rowDate: { fontSize: 11, color: "var(--text3)", width: 52, flexShrink: 0 },
  rowFlag: { fontSize: 14, flexShrink: 0 },
  rowMatch: { flex: 1, fontSize: 13.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  score: { color: "var(--text2)", margin: "0 2px" },
  rowPick: { flexShrink: 0 },
  pickTeam: { fontSize: 12.5, fontWeight: 700, borderRadius: 6, padding: "3px 8px", whiteSpace: "nowrap" },
  hitBadge: { fontSize: 13, fontWeight: 800, width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  hitWon: { background: "rgba(46,204,113,0.18)", color: "#2ecc71" },
  hitLost: { background: "rgba(231,76,60,0.16)", color: "#e74c3c" },

  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  teams: { fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 },
  cardFlag: { fontSize: 14, flexShrink: 0 },
  ko: { fontSize: 12, color: "var(--text3)", flexShrink: 0 },
  odds: { fontSize: 13, fontWeight: 700, color: "var(--text)" },
  book: { fontSize: 11, fontWeight: 400, color: "var(--text3)" },

  sides: { display: "flex", flexDirection: "column", gap: 7, borderTop: "1px solid var(--border)", paddingTop: 8 },
  sideRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  sideName: { fontSize: 13.5, color: "var(--text)", display: "flex", alignItems: "center", gap: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  pickDot: { color: "var(--accent)", fontSize: 10, flexShrink: 0 },
  sideRight: { display: "flex", alignItems: "center", gap: 10, flexShrink: 0 },
  sideProb: { fontSize: 12, fontWeight: 700, borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" },
  sideOdds: { fontSize: 13, fontWeight: 700, color: "var(--text)", minWidth: 76, textAlign: "right" },
};

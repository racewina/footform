import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getToolPass, clearToolPass } from "../components/ToolGate";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Same pinned order as the Today's Matches sidebar.
const TOP_COUNTRIES = ["England", "Spain", "Italy", "Germany", "France", "Europe", "South America"];
// Continent chips (shown only when present in the day's leagues).
const CONTINENT_ORDER = ["Europe", "South America", "North America", "Asia", "Africa", "International", "Other"];

const WINDOWS = [
  { key: "all", label: "All day" },
  { key: "1", label: "Next 1h" },
  { key: "3", label: "Next 3h" },
  { key: "6", label: "Next 6h" },
];

// Label a kickoff-hour bucket, e.g. 6 → "6–7 AM".
const hourLabel = (h) => {
  const f = (x) => `${x % 12 === 0 ? 12 : x % 12} ${x < 12 ? "AM" : "PM"}`;
  return `${f(h)}–${f((h + 1) % 24)}`;
};

// Leagues with fixtures for the date + window (drives the picker). finished=1 keeps
// past/finished-match leagues in the list so the date nav can browse any day.
async function fetchScanLeagues({ dateStr, within, hour }) {
  const hourQ = hour === "all" ? "" : `&hour=${hour}`;
  const res = await fetch(`/api/team-2plus/leagues?date=${dateStr}&within=${within}&finished=1${hourQ}&tz=${encodeURIComponent(TZ)}`, {
    headers: { "x-odds-pass": getToolPass() },
  });
  if (res.status === 401) { clearToolPass(); throw new Error("This tool is private."); }
  if (!res.ok) throw new Error("Failed to load leagues");
  return res.json();
}

async function fetchBoard({ leagues, dateStr }) {
  const res = await fetch(`/api/corner-board?leagues=${leagues}&date=${dateStr}&tz=${encodeURIComponent(TZ)}`, {
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

export default function CornerGeneratorPage({ date, onDateChange, onOpenLeague }) {
  const [viewDate, setViewDate] = useState(() => {
    const d = date instanceof Date ? new Date(date) : new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const dateStr = ymd(viewDate);
  const isToday = dateStr === ymd(new Date());
  const [within, setWithin] = useState("all");
  const [selected, setSelected] = useState(() => new Set());   // league ids (strings)
  const [collapsed, setCollapsed] = useState(() => new Set());  // collapsed country groups
  const [pickerOpen, setPickerOpen] = useState(true);
  const [continent, setContinent] = useState("all");            // continent filter
  const [hourFilter, setHourFilter] = useState("all");          // "all" | 0..23 kickoff-hour bucket
  const [generated, setGenerated] = useState(null);

  const effWithin = isToday ? within : "all"; // the time window only applies to today
  const prettyDate = viewDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  // "Within" window cutoff — narrows the board to matches kicking off inside it.
  const nowMs = Date.now();
  const withinCutoff = isToday && within !== "all" ? nowMs + Number(within) * 3600 * 1000 : Infinity;
  const inWindow = (ts) => {
    if (withinCutoff === Infinity) return true;
    if (!ts) return false;
    const ms = ts * 1000;
    return ms >= nowMs - 10 * 60 * 1000 && ms <= withinCutoff;
  };

  // League list, refetched whenever the date/window/hour changes → auto-narrows.
  const lgQuery = useQuery({
    queryKey: ["corner-leagues", dateStr, effWithin, hourFilter],
    queryFn: () => fetchScanLeagues({ dateStr, within: effWithin, hour: hourFilter }),
    staleTime: 60 * 1000,
    placeholderData: (prev) => prev, // keep the picker + Kick-off list visible during refetch
  });
  const avail = lgQuery.data?.leagues || [];
  const hourBuckets = lgQuery.data?.hours || [];
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

  // Continents present in the day's leagues, in preferred order (drives the chips).
  const continents = useMemo(() => {
    const present = new Set(avail.map((l) => l.continent || "Other"));
    return CONTINENT_ORDER.filter((c) => present.has(c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availKey]);

  // Pinned top countries first (only those that have fixtures), then the rest A–Z.
  // Narrowed to the chosen continent when one is picked.
  const groups = useMemo(() => {
    const src = continent === "all" ? avail : avail.filter((l) => (l.continent || "Other") === continent);
    const by = {};
    for (const l of src) (by[l.country] ||= []).push(l);
    const pinned = TOP_COUNTRIES.filter((c) => by[c]).map((c) => [c, by[c]]);
    const rest = Object.entries(by)
      .filter(([c]) => !TOP_COUNTRIES.includes(c))
      .sort(([a], [b]) => a.localeCompare(b));
    return [...pinned, ...rest];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availKey, continent]);
  const shownCount = groups.reduce((n, [, items]) => n + items.length, 0);

  const toggleLeague = (id) => setSelected((p) => {
    const n = new Set(p); const k = String(id); n.has(k) ? n.delete(k) : n.add(k); return n;
  });
  const toggleCountry = (c) => setCollapsed((p) => {
    const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n;
  });
  const setCountry = (items, on) => setSelected((p) => {
    const n = new Set(p); items.forEach((l) => on ? n.add(String(l.id)) : n.delete(String(l.id))); return n;
  });
  // Add every league currently shown (respects the continent filter; accumulates).
  const selectAll = () => setSelected((p) => {
    const n = new Set(p);
    groups.forEach(([, items]) => items.forEach((l) => n.add(String(l.id))));
    return n;
  });
  const clearAll = () => setSelected(new Set());
  const selCount = selected.size;

  const onGenerate = () => {
    if (!selCount) return;
    const ids = [...selected].join(",");
    setGenerated({ leagues: ids, dateStr, key: `${ids}:${dateStr}` });
  };

  const board = useQuery({
    queryKey: ["corner-board", generated?.key],
    queryFn: () => fetchBoard(generated),
    enabled: !!generated,
  });

  // Open a match's league on the fixtures page for the full predictions + analysis.
  const openLeagueFixtures = (leagueId) => {
    if (!leagueId) return;
    onDateChange?.(new Date(viewDate));
    onOpenLeague?.(String(leagueId));
  };

  // Move the viewed day (future included). Re-generate for the new date so the
  // board follows the current selection.
  const shiftDay = (days) => {
    const next = new Date(viewDate);
    next.setDate(next.getDate() + days);
    next.setHours(0, 0, 0, 0);
    setViewDate(next);
    setHourFilter("all");
    const ids = [...selected].join(",");
    setGenerated(selCount ? { leagues: ids, dateStr: ymd(next), key: `${ids}:${ymd(next)}` } : null);
  };

  const passHour = (ts) => hourFilter === "all" || (ts && new Date(ts * 1000).getHours() === Number(hourFilter));
  const data = board.data;
  const matches = (data?.matches || []).filter((m) => inWindow(m.kickoff) && passHour(m.kickoff));

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
          Tick one or more leagues playing <strong>{prettyDate}</strong> and hit Generate to project each
          team's <strong>first-half corners</strong> — the chance of 2+, 3+ and 4+. Model estimates from
          each team's recent corner rates.
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
            title={isToday ? "Only leagues/matches kicking off within this window" : "Time window applies to today"}
          >
            {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </label>
        {hourBuckets.length > 1 && (
          <label style={styles.fieldNarrow}>
            <span style={styles.fieldLabel}>Kick-off</span>
            <select style={styles.select} value={hourFilter} onChange={(e) => { setHourFilter(e.target.value); setGenerated(null); }}>
              <option value="all">Any time</option>
              {hourBuckets.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
        )}
        <div style={styles.spacer} />
        <button
          style={{ ...styles.genBtn, ...(selCount ? {} : styles.genBtnOff) }}
          disabled={!selCount}
          onClick={onGenerate}
        >
          ⛳ Generate{selCount ? ` (${selCount})` : ""}
        </button>
      </div>

      {continents.length > 1 && (
        <div style={styles.continentBar}>
          <button
            style={{ ...styles.contChip, ...(continent === "all" ? styles.contChipOn : {}) }}
            onClick={() => setContinent("all")}
          >All</button>
          {continents.map((c) => (
            <button
              key={c}
              style={{ ...styles.contChip, ...(continent === c ? styles.contChipOn : {}) }}
              onClick={() => setContinent(c)}
            >{c}</button>
          ))}
        </div>
      )}

      <div style={styles.pickerHead}>
        <button style={styles.pickerToggle} onClick={() => setPickerOpen((v) => !v)} aria-expanded={pickerOpen}>
          <span style={{ ...styles.chev, transform: pickerOpen ? "rotate(90deg)" : "none" }}>›</span>
          Leagues{shownCount ? ` · ${shownCount}` : ""}
          {selCount ? <span style={styles.selBadge}>{selCount} selected</span> : null}
        </button>
        <span>
          <button style={styles.linkBtn} onClick={selectAll} disabled={!avail.length}>Select all</button>
          <button style={styles.linkBtn} onClick={clearAll} disabled={!selCount}>Clear</button>
        </span>
      </div>

      {pickerOpen && (
      <div style={styles.pickerWrap}>
        {lgQuery.isLoading ? (
          <p style={styles.pickerNote}>Loading leagues…</p>
        ) : lgQuery.isError ? (
          <p style={styles.pickerNote}>{lgQuery.error.message}</p>
        ) : groups.length === 0 ? (
          <p style={styles.pickerNote}>
            No leagues have fixtures {effWithin === "all" ? "on this date" : `in the next ${effWithin}h`}.
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
      )}

      <div style={styles.board}>
        {!generated && <p style={styles.empty}>Tick leagues above and press Generate.</p>}
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
              ? "No matches for the selected leagues on this date."
              : "No matches kicking off within this window."}
          </p>
        )}
        {generated && data && matches.map((m) => (
          <div
            key={`${m.leagueId}-${m.id}`}
            role="button"
            tabIndex={0}
            style={{ ...styles.card, ...styles.cardClickable }}
            onClick={() => openLeagueFixtures(m.leagueId)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLeagueFixtures(m.leagueId); } }}
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
  controls: { display: "flex", gap: 12, alignItems: "flex-end", padding: "14px 24px 12px", flexWrap: "wrap" },
  fieldNarrow: { display: "flex", flexDirection: "column", gap: 4, minWidth: 130 },
  fieldLabel: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  select: { background: "var(--bg2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 14, width: "100%" },
  spacer: { flex: 1 },
  genBtn: { fontSize: 14, fontWeight: 700, color: "#04121f", background: "var(--accent)", border: "none", borderRadius: 8, padding: "9px 16px", cursor: "pointer" },
  genBtnOff: { opacity: 0.4, cursor: "not-allowed" },

  continentBar: { display: "flex", flexWrap: "wrap", gap: 6, padding: "0 24px 8px", maxWidth: 820, width: "100%", margin: "0 auto" },
  contChip: { fontSize: 12, fontWeight: 600, color: "var(--text2)", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 20, padding: "4px 11px", cursor: "pointer" },
  contChipOn: { background: "var(--accent)", color: "#04121f", borderColor: "var(--accent)" },
  pickerHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px 6px", maxWidth: 820, width: "100%", margin: "0 auto" },
  pickerToggle: { fontSize: 12, fontWeight: 700, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 0.4, display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", padding: 0 },
  selBadge: { fontSize: 11, fontWeight: 700, color: "var(--accent)", background: "rgba(46,204,113,0.14)", borderRadius: 20, padding: "2px 9px", textTransform: "none", letterSpacing: 0 },
  linkBtn: { fontSize: 12, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" },
  pickerWrap: { maxHeight: 190, overflowY: "auto", padding: "0 24px 4px", maxWidth: 820, width: "100%", margin: "0 auto", borderBottom: "1px solid var(--border)" },
  pickerNote: { color: "var(--text3)", fontSize: 13, textAlign: "center", padding: 16 },
  cGroup: { borderBottom: "1px solid var(--border)" },
  cRow: { display: "flex", alignItems: "center", gap: 8 },
  cToggle: { flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "none", border: "none", cursor: "pointer", padding: "4px 0", color: "var(--text)", fontSize: 13.5, fontWeight: 600 },
  cName: { display: "flex", alignItems: "center", gap: 6 },
  cMeta: { display: "flex", alignItems: "center", gap: 8, color: "var(--text3)" },
  cCount: { fontSize: 11, fontWeight: 700, background: "var(--bg2)", borderRadius: 20, padding: "1px 7px", minWidth: 18, textAlign: "center" },
  chev: { fontSize: 14, display: "inline-block", transition: "transform .15s" },
  lRow: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0 3px 24px", cursor: "pointer", fontSize: 13, color: "var(--text2)" },
  lRowOn: { color: "var(--text)" },
  lName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  lCount: { fontSize: 11, color: "var(--text3)", fontWeight: 700 },
  cbox: { width: 15, height: 15, accentColor: "#2ecc71", cursor: "pointer", flexShrink: 0 },

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

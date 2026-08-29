import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const CONTINENT_ORDER = ["Europe", "South America", "North America", "Asia", "Africa", "International", "Other"];

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// League list for the day (props-finder selector feed — leagues with matches).
async function fetchLeagues(dateStr) {
  const res = await fetch(`/api/props-finder?date=${dateStr}&tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) throw new Error(`Failed (${res.status})`);
  return res.json();
}

// This page is private — every odds-generator call carries the gate code as a
// header (never in the URL). The code is validated server-side; the bundle holds
// no password, and a 401 bubbles up so the caller can drop back to the lock.
const PASS_KEY = "footform_og_pass";

class UnauthorizedError extends Error {}

async function fetchBoard({ leagues, dateStr, within, market, min, max, pass }) {
  const res = await fetch(
    `/api/odds-generator?leagues=${leagues}&date=${dateStr}&tz=${encodeURIComponent(TZ)}` +
    `&within=${within}&market=${market}&oddsMin=${min}&oddsMax=${max}`,
    { headers: { "x-odds-pass": pass || "" } }
  );
  if (res.status === 401) throw new UnauthorizedError("This tool is private.");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

// Validate a gate code against the server (a minimal, no-leagues request). Returns
// true only on a 200 — i.e. the server accepted the code.
async function verifyPass(code) {
  const res = await fetch(`/api/odds-generator?tz=${encodeURIComponent(TZ)}`, {
    headers: { "x-odds-pass": code },
  });
  return res.ok;
}

const WINDOWS = [
  { key: "all", label: "All day" },
  { key: "1", label: "Next 1h" },
  { key: "3", label: "Next 3h" },
  { key: "6", label: "Next 6h" },
];

// Market-family filter — restricts which market the engine may pick per fixture.
const MARKETS = [
  { key: "all", label: "All markets" },
  { key: "goals", label: "Goals" },
  { key: "corner1h", label: "1st half corners" },
  { key: "cornertotal", label: "Total corners" },
  { key: "over", label: "Over" },
  { key: "under", label: "Under" },
  { key: "dc", label: "Double chance" },
];

// Odds ladder in 0.10-wide buckets (matches the backend). Built from integers to
// avoid float drift, so buckets are clean and non-overlapping (1.10–1.19, …).
const RANGES = (() => {
  const out = [];
  for (let lo = 110; lo <= 500; lo += 10) {
    const min = lo / 100, max = (lo + 9) / 100;
    out.push({ key: `${min.toFixed(2)}-${max.toFixed(2)}`, min, max, label: `${min.toFixed(2)} – ${max.toFixed(2)}` });
  }
  return out;
})();
const DEFAULT_RANGE = "1.30-1.39";

function koTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// Label a kickoff-hour bucket, e.g. 6 → "6–7 AM".
const hourLabel = (h) => {
  const f = (x) => `${x % 12 === 0 ? 12 : x % 12} ${x < 12 ? "AM" : "PM"}`;
  return `${f(h)}–${f((h + 1) % 24)}`;
};
const kickoffHour = (ts) => (ts ? new Date(ts * 1000).getHours() : null);

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

export default function OddsGeneratorPage({ date, onDateChange, onOpenLeague }) {
  const [viewDate, setViewDate] = useState(() => {
    const d = date instanceof Date ? new Date(date) : new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const dateStr = ymd(viewDate);
  const isToday = dateStr === ymd(new Date());
  const [within, setWithin] = useState("all");
  const [hourFilter, setHourFilter] = useState("all"); // "all" | 0..23 — kickoff-hour bucket
  const [market, setMarket] = useState("all");
  const [picked, setPicked] = useState([]);     // selected league ids (strings)
  const [continent, setContinent] = useState("all");
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [generated, setGenerated] = useState(null);
  // Gate code — remembered across visits once validated. Empty ⇒ show the lock.
  const [pass, setPass] = useState(() => (typeof localStorage !== "undefined" && localStorage.getItem(PASS_KEY)) || "");

  const lockOut = () => {
    try { localStorage.removeItem(PASS_KEY); } catch {}
    setPass("");
    setGenerated(null);
  };

  const nowMs = Date.now();
  const withinCutoff = isToday && within !== "all" ? nowMs + Number(within) * 3600 * 1000 : Infinity;
  // A league qualifies for a time window only if it has an UPCOMING match inside it —
  // kicking off from now (small grace for a just-started one) up to the cutoff. Without
  // the lower bound, matches that already kicked off earlier today would leak in and the
  // window wouldn't actually narrow the league list.
  const inWindow = (ts) => {
    if (withinCutoff === Infinity) return true;
    if (!ts) return false;
    const ms = ts * 1000;
    return ms >= nowMs - 10 * 60 * 1000 && ms <= withinCutoff;
  };
  // Absolute kickoff-hour bucket (6–7 AM …), independent of "within" (relative).
  const passHour = (ts) => hourFilter === "all" || kickoffHour(ts) === Number(hourFilter);

  const { data: sel } = useQuery({
    queryKey: ["oddsgen-leagues", dateStr],
    queryFn: () => fetchLeagues(dateStr),
  });
  // Leagues offered. "All day" lists every league with a match today; a time
  // window narrows to leagues with an UPCOMING match inside it.
  const leagues = (within === "all" && hourFilter === "all")
    ? (sel?.allLeagues || sel?.leagues || [])
    : (() => {
        const seen = new Map();
        for (const m of sel?.matches || []) {
          if (!inWindow(m.kickoff) || !passHour(m.kickoff)) continue;
          if (!seen.has(m.leagueId)) seen.set(m.leagueId, { id: m.leagueId, name: m.league, flag: m.leagueFlag, continent: m.leagueContinent });
        }
        return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
      })();
  // Distinct kickoff hours among the day's fixtures (drives the Kick-off buckets).
  const hourBuckets = [...new Set((sel?.matches || []).map((m) => kickoffHour(m.kickoff)).filter((h) => h != null))].sort((a, b) => a - b);

  // Continent filter: chips shown only when >1 continent has leagues that day.
  const continents = CONTINENT_ORDER.filter((c) => leagues.some((l) => (l.continent || "Other") === c));
  const shownLeagues = continent === "all" ? leagues : leagues.filter((l) => (l.continent || "Other") === continent);

  // Drop any picked league that's no longer offered in the current window/day.
  useEffect(() => {
    setPicked((cur) => cur.filter((id) => leagues.some((l) => String(l.id) === String(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [within, hourFilter, dateStr, sel]);

  const board = useQuery({
    queryKey: ["odds-gen", generated?.key],
    queryFn: () => fetchBoard({ ...generated, pass }),
    enabled: !!generated && !!pass,
    retry: false,
  });

  // A rejected code (e.g. changed server-side) drops the page back to the lock.
  useEffect(() => {
    if (board.error instanceof UnauthorizedError) lockOut();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.error]);

  const rangeObj = RANGES.find((r) => r.key === range) || RANGES[0];
  const leaguesById = new Map(leagues.map((l) => [String(l.id), l]));

  const addLeague = (id) => {
    if (!id) return;
    setPicked((cur) => (cur.includes(id) ? cur : [...cur, id]));
  };
  const removeLeague = (id) => setPicked((cur) => cur.filter((x) => x !== id));
  const addAll = () => setPicked((cur) => [...new Set([...cur, ...shownLeagues.map((l) => String(l.id))])]);
  const clearAll = () => setPicked([]);

  const onGenerate = () => {
    if (!picked.length) return;
    const leaguesCsv = picked.join(",");
    setGenerated({
      leagues: leaguesCsv, dateStr, within, market, min: rangeObj.min, max: rangeObj.max,
      key: `${leaguesCsv}:${dateStr}:${within}:${market}:${rangeObj.key}`,
    });
  };

  const openMatchLeague = (leagueId) => {
    if (!leagueId) return;
    onDateChange?.(new Date(viewDate));
    onOpenLeague?.(String(leagueId));
  };

  const shiftDay = (days) => {
    const next = new Date(viewDate);
    next.setDate(next.getDate() + days);
    next.setHours(0, 0, 0, 0);
    setViewDate(next);
    setHourFilter("all");
    setGenerated(null); // filters must be re-run for the new day
  };

  const data = board.data;
  const prettyDate = viewDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const matches = (data?.matches || []).filter((m) => passHour(m.kickoff));

  if (!pass) {
    return <LockGate onUnlock={(code) => { try { localStorage.setItem(PASS_KEY, code); } catch {} setPass(code); }} />;
  }

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
        <span aria-hidden="true">🎰</span>
        <span>
          Pick one or more leagues, a time window and an <strong>odds range</strong>, then Generate.
          For every match, the engine surfaces the <strong>highest-confidence market</strong> whose
          <strong> real bookmaker odds</strong> land in your range — goals, corners, BTTS, double chance and more.
        </span>
      </div>

      {continents.length > 1 && (
        <div style={styles.contBar}>
          <button style={{ ...styles.contChip, ...(continent === "all" ? styles.contChipOn : {}) }} onClick={() => setContinent("all")}>All</button>
          {continents.map((c) => (
            <button key={c} style={{ ...styles.contChip, ...(continent === c ? styles.contChipOn : {}) }} onClick={() => setContinent(c)}>{c}</button>
          ))}
        </div>
      )}

      <div style={styles.controls}>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>Add league</span>
          <select
            style={styles.select}
            value=""
            onChange={(e) => { addLeague(e.target.value); e.target.value = ""; }}
          >
            <option value="">
              {shownLeagues.length ? "Choose a league…" : "No leagues playing this date"}
            </option>
            {shownLeagues
              .filter((l) => !picked.includes(String(l.id)))
              .map((l) => (
                <option key={l.id} value={String(l.id)}>{l.flag} {l.name}</option>
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
            title={isToday ? "Only scan matches kicking off within this window" : "Time window applies to today's matches"}
          >
            {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </label>

        {hourBuckets.length > 1 && (
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Kick-off</span>
            <select style={{ ...styles.select, minWidth: 130 }} value={hourFilter} onChange={(e) => setHourFilter(e.target.value)}>
              <option value="all">Any time</option>
              {hourBuckets.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </label>
        )}

        <label style={styles.field}>
          <span style={styles.fieldLabel}>Market</span>
          <select style={{ ...styles.select, minWidth: 150 }} value={market} onChange={(e) => setMarket(e.target.value)}>
            {MARKETS.map((mk) => <option key={mk.key} value={mk.key}>{mk.label}</option>)}
          </select>
        </label>

        <label style={styles.field}>
          <span style={styles.fieldLabel}>Odds range</span>
          <select style={{ ...styles.select, minWidth: 140 }} value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>

        <button
          style={{ ...styles.genBtn, ...(picked.length ? {} : styles.genBtnOff) }}
          disabled={!picked.length}
          onClick={onGenerate}
        >
          🎰 Generate
        </button>
      </div>

      {leagues.length > 0 && (
        <div style={styles.pickBar}>
          <div style={styles.chipsWrap}>
            {picked.length === 0 && <span style={styles.chipsHint}>No leagues selected — add one above.</span>}
            {picked.map((id) => {
              const l = leaguesById.get(String(id));
              return (
                <span key={id} style={styles.leagueChip}>
                  {l ? `${l.flag} ${l.name}` : id}
                  <button style={styles.chipX} onClick={() => removeLeague(id)} aria-label={`Remove ${l?.name || id}`}>×</button>
                </span>
              );
            })}
          </div>
          <div style={styles.pickActions}>
            <button style={styles.smallBtn} onClick={addAll}>Add all ({shownLeagues.length})</button>
            {picked.length > 0 && <button style={styles.smallBtn} onClick={clearAll}>Clear</button>}
          </div>
        </div>
      )}

      <div style={styles.board}>
        {!generated && <p style={styles.empty}>Select leagues, choose an odds range, and press Generate.</p>}
        {generated && board.isLoading && (
          <>
            <Spinner />
            <p style={styles.loadingNote}>Scanning fixtures and pricing every market against the book…</p>
          </>
        )}
        {generated && board.isError && <p style={styles.error}>{board.error.message}</p>}
        {generated && data && matches.length === 0 && (
          <p style={styles.empty}>
            No match has a market landing in {rangeObj.label} for the selected leagues and window.
            {data.scanned > 0 && <> ({data.scanned} fixtures scanned.)</>}
          </p>
        )}
        {generated && data && matches.length > 0 && (
          <div style={styles.resultHead}>
            {matches.length} {matches.length === 1 ? "match" : "matches"} with a market in <strong>{rangeObj.label}</strong>
          </div>
        )}
        {generated && data && matches.map((m) => (
          <div
            key={m.id}
            role="button"
            tabIndex={0}
            style={{ ...styles.card, ...styles.cardClickable }}
            onClick={() => openMatchLeague(m.leagueId)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMatchLeague(m.leagueId); } }}
            title="Open full predictions & analysis on the league fixtures page"
          >
            <div style={styles.cardHead}>
              <span style={styles.league}>{m.leagueFlag} {m.league}</span>
              <span style={styles.meta}>{koTime(m.kickoff)}</span>
            </div>

            <div style={styles.teams}>
              {m.home.logo && <img src={m.home.logo} alt="" width={20} height={20} style={styles.logo} onError={(e) => (e.target.style.visibility = "hidden")} />}
              <span style={styles.teamName}>{m.home.name}</span>
              <span style={styles.vs}>v</span>
              <span style={styles.teamNameR}>{m.away.name}</span>
              {m.away.logo && <img src={m.away.logo} alt="" width={20} height={20} style={styles.logo} onError={(e) => (e.target.style.visibility = "hidden")} />}
            </div>

            <div style={styles.pickRow}>
              <div style={styles.pickLeft}>
                <span style={styles.groupTag}>{m.pick.group}</span>
                <span style={styles.selection}>{m.pick.selection}</span>
              </div>
              <div style={styles.pickRight}>
                <span
                  style={{ ...styles.conf, background: tint(pctColor(m.pick.probability)), color: pctColor(m.pick.probability) }}
                  title="Model confidence"
                >
                  {m.pick.probability}%
                </span>
                <span style={styles.odds} title={`Best price — ${m.pick.bookmaker}`}>@{m.pick.bookOdds.toFixed(2)}</span>
              </div>
            </div>
            <div style={styles.bookLine}>
              <span>{m.pick.bookmaker}</span>
              {m.qualifyingMarkets > 1 && <span style={styles.altTag}>+{m.qualifyingMarkets - 1} more in range</span>}
            </div>
          </div>
        ))}
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

// Password gate. The code is checked by the server — we only unlock on its OK, so
// nothing here reveals it. On a wrong code the server 401s and we show the error.
function LockGate({ onUnlock }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (!code || busy) return;
    setBusy(true); setErr("");
    try {
      if (await verifyPass(code)) onUnlock(code);
      else setErr("Incorrect code.");
    } catch {
      setErr("Couldn't verify — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.lockWrap}>
      <form style={styles.lockCard} onSubmit={submit}>
        <div style={styles.lockIcon} aria-hidden="true">🔒</div>
        <div style={styles.lockTitle}>Odds Generator</div>
        <div style={styles.lockSub}>This tool is private. Enter the access code to continue.</div>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={code}
          onChange={(e) => { setCode(e.target.value); setErr(""); }}
          placeholder="Access code"
          style={styles.lockInput}
          aria-label="Access code"
        />
        {err && <div style={styles.lockErr}>{err}</div>}
        <button type="submit" disabled={!code || busy} style={{ ...styles.lockBtn, ...(code && !busy ? {} : styles.genBtnOff) }}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
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

  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "10px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  contBar: { display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 24px 0" },
  contChip: { fontSize: 12, fontWeight: 600, color: "var(--text2)", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 20, padding: "4px 11px", cursor: "pointer" },
  contChipOn: { background: "var(--accent)", color: "#04121f", borderColor: "var(--accent)" },
  controls: { display: "flex", gap: 12, alignItems: "flex-end", padding: "14px 24px 10px", flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  fieldLabel: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  select: { background: "var(--bg2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 14, minWidth: 200 },
  genBtn: { fontSize: 14, fontWeight: 700, color: "#04121f", background: "var(--accent)", border: "none", borderRadius: 8, padding: "9px 16px", cursor: "pointer" },
  genBtnOff: { opacity: 0.4, cursor: "not-allowed" },

  pickBar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 24px 14px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" },
  chipsWrap: { display: "flex", gap: 6, flexWrap: "wrap", flex: 1, minWidth: 0 },
  chipsHint: { fontSize: 12, color: "var(--text3)" },
  leagueChip: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: "var(--text)", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 999, padding: "4px 6px 4px 10px" },
  chipX: { fontSize: 15, lineHeight: 1, color: "var(--text3)", background: "transparent", border: "none", cursor: "pointer", padding: "0 2px" },
  pickActions: { display: "flex", gap: 8, flexShrink: 0 },
  smallBtn: { fontSize: 12, fontWeight: 600, color: "var(--text2)", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", cursor: "pointer" },

  board: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 10, maxWidth: 820, width: "100%", margin: "0 auto" },
  resultHead: { fontSize: 13, color: "var(--text3)", padding: "0 2px 2px" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  loadingNote: { color: "var(--text3)", fontSize: 12, textAlign: "center" },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 9 },
  cardClickable: { cursor: "pointer" },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  league: { fontSize: 12, color: "var(--text3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { fontSize: 12, color: "var(--text3)", flexShrink: 0 },

  teams: { display: "flex", alignItems: "center", gap: 8 },
  logo: { borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "var(--bg3)" },
  teamName: { flex: 1, fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" },
  teamNameR: { flex: 1, fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  vs: { fontSize: 11, color: "var(--text3)", flexShrink: 0 },

  pickRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: "1px solid var(--border)", paddingTop: 9 },
  pickLeft: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
  groupTag: { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text3)" },
  selection: { fontSize: 14.5, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis" },
  pickRight: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  conf: { fontSize: 14, fontWeight: 800, borderRadius: 8, padding: "5px 9px", minWidth: 46, textAlign: "center" },
  odds: { fontSize: 14, fontWeight: 800, color: "var(--text)", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 9px" },
  bookLine: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 11, color: "var(--text3)" },
  altTag: { fontSize: 10, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 5px" },

  lockWrap: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
  lockCard: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 16, padding: "28px 26px", width: "100%", maxWidth: 340 },
  lockIcon: { fontSize: 30 },
  lockTitle: { fontSize: 17, fontWeight: 700, color: "var(--text)" },
  lockSub: { fontSize: 12.5, color: "var(--text3)", lineHeight: 1.45, marginBottom: 4 },
  lockInput: { width: "100%", textAlign: "center", letterSpacing: 3, fontSize: 18, background: "var(--bg3)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" },
  lockErr: { fontSize: 12.5, color: "var(--loss)" },
  lockBtn: { width: "100%", fontSize: 14, fontWeight: 700, color: "#04121f", background: "var(--accent)", border: "none", borderRadius: 10, padding: "10px 16px", cursor: "pointer" },
};

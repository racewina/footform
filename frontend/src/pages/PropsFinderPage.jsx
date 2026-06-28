import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchFinder({ within, match, league }) {
  const params = new URLSearchParams({ tz: TZ });
  if (within && within !== "all" && match === "all") params.set("within", within);
  if (match && match !== "all") params.set("match", match);
  if (league && league !== "all" && match === "all") params.set("league", league);
  const res = await fetch(`/api/props-finder?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

const WINDOWS = [
  { key: "3", label: "Next 3 hours" },
  { key: "6", label: "Next 6 hours" },
  { key: "12", label: "Next 12 hours" },
  { key: "all", label: "All day" },
];

// "15:00" in the user's local time, for the match selector.
function koTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const STATS = [
  { key: "score", label: "Anytime scorer" },
  { key: "shots", label: "Shots" },
  { key: "shotOnTarget", label: "Shots on target" },
  { key: "foul", label: "Fouls committed" },
  { key: "fouled", label: "Fouled" },
  { key: "tackle", label: "Tackles" },
  { key: "yellow", label: "Yellow card" },
];
const THRESHOLDS = [
  { key: 1, label: "1+" },
  { key: 2, label: "2+" },
  { key: 3, label: "3+" },
];
const TOP_N = 50;

// Minimum probability to surface a pick, tuned per market. A 3+ outcome is rarer
// so it gets a lower bar; anytime-scorer and yellow-card markets are scored more
// leniently than the default 40%.
function floorFor(stat, tier) {
  if (tier === 3) return 28; // any "3+ event" — the third occurrence
  if (stat === "score") return 30; // anytime scorer
  if (stat === "yellow") return 25; // yellow card
  return 40;
}

function pctColor(p) {
  if (p >= 70) return "#2ecc71";
  if (p >= 55) return "#9acd32";
  if (p >= 40) return "#f1c40f";
  return "#e74c3c";
}
function tint(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.16)`;
}

export default function PropsFinderPage() {
  const [stat, setStat] = useState("foul");
  const [tier, setTier] = useState(2);
  const [league, setLeague] = useState("all");
  const [within, setWithin] = useState("all");
  const [match, setMatch] = useState("all");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["props-finder", within, match, league],
    queryFn: () => fetchFinder({ within, match, league }),
  });

  const players = data?.players || [];
  // Full lists of today's upcoming matches and leagues (independent of the time
  // window), so the selectors can reach any fixture/league, even outside it.
  const matches = data?.matches || [];
  const leagues = data?.leagues || [];
  const singleMatch = match !== "all";
  // Players are only fetched once a league or a single match is picked — until
  // then the page just offers the selectors (keeps the default load cheap).
  const hasSelection = league !== "all" || match !== "all";
  // Match selector is scoped to the chosen league for a tidier list.
  const matchOptions = matches.filter((m) => league === "all" || String(m.leagueId) === String(league));

  const minPct = floorFor(stat, tier);
  const ranked = players
    .filter((p) => p.tiers?.[stat])
    .map((p) => ({ ...p, val: p.tiers[stat][tier] }))
    .filter((p) => p.val >= minPct)
    .sort((a, b) => b.val - a.val)
    .slice(0, TOP_N);

  const statLabel = STATS.find((s) => s.key === stat)?.label;

  return (
    <div style={styles.page}>
      <div style={styles.controls}>
        <label style={{ ...styles.field, ...(singleMatch ? styles.fieldDisabled : {}) }}>
          <span style={styles.fieldLabel}>League</span>
          <select
            style={styles.select}
            value={league}
            disabled={singleMatch}
            title={singleMatch ? "Showing a single match — clear it to filter by league" : undefined}
            onChange={(e) => { setLeague(e.target.value); setMatch("all"); }}
          >
            <option value="all">All leagues</option>
            {leagues.map((l) => <option key={l.id} value={l.id}>{l.flag} {l.name}</option>)}
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>Match</span>
          <select style={styles.select} value={match} onChange={(e) => setMatch(e.target.value)}>
            <option value="all">All matches</option>
            {matchOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.leagueFlag} {m.home} v {m.away}{koTime(m.kickoff) ? ` · ${koTime(m.kickoff)}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...styles.field, ...(singleMatch ? styles.fieldDisabled : {}) }}>
          <span style={styles.fieldLabel}>Starting within</span>
          <select
            style={styles.select}
            value={within}
            disabled={singleMatch}
            title={singleMatch ? "Showing a single match — clear it to use the time window" : undefined}
            onChange={(e) => setWithin(e.target.value)}
          >
            {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>Market</span>
          <select style={styles.select} value={stat} onChange={(e) => setStat(e.target.value)}>
            {STATS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>Threshold</span>
          <select style={styles.select} value={tier} onChange={(e) => setTier(Number(e.target.value))}>
            {THRESHOLDS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
      </div>

      <div style={styles.note}>
        <span aria-hidden="true">🔎</span>
        <span>
          {!hasSelection
            ? "Pick a league or a match above to find players likely to commit an event."
            : <>
                {singleMatch
                  ? "Players in the selected match"
                  : within === "all"
                    ? "Players in the selected league"
                    : `Players in the selected league kicking off within ${within}h`}{" "}
                ranked by their chance of{" "}
                <strong>{THRESHOLDS.find((t) => t.key === tier)?.label} {statLabel.toLowerCase()}</strong>.
                Percentages are model estimates from each player's season rates (Poisson),
                updated to the official XI once lineups drop. {stat === "foul" && "⚔️ marks a wide defender the positional model flags against a dribbling winger. "}
                Not betting advice.
              </>}
        </span>
      </div>

      <div style={styles.list}>
        {!hasSelection && (
          <p style={styles.empty}>Select a league or a match above to load players.</p>
        )}
        {hasSelection && isLoading && <Spinner />}
        {hasSelection && isError && <p style={styles.error}>{error.message}</p>}
        {hasSelection && !isLoading && !isError && ranked.length === 0 && (
          <p style={styles.empty}>No players reach {minPct}% for this market & threshold.</p>
        )}
        {hasSelection && !isLoading && !isError && ranked.map((p, i) => {
          const color = pctColor(p.val);
          const showMatchup = stat === "foul" && p.foulMatchup;
          return (
            <div key={`${p.id}-${p.matchId}`} style={styles.row}>
              <span style={styles.rank}>{i + 1}</span>
              {p.photo
                ? <img src={p.photo} alt="" width={34} height={34} style={styles.avatar} onError={(e) => (e.target.style.visibility = "hidden")} />
                : <span style={styles.avatar} />}
              <div style={styles.who}>
                <div style={styles.nameLine}>
                  <span style={styles.name}>{p.name}</span>
                  {p.pos && <span style={styles.pos}>{p.pos}</span>}
                  {showMatchup && <span style={styles.matchup} title={`Facing ${p.foulMatchup.opponent} (${p.foulMatchup.opponentDribbles90} dribbles/90)`}>⚔️</span>}
                </div>
                <span style={styles.meta}>
                  {p.team} · {p.leagueFlag} {p.home} v {p.away}
                </span>
              </div>
              <span style={{ ...styles.val, background: tint(color), color }}>{p.val}%</span>
            </div>
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
  controls: { display: "flex", gap: 12, padding: "14px 24px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  fieldDisabled: { opacity: 0.45 },
  fieldLabel: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  select: { background: "var(--bg2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 14, minWidth: 160 },
  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "10px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  list: { flex: 1, overflowY: "auto", padding: "12px 24px", display: "flex", flexDirection: "column", gap: 6, maxWidth: 820, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  row: { display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10 },
  rank: { fontSize: 13, fontWeight: 700, color: "var(--text3)", width: 22, textAlign: "center", flexShrink: 0 },
  avatar: { width: 34, height: 34, borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "var(--bg3)" },
  who: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  nameLine: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  name: { fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  pos: { fontSize: 9, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px", flexShrink: 0 },
  matchup: { fontSize: 12, flexShrink: 0 },
  meta: { fontSize: 11, color: "var(--text3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  val: { fontSize: 15, fontWeight: 700, borderRadius: 7, padding: "5px 10px", minWidth: 52, textAlign: "center", flexShrink: 0 },
};

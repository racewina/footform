import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getToolPass, clearToolPass } from "../components/ToolGate";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function ymd(d) {
  const dt = d instanceof Date ? d : new Date();
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}
function koTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// The day's upcoming matches + leagues, reused as the selector source (returns
// only the selector lists until a league/match is chosen — cheap).
async function fetchSelectors(dateStr) {
  const res = await fetch(`/api/props-finder?date=${dateStr}&tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) throw new Error(`Failed to load matches (${res.status})`);
  return res.json();
}

// The whole event board for one match: outcome + corners + player tiers.
async function fetchBoard({ matchId, leagueId, dateStr }) {
  const res = await fetch(
    `/api/match/${matchId}/event-board?league=${leagueId}&date=${dateStr}&tz=${encodeURIComponent(TZ)}`,
    { headers: { "x-odds-pass": getToolPass() } }
  );
  if (res.status === 401) { clearToolPass(); throw new Error("This tool is private."); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

// Player-event markets shown on the board. `rankTier` is the tier we sort each
// panel by (2+ separates the volume markets better than 1+, which saturates);
// `tiers` are the thresholds each row displays. `gkOnly` self-filters via the
// saves rate (only keepers have one). `markDef` flags overlapping defenders in
// the shot lists — the ones the user specifically wants surfaced.
const PLAYER_MARKETS = [
  { key: "score", label: "To score", icon: "⚽", rankTier: 1, tiers: [1, 2], topN: 6 },
  { key: "scoreOrAssist", label: "To score or assist", icon: "🅰️", rankTier: 1, tiers: [1, 2], topN: 6 },
  { key: "shotOnTarget", label: "Shot on target", icon: "🎯", rankTier: 1, tiers: [1, 2], topN: 6, note: "adj. for opponent" },
  { key: "shots", label: "Shots", icon: "👟", rankTier: 2, tiers: [1, 2, 3], topN: 6, markDef: true, note: "adj. for opponent" },
  { key: "foul", label: "To commit a foul", icon: "⚔️", rankTier: 2, tiers: [1, 2], topN: 6 },
  { key: "fouled", label: "To be fouled", icon: "🤕", rankTier: 2, tiers: [1, 2], topN: 6 },
  { key: "tackle", label: "Tackles", icon: "🛡️", rankTier: 2, tiers: [1, 2, 3], topN: 6 },
  { key: "saves", label: "Goalkeeper saves", icon: "🧤", rankTier: 2, tiers: [2, 3], topN: 2, note: "adj. for opponent shots" },
];

function pctColor(p) {
  if (p >= 70) return "#2ecc71";
  if (p >= 55) return "#9acd32";
  if (p >= 40) return "#f1c40f";
  if (p >= 25) return "#e67e22";
  return "#e74c3c";
}
function tint(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.16)`;
}

export default function EventGeneratorPage({ date }) {
  const dateStr = ymd(date);
  const [league, setLeague] = useState("all");
  const [match, setMatch] = useState("");
  // The match the board is built for — set only when Generate is clicked, so
  // changing the dropdowns doesn't fire the (heavier) board build until asked.
  const [generated, setGenerated] = useState(null);

  const { data: sel } = useQuery({
    queryKey: ["event-selectors", dateStr],
    queryFn: () => fetchSelectors(dateStr),
  });
  const matches = sel?.matches || [];
  const leagues = sel?.leagues || [];
  const matchOptions = matches.filter((m) => league === "all" || String(m.leagueId) === String(league));

  const board = useQuery({
    queryKey: ["event-board", generated?.matchId, dateStr],
    queryFn: () => fetchBoard(generated),
    enabled: !!generated,
    // A board built off a projected / last-match XI must flip to the CONFIRMED
    // lineup once it's posted (~1h before kickoff) — otherwise a rotated-out player
    // (benched star) keeps showing. So while the board isn't on the official XI and
    // we're in the pre-kickoff window when it can drop, poll every 3 min; stop once
    // it's official or the match has started. Also refetch when the tab regains
    // focus (overrides the app-wide refetchOnWindowFocus:false).
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d?.match || d.players?.source === "official") return false;
      const ko = d.match.kickoff ? d.match.kickoff * 1000 : null;
      if (!ko) return false;
      const mins = (ko - Date.now()) / 60000;
      return mins > 0 && mins <= 150 ? 3 * 60 * 1000 : false;
    },
  });

  const canGenerate = !!match;
  const onGenerate = () => {
    const m = matches.find((x) => String(x.id) === String(match));
    if (!m) return;
    setGenerated({ matchId: m.id, leagueId: m.leagueId, dateStr });
  };

  const data = board.data;
  // Merge both squads into one ranked pool per market (side tag kept for the dot).
  const pool = useMemo(() => {
    if (!data?.players?.available) return [];
    const tag = (rows, side, teamName) => (rows || []).map((r) => ({ ...r, side, teamName }));
    return [
      ...tag(data.players.home?.rows, "home", data.players.home?.teamName),
      ...tag(data.players.away?.rows, "away", data.players.away?.teamName),
    ];
  }, [data]);

  return (
    <div style={styles.page}>
      <div style={styles.controls}>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>League</span>
          <select
            style={styles.select}
            value={league}
            onChange={(e) => { setLeague(e.target.value); setMatch(""); }}
          >
            <option value="all">All leagues</option>
            {leagues.map((l) => <option key={l.id} value={l.id}>{l.flag} {l.name}</option>)}
          </select>
        </label>
        <label style={styles.field}>
          <span style={styles.fieldLabel}>Match</span>
          <select style={styles.select} value={match} onChange={(e) => setMatch(e.target.value)}>
            <option value="">Select a match…</option>
            {matchOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.leagueFlag} {m.home} v {m.away}{koTime(m.kickoff) ? ` · ${koTime(m.kickoff)}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          style={{ ...styles.genBtn, ...(canGenerate ? {} : styles.genBtnDisabled) }}
          disabled={!canGenerate}
          onClick={onGenerate}
        >
          ⚡ Generate
        </button>
      </div>

      <div style={styles.note}>
        <span aria-hidden="true">⚡</span>
        <span>
          Pick a match and hit <strong>Generate</strong> to project what&apos;s likely to happen —
          winner, goals &amp; corners, and each starter&apos;s chance of scoring, assisting, shooting,
          fouling, being fouled, tackling or (keepers) saving, at 1+/2+/3+. Shot and save lines are
          adjusted for the opponent; where the market prices a matching bet we show it
          (<strong style={{ color: "#2ecc71" }}>▲</strong>/<strong style={{ color: "#e74c3c" }}>▼</strong> = our
          model above/below the book). A projection to explore, not a guaranteed edge — sharper once
          lineups drop. Not betting advice.
        </span>
      </div>

      <div style={styles.board}>
        {!generated && <p style={styles.empty}>Select a match above and press Generate.</p>}
        {generated && board.isLoading && <Spinner />}
        {generated && board.isError && <p style={styles.error}>{board.error.message}</p>}
        {generated && data && (
          <>
            <MatchHead match={data.match} source={data.players?.source} />
            <OutcomePanel outcome={data.outcome} match={data.match} />
            <CornersPanel corners={data.corners} match={data.match} />
            <SameGameCombos data={data} pool={pool} />
            {data.players?.available ? (
              <div style={styles.grid}>
                {PLAYER_MARKETS.map((mk) => (
                  <MarketPanel key={mk.key} market={mk} pool={pool} wide={mk.tiers.length > 2} />
                ))}
              </div>
            ) : (
              <p style={styles.subempty}>
                {data.players?.reason || "Player-level projections aren't available for this match yet."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const LINEUP_TAG = {
  last: { label: "Last lineup", title: "Based on each team's most recent starting XI — updates automatically when the official lineup is posted" },
  projected: { label: "Projected XI", title: "Based on a projected XI — updates automatically when the official lineup is posted" },
};

function MatchHead({ match, source }) {
  const tag = LINEUP_TAG[source]; // no tag once it's the official lineup
  return (
    <div style={styles.head}>
      <div style={styles.headTeams}>
        {match.homeLogo && <img src={match.homeLogo} alt="" width={26} height={26} style={styles.logo} onError={(e) => (e.target.style.visibility = "hidden")} />}
        <span style={styles.headName}>{match.home}</span>
        <span style={styles.headV}>v</span>
        <span style={styles.headName}>{match.away}</span>
        {match.awayLogo && <img src={match.awayLogo} alt="" width={26} height={26} style={styles.logo} onError={(e) => (e.target.style.visibility = "hidden")} />}
      </div>
      <div style={styles.headMeta}>
        {match.league}{match.kickoff ? ` · ${koTime(match.kickoff)}` : ""}
        {tag && <span style={styles.projTag} title={tag.title}>{tag.label}</span>}
      </div>
    </div>
  );
}

// Edge vs the de-vigged bookmaker line. ≥+4 = we're notably more bullish (value),
// ≤−4 = market is higher. Small gaps are noise, shown grey.
const EDGE_MIN = 4;
function EdgeTag({ model, book }) {
  if (book == null) return null;
  const edge = model - book;
  const strong = edge >= EDGE_MIN, weak = edge <= -EDGE_MIN;
  const color = strong ? "#2ecc71" : weak ? "#e74c3c" : "var(--text3)";
  return (
    <span style={styles.edgeTag} title="Bookmaker probability with the margin removed">
      book {book}%
      {(strong || weak) && (
        <span style={{ color, marginLeft: 4, fontWeight: 700 }}>
          {strong ? "▲" : "▼"} {edge > 0 ? "+" : ""}{edge}
        </span>
      )}
    </span>
  );
}

function Chip({ label, val, book }) {
  const c = pctColor(val);
  return (
    <div style={styles.chip}>
      <span style={styles.chipLabel}>{label}</span>
      <span style={{ ...styles.chipVal, background: tint(c), color: c }}>{val}%</span>
      {book != null && <EdgeTag model={val} book={book} />}
    </div>
  );
}

function OutcomePanel({ outcome, match }) {
  if (!outcome) return null;
  const favName = outcome.winner === "home" ? match.home : match.away;
  const b = outcome.book || {};
  return (
    <section style={styles.panel}>
      <h3 style={styles.panelTitle}><span>🏆</span> Match outcome</h3>
      <p style={styles.lead}>
        Most likely: <strong>{favName} to win</strong> ({outcome.win}%)
        {outcome.book && <span style={styles.leadNote}> · ▲ / ▼ mark where our model differs from the market</span>}
      </p>
      <div style={styles.winBars}>
        <WinBar label={match.home} val={outcome.home} book={b.home} fav={outcome.winner === "home"} />
        <WinBar label="Draw" val={outcome.draw} book={b.draw} fav={false} />
        <WinBar label={match.away} val={outcome.away} book={b.away} fav={outcome.winner === "away"} />
      </div>
      <div style={styles.chipWrap}>
        <Chip label={`${match.home} to score`} val={outcome.home1Plus} book={b.home1Plus} />
        <Chip label={`${match.away} to score`} val={outcome.away1Plus} book={b.away1Plus} />
        <Chip label={`${match.home} 2+ goals`} val={outcome.home2Plus} book={b.home2Plus} />
        <Chip label={`${match.away} 2+ goals`} val={outcome.away2Plus} book={b.away2Plus} />
        <Chip label="Over 2.5 goals" val={outcome.over25} book={b.over25} />
        <Chip label="Both teams score" val={outcome.btts} book={b.btts} />
      </div>
    </section>
  );
}

function WinBar({ label, val, book, fav }) {
  const edge = book != null ? val - book : null;
  const flag = edge >= EDGE_MIN ? "▲" : edge <= -EDGE_MIN ? "▼" : "";
  const flagColor = edge >= EDGE_MIN ? "#2ecc71" : "#e74c3c";
  return (
    <div style={styles.winRow}>
      <span style={{ ...styles.winLabel, ...(fav ? { color: "var(--text)", fontWeight: 700 } : {}) }}>{label}</span>
      <div style={styles.winTrack}>
        <div style={{ ...styles.winFill, width: `${val}%`, background: fav ? "var(--accent)" : "var(--bg3)" }} />
        {book != null && <span style={{ ...styles.winBookTick, left: `${book}%` }} title={`Market: ${book}%`} />}
      </div>
      <span style={styles.winPct}>
        {val}%{flag && <span style={{ color: flagColor, marginLeft: 3 }}>{flag}</span>}
      </span>
    </div>
  );
}

function ConfidenceDot({ level }) {
  const map = { high: "#2ecc71", medium: "#f1c40f", low: "#e67e22" };
  return (
    <span
      style={{ ...styles.confDot, background: map[level] || "var(--text3)" }}
      title={`Sample confidence: ${level || "unknown"}`}
    />
  );
}

function CornersPanel({ corners, match }) {
  const p = corners?.prediction;
  return (
    <section style={styles.panel}>
      <h3 style={styles.panelTitle}>
        <span>🚩</span> First-half corners
        {corners?.available && p && <ConfidenceDot level={p.confidence} />}
      </h3>
      {corners?.available && p ? (
        <>
          <p style={styles.lead}>~{p.firstHalfTotal} first-half corners projected between the sides.</p>
          <div style={styles.chipWrap}>
            <Chip label={`${match.home} 2+`} val={p.home.fh2Plus} />
            <Chip label={`${match.home} 3+`} val={p.home.fh3Plus} />
            <Chip label={`${match.away} 2+`} val={p.away.fh2Plus} />
            <Chip label={`${match.away} 3+`} val={p.away.fh3Plus} />
          </div>
        </>
      ) : (
        <p style={styles.subempty}>Not enough recent corner history for these teams.</p>
      )}
    </section>
  );
}

// ---- Same-game picks ---------------------------------------------------------
// Rather than one combo, the board offers up to three, each a different risk
// tier: a Safer two-legger, a Balanced spread across the match, and an Ambitious
// reach for returns. Every combined number is a plain independence product (the
// legs aren't truly independent), so it's shown as a rough guide, not a price.

const productPct = (legs) => Math.round(legs.reduce((acc, l) => acc * (l.p / 100), 1) * 100);

// Candidate legs drawn once from the board, then dealt out to the three picks.
function teamCandidates({ match, outcome }) {
  if (!outcome) return [];
  return [
    { key: "win", label: `${outcome.winner === "home" ? match.home : match.away} to win`, p: outcome.win },
    { key: "home1", label: `${match.home} to score`, p: outcome.home1Plus },
    { key: "away1", label: `${match.away} to score`, p: outcome.away1Plus },
    { key: "btts", label: "Both teams to score", p: outcome.btts },
    { key: "over25", label: "Over 2.5 goals", p: outcome.over25 },
    { key: "home2", label: `${match.home} 2+ goals`, p: outcome.home2Plus },
    { key: "away2", label: `${match.away} 2+ goals`, p: outcome.away2Plus },
  ].filter((c) => typeof c.p === "number" && c.p > 0);
}

function playerCandidates(pool) {
  const atk = pool.flatMap((p) => [
    { label: `${p.name} 1+ shot on target`, p: p.tiers.shotOnTarget?.[1] || 0, id: p.id },
    { label: `${p.name} to score or assist`, p: p.tiers.scoreOrAssist?.[1] || 0, id: p.id },
  ]);
  const scorer = pool.map((p) => ({ label: `${p.name} to score`, p: p.tiers.score?.[1] || 0, id: p.id }));
  const shots2 = pool.map((p) => ({ label: `${p.name} 2+ shots`, p: p.tiers.shots?.[2] || 0, id: p.id }));
  const def = pool.flatMap((p) => [
    { label: `${p.name} 1+ tackle`, p: p.tiers.tackle?.[1] || 0, id: p.id },
    { label: `${p.name} 1+ foul`, p: p.tiers.foul?.[1] || 0, id: p.id },
  ]);
  return { atk, scorer, shots2, def };
}

function cornerCandidates({ match, corners }) {
  if (!corners?.available || !corners.prediction) return [];
  const cp = corners.prediction;
  const pickSide = (field) => {
    const h = cp.home?.[field] || 0, a = cp.away?.[field] || 0;
    return h >= a ? { team: match.home, p: h } : { team: match.away, p: a };
  };
  const out = [];
  const s2 = pickSide("fh2Plus");
  if (s2.p > 0) out.push({ key: "corner2", label: `${s2.team} 2+ first-half corners`, p: s2.p });
  const s3 = pickSide("fh3Plus");
  if (s3.p > 0) out.push({ key: "corner3", label: `${s3.team} 3+ first-half corners`, p: s3.p });
  return out;
}

// Best candidate clearing a floor that reuses neither a player nor a team market
// already spent on this pick.
function takeBest(cands, floor, usedIds, usedKeys) {
  return cands
    .filter((c) => c.p >= floor)
    .filter((c) => (c.id == null || !usedIds.has(c.id)) && (c.key == null || !usedKeys.has(c.key)))
    .sort((a, b) => b.p - a.p)[0];
}

function buildCombos(data, pool) {
  const teams = teamCandidates(data);
  const { atk, scorer, shots2, def } = playerCandidates(pool);
  const corners = cornerCandidates(data);
  const drafts = [];

  // 1) Safer — two of the highest-confidence legs on the board.
  {
    const legs = [], ids = new Set(), keys = new Set();
    const t = takeBest(teams, 58, ids, keys); if (t) { legs.push(t); keys.add(t.key); }
    const a = takeBest(atk, 65, ids, keys) || takeBest(def, 68, ids, keys);
    if (a) { legs.push(a); ids.add(a.id); }
    if (legs.length >= 2) drafts.push({ name: "Safer", tag: "two strong legs", legs });
  }

  // 2) Balanced — a team lead, an attacker, a different defender, a corner.
  {
    const legs = [], ids = new Set(), keys = new Set();
    const t = takeBest(teams, 55, ids, keys); if (t) { legs.push(t); keys.add(t.key); }
    const a = takeBest(atk, 55, ids, keys); if (a) { legs.push(a); ids.add(a.id); }
    const d = takeBest(def, 60, ids, keys); if (d) { legs.push(d); ids.add(d.id); }
    const c = takeBest(corners.filter((x) => x.key === "corner2"), 62, ids, keys);
    if (c && legs.length < 4) legs.push(c);
    if (legs.length >= 2) drafts.push({ name: "Balanced", tag: "spread across the match", legs });
  }

  // 3) Ambitious — reach for returns: a scorer, extra shots, more goals/corners.
  {
    const legs = [], ids = new Set(), keys = new Set();
    const s = takeBest(scorer, 45, ids, keys); if (s) { legs.push(s); ids.add(s.id); }
    const sh = takeBest(shots2, 50, ids, keys); if (sh) { legs.push(sh); ids.add(sh.id); }
    const g = takeBest(teams.filter((x) => ["over25", "home2", "away2"].includes(x.key)), 45, ids, keys);
    if (g) { legs.push(g); keys.add(g.key); }
    const c = takeBest(corners, 55, ids, keys);
    if (c && legs.length < 4) legs.push(c);
    if (legs.length >= 2) drafts.push({ name: "Ambitious", tag: "higher risk, higher reward", legs });
  }

  // Drop only exact duplicates (a thin board can make two tiers land on the
  // identical leg-set); a leaner pick that's a subset of a richer one is still a
  // distinct risk tier worth showing. Cap at three.
  const seen = new Set();
  const kept = [];
  for (const d of drafts) {
    const sig = d.legs.map((l) => l.label).sort().join("|");
    if (seen.has(sig)) continue;
    seen.add(sig);
    kept.push({ ...d, combined: productPct(d.legs) });
  }
  return kept.slice(0, 3);
}

function SameGameCombos({ data, pool }) {
  const combos = useMemo(() => buildCombos(data, pool), [data, pool]);
  if (!combos.length) return null;
  return (
    <section style={{ ...styles.panel, ...styles.comboPanel }}>
      <h3 style={styles.panelTitle}>
        <span>🎲</span> Suggested same-game picks
        <span style={styles.comboCount}>{combos.length}</span>
      </h3>
      <div style={styles.comboList}>
        {combos.map((combo, ci) => (
          <div key={ci} style={styles.comboCard}>
            <div style={styles.comboCardHead}>
              <span style={styles.comboName}>{combo.name}</span>
              <span style={styles.comboTag}>{combo.tag}</span>
              <span style={styles.comboCombined}>~{combo.combined}%</span>
            </div>
            <div style={styles.comboLegs}>
              {combo.legs.map((l, i) => (
                <div key={i} style={styles.comboLeg}>
                  <span style={styles.comboCheck}>✓</span>
                  <span style={styles.comboLegLabel}>{l.label}</span>
                  <span style={styles.comboLegPct}>{l.p}%</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p style={styles.comboNote}>
        Each pick&apos;s legs overlap as little as possible, but they aren&apos;t truly independent — treat the
        combined number as a guide, not a price. Not betting advice.
      </p>
    </section>
  );
}

function MarketPanel({ market, pool, wide }) {
  const ranked = pool
    .filter((p) => p.tiers?.[market.key] && p.tiers[market.key][market.rankTier] > 0)
    .sort((a, b) => b.tiers[market.key][market.rankTier] - a.tiers[market.key][market.rankTier])
    .slice(0, market.topN);

  return (
    <section style={{ ...styles.panel, ...(wide ? { gridColumn: "1 / -1" } : {}) }}>
      <h3 style={styles.panelTitle}>
        <span>{market.icon}</span> {market.label}
        {market.note && <span style={styles.panelNote}>· {market.note}</span>}
      </h3>
      {ranked.length === 0 ? (
        <p style={styles.subempty}>No qualifying players.</p>
      ) : (
        <div style={styles.rows}>
          {ranked.map((p) => (
            <div key={p.id} style={styles.row}>
              <span style={{ ...styles.dot, background: p.side === "home" ? "var(--accent)" : "var(--text3)" }} title={p.teamName} />
              <div style={styles.who}>
                <div style={styles.nameLine}>
                  <span style={styles.name}>{p.name}</span>
                  {p.pos && <span style={styles.pos}>{abbrevPos(p.pos)}</span>}
                  {market.markDef && p.pos === "Defender" && (
                    <span style={styles.overlap} title="Overlapping defender — notable shot threat">↗</span>
                  )}
                </div>
              </div>
              <div style={styles.tierChips}>
                {market.tiers.map((t) => {
                  const v = p.tiers[market.key][t];
                  const c = pctColor(v);
                  return (
                    <span key={t} style={{ ...styles.tierChip, background: tint(c), color: c }}>
                      <b>{t}+</b> {v}%
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function abbrevPos(pos) {
  return { Goalkeeper: "GK", Defender: "DEF", Midfielder: "MID", Attacker: "ATT" }[pos] || pos;
}

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 30 }}>
      <div style={{ width: 30, height: 30, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
    </div>
  );
}

const styles = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  controls: { display: "flex", gap: 12, padding: "14px 24px", borderBottom: "1px solid var(--border)", flexWrap: "wrap", alignItems: "flex-end" },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  fieldLabel: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },
  select: { background: "var(--bg2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 14, minWidth: 220 },
  genBtn: { background: "var(--accent)", color: "#fff", border: "none", borderRadius: 8, padding: "9px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" },
  genBtnDisabled: { opacity: 0.4, cursor: "not-allowed" },
  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "10px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  board: { flex: 1, overflowY: "auto", padding: "16px 24px", maxWidth: 960, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  subempty: { color: "var(--text3)", fontSize: 12, padding: "6px 2px" },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  head: { display: "flex", flexDirection: "column", gap: 4, alignItems: "center", marginBottom: 14 },
  headTeams: { display: "flex", alignItems: "center", gap: 10 },
  logo: { objectFit: "contain", flexShrink: 0 },
  headName: { fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, color: "var(--text)" },
  headV: { fontSize: 13, color: "var(--text3)" },
  headMeta: { fontSize: 12, color: "var(--text3)", display: "flex", alignItems: "center", gap: 8 },
  projTag: { fontSize: 10, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px" },

  panel: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px", marginBottom: 14 },
  comboPanel: { border: "1px solid var(--accent)", background: "color-mix(in srgb, var(--accent) 7%, var(--bg2))" },
  comboCount: { fontSize: 11, fontWeight: 700, color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 18%, transparent)", borderRadius: 10, padding: "1px 7px", marginLeft: 2 },
  comboList: { display: "flex", flexDirection: "column", gap: 10 },
  comboCard: { border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", background: "color-mix(in srgb, var(--bg) 40%, var(--bg2))" },
  comboCardHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid var(--border)" },
  comboName: { fontSize: 13, fontWeight: 800, color: "var(--accent)", flexShrink: 0 },
  comboTag: { flex: 1, fontSize: 11, color: "var(--text3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  comboLegs: { display: "flex", flexDirection: "column", gap: 6 },
  comboLeg: { display: "flex", alignItems: "center", gap: 8 },
  comboCheck: { color: "var(--accent)", fontWeight: 800, fontSize: 13, flexShrink: 0 },
  comboLegLabel: { flex: 1, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  comboLegPct: { fontSize: 12, fontWeight: 700, color: "var(--text2)", flexShrink: 0 },
  comboCombined: { fontSize: 16, fontWeight: 800, color: "var(--accent)", flexShrink: 0 },
  comboNote: { fontSize: 10.5, color: "var(--text3)", margin: "10px 0 0", lineHeight: 1.4 },
  panelTitle: { display: "flex", alignItems: "center", gap: 7, fontSize: 14, fontWeight: 700, color: "var(--text)", margin: "0 0 10px" },
  panelNote: { fontSize: 10, fontWeight: 400, color: "var(--text3)" },
  confDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  lead: { fontSize: 13, color: "var(--text2)", margin: "0 0 10px" },
  chipWrap: { display: "flex", flexWrap: "wrap", gap: 8 },
  chip: { display: "flex", flexDirection: "column", gap: 3, background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px", minWidth: 96 },
  chipLabel: { fontSize: 10.5, color: "var(--text3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 150 },
  chipVal: { fontSize: 15, fontWeight: 700, borderRadius: 6, padding: "2px 8px", alignSelf: "flex-start", textAlign: "center" },
  edgeTag: { fontSize: 9.5, color: "var(--text3)", marginTop: 3, whiteSpace: "nowrap" },
  leadNote: { color: "var(--text3)", fontWeight: 400, fontSize: 11 },

  winBars: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 },
  winRow: { display: "flex", alignItems: "center", gap: 10 },
  winLabel: { fontSize: 12, color: "var(--text2)", width: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 },
  winTrack: { position: "relative", flex: 1, height: 8, background: "var(--bg3)", borderRadius: 4, overflow: "hidden" },
  winFill: { height: "100%", borderRadius: 4 },
  winBookTick: { position: "absolute", top: 0, height: "100%", width: 2, background: "var(--text)", opacity: 0.65 },
  winPct: { fontSize: 12, fontWeight: 700, color: "var(--text2)", width: 52, textAlign: "right", flexShrink: 0 },

  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14, alignItems: "start" },
  rows: { display: "flex", flexDirection: "column", gap: 5 },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", borderBottom: "1px solid var(--border)" },
  dot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  who: { flex: 1, minWidth: 0 },
  nameLine: { display: "flex", alignItems: "center", gap: 5, minWidth: 0 },
  name: { fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  pos: { fontSize: 8.5, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px", flexShrink: 0 },
  overlap: { fontSize: 12, color: "var(--accent)", flexShrink: 0 },
  tierChips: { display: "flex", gap: 4, flexShrink: 0 },
  tierChip: { fontSize: 10.5, fontWeight: 600, borderRadius: 6, padding: "2px 5px", whiteSpace: "nowrap" },
};

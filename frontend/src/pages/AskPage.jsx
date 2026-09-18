import { useState, useRef, useEffect } from "react";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const EXAMPLES = [
  "Top Europe teams for over 2.5 and BTTS",
  "Double chance safe picks in Europe tomorrow",
  "Premier League teams to score 2+",
  "South America over 1.5 above 70%",
];

async function ask(query) {
  const res = await fetch(`/api/ask?q=${encodeURIComponent(query)}&tz=${encodeURIComponent(TZ)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
  return body;
}

function koLabel(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

export default function AskPage() {
  const [input, setInput] = useState("");
  const [thread, setThread] = useState([]); // { q, res?, error?, loading }
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [thread, busy]);

  const send = async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const idx = thread.length;
    setThread((t) => [...t, { q, loading: true }]);
    try {
      const res = await ask(q);
      setThread((t) => t.map((m, i) => (i === idx ? { q, res } : m)));
    } catch (e) {
      setThread((t) => t.map((m, i) => (i === idx ? { q, error: e.message } : m)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.note}>
        <span aria-hidden="true">💬</span>
        <span>
          Ask in plain English and I'll run your <strong>own prediction model</strong> over real fixtures —
          markets (over 1.5/2.5, BTTS, to win, double chance, team to score / 2+), a scope
          (top Europe, a continent, or a named league), and filters (a % bar, odds range, today/tomorrow).
          e.g. <em>“top Europe teams for over 2.5 and BTTS above 60%”</em>.
        </span>
      </div>

      <div style={styles.thread}>
        {thread.length === 0 && (
          <div style={styles.empty}>
            <div style={styles.emptyTitle}>Try a query</div>
            <div style={styles.chips}>
              {EXAMPLES.map((e) => (
                <button key={e} style={styles.chip} onClick={() => send(e)}>{e}</button>
              ))}
            </div>
          </div>
        )}
        {thread.map((m, i) => (
          <div key={i} style={styles.exchange}>
            <div style={styles.userRow}><div style={styles.userBubble}>{m.q}</div></div>
            {m.loading && <div style={styles.botNote}><Spinner /> Running the model across the fixtures…</div>}
            {m.error && <div style={styles.errNote}>{m.error}</div>}
            {m.res && <Answer res={m.res} />}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form style={styles.inputBar} onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about today or tomorrow's fixtures…"
          disabled={busy}
          autoFocus
        />
        <button type="submit" style={{ ...styles.sendBtn, ...(busy || !input.trim() ? styles.sendOff : {}) }} disabled={busy || !input.trim()}>Ask</button>
      </form>
    </div>
  );
}

function Answer({ res }) {
  const { matches = [], count, marketLabels = [], params = {}, note, leaguesScanned, date } = res;
  const scopeLabel = params.scope === "top-europe" ? "top Europe"
    : params.scope === "league" ? params.leagueName
    : params.scope === "all" ? "all leagues"
    : (params.scope || "").replace("-", " ");
  const filters = [];
  if (params.minProb) filters.push(`≥ ${params.minProb}%`);
  if (params.oddsMin != null || params.oddsMax != null) filters.push(`odds ${params.oddsMin ?? "–"}–${params.oddsMax ?? "–"}`);
  if (params.within && params.within !== "all") filters.push(`next ${params.within}h`);

  if (note) return <div style={styles.botNote}>{note}</div>;

  return (
    <div style={styles.answer}>
      <div style={styles.interp}>
        <strong>{marketLabels.join(" + ") || "picks"}</strong> · {scopeLabel} · {date}
        {filters.length > 0 && <> · {filters.join(" · ")}</>}
        <span style={styles.count}>{count} match{count === 1 ? "" : "es"}</span>
      </div>
      {count === 0 && (
        <div style={styles.botNote}>
          Nothing clears that bar {leaguesScanned === 0 ? "— no upcoming fixtures for that scope right now (try “tomorrow”)." : "for the fixtures scanned. Loosen the % or try a wider scope / tomorrow."}
        </div>
      )}
      {matches.map((mt) => (
        <div key={mt.matchId} style={styles.card}>
          <div style={styles.cardHead}>
            <span style={styles.teams}>{mt.home} v {mt.away}</span>
            <span style={styles.score}>{mt.score}%</span>
          </div>
          <div style={styles.meta}>{mt.leagueFlag} {mt.league} · {koLabel(mt.kickoff)}{mt.status && mt.status !== "notstarted" ? " · ● live" : ""}</div>
          <div style={styles.legs}>
            {Object.entries(mt.markets).map(([k, v]) => (
              <span key={k} style={styles.leg}>
                <span style={styles.legSel}>{v.selection}</span>
                <span style={{ ...styles.legProb, color: probColor(v.prob) }}>{v.prob}%</span>
                {v.odds != null && <span style={styles.legOdds}>@{v.odds.toFixed(2)}</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function probColor(p) {
  if (p >= 75) return "#2ecc71";
  if (p >= 65) return "#9acd32";
  if (p >= 55) return "#f1c40f";
  return "#e78d3c";
}

function Spinner() {
  return <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite", verticalAlign: "middle", marginRight: 6 }} />;
}

const styles = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "10px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  thread: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 860, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: "30px 0", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" },
  emptyTitle: { fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5 },
  chips: { display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" },
  chip: { fontSize: 13, color: "var(--text)", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 999, padding: "7px 14px", cursor: "pointer" },

  exchange: { display: "flex", flexDirection: "column", gap: 8 },
  userRow: { display: "flex", justifyContent: "flex-end" },
  userBubble: { background: "var(--accent)", color: "#04121f", fontWeight: 600, fontSize: 14, borderRadius: "14px 14px 4px 14px", padding: "8px 14px", maxWidth: "80%" },
  botNote: { fontSize: 13, color: "var(--text3)", padding: "2px 2px" },
  errNote: { fontSize: 13, color: "var(--loss)" },

  answer: { display: "flex", flexDirection: "column", gap: 10 },
  interp: { fontSize: 12, color: "var(--text3)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  count: { marginLeft: "auto", color: "var(--text2)", background: "var(--bg3)", borderRadius: 10, padding: "1px 8px", fontSize: 11 },

  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  teams: { fontSize: 15, fontWeight: 700, color: "var(--text)" },
  score: { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 15, color: "var(--accent)" },
  meta: { fontSize: 11, color: "var(--text3)" },
  legs: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 2 },
  leg: { display: "inline-flex", alignItems: "center", gap: 6, background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 8px" },
  legSel: { fontSize: 12.5, fontWeight: 600, color: "var(--text)" },
  legProb: { fontSize: 12, fontWeight: 700 },
  legOdds: { fontSize: 12, color: "var(--text2)" },

  inputBar: { display: "flex", gap: 8, padding: "12px 24px", borderTop: "1px solid var(--border)", maxWidth: 860, width: "100%", margin: "0 auto" },
  input: { flex: 1, background: "var(--bg2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 10, padding: "11px 14px", fontSize: 14, outline: "none" },
  sendBtn: { fontSize: 14, fontWeight: 700, color: "#04121f", background: "var(--accent)", border: "none", borderRadius: 10, padding: "0 18px", cursor: "pointer" },
  sendOff: { opacity: 0.4, cursor: "not-allowed" },
};

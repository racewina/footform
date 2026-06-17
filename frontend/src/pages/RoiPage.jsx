import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchRoi(days) {
  const res = await fetch(`/api/roi?days=${days}&tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

const WINDOWS = [
  { key: "14", label: "14 days" },
  { key: "30", label: "30 days" },
];

const roiColor = (v) =>
  v == null ? "var(--text3)" : v > 0 ? "#2ecc71" : v < 0 ? "#e74c3c" : "var(--text2)";

export default function RoiPage() {
  const [days, setDays] = useState("14");
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["roi", days],
    queryFn: () => fetchRoi(days),
  });

  return (
    <div style={styles.page}>
      <div style={styles.note}>
        <span aria-hidden="true">💹</span>
        <span>
          How the model's published picks would have performed, settled at <strong>1
          unit flat</strong> on our <strong>fair odds</strong>. Because no historical
          bookmaker prices exist, this is a deliberately conservative floor — at the
          best available book price (always ≥ fair) you'd typically do better. Past
          performance is not a guarantee; not betting advice.
        </span>
      </div>

      <div style={styles.controls}>
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            style={{ ...styles.tab, ...(days === w.key ? styles.tabActive : {}) }}
            onClick={() => setDays(w.key)}
          >
            {w.label}
          </button>
        ))}
      </div>

      <div style={styles.body}>
        {isLoading && <Spinner />}
        {isError && <p style={styles.error}>{error.message}</p>}
        {!isLoading && !isError && data && (
          <>
            <div style={styles.cards}>
              <ProductCard
                title="🎯 Safe Bets"
                subtitle="Accumulator slips — win only if every leg lands"
                p={data.products.safeBets}
              />
              <ProductCard
                title="⭐ Top Picks"
                subtitle="The single most-confident market per match, flat staked"
                p={data.products.topPicks}
              />
            </div>
            <TrendChart trend={data.trend} />
            <p style={styles.windowNote}>
              Window: {data.window.from} → {data.window.to} ({data.window.days} days, ending yesterday)
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function ProductCard({ title, subtitle, p }) {
  if (!p || !p.bets) {
    return (
      <div style={styles.card}>
        <div style={styles.cardTitle}>{title}</div>
        <div style={styles.cardSub}>{subtitle}</div>
        <p style={styles.noData}>No settled bets in this window yet.</p>
      </div>
    );
  }
  return (
    <div style={styles.card}>
      <div style={styles.cardHead}>
        <div>
          <div style={styles.cardTitle}>{title}</div>
          <div style={styles.cardSub}>{subtitle}</div>
        </div>
        <div style={styles.roiBox}>
          <span style={{ ...styles.roiValue, color: roiColor(p.roiPct) }}>
            {p.roiPct > 0 ? "+" : ""}{p.roiPct}%
          </span>
          <span style={styles.roiLabel}>ROI</span>
        </div>
      </div>
      <div style={styles.statRow}>
        <Stat label="Win rate" value={`${p.winRate}%`} />
        <Stat label="Record" value={`${p.wins}W–${p.losses}L`} />
        <Stat label="Bets" value={p.bets} />
        <Stat
          label="Net units"
          value={`${p.profit > 0 ? "+" : ""}${p.profit}`}
          color={roiColor(p.profit)}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={styles.stat}>
      <span style={{ ...styles.statValue, ...(color ? { color } : {}) }}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
    </div>
  );
}

// Compact cumulative-profit line (Safe Bets), drawn as an inline SVG sparkline.
function TrendChart({ trend }) {
  const pts = (trend || []).filter((t) => t.bets > 0 || t.cumulative !== 0);
  if (pts.length < 2) return null;

  const W = 760, H = 120, PAD = 8;
  const xs = trend.map((_, i) => i);
  const ys = trend.map((t) => t.cumulative);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const spanY = maxY - minY || 1;
  const x = (i) => PAD + (i / (trend.length - 1 || 1)) * (W - 2 * PAD);
  const y = (v) => PAD + (1 - (v - minY) / spanY) * (H - 2 * PAD);

  const path = trend.map((t, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(t.cumulative).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  const last = ys[ys.length - 1];
  const lineColor = last >= 0 ? "#2ecc71" : "#e74c3c";

  return (
    <div style={styles.chartWrap}>
      <div style={styles.chartTitle}>Safe Bets — cumulative units</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} preserveAspectRatio="none">
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="var(--border)" strokeWidth="1" strokeDasharray="4 4" />
        <path d={path} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div style={styles.chartFoot}>
        <span>{trend[0]?.date}</span>
        <span style={{ color: roiColor(last) }}>
          {last > 0 ? "+" : ""}{last} units
        </span>
        <span>{trend[trend.length - 1]?.date}</span>
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
  controls: { display: "flex", gap: 8, padding: "12px 24px 0" },
  tab: { fontSize: 13, fontWeight: 600, color: "var(--text2)", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 14px" },
  tabActive: { color: "#04121f", background: "var(--accent)", borderColor: "var(--accent)" },
  body: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 860, width: "100%", margin: "0 auto" },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },

  cards: { display: "flex", flexDirection: "column", gap: 16 },
  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px" },
  cardHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  cardTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 17, color: "var(--text)" },
  cardSub: { fontSize: 12, color: "var(--text3)", marginTop: 2 },
  roiBox: { display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 },
  roiValue: { fontFamily: "var(--font-display)", fontSize: 30, fontWeight: 800, lineHeight: 1 },
  roiLabel: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5 },
  noData: { color: "var(--text3)", fontSize: 13, marginTop: 10 },

  statRow: { display: "flex", gap: 24, marginTop: 16, flexWrap: "wrap" },
  stat: { display: "flex", flexDirection: "column", gap: 2 },
  statValue: { fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, color: "var(--text)" },
  statLabel: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4 },

  chartWrap: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: "14px 16px" },
  chartTitle: { fontSize: 12, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 },
  chartFoot: { display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text3)", marginTop: 4 },

  windowNote: { fontSize: 11, color: "var(--text3)", textAlign: "center" },
};

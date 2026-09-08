// Shared date navigator for the bet-slate pages. Front-most date (today) shows
// the live/frozen selection; stepping back shows that day's graded record
// (score + hit/miss). Forward is capped at today.
export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export default function DateBar({ date, onShift }) {
  const isToday = ymd(date) === ymd(startOfToday());
  const pretty = date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return (
    <div style={styles.bar}>
      <button style={styles.nav} onClick={() => onShift(-1)} aria-label="Previous day">‹</button>
      <div style={styles.label}>
        {pretty}
        {isToday && <span style={styles.tag}>Today</span>}
      </div>
      <button
        style={{ ...styles.nav, ...(isToday ? styles.navOff : {}) }}
        onClick={() => !isToday && onShift(1)}
        disabled={isToday}
        aria-label="Next day"
      >
        ›
      </button>
    </div>
  );
}

const styles = {
  bar: { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "12px 24px", borderBottom: "1px solid var(--border)" },
  nav: { fontSize: 22, color: "var(--text2)", padding: "2px 14px", borderRadius: 8, background: "var(--bg2)" },
  navOff: { opacity: 0.3, cursor: "not-allowed" },
  label: { display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 15, minWidth: 180, justifyContent: "center" },
  tag: { fontSize: 11, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 4, padding: "1px 6px" },
};

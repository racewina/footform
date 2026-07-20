import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FootformLogo } from "./FootformLogo";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchLeagues() {
  const res = await fetch("/api/leagues");
  if (!res.ok) throw new Error("Failed to load leagues");
  return res.json();
}

async function fetchCounts(dateStr) {
  const res = await fetch(`/api/counts?date=${dateStr}&tz=${encodeURIComponent(TZ)}`);
  if (!res.ok) throw new Error("Failed to load counts");
  return res.json();
}

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
};

export default function Sidebar({ selectedId, onSelect, date, onDateChange, mobileOpen, onClose }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["leagues"],
    queryFn: fetchLeagues,
    staleTime: 24 * 60 * 60 * 1000,
  });

  const viewDate = date instanceof Date ? date : new Date();
  const dateStr = ymd(viewDate);
  const isToday = dateStr === ymd(new Date());

  // Match counts per league for the viewed date, for the country/league badges.
  const { data: countsData } = useQuery({
    queryKey: ["counts", dateStr],
    queryFn: () => fetchCounts(dateStr),
    staleTime: 5 * 60 * 1000,
    refetchInterval: isToday ? 5 * 60 * 1000 : false,
    placeholderData: (prev) => prev, // keep counts visible while a new date loads (v5)
  });
  const counts = countsData?.counts || {};
  const countFor = (id) => counts[String(id)] || 0;
  const countryTotal = (items) => items.reduce((n, l) => n + countFor(l.id), 0);

  const shiftDay = (days) => {
    const next = new Date(viewDate);
    next.setDate(next.getDate() + days);
    next.setHours(0, 0, 0, 0);
    onDateChange?.(next);
  };
  const prettyDate = viewDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const countTitle = isToday ? "Matches today" : `Matches ${prettyDate}`;

  const [leaguesOpen, setLeaguesOpen] = useState(false);
  const [openCountry, setOpenCountry] = useState(null);

  // Some views are kept for local use only — hidden on the deployed site, shown
  // when running on localhost (the dev box). Keeps the public sidebar focused.
  const localOnly = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);

  const leagues = data?.leagues || [];

  // Countries pinned above the rest, in this order. They use the SAME collapsible
  // row as everything else, so a pinned country brings its lower divisions with
  // it — England carries the Championship, League One and League Two rather than
  // scattering them further down. That plus the exclusion below is what
  // decongests the list: seven fewer entries in the A-Z, nothing listed twice.
  const TOP_COUNTRIES = ["England", "Spain", "Italy", "Germany", "France", "Europe", "South America"];

  const byCountry = leagues.reduce((acc, l) => {
    (acc[l.country] ||= []).push(l);
    return acc;
  }, {});

  // Every country appears exactly once: pinned, or in the A-Z list, never both.
  const topGroups = TOP_COUNTRIES.filter((c) => byCountry[c]).map((c) => [c, byCountry[c]]);
  const countryGroups = Object.entries(byCountry)
    .filter(([country]) => !TOP_COUNTRIES.includes(country))
    .sort(([a], [b]) => a.localeCompare(b));

  // One row shape for both sections, so a pinned country expands exactly like
  // any other and there's only one place to change the styling.
  const renderCountry = ([country, items]) => {
    const open = openCountry === country;
    const hasActive = items.some((l) => String(l.id) === String(selectedId));
    return (
      <div key={country} style={styles.group}>
        <button
          style={{ ...styles.countryRow, ...(hasActive ? styles.countryRowActive : {}) }}
          onClick={() => setOpenCountry(open ? null : country)}
          aria-expanded={open}
        >
          <span style={styles.countryLeft}>
            <span style={styles.countryFlag}>{items[0].flag}</span>
            <span style={styles.itemName}>{country}</span>
          </span>
          <span style={styles.countryRight}>
            {countryTotal(items) > 0 && <span style={styles.countMatch} title={countTitle}>{countryTotal(items)}</span>}
            <span style={{ ...styles.chevron, transform: open ? "rotate(90deg)" : "none" }}>›</span>
          </span>
        </button>
        {open && (
          <div style={styles.countryLeagues}>
            {items.map((l) => {
              const active = String(l.id) === String(selectedId);
              return (
                <button
                  key={l.id}
                  style={{ ...styles.subItem, ...(active ? styles.itemActive : {}) }}
                  onClick={() => {
                    onSelect(String(l.id));
                    onClose?.();
                  }}
                >
                  <span style={styles.itemName}>{l.name}</span>
                  <span style={styles.subRight}>
                    {l.tier === 2 && <span style={styles.tierBadge}>2nd</span>}
                    {countFor(l.id) > 0 && <span style={styles.countMatch} title={countTitle}>{countFor(l.id)}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {mobileOpen && <div style={styles.overlay} onClick={onClose} />}
      <aside className={`app-sidebar${mobileOpen ? " open" : ""}`} style={styles.sidebar}>
        <button
          style={styles.brand}
          onClick={() => {
            onSelect("today");
            onClose?.();
          }}
          aria-label="FootForm home"
          title="Back to today's matches"
        >
          <FootformLogo iconSize={34} wordSize={19} uid="sidebar" />
        </button>

        <nav style={styles.nav}>
          <button
            style={{ ...styles.todayItem, justifyContent: "space-between" }}
            onClick={() => setLeaguesOpen((v) => !v)}
            aria-expanded={leaguesOpen}
          >
            <span style={styles.toggleLeft}>
              <span style={styles.todayIcon}>🏆</span>
              <span style={styles.itemName}>Leagues</span>
            </span>
            <span style={{ ...styles.chevron, transform: leaguesOpen ? "rotate(90deg)" : "none" }}>›</span>
          </button>

          {leaguesOpen && (
            <div style={styles.leaguesList}>
              {/* Date selector — the counts (and the fixtures you open) follow it,
                  so you can browse another day's events across every league. */}
              <div style={styles.dateNav}>
                <button style={styles.dateNavBtn} onClick={() => shiftDay(-1)} aria-label="Previous day">‹</button>
                {/* Full date-picker: a transparent native date input overlays the
                    label so a tap opens the calendar (works on iOS too). */}
                <label style={styles.dateNavLabel} title="Pick a date">
                  {prettyDate}{isToday && <span style={styles.dateNavToday}>Today</span>}
                  <input
                    type="date"
                    value={dateStr}
                    onChange={(e) => e.target.value && onDateChange?.(parseYmd(e.target.value))}
                    onClick={(e) => { try { e.currentTarget.showPicker?.(); } catch {} }}
                    style={styles.dateNavInput}
                  />
                </label>
                <button style={styles.dateNavBtn} onClick={() => shiftDay(1)} aria-label="Next day">›</button>
              </div>
              {isLoading && <p style={styles.muted}>Loading leagues…</p>}
              {isError && <p style={styles.error}>Couldn't load leagues</p>}
              {topGroups.length > 0 && <div style={styles.groupLabel}>Top competitions</div>}
              {topGroups.map(renderCountry)}
              {countryGroups.length > 0 && <div style={styles.groupLabel}>All countries</div>}
              {countryGroups.map(renderCountry)}
            </div>
          )}

          <button
            style={{
              ...styles.todayItem,
              ...(String(selectedId) === "today" ? styles.todayItemActive : {}),
            }}
            onClick={() => {
              onSelect("today");
              onClose?.();
            }}
          >
            <span style={styles.todayIcon}>📅</span>
            <span style={styles.itemName}>Today's Matches</span>
          </button>

          {localOnly && (
          <button
            style={{
              ...styles.todayItem,
              ...(String(selectedId) === "results" ? styles.todayItemActive : {}),
            }}
            onClick={() => {
              onSelect("results");
              onClose?.();
            }}
          >
            <span style={styles.todayIcon}>📊</span>
            <span style={styles.itemName}>Track Record</span>
          </button>
          )}

          <button
            style={{
              ...styles.todayItem,
              ...(String(selectedId) === "props-finder" ? styles.todayItemActive : {}),
            }}
            onClick={() => {
              onSelect("props-finder");
              onClose?.();
            }}
          >
            <span style={styles.todayIcon}>🔎</span>
            <span style={styles.itemName}>Props Finder</span>
          </button>

          <button
            style={{
              ...styles.todayItem,
              ...(String(selectedId) === "safebets" ? styles.todayItemActive : {}),
            }}
            onClick={() => {
              onSelect("safebets");
              onClose?.();
            }}
          >
            <span style={styles.todayIcon}>🎯</span>
            <span style={styles.itemName}>Safe Bets</span>
          </button>

          {localOnly && (
          <button
            style={{
              ...styles.todayItem,
              ...(String(selectedId) === "safe-results" ? styles.todayItemActive : {}),
            }}
            onClick={() => {
              onSelect("safe-results");
              onClose?.();
            }}
          >
            <span style={styles.todayIcon}>🧾</span>
            <span style={styles.itemName}>Safe Bets Record</span>
          </button>
          )}

          <button
            style={{
              ...styles.todayItem,
              ...(String(selectedId) === "vip" ? styles.todayItemActive : {}),
            }}
            onClick={() => {
              onSelect("vip");
              onClose?.();
            }}
          >
            <span style={styles.todayIcon}>💎</span>
            <span style={styles.itemName}>VIP Bet</span>
          </button>

          {localOnly && (
          <button
            style={{
              ...styles.todayItem,
              ...(String(selectedId) === "value" ? styles.todayItemActive : {}),
            }}
            onClick={() => {
              onSelect("value");
              onClose?.();
            }}
          >
            <span style={styles.todayIcon}>📈</span>
            <span style={styles.itemName}>Value Bets</span>
          </button>
          )}

          {localOnly && (
          <button
            style={{
              ...styles.todayItem,
              ...(String(selectedId) === "roi" ? styles.todayItemActive : {}),
            }}
            onClick={() => {
              onSelect("roi");
              onClose?.();
            }}
          >
            <span style={styles.todayIcon}>💹</span>
            <span style={styles.itemName}>ROI Tracker</span>
          </button>
          )}

        </nav>
      </aside>
    </>
  );
}

const styles = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9 },
  sidebar: {
    width: 240,
    flexShrink: 0,
    background: "var(--bg2)",
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
  },
  sidebarOpen: {},
  brand: { display: "flex", alignItems: "center", gap: 10, padding: "18px 20px", borderBottom: "1px solid var(--border)", width: "100%", textAlign: "left" },
  brandMark: { fontSize: 22 },
  brandName: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, color: "var(--text)" },
  nav: { padding: "12px 10px", display: "flex", flexDirection: "column", gap: 14 },
  todayItem: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "10px 10px", borderRadius: 8, color: "var(--text)", fontSize: 14, fontWeight: 600,
    textAlign: "left", background: "var(--bg3)", border: "1px solid var(--border)",
  },
  todayItemActive: { background: "var(--accent)", color: "#04121f", border: "1px solid var(--accent)" },
  todayIcon: { fontSize: 16 },
  toggleLeft: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  chevron: { fontSize: 18, color: "var(--text3)", transition: "transform 0.15s ease", flexShrink: 0 },
  leaguesList: { display: "flex", flexDirection: "column", gap: 4 },
  dateNav: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, marginBottom: 4, background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: 3 },
  dateNavBtn: { fontSize: 18, lineHeight: 1, color: "var(--text2)", padding: "2px 10px", borderRadius: 6, flexShrink: 0 },
  dateNavLabel: { position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--text)", padding: "2px 4px", minWidth: 0, whiteSpace: "nowrap", cursor: "pointer" },
  dateNavInput: { position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, border: "none", padding: 0, margin: 0, cursor: "pointer", WebkitAppearance: "none", appearance: "none" },
  dateNavToday: { fontSize: 9, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 4, padding: "0 4px" },
  group: { display: "flex", flexDirection: "column", gap: 2 },
  groupLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text3)", padding: "4px 10px" },
  countryRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
    padding: "9px 10px", borderRadius: 8, color: "var(--text)", fontSize: 14, fontWeight: 500,
    textAlign: "left", width: "100%",
  },
  countryRowActive: { background: "var(--bg3)" },
  countryLeft: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  countryFlag: { fontSize: 15, flexShrink: 0 },
  countryRight: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  countryCount: { fontSize: 11, fontWeight: 700, color: "var(--text3)", background: "var(--bg3)", borderRadius: 10, padding: "1px 7px", minWidth: 18, textAlign: "center" },
  countMatch: { fontSize: 11, fontWeight: 700, color: "#04121f", background: "var(--accent)", borderRadius: 10, padding: "1px 7px", minWidth: 18, textAlign: "center" },
  subRight: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  countryLeagues: { display: "flex", flexDirection: "column", gap: 2, margin: "2px 0 4px", paddingLeft: 10, borderLeft: "1px solid var(--border)", marginLeft: 16 },
  subItem: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 10px", borderRadius: 8, color: "var(--text2)", fontSize: 13.5, textAlign: "left",
  },
  item: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "8px 10px", borderRadius: 8, color: "var(--text2)", fontSize: 14, textAlign: "left",
  },
  itemActive: { background: "var(--bg3)", color: "var(--text)" },
  itemName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tierBadge: { fontSize: 10, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px" },
  muted: { color: "var(--text3)", fontSize: 13, padding: "6px 10px" },
  error: { color: "var(--loss)", fontSize: 13, padding: "6px 10px" },
};

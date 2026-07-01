import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FootformLogo } from "./FootformLogo";

async function fetchLeagues() {
  const res = await fetch("/api/leagues");
  if (!res.ok) throw new Error("Failed to load leagues");
  return res.json();
}

export default function Sidebar({ selectedId, onSelect, mobileOpen, onClose }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["leagues"],
    queryFn: fetchLeagues,
    staleTime: 24 * 60 * 60 * 1000,
  });

  const [leaguesOpen, setLeaguesOpen] = useState(false);

  // Some views are kept for local use only — hidden on the deployed site, shown
  // when running on localhost (the dev box). Keeps the public sidebar focused.
  const localOnly = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);

  const leagues = data?.leagues || [];
  const byCountry = leagues.reduce((acc, l) => {
    (acc[l.country] ||= []).push(l);
    return acc;
  }, {});

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
              {isLoading && <p style={styles.muted}>Loading leagues…</p>}
              {isError && <p style={styles.error}>Couldn't load leagues</p>}
              {Object.entries(byCountry).map(([country, items]) => (
                <div key={country} style={styles.group}>
                  <div style={styles.groupLabel}>{items[0].flag} {country}</div>
                  {items.map((l) => {
                    const active = String(l.id) === String(selectedId);
                    return (
                      <button
                        key={l.id}
                        style={{ ...styles.item, ...(active ? styles.itemActive : {}) }}
                        onClick={() => {
                          onSelect(String(l.id));
                          onClose?.();
                        }}
                      >
                        <span style={styles.itemName}>{l.name}</span>
                        {l.tier === 2 && <span style={styles.tierBadge}>2nd</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
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
  leaguesList: { display: "flex", flexDirection: "column", gap: 14 },
  group: { display: "flex", flexDirection: "column", gap: 2 },
  groupLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--text3)", padding: "4px 10px" },
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

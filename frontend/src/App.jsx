import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Analytics } from "@vercel/analytics/react";
import Sidebar from "./components/Sidebar";
import FixturesPage from "./pages/FixturesPage";
import ResultsPage from "./pages/ResultsPage";
import SafeBetsPage from "./pages/SafeBetsPage";
import SafeBetsResultsPage from "./pages/SafeBetsResultsPage";
import VipBetPage from "./pages/VipBetPage";
import ValueBetsPage from "./pages/ValueBetsPage";
import PropsFinderPage from "./pages/PropsFinderPage";
import RoiPage from "./pages/RoiPage";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

const spinnerCSS = `
@keyframes spin { to { transform: rotate(360deg); } }
`;

export default function App() {
  const [selectedLeague, setSelectedLeague] = useState("today");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <QueryClientProvider client={queryClient}>
      <style>{spinnerCSS}</style>
      <div style={styles.app}>
        <Sidebar
          selectedId={selectedLeague}
          onSelect={setSelectedLeague}
          mobileOpen={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
        />
        <main style={styles.main}>
          <header style={styles.header}>
            <button className="app-menu-btn" style={styles.menuBtn} onClick={() => setMobileMenuOpen(true)} aria-label="Open menu">
              ☰
            </button>
            <LeaguePill leagueId={selectedLeague} />
          </header>
          {selectedLeague === "results"
            ? <ResultsPage />
            : selectedLeague === "props-finder"
              ? <PropsFinderPage />
            : selectedLeague === "roi"
              ? <RoiPage />
            : selectedLeague === "value"
              ? <ValueBetsPage />
              : selectedLeague === "vip"
              ? <VipBetPage />
              : selectedLeague === "safebets"
                ? <SafeBetsPage />
                : selectedLeague === "safe-results"
                  ? <SafeBetsResultsPage />
                  : selectedLeague
                    ? <FixturesPage leagueId={selectedLeague} />
                    : <NoLeaguePrompt />
          }
        </main>
      </div>
      <Analytics />
    </QueryClientProvider>
  );
}

const LEAGUE_NAMES = {
  "today": { name: "Today's Matches", flag: "📅" },
  "results": { name: "Track Record", flag: "📊" },
  "safebets": { name: "Safe Bets", flag: "🎯" },
  "safe-results": { name: "Safe Bets Record", flag: "🧾" },
  "vip": { name: "VIP Bet", flag: "💎" },
  "props-finder": { name: "Props Finder", flag: "🔎" },
  "value": { name: "Value Bets", flag: "📈" },
  "roi": { name: "ROI Tracker", flag: "💹" },
  "39": { name: "Premier League", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  "40": { name: "Championship", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  "179": { name: "Scottish Premiership", flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿" },
  "140": { name: "La Liga", flag: "🇪🇸" },
  "141": { name: "La Liga 2", flag: "🇪🇸" },
  "135": { name: "Serie A", flag: "🇮🇹" },
  "136": { name: "Serie B", flag: "🇮🇹" },
  "78": { name: "Bundesliga", flag: "🇩🇪" },
  "79": { name: "2. Bundesliga", flag: "🇩🇪" },
  "80": { name: "3. Liga", flag: "🇩🇪" },
  "61": { name: "Ligue 1", flag: "🇫🇷" },
  "88": { name: "Eredivisie", flag: "🇳🇱" },
  "94": { name: "Primeira Liga", flag: "🇵🇹" },
  "203": { name: "Süper Lig", flag: "🇹🇷" },
  "103": { name: "Eliteserien", flag: "🇳🇴" },
  "104": { name: "1. Division", flag: "🇳🇴" },
  "71": { name: "Brasileirão Série A", flag: "🇧🇷" },
  "72": { name: "Brasileirão Série B", flag: "🇧🇷" },
  "75": { name: "Brasileirão Série C", flag: "🇧🇷" },
  "76": { name: "Brasileirão Série D", flag: "🇧🇷" },
  "128": { name: "Liga Profesional", flag: "🇦🇷" },
  "129": { name: "Primera Nacional", flag: "🇦🇷" },
  "131": { name: "Primera B Metropolitana", flag: "🇦🇷" },
  "134": { name: "Torneo Federal A", flag: "🇦🇷" },
  "253": { name: "Major League Soccer", flag: "🇺🇸" },
  "262": { name: "Liga MX", flag: "🇲🇽" },
  "2":  { name: "Champions League", flag: "🇪🇺" },
  "3": { name: "Europa League", flag: "🇪🇺" },
  "848": { name: "Conference League", flag: "🇪🇺" },
  "1": { name: "World Cup", flag: "🌍" },
  "10": { name: "International Friendlies", flag: "🤝" },
};

function LeaguePill({ leagueId }) {
  const l = LEAGUE_NAMES[leagueId];
  if (!l) return null;
  return (
    <div style={styles.leaguePill}>
      <span style={{ fontSize: 16 }}>{l.flag}</span>
      <span style={styles.leaguePillName}>{l.name}</span>
    </div>
  );
}

function NoLeaguePrompt() {
  return (
    <div style={styles.noLeague}>
      <p style={styles.noLeagueText}>Select a league from the sidebar</p>
    </div>
  );
}

const styles = {
  app: { display: "flex", height: "100vh", overflow: "hidden" },
  main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 },
  header: { display: "flex", alignItems: "center", gap: 12, padding: "14px 24px", borderBottom: "1px solid var(--border)", background: "var(--bg2)" },
  menuBtn: { fontSize: 18, color: "var(--text2)", display: "none", padding: "4px 8px" },
  leaguePill: { display: "flex", alignItems: "center", gap: 8 },
  leaguePillName: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 16, color: "var(--text)" },
  noLeague: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  noLeagueText: { color: "var(--text3)", fontSize: 15 },
};

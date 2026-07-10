import { useState, useEffect, useRef } from "react";
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
  // App-wide viewed date, shared by the sidebar's date selector and the fixtures
  // view, so picking a day in either keeps the whole app on that day.
  const [viewDate, setViewDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  // In-app navigation history wired into the browser History API so the Android
  // hardware/gesture back (and the in-app back button) step through views instead
  // of closing the PWA. A ref mirrors the stack so the popstate listener — bound
  // once — always reads the latest value.
  const [navStack, setNavStack] = useState([]);
  const navStackRef = useRef(navStack);
  navStackRef.current = navStack;

  const navigate = (id) => {
    if (String(id) === String(selectedLeague)) return;
    setNavStack((s) => [...s, selectedLeague]);
    setSelectedLeague(id);
    // One browser history entry per forward navigation (same URL, no reload) so
    // a system/gesture back pops it and fires popstate.
    window.history.pushState({ ff: true }, "");
  };
  // Both the system back and our button flow through popstate, so there's a
  // single source of truth and no divergence.
  const goBack = () => {
    if (navStack.length) window.history.back();
  };

  useEffect(() => {
    const onPop = () => {
      const stack = navStackRef.current;
      if (!stack.length) return; // at the root — let the browser exit the app
      setSelectedLeague(stack[stack.length - 1]);
      setNavStack(stack.slice(0, -1));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <style>{spinnerCSS}</style>
      <div style={styles.app}>
        <Sidebar
          selectedId={selectedLeague}
          onSelect={navigate}
          date={viewDate}
          onDateChange={setViewDate}
          mobileOpen={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
        />
        <main style={styles.main}>
          <header style={styles.header}>
            {navStack.length > 0 && (
              <button style={styles.backBtn} onClick={goBack} aria-label="Go back">
                ‹
              </button>
            )}
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
                    ? <FixturesPage leagueId={selectedLeague} date={viewDate} onDateChange={setViewDate} />
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
  "41": { name: "League One", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  "42": { name: "League Two", flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  "179": { name: "Scottish Premiership", flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿" },
  "180": { name: "Scottish Championship", flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿" },
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
  "144": { name: "Pro League", flag: "🇧🇪" },
  "145": { name: "Challenger Pro League", flag: "🇧🇪" },
  "103": { name: "Eliteserien", flag: "🇳🇴" },
  "104": { name: "1. Division", flag: "🇳🇴" },
  "113": { name: "Allsvenskan", flag: "🇸🇪" },
  "119": { name: "Superliga", flag: "🇩🇰" },
  "120": { name: "1. Division", flag: "🇩🇰" },
  "329": { name: "Meistriliiga", flag: "🇪🇪" },
  "328": { name: "Esiliiga A", flag: "🇪🇪" },
  "244": { name: "Veikkausliiga", flag: "🇫🇮" },
  "1087": { name: "Ykkösliiga", flag: "🇫🇮" },
  "245": { name: "Ykkönen", flag: "🇫🇮" },
  "247": { name: "Kakkonen A", flag: "🇫🇮" },
  "248": { name: "Kakkonen B", flag: "🇫🇮" },
  "249": { name: "Kakkonen C", flag: "🇫🇮" },
  "165": { name: "1. Deild", flag: "🇮🇸" },
  "89": { name: "Eerste Divisie", flag: "🇳🇱" },
  "95": { name: "Liga 2", flag: "🇵🇹" },
  "207": { name: "Super League", flag: "🇨🇭" },
  "208": { name: "Challenge League", flag: "🇨🇭" },
  "204": { name: "1. Lig", flag: "🇹🇷" },
  "106": { name: "Ekstraklasa", flag: "🇵🇱" },
  "345": { name: "Czech First League", flag: "🇨🇿" },
  "271": { name: "NB I", flag: "🇭🇺" },
  "283": { name: "Superliga", flag: "🇷🇴" },
  "286": { name: "Super Liga", flag: "🇷🇸" },
  "332": { name: "Super Liga", flag: "🇸🇰" },
  "210": { name: "HNL", flag: "🇭🇷" },
  "172": { name: "Parva Liga", flag: "🇧🇬" },
  "71": { name: "Brasileirão Série A", flag: "🇧🇷" },
  "72": { name: "Brasileirão Série B", flag: "🇧🇷" },
  "75": { name: "Brasileirão Série C", flag: "🇧🇷" },
  "76": { name: "Brasileirão Série D", flag: "🇧🇷" },
  "128": { name: "Liga Profesional", flag: "🇦🇷" },
  "129": { name: "Primera Nacional", flag: "🇦🇷" },
  "131": { name: "Primera B Metropolitana", flag: "🇦🇷" },
  "134": { name: "Torneo Federal A", flag: "🇦🇷" },
  "242": { name: "LigaPro Serie A", flag: "🇪🇨" },
  "253": { name: "Major League Soccer", flag: "🇺🇸" },
  "255": { name: "USL Championship", flag: "🇺🇸" },
  "479": { name: "Premier League", flag: "🇨🇦" },
  "262": { name: "Liga MX", flag: "🇲🇽" },
  "169": { name: "Super League", flag: "🇨🇳" },
  "2":  { name: "Champions League", flag: "🇪🇺" },
  "3": { name: "Europa League", flag: "🇪🇺" },
  "848": { name: "Conference League", flag: "🇪🇺" },
  "1": { name: "World Cup", flag: "🌍" },
  "10": { name: "International Friendlies", flag: "🤝" },
  "667": { name: "Club Friendlies", flag: "🤝" },
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
  backBtn: { fontSize: 24, lineHeight: 1, color: "var(--text2)", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "2px 12px", flexShrink: 0, cursor: "pointer" },
  leaguePill: { display: "flex", alignItems: "center", gap: 8 },
  leaguePillName: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 16, color: "var(--text)" },
  noLeague: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center" },
  noLeagueText: { color: "var(--text3)", fontSize: 15 },
};

// API-Football v3 league IDs (host: v3.football.api-sports.io).
// NOTE: these mirror the IDs hardcoded in frontend App.jsx (LEAGUE_NAMES). If
// you add/replace a league, update BOTH files together. League IDs are stable
// in API-Football; look them up via GET /leagues?search=<name>.
export const LEAGUES = [
  { id: "39", name: "Premier League", country: "England", tier: 1, flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { id: "40", name: "Championship", country: "England", tier: 2, flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { id: "179", name: "Scottish Premiership", country: "Scotland", tier: 1, flag: "🏴󠁧󠁢󠁳󠁣󠁴󠁿" },
  { id: "140", name: "La Liga", country: "Spain", tier: 1, flag: "🇪🇸" },
  { id: "141", name: "La Liga 2", country: "Spain", tier: 2, flag: "🇪🇸" },
  { id: "135", name: "Serie A", country: "Italy", tier: 1, flag: "🇮🇹" },
  { id: "136", name: "Serie B", country: "Italy", tier: 2, flag: "🇮🇹" },
  { id: "78", name: "Bundesliga", country: "Germany", tier: 1, flag: "🇩🇪" },
  { id: "79", name: "2. Bundesliga", country: "Germany", tier: 2, flag: "🇩🇪" },
  { id: "80", name: "3. Liga", country: "Germany", tier: 3, flag: "🇩🇪" },
  { id: "61", name: "Ligue 1", country: "France", tier: 1, flag: "🇫🇷" },
  { id: "88", name: "Eredivisie", country: "Netherlands", tier: 1, flag: "🇳🇱" },
  { id: "94", name: "Primeira Liga", country: "Portugal", tier: 1, flag: "🇵🇹" },
  { id: "203", name: "Süper Lig", country: "Turkey", tier: 1, flag: "🇹🇷" },
  { id: "103", name: "Eliteserien", country: "Norway", tier: 1, flag: "🇳🇴" },
  { id: "104", name: "1. Division", country: "Norway", tier: 2, flag: "🇳🇴" },
  { id: "71", name: "Brasileirão Série A", country: "Brazil", tier: 1, flag: "🇧🇷" },
  { id: "72", name: "Brasileirão Série B", country: "Brazil", tier: 2, flag: "🇧🇷" },
  { id: "75", name: "Brasileirão Série C", country: "Brazil", tier: 3, flag: "🇧🇷" },
  { id: "76", name: "Brasileirão Série D", country: "Brazil", tier: 4, flag: "🇧🇷" },
  { id: "128", name: "Liga Profesional", country: "Argentina", tier: 1, flag: "🇦🇷" },
  { id: "129", name: "Primera Nacional", country: "Argentina", tier: 2, flag: "🇦🇷" },
  { id: "131", name: "Primera B Metropolitana", country: "Argentina", tier: 3, flag: "🇦🇷" },
  { id: "134", name: "Torneo Federal A", country: "Argentina", tier: 3, flag: "🇦🇷" },
  { id: "253", name: "Major League Soccer", country: "USA", tier: 1, flag: "🇺🇸" },
  { id: "262", name: "Liga MX", country: "Mexico", tier: 1, flag: "🇲🇽" },
  { id: "2", name: "Champions League", country: "Europe", tier: 1, flag: "🇪🇺" },
  { id: "3", name: "Europa League", country: "Europe", tier: 1, flag: "🇪🇺" },
  { id: "848", name: "Conference League", country: "Europe", tier: 1, flag: "🇪🇺" },
  { id: "1", name: "World Cup", country: "International", tier: 1, flag: "🌍" },
  { id: "10", name: "International Friendlies", country: "International", tier: 1, flag: "🤝" },
];

export const LEAGUES_BY_ID = Object.fromEntries(
  LEAGUES.map((l) => [l.id, l])
);

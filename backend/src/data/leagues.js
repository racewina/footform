// API-Football v3 league IDs (host: v3.football.api-sports.io).
// NOTE: these mirror the IDs hardcoded in frontend App.jsx (LEAGUE_NAMES). If
// you add/replace a league, update BOTH files together. League IDs are stable
// in API-Football; look them up via GET /leagues?search=<name>.
export const LEAGUES = [
  { id: "39", name: "Premier League", country: "England", tier: 1, flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { id: "40", name: "Championship", country: "England", tier: 2, flag: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  { id: "140", name: "La Liga", country: "Spain", tier: 1, flag: "🇪🇸" },
  { id: "141", name: "La Liga 2", country: "Spain", tier: 2, flag: "🇪🇸" },
  { id: "135", name: "Serie A", country: "Italy", tier: 1, flag: "🇮🇹" },
  { id: "136", name: "Serie B", country: "Italy", tier: 2, flag: "🇮🇹" },
  { id: "78", name: "Bundesliga", country: "Germany", tier: 1, flag: "🇩🇪" },
  { id: "79", name: "2. Bundesliga", country: "Germany", tier: 2, flag: "🇩🇪" },
  { id: "61", name: "Ligue 1", country: "France", tier: 1, flag: "🇫🇷" },
  { id: "71", name: "Brasileirão Série A", country: "Brazil", tier: 1, flag: "🇧🇷" },
  { id: "72", name: "Brasileirão Série B", country: "Brazil", tier: 2, flag: "🇧🇷" },
  { id: "2", name: "Champions League", country: "Europe", tier: 1, flag: "🇪🇺" },
  { id: "1", name: "World Cup", country: "International", tier: 1, flag: "🌍" },
  { id: "10", name: "International Friendlies", country: "International", tier: 1, flag: "🤝" },
];

export const LEAGUES_BY_ID = Object.fromEntries(
  LEAGUES.map((l) => [l.id, l])
);

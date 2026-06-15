// API-Football v3 client (direct, host: v3.football.api-sports.io).
//
// This replaces the former RapidAPI/SofaScore provider. To avoid rewriting the
// rest of the app, every fetch here ADAPTS API-Football's response into the
// SAME event shape the old SofaScore client returned, so predictions.js,
// backtest.js and fixtures.js keep consuming `{ events: [...] }` /
// `{ seasons: [...] }` unchanged. The only shape this module emits:
//
//   season:  { seasons: [{ id: <year>, name: "<year>" }] }
//   event:   {
//     id, startTimestamp (unix seconds), status: { type },
//     homeTeam: { id, name, shortName, logo },
//     awayTeam: { id, name, shortName, logo },
//     homeScore: { current }, awayScore: { current },
//     roundInfo: { round }, venue: { name },
//   }
//
// API-Football auth is a single header `x-apisports-key` and it returns HTTP
// 200 even for auth/quota problems, putting the reason in a top-level `errors`
// field — so we inspect that explicitly.

const BASE = process.env.APIFOOTBALL_HOST || "v3.football.api-sports.io";

function authHeaders() {
  return {
    "x-apisports-key": process.env.APIFOOTBALL_KEY || "",
    accept: "application/json",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Rate-limit handling ---------------------------------------------------
// API-Football enforces a per-MINUTE request cap that depends on your plan
// (free ~10/min, paid plans much higher). The /today and /results/summary
// views fan out across every league, so we keep the same two defenses the old
// client used: a global gate spacing successive calls, and retry-with-backoff
// on 429. Tune APIFOOTBALL_MIN_GAP_MS to your plan's per-minute allowance.
const MIN_GAP_MS = Number(process.env.APIFOOTBALL_MIN_GAP_MS || 150);
const MAX_RETRIES = Number(process.env.APIFOOTBALL_MAX_RETRIES || 4);

let nextSlotAt = 0;
function reserveSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + MIN_GAP_MS;
  return at - now;
}

// API-Football reports auth/quota issues in a 200 body. `errors` is sometimes
// an array, sometimes an object map — normalize to a list of messages.
function errorMessages(errors) {
  if (!errors) return [];
  if (Array.isArray(errors)) return errors.filter(Boolean).map(String);
  if (typeof errors === "object") return Object.values(errors).filter(Boolean).map(String);
  return [String(errors)];
}

async function request(path, attempt = 0) {
  if (!process.env.APIFOOTBALL_KEY) {
    const err = new Error("APIFOOTBALL_KEY not set");
    err.status = 500;
    throw err;
  }

  const waitMs = reserveSlot();
  if (waitMs > 0) await sleep(waitMs);

  const url = `https://${BASE}${path}`;
  let res;
  try {
    res = await fetch(url, { headers: authHeaders() });
  } catch (cause) {
    const detail = cause?.cause?.message || cause?.cause?.code || cause?.code || cause.message;
    const err = new Error(`Network error calling ${path}: ${detail} (host=${BASE})`);
    err.status = 502;
    throw err;
  }

  const transient =
    res.status === 429 ||
    (res.status >= 500 && res.status <= 599) ||
    (res.status >= 300 && res.status < 400);
  if (transient && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 400 * 2 ** attempt;
    await sleep(backoff);
    return request(path, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`API-Football ${res.status} for ${path} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const json = await res.json().catch(() => ({}));

  // Errors arrive in a 200 body. A rate-limit message is transient (retry);
  // anything else (bad key, plan limits) is surfaced so the cause is obvious.
  const msgs = errorMessages(json?.errors);
  if (msgs.length) {
    const text = msgs.join("; ");
    const rateLimited = /rate|limit|requests|minute|per day|quota/i.test(text);
    if (rateLimited && attempt < MAX_RETRIES) {
      await sleep(400 * 2 ** attempt);
      return request(path, attempt + 1);
    }
    const err = new Error(`API-Football error for ${path}: ${text}`);
    err.status = 502;
    throw err;
  }

  return json;
}

// --- status mapping --------------------------------------------------------
// API-Football "short" status -> the three buckets the app branches on.
const FINISHED = new Set(["FT", "AET", "PEN"]);
const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE", "INT"]);
function mapStatus(short) {
  if (FINISHED.has(short)) return "finished";
  if (LIVE.has(short)) return "inprogress";
  return "notstarted"; // NS, TBD, PST, CANC, ABD, SUSP, AWD, WO, ...
}

// Adapt one API-Football fixture into the SofaScore-style event the app reads.
function adaptFixture(fx) {
  const home = fx.teams?.home || {};
  const away = fx.teams?.away || {};
  return {
    id: fx.fixture?.id,
    startTimestamp: fx.fixture?.timestamp ?? null,
    status: { type: mapStatus(fx.fixture?.status?.short) },
    homeTeam: { id: home.id, name: home.name, shortName: home.name, logo: home.logo || null },
    awayTeam: { id: away.id, name: away.name, shortName: away.name, logo: away.logo || null },
    homeScore: { current: fx.goals?.home ?? null },
    awayScore: { current: fx.goals?.away ?? null },
    roundInfo: { round: fx.league?.round || null },
    venue: { name: fx.fixture?.venue?.name || null },
  };
}

function adaptFixtures(json) {
  const list = Array.isArray(json?.response) ? json.response : [];
  return { events: list.map(adaptFixture) };
}

const ymdUTC = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

// Current season YEAR for a league (API-Football seasons are years, e.g. 2025
// for a 2025/26 European campaign). Returned in the old { seasons:[{id,name}] }
// shape so callers can keep doing `seasons[0].id`.
export async function fetchLeagueSeason(leagueId) {
  const json = await request(`/leagues?id=${leagueId}&current=true`);
  const league = Array.isArray(json?.response) ? json.response[0] : null;
  const seasons = league?.seasons || [];
  const current = seasons.find((s) => s.current) || seasons[seasons.length - 1];
  if (!current) return { seasons: [] };
  return { seasons: [{ id: current.year, name: String(current.year) }] };
}

// Upcoming fixtures for a league: a generous date window (yesterday → +14d) so
// today's already-started matches and the multi-day range view are both
// covered. All fixtures come back in one response, so page>0 is empty.
export async function fetchScheduledEvents(leagueId, season, page = 0) {
  if (page > 0) return { events: [] };
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const json = await request(
    `/fixtures?league=${leagueId}&season=${season}&from=${ymdUTC(from)}&to=${ymdUTC(to)}`
  );
  return adaptFixtures(json);
}

// Whole-season fixtures for a league (callers filter to finished + date). The
// API returns the full season in a single response, so page>0 is empty — this
// keeps the multi-page dedup loops in fixtures.js to a single real call.
export async function fetchPastEvents(leagueId, season, page = 0) {
  if (page > 0) return { events: [] };
  const json = await request(`/fixtures?league=${leagueId}&season=${season}`);
  return adaptFixtures(json);
}

// A team's most recent fixtures (form). `last` returns the latest finished
// games, which parseFormFromEvents then orders and trims.
export async function fetchTeamLastMatches(teamId, page = 0) {
  if (page > 0) return { events: [] };
  const json = await request(`/fixtures?team=${teamId}&last=12`);
  return adaptFixtures(json);
}

// --- Player props (lineups + per-player season stats) ----------------------
// These power the World Cup player-prop markets (anytime scorer / to commit a
// foul / to be fouled / player tackle). They are NOT used by the matchday or
// results views — only the on-demand /match/:id/players endpoint hits them.

// Projected/actual lineups for a fixture. API-Football only publishes these
// ~20-40 min before kickoff, so an EMPTY response is normal for a match that
// hasn't reached that window — callers surface a "not available yet" state
// rather than treating it as an error.
export async function fetchFixtureLineups(fixtureId) {
  const json = await request(`/fixtures/lineups?fixture=${fixtureId}`);
  const list = Array.isArray(json?.response) ? json.response : [];
  return list.map((side) => ({
    teamId: side.team?.id ?? null,
    teamName: side.team?.name ?? null,
    formation: side.formation || null,
    startXI: (Array.isArray(side.startXI) ? side.startXI : []).map((e) => ({
      id: e.player?.id ?? null,
      name: e.player?.name ?? null,
      number: e.player?.number ?? null,
      pos: e.player?.pos || null,
    })),
  }));
}

// Per-team corner counts for one finished fixture, read from the match
// statistics feed. API-Football only reports a FULL-MATCH total (there is no
// per-half breakdown anywhere in the API), and coverage is patchy for lower-
// profile/older matches — so a missing value comes back as null and callers
// simply average over the matches that do have data. Returns { [teamId]: corners|null }.
export async function fetchFixtureStats(fixtureId) {
  const json = await request(`/fixtures/statistics?fixture=${fixtureId}`);
  const list = Array.isArray(json?.response) ? json.response : [];
  const out = {};
  for (const side of list) {
    const teamId = side.team?.id;
    if (!teamId) continue;
    const row = (side.statistics || []).find((s) => s.type === "Corner Kicks");
    out[teamId] = row && row.value != null ? Number(row.value) : null;
  }
  return out;
}

// The two team ids (+ names) for a fixture, plus its league season. Used by the
// player-props fallback to find each squad when official lineups aren't out yet.
export async function fetchFixtureTeams(fixtureId) {
  const json = await request(`/fixtures?id=${fixtureId}`);
  const fx = Array.isArray(json?.response) ? json.response[0] : null;
  if (!fx) return null;
  return {
    home: { id: fx.teams?.home?.id ?? null, name: fx.teams?.home?.name ?? null },
    away: { id: fx.teams?.away?.id ?? null, name: fx.teams?.away?.name ?? null },
    season: fx.league?.season ?? null,
  };
}

// A team's players for a season, ranked by minutes played FOR THAT TEAM. The
// /players?team= endpoint scopes statistics to the team's own competitions, so
// for a national team these are international minutes — a good proxy for "who
// actually starts" when no official lineup exists yet. Paginated (20/page); we
// cap the pages so a deep squad can't blow the rate budget. Rates are NOT taken
// from here (international samples are tiny) — only the player ids/ranking are.
export async function fetchTeamSquadByMinutes(teamId, season, maxPages = 3) {
  const out = [];
  let page = 1;
  let totalPages = 1;
  do {
    const json = await request(`/players?team=${teamId}&season=${season}&page=${page}`);
    const rows = Array.isArray(json?.response) ? json.response : [];
    totalPages = json?.paging?.total || 1;
    for (const r of rows) {
      const blocks = Array.isArray(r.statistics) ? r.statistics : [];
      let minutes = 0, pos = null, posMin = -1;
      for (const b of blocks) {
        const m = b.games?.minutes || 0;
        minutes += m;
        if (m > posMin) { posMin = m; pos = b.games?.position || pos; }
      }
      if (r.player?.id) {
        out.push({ id: r.player.id, name: r.player.name || null, pos, minutes });
      }
    }
    page += 1;
  } while (page <= totalPages && page <= maxPages);

  out.sort((a, b) => b.minutes - a.minutes);
  return out;
}

// One player's season statistics, SUMMED across every competition they played
// that season (league + domestic cups + internationals) into the raw counts the
// prop model turns into per-90 rates. World Cup national-team samples are tiny,
// so callers pass the player's most recent CLUB season here — the honest best
// signal available before the tournament generates its own data. Returns null
// when the player row is missing entirely.
export async function fetchPlayerSeasonStats(playerId, season) {
  const json = await request(`/players?id=${playerId}&season=${season}`);
  const row = Array.isArray(json?.response) ? json.response[0] : null;
  if (!row) return null;

  const blocks = Array.isArray(row.statistics) ? row.statistics : [];
  let minutes = 0, apps = 0, goals = 0, foulsCommitted = 0, foulsDrawn = 0, tackles = 0, shotsOnTarget = 0;
  let pos = null, posMinutes = -1;
  for (const b of blocks) {
    const m = b.games?.minutes || 0;
    minutes += m;
    apps += b.games?.appearences || 0;
    goals += b.goals?.total || 0;
    foulsCommitted += b.fouls?.committed || 0;
    foulsDrawn += b.fouls?.drawn || 0;
    tackles += b.tackles?.total || 0;
    shotsOnTarget += b.shots?.on || 0;
    // Position from whichever competition they played the most in.
    if (m > posMinutes) { posMinutes = m; pos = b.games?.position || pos; }
  }

  return {
    id: playerId,
    name: row.player?.name || null,
    photo: row.player?.photo || null,
    pos,
    minutes,
    apps,
    goals,
    foulsCommitted,
    foulsDrawn,
    tackles,
    shotsOnTarget,
  };
}

// --- Bookmaker odds (for value betting) ------------------------------------
//
// Pre-match odds for one fixture across every bookmaker the feed carries. We
// only keep the three markets our model prices cleanly off its scoreline grid —
// Match Winner (1X2), Over/Under 2.5 goals, and Both Teams Score — and for each
// selection we take the BEST (highest) decimal price across all books, plus
// which book offered it. Returns null when no odds are published yet (odds
// appear a few days out and disappear at kickoff).
export async function fetchFixtureOdds(fixtureId) {
  const json = await request(`/odds?fixture=${fixtureId}`);
  const row = Array.isArray(json?.response) ? json.response[0] : null;
  const books = row?.bookmakers;
  if (!Array.isArray(books) || !books.length) return null;

  // best[selectionKey] = { odd, book } with the highest odd seen so far.
  const best = {};
  const consider = (key, oddStr, bookName) => {
    const odd = parseFloat(oddStr);
    if (!(odd > 1)) return;
    if (!best[key] || odd > best[key].odd) best[key] = { odd, book: bookName };
  };

  for (const bk of books) {
    const name = bk.name || "—";
    for (const bet of bk.bets || []) {
      const market = bet.name;
      for (const v of bet.values || []) {
        const val = String(v.value);
        if (market === "Match Winner") {
          if (val === "Home") consider("homeWin", v.odd, name);
          else if (val === "Draw") consider("draw", v.odd, name);
          else if (val === "Away") consider("awayWin", v.odd, name);
        } else if (market === "Goals Over/Under") {
          if (val === "Over 2.5") consider("over25", v.odd, name);
          else if (val === "Under 2.5") consider("under25", v.odd, name);
        } else if (market === "Both Teams Score") {
          if (val === "Yes") consider("bttsYes", v.odd, name);
          else if (val === "No") consider("bttsNo", v.odd, name);
        }
      }
    }
  }

  if (!Object.keys(best).length) return null;
  return { bookmakers: books.length, best };
}

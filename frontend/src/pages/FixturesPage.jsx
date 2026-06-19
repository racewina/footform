import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Parse a "YYYY-MM-DD" string (from the date picker) into a LOCAL-midnight Date,
// avoiding the UTC shift that `new Date("YYYY-MM-DD")` would introduce.
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// The viewer's IANA timezone (e.g. "America/New_York"). Sent to the API so the
// server buckets matches into the correct calendar day for the user instead of
// using its own (UTC, on Vercel) clock.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function fetchFixtures(leagueId, date) {
  const tz = encodeURIComponent(TZ);
  const url =
    leagueId === "today"
      ? `/api/today?date=${date}&tz=${tz}`
      : `/api/fixtures/${leagueId}?date=${date}&tz=${tz}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

// Match-level goal markets shown as pills on every card.
// Short, fixed-width label for a team in the compact 1X2 result row. Prefer an
// existing short code; otherwise abbreviate the name to its first three letters.
function teamCode(t) {
  const s = (t?.shortName || t?.name || "").trim();
  if (!s) return "—";
  return (s.length <= 4 ? s : s.slice(0, 3)).toUpperCase();
}

// Single-letter position code for the cramped mobile player rows: Goalkeeper→G,
// Defender→D, Midfielder→M, Attacker/Forward→F.
function posCode(pos) {
  if (!pos) return "";
  const p = pos.toLowerCase();
  if (p.startsWith("goal") || p === "gk" || p === "g") return "G";
  if (p.startsWith("def") || p === "d") return "D";
  if (p.startsWith("mid") || p === "m") return "M";
  if (p.startsWith("att") || p.startsWith("for") || p === "f" || p === "a") return "F";
  return pos[0].toUpperCase();
}

// API-Football id for the World Cup — the only competition we show player props
// for (national-team props lean on club-season form; see backend players.js).
const WORLD_CUP_ID = 1;

// The four per-player markets, in display order.
const PLAYER_MARKETS = [
  { key: "score", label: "Score" },
  { key: "shotOnTarget", label: "SoT" },
  { key: "foul", label: "Foul" },
  { key: "fouled", label: "Fouled" },
  { key: "tackle", label: "Tackle" },
];

async function fetchPlayerProps(fixtureId, clubSeason) {
  const res = await fetch(`/api/match/${fixtureId}/players?season=${clubSeason}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

async function fetchCorners(fixtureId, homeId, awayId) {
  const res = await fetch(`/api/match/${fixtureId}/corners?homeTeamId=${homeId}&awayTeamId=${awayId}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed (${res.status})`);
  }
  return res.json();
}

// Prediction-type filter chips. 1+ and 2+ are per-team markets, so a match
// qualifies if EITHER team meets the threshold (we take the higher of the two).
const FILTERS = [
  { key: "win", label: "Win", value: (m) => m.win ?? 0 },
  { key: "onePlus", label: "1+", value: (m) => Math.max(m.home1Plus ?? 0, m.away1Plus ?? 0) },
  { key: "twoPlus", label: "2+", value: (m) => Math.max(m.home2Plus ?? 0, m.away2Plus ?? 0) },
  { key: "over25", label: "O2.5", value: (m) => m.over25 ?? 0 },
  { key: "btts", label: "BTTS", value: (m) => m.btts ?? 0 },
];
const FILTER_BY_KEY = Object.fromEntries(FILTERS.map((f) => [f.key, f]));
const FILTER_THRESHOLD = 50; // a "prediction type" filter keeps matches >= this %

// Color coding: green 70+, yellow-green 50-69, yellow 35-49, red below 35.
function pctColor(p) {
  if (p >= 70) return "#2ecc71";
  if (p >= 50) return "#9acd32";
  if (p >= 35) return "#f1c40f";
  return "#e74c3c";
}
function tint(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},0.16)`;
}

export default function FixturesPage({ leagueId }) {
  const [date, setDate] = useState(() => startOfToday());
  const [filterMarket, setFilterMarket] = useState("all");
  const dateInputRef = useRef(null);
  const dateStr = ymd(date);
  const isToday = dateStr === ymd(startOfToday());
  const isTodayView = leagueId === "today";

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["fixtures", leagueId, dateStr],
    queryFn: () => fetchFixtures(leagueId, dateStr),
    keepPreviousData: true,
  });

  const shift = (days) => {
    setDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + days);
      return next;
    });
  };

  // Normalize both the single-league and cross-league ("today") responses into
  // a common list of { league, fixtures } groups, then apply the prediction
  // filter inside each group.
  let groups = isTodayView
    ? (data?.leagues || []).map((g) => ({ league: g.league, season: g.season, fixtures: g.fixtures || [] }))
    : data?.league
    ? [{ league: data.league, season: data.season, fixtures: data.fixtures || [] }]
    : [];

  if (filterMarket !== "all") {
    const valueOf = FILTER_BY_KEY[filterMarket].value;
    groups = groups
      .map((g) => ({
        ...g,
        fixtures: g.fixtures
          .filter((f) => f.prediction?.markets && valueOf(f.prediction.markets) >= FILTER_THRESHOLD)
          .sort((a, b) => valueOf(b.prediction.markets) - valueOf(a.prediction.markets)),
      }))
      .filter((g) => g.fixtures.length > 0);
  }

  const totalFixtures = groups.reduce((n, g) => n + g.fixtures.length, 0);

  // The cross-league "today" view reads best as one time-ordered list rather
  // than league-by-league. Flatten every group into a single stream, carrying
  // each fixture's league/season so the card can still show its competition.
  // Default sort is by kickoff; with a prediction filter active we keep the
  // strongest-first ranking that filter implies.
  const flatToday = isTodayView
    ? (() => {
        const flat = groups.flatMap((g) =>
          g.fixtures.map((fx) => ({ fx, league: g.league, season: g.season }))
        );
        if (filterMarket === "all") {
          flat.sort((a, b) => (a.fx.startTimestamp ?? Infinity) - (b.fx.startTimestamp ?? Infinity));
        } else {
          const valueOf = FILTER_BY_KEY[filterMarket].value;
          flat.sort((a, b) => valueOf(b.fx.prediction.markets) - valueOf(a.fx.prediction.markets));
        }
        return flat;
      })()
    : null;

  const prettyDate = date.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });

  return (
    <div style={styles.page}>
      <div style={styles.dateBar}>
        <button style={styles.navBtn} onClick={() => shift(-1)} aria-label="Previous day">
          ‹
        </button>
        <button
          style={styles.dateLabel}
          onClick={() => {
            const el = dateInputRef.current;
            if (el?.showPicker) el.showPicker();
            else el?.focus();
          }}
          aria-label="Pick a date"
          title="Pick a date"
        >
          <span style={styles.dateLabelIcon} aria-hidden="true">📅</span>
          {prettyDate}
          {isToday && <span style={styles.todayTag}>Today</span>}
          <input
            ref={dateInputRef}
            type="date"
            value={dateStr}
            onChange={(e) => e.target.value && setDate(parseYmd(e.target.value))}
            style={styles.dateInput}
            tabIndex={-1}
            aria-hidden="true"
          />
        </button>
        <button style={styles.navBtn} onClick={() => shift(1)}>›</button>
      </div>

      <div style={styles.filterBar}>
        <span style={styles.filterLabel}>Prediction</span>
        <button
          style={{ ...styles.filterChip, ...(filterMarket === "all" ? styles.filterChipActive : {}) }}
          onClick={() => setFilterMarket("all")}
        >
          All
        </button>
        {FILTERS.map((m) => (
          <button
            key={m.key}
            style={{ ...styles.filterChip, ...(filterMarket === m.key ? styles.filterChipActive : {}) }}
            onClick={() => setFilterMarket(m.key)}
          >
            {m.label}
          </button>
        ))}
        {filterMarket !== "all" && (
          <span style={styles.filterHint}>≥ {FILTER_THRESHOLD}%</span>
        )}
      </div>

      <div style={styles.note}>
        <span aria-hidden="true">ⓘ</span>
        <span>
          Predictions use each team's recent form and assume their projected
          lineup. They may change up to 30&nbsp;minutes before kickoff, when
          official team lineups are released.
        </span>
      </div>

      <div style={styles.list}>
        {isLoading && <Spinner />}
        {isError && <p style={styles.error}>{error.message}</p>}
        {!isLoading && !isError && totalFixtures === 0 && (
          <p style={styles.empty}>
            {filterMarket === "all"
              ? isTodayView
                ? "No matches scheduled across any league on this date."
                : "No fixtures on this date."
              : "No matches meet this prediction filter."}
          </p>
        )}
        {!isLoading && !isError && isTodayView &&
          flatToday.map(({ fx, league, season }) => (
            <FixtureCard
              key={fx.id}
              fixture={fx}
              league={league}
              season={season}
              highlight={filterMarket}
              showLeague
            />
          ))}

        {!isLoading && !isError && !isTodayView && groups.map((g) => (
          <div key={g.league.id} style={styles.leagueGroup}>
            <div style={styles.groupHeader}>
              <span style={{ fontSize: 16 }}>{g.league.flag}</span>
              <span style={styles.groupTitle}>{g.league.name}</span>
              <span style={styles.groupCount}>{g.fixtures.length}</span>
            </div>
            {g.fixtures.map((fx) => (
              <FixtureCard
                key={fx.id}
                fixture={fx}
                league={g.league}
                season={g.season}
                highlight={filterMarket}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function FixtureCard({ fixture, league, season, highlight, showLeague }) {
  const [open, setOpen] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [showPlayers, setShowPlayers] = useState(false);
  const [showCorners, setShowCorners] = useState(false);
  const p = fixture.prediction;
  const kickoff = fixture.startTimestamp
    ? new Date(fixture.startTimestamp * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "--:--";

  // Player props for every league. The rates come from each player's season
  // stats: for club leagues that's the SAME season as the fixture, so we use it
  // directly. For national-team (World Cup) matches the players' meaningful
  // sample is their CLUB season — the year before the tournament (e.g. 2025 for
  // "2026") — so we step back one year there.
  const isWorldCup = String(league?.id) === String(WORLD_CUP_ID);
  const propsSeason = isWorldCup ? Number(season) - 1 : Number(season);
  const canShowPlayers = Number.isFinite(propsSeason) && !!fixture.id;
  // Corners apply to any match with both team ids (data coverage permitting).
  const canShowCorners = !!(fixture.id && fixture.homeTeam?.id && fixture.awayTeam?.id);

  return (
    <div style={styles.card}>
      {showLeague && league && (
        <div style={styles.cardLeague}>
          <span style={{ fontSize: 13 }}>{league.flag}</span>
          <span style={styles.cardLeagueName}>{league.name}</span>
        </div>
      )}
      <div
        role="button"
        tabIndex={0}
        style={styles.cardHead}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        <span style={styles.kickoff}>{kickoff}</span>
        <div style={styles.teams}>
          <TeamRow team={fixture.homeTeam} score={fixture.homeScore} />
          <TeamRow team={fixture.awayTeam} score={fixture.awayScore} />
        </div>
        <span style={styles.chevron}>{open ? "▲" : "▼"}</span>
      </div>

      {showAnalysis && p?.markets && (
        <AnalysisModal
          fixture={fixture}
          league={league}
          prediction={p}
          onClose={() => setShowAnalysis(false)}
        />
      )}

      {p?.markets && (
        <div style={styles.marketWrap}>
          <div style={styles.marketRow}>
            {(() => {
              // Favoured side drives where the result ✓/✗ sits (the model never
              // picks the draw as its call, so only home/away can carry it).
              const favSide = (p.home ?? 0) >= (p.away ?? 0) ? "home" : "away";
              const winnerHit = fixture.grade?.grades?.winner?.hit;
              const cells = [
                { key: "home", label: teamCode(fixture.homeTeam), val: p.home, hit: favSide === "home" ? winnerHit : null, active: highlight === "win" && favSide === "home" },
                { key: "draw", label: "Draw", val: p.draw, hit: null, active: false },
                { key: "away", label: teamCode(fixture.awayTeam), val: p.away, hit: favSide === "away" ? winnerHit : null, active: highlight === "win" && favSide === "away" },
                { key: "over25", label: "O2.5", val: p.markets.over25, hit: fixture.grade?.grades?.over25?.hit, active: highlight === "over25" },
                { key: "btts", label: "BTTS", val: p.markets.btts, hit: fixture.grade?.grades?.btts?.hit, active: highlight === "btts" },
              ];
              return cells.map((c) => {
                const val = c.val ?? 0;
                const color = pctColor(val);
                return (
                  <div
                    key={c.key}
                    style={{
                      ...styles.marketPill,
                      background: tint(color),
                      ...(c.active ? { outline: `1px solid ${color}` } : {}),
                    }}
                  >
                    <span style={styles.marketLabel}>
                      {c.label}
                      {c.hit != null && (
                        <span style={{ color: c.hit ? "var(--win)" : "var(--loss)", marginLeft: 2 }}>
                          {c.hit ? "✓" : "✗"}
                        </span>
                      )}
                    </span>
                    <span style={{ ...styles.marketVal, color }}>{val}%</span>
                  </div>
                );
              });
            })()}
          </div>
          <div style={styles.teamGoals}>
            <TeamGoals
              name={fixture.homeTeam?.shortName || fixture.homeTeam?.name || "Home"}
              onePlus={p.markets.home1Plus}
              twoPlus={p.markets.home2Plus}
              highlightOne={highlight === "onePlus"}
              highlightTwo={highlight === "twoPlus"}
            />
            <TeamGoals
              name={fixture.awayTeam?.shortName || fixture.awayTeam?.name || "Away"}
              onePlus={p.markets.away1Plus}
              twoPlus={p.markets.away2Plus}
              highlightOne={highlight === "onePlus"}
              highlightTwo={highlight === "twoPlus"}
              last
            />
          </div>
        </div>
      )}

      {(canShowPlayers || canShowCorners || p?.markets) && (
        <div style={styles.actionRow}>
          {canShowPlayers && (
            <button
              style={{ ...styles.actionBtn, ...(showPlayers ? styles.actionBtnActive : {}) }}
              onClick={() => setShowPlayers((s) => !s)}
            >
              <span aria-hidden="true">👤</span> Players
            </button>
          )}
          {canShowCorners && (
            <button
              style={{ ...styles.actionBtn, ...(showCorners ? styles.actionBtnActive : {}) }}
              onClick={() => setShowCorners((s) => !s)}
            >
              <span aria-hidden="true">⛳</span> Corners
            </button>
          )}
          {p?.markets && (
            <button style={styles.actionBtn} onClick={() => setShowAnalysis(true)} aria-label="AI match analysis">
              <span aria-hidden="true">🧠</span> Analysis
            </button>
          )}
        </div>
      )}

      {canShowPlayers && showPlayers && (
        <PlayerPropsSection fixtureId={fixture.id} propsSeason={propsSeason} isWorldCup={isWorldCup} highlight={highlight} />
      )}

      {canShowCorners && showCorners && (
        <CornersSection fixture={fixture} />
      )}

      {open && p && <PredictionDetail prediction={p} fixture={fixture} />}
    </div>
  );
}

// Team corner markets, fetched lazily on first expand. Shows each side's
// first-half 2+/3+ corner probability and a projected full-match corner count.
function CornersSection({ fixture }) {
  const homeId = fixture.homeTeam?.id;
  const awayId = fixture.awayTeam?.id;
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["corners", fixture.id, homeId, awayId],
    queryFn: () => fetchCorners(fixture.id, homeId, awayId),
    staleTime: 30 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div style={styles.playerWrap}>
        <Spinner small />
      </div>
    );
  }
  if (isError) {
    return (
      <div style={styles.playerWrap}>
        <p style={styles.playerEmpty}>{error.message}</p>
      </div>
    );
  }
  if (!data) return null;
  if (!data.available) {
    return (
      <div style={styles.playerWrap}>
        <p style={styles.playerEmpty}>
          Not enough recent corner data for these teams yet.
        </p>
      </div>
    );
  }

  const c = data.prediction;
  const homeName = fixture.homeTeam?.shortName || fixture.homeTeam?.name || "Home";
  const awayName = fixture.awayTeam?.shortName || fixture.awayTeam?.name || "Away";

  return (
    <div style={styles.playerWrap}>
      <p style={styles.playerNote}>
        First-half 2+/3+ are modeled as ~47% of projected full-match corners — the
        feed has no per-half corner data, so treat them as directional.
      </p>
      <div style={styles.cornerHead}>
        <span style={styles.cornerHeadName} />
        <span style={styles.cornerHeadCell}>H1 2+</span>
        <span style={styles.cornerHeadCell}>H1 3+</span>
        <span style={styles.cornerHeadCell}>Full</span>
      </div>
      <CornerRow name={homeName} side={c.home} />
      <CornerRow name={awayName} side={c.away} />
      <div style={styles.cornerTotals}>
        <span>
          Projected match total <strong style={styles.cornerTotalVal}>{c.matchTotal}</strong>
        </span>
        <span style={styles.cornerTotalSub}>H1 ≈ {c.firstHalfTotal}</span>
        <span style={{ ...styles.confidence, ...confidenceStyle(c.confidence) }}>
          {c.confidence} confidence
        </span>
      </div>
    </div>
  );
}

function CornerRow({ name, side }) {
  const cell = (val, isPct) => {
    const color = isPct ? pctColor(val) : "var(--text)";
    return (
      <span
        style={{
          ...styles.cornerCell,
          ...(isPct ? { background: tint(pctColor(val)), color } : styles.cornerCellNum),
        }}
      >
        {isPct ? `${val}%` : val}
      </span>
    );
  };
  return (
    <div style={styles.cornerRow}>
      <span style={styles.cornerName}>{name}</span>
      {cell(side.fh2Plus, true)}
      {cell(side.fh3Plus, true)}
      {cell(side.full, false)}
    </div>
  );
}

// World Cup player props, fetched lazily on first expand. The backend fans out
// to one /players call per starter, so we only hit it when the user opens the
// section and let react-query cache the result.
function PlayerPropsSection({ fixtureId, propsSeason, isWorldCup, highlight }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["player-props", fixtureId, propsSeason],
    queryFn: () => fetchPlayerProps(fixtureId, propsSeason),
    staleTime: 30 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div style={styles.playerWrap}>
        <Spinner small />
      </div>
    );
  }
  if (isError) {
    return (
      <div style={styles.playerWrap}>
        <p style={styles.playerEmpty}>{error.message}</p>
      </div>
    );
  }
  if (!data) return null;

  if (!data.available) {
    return (
      <div style={styles.playerWrap}>
        <p style={styles.playerEmpty}>
          {data.reason || "Player props are not available yet."}
        </p>
      </div>
    );
  }

  const rateSeason = data.season ?? propsSeason;
  const seasonLabel = `${rateSeason}/${String((rateSeason + 1) % 100).padStart(2, "0")}`;
  const sides = [data.home, data.away].filter((s) => s && s.players?.length);

  return (
    <div style={styles.playerWrap}>
      <p style={styles.playerNote}>
        {data.projected
          ? (isWorldCup
              ? "Projected XI — the most-capped regulars, shown until the official lineup is released."
              : "Projected XI — the most-used players, shown until the official lineup is released.")
          : "Official starting lineup."}{" "}
        Each player's odds use their {seasonLabel}{isWorldCup ? " club-season" : ""} per-90 rates —
        guidance, not certainty.
      </p>
      <div className="pp-legend" style={styles.playerLegend}>
        <span style={styles.playerLegendName} />
        {PLAYER_MARKETS.map((m) => (
          <span key={m.key} className="pp-legend-cell" style={styles.playerLegendCell}>{m.label}</span>
        ))}
      </div>
      {sides.map((side) => (
        <div key={side.teamId} style={styles.playerSide}>
          <div style={styles.playerSideHead}>
            <span style={styles.playerSideName}>{side.teamName}</span>
            {side.formation && <span style={styles.playerFormation}>{side.formation}</span>}
          </div>
          {side.players.map((pl) => (
            <PlayerRow key={pl.id} player={pl} highlight={highlight} />
          ))}
        </div>
      ))}
    </div>
  );
}

function PlayerRow({ player, highlight }) {
  const props = player.props;
  return (
    <div className="pp-row" style={styles.playerRow}>
      <span style={styles.playerName}>
        {player.number != null && <span className="pp-num" style={styles.playerNum}>{player.number}</span>}
        <span className="pp-nametext" style={styles.playerNameText}>{player.name || "Unknown"}</span>
        {player.pos && <span className="pp-pos" style={styles.playerPos}>{player.pos}</span>}
        {player.pos && <span className="pp-pos-short" style={styles.playerPosShort}>{posCode(player.pos)}</span>}
      </span>
      {props
        ? PLAYER_MARKETS.map((m) => {
            const val = props[m.key] ?? 0;
            const color = pctColor(val);
            const active = highlight === m.key;
            return (
              <span
                key={m.key}
                className="pp-cell"
                style={{
                  ...styles.playerCell,
                  background: tint(color),
                  color,
                  ...(active ? { outline: `1px solid ${color}` } : {}),
                }}
              >
                {val}%
              </span>
            );
          })
        : PLAYER_MARKETS.map((m) => (
            <span key={m.key} className="pp-cell" style={{ ...styles.playerCell, ...styles.playerCellEmpty }}>–</span>
          ))}
    </div>
  );
}

function AnalysisModal({ fixture, league, prediction: p, onClose }) {
  const m = p.markets;
  const homeName = fixture.homeTeam?.shortName || fixture.homeTeam?.name || "Home";
  const awayName = fixture.awayTeam?.shortName || fixture.awayTeam?.name || "Away";
  const favName = m.winner === "home" ? homeName : awayName;

  // Each verdict is a positive call when the model's probability clears 50%.
  const verdicts = [
    { label: `${favName} to win the tie`, val: m.win },
    { label: `${homeName} to score 1+ goal`, val: m.home1Plus },
    { label: `${awayName} to score 1+ goal`, val: m.away1Plus },
    { label: "Both teams to score (BTTS)", val: m.btts },
    { label: "Over 2.5 goals", val: m.over25 },
  ];

  const positives = verdicts.filter((v) => v.val >= 50);
  const summary =
    positives.length === 0
      ? `A cagey, low-confidence call — none of the main markets clear 50%. ${favName} are marginal favourites.`
      : `The model leans ${favName} (${m.win}%). ` +
        positives
          .filter((v) => !v.label.includes("to win"))
          .map((v) => v.label.replace(" (BTTS)", ""))
          .join(", ")
          .replace(/,([^,]*)$/, " and$1") +
        (positives.some((v) => !v.label.includes("to win"))
          ? " look the strongest secondary angles."
          : "");

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={styles.modalHead}>
          <div style={styles.modalTitleWrap}>
            <span style={styles.modalCap}>🧠</span>
            <div>
              <div style={styles.modalTitle}>{homeName} vs {awayName}</div>
              {league && <div style={styles.modalSub}>{league.flag} {league.name}</div>}
            </div>
          </div>
          <button style={styles.modalClose} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={styles.modalVerdicts}>
          {verdicts.map((v) => {
            const good = v.val >= 50;
            return (
              <div key={v.label} style={styles.verdictRow}>
                <span style={styles.verdictIcon}>{good ? "✅" : "❌"}</span>
                <span style={styles.verdictLabel}>{v.label}</span>
                <span style={{ ...styles.verdictPct, color: pctColor(v.val) }}>{v.val}%</span>
              </div>
            );
          })}
        </div>

        <div style={styles.modalSummary}>
          <span style={styles.modalSummaryTitle}>Analysis</span>
          <p style={styles.modalSummaryText}>{summary}</p>
          {m.expectedGoals != null && (
            <p style={styles.modalSummaryText}>Projected total goals: <strong>{m.expectedGoals}</strong>.</p>
          )}
        </div>

        <div style={styles.modalFooter}>
          Generated from each team's recent form. Treat as guidance, not certainty —
          lineups can shift up to 30&nbsp;min before kickoff.
        </div>
      </div>
    </div>
  );
}

function TeamRow({ team, score }) {
  return (
    <div style={styles.teamRow}>
      {team?.logo && <img src={team.logo} alt="" width={18} height={18} style={styles.logo} onError={(e) => (e.target.style.visibility = "hidden")} />}
      <span style={styles.teamName}>{team?.name || "TBD"}</span>
      {score != null && <span style={styles.score}>{score}</span>}
    </div>
  );
}

function TeamGoals({ name, onePlus = 0, twoPlus = 0, highlightOne, highlightTwo, last }) {
  return (
    <div style={{ ...styles.teamGoalRow, ...(last ? {} : styles.teamGoalRowDivider) }}>
      <span style={styles.teamGoalName}>{name} <span style={styles.teamGoalSuffix}>to score</span></span>
      <div style={styles.teamGoalPills}>
        <GoalStat label="1+" val={onePlus} active={highlightOne} />
        <GoalStat label="2+" val={twoPlus} active={highlightTwo} />
      </div>
    </div>
  );
}

function GoalStat({ label, val = 0, active }) {
  const color = pctColor(val);
  return (
    <div style={{ ...styles.goalStat, background: tint(color), ...(active ? { outline: `1px solid ${color}` } : {}) }}>
      <span style={styles.goalStatLabel}>{label}</span>
      <span style={{ ...styles.goalStatVal, color }}>{val}%</span>
    </div>
  );
}

function PredictionDetail({ prediction: p, fixture }) {
  return (
    <div style={styles.predBody}>
      <div style={styles.probBar}>
        <div style={{ ...styles.probSeg, width: `${p.home}%`, background: "var(--win)" }} title={`Home ${p.home}%`} />
        <div style={{ ...styles.probSeg, width: `${p.draw}%`, background: "var(--draw)" }} title={`Draw ${p.draw}%`} />
        <div style={{ ...styles.probSeg, width: `${p.away}%`, background: "var(--loss)" }} title={`Away ${p.away}%`} />
      </div>
      <div style={styles.probLabels}>
        <span>Home {p.home}%</span>
        <span>Draw {p.draw}%</span>
        <span>Away {p.away}%</span>
      </div>

      <div style={styles.formRow}>
        <FormBadges label={fixture.homeTeam?.shortName || "Home"} form={p.homeForm} />
        <div style={styles.centerMeta}>
          <span style={{ ...styles.confidence, ...confidenceStyle(p.confidence) }}>{p.confidence} confidence</span>
          {p.markets?.expectedGoals != null && (
            <span style={styles.xg}>xG {p.markets.expectedGoals}</span>
          )}
        </div>
        <FormBadges label={fixture.awayTeam?.shortName || "Away"} form={p.awayForm} align="right" />
      </div>
    </div>
  );
}

function FormBadges({ label, form = [], align }) {
  return (
    <div style={{ ...styles.formGroup, alignItems: align === "right" ? "flex-end" : "flex-start" }}>
      <span style={styles.formLabel}>{label}</span>
      <div style={styles.badges}>
        {form.length === 0 && <span style={styles.formLabel}>no data</span>}
        {form.map((r, i) => (
          <span key={i} style={{ ...styles.badge, ...badgeStyle(r) }}>{r}</span>
        ))}
      </div>
    </div>
  );
}

function badgeStyle(r) {
  if (r === "W") return { background: "var(--win)", color: "#06231a" };
  if (r === "L") return { background: "var(--loss)", color: "#2a0a07" };
  return { background: "var(--draw)", color: "#2a2406" };
}

function confidenceStyle(c) {
  if (c === "high") return { color: "var(--win)", borderColor: "var(--win)" };
  if (c === "medium") return { color: "var(--draw)", borderColor: "var(--draw)" };
  return { color: "var(--text3)", borderColor: "var(--border)" };
}

function Spinner({ small }) {
  const size = small ? 18 : 28;
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
      <div style={{ width: size, height: size, border: "3px solid var(--border)", borderTopColor: "var(--accent)", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
    </div>
  );
}

const styles = {
  page: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  dateBar: { display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: "14px 24px", borderBottom: "1px solid var(--border)" },
  navBtn: { fontSize: 22, color: "var(--text2)", padding: "2px 14px", borderRadius: 8, background: "var(--bg2)" },
  navBtnDisabled: { opacity: 0.3, cursor: "not-allowed" },
  dateLabel: { position: "relative", display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 15, minWidth: 180, justifyContent: "center", color: "var(--text)", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 8, padding: "6px 14px", cursor: "pointer" },
  dateLabelIcon: { fontSize: 13, opacity: 0.8 },
  dateInput: { position: "absolute", left: "50%", bottom: 0, width: 1, height: 1, opacity: 0, border: "none", padding: 0, pointerEvents: "none" },
  todayTag: { fontSize: 11, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 4, padding: "1px 6px" },
  filterBar: { display: "flex", alignItems: "center", gap: 8, padding: "10px 24px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" },
  filterLabel: { fontSize: 12, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5, marginRight: 2 },
  filterChip: { fontSize: 13, color: "var(--text2)", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 16, padding: "4px 12px" },
  filterChipActive: { background: "var(--accent)", color: "#04121f", borderColor: "var(--accent)", fontWeight: 600 },
  filterHint: { fontSize: 12, color: "var(--text3)" },
  note: { display: "flex", alignItems: "flex-start", gap: 6, padding: "8px 24px", fontSize: 12, color: "var(--text3)", borderBottom: "1px solid var(--border)", lineHeight: 1.45 },
  list: { flex: 1, overflowY: "auto", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 780, width: "100%", margin: "0 auto" },
  empty: { color: "var(--text3)", textAlign: "center", padding: 40 },
  error: { color: "var(--loss)", textAlign: "center", padding: 20 },
  leagueGroup: { display: "flex", flexDirection: "column", gap: 10 },
  groupHeader: { display: "flex", alignItems: "center", gap: 8, padding: "2px 2px 4px" },
  groupTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--text)" },
  groupCount: { fontSize: 12, color: "var(--text3)", background: "var(--bg3)", borderRadius: 10, padding: "1px 8px" },
  card: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", flexShrink: 0 },
  cardLeague: { display: "flex", alignItems: "center", gap: 6, padding: "6px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg3)" },
  cardLeagueName: { fontSize: 11, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  cardHead: { display: "flex", alignItems: "center", gap: 16, padding: "12px 16px", width: "100%", textAlign: "left" },
  kickoff: { fontSize: 13, color: "var(--text3)", width: 44, flexShrink: 0 },
  teams: { flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
  teamRow: { display: "flex", alignItems: "center", gap: 8 },
  logo: { flexShrink: 0, objectFit: "contain" },
  teamName: { fontSize: 14, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  score: { fontSize: 14, fontWeight: 700, color: "var(--text)" },
  chevron: { fontSize: 10, color: "var(--text3)", flexShrink: 0 },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 },
  modal: { background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, width: "100%", maxWidth: 440, maxHeight: "85vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.5)" },
  modalHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "16px 18px", borderBottom: "1px solid var(--border)" },
  modalTitleWrap: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  modalCap: { fontSize: 22, flexShrink: 0 },
  modalTitle: { fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, color: "var(--text)" },
  modalSub: { fontSize: 12, color: "var(--text3)", marginTop: 2 },
  modalClose: { fontSize: 16, color: "var(--text2)", padding: "2px 8px", borderRadius: 6, background: "var(--bg3)", flexShrink: 0 },
  modalVerdicts: { display: "flex", flexDirection: "column", padding: "10px 18px" },
  verdictRow: { display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--border)" },
  verdictIcon: { fontSize: 15, flexShrink: 0, width: 20, textAlign: "center" },
  verdictLabel: { flex: 1, fontSize: 14, color: "var(--text)", minWidth: 0 },
  verdictPct: { fontSize: 14, fontWeight: 700, flexShrink: 0 },
  modalSummary: { padding: "12px 18px", background: "var(--bg3)", margin: "4px 14px", borderRadius: 10 },
  modalSummaryTitle: { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5 },
  modalSummaryText: { fontSize: 13, color: "var(--text2)", lineHeight: 1.5, marginTop: 5 },
  modalFooter: { fontSize: 11, color: "var(--text3)", padding: "12px 18px", lineHeight: 1.45 },
  marketWrap: { display: "flex", flexDirection: "column", gap: 8, padding: "0 16px 12px" },
  marketRow: { display: "flex", gap: 5, flexWrap: "wrap" },
  marketPill: { flex: "1 1 0", minWidth: 52, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, padding: "5px 3px", borderRadius: 7 },
  marketLabel: { fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.3, whiteSpace: "nowrap" },
  marketVal: { fontSize: 14, fontWeight: 700 },
  teamGoals: { display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" },
  teamGoalRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 11px" },
  teamGoalRowDivider: { borderBottom: "1px solid var(--border)" },
  teamGoalName: { fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 },
  teamGoalSuffix: { color: "var(--text3)", fontSize: 12 },
  teamGoalPills: { display: "flex", gap: 6, flexShrink: 0 },
  goalStat: { display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: 6, minWidth: 64, justifyContent: "center" },
  goalStatLabel: { fontSize: 10, color: "var(--text3)", textTransform: "uppercase" },
  goalStatVal: { fontSize: 13, fontWeight: 700 },
  predBody: { borderTop: "1px solid var(--border)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 },
  probBar: { display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "var(--bg3)" },
  probSeg: { height: "100%" },
  probLabels: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text2)" },
  formRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  centerMeta: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  xg: { fontSize: 11, color: "var(--text3)" },
  formGroup: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
  formLabel: { fontSize: 11, color: "var(--text3)" },
  badges: { display: "flex", gap: 3, flexWrap: "wrap" },
  badge: { width: 18, height: 18, borderRadius: 4, fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  confidence: { fontSize: 11, textTransform: "capitalize", border: "1px solid", borderRadius: 6, padding: "3px 8px", whiteSpace: "nowrap" },
  actionRow: { display: "flex", gap: 6, padding: "0 16px 12px" },
  actionBtn: { flex: "1 1 0", display: "flex", alignItems: "center", justifyContent: "center", gap: 5, fontSize: 12, color: "var(--text2)", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 6px" },
  actionBtnActive: { color: "var(--accent)", borderColor: "var(--accent)", background: "var(--bg2)" },
  playerWrap: { borderTop: "1px solid var(--border)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 },
  playerNote: { fontSize: 11, color: "var(--text3)", lineHeight: 1.45, margin: 0 },
  playerEmpty: { fontSize: 12, color: "var(--text3)", textAlign: "center", padding: "8px 0", margin: 0 },
  playerLegend: { display: "flex", alignItems: "center", gap: 6, padding: "0 2px" },
  playerLegendName: { flex: 1, minWidth: 0 },
  playerLegendCell: { width: 44, textAlign: "center", fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, flexShrink: 0 },
  playerSide: { display: "flex", flexDirection: "column", gap: 4 },
  playerSideHead: { display: "flex", alignItems: "center", gap: 8, marginTop: 4 },
  playerSideName: { fontSize: 12, fontWeight: 700, color: "var(--text)" },
  playerFormation: { fontSize: 10, color: "var(--text3)", background: "var(--bg3)", borderRadius: 10, padding: "1px 7px" },
  playerRow: { display: "flex", alignItems: "center", gap: 6, padding: "4px 2px", borderBottom: "1px solid var(--border)" },
  playerName: { flex: 1, display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  playerNum: { fontSize: 10, color: "var(--text3)", width: 16, textAlign: "center", flexShrink: 0 },
  playerNameText: { fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  playerPos: { fontSize: 9, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px", flexShrink: 0 },
  playerPosShort: { display: "none", fontSize: 9, fontWeight: 700, color: "var(--text3)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 3px", flexShrink: 0, lineHeight: "14px" },
  playerCell: { width: 44, textAlign: "center", fontSize: 12, fontWeight: 700, padding: "3px 0", borderRadius: 6, flexShrink: 0 },
  playerCellEmpty: { color: "var(--text3)", fontWeight: 400, background: "var(--bg3)" },
  cornerHead: { display: "flex", alignItems: "center", gap: 6, padding: "0 2px" },
  cornerHeadName: { flex: 1, minWidth: 0 },
  cornerHeadCell: { width: 52, textAlign: "center", fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.4, flexShrink: 0 },
  cornerRow: { display: "flex", alignItems: "center", gap: 6, padding: "5px 2px", borderBottom: "1px solid var(--border)" },
  cornerName: { flex: 1, fontSize: 13, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 },
  cornerCell: { width: 52, textAlign: "center", fontSize: 12, fontWeight: 700, padding: "3px 0", borderRadius: 6, flexShrink: 0 },
  cornerCellNum: { background: "var(--bg3)", color: "var(--text)" },
  cornerTotals: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4, fontSize: 12, color: "var(--text2)" },
  cornerTotalVal: { color: "var(--text)", fontSize: 14 },
  cornerTotalSub: { fontSize: 11, color: "var(--text3)" },
};

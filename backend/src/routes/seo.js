// Server-rendered, crawlable SEO pages for search engines and AI answer engines.
//
// The app itself is a client-rendered SPA (bots see an empty shell), so these
// routes emit real HTML — a per-league page and an index hub — with the day's
// fixtures + predictions as TEXT, structured data, and internal links. They pull
// data by self-fetching the existing /api endpoints (so they reuse the same
// cache), and they're edge-cached themselves. They link into the live app; they
// are not the app.
import { Router } from "express";
import { LEAGUES, LEAGUES_BY_ID } from "../data/leagues.js";

const router = Router();

const SITE = "FootForm";

// slug helpers ---------------------------------------------------------------
export function slugify(s) {
  return String(s)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
// country+name keeps it unique (several leagues share a name).
export function leagueSlug(l) {
  return `${slugify(l.country)}-${slugify(l.name)}`;
}
const SLUG_TO_ID = Object.fromEntries(LEAGUES.map((l) => [leagueSlug(l), l.id]));

// Match page slug: "home-vs-away-<fixtureId>" — the trailing id is what we parse
// back out to look the fixture up.
export function matchSlug(fx) {
  return `${slugify(fx.homeTeam?.name || "home")}-vs-${slugify(fx.awayTeam?.name || "away")}-${fx.id}`;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function baseUrl(req) {
  const host = req.headers.host || "football-app-six.vercel.app";
  const proto = req.headers["x-forwarded-proto"] || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

function ymdUTC(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Shared <head> + shell styling (minimal, self-contained, theme-matched).
function page({ title, description, canonical, jsonLd, body, base }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${esc(canonical)}" />
<meta name="robots" content="index, follow" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="${SITE}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:image" content="${base}/og-image.jpg" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
<style>
:root{color-scheme:dark}
body{margin:0;background:#060F1C;color:#e6edf3;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:24px 20px 64px}
a{color:#2ecc71;text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:8px;padding:16px 20px;border-bottom:1px solid #16222f}
header .brand{font-weight:800;font-size:20px;color:#fff}
h1{font-size:26px;margin:24px 0 6px}
.sub{color:#9fb3c8;margin:0 0 20px}
.m{background:#0c1622;border:1px solid #16222f;border-radius:12px;padding:14px 16px;margin:10px 0}
.m .t{font-weight:700;color:#fff}
.m .p{color:#9fb3c8;font-size:14px;margin-top:6px}
.m .p b{color:#e6edf3}
.cta{display:inline-block;margin:20px 0;background:#2ecc71;color:#04121f;font-weight:700;padding:10px 16px;border-radius:8px}
.grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.chip{background:#0c1622;border:1px solid #16222f;border-radius:8px;padding:6px 10px;font-size:14px}
.foot{color:#6b8299;font-size:12px;margin-top:32px;border-top:1px solid #16222f;padding-top:16px}
</style>
</head>
<body>
<header><span class="brand">⚽ ${SITE}</span> <span style="color:#6b8299">· Football predictions</span></header>
<div class="wrap">
${body}
<p class="foot">Predictions are model estimates, updated continuously and may change up to ~30 minutes before kickoff. Estimates only — not betting advice.</p>
</div>
</body>
</html>`;
}

// A team-vs-team line with the model's read, as plain crawlable text, linking to
// the dedicated match page.
function fixtureLine(fx, leagueSlugStr) {
  const p = fx.prediction;
  const h = esc(fx.homeTeam?.name || "Home");
  const a = esc(fx.awayTeam?.name || "Away");
  const href = leagueSlugStr ? `/league/${leagueSlugStr}/${matchSlug(fx)}` : null;
  const title = href ? `<a class="t" href="${href}">${h} vs ${a}</a>` : `<span class="t">${h} vs ${a}</span>`;
  if (!p || p.home == null) return `<div class="m">${title}</div>`;
  const m = p.markets || {};
  return `<div class="m">${title}` +
    `<div class="p">${h} win <b>${p.home}%</b> · Draw <b>${p.draw}%</b> · ${a} win <b>${p.away}%</b>` +
    (m.over15 != null ? ` · Over 1.5 <b>${m.over15}%</b>` : "") +
    (m.over25 != null ? ` · Over 2.5 <b>${m.over25}%</b>` : "") +
    (m.btts != null ? ` · Both teams to score <b>${m.btts}%</b>` : "") +
    `</div></div>`;
}

// SportsEvent JSON-LD for the day's fixtures (helps rich results + AEO).
function fixturesJsonLd(fixtures, leagueName) {
  const items = fixtures
    .filter((f) => f.homeTeam?.name && f.awayTeam?.name && f.startTimestamp)
    .slice(0, 30)
    .map((f) => ({
      "@type": "SportsEvent",
      name: `${f.homeTeam.name} vs ${f.awayTeam.name}`,
      startDate: new Date(f.startTimestamp * 1000).toISOString(),
      sport: "Soccer",
      homeTeam: { "@type": "SportsTeam", name: f.homeTeam.name },
      awayTeam: { "@type": "SportsTeam", name: f.awayTeam.name },
      superEvent: { "@type": "SportsOrganization", name: leagueName },
    }));
  if (!items.length) return null;
  return JSON.stringify({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, item: it })) });
}

// Index hub: every league, grouped by country, linking to its page. Pure static
// (from the league list), so it always has crawlable content + internal links.
router.get("/leagues", (req, res) => {
  const base = baseUrl(req);
  const byCountry = {};
  for (const l of LEAGUES) (byCountry[l.country] ||= []).push(l);
  const sections = Object.entries(byCountry)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([country, ls]) =>
      `<h2 style="font-size:18px;margin:20px 0 8px">${esc(country)}</h2><div class="grid">` +
      ls.map((l) => `<a class="chip" href="/league/${leagueSlug(l)}">${esc(l.flag)} ${esc(l.name)}</a>`).join("") +
      `</div>`
    ).join("");
  const body = `<h1>Football leagues &amp; predictions</h1>
<p class="sub">Model-based match predictions across ${LEAGUES.length}+ leagues worldwide. Pick a league:</p>
${sections}
<a class="cta" href="/">Open the live app →</a>`;
  res.set("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
  res.type("html").send(page({
    base,
    title: `Football leagues & predictions across ${LEAGUES.length}+ competitions | ${SITE}`,
    description: `Browse model-based football predictions for ${LEAGUES.length}+ leagues worldwide — win probability, over/under, both teams to score and more.`,
    canonical: `${base}/leagues`,
    body,
  }));
});

// Per-league page: today's fixtures + predictions as crawlable text.
router.get("/league/:slug", async (req, res) => {
  const id = SLUG_TO_ID[req.params.slug];
  const league = id && LEAGUES_BY_ID[id];
  if (!league) return res.status(404).type("html").send(page({
    base: baseUrl(req), title: `League not found | ${SITE}`, description: "League not found.",
    canonical: `${baseUrl(req)}/leagues`,
    body: `<h1>League not found</h1><p><a href="/leagues">See all leagues →</a></p>`,
  }));

  const base = baseUrl(req);
  const today = ymdUTC();
  // Show the nearest upcoming match-day so the page always has real content (most
  // leagues don't play every day). /range finds the next date with fixtures; the
  // per-day /fixtures call is what carries the predictions.
  let date = today;
  let fixtures = [];
  try {
    const rangeR = await fetch(`${base}/api/fixtures/${id}/range?days=14&tz=UTC`);
    if (rangeR.ok) {
      const days = (await rangeR.json()).days || {};
      const nextDate = Object.keys(days).sort().find((d) => d >= today && (days[d] || []).length > 0);
      if (nextDate) date = nextDate;
    }
    const r = await fetch(`${base}/api/fixtures/${id}?date=${date}&tz=UTC`);
    if (r.ok) fixtures = (await r.json()).fixtures || [];
  } catch { /* render without fixtures on failure */ }

  const name = league.name;
  const when = date === today
    ? "today"
    : new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const lines = fixtures.map((fx) => fixtureLine(fx, req.params.slug)).join("");
  const body = `<p style="color:#6b8299;font-size:13px"><a href="/leagues">All leagues</a> › ${esc(league.country)}</p>
<h1>${esc(league.flag)} ${esc(name)} predictions</h1>
<p class="sub">${esc(league.country)} · ${lines ? `fixtures ${esc(when)}` : "upcoming fixtures"} with model win probabilities, over/under 1.5 &amp; 2.5 goals and both teams to score.</p>
${lines || `<p>No ${esc(name)} matches in the next two weeks. Check the live app for the latest fixtures.</p>`}
<a class="cta" href="/?league=${esc(id)}&date=${esc(date)}">Open ${esc(name)} in the live app →</a>`;

  res.set("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
  res.type("html").send(page({
    base,
    title: `${name} predictions — today's fixtures & odds insight | ${SITE}`,
    description: `Today's ${name} (${league.country}) match predictions: win probability, over/under 1.5 & 2.5 goals, and both teams to score. Model estimates, updated continuously.`,
    canonical: `${base}/league/${req.params.slug}`,
    jsonLd: fixturesJsonLd(fixtures, name),
    body,
  }));
});

// Per-match page: one fixture's full prediction as crawlable text + SportsEvent
// structured data. Nested under its league so it reuses the league's cached data
// (find the match's date via /range, then that day's /fixtures carries the
// prediction). This is the long-tail: a page per "home vs away prediction".
router.get("/league/:slug/:matchSlug", async (req, res) => {
  const base = baseUrl(req);
  const id = SLUG_TO_ID[req.params.slug];
  const league = id && LEAGUES_BY_ID[id];
  const fixtureId = (req.params.matchSlug.match(/(\d+)$/) || [])[1];
  const notFound = (msg) => res.status(404).type("html").send(page({
    base, title: `Match not found | ${SITE}`, description: "Match not found.",
    canonical: `${base}/leagues`,
    body: `<h1>Match not found</h1><p>${esc(msg)}</p><p>${league ? `<a href="/league/${req.params.slug}">See ${esc(league.name)} fixtures →</a>` : `<a href="/leagues">All leagues →</a>`}</p>`,
  }));
  if (!league || !fixtureId) return notFound("This match link isn't valid.");

  let fx = null, date = null;
  try {
    const rangeR = await fetch(`${base}/api/fixtures/${id}/range?days=21&tz=UTC`);
    if (rangeR.ok) {
      const days = (await rangeR.json()).days || {};
      for (const [d, list] of Object.entries(days)) {
        if ((list || []).some((f) => String(f.id) === fixtureId)) { date = d; break; }
      }
    }
    if (date) {
      const r = await fetch(`${base}/api/fixtures/${id}?date=${date}&tz=UTC`);
      if (r.ok) fx = ((await r.json()).fixtures || []).find((f) => String(f.id) === fixtureId);
    }
  } catch { /* fall through to not-found */ }

  if (!fx) return notFound("This match may have already been played or isn't scheduled in the next few weeks.");

  const h = esc(fx.homeTeam?.name || "Home");
  const a = esc(fx.awayTeam?.name || "Away");
  const p = fx.prediction || {};
  const m = p.markets || {};
  const ko = fx.startTimestamp ? new Date(fx.startTimestamp * 1000) : null;
  const koText = ko ? ko.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "TBC";

  const rows = [];
  if (p.home != null) rows.push(`<div class="p">Match result — ${h} <b>${p.home}%</b> · Draw <b>${p.draw}%</b> · ${a} <b>${p.away}%</b></div>`);
  if (m.over15 != null) rows.push(`<div class="p">Over 1.5 goals <b>${m.over15}%</b> · Over 2.5 goals <b>${m.over25}%</b></div>`);
  if (m.btts != null) rows.push(`<div class="p">Both teams to score <b>${m.btts}%</b></div>`);
  if (m.home1Plus != null) rows.push(`<div class="p">${h} to score <b>${m.home1Plus}%</b> (2+ <b>${m.home2Plus}%</b>) · ${a} to score <b>${m.away1Plus}%</b> (2+ <b>${m.away2Plus}%</b>)</div>`);
  if (m.expectedGoals != null) rows.push(`<div class="p">Expected goals <b>${m.expectedGoals}</b></div>`);

  const fav = p.home != null ? (p.home >= p.away && p.home >= p.draw ? h + " are favourites" : p.away >= p.draw ? a + " are favourites" : "a draw is most likely") : null;
  const lead = fav
    ? `Our model makes ${fav} in this ${esc(league.name)} fixture` + (p.home != null ? ` — ${h} ${p.home}%, draw ${p.draw}%, ${a} ${p.away}%.` : ".")
    : `Model prediction for ${h} vs ${a} in the ${esc(league.name)}.`;

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org", "@type": "SportsEvent",
    name: `${fx.homeTeam?.name} vs ${fx.awayTeam?.name}`,
    sport: "Soccer",
    ...(ko ? { startDate: ko.toISOString() } : {}),
    homeTeam: { "@type": "SportsTeam", name: fx.homeTeam?.name },
    awayTeam: { "@type": "SportsTeam", name: fx.awayTeam?.name },
    superEvent: { "@type": "SportsOrganization", name: league.name },
  });

  const body = `<p style="color:#6b8299;font-size:13px"><a href="/leagues">All leagues</a> › <a href="/league/${req.params.slug}">${esc(league.flag)} ${esc(league.name)}</a> › ${h} vs ${a}</p>
<h1>${h} vs ${a} prediction</h1>
<p class="sub">${esc(league.name)} · ${esc(koText)}</p>
<p>${lead}</p>
<div class="m">${rows.join("") || "<div class='p'>Prediction not available yet.</div>"}</div>
<a class="cta" href="/?league=${esc(id)}&date=${esc(date)}&match=${esc(fixtureId)}">Open this match in the live app →</a>`;

  res.set("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
  res.type("html").send(page({
    base,
    title: `${fx.homeTeam?.name} vs ${fx.awayTeam?.name} prediction — ${league.name} | ${SITE}`,
    description: `${fx.homeTeam?.name} vs ${fx.awayTeam?.name} (${league.name}) prediction` + (p.home != null ? `: ${fx.homeTeam?.name} win ${p.home}%, draw ${p.draw}%, ${fx.awayTeam?.name} win ${p.away}%` : "") + (m.over25 != null ? `, over 2.5 ${m.over25}%, BTTS ${m.btts}%` : "") + ". Model estimate — not betting advice.",
    canonical: `${base}/league/${req.params.slug}/${req.params.matchSlug}`,
    jsonLd,
    body,
  }));
});

// --- Shareable VIP prediction pages -----------------------------------------
// /predict is a search box; searching resolves the fixture and lands on a unique,
// shareable /predict/<home>-vs-<away> page rendering the VIP model's most likely
// betting events with bookmaker odds. Server-rendered so links preview + load
// instantly. The engine is /api/predict (see predict.js) — the established VIP
// logic reached by team name.
// Private gate for the /predict pages — same code as the app's other tools, held
// server-side only. A correct entry sets a short-lived httpOnly cookie the server
// reads on later requests; the pages also forward the code to the (gated) engine.
const TOOLS_PASS = process.env.ODDS_GEN_PASS || "1211";
function toolsAuthed(req) {
  const c = (req.headers.cookie || "").match(/(?:^|;\s*)ff_tools=([^;]+)/);
  const fromCookie = c ? decodeURIComponent(c[1]) : "";
  return fromCookie === TOOLS_PASS || (req.get("x-odds-pass") || req.query.pass || "") === TOOLS_PASS;
}
const safeNext = (n) => (typeof n === "string" && (n.startsWith("/predict") || n.startsWith("/scan")) ? n : "/predict");
function unlockPage(req, { next, error } = {}) {
  const base = baseUrl(req);
  return page({
    base, title: `Enter access code | ${SITE}`, description: "This tool is private.",
    canonical: `${base}/predict`,
    body: `<h1>🔒 Private</h1>
<p class="sub">This prediction tool is private. Enter the access code to continue.</p>
<form action="/predict/unlock" method="post" style="display:flex;gap:8px;margin:16px 0;flex-wrap:wrap;max-width:360px">
<input type="password" name="code" inputmode="numeric" autofocus placeholder="Access code" aria-label="Access code"
 style="flex:1;min-width:150px;background:#0c1622;border:1px solid #16222f;color:#e6edf3;border-radius:8px;padding:12px 13px;font-size:16px;letter-spacing:4px;text-align:center" />
<input type="hidden" name="next" value="${esc(safeNext(next))}" />
<button style="background:#2ecc71;color:#04121f;font-weight:700;border:none;border-radius:8px;padding:12px 20px;font-size:15px;cursor:pointer">Unlock</button>
</form>
${error ? `<p style="color:#e74c3c;font-size:13px;margin:0">${esc(error)}</p>` : ""}`,
  });
}

router.post("/predict/unlock", (req, res) => {
  const code = String(req.body?.code || "");
  const next = safeNext(req.body?.next);
  if (code === TOOLS_PASS) {
    res.cookie("ff_tools", TOOLS_PASS, { maxAge: 30 * 24 * 3600 * 1000, httpOnly: true, sameSite: "lax", path: "/" });
    return res.redirect(302, next);
  }
  res.status(401).type("html").send(unlockPage(req, { next, error: "Incorrect code." }));
});

function searchForm(q = "") {
  return `<form action="/predict" method="get" style="display:flex;gap:8px;margin:16px 0;flex-wrap:wrap">
<input name="q" value="${esc(q)}" placeholder="e.g. Arsenal vs Chelsea" aria-label="Fixture"
 style="flex:1;min-width:220px;background:#0c1622;border:1px solid #16222f;color:#e6edf3;border-radius:8px;padding:11px 13px;font-size:15px" />
<button style="background:#2ecc71;color:#04121f;font-weight:700;border:none;border-radius:8px;padding:11px 20px;font-size:15px;cursor:pointer">Predict →</button>
</form>`;
}

// Split "Arsenal vs Chelsea" / "Arsenal v Chelsea" / "Arsenal - Chelsea".
function parseFixtureQuery(q) {
  const parts = String(q).split(/\s+(?:vs?\.?|[-–—])\s+/i);
  return { home: (parts[0] || "").trim(), away: (parts[1] || "").trim() };
}

router.get("/predict", async (req, res) => {
  const base = baseUrl(req);
  if (!toolsAuthed(req)) return res.type("html").send(unlockPage(req, { next: req.originalUrl }));
  const q = String(req.query.q || "").trim();
  if (q) {
    const { home, away } = parseFixtureQuery(q);
    if (home && away) return res.redirect(302, `/predict/${slugify(home)}-vs-${slugify(away)}`);
    return res.type("html").send(page({
      base, title: `Match prediction | ${SITE}`, description: "Enter a fixture to get the VIP model's most likely betting events.",
      canonical: `${base}/predict`,
      body: `<h1>⚡ Match prediction</h1>${searchForm(q)}<p class="sub">Couldn't read that — enter a fixture like <b>Arsenal vs Chelsea</b>.</p>`,
    }));
  }
  res.set("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
  res.type("html").send(page({
    base,
    title: `Match prediction — most likely betting events for any fixture | ${SITE}`,
    description: `Enter any football fixture and get the VIP model's most likely betting events — win, goals, both teams to score and more — ranked by confidence with bookmaker odds.`,
    canonical: `${base}/predict`,
    body: `<h1>⚡ Match prediction</h1>
<p class="sub">Type a fixture and get the VIP model's most likely betting events, ranked by confidence with bookmaker odds.</p>
${searchForm()}
<div class="grid">
<a class="chip" href="/predict?q=${encodeURIComponent("Arsenal vs Chelsea")}">Arsenal vs Chelsea</a>
<a class="chip" href="/predict?q=${encodeURIComponent("Real Madrid vs Barcelona")}">Real Madrid vs Barcelona</a>
<a class="chip" href="/predict?q=${encodeURIComponent("Inter vs Juventus")}">Inter vs Juventus</a>
</div>`,
  }));
});

router.get("/predict/:slug", async (req, res) => {
  const base = baseUrl(req);
  if (!toolsAuthed(req)) return res.type("html").send(unlockPage(req, { next: req.originalUrl }));
  const { home, away } = (() => {
    const p = req.params.slug.split("-vs-");
    return { home: (p[0] || "").replace(/-/g, " ").trim(), away: (p[1] || "").replace(/-/g, " ").trim() };
  })();
  const backForm = (q) => searchForm(q);
  const fail = (msg, code = 404) => res.status(code).type("html").send(page({
    base, title: `Match prediction | ${SITE}`, description: msg, canonical: `${base}/predict`,
    body: `<h1>Match prediction</h1>${backForm(home && away ? `${home} vs ${away}` : "")}<p class="sub">${esc(msg)}</p><p><a href="/predict">Try another fixture →</a></p>`,
  }));
  if (!home || !away) return fail("Enter a fixture like 'Arsenal vs Chelsea'.");

  let data;
  try {
    const r = await fetch(`${base}/api/predict?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}&tz=UTC`, {
      headers: { "x-odds-pass": TOOLS_PASS },
    });
    data = await r.json().catch(() => ({}));
    if (!r.ok) return fail(data.error || "Couldn't build this prediction.", r.status === 500 ? 500 : 404);
  } catch {
    return fail("Couldn't build this prediction right now — try again shortly.", 502);
  }

  const { match, events = [], recommended, analysisPath, vip } = data;
  const h = esc(match.home), a = esc(match.away);
  const ko = match.kickoff
    ? new Date(match.kickoff * 1000).toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"
    : "Kickoff TBC";

  const odds = (e) => (e.bookOdds ? ` · book <b>@${e.bookOdds.toFixed(2)}</b>${e.bookmaker ? ` (${esc(e.bookmaker)})` : ""}` : "");
  const evRow = (e, top) => `<div class="m"${top ? ' style="border-color:#2ecc71"' : ""}>
<div class="t">${esc(e.selection)}${top ? ' <span style="color:#2ecc71;font-size:12px;font-weight:700">◆ most likely</span>' : ""}</div>
<div class="p"><b>${e.probability}%</b> confidence${odds(e)} · ${esc(e.market)}</div>
</div>`;

  const canonical = `${base}/predict/${slugify(match.home)}-vs-${slugify(match.away)}`;
  const topLine = recommended
    ? `${recommended.selection} — ${recommended.probability}%${recommended.bookOdds ? ` @${recommended.bookOdds.toFixed(2)}` : ""}`
    : "see the ranked events";

  const body = `<p style="color:#6b8299;font-size:13px"><a href="/predict">← New prediction</a></p>
<h1>${h} vs ${a}</h1>
<p class="sub">${esc(match.leagueFlag)} ${esc(match.league)} · ${esc(ko)}${vip ? "" : " · below the VIP confidence floor — showing the model's read"}</p>
${searchForm(`${match.home} vs ${match.away}`)}
<h2 style="font-size:16px;margin:20px 0 6px">Most likely events</h2>
${events.length ? events.map((e, i) => evRow(e, i === 0)).join("") : "<p class='sub'>No qualifying events for this fixture right now.</p>"}
${analysisPath ? `<a class="cta" href="${esc(analysisPath)}">Full fixture analysis →</a>` : ""}`;

  res.set("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
  res.type("html").send(page({
    base,
    title: `${match.home} vs ${match.away} — prediction & top betting events | ${SITE}`,
    description: `${match.home} vs ${match.away} (${match.league}): most likely — ${topLine}. VIP model's ranked betting events with bookmaker odds. Estimates only — not betting advice.`,
    canonical,
    body,
  }));
});

// --- Shareable 2+ Goals Scan pages ------------------------------------------
// /scan is a league picker; picking one lands on a unique, shareable
// /scan/<id>-<league> page rendering that league's "team to score 2+ goals" read:
// today's upcoming picks with bookmaker odds, plus the model's backtested hit rate
// over recent finished matches. Server-rendered so links preview + load instantly.
// The engine is /api/team-2plus/scan (see fixtures.js) — the same scanner the app
// uses. Gated by the same ff_tools cookie / code as /predict.
const scanUrl = (l) => `/scan/${l.id}-${leagueSlug(l)}`;

// Adjacent day in UTC (n = -1 / +1), as YYYY-MM-DD.
function shiftYmd(ymd, n) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return ymdUTC(dt);
}
const prettyUtc = (ymd) => {
  const [y, m, d] = String(ymd).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
};

router.get("/scan", async (req, res) => {
  const base = baseUrl(req);
  if (!toolsAuthed(req)) return res.type("html").send(unlockPage(req, { next: req.originalUrl }));

  // Picking a league (GET form or a chip) lands on its own shareable page.
  const picked = LEAGUES_BY_ID[String(req.query.league || "").trim()];
  if (picked) return res.redirect(302, scanUrl(picked));

  const byCountry = LEAGUES.reduce((acc, l) => { (acc[l.country] ||= []).push(l); return acc; }, {});
  const options = Object.entries(byCountry)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([country, ls]) =>
      `<optgroup label="${esc(country)}">` +
      ls.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("") +
      `</optgroup>`).join("");
  const popular = ["39", "140", "135", "78", "61", "71"].map((id) => LEAGUES_BY_ID[id]).filter(Boolean);

  res.set("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
  res.type("html").send(page({
    base,
    title: `2+ goals scan — team to score 2+ picks by league | ${SITE}`,
    description: `Pick a league to see the model's "team to score 2+ goals" picks for upcoming fixtures with bookmaker odds, plus its backtested hit rate.`,
    canonical: `${base}/scan`,
    body: `<h1>📊 2+ goals scan</h1>
<p class="sub">Pick a league to see the model's <b>team to score 2+ goals</b> picks for upcoming fixtures with bookmaker odds — plus how the pick has backtested.</p>
<form action="/scan" method="get" style="display:flex;gap:8px;margin:16px 0;flex-wrap:wrap">
<select name="league" aria-label="League" style="flex:1;min-width:220px;background:#0c1622;border:1px solid #16222f;color:#e6edf3;border-radius:8px;padding:11px 13px;font-size:15px">
<option value="">Select a league…</option>
${options}
</select>
<button style="background:#2ecc71;color:#04121f;font-weight:700;border:none;border-radius:8px;padding:11px 20px;font-size:15px;cursor:pointer">Scan →</button>
</form>
<div class="grid">
${popular.map((l) => `<a class="chip" href="${scanUrl(l)}">${esc(l.flag)} ${esc(l.name)}</a>`).join("")}
</div>`,
  }));
});

router.get("/scan/:idslug", async (req, res) => {
  const base = baseUrl(req);
  if (!toolsAuthed(req)) return res.type("html").send(unlockPage(req, { next: req.originalUrl }));

  const league = LEAGUES_BY_ID[String(parseInt(req.params.idslug, 10))];
  const fail = (msg, code = 404) => res.status(code).type("html").send(page({
    base, title: `2+ goals scan | ${SITE}`, description: msg, canonical: `${base}/scan`,
    body: `<h1>2+ goals scan</h1><p class="sub">${esc(msg)}</p><p><a href="/scan">Pick a league →</a></p>`,
  }));
  if (!league) return fail("That league isn't covered — pick one from the list.");

  const mode = req.query.mode === "backtest" ? "backtest" : "upcoming";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : ymdUTC();
  const within = ["1", "3", "6"].includes(String(req.query.within)) ? String(req.query.within) : "all";
  const canonical = `${base}${scanUrl(league)}`;

  // The engine (gated) — self-fetch with the tools pass, same as /predict.
  const call = (qs) => fetch(`${base}/api/team-2plus/scan?leagues=${league.id}&${qs}`, { headers: { "x-odds-pass": TOOLS_PASS } })
    .then((r) => r.json().catch(() => ({}))).catch(() => ({}));

  let bt, up;
  try {
    [bt, up] = await Promise.all([
      call("mode=backtest&days=120&tz=UTC"),
      mode === "upcoming" ? call(`mode=upcoming&date=${date}&within=${within}&tz=UTC`) : Promise.resolve(null),
    ]);
  } catch {
    return fail("Couldn't build this scan right now — try again shortly.", 502);
  }

  const s = bt?.summary;
  const headline = s && s.total
    ? `Over the last <b>${s.total}</b> finished matches, the model's 2+ pick hit <b>${s.hitRate}%</b> (avg confidence ${s.avgProb}%).`
    : `Backtest is still warming up for this league.`;

  // Mode / date / window navigation, all as plain links (no JS needed).
  const modeTabs = `<div class="grid" style="margin:2px 0 14px">
<a class="chip" href="${scanUrl(league)}"${mode === "upcoming" ? ' style="border-color:#2ecc71;color:#2ecc71"' : ""}>Upcoming picks</a>
<a class="chip" href="${scanUrl(league)}?mode=backtest"${mode === "backtest" ? ' style="border-color:#2ecc71;color:#2ecc71"' : ""}>Backtest history</a>
</div>`;

  let main;
  if (mode === "backtest") {
    const rows = (bt?.rows || []).slice(0, 60);
    main = `<h2 style="font-size:16px;margin:20px 0 6px">Graded history — last 120 days</h2>` +
      (rows.length ? rows.map((r) => `<div class="m"${r.hit ? ' style="border-color:#2ecc71"' : ""}>
<div class="t">${esc(r.home)} ${r.homeScore}-${r.awayScore} ${esc(r.away)}</div>
<div class="p">Pick: <b>${esc(r.team)}</b> to score 2+ · ${r.prob}% · ${r.hit ? '<b style="color:#2ecc71">HIT ✓</b>' : '<span style="color:#e74c3c">miss ✗</span>'} · ${esc(prettyUtc(r.date))}</div>
</div>`).join("") : "<p class='sub'>No finished matches graded yet.</p>");
  } else {
    const rows = up?.rows || [];
    const withinLinks = ["all", "1", "3", "6"].map((w) => {
      const label = w === "all" ? "All day" : `${w}h`;
      const href = `${scanUrl(league)}?date=${date}` + (w === "all" ? "" : `&within=${w}`);
      return `<a class="chip" href="${href}"${within === w ? ' style="border-color:#2ecc71;color:#2ecc71"' : ""}>${label}</a>`;
    }).join("");
    const dateBar = `<div class="grid" style="align-items:center;margin:2px 0 12px">
<a class="chip" href="${scanUrl(league)}?date=${shiftYmd(date, -1)}${within === "all" ? "" : `&within=${within}`}">‹ Prev</a>
<span class="chip" style="border-color:#2a3a4a">${esc(prettyUtc(date))}${date === ymdUTC() ? " · Today" : ""}</span>
<a class="chip" href="${scanUrl(league)}?date=${shiftYmd(date, 1)}${within === "all" ? "" : `&within=${within}`}">Next ›</a>
</div>
<div class="grid" style="margin:0 0 14px">${withinLinks}</div>`;
    // Both teams' 2+ strength side by side; the stronger side (the pick) is marked.
    const sideLine = (name, prob, odds, book, picked) =>
      `<div class="p"${picked ? ' style="color:#e6edf3"' : ""}>${picked ? "◆ " : "&nbsp;&nbsp; "}<b>${esc(name)}</b> to score 2+ · <b>${typeof prob === "number" ? prob + "%" : "–"}</b>${odds ? ` · book <b>@${odds.toFixed(2)}</b>${book ? ` (${esc(book)})` : ""}` : ""}</div>`;
    const evRow = (r) => `<div class="m">
<div class="t">${esc(r.home)} vs ${esc(r.away)}${r.kickoff ? ` · ${new Date(r.kickoff * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC` : ""}</div>
${sideLine(r.home, r.homeProb, r.homeOdds, r.homeBook, r.side === "home")}
${sideLine(r.away, r.awayProb, r.awayOdds, r.awayBook, r.side === "away")}
</div>`;
    main = `<h2 style="font-size:16px;margin:20px 0 6px">Upcoming picks</h2>${dateBar}` +
      (rows.length ? rows.map(evRow).join("") : "<p class='sub'>No upcoming fixtures for this date/window.</p>");
  }

  const body = `<p style="color:#6b8299;font-size:13px"><a href="/scan">← All leagues</a></p>
<h1>${esc(league.flag)} ${esc(league.name)} — 2+ goals scan</h1>
<p class="sub">${headline}</p>
${modeTabs}
${main}
<a class="cta" href="/">Open in the live app →</a>`;

  res.set("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
  res.type("html").send(page({
    base,
    title: `${league.name} — team to score 2+ goals picks | ${SITE}`,
    description: (s && s.total ? `${league.name}: the model's 2+ goals pick has hit ${s.hitRate}% over ${s.total} recent matches. ` : "") + `Upcoming "team to score 2+ goals" picks with bookmaker odds. Estimates only — not betting advice.`,
    canonical,
    body,
  }));
});

export default router;

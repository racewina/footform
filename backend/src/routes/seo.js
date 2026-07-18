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
function slugify(s) {
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

// A team-vs-team line with the model's read, as plain crawlable text.
function fixtureLine(fx) {
  const p = fx.prediction;
  const h = esc(fx.homeTeam?.name || "Home");
  const a = esc(fx.awayTeam?.name || "Away");
  if (!p || p.home == null) return `<div class="m"><span class="t">${h} vs ${a}</span></div>`;
  const m = p.markets || {};
  return `<div class="m"><span class="t">${h} vs ${a}</span>` +
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
  const lines = fixtures.map(fixtureLine).join("");
  const body = `<p style="color:#6b8299;font-size:13px"><a href="/leagues">All leagues</a> › ${esc(league.country)}</p>
<h1>${esc(league.flag)} ${esc(name)} predictions</h1>
<p class="sub">${esc(league.country)} · ${lines ? `fixtures ${esc(when)}` : "upcoming fixtures"} with model win probabilities, over/under 1.5 &amp; 2.5 goals and both teams to score.</p>
${lines || `<p>No ${esc(name)} matches in the next two weeks. Check the live app for the latest fixtures.</p>`}
<a class="cta" href="/">Open ${esc(name)} in the live app →</a>`;

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

export default router;

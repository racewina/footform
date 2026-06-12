# FootForm — Football Fixtures & Predictions

Live fixture tracking and form-based match predictions across 20+ leagues and second divisions.

## Stack
- **Frontend**: React + Vite + TailwindCSS + React Query
- **Backend**: Node.js + Express + node-cache
- **Data**: SofaScore via RapidAPI

---

## Setup

### 1. Get your RapidAPI key
1. Sign up at [rapidapi.com](https://rapidapi.com)
2. Subscribe to **SofaScore** API
3. Copy your key from the dashboard

### 2. Backend
```bash
cd backend
npm install
cp .env.example .env
# Edit .env and paste your RAPIDAPI_KEY
npm run dev
```
Backend runs at `http://localhost:3001`

### 3. Frontend
```bash
cd frontend
npm install
npm run dev
```
Frontend runs at `http://localhost:5173`

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/leagues` | All supported leagues |
| GET | `/api/fixtures/:leagueId?date=YYYY-MM-DD` | Fixtures for a single date |
| GET | `/api/fixtures/:leagueId/range?from=YYYY-MM-DD&days=14` | Fixtures over a date range |
| GET | `/api/match/:matchId/prediction?homeTeamId=X&awayTeamId=Y` | W/D/L prediction |
| GET | `/api/health` | Server health + cache stats |

---

## Prediction Algorithm

For each team, the engine pulls last 6 matches and computes:

1. **Points per game** (W=3, D=1, L=0) — 50% weight
2. **Attack score** (avg goals scored / 2.5, capped at 1) — 25% weight
3. **Defense score** (1 - avg goals conceded / 2.5, floored at 0) — 25% weight

Home team score × 1.15 home advantage multiplier.

Win/draw/loss probabilities normalized to 100%.  
Confidence: **High** (8+ relevant games), **Medium** (4–7), **Low** (<4).

---

## Caching Strategy

| Data | Cache key | TTL |
|------|-----------|-----|
| Season ID | `season:{leagueId}` | 24h |
| Fixture range | `range:{leagueId}:{date}:{days}` | 30min |
| Team form | `form:{teamId}` | 6h |
| Prediction | `prediction:{homeId}:{awayId}` | 6h |

---

## Phase Roadmap

- [x] **Phase 1** — Backend proxy + cache + fixture display (current)
- [ ] **Phase 2** — Prediction pre-warming, batch form fetch, confidence tuning
- [ ] **Phase 3** — Expand league list, mobile polish, PWA manifest, rate limit monitoring

---

## Known Limitations

- SofaScore via RapidAPI is **unofficial** — no SLA, endpoint may change
- Free tier ~100 req/day — upgrade to paid or implement pre-warming before going public
- League IDs are hardcoded — verify against SofaScore before deploying new leagues

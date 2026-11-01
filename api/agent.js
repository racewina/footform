// The research agent's cron (/api/cron/agent-report) runs here instead of in
// api/index.js: same Express app, but its own function so it can take up to 800s
// (screening + Claude's web research) without raising every other route's limit.
// The vercel.json rewrite keeps the original path, so the app routes it as usual.
import app from "../backend/src/app.js";

export default app;

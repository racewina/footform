// Local dev entry point. On Vercel the Express app is served as a serverless
// function (see /api/[...slug].js) and this file is not used.
import "dotenv/config";
import app from "./app.js";

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`⚽ Football API running on http://localhost:${PORT}`);
  if (!process.env.APIFOOTBALL_KEY) {
    console.warn("⚠️  APIFOOTBALL_KEY not set — API calls will fail");
  }
});

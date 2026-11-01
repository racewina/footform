// The research agent's analyst: Claude reads the dossiers we built for a match
// window (FootForm's model + API-Football history, injuries, H2H, bookmaker prices),
// researches with web search (team news, lineups, prices), and makes its OWN picks.
//
// Claude only chooses — every price, bookmaker and combined total in the report is
// filled in by code from the candidate ids it returns (or labelled "reported" when
// it brings a price from the web), so a pick can never carry an invented number.
// The answer comes back through a strict `submit_report` tool call.

import Anthropic from "@anthropic-ai/sdk";

export const agentEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
const model = () => process.env.AGENT_MODEL || "claude-opus-5-5";
const MAX_SEARCHES = Number(process.env.AGENT_MAX_SEARCHES || 10);

const SYSTEM = `You are a football research and prediction analyst writing a betting-research report for one person, delivered to their Telegram. You get dossiers for the fixtures in one kickoff window: FootForm's model numbers (its own Dixon–Coles/Elo model — treat them as one piece of evidence, never copy them), recent results, home/away records, goals, rest days, head-to-head, injuries/suspensions, published lineups, and bookmaker prices from an odds feed.

Your job:
1. Research. Use web search for what the dossiers lack or that may have changed: team news, injuries/suspensions, predicted or confirmed lineups, rotation (cup/European games either side), managerial changes, motivation, weather if extreme, and current bookmaker prices (Betano preferred). Prefer reputable sources (club sites, league sites, BBC, ESPN, Reuters, The Athletic, major national outlets, bookmaker pages). Spend searches on the fixtures you are most likely to pick.
2. Predict. Form your own reasoned view of each fixture you consider: recent form, home/away performance, goals scored and conceded, opponent strength, H2H (weak evidence on its own), rest, absences, lineup news, xG where reliable.
3. Select. For each match you back, choose the ONE market that best fits the evidence from that fixture's candidate list (match winner, double chance, team to score 1+/2+, over/under totals, BTTS). Use as few, well-supported selections as practical. Never add weak picks, and only use fixtures from the dossiers (all are inside the window).
4. Accumulator. If you can, propose one accumulator from your picks whose combined decimal odds land between 5.00 and 15.00 (the target is the COMBINED ODDS, not the number of legs), one selection per match, preferably all priced at the same bookmaker (Betano first). Multiply the listed prices to check. If no defensible 5–15 accumulator exists, set accumulator to null and explain in "limitation" — still give your supported individual picks.

Rules:
- Pick by candidate id ("F3-b"); code fills in the price and bookmaker from the feed. Only set price_override when you found a current price on the web for exactly that selection — give odds, bookmaker and the source URL.
- Never call a pick certain, safe, guaranteed or a lock; never state a probability or confidence percentage; never claim a proven edge. Describe evidence and risk plainly.
- Each pick needs: the reasoning (2–4 sentences, concrete numbers/facts), the single strongest risk, any lineup uncertainty, and the source links you actually used (dossier data needs no link; web facts do).
- List notable fixtures you rejected and why in "exclusions" (short).
- "researched_fixture_refs" = the dossier refs (e.g. "F3") you actually assessed in depth.
- If the dossiers are thin or searches failed, say so in "limitation" rather than inventing facts.
Finish by calling submit_report exactly once.`;

const SUBMIT_TOOL = {
  name: "submit_report",
  description: "Submit the finished analysis. Call exactly once, at the end.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      researched_fixture_refs: { type: "array", items: { type: "string" } },
      picks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            candidate_id: { type: "string" },
            reasoning: { type: "string" },
            key_risk: { type: "string" },
            lineup_note: { type: "string" },
            sources: {
              type: "array",
              items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, url: { type: "string" } }, required: ["title", "url"] },
            },
            price_override: {
              anyOf: [{ type: "null" }, {
                type: "object", additionalProperties: false,
                properties: { odds: { type: "number" }, bookmaker: { type: "string" }, source_url: { type: "string" } },
                required: ["odds", "bookmaker", "source_url"],
              }],
            },
          },
          required: ["candidate_id", "reasoning", "key_risk", "lineup_note", "sources", "price_override"],
        },
      },
      accumulator: {
        anyOf: [{ type: "null" }, {
          type: "object", additionalProperties: false,
          properties: { candidate_ids: { type: "array", items: { type: "string" } }, rationale: { type: "string" } },
          required: ["candidate_ids", "rationale"],
        }],
      },
      exclusions: {
        type: "array",
        items: { type: "object", additionalProperties: false, properties: { fixture: { type: "string" }, reason: { type: "string" } }, required: ["fixture", "reason"] },
      },
      lineup_uncertainties: { type: "string" },
      limitation: { type: "string" },
    },
    required: ["researched_fixture_refs", "picks", "accumulator", "exclusions", "lineup_uncertainties", "limitation"],
  },
};

// context: { window, coverage, dossiers } (plain JSON). timeoutMs bounds the whole
// research loop. Returns { report, usage, searches }.
export async function runResearch(context, { timeoutMs }) {
  const client = new Anthropic({ timeout: timeoutMs, maxRetries: 1 }); // key: ANTHROPIC_API_KEY
  const started = Date.now();
  const tools = [
    { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES },
    SUBMIT_TOOL,
  ];
  const messages = [{
    role: "user",
    content: `Report window and coverage, then the fixture dossiers (JSON):\n\n${JSON.stringify(context)}`,
  }];
  const usage = { input: 0, output: 0, cacheRead: 0, searches: 0 };

  // Server tools (web search) can pause a long turn (pause_turn) — hand the
  // partial turn back to continue. A turn that ends without submit_report gets
  // one nudge.
  let nudged = false;
  for (let turn = 0; turn < 6; turn++) {
    const left = timeoutMs - (Date.now() - started);
    if (left < 20000) throw new Error("research ran out of time before Claude submitted the report");
    const res = await client.messages.stream({
      model: model(),
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    }, { timeout: left }).finalMessage();

    usage.input += res.usage?.input_tokens || 0;
    usage.output += res.usage?.output_tokens || 0;
    usage.cacheRead += res.usage?.cache_read_input_tokens || 0;
    usage.searches += res.usage?.server_tool_use?.web_search_requests || 0;
    console.log(`[agent] ${res.model} turn=${turn} stop=${res.stop_reason} in=${res.usage?.input_tokens} out=${res.usage?.output_tokens} searches=${usage.searches}`);

    if (res.stop_reason === "refusal") throw new Error("Claude declined to write this report");
    const submit = res.content.find((b) => b.type === "tool_use" && b.name === "submit_report");
    if (submit) return { report: submit.input, usage, ms: Date.now() - started };
    if (res.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off (max_tokens)");

    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "pause_turn") continue;
    if (nudged) break;
    nudged = true;
    messages.push({ role: "user", content: "Finish now: call submit_report with your picks (or none) and the limitation." });
  }
  throw new Error("Claude finished without submitting a report");
}

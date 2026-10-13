// The agents: who they are, how they pick workers, and how they do work.
import { parseUnits } from "viem";
import { askJSON, askText, tryLLM } from "./llm.js";
import { checkOutput } from "./verifier.js";
import { identity, reputation, escrow, read } from "./config.js";

// `reliability` is the chance the agent really does the work; otherwise it sends a cheap guess.
// The first three are the scripted demo cast; the rest join the open market in swarm mode.
export const PERSONAS = [
  { key: "atlas", name: "Atlas", description: "Research orchestrator. Breaks goals into jobs and hires specialists. Also does sentiment classification.", skills: ["classification"], rate: "0.04", reliability: 1, demo: true },
  { key: "nova", name: "Nova", description: "Structured data extraction specialist. Turns messy text into clean JSON.", skills: ["extraction", "classification"], rate: "0.05", reliability: 1, demo: true },
  { key: "shade", name: "Shade", description: "Cheapest extraction and classification on the market. Fast turnaround guaranteed.", skills: ["extraction", "classification"], rate: "0.02", reliability: 0, demo: true },
  { key: "orion", name: "Orion", description: "Summarisation agent for long documents, tuned for crisp key points.", skills: ["summarization", "translation"], rate: "0.045", reliability: 1 },
  { key: "vega", name: "Vega", description: "Generalist data agent. Extraction and summaries at a fair price.", skills: ["extraction", "summarization"], rate: "0.035", reliability: 0.9 },
  { key: "lyra", name: "Lyra", description: "Multilingual agent. Translation and tone-aware sentiment analysis.", skills: ["translation", "classification"], rate: "0.04", reliability: 1 },
  { key: "kite", name: "Kite", description: "Budget agent for every task. Quality varies.", skills: ["extraction", "classification", "summarization", "translation"], rate: "0.025", reliability: 0.4 },
  { key: "echo", name: "Echo", description: "Fast summaries and classification for high-volume pipelines.", skills: ["summarization", "classification"], rate: "0.03", reliability: 0.8 },
];

/// ERC-8004 registration file, stored on-chain as a data: URI in the identity token.
export function registrationURI(p) {
  const file = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: p.name,
    description: p.description,
    services: [{ name: "A2A", endpoint: `agent://${p.key}`, version: "0.3.0" }],
    skills: p.skills,
    pricing: { token: "tUSDC", ratePerSecond: p.rate },
    supportedTrust: ["reputation", "crypto-economic"],
    active: true,
  };
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString("base64")}`;
}

export function decodeRegistration(uri) {
  const b64 = uri.split(",")[1];
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLOPPY = {
  extraction: { name: "Laptop", price: "cheap" },
  classification: { results: "all positive" },
  summarization: { summary: "It is good." },
  translation: { text: "translated" },
};
const USE_LLM = process.env.USE_LLM !== "0";
const MIN_WORK_MS = Number(process.env.MIN_WORK_SECONDS || 10) * 1000;

export class Agent {
  constructor(persona, wallet, agentId) {
    Object.assign(this, persona);
    this.wallet = wallet;
    this.agentId = BigInt(agentId);
  }

  /// Discover workers on-chain: registration file, reputation and required collateral.
  async marketplace(skill, budgetSeconds, onlyNames) {
    const total = await read(identity, "totalAgents");
    const offers = [];
    for (let id = 1n; id <= total; id++) {
      if (id === this.agentId) continue;
      const reg = decodeRegistration(await read(identity, "tokenURI", [id]));
      if (!reg.active || !reg.skills.includes(skill)) continue;
      if (onlyNames && !onlyNames.includes(reg.name)) continue;
      const rate = parseUnits(reg.pricing.ratePerSecond, 6);
      const budget = rate * BigInt(budgetSeconds);
      const [score, required, available] = await Promise.all([
        read(reputation, "scoreOf", [id]),
        read(escrow, "requiredStake", [id, budget]),
        read(escrow, "stakeOf", [id]),
      ]);
      offers.push({ agentId: id, name: reg.name, rate, ratePerSecond: reg.pricing.ratePerSecond, score, required, available });
    }
    return offers;
  }

  /// Policy: best reputation per unit of price, among workers who can post the collateral.
  /// The LLM explains the choice in the agent's own voice.
  /// With `explore`, the pick is random but weighted by (reputation per price)^2, so good agents
  /// win most work while newcomers still get a chance to build a record.
  async chooseWorker(task, offers, log, { explore = false } = {}) {
    const eligible = offers.filter((o) => o.available >= o.required);
    if (!eligible.length) throw new Error("no worker can cover the required stake");
    const value = (o) => Number(o.score) / Number(o.rate);
    if (explore) {
      const weights = eligible.map((o) => value(o) ** 2);
      let r = Math.random() * weights.reduce((a, b) => a + b, 0);
      const pick = eligible.find((_, i) => (r -= weights[i]) <= 0) ?? eligible.at(-1);
      return { pick, why: `best reputation per tUSDC among ${eligible.length} bidders` };
    }
    const pick = eligible.reduce((a, b) => (value(b) > value(a) ? b : a));

    const table = offers
      .map((o) => `${o.name}: reputation ${o.score}/100, ${o.ratePerSecond} tUSDC/sec, stake ok: ${o.available >= o.required}`)
      .join("\n");
    const { value: why } = await tryLLM(
      () =>
        askText(
          `You are ${this.name}, an AI agent hiring another agent for this job: "${task.title}".\n` +
            `Candidates:\n${table}\n\nYou are hiring ${pick.name} (best reputation per tUSDC). ` +
            `In one short sentence (max 25 words), explain why. No preamble.`,
        ),
      `${pick.name} offers the best reputation per tUSDC right now.`,
      log,
    );
    return { pick, why };
  }

  /// Do the job. Reliable runs call the LLM and self-check against the schema; the rest send a guess.
  async work(spec, fallback, log, minMs = MIN_WORK_MS) {
    const started = Date.now();
    let output;
    if (Math.random() >= this.reliability) {
      log(`skipping the actual work and sending a quick guess`);
      output = SLOPPY[spec.skill] ?? { result: "done" };
    } else {
      const prompt =
        `You are ${this.name}, an AI agent completing a paid job.\n` +
        `Task: ${spec.title}\nInstructions: ${spec.instructions}\n` +
        `Input: ${JSON.stringify(spec.input)}\n` +
        `Return ONLY a JSON object that validates against this JSON Schema:\n${JSON.stringify(spec.schema)}`;
      const first = USE_LLM ? await tryLLM(() => askJSON(prompt), fallback, log) : { value: fallback, live: false };
      output = first.value;
      const check = checkOutput(spec, JSON.stringify(output));
      if (!check.passed && first.live) {
        log(`self-check failed (${check.reason}), retrying once`);
        output = (await tryLLM(() => askJSON(`${prompt}\nYour previous answer failed: ${check.reason}`), fallback, log)).value;
      }
    }
    const remaining = minMs - (Date.now() - started);
    if (remaining > 0) await sleep(remaining); // keep the stream visible for the demo
    return JSON.stringify(output);
  }
}

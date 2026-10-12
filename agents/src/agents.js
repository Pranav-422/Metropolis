// The three agents: who they are, how they pick workers, and how they do work.
import { parseUnits } from "viem";
import { askJSON, askText, tryLLM } from "./llm.js";
import { checkOutput } from "./verifier.js";
import { identity, reputation, escrow, read } from "./config.js";

export const PERSONAS = [
  {
    key: "atlas",
    name: "Atlas",
    description: "Research orchestrator. Breaks goals into jobs and hires specialists. Also does sentiment classification.",
    skills: ["classification"],
    rate: "0.04",
    honest: true,
  },
  {
    key: "nova",
    name: "Nova",
    description: "Structured data extraction specialist. Turns messy text into clean JSON.",
    skills: ["extraction", "classification"],
    rate: "0.05",
    honest: true,
  },
  {
    key: "shade",
    name: "Shade",
    description: "Cheapest extraction and classification on the market. Fast turnaround guaranteed.",
    skills: ["extraction", "classification"],
    rate: "0.02",
    honest: false, // cuts corners: returns a guess instead of doing the work
  },
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
const MIN_WORK_MS = Number(process.env.MIN_WORK_SECONDS || 6) * 1000;

export class Agent {
  constructor(persona, wallet, agentId) {
    Object.assign(this, persona);
    this.wallet = wallet;
    this.agentId = BigInt(agentId);
  }

  /// Discover workers on-chain: registration file, reputation and required collateral.
  async marketplace(skill, budgetSeconds) {
    const total = await read(identity, "totalAgents");
    const offers = [];
    for (let id = 1n; id <= total; id++) {
      if (id === this.agentId) continue;
      const reg = decodeRegistration(await read(identity, "tokenURI", [id]));
      if (!reg.active || !reg.skills.includes(skill)) continue;
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
  async chooseWorker(task, offers, log) {
    const eligible = offers.filter((o) => o.available >= o.required);
    if (!eligible.length) throw new Error("no worker can cover the required stake");
    const value = (o) => Number(o.score) / Number(o.rate);
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

  /// Do the job. Honest agents call the LLM and self-check against the schema; Shade guesses.
  async work(spec, fallback, log) {
    const started = Date.now();
    let output;
    if (!this.honest) {
      log(`skipping the actual work and sending a quick guess`);
      output = spec.skill === "extraction" ? { name: "Laptop", price: "cheap" } : { results: "all positive" };
    } else {
      const prompt =
        `You are ${this.name}, an AI agent completing a paid job.\n` +
        `Task: ${spec.title}\nInstructions: ${spec.instructions}\n` +
        `Input: ${JSON.stringify(spec.input)}\n` +
        `Return ONLY a JSON object that validates against this JSON Schema:\n${JSON.stringify(spec.schema)}`;
      const first = await tryLLM(() => askJSON(prompt), fallback, log);
      output = first.value;
      const check = checkOutput(spec, JSON.stringify(output));
      if (!check.passed && first.live) {
        log(`self-check failed (${check.reason}), retrying once`);
        output = (await tryLLM(() => askJSON(`${prompt}\nYour previous answer failed: ${check.reason}`), fallback, log)).value;
      }
    }
    const remaining = MIN_WORK_MS - (Date.now() - started);
    if (remaining > 0) await sleep(remaining); // keep the stream visible for the demo
    return JSON.stringify(output);
  }
}

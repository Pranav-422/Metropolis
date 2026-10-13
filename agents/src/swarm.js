// Swarm mode: every agent is a client and a worker. Jobs run in parallel with random clients and
// tasks, workers are picked by reputation per price (weighted random), and reputation diverges
// as reliable agents get paid and sloppy ones get slashed.
//
//   JOBS=30 CONCURRENCY=6 npm run swarm
import { formatUnits, parseEventLogs } from "viem";
import { NETWORK, walletFor, funderKey, escrow, reputation, read, send } from "./config.js";
import { Agent, PERSONAS } from "./agents.js";
import { TASKS, specFor } from "./tasks.js";
import { verifyJob } from "./verifier.js";
import { loadWallets } from "./setup.js";

const JOBS = Number(process.env.JOBS || 24);
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const MAX_SECONDS = 60;
const WORK_MS = [Number(process.env.MIN_WORK_SECONDS || 2) * 1000, Number(process.env.MAX_WORK_SECONDS || 6) * 1000];

const c = { dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", cyan: "\x1b[36m", reset: "\x1b[0m" };
const usdc = (v) => `${Number(formatUnits(v, 6)).toFixed(3)}`;
const pickOne = (xs) => xs[Math.floor(Math.random() * xs.length)];

const wallets = loadWallets();
const missing = PERSONAS.filter((p) => !wallets[p.key]?.agentId);
if (missing.length) {
  console.error(`Agents not set up on ${NETWORK}: ${missing.map((p) => p.name).join(", ")}. Run: npm run setup`);
  process.exit(1);
}
const agents = PERSONAS.map((p) => new Agent(p, walletFor(wallets[p.key].privateKey), wallets[p.key].agentId));
const byId = (id) => agents.find((a) => a.agentId === id);
const verifier = walletFor(funderKey);
const stats = { paid: 0, slashed: 0, skipped: 0 };

async function runJob(n) {
  const tag = `${c.dim}[${String(n).padStart(2)}]${c.reset}`;
  const log = (msg) => console.log(`${tag} ${msg}`);

  const client = pickOne(agents);
  const task = pickOne(Object.values(TASKS));
  const offers = await client.marketplace(task.skill, MAX_SECONDS);
  if (!offers.length) return stats.skipped++;
  const { pick } = await client.chooseWorker(task, offers, null, { explore: true });
  const worker = byId(pick.agentId);

  const spec = specFor(task);
  const created = await send(client.wallet, escrow, "createJob", [pick.agentId, pick.rate, BigInt(MAX_SECONDS), JSON.stringify(spec)]);
  const [{ args: job }] = parseEventLogs({ abi: escrow.abi, logs: created.logs, eventName: "JobCreated" });
  log(`${c.cyan}${client.name}${c.reset} hired ${c.bold}${worker.name}${c.reset} (rep ${pick.score}) for ${task.skill}, job #${job.jobId} streaming ${pick.ratePerSecond}/s`);

  const workMs = WORK_MS[0] + Math.random() * (WORK_MS[1] - WORK_MS[0]);
  const output = await worker.work(spec, task.fallback, () => {}, workMs);
  await send(worker.wallet, escrow, "submitWork", [job.jobId, output]);

  const verdict = await verifyJob(verifier, job.jobId, spec, output);
  const score = await read(reputation, "scoreOf", [pick.agentId]);
  if (verdict.passed) {
    stats.paid++;
    log(`${c.green}PASS${c.reset} ${worker.name} paid ${usdc(await read(escrow, "accrued", [job.jobId]))} tUSDC, rep -> ${score}`);
  } else {
    stats.slashed++;
    log(`${c.red}FAIL${c.reset} ${worker.name} slashed ${usdc(job.stakeLocked)} tUSDC (${verdict.reason}), rep -> ${score}`);
  }
}

async function main() {
  console.log(`${c.bold}Swarm on ${NETWORK}${c.reset}: ${agents.length} agents, ${JOBS} jobs, ${CONCURRENCY} at a time\n`);
  const started = Date.now();
  let next = 1;
  const lane = async () => {
    while (next <= JOBS) {
      const n = next++;
      try {
        await runJob(n);
      } catch (e) {
        stats.skipped++;
        console.log(`${c.dim}[${String(n).padStart(2)}] skipped: ${(e.shortMessage || e.message).split("\n")[0]}${c.reset}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));

  console.log(`\n${c.bold}Done in ${((Date.now() - started) / 1000).toFixed(0)}s${c.reset}: ${stats.paid} paid, ${stats.slashed} slashed, ${stats.skipped} skipped\n`);
  const rows = await Promise.all(
    agents.map(async (a) => {
      const [score, s] = await Promise.all([read(reputation, "scoreOf", [a.agentId]), read(reputation, "stats", [a.agentId])]);
      return { a, score, passed: s[2], failed: s[3], earned: s[5], slashed: s[6] };
    }),
  );
  rows.sort((x, y) => Number(y.score - x.score));
  for (const r of rows) {
    console.log(
      `  ${r.a.name.padEnd(6)} rep ${String(r.score).padStart(3)}  reliability ${String(r.a.reliability).padEnd(4)}  ${r.passed} passed  ${r.failed} failed  earned ${usdc(r.earned)}  slashed ${usdc(r.slashed)}`,
    );
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e);
  process.exit(1);
});

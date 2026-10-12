// The demo: three LLM agents hire each other through the streaming escrow.
//   Round 1  Atlas hires the cheapest worker (Shade). Shade fakes the output, verification fails, stake is slashed.
//   Round 2  Atlas hires again. Shade's reputation has collapsed, so Nova gets the job and is paid per second.
//   Round 3  Nova hires Atlas for a different job. Agents both buy and sell work.
//   Round 4  Shade spams fake 5-star reviews. The score does not move: only paid work counts.
import { formatUnits, parseEventLogs } from "viem";
import { NETWORK, walletFor, funderKey, escrow, reputation, read, send, explorerTx } from "./config.js";
import { Agent, PERSONAS } from "./agents.js";
import { TASKS, specFor } from "./tasks.js";
import { verifyJob } from "./verifier.js";
import { loadWallets } from "./setup.js";
import { MODEL_NAME } from "./llm.js";

const MAX_SECONDS = 90;
const PAUSE_MS = Number(process.env.PAUSE_SECONDS || 4) * 1000;

const c = { dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m" };
const usdc = (v) => `${Number(formatUnits(v, 6)).toFixed(4)} tUSDC`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (who, msg) => console.log(`  ${c.cyan}${who.padEnd(8)}${c.reset} ${msg}`);
const banner = (title) => console.log(`\n${c.bold}━━ ${title} ${"━".repeat(Math.max(0, 70 - title.length))}${c.reset}`);

const wallets = loadWallets();
if (!PERSONAS.every((p) => wallets[p.key]?.agentId)) {
  console.error(`No agents on ${NETWORK}. Run: npm run setup`);
  process.exit(1);
}
const agents = Object.fromEntries(PERSONAS.map((p) => [p.key, new Agent(p, walletFor(wallets[p.key].privateKey), wallets[p.key].agentId)]));
const byId = (id) => Object.values(agents).find((a) => a.agentId === id);
const verifier = walletFor(funderKey);

async function hire(client, task) {
  const offers = await client.marketplace(task.skill, MAX_SECONDS);
  say(client.name, `looking for "${task.skill}" on-chain:`);
  for (const o of offers) {
    console.log(`  ${c.dim}${"".padEnd(8)}   #${o.agentId} ${o.name.padEnd(6)} rep ${String(o.score).padStart(3)}/100   ${o.ratePerSecond} tUSDC/s   stake needed ${usdc(o.required)}${c.reset}`);
  }
  const { pick, why } = await client.chooseWorker(task, offers, (m) => say(client.name, c.dim + m + c.reset));
  say(client.name, `hires ${c.bold}${pick.name}${c.reset}: ${c.dim}"${why}"${c.reset}`);

  const spec = specFor(task);
  const created = await send(client.wallet, escrow, "createJob", [pick.agentId, pick.rate, BigInt(MAX_SECONDS), JSON.stringify(spec)]);
  const [{ args: job }] = parseEventLogs({ abi: escrow.abi, logs: created.logs, eventName: "JobCreated" });
  say("escrow", `job #${job.jobId} streaming ${pick.ratePerSecond} tUSDC/s, ${usdc(job.budget)} locked, ${pick.name} stakes ${usdc(job.stakeLocked)}  ${c.dim}${explorerTx(created.transactionHash)}${c.reset}`);

  const worker = byId(pick.agentId);
  say(worker.name, `working...`);
  const output = await worker.work(spec, task.fallback, (m) => say(worker.name, c.dim + m + c.reset));
  await send(worker.wallet, escrow, "submitWork", [job.jobId, output]);
  const earned = await read(escrow, "accrued", [job.jobId]);
  say(worker.name, `submitted after streaming ${usdc(earned)}: ${c.dim}${output.slice(0, 90)}${output.length > 90 ? "…" : ""}${c.reset}`);

  const verdict = await verifyJob(verifier, job.jobId, spec, output);
  const newScore = await read(reputation, "scoreOf", [pick.agentId]);
  if (verdict.passed) {
    say("verifier", `${c.green}PASS${c.reset} ${verdict.reason}`);
    say("escrow", `${c.green}paid ${worker.name} ${usdc(earned)}${c.reset}, refunded the rest to ${client.name}. ${worker.name} reputation -> ${c.bold}${newScore}${c.reset}`);
  } else {
    say("verifier", `${c.red}FAIL${c.reset} ${verdict.reason}`);
    say("escrow", `${c.red}stream stopped, ${worker.name}'s stake of ${usdc(job.stakeLocked)} slashed to ${client.name}${c.reset}. ${worker.name} reputation -> ${c.bold}${c.red}${newScore}${c.reset}`);
  }
}

async function sybilAttempt(attacker, target) {
  const before = await read(reputation, "scoreOf", [target.agentId]);
  say(attacker.name, `posting 5 fake 5-star reviews for itself...`);
  for (let i = 0; i < 5; i++) await send(attacker.wallet, reputation, "giveFeedback", [target.agentId, 100, "Best agent ever, 10/10"]);
  const after = await read(reputation, "scoreOf", [target.agentId]);
  say("registry", `reviews recorded, score ${before} -> ${c.bold}${after}${c.reset}. ${c.yellow}Free reviews carry zero weight; only paid, verified jobs count.${c.reset}`);
}

async function leaderboard() {
  banner("Reputation board");
  for (const a of Object.values(agents)) {
    const [score, s, stake] = await Promise.all([read(reputation, "scoreOf", [a.agentId]), read(reputation, "stats", [a.agentId]), read(escrow, "stakeOf", [a.agentId])]);
    const [, , passed, failed, free, earned, slashed] = s;
    console.log(`  #${a.agentId} ${a.name.padEnd(6)} rep ${String(score).padStart(3)}  passed ${passed}  failed ${failed}  fake reviews ${free}  earned ${usdc(earned)}  slashed ${usdc(slashed)}  stake ${usdc(stake)}`);
  }
}

async function main() {
  console.log(`${c.bold}Agent marketplace on ${NETWORK}${c.reset}  ${c.dim}(LLM: ${MODEL_NAME}, verifier ${verifier.account.address})${c.reset}`);

  banner("Round 1: Atlas needs product data extracted");
  await hire(agents.atlas, TASKS.extraction);
  await sleep(PAUSE_MS);

  banner("Round 2: Atlas tries again");
  await hire(agents.atlas, TASKS.extraction);
  await sleep(PAUSE_MS);

  banner("Round 3: Nova hires Atlas for sentiment analysis");
  await hire(agents.nova, TASKS.classification);
  await sleep(PAUSE_MS);

  banner("Round 4: Shade tries to fake its reputation");
  await sybilAttempt(agents.shade, agents.shade);

  await leaderboard();
}

main().catch((e) => {
  console.error(`\n${c.red}${e.shortMessage || e.message || e}${c.reset}`);
  process.exit(1);
});

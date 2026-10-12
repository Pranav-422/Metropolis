// Reads everything straight from the chain: no backend. Events are fetched incrementally and
// folded into a state object the UI renders.
import { createPublicClient, http, formatUnits } from "viem";
import { hardhat, baseSepolia } from "viem/chains";
import abis from "./generated/abis.json";

const deployments = import.meta.glob("./generated/*.json", { eager: true, import: "default" });

export function pickNetwork() {
  const q = new URLSearchParams(location.search).get("network");
  const wanted = q || import.meta.env.VITE_NETWORK || (location.hostname === "localhost" ? "localhost" : "baseSepolia");
  const dep = deployments[`./generated/${wanted}.json`] ?? deployments["./generated/baseSepolia.json"] ?? deployments["./generated/localhost.json"];
  if (!dep) throw new Error("No deployment found. Run the deploy script first.");
  return dep;
}

export const deployment = pickNetwork();
const isTestnet = deployment.network === "baseSepolia";
export const explorer = isTestnet ? "https://sepolia.basescan.org" : null;

const client = createPublicClient({
  chain: isTestnet ? baseSepolia : hardhat,
  transport: http(isTestnet ? import.meta.env.VITE_RPC || "https://sepolia.base.org" : "http://127.0.0.1:8545"),
});

const c = (name) => ({ address: deployment.contracts[name], abi: abis[name] });
const identity = c("IdentityRegistry");
const reputation = c("ReputationRegistry");
const escrow = c("StreamingEscrow");

export const usdc = (v) => Number(formatUnits(v ?? 0n, 6));

function decodeRegistration(uri) {
  try {
    return JSON.parse(atob(uri.split(",")[1]));
  } catch {
    return { name: "unknown" };
  }
}

const CHUNK = 2000n;

export function createFeed() {
  let nextBlock = BigInt(deployment.startBlock);
  const state = { agents: {}, jobs: {}, events: [], scoreHistory: {} };

  async function fetchEvents() {
    const latest = await client.getBlockNumber();
    while (nextBlock <= latest) {
      const to = nextBlock + CHUNK - 1n < latest ? nextBlock + CHUNK - 1n : latest;
      const batches = await Promise.all(
        [identity, reputation, escrow].map((k) => client.getContractEvents({ ...k, fromBlock: nextBlock, toBlock: to })),
      );
      const logs = batches.flat().sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
      for (const log of logs) apply(log);
      nextBlock = to + 1n;
    }
  }

  function apply(log) {
    const a = log.args;
    const at = { tx: log.transactionHash, block: log.blockNumber };
    switch (log.eventName) {
      case "Registered": {
        state.agents[a.agentId] = { id: a.agentId, owner: a.owner, ...decodeRegistration(a.agentURI) };
        state.scoreHistory[a.agentId] = [50];
        state.events.push({ ...at, kind: "register", agent: a.agentId });
        break;
      }
      case "JobCreated": {
        let spec = {};
        try {
          spec = JSON.parse(a.spec);
        } catch {}
        state.jobs[a.jobId] = {
          id: a.jobId,
          client: a.clientAgent,
          worker: a.workerAgent,
          rate: a.ratePerSecond,
          budget: a.budget,
          stake: a.stakeLocked,
          start: Number(a.start),
          maxEnd: Number(a.maxEnd),
          spec,
          status: "streaming",
          createdTx: log.transactionHash,
        };
        state.events.push({ ...at, kind: "job", job: a.jobId });
        break;
      }
      case "WorkSubmitted": {
        const j = state.jobs[a.jobId];
        Object.assign(j, { status: "verifying", stoppedAt: Number(a.stoppedAt), output: a.output });
        state.events.push({ ...at, kind: "submit", job: a.jobId });
        break;
      }
      case "JobCompleted": {
        const j = state.jobs[a.jobId];
        Object.assign(j, { status: "paid", paid: a.paidToWorker, fee: a.fee, reason: a.reason, settledTx: log.transactionHash });
        state.events.push({ ...at, kind: "paid", job: a.jobId });
        break;
      }
      case "JobSlashed": {
        const j = state.jobs[a.jobId];
        Object.assign(j, { status: "slashed", slashed: a.slashedStake, reason: a.reason, settledTx: log.transactionHash });
        j.stoppedAt ??= j.maxEnd;
        state.events.push({ ...at, kind: "slashed", job: a.jobId });
        break;
      }
      case "PaidFeedback":
        (state.scoreHistory[a.agentId] ??= [50]).push(Number(a.newScore));
        break;
      case "FreeFeedback":
        state.events.push({ ...at, kind: "fake", agent: a.agentId, from: a.from, comment: a.comment });
        break;
    }
  }

  async function fetchAgentStats() {
    await Promise.all(
      Object.values(state.agents).map(async (ag) => {
        const [score, stats, stake, locked] = await Promise.all([
          client.readContract({ ...reputation, functionName: "scoreOf", args: [ag.id] }),
          client.readContract({ ...reputation, functionName: "stats", args: [ag.id] }),
          client.readContract({ ...escrow, functionName: "stakeOf", args: [ag.id] }),
          client.readContract({ ...escrow, functionName: "lockedStakeOf", args: [ag.id] }),
        ]);
        const [, , passed, failed, freeReviews, earned, slashed] = stats;
        Object.assign(ag, { score: Number(score), passed, failed, freeReviews, earned, slashed, stake, locked });
      }),
    );
  }

  return {
    state,
    async refresh() {
      await fetchEvents();
      await fetchAgentStats();
      return state;
    },
  };
}

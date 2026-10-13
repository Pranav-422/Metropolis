# TrustStream

**ERC-8004 agents that get paid by the second, and lose their stake when they lie.**

Track 04, Trust, Identity & AI Infrastructure: *Agent identity and reputation under ERC-8004.*

A registry plus a score is easy to build and easy to fake. TrustStream puts agent reputation under real money: agents hire each other, payment streams per second while they work, an objective verifier checks the output, and the result is written to an ERC-8004 reputation registry that only counts paid, verified work. Good reputation then reduces the collateral an agent must post (reputation-backed credit).

## Demo

Three Gemini-powered agents run a small job market on Base Sepolia:

| Round | What happens |
|---|---|
| 1 | **Atlas** needs product data extracted and hires the cheapest worker, **Shade**. Money streams per second. Shade fakes the output, the JSON-schema verifier rejects it, the stream stops, Atlas is refunded and Shade's stake is slashed. Shade's reputation drops from 50 to 1. |
| 2 | Atlas posts the job again. Shade now ranks last on reputation per tUSDC, so **Nova** is hired, does the work with Gemini, passes verification and is paid for exactly the seconds it worked. Reputation rises to 93. |
| 3 | Nova hires Atlas for sentiment analysis, so the same agent is a client in one job and a worker in another. Atlas passes and rises to 91. |
| 4 | Shade posts 5 fake 5-star reviews for itself. They are recorded on-chain and its score stays at 1. |

### Swarm mode

`npm run swarm` opens the market to 8 agents with different skills, prices and reliability (from always honest to cuts corners 60% of the time). Every agent both hires and works, and jobs run in parallel: 24 jobs settle in about 35 seconds. Workers are picked at random, weighted by (reputation per price)², so newcomers still get chances. Over a few dozen jobs, reliable agents climb to about 95+ and win most of the work, while unreliable ones get slashed down to the teens and must post near-full collateral.

```
JOBS=40 CONCURRENCY=8 npm run swarm      # USE_LLM=0 skips Gemini for maximum speed
```

The dashboard shows it live: a per-second ticker on each job, reputation rings that move, the slash, and every transaction linked to Basescan.

## How it works

```
 Atlas (client)                     StreamingEscrow                     Nova (worker)
      │  createJob(worker, rate, maxSecs, spec+schema) ──►│                     │
      │       locks rate*maxSecs tUSDC                    │ locks worker stake  │
      │                                                   │   (sized by rep)    │
      │                                     stream: rate × seconds ──────────►  │  Gemini does the work
      │                                                   │◄── submitWork(output)  stream stops
      │                       Verifier: output vs JSON schema in the spec       │
      │                              verify(pass/fail) ──►│                     │
      │                    pass: pay seconds worked, refund rest, unlock stake  │
      │                    fail: refund client in full, slash stake to client   │
      │                                                   └─► ReputationRegistry.recordJob(weight = value at stake)
```

### Contracts (`contracts/`)

| Contract | Role |
|---|---|
| `IdentityRegistry` | ERC-8004 identity. Each agent is an ERC-721 whose `tokenURI` is its registration file (name, skills, A2A endpoint, price per second), stored on-chain as a `data:` URI. |
| `ReputationRegistry` | ERC-8004 reputation. Scores move only through `recordJob`, which only the escrow can call, weighted by the money at stake. Anyone can call `giveFeedback`, but those reviews carry zero weight. |
| `StreamingEscrow` | Pay-per-second escrow, reputation-sized stake, slashing, timeouts. |
| `MockUSDC` | Test stablecoin (6 decimals). |

### Design choices

- **Sybil resistance:** a reputation point costs real money. Weight comes from settled escrow value, failures count double, free reviews count zero, you cannot hire yourself, and a 2% protocol fee makes wash-trading between your own wallets lose money.
- **Per-second pay:** `accrued = rate × (now - start)`. The worker is paid only for the seconds until it submits. Output that fails verification earns nothing, and the stake is slashed to the client.
- **Reputation-backed credit:** `requiredStake = budget × (100 - score) / 100`. A new agent (50) posts 50% of the budget, a trusted agent (93) posts 7%, and a slashed agent (1) posts 99%. This is undercollateralised lending for agents.
- **Objective verifier:** the job spec, including its JSON Schema, is emitted on-chain in `JobCreated`, so anyone can re-run the check against the on-chain output.
- **No backend:** the dashboard reads everything from contract events.

## Deployed on Base Sepolia

| Contract | Address |
|---|---|
| IdentityRegistry | [`0x56B4fCae7B443129DB2adAD33fF7994AB45B7448`](https://sepolia.basescan.org/address/0x56B4fCae7B443129DB2adAD33fF7994AB45B7448) |
| ReputationRegistry | [`0x9A2cA0CE78BDbd3C18EEf1D745Fd1D9A2636b95c`](https://sepolia.basescan.org/address/0x9A2cA0CE78BDbd3C18EEf1D745Fd1D9A2636b95c) |
| StreamingEscrow | [`0x8A05C0b0621813506B80b423854fFd51c1Be666C`](https://sepolia.basescan.org/address/0x8A05C0b0621813506B80b423854fFd51c1Be666C) |
| MockUSDC | [`0xFD3369f9b1173f91fF223235f141534696dAAa99`](https://sepolia.basescan.org/address/0xFD3369f9b1173f91fF223235f141534696dAAa99) |

## Run it locally

Requires Node 20+ and a Gemini API key.

```bash
# .env in the repo root
GEMINI_API_KEY=...
DEPLOYER_PRIVATE_KEY=0x...        # only needed for Base Sepolia
BASE_SEPOLIA_RPC=https://sepolia.base.org

cd contracts && npm install && npx hardhat test      # 6 tests
npx hardhat node                                       # terminal 1
npm run deploy:local                                   # terminal 2

cd ../dashboard && npm install && npm run dev          # http://localhost:5173
cd ../agents && npm install && npm run setup && npm run demo
```

On Base Sepolia: `npm run deploy:testnet` in `contracts/`, then `npm run setup:testnet && npm run demo:testnet` in `agents/`.

Environment knobs for the agents: `GEMINI_MODEL` (default `gemini-3-flash-preview`), `MIN_WORK_SECONDS` (default 10, keeps the stream visible), `PAUSE_SECONDS` between rounds. If Gemini is unreachable, agents fall back to cached answers so a live demo cannot stall.

## Repo layout

```
contracts/   Solidity + Hardhat tests + deploy script
agents/      Gemini agents, marketplace logic, JSON-schema verifier, demo + swarm runners
dashboard/   Vite + React live view (reads the chain directly)
deployments/ addresses and ABIs written by the deploy script
```

## Next steps

- Use ERC-8004's Validation Registry so third-party validators (TEE, zkML, re-execution) can replace the single verifier key.
- Mid-stream checkpoints so long jobs can be verified and paid in slices.
- Let workers withdraw accrued pay mid-stream, protected by the stake.
- Weight reviews by the reviewer's own reputation, in addition to the money at stake.

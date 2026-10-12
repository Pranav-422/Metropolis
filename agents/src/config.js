// Shared chain config: which network, contract handles, clients and a tx helper.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat, baseSepolia } from "viem/chains";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
dotenv.config({ path: path.join(ROOT, ".env") });

export const NETWORK = process.env.NETWORK || (process.argv.includes("--testnet") ? "baseSepolia" : "localhost");
const isTestnet = NETWORK === "baseSepolia";

// Hardhat's well-known account #0. Only ever used against the local node.
const HARDHAT_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export const chain = isTestnet ? baseSepolia : hardhat;
const rpc = isTestnet ? process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org" : "http://127.0.0.1:8545";
const transport = http(rpc, { retryCount: 5, retryDelay: 1000 });

/// Deployer key: funds agents and acts as the escrow's verifier.
export const funderKey = isTestnet ? process.env.DEPLOYER_PRIVATE_KEY : HARDHAT_KEY0;
if (!funderKey) throw new Error("DEPLOYER_PRIVATE_KEY missing in .env");

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
export const deployment = readJson(`deployments/${NETWORK}.json`);
const abis = readJson("deployments/abis.json");

const handle = (name) => ({ address: deployment.contracts[name], abi: abis[name] });
export const token = handle("MockUSDC");
export const identity = handle("IdentityRegistry");
export const reputation = handle("ReputationRegistry");
export const escrow = handle("StreamingEscrow");

export const publicClient = createPublicClient({ chain, transport, pollingInterval: isTestnet ? 1000 : 200 });

export function walletFor(privateKey) {
  return createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport });
}

// Public RPCs are load-balanced: right after a tx is mined, the next request can land on a node
// that has not seen it yet. Reads are pinned to the newest block we have written to, and sends are
// retried, so a lagging node shows up as a short delay instead of a bogus revert.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRIES = isTestnet ? 8 : 1;
let minBlock;

async function retry(fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= RETRIES) throw e;
      await sleep(1000);
    }
  }
}

export const read = (contract, functionName, args = []) =>
  retry(() => publicClient.readContract({ ...contract, functionName, args, blockNumber: minBlock }));

/// Send a contract call and wait for it to be mined. Throws on revert.
export async function send(wallet, contract, functionName, args = []) {
  const hash = await retry(async () => {
    const { request } = await publicClient.simulateContract({ ...contract, functionName, args, account: wallet.account });
    return wallet.writeContract(request);
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  if (minBlock === undefined || receipt.blockNumber > minBlock) minBlock = receipt.blockNumber;
  return receipt;
}

/// Plain ETH transfer with the same bookkeeping as `send`.
export async function sendEth(wallet, to, value) {
  const hash = await retry(() => wallet.sendTransaction({ to, value }));
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (minBlock === undefined || receipt.blockNumber > minBlock) minBlock = receipt.blockNumber;
  return receipt;
}

export const explorerTx = (hash) => (isTestnet ? `https://sepolia.basescan.org/tx/${hash}` : hash);

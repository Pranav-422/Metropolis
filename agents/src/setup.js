// One-time setup per network: create agent wallets, fund gas + tUSDC, register ERC-8004
// identities, approve the escrow and post stake. Safe to re-run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEther, parseUnits, formatEther, maxUint256 } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { NETWORK, publicClient, walletFor, funderKey, token, identity, escrow, read, send } from "./config.js";
import { PERSONAS, registrationURI } from "./agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const WALLETS_FILE = path.join(here, "..", `wallets.${NETWORK}.json`);

const GAS_ETH = parseEther(process.env.AGENT_GAS_ETH || (NETWORK === "localhost" ? "1" : "0.002"));
const USDC_BALANCE = parseUnits("50", 6);
const STAKE = parseUnits("10", 6);

export function loadWallets() {
  return fs.existsSync(WALLETS_FILE) ? JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8")) : {};
}

async function main() {
  const funder = walletFor(funderKey);
  const wallets = loadWallets();
  console.log(`Setting up agents on ${NETWORK}. Funder ${funder.account.address}: ${formatEther(await publicClient.getBalance({ address: funder.account.address }))} ETH`);

  for (const p of PERSONAS) {
    wallets[p.key] ??= { privateKey: generatePrivateKey() };
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2)); // persist keys before spending gas on them
    const w = walletFor(wallets[p.key].privateKey);
    const addr = w.account.address;
    wallets[p.key].address = addr;

    const eth = await publicClient.getBalance({ address: addr });
    if (eth < GAS_ETH / 2n) {
      const hash = await funder.sendTransaction({ to: addr, value: GAS_ETH - eth });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    const bal = await read(token, "balanceOf", [addr]);
    const staked = await read(escrow, "stakeOf", [await read(identity, "agentOf", [addr])]);
    if (bal + staked < USDC_BALANCE) await send(funder, token, "mint", [addr, USDC_BALANCE]);

    let agentId = await read(identity, "agentOf", [addr]);
    if (agentId === 0n) {
      await send(w, identity, "register", [registrationURI(p)]);
      agentId = await read(identity, "agentOf", [addr]);
    }
    wallets[p.key].agentId = Number(agentId);

    if ((await read(token, "allowance", [addr, escrow.address])) < parseUnits("1000", 6)) {
      await send(w, token, "approve", [escrow.address, maxUint256]);
    }
    const stake = await read(escrow, "stakeOf", [agentId]);
    if (stake < STAKE) await send(w, escrow, "stake", [agentId, STAKE - stake]);

    console.log(`  ${p.name.padEnd(6)} agent #${agentId}  ${addr}`);
  }
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
  console.log(`Saved ${path.basename(WALLETS_FILE)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.shortMessage || e);
    process.exit(1);
  });
}

// Deploys the four contracts and writes addresses + ABIs where the agents and dashboard read them.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying to ${network.name} from ${deployer.address}`);

  const startBlock = await ethers.provider.getBlockNumber();
  const deploy = async (name, args = []) => {
    const c = await ethers.deployContract(name, args);
    await c.waitForDeployment();
    console.log(`  ${name}: ${await c.getAddress()}`);
    return c;
  };

  const token = await deploy("MockUSDC");
  const identity = await deploy("IdentityRegistry");
  const reputation = await deploy("ReputationRegistry", [await identity.getAddress()]);
  // The deployer doubles as verifier and treasury so a single funded key runs the demo.
  const escrow = await deploy("StreamingEscrow", [
    await token.getAddress(),
    await identity.getAddress(),
    await reputation.getAddress(),
    deployer.address,
    deployer.address,
  ]);
  await (await reputation.setEscrow(await escrow.getAddress())).wait();

  const out = {
    network: network.name,
    chainId: Number(network.config.chainId ?? (await ethers.provider.getNetwork()).chainId),
    startBlock,
    verifier: deployer.address,
    contracts: {
      MockUSDC: await token.getAddress(),
      IdentityRegistry: await identity.getAddress(),
      ReputationRegistry: await reputation.getAddress(),
      StreamingEscrow: await escrow.getAddress(),
    },
  };

  const abis = {};
  for (const name of Object.keys(out.contracts)) abis[name] = (await hre.artifacts.readArtifact(name)).abi;

  const root = path.join(__dirname, "..", "..");
  for (const dir of [path.join(root, "deployments"), path.join(root, "dashboard", "src", "generated")]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(dir, "abis.json"), JSON.stringify(abis));
  }
  console.log("Wrote deployments/ and dashboard/src/generated/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

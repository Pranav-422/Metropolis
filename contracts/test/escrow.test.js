const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const RATE = USDC("0.01"); // per second
const MAX = 120n; // seconds => budget 1.2 tUSDC

async function deploy() {
  const [owner, verifier, treasury, alice, bob, mallory, sybil] = await ethers.getSigners();
  const token = await ethers.deployContract("MockUSDC");
  const identity = await ethers.deployContract("IdentityRegistry");
  const reputation = await ethers.deployContract("ReputationRegistry", [identity]);
  const escrow = await ethers.deployContract("StreamingEscrow", [
    token,
    identity,
    reputation,
    verifier.address,
    treasury.address,
  ]);
  await reputation.setEscrow(escrow);

  for (const s of [alice, bob, mallory]) {
    await identity.connect(s).register(`data:application/json,{"name":"${s.address}"}`);
    await token.mint(s.address, USDC(100));
    await token.connect(s).approve(escrow, ethers.MaxUint256);
  }
  // alice=1, bob=2, mallory=3
  await escrow.connect(bob).stake(2, USDC(5));
  await escrow.connect(mallory).stake(3, USDC(5));
  return { owner, verifier, treasury, alice, bob, mallory, sybil, token, identity, reputation, escrow };
}

describe("StreamingEscrow", () => {
  it("pays the worker per second on a verified job and raises reputation", async () => {
    const c = await deploy();
    expect(await c.reputation.scoreOf(2)).to.equal(50n);

    await c.escrow.connect(c.alice).createJob(2, RATE, MAX, "spec");
    const job = await c.escrow.jobs(1);
    expect(job.stakeLocked).to.equal(USDC("0.6")); // score 50 => 50% of 1.2

    await time.increase(19);
    await c.escrow.connect(c.bob).submitWork(1, '{"ok":true}'); // ~20s elapsed
    const stopped = (await c.escrow.jobs(1)).stoppedAt;
    const elapsed = stopped - job.start;
    const pay = RATE * elapsed;

    const bobBefore = await c.token.balanceOf(c.bob.address);
    await expect(c.escrow.connect(c.verifier).verify(1, true, "schema ok")).to.emit(c.escrow, "JobCompleted");

    const fee = (pay * 200n) / 10000n;
    expect(await c.token.balanceOf(c.bob.address)).to.equal(bobBefore + pay - fee);
    expect(await c.token.balanceOf(c.treasury.address)).to.equal(fee);
    expect(await c.escrow.stakeOf(2)).to.equal(USDC(5)); // stake released
    expect(await c.reputation.scoreOf(2)).to.be.greaterThan(50n);
  });

  it("slashes stake and refunds the client when verification fails", async () => {
    const c = await deploy();
    await c.escrow.connect(c.alice).createJob(3, RATE, MAX, "spec");
    await time.increase(5);
    await c.escrow.connect(c.mallory).submitWork(1, "garbage");

    const aliceBefore = await c.token.balanceOf(c.alice.address);
    await expect(c.escrow.connect(c.verifier).verify(1, false, "schema mismatch")).to.emit(c.escrow, "JobSlashed");

    // full budget back + the 0.6 stake that was slashed
    expect(await c.token.balanceOf(c.alice.address)).to.equal(aliceBefore + USDC("1.2") + USDC("0.6"));
    expect(await c.escrow.stakeOf(3)).to.equal(USDC("4.4"));
    expect(await c.escrow.lockedStakeOf(3)).to.equal(0n);
    expect(await c.reputation.scoreOf(3)).to.be.lessThan(10n);
  });

  it("lets anyone expire a job the worker never delivered", async () => {
    const c = await deploy();
    await c.escrow.connect(c.alice).createJob(3, RATE, MAX, "spec");
    await expect(c.escrow.expire(1)).to.be.revertedWith("not expired");
    await time.increase(Number(MAX) + 1);
    await expect(c.escrow.expire(1)).to.emit(c.escrow, "JobSlashed");
    await expect(c.escrow.connect(c.mallory).submitWork(1, "late")).to.be.revertedWith("not streaming");
  });

  it("asks trusted agents for less collateral", async () => {
    const c = await deploy();
    const budget = RATE * MAX;
    const before = await c.escrow.requiredStake(2, budget);

    await c.escrow.connect(c.alice).createJob(2, RATE, MAX, "spec");
    await time.increase(29);
    await c.escrow.connect(c.bob).submitWork(1, "{}");
    await c.escrow.connect(c.verifier).verify(1, true, "ok");

    expect(await c.escrow.requiredStake(2, budget)).to.be.lessThan(before);
  });

  it("ignores free reviews when scoring (Sybil resistance)", async () => {
    const c = await deploy();
    for (let i = 0; i < 5; i++) await c.reputation.connect(c.sybil).giveFeedback(3, 100, "best agent ever");
    expect((await c.reputation.stats(3)).freeReviews).to.equal(5n);
    expect(await c.reputation.scoreOf(3)).to.equal(50n);
  });

  it("enforces roles", async () => {
    const c = await deploy();
    await expect(c.escrow.connect(c.alice).createJob(1, RATE, MAX, "spec")).to.be.revertedWith("cannot hire yourself");
    await expect(c.escrow.connect(c.sybil).createJob(2, RATE, MAX, "spec")).to.be.revertedWith("client not registered");
    await c.escrow.connect(c.alice).createJob(2, RATE, MAX, "spec");
    await expect(c.escrow.connect(c.mallory).submitWork(1, "x")).to.be.revertedWith("not worker");
    await c.escrow.connect(c.bob).submitWork(1, "x");
    await expect(c.escrow.connect(c.alice).verify(1, true, "x")).to.be.revertedWith("not verifier");
    await expect(c.reputation.recordJob(2, 1, c.alice.address, true, 1, 1, 0)).to.be.revertedWith("only escrow");
  });
});

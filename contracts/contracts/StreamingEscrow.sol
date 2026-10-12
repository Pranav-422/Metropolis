// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {ReputationRegistry} from "./ReputationRegistry.sol";

/// Pay-per-second escrow between ERC-8004 agents.
///
/// - The client locks `rate * maxDuration` up front; the worker earns `rate` for every second
///   it works, until it submits its output.
/// - The worker must lock stake, sized by reputation: a trusted agent posts less collateral
///   (reputation-backed credit), a new or bad agent posts more.
/// - A verifier checks the output. Pass: the worker is paid for the seconds it streamed.
///   Fail or timeout: the client is refunded in full and the worker's stake is slashed to the client.
contract StreamingEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Streaming,
        Submitted,
        Completed,
        Slashed
    }

    struct Job {
        uint256 clientAgent;
        uint256 workerAgent;
        address client;
        address worker;
        uint128 ratePerSecond;
        uint128 budget;
        uint128 stakeLocked;
        uint64 start;
        uint64 maxEnd;
        uint64 stoppedAt;
        Status status;
    }

    /// 2% protocol fee, so farming reputation by paying yourself still costs money.
    uint16 public constant FEE_BPS = 200;

    IERC20 public immutable token;
    IdentityRegistry public immutable identity;
    ReputationRegistry public immutable reputation;
    address public immutable verifier;
    address public immutable treasury;

    uint256 public jobCount;
    mapping(uint256 => Job) public jobs;
    mapping(uint256 => uint256) public stakeOf; // agentId => free stake
    mapping(uint256 => uint256) public lockedStakeOf; // agentId => stake locked in live jobs

    event Staked(uint256 indexed agentId, uint256 amount);
    event Unstaked(uint256 indexed agentId, uint256 amount);
    event JobCreated(
        uint256 indexed jobId,
        uint256 indexed clientAgent,
        uint256 indexed workerAgent,
        uint256 ratePerSecond,
        uint256 budget,
        uint256 stakeLocked,
        uint64 start,
        uint64 maxEnd,
        string spec
    );
    event WorkSubmitted(uint256 indexed jobId, uint64 stoppedAt, string output);
    event JobCompleted(uint256 indexed jobId, uint256 paidToWorker, uint256 fee, uint256 refundToClient, string reason);
    event JobSlashed(uint256 indexed jobId, uint256 slashedStake, uint256 refundToClient, string reason);

    constructor(
        IERC20 token_,
        IdentityRegistry identity_,
        ReputationRegistry reputation_,
        address verifier_,
        address treasury_
    ) {
        token = token_;
        identity = identity_;
        reputation = reputation_;
        verifier = verifier_;
        treasury = treasury_;
    }

    // ---------------------------------------------------------------- stake

    function stake(uint256 agentId, uint256 amount) external nonReentrant {
        require(identity.ownerOf(agentId) == msg.sender, "not agent owner");
        token.safeTransferFrom(msg.sender, address(this), amount);
        stakeOf[agentId] += amount;
        emit Staked(agentId, amount);
    }

    function unstake(uint256 agentId, uint256 amount) external nonReentrant {
        require(identity.ownerOf(agentId) == msg.sender, "not agent owner");
        stakeOf[agentId] -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Unstaked(agentId, amount);
    }

    /// Collateral a worker must lock for a job of this size.
    /// Score 50 => 50% of budget, score 90 => 10%, score 10 => 90%.
    function requiredStake(uint256 workerAgent, uint256 budget) public view returns (uint256) {
        uint256 score = reputation.scoreOf(workerAgent);
        return (budget * (100 - score)) / 100;
    }

    // ---------------------------------------------------------------- jobs

    function createJob(uint256 workerAgent, uint128 ratePerSecond, uint64 maxDuration, string calldata spec)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        uint256 clientAgent = identity.agentOf(msg.sender);
        require(clientAgent != 0, "client not registered");
        require(clientAgent != workerAgent, "cannot hire yourself");
        require(ratePerSecond > 0 && maxDuration > 0, "empty job");

        uint128 budget = ratePerSecond * maxDuration;
        uint256 required = requiredStake(workerAgent, budget);
        require(stakeOf[workerAgent] >= required, "worker stake too low");

        token.safeTransferFrom(msg.sender, address(this), budget);
        stakeOf[workerAgent] -= required;
        lockedStakeOf[workerAgent] += required;

        jobId = ++jobCount;
        uint64 start = uint64(block.timestamp);
        jobs[jobId] = Job({
            clientAgent: clientAgent,
            workerAgent: workerAgent,
            client: msg.sender,
            worker: identity.ownerOf(workerAgent),
            ratePerSecond: ratePerSecond,
            budget: budget,
            stakeLocked: uint128(required),
            start: start,
            maxEnd: start + maxDuration,
            stoppedAt: 0,
            status: Status.Streaming
        });
        emit JobCreated(jobId, clientAgent, workerAgent, ratePerSecond, budget, required, start, start + maxDuration, spec);
    }

    /// Worker delivers. The stream stops here: the worker is owed the seconds up to now.
    function submitWork(uint256 jobId, string calldata output) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Streaming, "not streaming");
        require(msg.sender == j.worker, "not worker");
        uint64 nowTs = uint64(block.timestamp);
        j.stoppedAt = nowTs < j.maxEnd ? nowTs : j.maxEnd;
        j.status = Status.Submitted;
        emit WorkSubmitted(jobId, j.stoppedAt, output);
    }

    /// Verifier's verdict on submitted output.
    function verify(uint256 jobId, bool passed, string calldata reason) external nonReentrant {
        require(msg.sender == verifier, "not verifier");
        Job storage j = jobs[jobId];
        require(j.status == Status.Submitted, "nothing to verify");
        if (passed) _complete(jobId, j, reason);
        else _slash(jobId, j, reason);
    }

    /// Worker never delivered before the deadline: anyone can trigger the slash.
    function expire(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.status == Status.Streaming && block.timestamp > j.maxEnd, "not expired");
        j.stoppedAt = j.maxEnd;
        _slash(jobId, j, "timeout: no output before deadline");
    }

    /// Amount the worker has earned so far (what the dashboard ticks up live).
    function accrued(uint256 jobId) public view returns (uint256) {
        Job storage j = jobs[jobId];
        if (j.status == Status.None) return 0;
        uint256 end;
        if (j.status == Status.Streaming) end = block.timestamp < j.maxEnd ? block.timestamp : j.maxEnd;
        else end = j.stoppedAt;
        return uint256(j.ratePerSecond) * (end - j.start);
    }

    function _complete(uint256 jobId, Job storage j, string calldata reason) private {
        j.status = Status.Completed;
        uint256 pay = uint256(j.ratePerSecond) * (j.stoppedAt - j.start);
        uint256 fee = (pay * FEE_BPS) / 10_000;
        uint256 refund = j.budget - pay;

        lockedStakeOf[j.workerAgent] -= j.stakeLocked;
        stakeOf[j.workerAgent] += j.stakeLocked;

        reputation.recordJob(j.workerAgent, jobId, j.client, true, pay, pay - fee, 0);

        if (pay - fee > 0) token.safeTransfer(j.worker, pay - fee);
        if (fee > 0) token.safeTransfer(treasury, fee);
        if (refund > 0) token.safeTransfer(j.client, refund);
        emit JobCompleted(jobId, pay - fee, fee, refund, reason);
    }

    function _slash(uint256 jobId, Job storage j, string memory reason) private {
        j.status = Status.Slashed;
        uint256 slashed = j.stakeLocked;
        lockedStakeOf[j.workerAgent] -= slashed;

        reputation.recordJob(j.workerAgent, jobId, j.client, false, j.budget, 0, slashed);

        token.safeTransfer(j.client, uint256(j.budget) + slashed);
        emit JobSlashed(jobId, slashed, j.budget, reason);
    }
}

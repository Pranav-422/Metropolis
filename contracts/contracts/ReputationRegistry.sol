// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry} from "./IdentityRegistry.sol";

/// ERC-8004 Reputation Registry with Sybil-resistant scoring.
///
/// Only feedback that comes out of a paid, settled escrow job moves the score, and it is
/// weighted by the money at stake. Free reviews are recorded (visible and auditable) but
/// carry zero weight, so spinning up fake reviewers buys nothing.
contract ReputationRegistry {
    uint256 public constant PRIOR_SCORE = 50;
    /// Weight of the neutral prior, in token base units (0.1 tUSDC).
    uint256 public constant PRIOR_WEIGHT = 100_000;
    /// Failed jobs count double: trust should be lost faster than it is earned.
    uint256 public constant FAIL_MULTIPLIER = 2;

    struct Stats {
        uint256 weightedScoreSum;
        uint256 totalWeight;
        uint64 jobsPassed;
        uint64 jobsFailed;
        uint64 freeReviews;
        uint256 earned;
        uint256 slashed;
    }

    IdentityRegistry public immutable identity;
    address public immutable owner;
    address public escrow;

    mapping(uint256 => Stats) public stats;

    event PaidFeedback(
        uint256 indexed agentId, uint256 indexed jobId, address indexed client, uint8 score, uint256 weight, uint256 newScore
    );
    event FreeFeedback(uint256 indexed agentId, address indexed from, uint8 score, string comment);

    constructor(IdentityRegistry identity_) {
        identity = identity_;
        owner = msg.sender;
    }

    function setEscrow(address escrow_) external {
        require(msg.sender == owner && escrow == address(0), "escrow locked");
        escrow = escrow_;
    }

    /// Called by the escrow when a job settles. `weight` is the value that was on the line.
    function recordJob(
        uint256 agentId,
        uint256 jobId,
        address client,
        bool passed,
        uint256 weight,
        uint256 earned,
        uint256 slashed
    ) external {
        require(msg.sender == escrow, "only escrow");
        Stats storage s = stats[agentId];
        uint8 score;
        if (passed) {
            score = 100;
            s.jobsPassed++;
            s.weightedScoreSum += 100 * weight;
            s.totalWeight += weight;
        } else {
            s.jobsFailed++;
            s.totalWeight += weight * FAIL_MULTIPLIER;
        }
        s.earned += earned;
        s.slashed += slashed;
        emit PaidFeedback(agentId, jobId, client, score, weight, scoreOf(agentId));
    }

    /// Anyone can leave a review. It is stored as an event but has no effect on the score.
    function giveFeedback(uint256 agentId, uint8 score, string calldata comment) external {
        require(identity.exists(agentId), "unknown agent");
        require(score <= 100, "score > 100");
        stats[agentId].freeReviews++;
        emit FreeFeedback(agentId, msg.sender, score, comment);
    }

    /// 0-100. New agents start at 50 and move only as paid work settles.
    function scoreOf(uint256 agentId) public view returns (uint256) {
        Stats storage s = stats[agentId];
        return (PRIOR_SCORE * PRIOR_WEIGHT + s.weightedScoreSum) / (PRIOR_WEIGHT + s.totalWeight);
    }
}

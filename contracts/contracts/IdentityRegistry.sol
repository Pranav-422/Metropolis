// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// ERC-8004 Identity Registry: every agent is an ERC-721 token. The tokenURI is the
/// agent's registration file (name, description, services, pricing).
contract IdentityRegistry is ERC721URIStorage {
    uint256 public totalAgents;

    /// wallet => agentId (0 = not registered). One agent per wallet keeps lookups simple.
    mapping(address => uint256) public agentOf;
    mapping(uint256 => mapping(string => bytes)) private _metadata;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedKey, string key, bytes value);

    constructor() ERC721("ERC-8004 Agent Identity", "AGENT") {}

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = ++totalAgents;
        _mint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external {
        require(ownerOf(agentId) == msg.sender, "not agent owner");
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        return _metadata[agentId][key];
    }

    function exists(uint256 agentId) external view returns (bool) {
        return _ownerOf(agentId) != address(0);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0)) delete agentOf[from];
        if (to != address(0)) {
            require(agentOf[to] == 0, "wallet already has an agent");
            agentOf[to] = tokenId;
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GigToken
/// @notice Sample ERC-20 for the Giggora chain. Exists to prove that standard
///         EVM token contracts deploy and behave normally here, and to give the
///         indexer and explorer real Transfer events to detect (brief §12, §20).
/// @dev Compiled for the Shanghai EVM — see foundry.toml.
contract GigToken is ERC20, ERC20Burnable, Ownable {
    /// @notice Minted to the deployer at construction.
    uint256 public constant INITIAL_SUPPLY = 1_000_000 ether;

    constructor(address initialOwner) ERC20("Gig Test Token", "GTT") Ownable(initialOwner) {
        _mint(initialOwner, INITIAL_SUPPLY);
    }

    /// @notice Mint new tokens. Owner only.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Burnable} from
    "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Burnable.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GigMultiToken
/// @notice Sample ERC-1155 multi-token for the Giggora chain.
/// @dev ERC1155Supply is included so the explorer can report totalSupply(id)
///      and exists(id) per token id (brief §20).
///
///      `name` and `symbol` are NOT part of the ERC-1155 standard, but most
///      explorers and wallets probe for them when identifying a collection, so
///      they are provided deliberately to aid token detection.
///
///      Compiled for the Shanghai EVM — see foundry.toml.
contract GigMultiToken is ERC1155, ERC1155Burnable, ERC1155Supply, Ownable {
    string public name = "Gig Multi Token";
    string public symbol = "GIGMT";

    constructor(address initialOwner)
        ERC1155("https://giggora.invalid/token/{id}.json")
        Ownable(initialOwner)
    {}

    /// @notice Mint `amount` of token `id` to `to`. Owner only.
    function mint(address to, uint256 id, uint256 amount, bytes memory data)
        external
        onlyOwner
    {
        _mint(to, id, amount, data);
    }

    /// @notice Mint several ids at once. Owner only.
    function mintBatch(
        address to,
        uint256[] memory ids,
        uint256[] memory amounts,
        bytes memory data
    ) external onlyOwner {
        _mintBatch(to, ids, amounts, data);
    }

    /// @notice Replace the metadata URI template. Owner only.
    function setURI(string memory newUri) external onlyOwner {
        _setURI(newUri);
    }

    // --- override required by OpenZeppelin v5 ---

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155, ERC1155Supply) {
        super._update(from, to, ids, values);
    }
}

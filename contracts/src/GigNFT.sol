// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from
    "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721URIStorage} from
    "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title GigNFT
/// @notice Sample ERC-721 collection for the Giggora chain.
/// @dev Includes ERC721Enumerable deliberately: totalSupply() and
///      tokenOfOwnerByIndex() let the explorer list a collection and an
///      address's holdings without replaying every historical log (brief §20).
///      Compiled for the Shanghai EVM — see foundry.toml.
contract GigNFT is ERC721, ERC721Enumerable, ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;

    constructor(address initialOwner)
        ERC721("Gig Collection", "GIGNFT")
        Ownable(initialOwner)
    {}

    /// @notice Mint the next token in sequence to `to`. Owner only.
    /// @return tokenId The id that was minted.
    function safeMint(address to, string memory uri) external onlyOwner returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
        return tokenId;
    }

    /// @notice The id the next mint will use.
    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    // --- multiple-inheritance overrides required by OpenZeppelin v5 ---

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }

    function tokenURI(uint256 tokenId)
        public
        view
        override(ERC721, ERC721URIStorage)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}

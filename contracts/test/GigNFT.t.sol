// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GigNFT} from "../src/GigNFT.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract GigNFTTest is Test {
    GigNFT internal nft;

    address internal owner = address(0xA11CE);
    address internal alice = address(0xBEEF);
    address internal bob = address(0xCAFE);

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function setUp() public {
        nft = new GigNFT(owner);
    }

    function test_Metadata() public view {
        assertEq(nft.name(), "Gig Collection");
        assertEq(nft.symbol(), "GIGNFT");
    }

    function test_SafeMintAssignsSequentialIds() public {
        vm.startPrank(owner);
        uint256 first = nft.safeMint(alice, "ipfs://one");
        uint256 second = nft.safeMint(bob, "ipfs://two");
        vm.stopPrank();

        assertEq(first, 0);
        assertEq(second, 1);
        assertEq(nft.ownerOf(0), alice);
        assertEq(nft.ownerOf(1), bob);
        assertEq(nft.tokenURI(0), "ipfs://one");
    }

    /// @dev ERC-721 Transfer indexes tokenId (unlike ERC-20's value). The
    ///      indexer relies on that difference to tell the two standards apart.
    function test_MintEmitsTransferFromZero() public {
        vm.expectEmit(true, true, true, false);
        emit Transfer(address(0), alice, 0);

        vm.prank(owner);
        nft.safeMint(alice, "ipfs://one");
    }

    function test_EnumerableTracksSupplyAndOwnership() public {
        vm.startPrank(owner);
        nft.safeMint(alice, "a");
        nft.safeMint(alice, "b");
        nft.safeMint(bob, "c");
        vm.stopPrank();

        assertEq(nft.totalSupply(), 3);
        assertEq(nft.balanceOf(alice), 2);
        assertEq(nft.tokenOfOwnerByIndex(alice, 0), 0);
        assertEq(nft.tokenOfOwnerByIndex(alice, 1), 1);
        assertEq(nft.tokenByIndex(2), 2);
    }

    function test_TransferChangesOwner() public {
        vm.prank(owner);
        nft.safeMint(alice, "a");

        vm.prank(alice);
        nft.transferFrom(alice, bob, 0);

        assertEq(nft.ownerOf(0), bob);
        assertEq(nft.balanceOf(alice), 0);
        assertEq(nft.balanceOf(bob), 1);
    }

    function test_RevertWhen_NonOwnerMints() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        nft.safeMint(alice, "a");
    }

    function test_RevertWhen_QueryingNonexistentToken() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        nft.ownerOf(99);
    }

    /// @dev Explorers detect the standard via ERC-165, so verify the interface
    ///      ids the detector will probe (brief §20).
    function test_SupportsExpectedInterfaces() public view {
        assertTrue(nft.supportsInterface(0x80ac58cd), "ERC721");
        assertTrue(nft.supportsInterface(0x5b5e139f), "ERC721Metadata");
        assertTrue(nft.supportsInterface(0x780e9d63), "ERC721Enumerable");
        assertTrue(nft.supportsInterface(0x01ffc9a7), "ERC165");
        assertFalse(nft.supportsInterface(0xd9b67a26), "must NOT claim ERC1155");
    }
}

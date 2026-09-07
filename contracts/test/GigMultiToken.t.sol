// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GigMultiToken} from "../src/GigMultiToken.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract GigMultiTokenTest is Test {
    GigMultiToken internal multi;

    address internal owner = address(0xA11CE);
    address internal alice = address(0xBEEF);
    address internal bob = address(0xCAFE);

    event TransferSingle(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256 id,
        uint256 value
    );

    event TransferBatch(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256[] ids,
        uint256[] values
    );

    function setUp() public {
        multi = new GigMultiToken(owner);
    }

    function test_Metadata() public view {
        assertEq(multi.name(), "Gig Multi Token");
        assertEq(multi.symbol(), "GIGMT");
    }

    function test_MintTracksBalanceAndSupply() public {
        vm.prank(owner);
        multi.mint(alice, 1, 100, "");

        assertEq(multi.balanceOf(alice, 1), 100);
        assertEq(multi.totalSupply(1), 100);
        assertTrue(multi.exists(1));
        assertFalse(multi.exists(2));
    }

    /// @dev TransferSingle indexes operator/from/to but NOT id or value — the
    ///      indexer must decode those from the data field (brief §20).
    function test_MintEmitsTransferSingle() public {
        vm.expectEmit(true, true, true, true);
        emit TransferSingle(owner, address(0), alice, 7, 3);

        vm.prank(owner);
        multi.mint(alice, 7, 3, "");
    }

    function test_MintBatchEmitsTransferBatch() public {
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = 1;
        ids[1] = 2;
        amounts[0] = 10;
        amounts[1] = 20;

        vm.expectEmit(true, true, true, true);
        emit TransferBatch(owner, address(0), alice, ids, amounts);

        vm.prank(owner);
        multi.mintBatch(alice, ids, amounts, "");

        assertEq(multi.balanceOf(alice, 1), 10);
        assertEq(multi.balanceOf(alice, 2), 20);
    }

    function test_SafeTransferFromMovesBalance() public {
        vm.prank(owner);
        multi.mint(alice, 1, 100, "");

        vm.prank(alice);
        multi.safeTransferFrom(alice, bob, 1, 40, "");

        assertEq(multi.balanceOf(alice, 1), 60);
        assertEq(multi.balanceOf(bob, 1), 40);
        // A transfer must not change supply.
        assertEq(multi.totalSupply(1), 100);
    }

    function test_BalanceOfBatch() public {
        vm.startPrank(owner);
        multi.mint(alice, 1, 5, "");
        multi.mint(bob, 2, 9, "");
        vm.stopPrank();

        address[] memory accounts = new address[](2);
        uint256[] memory ids = new uint256[](2);
        accounts[0] = alice;
        accounts[1] = bob;
        ids[0] = 1;
        ids[1] = 2;

        uint256[] memory balances = multi.balanceOfBatch(accounts, ids);
        assertEq(balances[0], 5);
        assertEq(balances[1], 9);
    }

    function test_BurnReducesSupply() public {
        vm.prank(owner);
        multi.mint(alice, 1, 100, "");

        vm.prank(alice);
        multi.burn(alice, 1, 30);

        assertEq(multi.totalSupply(1), 70);
    }

    function test_RevertWhen_TransferExceedsBalance() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC1155Errors.ERC1155InsufficientBalance.selector, alice, 0, 1, 1
            )
        );
        multi.safeTransferFrom(alice, bob, 1, 1, "");
    }

    function test_RevertWhen_NonOwnerMints() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        multi.mint(alice, 1, 1, "");
    }

    function test_SupportsExpectedInterfaces() public view {
        assertTrue(multi.supportsInterface(0xd9b67a26), "ERC1155");
        assertTrue(multi.supportsInterface(0x0e89341c), "ERC1155MetadataURI");
        assertFalse(multi.supportsInterface(0x80ac58cd), "must NOT claim ERC721");
    }
}

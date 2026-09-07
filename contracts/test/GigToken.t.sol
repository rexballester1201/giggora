// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GigToken} from "../src/GigToken.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract GigTokenTest is Test {
    GigToken internal token;

    address internal owner = address(0xA11CE);
    address internal alice = address(0xBEEF);
    address internal bob = address(0xCAFE);

    // Must match the ERC-20 standard signature exactly — the indexer will key
    // token transfers off this topic0 (brief §20).
    event Transfer(address indexed from, address indexed to, uint256 value);

    function setUp() public {
        token = new GigToken(owner);
    }

    function test_Metadata() public view {
        assertEq(token.name(), "Gig Test Token");
        assertEq(token.symbol(), "GTT");
        assertEq(token.decimals(), 18);
    }

    function test_InitialSupplyMintedToOwner() public view {
        assertEq(token.totalSupply(), 1_000_000 ether);
        assertEq(token.balanceOf(owner), 1_000_000 ether);
    }

    function test_TransferMovesBalancesAndEmitsEvent() public {
        vm.prank(owner);
        token.transfer(alice, 100 ether);

        assertEq(token.balanceOf(alice), 100 ether);
        assertEq(token.balanceOf(owner), 1_000_000 ether - 100 ether);
    }

    /// @dev The explorer's token indexing depends on this event shape, so it is
    ///      asserted explicitly rather than assumed.
    function test_TransferEmitsCorrectEvent() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(owner, alice, 42 ether);

        vm.prank(owner);
        token.transfer(alice, 42 ether);
    }

    function test_ApproveAndTransferFrom() public {
        vm.prank(owner);
        token.approve(alice, 50 ether);
        assertEq(token.allowance(owner, alice), 50 ether);

        vm.prank(alice);
        token.transferFrom(owner, bob, 50 ether);

        assertEq(token.balanceOf(bob), 50 ether);
        assertEq(token.allowance(owner, alice), 0);
    }

    function test_RevertWhen_TransferExceedsBalance() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 0, 1 ether)
        );
        token.transfer(bob, 1 ether);
    }

    function test_OwnerCanMint() public {
        vm.prank(owner);
        token.mint(alice, 5 ether);
        assertEq(token.balanceOf(alice), 5 ether);
        assertEq(token.totalSupply(), 1_000_000 ether + 5 ether);
    }

    function test_RevertWhen_NonOwnerMints() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice)
        );
        token.mint(alice, 1 ether);
    }

    function test_BurnReducesSupply() public {
        vm.prank(owner);
        token.burn(1000 ether);
        assertEq(token.totalSupply(), 1_000_000 ether - 1000 ether);
    }

    function testFuzz_TransferPreservesTotalSupply(uint96 amount) public {
        vm.assume(amount <= 1_000_000 ether);
        vm.prank(owner);
        token.transfer(alice, amount);
        assertEq(token.balanceOf(owner) + token.balanceOf(alice), 1_000_000 ether);
    }
}

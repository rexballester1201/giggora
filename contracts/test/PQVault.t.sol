// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PQVault} from "../src/pq/PQVault.sol";
import {IMLDSAVerifier} from "../src/pq/IMLDSAVerifier.sol";
import {GigToken} from "../src/GigToken.sol";
import {GigNFT} from "../src/GigNFT.sol";
import {GigMultiToken} from "../src/GigMultiToken.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

/// Stand-in for the ML-DSA-44 verifier, so these tests exercise the VAULT's logic. It
/// accepts exactly abi.encode(pkBlob, message) as the signature for (pkBlob, message).
/// The real verifier, with real ML-DSA-44 signatures, is exercised in spikes/pq-verifier.
contract MockMLDSAVerifier is IMLDSAVerifier {
    mapping(address => bool) public reverts;

    function setReverts(address key, bool on) external {
        reverts[key] = on;
    }

    function verify(address pkBlob, bytes calldata message, bytes calldata signature) external view returns (bool) {
        if (reverts[pkBlob]) revert("mock: verifier reverted");
        return keccak256(signature) == keccak256(abi.encode(pkBlob, message));
    }
}

/// Refuses until opened: lets a test fail an operation, then retry the same signature.
contract Gate {
    bool public open;

    function setOpen(bool o) external {
        open = o;
    }

    function enter() external payable {
        require(open, "gate closed");
    }
}

/// Calls straight back into the vault from inside an operation.
contract Reenterer {
    function attack(PQVault v) external {
        v.execute(address(0), 0, "", block.timestamp, new uint256[](0), new bytes[](0));
    }
}

contract PQVaultTest is Test {
    MockMLDSAVerifier internal verifier;
    address internal owner = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal stranger = address(0xBAD);
    address[] internal blobs; // four stand-in key blobs

    bytes32 internal constant OPERATION_TYPEHASH = keccak256(
        "PQVault.Operation(uint256 chainId,address vault,uint256 nonce,uint256 deadline,address target,uint256 value,bytes32 dataHash)"
    );
    bytes32 internal constant KEY_TYPEHASH = keccak256("PQVault.Key(uint256 chainId,address vault,address key)");

    event Executed(uint256 indexed nonce, address indexed target, uint256 value, bytes32 digest);

    function setUp() public {
        verifier = new MockMLDSAVerifier();
        for (uint256 i; i < 4; ++i) {
            blobs.push(_blob(i));
        }
    }

    // ---- helpers ---------------------------------------------------------------------------

    /// A stand-in key blob: the right size, a 0x00 first byte, distinct contents per key.
    function _blob(uint256 i) internal returns (address a) {
        require(i < 255, "test helper: small key indices only");
        // casting to 'uint160' is safe because i < 255
        // forge-lint: disable-next-line(unsafe-typecast)
        a = address(uint160(0xB10B_0000 + i));
        bytes memory code = new bytes(20_545);
        // casting to 'uint8' is safe because i < 255
        // forge-lint: disable-next-line(unsafe-typecast)
        code[1] = bytes1(uint8(i + 1));
        vm.etch(a, code);
    }

    function _sig(address key, bytes32 digest) internal pure returns (bytes memory) {
        return abi.encode(key, abi.encodePacked(digest));
    }

    function _keyDigest(address vault, address key) internal view returns (bytes32) {
        return keccak256(abi.encode(KEY_TYPEHASH, block.chainid, vault, key));
    }

    function _keys(uint256 a) internal view returns (address[] memory k) {
        k = new address[](1);
        k[0] = blobs[a];
    }

    function _keys(uint256 a, uint256 b, uint256 c) internal view returns (address[] memory k) {
        k = new address[](3);
        (k[0], k[1], k[2]) = (blobs[a], blobs[b], blobs[c]);
    }

    function _idx(uint256 a) internal pure returns (uint256[] memory s) {
        s = new uint256[](1);
        s[0] = a;
    }

    function _idx(uint256 a, uint256 b) internal pure returns (uint256[] memory s) {
        s = new uint256[](2);
        (s[0], s[1]) = (a, b);
    }

    /// Proofs of possession for `ks`, made for the address the next CREATE from this test lands on.
    function _proofsForNextDeploy(address[] memory ks) internal view returns (bytes[] memory p) {
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        p = new bytes[](ks.length);
        for (uint256 i; i < ks.length; ++i) {
            p[i] = _sig(ks[i], _keyDigest(next, ks[i]));
        }
    }

    function _deploy(address[] memory ks, uint256 t) internal returns (PQVault v) {
        v = new PQVault(verifier, owner, ks, t, _proofsForNextDeploy(ks));
    }

    function _sigs(PQVault v, bytes32 digest, uint256[] memory signers) internal view returns (bytes[] memory s) {
        address[] memory ks = v.keys();
        s = new bytes[](signers.length);
        for (uint256 i; i < signers.length; ++i) {
            s[i] = _sig(ks[signers[i]], digest);
        }
    }

    function _digest(PQVault v, uint256 deadline, address target, uint256 value, bytes memory data)
        internal
        view
        returns (bytes32)
    {
        return v.operationDigest(v.nonce(), deadline, target, value, keccak256(data));
    }

    /// Sign with `signers` and execute as the owner.
    function _exec(PQVault v, address target, uint256 value, bytes memory data, uint256[] memory signers)
        internal
        returns (bytes memory)
    {
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(v, _digest(v, deadline, target, value, data), signers);
        vm.prank(owner);
        return v.execute(target, value, data, deadline, signers, s);
    }

    /// As _exec, expecting `reason`. expectRevert is armed only after the helper's own
    /// view calls (nonce, keys, digest), so it applies to execute() itself.
    function _execReverts(
        PQVault v,
        address target,
        uint256 value,
        bytes memory data,
        uint256[] memory signers,
        bytes memory reason
    ) internal {
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(v, _digest(v, deadline, target, value, data), signers);
        vm.prank(owner);
        vm.expectRevert(reason);
        v.execute(target, value, data, deadline, signers, s);
    }

    // ---- construction ------------------------------------------------------------------------

    function test_ConstructorRegistersOwnerKeysAndThreshold() public {
        PQVault v = _deploy(_keys(0, 1, 2), 2);
        assertEq(v.owner(), owner);
        assertEq(v.threshold(), 2);
        assertEq(v.nonce(), 0);
        address[] memory ks = v.keys();
        assertEq(ks.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(ks[i], blobs[i]);
            assertEq(v.keyCodehash(blobs[i]), blobs[i].codehash);
        }
        assertEq(v.keyCodehash(blobs[3]), bytes32(0), "an unregistered blob is not a key");
        assertEq(address(v.verifier()), address(verifier));
    }

    /// Off-chain signers rebuild these digests themselves, so the formula is pinned here
    /// independently of the contract's own implementation.
    function test_DigestsMatchTheDocumentedFormat() public {
        PQVault v = _deploy(_keys(0), 1);
        bytes memory data = abi.encodeCall(Gate.enter, ());
        bytes32 expected = keccak256(
            abi.encode(OPERATION_TYPEHASH, block.chainid, address(v), uint256(7), uint256(99), bob, 3 ether, keccak256(data))
        );
        assertEq(v.operationDigest(7, 99, bob, 3 ether, keccak256(data)), expected);
        assertEq(v.keyDigest(blobs[0]), _keyDigest(address(v), blobs[0]));
        assertEq(v.OPERATION_TYPEHASH(), OPERATION_TYPEHASH);
        assertEq(v.KEY_TYPEHASH(), KEY_TYPEHASH);
    }

    function test_ConstructorRejectsBadShapes() public {
        address[] memory none = new address[](0);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadKeyCount.selector, 0));
        new PQVault(verifier, owner, none, 1, new bytes[](0));

        address[] memory six = new address[](6);
        for (uint256 i; i < 6; ++i) {
            six[i] = _blob(10 + i);
        }
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadKeyCount.selector, 6));
        new PQVault(verifier, owner, six, 1, new bytes[](6));

        bytes[] memory proofs = _proofsForNextDeploy(_keys(0, 1, 2));
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadThreshold.selector, 0, 3));
        new PQVault(verifier, owner, _keys(0, 1, 2), 0, proofs);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadThreshold.selector, 4, 3));
        new PQVault(verifier, owner, _keys(0, 1, 2), 4, proofs);

        vm.expectRevert(abi.encodeWithSelector(PQVault.BadProofCount.selector, 1, 3));
        new PQVault(verifier, owner, _keys(0, 1, 2), 2, new bytes[](1));

        vm.expectRevert(abi.encodeWithSelector(PQVault.BadOwner.selector, address(0)));
        new PQVault(verifier, address(0), _keys(0), 1, _proofsForNextDeploy(_keys(0)));
    }

    function test_ConstructorRejectsDuplicateAndNonBlobKeys() public {
        address[] memory dup = _keys(0, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(PQVault.DuplicateKey.selector, blobs[0]));
        new PQVault(verifier, owner, dup, 2, _proofsForNextDeploy(dup));

        address[] memory eoa = new address[](1);
        eoa[0] = stranger;
        vm.expectRevert(abi.encodeWithSelector(PQVault.NotAKeyBlob.selector, stranger));
        new PQVault(verifier, owner, eoa, 1, _proofsForNextDeploy(eoa));

        address short = address(0xB10B_FFFF);
        vm.etch(short, new bytes(20_544));
        address[] memory s = new address[](1);
        s[0] = short;
        vm.expectRevert(abi.encodeWithSelector(PQVault.NotAKeyBlob.selector, short));
        new PQVault(verifier, owner, s, 1, _proofsForNextDeploy(s));
    }

    function test_ConstructorRequiresProofOfPossession() public {
        bytes[] memory proofs = _proofsForNextDeploy(_keys(0, 1, 2));
        proofs[1] = _sig(blobs[1], bytes32(uint256(1))); // signed the wrong thing
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadProof.selector, blobs[1]));
        new PQVault(verifier, owner, _keys(0, 1, 2), 2, proofs);
    }

    // ---- executing ---------------------------------------------------------------------------

    function test_ExecuteSendsGigAndBumpsNonce() public {
        PQVault v = _deploy(_keys(0), 1);
        vm.deal(address(v), 10 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 d = _digest(v, deadline, bob, 1 ether, "");
        bytes[] memory s = _sigs(v, d, _idx(0)); // before expectEmit: it applies to the next call

        vm.expectEmit(true, true, false, true, address(v));
        emit Executed(0, bob, 1 ether, d);
        vm.prank(owner);
        v.execute(bob, 1 ether, "", deadline, _idx(0), s);

        assertEq(bob.balance, 1 ether);
        assertEq(address(v).balance, 9 ether);
        assertEq(v.nonce(), 1);
    }

    function test_OnlyTheOwnerMayExecute() public {
        PQVault v = _deploy(_keys(0), 1);
        vm.deal(address(v), 1 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(v, _digest(v, deadline, bob, 1 ether, ""), _idx(0));

        vm.prank(stranger); // valid post-quantum signature, wrong classical account
        vm.expectRevert(PQVault.NotOwner.selector);
        v.execute(bob, 1 ether, "", deadline, _idx(0), s);
    }

    function test_RefusesAfterTheDeadline() public {
        PQVault v = _deploy(_keys(0), 1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(v, _digest(v, deadline, bob, 0, ""), _idx(0));
        vm.warp(deadline + 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PQVault.Expired.selector, deadline));
        v.execute(bob, 0, "", deadline, _idx(0), s);
    }

    function test_RefusesABadSignature() public {
        PQVault v = _deploy(_keys(0), 1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = new bytes[](1);
        s[0] = _sig(blobs[0], bytes32(uint256(42)));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
        v.execute(bob, 0, "", deadline, _idx(0), s);
    }

    function test_AVerifierRevertCountsAsRejection() public {
        PQVault v = _deploy(_keys(0), 1);
        verifier.setReverts(blobs[0], true);
        _execReverts(v, bob, 0, "", _idx(0), abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
    }

    function test_SignatureIsBoundToTheCall() public {
        PQVault v = _deploy(_keys(0), 1);
        vm.deal(address(v), 5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(v, _digest(v, deadline, bob, 1 ether, ""), _idx(0));
        vm.prank(owner); // same signature, larger amount
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
        v.execute(bob, 2 ether, "", deadline, _idx(0), s);
    }

    function test_SignatureCannotBeReplayed() public {
        PQVault v = _deploy(_keys(0), 1);
        vm.deal(address(v), 5 ether);
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(v, _digest(v, deadline, bob, 1 ether, ""), _idx(0));
        vm.prank(owner);
        v.execute(bob, 1 ether, "", deadline, _idx(0), s);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
        v.execute(bob, 1 ether, "", deadline, _idx(0), s);
        assertEq(bob.balance, 1 ether);
    }

    function test_SignatureIsBoundToTheChain() public {
        PQVault v = _deploy(_keys(0), 1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(v, _digest(v, deadline, bob, 0, ""), _idx(0));
        vm.chainId(4042); // the same vault address on Giggora's testnet
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
        v.execute(bob, 0, "", deadline, _idx(0), s);
    }

    function test_SignatureIsBoundToTheVault() public {
        PQVault a = _deploy(_keys(0), 1);
        PQVault b = _deploy(_keys(0), 1); // same key, different vault
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(a, _digest(a, deadline, bob, 0, ""), _idx(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
        b.execute(bob, 0, "", deadline, _idx(0), s);
    }

    // ---- thresholds --------------------------------------------------------------------------

    function test_TwoOfThreeAcceptsAnyTwoDistinctKeys() public {
        PQVault v = _deploy(_keys(0, 1, 2), 2);
        vm.deal(address(v), 3 ether);
        _exec(v, bob, 1 ether, "", _idx(0, 1));
        _exec(v, bob, 1 ether, "", _idx(0, 2));
        _exec(v, bob, 1 ether, "", _idx(1, 2));
        assertEq(bob.balance, 3 ether);
        assertEq(v.nonce(), 3);
    }

    function test_TwoOfThreeRefusesOneKeyTwice() public {
        PQVault v = _deploy(_keys(0, 1, 2), 2);
        bytes memory reason = abi.encodeWithSelector(PQVault.SignersNotAscending.selector);
        _execReverts(v, bob, 0, "", _idx(1, 1), reason);
        _execReverts(v, bob, 0, "", _idx(2, 0), reason);
    }

    function test_RefusesTheWrongNumberOfSignatures() public {
        PQVault v = _deploy(_keys(0, 1, 2), 2);
        _execReverts(v, bob, 0, "", _idx(0), abi.encodeWithSelector(PQVault.BadSignatureCount.selector, 1, 1, 2));

        uint256[] memory three = new uint256[](3);
        (three[0], three[1], three[2]) = (0, 1, 2);
        _execReverts(v, bob, 0, "", three, abi.encodeWithSelector(PQVault.BadSignatureCount.selector, 3, 3, 2));
    }

    function test_RefusesAnUnknownSigner() public {
        PQVault v = _deploy(_keys(0, 1, 2), 2);
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = new bytes[](2);
        s[0] = _sig(blobs[0], _digest(v, deadline, bob, 0, "")); // signer 0 is valid, so index 3 is reached
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PQVault.UnknownSigner.selector, 3));
        v.execute(bob, 0, "", deadline, _idx(0, 3), s);
    }

    // ---- failing calls -----------------------------------------------------------------------

    function test_AFailedCallKeepsItsReasonAndTheNonce() public {
        PQVault v = _deploy(_keys(0), 1);
        Gate gate = new Gate();
        bytes memory data = abi.encodeCall(Gate.enter, ());
        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(v, _digest(v, deadline, address(gate), 0, data), _idx(0));

        vm.prank(owner);
        vm.expectRevert(bytes("gate closed"));
        v.execute(address(gate), 0, data, deadline, _idx(0), s);
        assertEq(v.nonce(), 0, "a failed operation does not use up its nonce");

        gate.setOpen(true); // the same signed operation now goes through
        vm.prank(owner);
        v.execute(address(gate), 0, data, deadline, _idx(0), s);
        assertEq(v.nonce(), 1);
    }

    function test_ReenteringExecuteFails() public {
        PQVault v = _deploy(_keys(0), 1);
        Reenterer r = new Reenterer();
        _execReverts(
            v, address(r), 0, abi.encodeCall(Reenterer.attack, (v)), _idx(0), abi.encodeWithSelector(PQVault.NotOwner.selector)
        );
        assertEq(v.nonce(), 0);
    }

    // ---- administration through the vault itself --------------------------------------------

    function test_AdministrationRefusesDirectCalls() public {
        PQVault v = _deploy(_keys(0), 1);
        vm.startPrank(owner);
        vm.expectRevert(PQVault.NotSelf.selector);
        v.setOwner(stranger);
        vm.expectRevert(PQVault.NotSelf.selector);
        v.setKeys(_keys(1), 1, new bytes[](1));
        vm.stopPrank();
    }

    function test_RotatesKeysThroughItself() public {
        PQVault v = _deploy(_keys(0), 1);
        vm.deal(address(v), 2 ether);
        address[] memory next = new address[](2);
        (next[0], next[1]) = (blobs[1], blobs[2]);
        bytes[] memory proofs = new bytes[](2);
        for (uint256 i; i < 2; ++i) {
            proofs[i] = _sig(next[i], v.keyDigest(next[i]));
        }

        _exec(v, address(v), 0, abi.encodeCall(PQVault.setKeys, (next, 2, proofs)), _idx(0));

        assertEq(v.threshold(), 2);
        assertEq(v.keys().length, 2);
        assertEq(v.keyCodehash(blobs[0]), bytes32(0), "the old key is gone");

        // One signature no longer moves anything; the new pair does.
        _execReverts(v, bob, 1 ether, "", _idx(0), abi.encodeWithSelector(PQVault.BadSignatureCount.selector, 1, 1, 2));
        _exec(v, bob, 1 ether, "", _idx(0, 1));
        assertEq(bob.balance, 1 ether);
    }

    function test_RotationRequiresProofFromEveryNewKey() public {
        PQVault v = _deploy(_keys(0), 1);
        address[] memory next = new address[](2);
        (next[0], next[1]) = (blobs[1], blobs[2]);
        bytes[] memory proofs = new bytes[](2);
        proofs[0] = _sig(next[0], v.keyDigest(next[0]));
        proofs[1] = _sig(next[1], v.keyDigest(next[0])); // key 2 signed key 1's digest

        _execReverts(
            v,
            address(v),
            0,
            abi.encodeCall(PQVault.setKeys, (next, 1, proofs)),
            _idx(0),
            abi.encodeWithSelector(PQVault.BadProof.selector, blobs[2])
        );
        assertEq(v.keys()[0], blobs[0], "nothing changed");
    }

    function test_ChangesOwnerThroughItself() public {
        PQVault v = _deploy(_keys(0), 1);
        address newOwner = address(0xC0FFEE);
        _exec(v, address(v), 0, abi.encodeCall(PQVault.setOwner, (newOwner)), _idx(0));
        assertEq(v.owner(), newOwner);

        // the old owner is out
        _execReverts(v, bob, 0, "", _idx(0), abi.encodeWithSelector(PQVault.NotOwner.selector));

        uint256 deadline = block.timestamp + 1 hours;
        bytes[] memory s = _sigs(v, _digest(v, deadline, bob, 0, ""), _idx(0));
        vm.prank(newOwner);
        v.execute(bob, 0, "", deadline, _idx(0), s);
        assertEq(v.nonce(), 2);
    }

    function test_RefusesTheVaultAsItsOwnOwner() public {
        PQVault v = _deploy(_keys(0), 1);
        _execReverts(
            v,
            address(v),
            0,
            abi.encodeCall(PQVault.setOwner, (address(v))),
            _idx(0),
            abi.encodeWithSelector(PQVault.BadOwner.selector, address(v))
        );
    }

    function test_RefusesAKeyWhoseCodeChanged() public {
        PQVault v = _deploy(_keys(0), 1);
        bytes memory other = new bytes(20_545);
        other[2] = 0x01;
        vm.etch(blobs[0], other);
        _execReverts(v, bob, 0, "", _idx(0), abi.encodeWithSelector(PQVault.KeyCodeChanged.selector, blobs[0]));
    }

    // ---- holding and moving Giggora's tokens ---------------------------------------------------

    function test_OwnsGigTokenAndMintsThroughItself() public {
        PQVault v = _deploy(_keys(0), 1);
        GigToken token = new GigToken(address(v)); // the vault is the token's owner
        assertEq(token.balanceOf(address(v)), 1_000_000 ether);

        _exec(v, address(token), 0, abi.encodeCall(GigToken.mint, (bob, 5 ether)), _idx(0));
        _exec(v, address(token), 0, abi.encodeCall(token.transfer, (bob, 1 ether)), _idx(0));
        assertEq(token.balanceOf(bob), 6 ether);
    }

    function test_ReceivesAndSendsNftsAndMultiTokens() public {
        PQVault v = _deploy(_keys(0), 1);

        GigNFT nft = new GigNFT(address(this));
        uint256 tokenId = nft.safeMint(address(v), "ipfs://x"); // calls onERC721Received
        assertEq(nft.ownerOf(tokenId), address(v));
        _exec(v, address(nft), 0, abi.encodeCall(nft.transferFrom, (address(v), bob, tokenId)), _idx(0));
        assertEq(nft.ownerOf(tokenId), bob);

        GigMultiToken multi = new GigMultiToken(address(this));
        multi.mint(address(v), 1, 10, ""); // calls onERC1155Received
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        (ids[0], ids[1], amounts[0], amounts[1]) = (2, 3, 4, 5);
        multi.mintBatch(address(v), ids, amounts, ""); // calls onERC1155BatchReceived
        assertEq(multi.balanceOf(address(v), 3), 5);
        _exec(v, address(multi), 0, abi.encodeCall(multi.safeTransferFrom, (address(v), bob, 1, 10, "")), _idx(0));
        assertEq(multi.balanceOf(bob, 1), 10);
    }

    function test_ReceivesGigAndReportsReceiverInterfaces() public {
        PQVault v = _deploy(_keys(0), 1);
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool ok,) = address(v).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(v).balance, 1 ether);

        assertTrue(v.supportsInterface(type(IERC165).interfaceId));
        assertTrue(v.supportsInterface(type(IERC721Receiver).interfaceId));
        assertTrue(v.supportsInterface(type(IERC1155Receiver).interfaceId));
        assertFalse(v.supportsInterface(0xffffffff));
        assertEq(v.onERC721Received(address(0), address(0), 0, ""), IERC721Receiver.onERC721Received.selector);
        assertEq(v.onERC1155Received(address(0), address(0), 0, 0, ""), IERC1155Receiver.onERC1155Received.selector);
        assertEq(
            v.onERC1155BatchReceived(address(0), address(0), new uint256[](0), new uint256[](0), ""),
            IERC1155Receiver.onERC1155BatchReceived.selector
        );
    }

    function testFuzz_MovesExactlyTheSignedValue(uint96 value) public {
        PQVault v = _deploy(_keys(0, 1, 2), 2);
        vm.deal(address(v), value);
        _exec(v, bob, value, "", _idx(0, 2));
        assertEq(bob.balance, value);
        assertEq(address(v).balance, 0);
        assertEq(v.nonce(), 1);
    }
}

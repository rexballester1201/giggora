// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {MLDSA44Verifier} from "../vendor/evm-ml-dsa-verifier/src/MLDSA44Verifier.sol";
import {PQVault} from "giggora-pq/PQVault.sol";
import {IMLDSAVerifier as IVaultVerifier} from "giggora-pq/IMLDSAVerifier.sol";

// PQVault with the REAL ML-DSA-44 verifier and REAL signatures made by noble's post-quantum
// library (make-vault-fixtures.mjs). contracts/test/PQVault.t.sol covers the vault's logic
// with a stand-in verifier; this proves the two halves fit, and measures what they cost.
// (A plain comment: in a NatSpec comment the package name would parse as a tag.)
contract PQVaultIntegrationTest is Test {
    // The scenario make-vault-fixtures.mjs signed for. Change one, change both.
    address internal constant HELPER = address(0xF1600);
    address internal constant DEPLOYER = address(0xDE90);
    address internal constant OWNER = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    uint256 internal constant CHAIN_ID = 4043;
    uint256 internal constant DEADLINE = 2_000_000_000;

    struct Fixture {
        bytes helper;
        bytes[] blobs;
        bytes[] proofsU;
        bytes[] proofsT;
        bytes sigU0;
        bytes[] sigsT0;
        bytes setKeysData;
        bytes[] sigsT1;
        bytes sigT2;
        bytes32[] digests;
    }

    PQVault internal u; // personal: K0, threshold 1
    PQVault internal t; // treasury: K0, K1, K2, threshold 2
    uint256 internal deployGasU;
    uint256 internal deployGasT;

    /// Decoded fresh wherever it is needed: a struct of nested dynamic arrays is kept in
    /// memory rather than copied into storage.
    function _f() internal view returns (Fixture memory) {
        return abi.decode(vm.readFileBinary("fixtures/vault.bin"), (Fixture));
    }

    function _key(uint256 i) internal pure returns (address) {
        return address(uint160(0xC0DE_0000 + i));
    }

    function _one(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _idx(uint256 a) internal pure returns (uint256[] memory s) {
        s = new uint256[](1);
        s[0] = a;
    }

    function _idx(uint256 a, uint256 b) internal pure returns (uint256[] memory s) {
        s = new uint256[](2);
        (s[0], s[1]) = (a, b);
    }

    function _bytes1(bytes memory b) internal pure returns (bytes[] memory r) {
        r = new bytes[](1);
        r[0] = b;
    }

    function setUp() public {
        Fixture memory f = _f();
        vm.chainId(CHAIN_ID);
        vm.warp(1_900_000_000);

        vm.etch(HELPER, f.helper);
        IVaultVerifier verifier = IVaultVerifier(address(new MLDSA44Verifier(HELPER)));
        for (uint256 i; i < 3; ++i) {
            vm.etch(_key(i), f.blobs[i]);
        }

        address[] memory treasuryKeys = new address[](3);
        (treasuryKeys[0], treasuryKeys[1], treasuryKeys[2]) = (_key(0), _key(1), _key(2));

        uint256 g = gasleft();
        vm.prank(DEPLOYER);
        u = new PQVault(verifier, OWNER, _one(_key(0)), 1, f.proofsU);
        deployGasU = g - gasleft();

        g = gasleft();
        vm.prank(DEPLOYER);
        t = new PQVault(verifier, OWNER, treasuryKeys, 2, f.proofsT);
        deployGasT = g - gasleft();

        require(address(u) == vm.computeCreateAddress(DEPLOYER, 0), "U is not where the fixtures signed for");
        require(address(t) == vm.computeCreateAddress(DEPLOYER, 1), "T is not where the fixtures signed for");
        vm.deal(address(u), 10 ether);
        vm.deal(address(t), 10 ether);
    }

    function _exec(PQVault v, address target, uint256 value, bytes memory data, uint256[] memory s, bytes[] memory sigs)
        internal
        returns (uint256 used)
    {
        vm.prank(OWNER);
        uint256 g = gasleft();
        v.execute(target, value, data, DEADLINE, s, sigs);
        used = g - gasleft();
    }

    /// The digests an off-chain signer computed are the ones the contract checks.
    function test_DigestsAgreeWithTheOffChainSigner() public view {
        Fixture memory f = _f();
        assertEq(u.operationDigest(0, DEADLINE, BOB, 1 ether, keccak256("")), f.digests[0], "U op 0");
        assertEq(t.operationDigest(0, DEADLINE, BOB, 2 ether, keccak256("")), f.digests[1], "T op 0");
        assertEq(t.operationDigest(1, DEADLINE, address(t), 0, keccak256(f.setKeysData)), f.digests[2], "T op 1");
        assertEq(t.operationDigest(2, DEADLINE, BOB, 0.5 ether, keccak256("")), f.digests[3], "T op 2");
        assertEq(u.keyDigest(_key(0)), f.digests[4], "U key 0");
        for (uint256 i; i < 3; ++i) {
            assertEq(t.keyDigest(_key(i)), f.digests[5 + i], "T key");
        }
    }

    function test_PersonalVaultPaysOnceWithARealSignature() public {
        Fixture memory f = _f();
        uint256 used = _exec(u, BOB, 1 ether, "", _idx(0), _bytes1(f.sigU0));
        assertEq(BOB.balance, 1 ether);
        console.log("deploy personal vault (1 key proof)", deployGasU);
        console.log("execute, 1 of 1", used);

        // The same signature again: the nonce has moved on.
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
        u.execute(BOB, 1 ether, "", DEADLINE, _idx(0), _bytes1(f.sigU0));
    }

    function test_TreasuryPaysRotatesAndPaysAgain() public {
        Fixture memory f = _f();
        uint256 pay2of3 = _exec(t, BOB, 2 ether, "", _idx(0, 2), f.sigsT0);
        assertEq(BOB.balance, 2 ether);

        uint256 rotate = _exec(t, address(t), 0, f.setKeysData, _idx(0, 1), f.sigsT1);
        assertEq(t.threshold(), 1);
        assertEq(t.keys().length, 2);
        assertEq(t.keyCodehash(_key(0)), bytes32(0), "K0 is retired");

        uint256 pay1 = _exec(t, BOB, 0.5 ether, "", _idx(1), _bytes1(f.sigT2)); // K2 is index 1 now
        assertEq(BOB.balance, 2.5 ether);
        assertEq(t.nonce(), 3);

        console.log("deploy treasury vault (3 key proofs)", deployGasT);
        console.log("execute, 2 of 3", pay2of3);
        console.log("rotate keys: 2 signatures + 2 proofs", rotate);
        console.log("execute, 1 of 2 after rotation", pay1);
    }

    function test_RealSignaturesDoNotCrossVaultsChainsOrTampering() public {
        Fixture memory f = _f();
        // U's signature, offered to T for T's own operation, alongside K2's valid one.
        bytes[] memory cross = new bytes[](2);
        (cross[0], cross[1]) = (f.sigU0, f.sigsT0[1]);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
        t.execute(BOB, 2 ether, "", DEADLINE, _idx(0, 2), cross);

        // One flipped bit in the signature.
        bytes memory bent = bytes.concat(f.sigU0);
        bent[100] = bent[100] ^ bytes1(0x01);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
        u.execute(BOB, 1 ether, "", DEADLINE, _idx(0), _bytes1(bent));

        // The same vault address and signature on Giggora's testnet chain id.
        vm.chainId(4042);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(PQVault.BadSignature.selector, 0));
        u.execute(BOB, 1 ether, "", DEADLINE, _idx(0), _bytes1(f.sigU0));
        assertEq(BOB.balance, 0);
    }
}

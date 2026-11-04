// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {MLDSA44Verifier} from "../vendor/evm-ml-dsa-verifier/src/MLDSA44Verifier.sol";

/// Calls the verifier from a fresh call frame, so the gas it reports is what a vault
/// contract would pay for the call, not the test contract's multi-megabyte memory.
contract Meter {
    function measure(MLDSA44Verifier v, address pk, bytes calldata m, bytes calldata s)
        external
        view
        returns (bool ok, uint256 used)
    {
        uint256 g = gasleft();
        try v.verify(pk, m, s) returns (bool r) {
            ok = r;
        } catch {
            ok = false; // a revert is a rejection (IMLDSAVerifier: only `true` is acceptance)
        }
        used = g - gasleft();
    }
}

/// Runs CREATE from a fresh call frame and reports its gas: deployment cost on chain,
/// minus only the transaction's 21,000 base and calldata.
contract Deployer {
    function create(bytes calldata init) external returns (address a, uint256 used) {
        bytes memory code = init;
        uint256 g = gasleft();
        assembly ("memory-safe") {
            a := create(0, add(code, 32), mload(code))
        }
        used = g - gasleft();
        require(a != address(0), "CREATE failed");
    }
}

contract VerifierSpikeTest is Test {
    address internal constant HELPER = address(0xF1600);
    uint256 internal constant EIP170_LIMIT = 24_576;
    uint256 internal constant PK_BLOB_SIZE = 20_545;

    function _load()
        internal
        view
        returns (
            bytes memory helper,
            bytes[] memory blobs,
            uint256[] memory key,
            bytes[] memory msgs,
            bytes[] memory sigs,
            bool[] memory expect,
            string[] memory labels
        )
    {
        return abi.decode(
            vm.readFileBinary("fixtures/cases.bin"),
            (bytes, bytes[], uint256[], bytes[], bytes[], bool[], string[])
        );
    }

    function _pkAddr(uint256 i) internal pure returns (address) {
        return address(uint160(0x9000_0000 + i));
    }

    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(p);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    /// Every case: the verifier's verdict must equal the oracle's (NIST, cross-checked by noble).
    function test_vectors() public {
        (
            bytes memory helper,
            bytes[] memory blobs,
            uint256[] memory key,
            bytes[] memory msgs,
            bytes[] memory sigs,
            bool[] memory expect,
            string[] memory labels
        ) = _load();

        vm.etch(HELPER, helper);
        // The constructor reverts unless the helper is byte-identical to the one the verifier pins.
        MLDSA44Verifier v = new MLDSA44Verifier(HELPER);
        for (uint256 i; i < blobs.length; ++i) {
            vm.etch(_pkAddr(i), blobs[i]);
        }
        Meter meter = new Meter();

        uint256 wrong;
        uint256[3] memory acc = [type(uint256).max, 0, 0]; // min, max, sum
        uint256[3] memory rej = [type(uint256).max, 0, 0];
        uint256 nAcc;
        uint256 nRej;
        for (uint256 i; i < labels.length; ++i) {
            (bool ok, uint256 used) = meter.measure(v, _pkAddr(key[i]), msgs[i], sigs[i]);
            if (ok != expect[i]) {
                ++wrong;
                console.log("WRONG VERDICT:", labels[i]);
            }
            uint256[3] memory s = ok ? acc : rej;
            if (used < s[0]) s[0] = used;
            if (used > s[1]) s[1] = used;
            s[2] += used;
            if (ok) ++nAcc;
            else ++nRej;
            if (_startsWith(labels[i], "fresh key 0, |M| = ") && expect[i]) console.log(labels[i], used);
        }

        console.log("cases", labels.length, "distinct keys", blobs.length);
        console.log("accepted", nAcc, "rejected", nRej);
        // Guarded: if Cancun broke the verifier and nothing was accepted, report that, do not panic.
        console.log("accept gas  min / avg / max", acc[0], nAcc == 0 ? 0 : acc[2] / nAcc, acc[1]);
        console.log("reject gas  min / avg / max", rej[0], nRej == 0 ? 0 : rej[2] / nRej, rej[1]);
        assertEq(wrong, 0, "verdicts that differ from NIST and noble");
    }

    /// One-time costs: the shared Keccak helper, the verifier, and one key's blob.
    function test_deploymentCosts() public {
        (bytes memory helper, bytes[] memory blobs,,,,,) = _load();
        Deployer d = new Deployer();

        (address h, uint256 helperGas) = d.create(_rawInit(helper));
        assertEq(h.code.length, helper.length, "helper deployed whole");

        (address v, uint256 verifierGas) =
            d.create(abi.encodePacked(type(MLDSA44Verifier).creationCode, abi.encode(h)));
        assertLe(v.code.length, EIP170_LIMIT, "verifier must fit EIP-170");

        (address pk, uint256 keyGas) = d.create(_rawInit(blobs[0]));
        assertEq(pk.code.length, PK_BLOB_SIZE, "key blob deployed whole");

        console.log("verifier runtime bytes", v.code.length, "EIP-170 limit", EIP170_LIMIT);
        console.log("helper runtime bytes", h.code.length);
        console.log("CREATE gas: helper", helperGas);
        console.log("CREATE gas: verifier", verifierGas);
        console.log("CREATE gas: one key", keyGas);
    }

    /// Init code that returns `runtime` as the new contract's code:
    /// PUSH2 len, DUP1, PUSH1 12, PUSH1 0, CODECOPY, PUSH1 0, RETURN, then the runtime itself.
    function _rawInit(bytes memory runtime) internal pure returns (bytes memory) {
        require(runtime.length <= 0xffff, "runtime too large for PUSH2");
        return abi.encodePacked(hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime);
    }
}

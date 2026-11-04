// SPDX-License-Identifier: MIT
// Copied from Fireblocks Labs' evm-ml-dsa-verifier, src/IMLDSAVerifier.sol at commit
// cca262b537a5ac2ee55efb427e5c61de0308e566. Copyright (c) 2026 Fireblocks Ltd, MIT licence:
// https://github.com/fireblocks-labs/evm-ml-dsa-verifier/blob/cca262b537a5ac2ee55efb427e5c61de0308e566/LICENSE
pragma solidity ^0.8.25;

/// @title  IMLDSAVerifier: on-chain FIPS 204 ML-DSA-44 signature verification
/// @notice Pure (non-prehashed) ML-DSA-44 with an EMPTY context string: the verifier
///         forms M' = 0x00 || 0x00 || M itself. `signature` is the standard 2,420-byte
///         encoding. `pkBlob` is the address of a data contract whose code is the output
///         of the verifier's prepare/prepare.py run on the standard 1,312-byte public key.
///         Returning false and reverting both mean "not accepted"; only true is acceptance.
///         Safe to STATICCALL: no state writes, no logs, no calls out but its own helper.
interface IMLDSAVerifier {
    function verify(address pkBlob, bytes calldata message, bytes calldata signature)
        external
        view
        returns (bool accepted);
}

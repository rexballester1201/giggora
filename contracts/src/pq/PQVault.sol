// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IMLDSAVerifier} from "./IMLDSAVerifier.sol";

/// @title  PQVault: a contract account that needs a post-quantum signature to act
/// @notice Holds GIG and tokens, and acts only when BOTH of these hold:
///           1. the transaction comes from `owner`, an ordinary secp256k1 account such
///              as the owner's MetaMask account; and
///           2. it carries `threshold` valid ML-DSA-44 (NIST FIPS 204) signatures, from
///              distinct registered keys, over the operation's digest.
///         A quantum computer that breaks secp256k1 gets only the first. A bug in the
///         young ML-DSA verifier gets only the second. Neither alone moves anything, so a
///         vault is never weaker than an ordinary account.
///
///         One key with threshold 1 is a personal vault; three keys with threshold 2 is
///         the treasury shape. Changing the owner, the keys or the threshold goes through
///         the same signed path as everything else: the vault calls itself.
///
/// @dev    UNAUDITED, and so is the verifier it relies on.
///
///         WHAT THE KEYS SIGN. The 32 bytes of `operationDigest(...)`, as the message M of
///         pure ML-DSA-44 with an empty context string. The digest binds the chain id, this
///         vault's address, the nonce, a deadline and the exact call, so a signature works
///         once, on this vault, on this chain, before its deadline. A failed call reverts
///         the nonce bump with it, so the same signed operation can be retried until then.
///
///         KEYS. ML-DSA-44 public keys prepared by the verifier's prepare.py and deployed
///         as data contracts ("key blobs"). Registration checks that each key is a deployed
///         20,545-byte blob, pins its code hash, and makes it prove possession by signing
///         `keyDigest(key)`, so a rotation cannot lock the vault behind a key nobody holds.
///         What the vault CANNOT check is that a blob was built from a genuine key rather
///         than crafted (the verifier's docs/SAFETY.md, section 3). Whoever registers a key
///         must rebuild its blob from the 1,312-byte public key and compare it byte for byte.
///
///         NOT HERE YET. A delay on large transfers, and recovery when keys are lost. Both
///         need decisions first (what counts as large, who may cancel, who recovers).
contract PQVault {
    /// @notice Most keys a vault may hold. Bounds the gas of a key rotation, which
    ///         verifies one proof per key.
    uint256 public constant MAX_KEYS = 5;
    /// @notice Size of a key blob: prepare.py's 0x00 prefix plus its 20,544-byte payload.
    uint256 public constant KEY_BLOB_SIZE = 20_545;

    bytes32 public constant OPERATION_TYPEHASH = keccak256(
        "PQVault.Operation(uint256 chainId,address vault,uint256 nonce,uint256 deadline,address target,uint256 value,bytes32 dataHash)"
    );
    bytes32 public constant KEY_TYPEHASH = keccak256("PQVault.Key(uint256 chainId,address vault,address key)");

    // Return values the token standards require from a receiver.
    bytes4 private constant ERC721_RECEIVED = 0x150b7a02;
    bytes4 private constant ERC1155_RECEIVED = 0xf23a6e61;
    bytes4 private constant ERC1155_BATCH_RECEIVED = 0xbc197c81;

    // Lower case on purpose: `verifier()` is part of the vault's public interface.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IMLDSAVerifier public immutable verifier;

    address public owner;
    uint256 public threshold;
    /// @notice The nonce the next operation must be signed for.
    uint256 public nonce;

    address[] private _keys;
    /// @notice Code hash pinned when a key was registered; zero for any other address.
    mapping(address key => bytes32 codehash) public keyCodehash;

    event Executed(uint256 indexed nonce, address indexed target, uint256 value, bytes32 digest);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event KeysChanged(address[] keys, uint256 threshold);

    error NotOwner();
    error NotSelf();
    error Expired(uint256 deadline);
    error BadOwner(address owner);
    error BadKeyCount(uint256 count);
    error BadThreshold(uint256 threshold, uint256 keyCount);
    error BadProofCount(uint256 proofs, uint256 keys);
    error DuplicateKey(address key);
    error NotAKeyBlob(address key);
    error BadProof(address key);
    error BadSignatureCount(uint256 signers, uint256 signatures, uint256 threshold);
    error SignersNotAscending();
    error UnknownSigner(uint256 index);
    error KeyCodeChanged(address key);
    error BadSignature(uint256 position);

    modifier onlySelf() {
        _onlySelf();
        _;
    }

    /// @param proofs one ML-DSA-44 signature per key over keyDigest(key), for the address
    ///               this vault is being deployed to
    constructor(
        IMLDSAVerifier verifier_,
        address owner_,
        address[] memory keys_,
        uint256 threshold_,
        bytes[] memory proofs
    ) {
        verifier = verifier_;
        _setOwner(owner_);
        // The verifier is passed explicitly: an immutable cannot be read inside a
        // function while the contract is still being constructed.
        _setKeys(verifier_, keys_, threshold_, proofs);
    }

    // ---- the one way to act ------------------------------------------------------------

    /// @notice Perform `target.call{value: value}(data)` as this vault.
    /// @param deadline   last block timestamp at which this operation may run
    /// @param signers    indices into keys(), strictly ascending, exactly `threshold` of them
    /// @param signatures one 2,420-byte ML-DSA-44 signature per signer, over
    ///                   operationDigest(nonce(), deadline, target, value, keccak256(data))
    /// @return result    whatever the call returned. The vault does not interpret it: a token
    ///                   that reports failure by returning false must be checked by the caller.
    function execute(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 deadline,
        uint256[] calldata signers,
        bytes[] calldata signatures
    ) external returns (bytes memory result) {
        if (msg.sender != owner) revert NotOwner();
        if (block.timestamp > deadline) revert Expired(deadline);

        uint256 n = nonce;
        bytes32 digest = operationDigest(n, deadline, target, value, keccak256(data));
        _requireSignatures(digest, signers, signatures);

        nonce = n + 1; // before the call, so a re-entrant operation needs its own signatures
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) {
            // Fail with the target's own reason. The nonce bump is undone with it.
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
        emit Executed(n, target, value, digest);
    }

    // ---- administration: reachable only through execute(), as a call to the vault itself ----

    function setOwner(address newOwner) external onlySelf {
        _setOwner(newOwner);
    }

    /// @param proofs one signature per new key over keyDigest(key). Every key, kept or new,
    ///               proves again that its holder can sign.
    function setKeys(address[] calldata newKeys, uint256 newThreshold, bytes[] calldata proofs)
        external
        onlySelf
    {
        _setKeys(verifier, newKeys, newThreshold, proofs);
    }

    // ---- views ---------------------------------------------------------------------------

    function keys() external view returns (address[] memory) {
        return _keys;
    }

    /// @notice The 32 bytes the keys sign for an operation.
    function operationDigest(uint256 nonce_, uint256 deadline, address target, uint256 value, bytes32 dataHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(OPERATION_TYPEHASH, block.chainid, address(this), nonce_, deadline, target, value, dataHash)
        );
    }

    /// @notice The 32 bytes a key signs to prove possession when it is registered.
    function keyDigest(address key) public view returns (bytes32) {
        return keccak256(abi.encode(KEY_TYPEHASH, block.chainid, address(this), key));
    }

    // ---- receiving GIG and tokens --------------------------------------------------------

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return ERC721_RECEIVED;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return ERC1155_RECEIVED;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return ERC1155_BATCH_RECEIVED;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == ERC721_RECEIVED // ERC-721 receiver
            || interfaceId == 0x4e2312e0; // ERC-1155 receiver
    }

    // ---- internals -----------------------------------------------------------------------

    function _onlySelf() private view {
        if (msg.sender != address(this)) revert NotSelf();
    }

    function _setOwner(address newOwner) private {
        if (newOwner == address(0) || newOwner == address(this)) revert BadOwner(newOwner);
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function _setKeys(IMLDSAVerifier v, address[] memory newKeys, uint256 newThreshold, bytes[] memory proofs)
        private
    {
        uint256 count = newKeys.length;
        if (count == 0 || count > MAX_KEYS) revert BadKeyCount(count);
        if (newThreshold == 0 || newThreshold > count) revert BadThreshold(newThreshold, count);
        if (proofs.length != count) revert BadProofCount(proofs.length, count);

        for (uint256 i = _keys.length; i > 0; --i) {
            delete keyCodehash[_keys[i - 1]];
            _keys.pop();
        }
        for (uint256 i; i < count; ++i) {
            address key = newKeys[i];
            if (keyCodehash[key] != bytes32(0)) revert DuplicateKey(key);
            if (key.code.length != KEY_BLOB_SIZE) revert NotAKeyBlob(key);
            keyCodehash[key] = key.codehash;
            _keys.push(key);
            if (!_accepts(v, key, keyDigest(key), proofs[i])) revert BadProof(key);
        }
        threshold = newThreshold;
        emit KeysChanged(newKeys, newThreshold);
    }

    function _requireSignatures(bytes32 digest, uint256[] calldata signers, bytes[] calldata signatures)
        private
        view
    {
        uint256 t = threshold;
        if (signers.length != t || signatures.length != t) {
            revert BadSignatureCount(signers.length, signatures.length, t);
        }
        IMLDSAVerifier v = verifier;
        uint256 lowest; // the smallest index the next signer may have
        for (uint256 i; i < t; ++i) {
            uint256 k = signers[i];
            if (k < lowest) revert SignersNotAscending();
            if (k >= _keys.length) revert UnknownSigner(k);
            lowest = k + 1;
            address key = _keys[k];
            // A key blob cannot change (its code starts with STOP), but checking the pinned
            // hash costs about 100 gas net: it pays the key's cold-account charge, which the
            // verifier's own EXTCODESIZE would otherwise pay. Any surprise becomes a refusal.
            if (key.codehash != keyCodehash[key]) revert KeyCodeChanged(key);
            if (!_accepts(v, key, digest, signatures[i])) revert BadSignature(i);
        }
    }

    /// The verifier signals rejection by returning false OR by reverting; both are "no".
    function _accepts(IMLDSAVerifier v, address key, bytes32 digest, bytes memory signature)
        private
        view
        returns (bool)
    {
        try v.verify(key, abi.encodePacked(digest), signature) returns (bool accepted) {
            return accepted;
        } catch {
            return false;
        }
    }
}

/**
 * Token transfer decoding.
 *
 * Turns raw logs into token_transfers rows. The distinctions here are exactly
 * the ones verified on chain in scripts/deploy-contracts.mjs:
 *
 *   ERC-20   Transfer(address indexed from, address indexed to, uint256 value)
 *            -> 3 topics, value in data
 *
 *   ERC-721  Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
 *            -> 4 topics, data empty
 *
 * Both share the SAME topic0. Topic count is the only way to tell them apart,
 * which is why it is asserted by a test rather than assumed.
 */

import { keccak256, toHex } from "viem";
import { toBytes, topicToAddress, wordAt } from "./hex.ts";

export const TOPIC_TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
export const TOPIC_TRANSFER_SINGLE = keccak256(
  toHex("TransferSingle(address,address,address,uint256,uint256)")
);
export const TOPIC_TRANSFER_BATCH = keccak256(
  toHex("TransferBatch(address,address,address,uint256[],uint256[])")
);

export type Standard = "erc20" | "erc721" | "erc1155";

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
}

export interface DecodedTransfer {
  batchIndex: number;
  tokenAddress: Buffer;
  standard: Standard;
  fromAddress: Buffer;
  toAddress: Buffer;
  value: bigint | null;
  tokenId: bigint | null;
}

/**
 * Decode one log into zero or more token transfers.
 * A batch transfer yields one row per id.
 *
 * Returns [] for anything that is not a recognised token event. Malformed logs
 * return [] rather than throwing: a single odd contract must not be able to
 * halt the whole indexer.
 */
export function decodeTransfers(log: RawLog): DecodedTransfer[] {
  const topic0 = log.topics[0];
  if (!topic0) return [];

  const token = toBytes(log.address)!;

  try {
    if (topic0 === TOPIC_TRANSFER) {
      // 3 topics -> ERC-20 (value in data). 4 topics -> ERC-721 (tokenId indexed).
      if (log.topics.length === 3) {
        return [
          {
            batchIndex: 0,
            tokenAddress: token,
            standard: "erc20",
            fromAddress: topicToAddress(log.topics[1]),
            toAddress: topicToAddress(log.topics[2]),
            value: log.data && log.data !== "0x" ? wordAt(log.data, 0) : 0n,
            tokenId: null,
          },
        ];
      }
      if (log.topics.length === 4) {
        return [
          {
            batchIndex: 0,
            tokenAddress: token,
            standard: "erc721",
            fromAddress: topicToAddress(log.topics[1]),
            toAddress: topicToAddress(log.topics[2]),
            value: null,
            tokenId: BigInt(log.topics[3]),
          },
        ];
      }
      return [];
    }

    if (topic0 === TOPIC_TRANSFER_SINGLE) {
      // topics: sig, operator, from, to | data: id, value
      if (log.topics.length !== 4) return [];
      return [
        {
          batchIndex: 0,
          tokenAddress: token,
          standard: "erc1155",
          fromAddress: topicToAddress(log.topics[2]),
          toAddress: topicToAddress(log.topics[3]),
          value: wordAt(log.data, 1),
          tokenId: wordAt(log.data, 0),
        },
      ];
    }

    if (topic0 === TOPIC_TRANSFER_BATCH) {
      // topics: sig, operator, from, to
      // data: offset(ids), offset(values), len(ids), ids..., len(values), values...
      if (log.topics.length !== 4) return [];
      const from = topicToAddress(log.topics[2]);
      const to = topicToAddress(log.topics[3]);

      // Offsets are byte offsets into data; convert to 32-byte word indices.
      const idsOffsetWords = Number(wordAt(log.data, 0)) / 32;
      const valuesOffsetWords = Number(wordAt(log.data, 1)) / 32;

      const idsLen = Number(wordAt(log.data, idsOffsetWords));
      const valuesLen = Number(wordAt(log.data, valuesOffsetWords));
      if (idsLen !== valuesLen) return [];

      const out: DecodedTransfer[] = [];
      for (let i = 0; i < idsLen; i++) {
        out.push({
          batchIndex: i,
          tokenAddress: token,
          standard: "erc1155",
          fromAddress: from,
          toAddress: to,
          value: wordAt(log.data, valuesOffsetWords + 1 + i),
          tokenId: wordAt(log.data, idsOffsetWords + 1 + i),
        });
      }
      return out;
    }
  } catch {
    // Malformed data from an arbitrary contract must not stop indexing.
    return [];
  }

  return [];
}

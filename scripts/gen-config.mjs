#!/usr/bin/env node
/**
 * Giggora config generator.
 *
 * Reads blockchain/config/chain.config.json (the single source of truth) and emits:
 *   - blockchain/genesis/qbftConfigFile.json   (input to `besu operator generate-blockchain-config`)
 *   - .env                                     (runtime config for every service)
 *
 * Zero npm dependencies by design, so it runs before any install step.
 * Brief refs: §3 (central config, no hard-coding), §6 (reproducible genesis).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "blockchain", "config", "chain.config.json");
const QBFT_OUT = join(ROOT, "blockchain", "genesis", "qbftConfigFile.json");
const ENV_OUT = join(ROOT, ".env");

const WEI_PER_GIG = 10n ** 18n;

function die(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(CONFIG_PATH)) die(`missing ${CONFIG_PATH}`);
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

const netName = cfg.activeNetwork;
const net = cfg.networks[netName];
if (!net) die(`activeNetwork "${netName}" not found in networks`);

// ---------------------------------------------------------------------------
// Validate supply. A typo here mints or burns money silently, so it is checked
// rather than trusted.
// ---------------------------------------------------------------------------
const expectedTotal = BigInt(cfg.supply.total) * WEI_PER_GIG;
let actualTotal = 0n;
const alloc = {};

for (const a of cfg.supply.allocations) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.address)) {
    die(`allocation "${a.role}" has a malformed address: ${a.address}`);
  }
  const key = a.address.toLowerCase().replace(/^0x/, "");
  if (alloc[key]) die(`address ${a.address} appears twice in allocations`);
  const wei = BigInt(a.gig) * WEI_PER_GIG;
  actualTotal += wei;
  alloc[key] = { balance: wei.toString() };
}

if (actualTotal !== expectedTotal) {
  die(
    `allocations sum to ${actualTotal / WEI_PER_GIG} GIG but supply.total says ${cfg.supply.total} GIG.\n` +
      `  Difference: ${(actualTotal - expectedTotal) / WEI_PER_GIG} GIG.`
  );
}

// ---------------------------------------------------------------------------
// Hardfork schedule.
//
// Shanghai is the ceiling on purpose. Setting cancunTime on a QBFT chain makes
// Besu attempt EIP-4788 beacon-root system calls, which do not exist outside a
// PoS chain -> "Invalid system call address" every block (besu issue #9379).
// ---------------------------------------------------------------------------
const forkConfig = {
  homesteadBlock: 0,
  eip150Block: 0,
  eip155Block: 0,
  eip158Block: 0,
  byzantiumBlock: 0,
  constantinopleBlock: 0,
  petersburgBlock: 0,
  istanbulBlock: 0,
  berlinBlock: 0,
  londonBlock: 0,
  shanghaiTime: 0,
};

if (cfg.genesis.hardfork !== "shanghai") {
  die(
    `genesis.hardfork is "${cfg.genesis.hardfork}". Only "shanghai" is supported.\n` +
      `  Cancun breaks QBFT (EIP-4788 beacon roots). See chain.config.json _hardforkNote.`
  );
}

// Sanity check: a fixed base fee must equal the min gas price, or wallets that
// estimate from the base fee will underpay the node's floor and hang forever.
if (cfg.genesis.fixedBaseFee && BigInt(cfg.genesis.baseFeePerGas) !== BigInt(cfg.gas.minGasPriceWei)) {
  die(
    `fixedBaseFee is on but baseFeePerGas (${cfg.genesis.baseFeePerGas}) != minGasPriceWei (${cfg.gas.minGasPriceWei}).\n` +
      `  They must match, or transactions will be accepted into the pool and never mined.`
  );
}

const c = cfg.consensus;
const qbftConfigFile = {
  genesis: {
    config: {
      chainId: net.chainId,
      ...forkConfig,
      ...(cfg.genesis.fixedBaseFee ? { fixedBaseFee: true } : {}),
      qbft: {
        blockperiodseconds: c.blockPeriodSeconds,
        emptyblockperiodseconds: c.emptyBlockPeriodSeconds,
        epochlength: c.epochLength,
        requesttimeoutseconds: c.requestTimeoutSeconds,
        blockreward: "0x" + BigInt(c.blockReward).toString(16),
      },
    },
    nonce: "0x0",
    timestamp: "0x0",
    gasLimit: "0x" + BigInt(cfg.genesis.gasLimit).toString(16),
    difficulty: "0x1",
    // Fixed QBFT/IBFT2 magic value. Besu rejects the genesis without it.
    mixHash: "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
    coinbase: "0x0000000000000000000000000000000000000000",
    baseFeePerGas: "0x" + BigInt(cfg.genesis.baseFeePerGas).toString(16),
    alloc,
  },
  blockchain: {
    nodes: {
      generate: true,
      count: c.validatorCount,
    },
  },
};

mkdirSync(dirname(QBFT_OUT), { recursive: true });
writeFileSync(QBFT_OUT, JSON.stringify(qbftConfigFile, null, 2) + "\n");

// ---------------------------------------------------------------------------
// .env — runtime config consumed by docker-compose and every service.
// BOOTNODE_ENODE is filled in later by create-genesis.sh, once node keys exist.
// ---------------------------------------------------------------------------
const p = cfg.ports;
const dn = cfg.docker.network;

// Static IPs. Besu rejects a DNS hostname in an enode URL, so the bootnode
// must live at a fixed address.
const validatorIps = [];
for (let i = 0; i < c.validatorCount; i++) {
  validatorIps.push(`${dn.validatorIpPrefix}${dn.validatorIpStart + i}`);
}

const envLines = [
  "# GENERATED by scripts/gen-config.mjs — DO NOT EDIT BY HAND.",
  "# Edit blockchain/config/chain.config.json and re-run: bash scripts/create-genesis.sh",
  `# Generated: ${new Date().toISOString()}`,
  "",
  `COMPOSE_PROJECT_NAME=giggora`,
  `BESU_IMAGE=${cfg.docker.besuImage}`,
  "",
  `CHAIN_NAME=${cfg.chain.name}`,
  `CHAIN_NETWORK=${netName}`,
  `CHAIN_ID=${net.chainId}`,
  `NETWORK_ID=${net.networkId}`,
  `CURRENCY_NAME=${cfg.chain.currency.name}`,
  `CURRENCY_SYMBOL=${cfg.chain.currency.symbol}`,
  `CURRENCY_DECIMALS=${cfg.chain.currency.decimals}`,
  "",
  `VALIDATOR_COUNT=${c.validatorCount}`,
  `BLOCK_PERIOD_SECONDS=${c.blockPeriodSeconds}`,
  `EMPTY_BLOCK_PERIOD_SECONDS=${c.emptyBlockPeriodSeconds}`,
  `MIN_GAS_PRICE=${cfg.gas.minGasPriceWei}`,
  "",
  `RPC_HTTP_PORT=${p.rpcHttp}`,
  `RPC_WS_PORT=${p.rpcWs}`,
  `P2P_PORT=${p.p2p}`,
  "",
  `RPC_URL=http://localhost:${p.rpcHttp}`,
  `WS_URL=ws://localhost:${p.rpcWs}`,
  "",
  "# --- static container IPs ---",
  "# Required: Besu rejects an enode URL whose host is a DNS name.",
  `DOCKER_SUBNET=${dn.subnet}`,
  ...validatorIps.map((ip, i) => `VALIDATOR_${i + 1}_IP=${ip}`),
  `RPC_IP=${dn.rpcIp}`,
  `BOOTNODE_IP=${validatorIps[0]}`,
  "",
  "# Filled in by scripts/create-genesis.sh after node keys are generated.",
  "BOOTNODE_ENODE=",
  "",
];

writeFileSync(ENV_OUT, envLines.join("\n"));

// ---------------------------------------------------------------------------
console.log(`
  Giggora config generated
  ------------------------
  Network        ${cfg.chain.name} ${netName}
  Chain ID       ${net.chainId}
  Currency       ${cfg.chain.currency.symbol} (${cfg.chain.currency.decimals} decimals)
  Validators     ${c.validatorCount}  (QBFT, tolerates ${Math.floor((c.validatorCount - 1) / 3)} faulty)
  Block time     ${c.blockPeriodSeconds}s
  Gas limit      ${Number(cfg.genesis.gasLimit).toLocaleString("en-US")}
  Hardfork       ${cfg.genesis.hardfork}
  Total supply   ${Number(cfg.supply.total).toLocaleString("en-US")} ${cfg.chain.currency.symbol}  [sum verified]

  Wrote  blockchain/genesis/qbftConfigFile.json
  Wrote  .env
`);

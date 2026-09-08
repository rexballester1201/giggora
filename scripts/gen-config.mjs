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

// A public network's genesis must never fund an address whose private key is
// public knowledge. `supply.allocations` is shared across networks, and the
// devnet allocations are ALL well-known dev accounts — so switching
// activeNetwork to testnet or mainnet and regenerating would, without this
// check, hand 100% of the supply to keys every Foundry user already has.
const isPublic = net.public === true;
const KNOWN_DEV_ACCOUNTS = new Set([
  // Besu dev accounts
  "fe3b557e8fb62b89f4916b721be55ceb828dbd73",
  "627306090abab3a6e1400e9345bc60c78a8bef57",
  "f17f52151ebef6c7334fad080c5704d77216b732",
  // Anvil / Hardhat default accounts #0-#9
  "f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "90f79bf6eb2c4f870365e785982e1f101e93b906",
  "15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "976ea74026e726554db657fa54763abd0c3a0aa9",
  "14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "a0ee7a142d267c1f36714e4a8f75612f20a79720",
]);

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
  if (isPublic) {
    if (KNOWN_DEV_ACCOUNTS.has(key)) {
      die(
        `network "${netName}" is PUBLIC but allocation "${a.role}" funds ${a.address},\n` +
          `  a publicly-known dev account whose private key is in every tutorial.\n` +
          `  Replace every allocation with ceremony-generated addresses before building a ${netName} genesis.`
      );
    }
    if (typeof a._key === "string" && /^DEVNET ONLY/i.test(a._key)) {
      die(`network "${netName}" is PUBLIC but allocation "${a.role}" is still annotated "${a._key}".`);
    }
  }
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
// Cancun IS supported, but only with the EIP-4788 beacon-roots contract
// pre-deployed (checked below). Without it, Besu system-calls an empty address
// every block and logs "Invalid system call address" forever. The comment that
// used to sit here said Shanghai was the ceiling; that was true before the
// pre-deploy was added in Phase 3 and had been wrong ever since.
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

const HARDFORKS = ["shanghai", "cancun"];
if (!HARDFORKS.includes(cfg.genesis.hardfork)) {
  die(
    `genesis.hardfork is "${cfg.genesis.hardfork}". Supported: ${HARDFORKS.join(", ")}.`
  );
}

if (cfg.genesis.hardfork === "cancun") {
  forkConfig.cancunTime = 0;

  // Cancun makes a system call to the EIP-4788 beacon-roots contract on every
  // block. Giggora has no beacon chain, but the CONTRACT MUST STILL EXIST or
  // Besu logs "Invalid system call address" every block. Pre-deploying it is
  // the documented fix for private networks, so refuse to build a Cancun
  // genesis without it rather than shipping a chain that errors every block.
  const sys = cfg.genesis.systemContracts?.beaconRoots;
  if (!sys?.address || !sys?.code) {
    die(
      `hardfork "cancun" requires genesis.systemContracts.beaconRoots (address + code).\n` +
        `  Without the EIP-4788 contract pre-deployed, Besu errors on every block.`
    );
  }
  const sysKey = sys.address.toLowerCase().replace(/^0x/, "");
  if (alloc[sysKey]) die(`system contract ${sys.address} collides with a supply allocation`);
  // Zero balance: a system contract must not affect total supply.
  alloc[sysKey] = { balance: "0", code: sys.code };
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
    // Validator identity. Two modes:
    //
    //   consensus.validators ABSENT  -> Besu generates fresh keys on this
    //                                   machine. Fine for a devnet; the keys
    //                                   are disposable.
    //   consensus.validators PRESENT -> the ceremony's public keys (one per
    //                                   validator host) go into the genesis
    //                                   and NO private key is produced here.
    //
    // A PUBLIC network refuses the first mode. The documented key ceremony
    // (docs/deployment.md §1) generates keys on each validator host, but this
    // file used to hard-code generate:true, so the genesis validator set was
    // whatever Besu minted on the operator's laptop and never matched the keys
    // actually deployed — a chain that could not form consensus, or one whose
    // validator keys had all lived on one shared machine.
    nodes: (() => {
      const v = c.validators;
      if (Array.isArray(v) && v.length > 0) {
        if (v.length !== c.validatorCount) {
          die(`consensus.validators has ${v.length} entries but validatorCount is ${c.validatorCount}`);
        }
        for (const k of v) {
          if (!/^(0x)?[0-9a-fA-F]{128}$/.test(k)) {
            die(`consensus.validators entry is not a 64-byte hex node public key: ${k}`);
          }
        }
        return { generate: false, keys: v.map((k) => (k.startsWith("0x") ? k : "0x" + k)) };
      }
      if (isPublic) {
        die(
          `network "${netName}" is PUBLIC: consensus.validators (the ceremony's node public keys) is required.\n` +
            `  Refusing to generate validator private keys on this machine for a public network.`
        );
      }
      return { generate: true, count: c.validatorCount };
    })(),
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
  // Branding, so every service and page renders the SAME name and blurb rather
  // than each hardcoding its own copy. A fork changes these once, here.
  `CHAIN_SLUG=${cfg.chain.slug ?? cfg.chain.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  `CHAIN_TAGLINE=${cfg.chain.tagline ?? ""}`,
  // split/join rather than a regex: the description is free text and a stray
  // newline inside it must not be able to break this file.
  `CHAIN_DESCRIPTION=${(cfg.chain.description ?? "").split(/\s+/).join(" ").trim()}`,
  `CHAIN_NETWORK=${netName}`,
  `CHAIN_ID=${net.chainId}`,
  `NETWORK_ID=${net.networkId}`,
  `CURRENCY_NAME=${cfg.chain.currency.name}`,
  `CURRENCY_SYMBOL=${cfg.chain.currency.symbol}`,
  `CURRENCY_DECIMALS=${cfg.chain.currency.decimals}`,
  "",
  `VALIDATOR_COUNT=${c.validatorCount}`,
  // 1 when validator keys come from a ceremony (consensus.validators) and no
  // private keys exist in this checkout; create-genesis.sh skips key
  // distribution in that case.
  `VALIDATOR_KEYS_EXTERNAL=${Array.isArray(c.validators) && c.validators.length ? 1 : 0}`,
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
  `POSTGRES_IP=${dn.postgresIp}`,
  `BOOTNODE_IP=${validatorIps[0]}`,
  "",
  "# --- database ---",
  "# DEVNET password, deliberately not a secret. Override from a real secret",
  "# store for testnet/mainnet and never commit it (brief §30).",
  `POSTGRES_IMAGE=${cfg.database.image}`,
  `POSTGRES_DB=${cfg.database.name}`,
  `POSTGRES_USER=${cfg.database.user}`,
  `POSTGRES_PASSWORD=${cfg.database.devnetPassword}`,
  `POSTGRES_PORT=${cfg.database.port}`,
  `POSTGRES_HOST_PORT=${cfg.database.hostPort}`,
  `DATABASE_URL=postgresql://${cfg.database.user}:${cfg.database.devnetPassword}@localhost:${cfg.database.hostPort}/${cfg.database.name}`,
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

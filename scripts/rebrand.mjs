#!/usr/bin/env node
/**
 * Make this chain yours.
 *
 * Renames the network everywhere at once: the config, the docs, the websites,
 * the container names. Run it on a fresh fork, review the diff, regenerate the
 * genesis, and you have your own chain rather than a copy of someone else's.
 *
 *   node scripts/rebrand.mjs --name "Aurora" --symbol AUR
 *   node scripts/rebrand.mjs --name "Aurora" --symbol AUR --description "..."
 *   node scripts/rebrand.mjs --list          # show what would change, touch nothing
 *
 * WHAT IT WILL NOT TOUCH, ON PURPOSE
 *
 *   Code identifiers. `maxGig`, `totalGig`, `WEI_PER_GIG`, `gigToWei` are
 *   internal names nobody sees, and `drip.maxGig` is a real config KEY that
 *   documentation refers to by name. Renaming them would be churn at best and
 *   would silently break the docs at worst. The replacements below are chosen
 *   so none of them match: the ticker rule requires word boundaries, so
 *   WEI_PER_GIG is safe, and mixed-case "Gig" is never replaced at all.
 *
 * SAFETY
 *
 *   Refuses to run on a dirty working tree, so `git diff` afterwards shows
 *   exactly what it did and `git checkout .` undoes all of it.
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "blockchain", "config", "chain.config.json");

function die(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : null;
}
const flag = (name) => process.argv.includes(`--${name}`);

// --- what we are renaming FROM ----------------------------------------------

const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
const from = {
  name: cfg.chain.name,
  slug: cfg.chain.slug ?? cfg.chain.name.toLowerCase(),
  symbol: cfg.chain.currency.symbol,
};

// --- what we are renaming TO ------------------------------------------------

const listOnly = flag("list");
const newName = arg("name");
const newSymbol = arg("symbol");

if (!listOnly && (!newName || !newSymbol)) {
  console.log(`
  Rebrand this chain
  ------------------
  Currently: ${from.name} (${from.symbol}), slug "${from.slug}"

  Usage:
    node scripts/rebrand.mjs --name "Aurora" --symbol AUR
                             [--slug aurora]
                             [--tagline "..."]
                             [--description "one paragraph"]
                             [--chain-id 5041] [--testnet-id 5042] [--devnet-id 5043]

    node scripts/rebrand.mjs --list      show every file that would change

  Pick your OWN chain IDs. They are meant to be globally unique - check
  https://chainlist.org before choosing, and never ship a chain on someone
  else's id: wallets key their network list on it and a collision means a
  transaction signed for one chain is valid on the other.
`);
  process.exit(listOnly ? 0 : 1);
}

const to = {
  name: newName ?? from.name,
  slug: (arg("slug") ?? (newName ?? from.name).toLowerCase().replace(/[^a-z0-9]+/g, "-")).replace(/^-|-$/g, ""),
  symbol: newSymbol ?? from.symbol,
};

if (to.symbol && !/^[A-Za-z][A-Za-z0-9]{1,10}$/.test(to.symbol)) {
  die(`--symbol "${to.symbol}" should be 2-11 letters/digits starting with a letter`);
}

// --- refuse to work on a dirty tree ----------------------------------------

if (!listOnly) {
  let dirty = "";
  try {
    dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    die("this does not look like a git repository, and this script relies on `git diff` being your undo button");
  }
  if (dirty) {
    die(
      `the working tree has uncommitted changes.\n` +
        `  Commit or stash them first, so that afterwards \`git diff\` shows only what\n` +
        `  this script did and \`git checkout .\` undoes exactly that.`
    );
  }
}

// --- which files ------------------------------------------------------------

const SKIP_DIRS = /(^|[\\/])(\.git|node_modules|out|cache|broadcast|\.next|backups)([\\/]|$)/;
const SKIP_FILES = new Set([
  "package-lock.json",
  // Generated from the Markdown; regenerate with `npm run docs` afterwards.
  "giggora-dossier.html",
]);
const TEXT = new Set([
  ".md", ".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".json", ".sol",
  ".sh", ".yml", ".yaml", ".bat", ".ps1", ".example", ".sql", ".toml", "",
]);

let files;
try {
  files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch {
  die("could not list files with `git ls-files`");
}

files = files.filter((f) => {
  if (SKIP_DIRS.test(f)) return false;
  if (SKIP_FILES.has(f.split("/").pop())) return false;
  if (!TEXT.has(extname(f))) return false;
  try {
    return statSync(join(ROOT, f)).size < 2_000_000;
  } catch {
    return false;
  }
});

// --- the replacements -------------------------------------------------------
//
// Order matters: the full name goes first, so that by the time the ticker rule
// runs there is no "GIGGORA" left for a \bGIG\b to sit inside.
//
// Mixed-case "Gig" is deliberately absent. See the header.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rules = [
  [new RegExp(esc(from.name), "g"), to.name],
  [new RegExp(esc(from.name.toUpperCase()), "g"), to.name.toUpperCase()],
  [new RegExp(esc(from.slug), "g"), to.slug],
  [new RegExp(`\\b${esc(from.symbol)}\\b`, "g"), to.symbol],
];

let changedFiles = 0;
let changedLines = 0;
const touched = [];

for (const f of files) {
  const p = join(ROOT, f);
  let s;
  try {
    s = readFileSync(p, "utf8");
  } catch {
    continue;
  }
  // Skip anything that looks binary. Written as an escape, not a literal NUL:
  // a raw control character in source is invisible in a diff and makes grep
  // treat this whole file as binary.
  if (s.indexOf(String.fromCharCode(0)) !== -1) continue;

  let out = s;
  for (const [re, rep] of rules) out = out.replace(re, rep);
  if (out === s) continue;

  const before = s.split("\n");
  const after = out.split("\n");
  let n = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) n++;

  changedFiles++;
  changedLines += n;
  touched.push({ f, n });
  if (!listOnly) writeFileSync(p, out);
}

// --- chain.config.json, structurally ---------------------------------------

if (!listOnly) {
  const c = JSON.parse(readFileSync(CONFIG, "utf8"));
  c.chain.name = to.name;
  c.chain.slug = to.slug;
  c.chain.currency.name = to.name;
  c.chain.currency.symbol = to.symbol;
  if (arg("tagline")) c.chain.tagline = arg("tagline");
  if (arg("description")) c.chain.description = arg("description");
  for (const [k, v] of [["mainnet", "chain-id"], ["testnet", "testnet-id"], ["devnet", "devnet-id"]]) {
    const id = arg(v);
    if (id) {
      if (!/^\d+$/.test(id)) die(`--${v} must be a number`);
      c.networks[k].chainId = Number(id);
      c.networks[k].networkId = Number(id);
    }
  }
  c.database.name = to.slug;
  c.database.user = to.slug;
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
}

// --- report -----------------------------------------------------------------

touched.sort((a, b) => b.n - a.n);
console.log(`
  ${listOnly ? "Would rename" : "Renamed"}  ${from.name} (${from.symbol})  ->  ${to.name} (${to.symbol})
  ${" ".repeat(listOnly ? 12 : 8)}  slug "${from.slug}" -> "${to.slug}"
`);
for (const t of touched.slice(0, 15)) console.log(`    ${String(t.n).padStart(4)}  ${t.f}`);
if (touched.length > 15) console.log(`    ... and ${touched.length - 15} more files`);
console.log(`\n  ${changedLines} line(s) in ${changedFiles} file(s).`);

if (listOnly) {
  console.log(`\n  Nothing was written. Re-run without --list to apply.\n`);
  process.exit(0);
}

console.log(`
  NEXT, in order:

    1. git diff                     review it - this is your undo point
    2. bash scripts/create-genesis.sh --force
                                    new genesis and new validator keys for the
                                    new chain id. --force because it deletes the
                                    old chain; that is the point here.
    3. npm run docs                 regenerate the combined documentation page
    4. npm run stack                rebuild and start under the new name

  Still yours to change by hand, because no script should guess them:

    - README.md, HANDOVER.md, CLAUDE.md - the prose is renamed but still
      describes THIS project's history, decisions and measurements
    - blockchain/config/chain.config.json - supply allocations still point at
      publicly-known dev accounts, which is correct for a devnet and is refused
      outright for a public network
    - contracts/src/*.sol - contract NAMES (GigToken and friends) are Solidity
      identifiers and were left alone
`);

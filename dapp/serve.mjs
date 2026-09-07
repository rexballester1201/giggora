#!/usr/bin/env node
/**
 * Giggora sample DApp — static server.
 *
 * A dozen lines of Node rather than a dependency. The DApp is three static
 * files; adding a web framework to serve them would be more moving parts than
 * the thing being served.
 *
 * Also exposes deployments/<network>.json so the page can prefill the token
 * address instead of asking the user to paste it.
 *
 * Usage:  node dapp/serve.mjs [--port 3001]
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "dapp", "src");

const pi = process.argv.indexOf("--port");
const PORT = pi !== -1 && process.argv[pi + 1] ? Number(process.argv[pi + 1]) : 3001;

const env = existsSync(join(ROOT, ".env"))
  ? Object.fromEntries(
      readFileSync(join(ROOT, ".env"), "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
    )
  : {};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;

    // Serve the recorded deployment so the page can prefill the token address.
    if (path === "/deployments.json") {
      const f = join(ROOT, "deployments", `${env.CHAIN_NETWORK ?? "devnet"}.json`);
      if (!existsSync(f)) {
        res.writeHead(404, { "content-type": TYPES[".json"] });
        return res.end("{}");
      }
      res.writeHead(200, { "content-type": TYPES[".json"] });
      return res.end(await readFile(f));
    }

    // Contain path traversal: resolve, then verify the result is still under SRC.
    const target = join(SRC, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    if (!target.startsWith(SRC)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    if (!existsSync(target)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("Not found");
    }

    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": TYPES[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error");
  }
});

server.listen(PORT, () => {
  console.log(`
  Giggora sample DApp
  -------------------
  http://localhost:${PORT}

  Chain     ${env.CHAIN_ID ?? "?"} (${env.CHAIN_NAME ?? "Giggora"})
  RPC       ${env.RPC_URL ?? "http://localhost:8545"}

  Connect a wallet on the page. Add the network first at
  http://localhost:3000/connect-wallet
`);
});

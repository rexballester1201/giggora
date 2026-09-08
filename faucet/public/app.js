/*
 * Giggora faucet — portal.
 *
 * No framework, no bundler, no CDN. The page's CSP is `default-src 'none'` with
 * script/style/connect limited to 'self', so this file is the whole client and
 * it talks only to its own origin.
 *
 * The one substantial piece here is SHA-256, needed for the proof of work.
 * SubtleCrypto is async per call and far too slow for a search of ~10^6
 * candidates, so a synchronous implementation is used instead. It is verified
 * against the FIPS-180-4 test vectors at load (see selfTest below): a silently
 * wrong hash would mean nobody could ever claim.
 */

"use strict";

// --- SHA-256 -----------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const W = new Uint32Array(64);

/** @param {Uint8Array} bytes @returns {Uint8Array} 32-byte digest */
function sha256(bytes) {
  const len = bytes.length;
  const bitLen = len * 8;
  // Message + 0x80 + zero padding + 8-byte length, rounded to a 64-byte block.
  const blocks = Math.ceil((len + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(bytes);
  buf[len] = 0x80;
  // Length fits in 32 bits for anything this page hashes; the high word stays 0.
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  for (let b = 0; b < blocks; b++) {
    const off = b * 64;
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15], w2 = W[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }

    let a = h0, b1 = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b1) ^ (a & c) ^ (b1 & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b1; b1 = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b1) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0 >>> 0, false); ov.setUint32(4, h1 >>> 0, false);
  ov.setUint32(8, h2 >>> 0, false); ov.setUint32(12, h3 >>> 0, false);
  ov.setUint32(16, h4 >>> 0, false); ov.setUint32(20, h5 >>> 0, false);
  ov.setUint32(24, h6 >>> 0, false); ov.setUint32(28, h7 >>> 0, false);
  return out;
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** A wrong SHA-256 would make every claim fail with no visible cause. */
function selfTest() {
  const enc = new TextEncoder();
  const cases = [
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ];
  for (const [input, expected] of cases) {
    if (hex(sha256(enc.encode(input))) !== expected) return false;
  }
  return true;
}

const SHA_OK = selfTest();

function leadingZeroBits(digest) {
  let bits = 0;
  for (let i = 0; i < digest.length; i++) {
    const byte = digest[i];
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Find a nonce whose SHA-256("<challenge>:<nonce>") has `bits` leading zeros.
 *
 * Yields to the event loop every CHUNK candidates so the progress bar keeps
 * painting and the tab stays responsive — a frozen page during a multi-second
 * search reads as a broken faucet.
 */
async function solve(challenge, bits, onProgress) {
  const enc = new TextEncoder();
  const prefix = enc.encode(challenge + ":");
  const buf = new Uint8Array(prefix.length + 24);
  buf.set(prefix);

  const expected = Math.pow(2, bits);
  const CHUNK = 4096;
  let nonce = Math.floor(Math.random() * 1e9); // not from 0: parallel tabs would duplicate work
  let tried = 0;

  for (;;) {
    for (let i = 0; i < CHUNK; i++) {
      const s = String(nonce);
      for (let j = 0; j < s.length; j++) buf[prefix.length + j] = s.charCodeAt(j);
      const view = buf.subarray(0, prefix.length + s.length);
      if (leadingZeroBits(sha256(view)) >= bits) return String(nonce);
      nonce++;
      tried++;
    }
    onProgress(Math.min(0.99, tried / expected));
    await new Promise((r) => setTimeout(r, 0));
  }
}

// --- DOM ---------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const fmt = (v, max = 4) => {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
};

const shorten = (a) => (a && a.length > 16 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a || "—");

/**
 * wei string -> GIG string, BigInt only.
 *
 * `Number(wei) / 1e18` looks equivalent and is not: 10 GIG is 1e19 wei, already
 * past Number.MAX_SAFE_INTEGER, so the division is lossy the moment an amount
 * is not a round number. Same discipline as the indexer, API and explorer.
 */
function weiToGig(wei, maxFrac = 4) {
  let v;
  try {
    v = BigInt(wei);
  } catch {
    return "—";
  }
  const base = 10n ** 18n;
  const whole = v / base;
  const frac = (v % base).toString().padStart(18, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${whole.toLocaleString()}${frac ? `.${frac}` : ""}`;
}

function timeAgo(iso) {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function show(kind, html) {
  const el = $("result");
  el.className = `result ${kind}`;
  el.innerHTML = html;
  el.hidden = false;
}

/** Text only — never innerHTML for anything that came from the network. */
function cell(row, text, mono) {
  const td = document.createElement("td");
  td.textContent = text;
  if (mono) td.className = "mono";
  row.appendChild(td);
  return td;
}

let STATUS = null;

async function loadStatus() {
  let s;
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    s = await res.json();
  } catch {
    $("pool-note").textContent = "Cannot reach the faucet service.";
    return;
  }
  STATUS = s;

  $("payout").textContent = fmt(s.payout.gig);
  $("payout-sub").textContent = `${s.chain.symbol} per claim`;
  $("remaining").textContent = `${fmt(s.pool.remainingGig, 0)} ${s.chain.symbol}`;
  $("daily").textContent = `${fmt(s.daily.remainingGig, 0)} / ${fmt(s.daily.capGig, 0)}`;
  $("claims").textContent = fmt(s.pool.claims, 0);
  $("pool-fill").style.width = `${Math.max(0, Math.min(100, s.pool.percentRemaining))}%`;
  $("hot-wallet").textContent = s.hotWallet.address;
  $("explorer-link").href = s.chain.explorerUrl;
  $("wallet-link").href = `${s.chain.explorerUrl}/connect-wallet`;

  // Say plainly when it cannot pay, rather than letting someone find out by
  // submitting: the project's rule is never to present a state that is not real.
  const notes = [];
  if (s.chainError) notes.push(`The chain node is unreachable — claims will fail right now.`);
  else if (Number(s.pool.remainingGig) <= 0) notes.push(`The pool is exhausted. No more GIG will be dispensed.`);
  else if (s.daily.exhausted) notes.push(`Today's shared limit of ${fmt(s.daily.capGig, 0)} ${s.chain.symbol} has been reached — the faucet opens again tomorrow.`);
  else if (!s.dispensing) notes.push(`The faucet wallet is empty — an operator needs to top it up.`);
  else if (s.hotWallet.low) notes.push(`Faucet wallet is running low.`);
  notes.push(`Chain ${s.chain.id} · ${s.pool.percentRemaining.toFixed(2)}% of the pool remains.`);
  $("pool-note").textContent = notes.join(" ");

  $("claim-btn").disabled = !s.dispensing;

  // Schedule
  const stbody = $("schedule").querySelector("tbody");
  stbody.textContent = "";
  const nowDrip = Number(s.payout.gig);
  for (const row of s.schedule) {
    const tr = document.createElement("tr");
    cell(tr, `${fmt(row.remainingGig, 0)} ${s.chain.symbol}`, true);
    cell(tr, `${row.dripGig} ${s.chain.symbol}`, true);
    if (Number(row.dripGig) === nowDrip) tr.className = "current";
    stbody.appendChild(tr);
  }

  // Recent
  const rtbody = $("recent").querySelector("tbody");
  rtbody.textContent = "";
  if (!s.recent.length) {
    const tr = document.createElement("tr");
    const td = cell(tr, "No claims yet.");
    td.className = "empty";
    td.colSpan = 4;
    rtbody.appendChild(tr);
  } else {
    for (const c of s.recent) {
      const tr = document.createElement("tr");
      cell(tr, shorten(c.address), true);
      cell(tr, `${weiToGig(c.amountWei)} ${s.chain.symbol}`, true);
      cell(tr, timeAgo(c.requestedAt));
      const td = document.createElement("td");
      if (c.txHash) {
        const a = document.createElement("a");
        a.href = `${s.chain.explorerUrl}/tx/${c.txHash}`;
        a.textContent = shorten(c.txHash);
        a.className = "mono";
        a.rel = "noopener";
        td.appendChild(a);
      } else td.textContent = "—";
      tr.appendChild(td);
      rtbody.appendChild(tr);
    }
  }
}

async function claim(ev) {
  ev.preventDefault();
  const address = $("address").value.trim();
  const btn = $("claim-btn");

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return show("err", "<p>That is not a valid address. It should be <code>0x</code> followed by 40 hex characters.</p>");
  }
  if (!SHA_OK) {
    return show("err", "<p>This browser produced an incorrect SHA-256 result, so the proof of work cannot be trusted. Please use another browser.</p>");
  }

  btn.disabled = true;
  $("result").hidden = true;

  try {
    let nonce = "";
    const ch = await (await fetch(`/api/challenge?address=${encodeURIComponent(address)}`)).json();

    if (ch.enabled) {
      $("progress").hidden = false;
      $("progress-text").textContent = "Doing a small proof of work so the faucet is not drained by scripts…";
      nonce = await solve(ch.challenge, ch.difficultyBits, (p) => {
        $("progress-fill").style.width = `${Math.round(p * 100)}%`;
      });
      $("progress-fill").style.width = "100%";
      $("progress-text").textContent = "Proof of work solved. Requesting…";
    }

    const res = await fetch("/api/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, nonce }),
    });
    const data = await res.json();
    $("progress").hidden = true;

    if (res.ok && data.ok) {
      show(
        "ok",
        `<p><strong>Sent ${fmt(data.amountGig)} ${STATUS.chain.symbol}</strong> to <span class="mono">${shorten(address)}</span>.</p>` +
          `<p><a href="${STATUS.chain.explorerUrl}/tx/${data.txHash}" rel="noopener">View the transaction</a> <span class="mono">${data.txHash}</span></p>` +
          `<p class="dim">Next claim from this address in ${data.cooldownSeconds >= 86400 ? `${Math.round(data.cooldownSeconds / 3600)} hours` : `${Math.round(data.cooldownSeconds / 60)} minutes`}. The pool now pays ${fmt(data.nextPayoutGig)} ${STATUS.chain.symbol} per claim.</p>`
      );
      $("address").value = "";
    } else if (res.status === 429 && data.retryAfterSeconds) {
      const s = data.retryAfterSeconds;
      const when =
        s >= 3600 ? `${Math.ceil(s / 3600)} hour${Math.ceil(s / 3600) === 1 ? "" : "s"}` : `${Math.ceil(s / 60)} minute${Math.ceil(s / 60) === 1 ? "" : "s"}`;
      show("warn", `<p>${data.message}. Try again in about ${when}.</p>`);
    } else {
      show("err", `<p>${data.message || "The request failed."}</p>`);
    }
  } catch (err) {
    $("progress").hidden = true;
    show("err", "<p>Could not reach the faucet. Check that it is running and try again.</p>");
  } finally {
    btn.disabled = false;
    loadStatus();
  }
}

$("claim-form").addEventListener("submit", claim);
loadStatus();
setInterval(loadStatus, 30_000);

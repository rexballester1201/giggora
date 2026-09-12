#!/usr/bin/env node
/**
 * Giggora — build the combined, printable documentation page.
 *
 * Reads the top-level Markdown documents and emits ONE self-contained HTML
 * file: no CDN, no fonts fetched at runtime, no JavaScript required to read it.
 * That is the point — a handover document that needs the internet to render is
 * not a handover document. Open it from a USB stick in five years and it works.
 *
 * The Markdown is converted here rather than transcribed by hand so the page
 * cannot drift from the sources. Edit the .md files, re-run this.
 *
 *   node scripts/build-docs.mjs
 *
 * The parser deliberately covers only the subset of Markdown these documents
 * actually use (headings, tables, fences, lists, blockquotes, rules, links,
 * bold, inline code). It is not a general Markdown implementation and should
 * not be treated as one.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DOCS = [
  {
    file: "HANDOVER.md",
    id: "handover",
    label: "HANDOVER.md",
    role: "Start here",
    blurb: "State of the project, what is unfinished, and the decisions waiting for someone.",
  },
  {
    file: "DEPLOY.md",
    id: "deploy",
    label: "DEPLOY.md",
    role: "Operations",
    blurb: "Running it locally, measured hardware requirements, production topology, and what to do when it breaks.",
  },
  {
    file: "CLAUDE.md",
    id: "claude",
    label: "CLAUDE.md",
    role: "Reference",
    blurb: "Architecture, conventions, and every load-bearing gotcha that will otherwise cost you a day.",
  },
];

// --- Markdown ---------------------------------------------------------------

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline: code first, so nothing inside a code span is re-processed. */
function inline(text) {
  const spans = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => {
    spans.push(`<code>${esc(code)}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });

  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    // Refuse script-bearing URL schemes. The sources are this repository's own
    // Markdown, so today this is hardening rather than a fix — but the page is
    // opened via file://, where a javascript: href runs with local-file
    // privileges, and a generator should not assume its inputs stay trusted.
    if (/^\s*(javascript|data|vbscript|file)\s*:/i.test(href)) {
      // `s` was HTML-escaped before this pass, so href is already safe text.
      return `${label} (${href})`;
    }
    const external = /^https?:/.test(href);
    return `<a href="${href.replace(/"/g, "&quot;")}"${external ? ' target="_blank" rel="noopener"' : ""}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)]|$)/g, "$1<em>$2</em>");

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]);
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

/** Split a GFM table row, tolerating leading/trailing pipes. */
const cells = (row) =>
  row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

function render(md, docId) {
  const lines = md.split("\n");
  const out = [];
  const toc = [];
  let i = 0;

  const closeList = (stack) => {
    while (stack.length) out.push(`</${stack.pop()}>`);
  };
  const listStack = [];

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. The opening fence may be INDENTED — these documents nest
    // fences under numbered list items, and a column-0-only test rendered
    // those blocks as mangled inline text.
    if (/^\s*```/.test(line)) {
      closeList(listStack);
      const pad = line.match(/^\s*/)[0].length;
      const lang = line.trim().slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        // Strip the fence indent so nested blocks are not shifted right.
        buf.push(lines[i].slice(pad));
        i++;
      }
      i++; // closing fence
      out.push(
        `<pre class="code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(
          buf.join("\n")
        )}</code></pre>`
      );
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      closeList(listStack);
      out.push('<hr class="rule">');
      i++;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList(listStack);
      const level = h[1].length;
      const text = h[2].trim();
      const id = `${docId}-${slug(text)}`;
      if (level === 2) toc.push({ id, text });
      // The document's own H1 is rendered by the page shell, not here.
      if (level > 1) {
        out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      }
      i++;
      continue;
    }

    // Table
    if (/^\|/.test(line) && /^\|?[\s:|-]+\|/.test(lines[i + 1] ?? "")) {
      closeList(listStack);
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) body.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head
          .map((c) => `<th>${inline(c)}</th>`)
          .join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`
      );
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      closeList(listStack);
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(" ").trim())}</blockquote>`);
      continue;
    }

    // Lists (one nesting level, which is all these documents use)
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      const indent = li[1].length;
      const ordered = /\d/.test(li[2]);
      const want = ordered ? "ol" : "ul";
      const depth = indent >= 2 ? 2 : 1;

      while (listStack.length > depth) out.push(`</${listStack.pop()}>`);
      if (listStack.length < depth) {
        // Numbering in these documents runs ACROSS h3 headings (the 16 gotchas
        // are grouped Chain / QBFT / Docker / Services but numbered 1..16), so
        // a fresh <ol> must resume at the source number rather than reset to 1.
        const n = ordered ? parseInt(li[2], 10) : 1;
        out.push(`<${want}${ordered && n !== 1 ? ` start="${n}"` : ""}>`);
        listStack.push(want);
      } else if (listStack[listStack.length - 1] !== want) {
        out.push(`</${listStack.pop()}>`);
        const n = ordered ? parseInt(li[2], 10) : 1;
        out.push(`<${want}${ordered && n !== 1 ? ` start="${n}"` : ""}>`);
        listStack.push(want);
      }

      // Continuation lines belonging to this item.
      let content = li[3];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) &&
        !/^(#{1,6})\s/.test(lines[i]) &&
        !/^\s*```/.test(lines[i]) &&
        !/^\|/.test(lines[i]) &&
        !/^---+\s*$/.test(lines[i])
      ) {
        content += " " + lines[i].trim();
        i++;
      }
      out.push(`<li>${inline(content)}</li>`);
      continue;
    }

    // Blank. A blank line between two list items does NOT end the list —
    // these documents put blank lines between items throughout, and closing
    // here restarted every ordered list at "1." Look ahead instead.
    if (line.trim() === "") {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const continues =
        listStack.length > 0 &&
        j < lines.length &&
        /^(\s*)([-*]|\d+\.)\s+/.test(lines[j]);
      if (!continues) closeList(listStack);
      i++;
      continue;
    }

    // Paragraph
    closeList(listStack);
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^\|/.test(lines[i]) &&
      !/^>/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  closeList(listStack);
  return { html: out.join("\n"), toc };
}

// --- Build ------------------------------------------------------------------

const chain = JSON.parse(
  readFileSync(join(ROOT, "blockchain/config/chain.config.json"), "utf8")
);

const rendered = DOCS.map((d) => {
  // Git for Windows checks text out as CRLF by default (core.autocrlf=true), and
  // render() assumes LF: `(.*)$` cannot match past a trailing \r, so a CRLF
  // checkout recognised no headings and the table of contents came out empty.
  const md = readFileSync(join(ROOT, d.file), "utf8").replace(/\r\n?/g, "\n");
  const title = (md.match(/^#\s+(.*)$/m) || [, d.label])[1];
  return { ...d, title, ...render(md, d.id) };
});

const BUILT = new Date().toISOString().slice(0, 10);

// The shelving date is history, not the build date: a rebuild must not move
// it. It comes from CLAUDE.md's status line, and the build stops if that line
// is gone rather than print a date nobody wrote.
const SHELVED = readFileSync(join(ROOT, "CLAUDE.md"), "utf8").match(
  /\*\*Status: SHELVED (\d{4}-\d{2}-\d{2})\./
)?.[1];
if (!SHELVED) {
  throw new Error('CLAUDE.md has no "**Status: SHELVED YYYY-MM-DD.**" line for the Shelved pill');
}

const nav = rendered
  .map(
    (d) => `
      <li class="nav-doc">
        <a class="nav-doc-link" href="#${d.id}">
          <span class="nav-role">${d.role}</span>
          <span class="nav-file">${d.label}</span>
        </a>
        <ul class="nav-sub">
          ${d.toc.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join("\n          ")}
        </ul>
      </li>`
  )
  .join("");

const body = rendered
  .map(
    (d) => `
      <section class="doc" id="${d.id}">
        <header class="doc-head">
          <p class="doc-role">${d.role}</p>
          <h1 class="doc-title">${esc(d.title)}</h1>
          <p class="doc-blurb">${esc(d.blurb)}</p>
          <p class="doc-src">${d.label}</p>
        </header>
        ${d.html}
      </section>`
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Giggora Project Dossier</title>
<meta name="description" content="Handover, deployment and reference documentation for the Giggora blockchain, shelved ${SHELVED}.">
<style>
/* ---------------------------------------------------------------------------
   Palette inherited from explorer-web/app/globals.css — the chain already has a
   visual identity (teal/slate, warm amber for the native coin, deliberately not
   Etherscan blue or BscScan yellow). This page uses it rather than inventing a
   second one.
   --------------------------------------------------------------------------- */
:root {
  --bg:#f7f9fa; --surface:#ffffff; --surface-2:#f1f5f6; --border:#dde5e8;
  --text:#0f2027; --text-dim:#5b7079; --text-faint:#8ea4ab;
  --brand:#0d7d78; --brand-strong:#0a5f5b; --accent:#b8722a;
  --ok:#17795e; --ok-bg:#e3f5ee; --fail:#b3261e; --fail-bg:#fdeceb;
  --warn:#8a6100; --warn-bg:#fbf2dc;
  --code-bg:#f1f5f6; --shadow:0 1px 2px rgba(15,32,39,.06), 0 8px 24px -16px rgba(15,32,39,.28);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:#0b1416; --surface:#101c1f; --surface-2:#16272b; --border:#21383d;
    --text:#e6f0f2; --text-dim:#8aa4ab; --text-faint:#66838b;
    --brand:#2bb6ae; --brand-strong:#4fd0c8; --accent:#e0a458;
    --ok:#4ecfa4; --ok-bg:#10322a; --fail:#f2837c; --fail-bg:#33191a;
    --warn:#e0b45c; --warn-bg:#2b2312;
    --code-bg:#16272b; --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
  }
}
:root[data-theme="dark"] {
  --bg:#0b1416; --surface:#101c1f; --surface-2:#16272b; --border:#21383d;
  --text:#e6f0f2; --text-dim:#8aa4ab; --text-faint:#66838b;
  --brand:#2bb6ae; --brand-strong:#4fd0c8; --accent:#e0a458;
  --ok:#4ecfa4; --ok-bg:#10322a; --fail:#f2837c; --fail-bg:#33191a;
  --warn:#e0b45c; --warn-bg:#2b2312;
  --code-bg:#16272b; --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 24px -16px rgba(0,0,0,.8);
}

/* System stacks only. This file must render identically with no network. */
:root {
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --serif: ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
}

*,*::before,*::after { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } *{animation:none!important;transition:none!important;} }
body {
  margin:0; background: var(--bg); color: var(--text);
  font-family: var(--sans); font-size: 16px; line-height: 1.65;
  -webkit-text-size-adjust: 100%;
}

/* --- shell ---------------------------------------------------------------- */
.shell { display:grid; grid-template-columns: 1fr; max-width: 1240px; margin: 0 auto; }
@media (min-width: 1060px) {
  .shell { grid-template-columns: 268px minmax(0,1fr); gap: 48px; padding-right: 32px; }
}

/* --- masthead ------------------------------------------------------------- */
.masthead {
  grid-column: 1 / -1; padding: 40px 24px 28px;
  border-bottom: 1px solid var(--border);
}
@media (min-width:1060px){ .masthead{ padding: 48px 0 32px 32px; } }
.brand { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
.brand h1 {
  font-family: var(--serif); font-weight:600; font-size: clamp(30px,4.2vw,42px);
  margin:0; letter-spacing:-.015em; text-wrap:balance;
}
.brand .tick {
  font-family: var(--mono); font-size:13px; letter-spacing:.08em;
  color: var(--brand); border:1px solid var(--brand); border-radius:3px;
  padding:2px 7px; text-transform:uppercase;
}
.lede { max-width: 62ch; color: var(--text-dim); margin:14px 0 0; font-size:16.5px; }
.status-line { display:flex; align-items:center; gap:10px; margin-top:20px; flex-wrap:wrap; }
.pill {
  font-family: var(--mono); font-size:11.5px; letter-spacing:.1em; text-transform:uppercase;
  padding:4px 10px; border-radius:999px; font-weight:600;
}
.pill.shelved { background: var(--warn-bg); color: var(--warn); }
.pill.done    { background: var(--ok-bg);   color: var(--ok); }
.built { font-family: var(--mono); font-size:12px; color: var(--text-faint); }

/* Chain facts: a data strip, not cards. Fixed-width labels, tabular figures. */
.facts {
  margin-top:26px; display:grid; gap:0 28px;
  grid-template-columns: repeat(auto-fit, minmax(178px,1fr));
  border-top:1px solid var(--border);
}
.fact { padding:14px 0 2px; border-bottom:1px solid var(--border); }
.fact dt {
  font-family:var(--mono); font-size:10.5px; letter-spacing:.11em; text-transform:uppercase;
  color: var(--text-faint); margin:0 0 3px;
}
.fact dd { margin:0 0 10px; font-family:var(--mono); font-size:14px; font-variant-numeric: tabular-nums; }
.fact dd.hash { font-size:11px; word-break:break-all; color: var(--text-dim); line-height:1.5; }

/* --- controls ------------------------------------------------------------- */
.controls { display:flex; gap:8px; margin-top:24px; flex-wrap:wrap; }
button.ctl {
  font: inherit; font-size:13.5px; cursor:pointer;
  background: var(--surface); color: var(--text);
  border:1px solid var(--border); border-radius:6px; padding:7px 14px;
}
button.ctl:hover { border-color: var(--brand); color: var(--brand); }
button.ctl:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }

/* --- nav ------------------------------------------------------------------ */
.nav { padding: 24px; border-bottom:1px solid var(--border); }
@media (min-width:1060px){
  .nav {
    padding: 36px 0 64px 32px; border-bottom:none;
    position: sticky; top:0; align-self:start; max-height:100vh; overflow-y:auto;
  }
}
.nav-title {
  font-family:var(--mono); font-size:10.5px; letter-spacing:.12em; text-transform:uppercase;
  color:var(--text-faint); margin:0 0 14px;
}
.nav ul { list-style:none; margin:0; padding:0; }
.nav-doc { margin-bottom:20px; }
.nav-doc-link { display:block; text-decoration:none; margin-bottom:6px; }
.nav-role { display:block; font-size:14px; font-weight:600; color:var(--text); }
.nav-file { display:block; font-family:var(--mono); font-size:11px; color:var(--brand); }
.nav-doc-link:hover .nav-role { color: var(--brand); }
.nav-sub { border-left:1px solid var(--border); padding-left:12px; margin-left:1px; }
.nav-sub li { margin:0; }
.nav-sub a {
  display:block; padding:3px 0; font-size:13px; color:var(--text-dim); text-decoration:none;
}
.nav-sub a:hover { color: var(--brand); }
.nav a:focus-visible { outline:2px solid var(--brand); outline-offset:2px; border-radius:2px; }

/* --- documents ------------------------------------------------------------ */
main { padding: 8px 24px 96px; min-width:0; }
@media (min-width:1060px){ main { padding: 36px 0 120px; } }
.doc { max-width: 74ch; }
.doc + .doc { margin-top: 96px; }
.doc-head { padding-bottom:22px; border-bottom:2px solid var(--text); margin-bottom:32px; }
.doc-role {
  font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase;
  color:var(--brand); margin:0 0 8px;
}
.doc-title { font-family:var(--serif); font-size:clamp(26px,3.4vw,34px); margin:0; letter-spacing:-.01em; text-wrap:balance; }
.doc-blurb { color:var(--text-dim); margin:10px 0 0; max-width:60ch; }
.doc-src { font-family:var(--mono); font-size:11.5px; color:var(--text-faint); margin:12px 0 0; }

.doc h2 {
  font-family:var(--serif); font-size:24px; font-weight:600; letter-spacing:-.01em;
  margin:52px 0 4px; padding-top:20px; border-top:1px solid var(--border); text-wrap:balance;
}
.doc h3 { font-size:17px; font-weight:650; margin:34px 0 4px; letter-spacing:-.005em; text-wrap:balance; }
.doc h4 { font-size:15px; font-weight:650; margin:26px 0 2px; color:var(--text-dim); }
.doc p { margin:14px 0; }
.doc strong { font-weight:650; }
.doc a { color: var(--brand-strong); text-underline-offset:2px; }
:root[data-theme="dark"] .doc a { color: var(--brand-strong); }
.doc a:focus-visible { outline:2px solid var(--brand); outline-offset:2px; border-radius:2px; }

.doc ul, .doc ol { margin:14px 0; padding-left:22px; }
.doc li { margin:7px 0; }
.doc li::marker { color: var(--text-faint); }

hr.rule { border:none; border-top:1px solid var(--border); margin:36px 0; }

blockquote {
  margin:22px 0; padding:14px 18px; background:var(--warn-bg);
  border-left:3px solid var(--warn); border-radius:0 4px 4px 0; color:var(--text);
}
blockquote p { margin:0; }

code {
  font-family:var(--mono); font-size:.875em; background:var(--code-bg);
  padding:.13em .38em; border-radius:3px; word-break:break-word;
}
pre.code {
  background:var(--code-bg); border:1px solid var(--border); border-radius:6px;
  padding:14px 16px; overflow-x:auto; margin:18px 0; line-height:1.55;
}
pre.code code { background:none; padding:0; font-size:13px; word-break:normal; }

.table-wrap { overflow-x:auto; margin:20px 0; border:1px solid var(--border); border-radius:6px; }
table { border-collapse:collapse; width:100%; font-size:14.5px; }
th, td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--border); vertical-align:top; }
thead th {
  background:var(--surface-2); font-family:var(--mono); font-weight:600;
  font-size:11px; letter-spacing:.07em; text-transform:uppercase; color:var(--text-dim);
  white-space:nowrap;
}
tbody tr:last-child td { border-bottom:none; }
td { font-variant-numeric: tabular-nums; }
td code { white-space:nowrap; }

.footer {
  grid-column:1/-1; border-top:1px solid var(--border);
  padding:24px 24px 48px; color:var(--text-faint); font-size:13px;
}
@media (min-width:1060px){ .footer{ padding:24px 0 56px 32px; } }

/* --- print ---------------------------------------------------------------- */
@media print {
  :root {
    --bg:#fff; --surface:#fff; --surface-2:#f2f2f2; --border:#c4ccce;
    --text:#000; --text-dim:#333; --text-faint:#555;
    --brand:#0a5f5b; --brand-strong:#0a5f5b; --warn-bg:#f6f2e6; --code-bg:#f4f6f6;
  }
  body { font-size:10.5pt; line-height:1.5; background:#fff; }
  .shell { display:block; max-width:none; padding:0; }
  .nav, .controls, .footer { display:none !important; }
  .masthead { padding:0 0 16pt; border-bottom:1.5pt solid #000; }
  main { padding:0; }
  .doc { max-width:none; }
  .doc + .doc { margin-top:0; }
  /* Each document starts its own page — they are separate documents. */
  .doc { break-before: page; }
  #handover { break-before: avoid; }
  .doc-head { break-after: avoid; }
  h2, h3, h4 { break-after: avoid; break-inside: avoid; }
  .doc h2 { margin-top:22pt; font-size:15pt; }
  .doc h3 { font-size:12pt; }
  table, pre.code, blockquote, .table-wrap { break-inside: avoid; }
  thead { display: table-header-group; }
  pre.code { border:1pt solid #c4ccce; }
  a { color:#000; text-decoration:underline; }
  @page { margin: 16mm 14mm; }
}
</style>
</head>
<body>
<div class="shell">

  <header class="masthead">
    <div class="brand">
      <h1>Giggora</h1>
      <span class="tick">${chain.chain.currency.symbol}</span>
    </div>
    <p class="lede">
      An independent, EVM-compatible Layer-1 blockchain with its own native currency,
      validator network and block explorer. This dossier is the complete handover:
      what was built, what was measured, what is still undecided.
    </p>

    <div class="status-line">
      <span class="pill shelved">Shelved ${SHELVED}</span>
      <span class="pill done">8 / 8 phases complete</span>
      <span class="built">Mainnet not launched</span>
    </div>

    <dl class="facts">
      <div class="fact"><dt>Client</dt><dd>Besu 26.8.1</dd></div>
      <div class="fact"><dt>Consensus</dt><dd>QBFT · ${chain.consensus.validatorCount} validators</dd></div>
      <div class="fact"><dt>Hardfork</dt><dd>${chain.genesis.hardfork}</dd></div>
      <div class="fact"><dt>Chain IDs</dt><dd>4041 / 4042 / 4043</dd></div>
      <div class="fact"><dt>Block period</dt><dd>${chain.consensus.blockPeriodSeconds}s · ${chain.consensus.emptyBlockPeriodSeconds}s idle</dd></div>
      <div class="fact"><dt>Devnet head at shelving</dt><dd>2,143</dd></div>
      <div class="fact" style="grid-column:1/-1">
        <dt>Devnet genesis hash</dt>
        <dd class="hash">0xf3e9fad05dc32b4a341f148f3c5b705c6c6e78a35f517986203f9d007b7c7fd6</dd>
      </div>
    </dl>

    <div class="controls">
      <button class="ctl" onclick="window.print()">Print / Save as PDF</button>
      <button class="ctl" id="theme">Switch theme</button>
    </div>
  </header>

  <nav class="nav" aria-label="Contents">
    <p class="nav-title">Contents</p>
    <ul>${nav}
    </ul>
  </nav>

  <main>${body}
  </main>

  <footer class="footer">
    Generated from HANDOVER.md, DEPLOY.md and CLAUDE.md by
    <code>scripts/build-docs.mjs</code> on ${BUILT}. Edit the Markdown and re-run
    the script; do not edit this file directly.
  </footer>

</div>

<script>
// Theme toggle. The page already renders correctly with JavaScript disabled —
// this only lets a reader override their system setting.
(function () {
  var root = document.documentElement;
  var btn = document.getElementById("theme");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var current = root.getAttribute("data-theme");
    if (!current) {
      var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      current = dark ? "dark" : "light";
    }
    root.setAttribute("data-theme", current === "dark" ? "light" : "dark");
  });
})();
</script>
</body>
</html>
`;

const dest = join(ROOT, "giggora-dossier.html");
writeFileSync(dest, html, "utf8");

const kb = (html.length / 1024).toFixed(0);
console.log(`\n  Wrote giggora-dossier.html  (${kb} KB, self-contained)`);
for (const d of rendered) {
  console.log(`    ${d.label.padEnd(14)} ${String(d.toc.length).padStart(2)} sections`);
}
console.log("");

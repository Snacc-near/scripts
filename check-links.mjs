#!/usr/bin/env node
// check-links.mjs — OPS-115 / DK-085: links & hashes referenced in docs must EXIST.
// Source: README.md, HACKATHON.md, docs/*.md
// Checks:
//  A) paths in `backticks` → try relative-to-file, relative-to-repo-root, relative-to-project-root
//     (reports/… lives at the project root), then fall back to a basename search. A token without "/"
//     that is not found = filename mention → WARN (not a failure); a token with "/" that is not found = FAIL.
//  B) commit hashes in `backticks` (hex 7/40) → search ALL nested repos (umbrella, contracts,
//     scripts, backend, sdk, oracle-tee, frontend); the hash must be in the owner repo's origin/main
//     after a git fetch (decision 2026-11-08: a hash that is not on GitHub = must not be
//     referenced). A local hash without origin = FAIL.
//  C) NEAR tx hashes (base58 43–50, outside URLs, context not block/code-hash/ed25519) →
//     must be queryable (EXPERIMENTAL_tx_status, testnet).
//  D) NEAR accounts (*.testnet / *.near without placeholders) → must pass view_account on the matching RPC.
//  E) http(s) URLs → HTTP check; 401/402/403/429/999 = OK (bot wall); 5xx/network = WARN
//     (local network is unstable; --strict-http for CI if desired).
// Exits 1 on any FAIL.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = resolve(ROOT, "../.."); // NEAR-AI-Hackathon/ (reports/ lives here)
const STRICT_HTTP = process.argv.includes("--strict-http");
const RPC_TESTNET = ["https://near-testnet.drpc.org", "https://rpc.testnet.near.org"];
// Regular RPC nodes garbage-collect transactions after a few epochs (~2-3 days), so evidence
// tx hashes must be looked up on archival nodes.
const RPC_TESTNET_ARCHIVAL = ["https://archival-rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"];
const RPC_MAINNET = ["https://rpc.mainnet.near.org"];

const FILES = [
  "README.md",
  "HACKATHON.md",
  ...readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f)),
];

const REPOS = [ROOT, "contracts", "scripts", "backend", "sdk", "oracle-tee", "frontend"]
  .map((r) => (r === ROOT ? ROOT : join(ROOT, r)))
  .filter((r) => existsSync(join(r, ".git")));

const HEX_DENY = new Set(["ed25519", "deadbeef", "cafebabe"]);
const ACCOUNT_ALLOW = new Set([
  "snacc-v001.near", // mainnet design address (not deployed; decision = owner)
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "target", ".secrets", ".next", "dist", ".github"]);

const fails = [];
const warns = [];
const stats = { files: 0, paths: 0, commits: 0, txs: 0, accounts: 0, urls: 0 };
const basenameCache = new Map();

function fail(where, msg) {
  fails.push(`${where}: ${msg}`);
}
function warn(where, msg) {
  warns.push(`${where}: ${msg}`);
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function walkFindBasename(base, name, cap = { n: 0 }) {
  if (basenameCache.has(name)) return basenameCache.get(name);
  let found = false;
  let stack = [base];
  while (stack.length && !found) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (cap.n++ > 40000) break;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
      } else if (e.name === name) {
        found = true;
        break;
      }
    }
  }
  basenameCache.set(name, found);
  return found;
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "cl", method, params }),
    signal: AbortSignal.timeout(12000),
  });
  const j = await res.json();
  return j.result ?? j.error ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tries each endpoint in order and returns the first result without an error. Public archival
 * nodes rate-limit CI runners (429 / non-JSON bodies), so the whole list is retried with backoff.
 */
async function rpcAny(urls, method, params, rounds = 4) {
  let last = null;
  for (let round = 0; round < rounds; round++) {
    if (round > 0) await sleep(1500 * 2 ** (round - 1));
    for (const url of urls) {
      try {
        const r = await rpc(url, method, params);
        if (r && !r.error && !r.name) return r;
        last = r;
      } catch (e) {
        last = { error: String(e.message) };
      }
    }
  }
  return last;
}

function resolvePath(tok, baseDir) {
  const candidates = [resolve(baseDir, tok), resolve(ROOT, tok), resolve(PROJECT_ROOT, tok)];
  if (candidates.some((c) => existsSync(c))) return true;
  return walkFindBasename(ROOT, tok.split("/").pop());
}

async function main() {
  // --- prepare origin/main in all repos (best-effort fetch) ---
  let fetchFailed = false;
  for (const repo of REPOS) {
    if (git(repo, ["fetch", "origin", "--quiet"]) === null) fetchFailed = true;
  }
  if (fetchFailed) warn("git", "some git fetch origin calls failed — using the local refs that exist");
  const repoHasOriginMain = new Map(
    REPOS.map((r) => [r, git(r, ["rev-parse", "--verify", "--quiet", "origin/main"]) !== null]),
  );

  const urlQueue = [];

  for (const rel of FILES) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      fail(rel, "file does not exist");
      continue;
    }
    stats.files++;
    const raw = readFileSync(abs, "utf8");
    // URLs first (before stripping), so they are still checked
    for (const m of raw.matchAll(/\((https?:\/\/[^)\s]+)\)/g)) {
      urlQueue.push({ url: m[1], from: rel });
    }
    // strip URLs so hashes inside URLs are not treated as separate tx/hashes
    const text = raw.replace(/\((https?:\/\/[^)\s]+)\)/g, "(URL)");

    // A) paths in backticks
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim();
      if (!/^(?:\.\.\/)?[A-Za-z0-9_.\-/]+\.(?:md|json|mjs|js|ts|rs|toml|yml|yaml|svg|wasm|sh)$/.test(tok))
        continue;
      if (tok.startsWith("http")) continue;
      stats.paths++;
      if (resolvePath(tok, dirname(abs))) continue;
      if (tok.includes("/")) fail(rel, `referenced path does not exist: \`${tok}\``);
      else warn(rel, `filename mention not found as a path: \`${tok}\``);
    }

    // B) commit hashes in backticks — search all repos
    for (const m of text.matchAll(/`([0-9a-f]{7}|[0-9a-f]{40})`/g)) {
      const h = m[1];
      if (HEX_DENY.has(h)) continue;
      stats.commits++;
      const owner = REPOS.find((r) => git(r, ["cat-file", "-e", `${h}^{commit}`]) === "");
      if (!owner) {
        fail(rel, `commit hash \`${h}\` is unknown in every repo`);
        continue;
      }
      if (!repoHasOriginMain.get(owner)) {
        fail(rel, `commit hash \`${h}\`: repo ${owner.replace(ROOT, ".")} has no origin/main`);
        continue;
      }
      const contained = git(owner, ["branch", "-r", "--contains", h]);
      if (contained === null || !contained.split("\n").some((b) => b.trim() === "origin/main")) {
        const where = owner === ROOT ? "umbrella" : owner.replace(ROOT + "/", "");
        fail(rel, `commit hash \`${h}\` exists locally (${where}) but NOT on origin/main — cannot be checked publicly`);
      }
    }

    // C) NEAR tx hashes (outside URLs, clean context)
    const txHashes = new Set(
      [...text.matchAll(/\b([1-9A-HJ-NP-Za-km-z]{43,50})\b/g)]
        .map((m) => ({ t: m[1], ctx: text.slice(Math.max(0, m.index - 30), m.index + m[1].length + 10) }))
        .filter(({ t, ctx }) =>
          !t.includes("-") &&
          !/block_hash|code_hash|ed25519|phantom|solana|owner_id|account_id|pubkey/i.test(ctx),
        )
        .map(({ t }) => t),
    );

    // D) NEAR accounts
    const accounts = new Set(
      [...text.matchAll(/\b([a-z0-9][a-z0-9._-]{0,61}(?:\.testnet|\.near))\b/g)]
        .map((m) => m[1])
        .filter((a) => !a.includes("<") && !ACCOUNT_ALLOW.has(a)),
    );

    // E) URLs — already collected from `raw` above

    for (const tx of txHashes) {
      stats.txs++;
      try {
        const r = await rpcAny(RPC_TESTNET_ARCHIVAL, "EXPERIMENTAL_tx_status", [tx, "snacc-v001.testnet"]);
        if (!r || r.error || !r.transaction) {
          fail(rel, `tx hash not found on testnet: ${tx}`);
        }
      } catch (e) {
        fail(rel, `tx hash ${tx}: RPC error ${String(e.message).slice(0, 80)}`);
      }
    }

    for (const acct of accounts) {
      stats.accounts++;
      const urls = acct.endsWith(".testnet") ? RPC_TESTNET : RPC_MAINNET;
      try {
        const r = await rpcAny(urls, "query", {
          request_type: "view_account",
          finality: "final",
          account_id: acct,
        });
        if (!r || r.error) fail(rel, `account not found on RPC: ${acct}`);
      } catch (e) {
        fail(rel, `account ${acct}: RPC error ${String(e.message).slice(0, 80)}`);
      }
    }
  }

  for (const { url, from } of urlQueue) {
    stats.urls++;
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
        headers: { "user-agent": "snacc-check-links/1.0" },
      });
      const okish = res.status < 400 || [401, 402, 403, 429, 999].includes(res.status);
      if (!okish) {
        const msg = `URL ${url} → HTTP ${res.status}`;
        if (res.status >= 500 || STRICT_HTTP) fail(from, msg);
        else warn(from, msg);
      }
    } catch (e) {
      const msg = `URL ${url} could not be reached: ${String(e.message).slice(0, 80)}`;
      if (STRICT_HTTP) fail(from, msg);
      else warn(from, msg);
    }
  }

  console.log(
    `check-links: ${stats.files} files · ${stats.paths} paths · ${stats.commits} commit hashes · ` +
      `${stats.txs} txs · ${stats.accounts} accounts · ${stats.urls} URLs · ${REPOS.length} repos`,
  );
  for (const w of warns) console.log(`  WARN  ${w}`);
  if (fails.length === 0) {
    console.log("check-links OK — 0 failures");
    process.exit(0);
  }
  console.log(`check-links FAILED — ${fails.length} findings:`);
  for (const f of fails) console.log(`  FAIL  ${f}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("check-links crash:", e);
  process.exit(1);
});

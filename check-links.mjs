#!/usr/bin/env node
// check-links.mjs — OPS-115 / DK-085: link & hash yang dirujuk di dokumen harus ADA.
// Sumber: README.md, HACKATHON.md, docs/*.md
// Pemeriksaan:
//  A) path dalam `backtick` → coba relatif-ke-file, relatif-repo-root, relatif-project-root
//     (reports/… ada di root proyek), lalu fallback basename-search. Token tanpa "/" yang
//     tidak ketemu = filename mention → WARN (bukan gagal); token ber-/ yang tidak ketemu = FAIL.
//  B) hash commit dalam `backtick` (hex 7/40) → cari di SEMUA repo nested (payung, contracts,
//     scripts, backend, sdk, oracle-tee, frontend); hash harus ada di origin/main repo pemilik
//     setelah git fetch (keputusan 2026-11-08: hash yang tidak ada di GitHub = tidak boleh
//     dirujuk). Hash lokal-tanpa-origin = GAGAL.
//  C) tx hash NEAR (base58 43–50, di luar URL, konteks bukan block/code-hash/ed25519) →
//     wajib bisa di-query (EXPERIMENTAL_tx_status, testnet).
//  D) akun NEAR (*.testnet / *.near tanpa placeholder) → wajib view_account di RPC yang sesuai.
//  E) URL http(s) → HTTP check; 401/402/403/429/999 = OK (bot wall); 5xx/jaringan = WARN
//     (jaringan lokal tidak stabil; --strict-http untuk CI bila diinginkan).
// Exit 1 bila ada FAIL.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_ROOT = resolve(ROOT, "../.."); // NEAR-AI-Hackathon/ (reports/ ada di sini)
const STRICT_HTTP = process.argv.includes("--strict-http");
const RPC_TESTNET = "https://near-testnet.drpc.org";
const RPC_MAINNET = "https://rpc.mainnet.near.org";

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
  "snacc-v001.near", // alamat desain mainnet (belum deploy; keputusan = pemilik)
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

function resolvePath(tok, baseDir) {
  const candidates = [resolve(baseDir, tok), resolve(ROOT, tok), resolve(PROJECT_ROOT, tok)];
  if (candidates.some((c) => existsSync(c))) return true;
  return walkFindBasename(ROOT, tok.split("/").pop());
}

async function main() {
  // --- siapkan origin/main di semua repo (fetch terbaik) ---
  let fetchFailed = false;
  for (const repo of REPOS) {
    if (git(repo, ["fetch", "origin", "--quiet"]) === null) fetchFailed = true;
  }
  if (fetchFailed) warn("git", "sebagian git fetch origin gagal — memakai refs lokal yang ada");
  const repoHasOriginMain = new Map(
    REPOS.map((r) => [r, git(r, ["rev-parse", "--verify", "--quiet", "origin/main"]) !== null]),
  );

  const urlQueue = [];

  for (const rel of FILES) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      fail(rel, "file tidak ada");
      continue;
    }
    stats.files++;
    const raw = readFileSync(abs, "utf8");
    // URL dulu (sebelum di-strip), agar tetap diperiksa
    for (const m of raw.matchAll(/\((https?:\/\/[^)\s]+)\)/g)) {
      urlQueue.push({ url: m[1], from: rel });
    }
    // buang URL agar hash di dalam URL tidak dianggap tx/hash terpisah
    const text = raw.replace(/\((https?:\/\/[^)\s]+)\)/g, "(URL)");

    // A) path dalam backtick
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim();
      if (!/^(?:\.\.\/)?[A-Za-z0-9_.\-/]+\.(?:md|json|mjs|js|ts|rs|toml|yml|yaml|svg|wasm|sh)$/.test(tok))
        continue;
      if (tok.startsWith("http")) continue;
      stats.paths++;
      if (resolvePath(tok, dirname(abs))) continue;
      if (tok.includes("/")) fail(rel, `path rujukan tidak ada: \`${tok}\``);
      else warn(rel, `sebutan filename tidak ditemukan sebagai path: \`${tok}\``);
    }

    // B) hash commit dalam backtick — cari di semua repo
    for (const m of text.matchAll(/`([0-9a-f]{7}|[0-9a-f]{40})`/g)) {
      const h = m[1];
      if (HEX_DENY.has(h)) continue;
      stats.commits++;
      const owner = REPOS.find((r) => git(r, ["cat-file", "-e", `${h}^{commit}`]) === "");
      if (!owner) {
        fail(rel, `hash commit \`${h}\` tidak dikenal di repo mana pun`);
        continue;
      }
      if (!repoHasOriginMain.get(owner)) {
        fail(rel, `hash commit \`${h}\`: repo ${owner.replace(ROOT, ".")} tanpa origin/main`);
        continue;
      }
      const contained = git(owner, ["branch", "-r", "--contains", h]);
      if (contained === null || !contained.split("\n").some((b) => b.trim() === "origin/main")) {
        const where = owner === ROOT ? "payung" : owner.replace(ROOT + "/", "");
        fail(rel, `hash commit \`${h}\` ada lokal (${where}) tapi TIDAK di origin/main — tidak bisa dicek publik`);
      }
    }

    // C) tx hash NEAR (di luar URL, konteks bersih)
    const txHashes = new Set(
      [...text.matchAll(/\b([1-9A-HJ-NP-Za-km-z]{43,50})\b/g)]
        .map((m) => ({ t: m[1], ctx: text.slice(Math.max(0, m.index - 30), m.index + m[1].length + 10) }))
        .filter(({ t, ctx }) =>
          !t.includes("-") &&
          !/block_hash|code_hash|ed25519|phantom|solana|owner_id|account_id|pubkey/i.test(ctx),
        )
        .map(({ t }) => t),
    );

    // D) akun NEAR
    const accounts = new Set(
      [...text.matchAll(/\b([a-z0-9][a-z0-9._-]{0,61}(?:\.testnet|\.near))\b/g)]
        .map((m) => m[1])
        .filter((a) => !a.includes("<") && !ACCOUNT_ALLOW.has(a)),
    );

    // E) URL — sudah dikumpulkan dari `raw` di atas

    for (const tx of txHashes) {
      stats.txs++;
      try {
        const r = await rpc(RPC_TESTNET, "EXPERIMENTAL_tx_status", [tx, "snacc-v001.testnet"]);
        if (!r || r.error || !r.transaction) {
          fail(rel, `tx hash tidak ditemukan di testnet: ${tx}`);
        }
      } catch (e) {
        fail(rel, `tx hash ${tx}: RPC error ${String(e.message).slice(0, 80)}`);
      }
    }

    for (const acct of accounts) {
      stats.accounts++;
      const url = acct.endsWith(".testnet") ? RPC_TESTNET : RPC_MAINNET;
      try {
        const r = await rpc(url, "query", {
          request_type: "view_account",
          finality: "final",
          account_id: acct,
        });
        if (!r || r.error) fail(rel, `akun tidak ditemukan di RPC: ${acct}`);
      } catch (e) {
        fail(rel, `akun ${acct}: RPC error ${String(e.message).slice(0, 80)}`);
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
      const msg = `URL ${url} gagal diakses: ${String(e.message).slice(0, 80)}`;
      if (STRICT_HTTP) fail(from, msg);
      else warn(from, msg);
    }
  }

  console.log(
    `check-links: ${stats.files} file · ${stats.paths} path · ${stats.commits} hash commit · ` +
      `${stats.txs} tx · ${stats.accounts} akun · ${stats.urls} URL · ${REPOS.length} repo`,
  );
  for (const w of warns) console.log(`  WARN  ${w}`);
  if (fails.length === 0) {
    console.log("check-links OK — 0 gagal");
    process.exit(0);
  }
  console.log(`check-links GAGAL — ${fails.length} temuan:`);
  for (const f of fails) console.log(`  FAIL  ${f}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("check-links crash:", e);
  process.exit(1);
});

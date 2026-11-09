#!/usr/bin/env node
// dex-check.mjs — $SNACC DEX STATUS VERIFIER (honest: EXISTS / DOES NOT EXIST / CANNOT BE CHECKED).
//   node scripts/dex-check.mjs [--token <contract address>]
// Layered checks: (1) the token is live on chain (ft_metadata/ft_total_supply),
// (2) presence of a pool/market on public DEXes (Ref/Meme Cooking) by CONTRACT ADDRESS
// (not ticker — tickers can be spoofed), (3) print the conclusion as-is.
// Principle: if it cannot be verified = write "CANNOT BE CHECKED", never make anything up.
const CONTRACT = process.argv.includes("--token") ? process.argv[process.argv.indexOf("--token") + 1] : "snacc-v001.testnet";

async function probe(name, url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    return { name, ok: res.ok, status: res.status, body: text.slice(0, 400) };
  } catch (e) {
    return { name, ok: false, status: 0, body: `unreachable: ${String(e.message).slice(0, 60)}` };
  }
}
async function rpcView(method, args = {}) {
  const r = await fetch("https://near-testnet.drpc.org", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  return JSON.parse(Buffer.from(j.result.result).toString("utf8"));
}

console.log(`# $SNACC DEX status check — contract: ${CONTRACT}\n`);
const conclusions = [];

// (1) Is the token live on chain?
try {
  const md = await rpcView("ft_metadata");
  const ts = await rpcView("ft_total_supply");
  console.log(`✅ TOKEN LIVE on chain: name=${md.name} symbol=${md.symbol} decimals=${md.decimals} · ft_total_supply=${ts}`);
  conclusions.push("NEP-141 token is LIVE on testnet (not a fabricated token).");
} catch (e) {
  console.log(`❌ Token NOT readable: ${String(e.message).slice(0, 80)}`);
  conclusions.push("Token is not readable on chain — a claim that it 'exists' is NOT valid.");
}

// (2) Check DEXes by CONTRACT ADDRESS (not ticker)
// Ref Finance (mainnet) — public pools API; Meme Cooking — token search.
const targets = [
  ["Ref Finance (mainnet) — look up the contract address in pools", "https://api.ref.finance/list-pairs"],
  ["Meme Cooking — token search", `https://meme.cooking/api/tokens?search=${CONTRACT}`],
  ["NEAR Blocks (testnet) — contract footprint", `https://api-testnet.nearblocks.io/v1/account/${CONTRACT}`],
];
for (const [name, url] of targets) {
  const r = await probe(name, url);
  const mentions = r.body.includes(CONTRACT) || r.body.toLowerCase().includes("snacc");
  if (!r.ok) console.log(`⚠️  ${name}: CANNOT BE CHECKED (HTTP ${r.status}) — ${r.body.slice(0, 60)}`);
  else if (mentions) console.log(`🔎 ${name}: MENTION FOUND — check manually: ${r.body.slice(0, 120)}`);
  else console.log(`🚫 ${name}: NO entry found for ${CONTRACT}`);
  conclusions.push(`- ${name}: ${!r.ok ? "cannot be checked automatically (check manually via the link)" : mentions ? "mention found — verify manually" : "not found"}`);
}

// (3) Honest conclusion
console.log("\n## Conclusion");
console.log(conclusions.join("\n"));
console.log(`
Valid criteria for "LISTED ON A DEX" (check at listing time):
1. A pool/liquidity EXISTS on a DEX (Ref / Meme Cooking) for the CONTRACT ADDRESS (not the ticker).
2. The contract address matches the officially published one (README/HACKATHON.md).
3. There is locked/recorded liquidity (TVL) + real trading volume.
4. Never trust NAME-based search — $SNACC can be imitated; the valid identifier = the ADDRESS.`);

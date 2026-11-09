#!/usr/bin/env node
// DK-022 — liquidator bot E2 (minimum version): scans Tier-3 Chapter 7 strains
// (`effective_vitality == 0`, spec `harvest_starving_strain` / `I-10`) then calls
// `harvest_starving_strain(target_id)` — 10% bounty to the caller, 90% to the treasury (D6).
//
// Usage:
//   node scripts/liquidator.mjs               # dry-run: scan + report candidates (no tx)
//   node scripts/liquidator.mjs --execute      # send harvest for the first candidate
//   MAX_STRAIN=50 node scripts/liquidator.mjs  # scan limit (default 60)
//
// Why dry-run is the default: it needs a signing key + an eff==0 candidate that actually exists
// live. Without candidates, the script honestly reports "0 candidates" and sends NOTHING.
// Signer: `LIQUIDATOR_KEY` (JSON key path) if set, otherwise the contract key
// (gladi-run pattern) — a dedicated E2 account = final design DK-054, outside this minimum version.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const { Account, JsonRpcProvider, KeyPairSigner } = createRequire(
  resolve(here, "../../x207/sdk/package.json"),
)("near-api-js");

const RPC = "https://near-testnet.drpc.org";
const CONTRACT = "snacc-v001.testnet";
const MAX = Number(process.env.MAX_STRAIN ?? 60);
const EXECUTE = process.argv.includes("--execute");

const provider = new JsonRpcProvider({ url: RPC });
const keyPath = process.env.LIQUIDATOR_KEY
  ? resolve(ROOT, process.env.LIQUIDATOR_KEY)
  : resolve(ROOT, ".secrets/snacc/snacc-v001.testnet.json");
const keyOf = (p) => {
  const j = JSON.parse(readFileSync(p, "utf8"));
  return j.secret_key ?? j.private_key;
};

const view = async (method, args = {}) => {
  const r = await provider.query({
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};

async function main() {
  console.log(`DK-022 liquidator bot — scan 1..${MAX} @ ${CONTRACT} (${EXECUTE ? "EXECUTE" : "dry-run"})`);

  // 1) Scan candidates: Active + effective_vitality == 0 (get_strain computes Lazy BMR for now).
  const candidates = [];
  const seen = [];
  for (let id = 1; id <= MAX; id++) {
    let v;
    try {
      v = await view("get_strain", { strain_id: id });
    } catch {
      break; // id does not exist → end of range
    }
    seen.push({ id, eff: v.effective_vitality, status: v.status });
    if (v.status === "Active" && v.effective_vitality === 0) candidates.push(id);
  }
  console.log(`scan: ${seen.length} live strains · eff range ${Math.min(...seen.map((s) => s.eff))}..${Math.max(...seen.map((s) => s.eff))}`);
  if (candidates.length === 0) {
    console.log(
      "0 insolvent candidates (eff==0). The bot does NOT send a transaction. " +
        "Live liquidation needs a strain to age to eff=0 (G-10 window, see gladi-retry).",
    );
    process.exit(0);
  }
  console.log(`candidates: ${candidates.map((c) => `#${c}`).join(", ")}`);

  // 2) Execute (only when requested + key available).
  if (!EXECUTE) {
    console.log("dry-run finished — run with --execute to send the harvest.");
    process.exit(0);
  }
  if (!existsSync(keyPath)) {
    console.error(`key not found: ${keyPath} — set LIQUIDATOR_KEY or run the dry-run.`);
    process.exit(2);
  }
  const signer = new Account(CONTRACT, provider, KeyPairSigner.fromSecretKey(keyOf(keyPath)));
  const target = candidates[0];
  const r = await signer.callFunctionRaw({
    contractId: CONTRACT,
    methodName: "harvest_starving_strain",
    args: { target_id: target },
    deposit: 0n,
    gas: 300_000_000_000_000n,
    waitUntil: "FINAL",
  });
  const tx = r.transaction.hash;
  console.log(`HARVEST_OK target=#${target} tx=${tx}`);
  console.log(`evidence: https://testnet.nearblocks.io/txns/${tx}`);
}

main().catch((e) => {
  console.error("liquidator failed:", String(e.message ?? e).slice(0, 300));
  process.exit(1);
});

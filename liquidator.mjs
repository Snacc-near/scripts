#!/usr/bin/env node
// DK-022 — bot liquidator E2 (versi minimum): memindai strain Tier-3 Chapter 7
// (`effective_vitality == 0`, spec `harvest_starving_strain` / `I-10`) lalu memanggil
// `harvest_starving_strain(target_id)` — 10% bounty ke pemanggil, 90% ke treasury (D6).
//
// Pemakaian:
//   node scripts/liquidator.mjs               # dry-run: scan + lapor kandidat (tanpa tx)
//   node scripts/liquidator.mjs --execute      # kirim harvest untuk kandidat pertama
//   MAX_STRAIN=50 node scripts/liquidator.mjs  # batas scan (default 60)
//
// Kenapa dry-run default: butuh key penandatangan + kandidat eff==0 yang benar-benar ada
// di live. Tanpa kandidat, script jujur melapor "0 kandidat" dan TIDAK mengirim apa pun.
// Signer: `LIQUIDATOR_KEY` (path JSON key) bila diisi, selain itu memakai key kontrak
// (pola gladi-run) — akun E2 khusus = desain final DK-054, di luar versi minimum ini.
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

  // 1) Scan kandidat: Active + effective_vitality == 0 (get_strain menghitung Lazy BMR untuk now).
  const candidates = [];
  const seen = [];
  for (let id = 1; id <= MAX; id++) {
    let v;
    try {
      v = await view("get_strain", { strain_id: id });
    } catch {
      break; // id tidak ada → akhir rentang
    }
    seen.push({ id, eff: v.effective_vitality, status: v.status });
    if (v.status === "Active" && v.effective_vitality === 0) candidates.push(id);
  }
  console.log(`scan: ${seen.length} strain hidup · eff range ${Math.min(...seen.map((s) => s.eff))}..${Math.max(...seen.map((s) => s.eff))}`);
  if (candidates.length === 0) {
    console.log(
      "0 kandidat insolven (eff==0). Bot TIDAK mengirim transaksi. " +
        "Liquidation live butuh strain menua sampai eff=0 (jendela G-10, lihat gladi-retry).",
    );
    process.exit(0);
  }
  console.log(`kandidat: ${candidates.map((c) => `#${c}`).join(", ")}`);

  // 2) Execute (hanya bila diminta + key tersedia).
  if (!EXECUTE) {
    console.log("dry-run selesai — jalankan dengan --execute untuk mengirim harvest.");
    process.exit(0);
  }
  if (!existsSync(keyPath)) {
    console.error(`key tidak ditemukan: ${keyPath} — set LIQUIDATOR_KEY atau jalankan dry-run.`);
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
  console.log(`bukti: https://testnet.nearblocks.io/txns/${tx}`);
}

main().catch((e) => {
  console.error("liquidator gagal:", String(e.message ?? e).slice(0, 300));
  process.exit(1);
});

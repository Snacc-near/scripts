#!/usr/bin/env node
// gladi-retry.mjs — perbaiki langkah gladi yang panic (deposit katalis + signer TEE + payload).
//   node scripts/gladi-retry.mjs
// Membaca reports/gladi-manifest.json, menambah aksi baru, menyimpan ulang.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const { Account, JsonRpcProvider, KeyPairSigner } = createRequire(resolve(here, "../../x207/sdk/package.json"))("near-api-js");
const provider = new JsonRpcProvider({ url: "https://near-testnet.drpc.org" });
const CONTRACT = "snacc-v001.testnet";
const keyOf = (p) => JSON.parse(readFileSync(p, "utf8")).secret_key ?? JSON.parse(readFileSync(p, "utf8")).private_key;
const main = new Account(CONTRACT, provider, KeyPairSigner.fromSecretKey(keyOf(resolve(ROOT, ".secrets/snacc/snacc-v001.testnet.json"))));

const manifest = JSON.parse(readFileSync(resolve(ROOT, "reports/gladi-manifest.json"), "utf8"));
const call = async (methodName, args, deposit = 0n) => {
  const r = await main.callFunctionRaw({ contractId: CONTRACT, methodName, args, deposit, gas: 300_000_000_000_000n, waitUntil: "FINAL" });
  return r.transaction.hash;
};
const record = (kpi, txHash, note) => { manifest.actions.push({ kpi, txHash, signer: CONTRACT, note }); console.log(`  ✓ ${kpi} tx=${txHash} (${note})`); };
const step = async (kpi, label, fn) => {
  console.log(`▶ ${label}`);
  try { record(kpi, await fn(), label); } catch (e) {
    const detail = JSON.stringify(e?.TransactionResult ?? e?.message ?? e).slice(0, 300);
    console.log(`  ✗ ${detail}`);
    manifest.actions.push({ kpi, txHash: null, note: `GAGAL: ${detail}` });
  }
};
const nowSec = () => Math.floor(Date.now() / 1000);

async function run() {
  const v = JSON.parse(readFileSync(resolve(ROOT, "reports/tee-vector-live.json"), "utf8"));

  // 0) Daftarkan signer TEE (I-16) — registri kosong pasca-migrate
  await step("G-05", "register_attested_signer (pubkey enclave)", () => call("register_attested_signer", { pubkey_hex: v.tee_pubkey_hex, attested_at_sec: nowSec() }));

  // 1) 3-stage dengan DEPOSIT katalis yang benar (attached == fee)
  await step("G-04", "extract spores (deposit==fee)", () => call("extract_spores", { strain_id: 1, spore_type: "mt:spore-ignis", snacc_catalyst_fee: "10000000000000" }, 10n ** 13n));
  await step("G-04", "transmute spores→enzyme (strain 1, E|F)", () => call("transmute_spores_to_enzyme", { strain_id: 1, spores_to_burn: 5, snacc_catalyst_fee: "10000000000000" }, 10n ** 13n));

  // 2) Fusi kedua: strain 1 (E|F) absorbs strain 3 (S) → role E|F|S + inventori menyatu
  await step("G-06", "splice_strains (1 absorbs 3 — role E|F|S)", () => call("splice_strains", { dominant_id: 1, absorbed_id: 3 }));

  // 3) Synthesize setelah role lengkap + enzyme tersedia
  await step("G-04", "synthesize enzyme→elixir (strain 1, E|F|S)", () => call("synthesize_elixir", { strain_id: 1, elixir_type: "mt:elixir-homeostasis", enzymes_to_burn: 3, snacc_catalyst_fee: "10000000000000" }, 10n ** 13n));

  // 4) TEE: commit + apply dengan vektor BARU (payload MutationPayload persis)
  await step("G-05", "commit_genome_experiment (req_sha baru)", () => call("commit_genome_experiment", { strain_id: 1, req_sha256_hex: v.req_sha256_hex }));
  await step("G-05", "apply_tee_mutation_zero_trust (payload persis)", () => call("apply_tee_mutation_zero_trust", {
    strain_id: 1, req_sha256_hex: v.req_sha256_hex, raw_response_body: v.raw_response_body,
    signature_hex: v.signature_hex, tee_pubkey_hex: v.tee_pubkey_hex,
  }));

  // 5) Dividen DK-033 — coba beberapa epoch (kontribusi dari burn/fee sebelumnya)
  for (const ep of [1, 0, 2]) {
    await step("G-11", `claim_industrial_dividend (strain 1, epoch ${ep})`, () => call("claim_industrial_dividend", { strain_id: 1, epoch: ep }));
  }

  // 6) Vault sub-account
  await step("G-21", "materialize_subaccount (strain 1)", () => call("materialize_subaccount", { strain_id: 1 }));

  // 7) NEP-141 — kirim bila saldo akun sudah terisi (klaim dividen → akun)
  const bal = await (async () => {
    const r = await provider.query({ request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: "ft_balance_of", args_base64: Buffer.from(JSON.stringify({ account_id: CONTRACT })).toString("base64") });
    return JSON.parse(Buffer.from(r.result).toString("utf8"));
  })();
  if (BigInt(bal ?? "0") > 0n) {
    await step("G-02", `ft_transfer (saldo akun ${bal})`, () => call("ft_transfer", { receiver_id: "x207-demo-buyer.testnet", amount: "1000", memo: "gladi" }, 1n));
  } else { console.log(`▶ ft_transfer: saldo akun masih 0`); }

  writeFileSync(resolve(ROOT, "reports/gladi-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nMANIFEST kini ${manifest.actions.filter((a) => a.txHash).length} tx tercatat`);
}
run().catch((e) => { console.error(e); process.exit(1); });

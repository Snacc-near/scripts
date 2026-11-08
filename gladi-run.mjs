#!/usr/bin/env node
// gladi-run.mjs v4 — pelaksana gladi FINAL (model baru: suhu ATP EN-117 + efek organel EN-119 +
// NEP-177/145/181). Perubahan v4: feed 5×10^17 (atp_minted ≈ 500 unit), langkah `allocate_atp`,
// bukti view `get_global_solvency`/`get_inventory`, trio NEP (nft_metadata · storage_deposit
// registration_only · nft_tokens) dengan kpi G-22 (saran KPI baru — lihat laporan tugas).
//   node scripts/gladi-run.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const { Account, JsonRpcProvider, KeyPairSigner } = createRequire(resolve(here, "../../x207/sdk/package.json"))("near-api-js");
const provider = new JsonRpcProvider({ url: "https://near-testnet.drpc.org" });
const CONTRACT = "snacc-v001.testnet";
const keyOf = (p) => { const j = JSON.parse(readFileSync(p, "utf8")); return j.secret_key ?? j.private_key; };
const main = new Account(CONTRACT, provider, KeyPairSigner.fromSecretKey(keyOf(resolve(ROOT, ".secrets/snacc/snacc-v001.testnet.json"))));

const v = JSON.parse(readFileSync(resolve(ROOT, "reports/tee-vector-live.json"), "utf8"));
const manifest = {
  owner: CONTRACT, signer: CONTRACT, counterparty: "x207-demo-buyer.testnet",
  strain_ids: [1, 2, 3], token_ids: ["1", "2", "3"], supply_before: null, temp_before: null,
  tee_chat_id: v.chat_id, actions: [],
};
const call = async (methodName, args, deposit = 0n) => {
  const r = await main.callFunctionRaw({ contractId: CONTRACT, methodName, args, deposit, gas: 300_000_000_000_000n, waitUntil: "FINAL" });
  return r.transaction.hash;
};
const view = async (method, args = {}) => {
  const r = await provider.query({ request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};
const record = (kpi, txHash, note) => { manifest.actions.push({ kpi, txHash, signer: CONTRACT, note }); console.log(`  ✓ ${kpi} tx=${txHash} (${note})`); };
const step = async (kpi, label, fn) => {
  console.log(`▶ ${label}`);
  try { record(kpi, await fn(), label); return true; }
  catch (e) {
    const st = (e.transactionResult?.receipts_outcome ?? []).map((r) => r.outcome?.status).filter((s) => s?.Failure).map((s) => JSON.stringify(s.Failure)).join("|");
    console.log(`  ✗ ${(st || e.message).slice(0, 140)}`);
    manifest.actions.push({ kpi, txHash: null, note: `GAGAL: ${(st || e.message).slice(0, 110)}` });
    return false;
  }
};
const inv = async (token) => BigInt(await view("get_inventory", { strain_id: 1, token_id: token }));
// BUKTI view read-only: dicatat ke manifest (txHash null + nilai) — tak mengganggu KPI runner.
const bukti = async (label, method, args, kpi = "BUKTI") => {
  try {
    const val = await view(method, args);
    manifest.actions.push({ kpi, txHash: null, note: `${label}: ${JSON.stringify(val).slice(0, 220)}` });
    console.log(`  ✓ ${label} (view) → ${JSON.stringify(val).slice(0, 120)}`);
    return val;
  } catch (e) {
    manifest.actions.push({ kpi, txHash: null, note: `${label}: GAGAL view — ${String(e.message ?? e).slice(0, 100)}` });
    console.log(`  ✗ ${label} (view) — ${String(e.message ?? e).slice(0, 100)}`);
    return null;
  }
};
const FE = 10n ** 13n;            // fee katalis nominal
const DEP_DIET = 8n * 10n ** 12n; // transmute: fee × 0.8 (diet Hypo+Synthesizer)
const IGNIS = "mt:spore-ignis", LUMIN = "mt:spore-lumin";

async function run() {
  manifest.supply_before = await view("ft_total_supply");
  manifest.temp_before = await view("get_crucible_temp").catch(() => 0);

  // 1) Lahir ×3 (tiap peran satu strain)
  await step("G-01", "incubate Extractor (strain 1)", () => call("incubate_strain", { role: "Extractor", initial_snacc_stake: "1000000000000000000000000", initial_spores: 10 }, 10n ** 24n));
  await step("PREP", "incubate Fermenter (strain 2)", () => call("incubate_strain", { role: "Fermenter", initial_snacc_stake: "500000000000000000000000", initial_spores: 10 }, 5n * 10n ** 23n));
  await step("PREP", "incubate Synthesizer (strain 3)", () => call("incubate_strain", { role: "Synthesizer", initial_snacc_stake: "500000000000000000000000", initial_spores: 10 }, 5n * 10n ** 23n));

  // 2) Makan → ATP (model ATP: EN-115 — atp_minted = feed/10^15 × eff × (10+mito)/10;
  //    feed 5×10^17 → atp_minted ≥ 500 unit, cukup untuk seluruh rantai kerja:
  //    extract/transmute/synthesize + allocate + divide + hostile).
  await step("G-03", "feed strain 1 (5×10^17 — model ATP)", () => call("feed_strain", { strain_id: 1, amount: "500000000000000000" }));
  // BUKTI (c): V_epoch tepat setelah feed memuat jejak ATP: atp_minted×ATP_VOLUME_SCALE(6×10^14)
  // (EN-117 suhu literal ATP). Diambil SEKARANG — V_epoch ter-reset tiap advance_epoch.
  const macroFeed = await bukti("get_macro_state pasca-feed (V_epoch jejak ATP)", "get_macro_state");
  await bukti("get_global_solvency pasca-feed", "get_global_solvency");
  if (macroFeed) manifest.bukti_feed = {
    volume_epoch: macroFeed.volume_epoch ?? null, temp_mk: macroFeed.current_temp_mk ?? null,
    feed_amount: "500000000000000000", atp_minted_min: 500, ATP_VOLUME_SCALE: "600000000000000",
  };

  // (a) Alokasi ATP — efek organel (EN-119): mitokondria +10%/level minting ATP,
  // nukleus +10%/level output produksi, lisosom −10%/level BMR. Biaya = Σ kenaikan
  // level (1/1/1 → 3 ATP); sekali per epoch (EN-114).
  await step("PREP", "allocate_atp (1/1/1 — efek organel EN-119, biaya 3 ATP)", () =>
    call("allocate_atp", { strain_id: 1, mitokondria: 1, nukleus: 1, lisosom: 1 }));

  // 3) TEE zero-trust (vektor live tersimpan — tanpa API baru)
  await step("G-05", "register_attested_signer", () => call("register_attested_signer", { pubkey_hex: v.tee_pubkey_hex, attested_at_sec: Math.floor(Date.now() / 1000) }));
  await step("G-05", "commit_genome_experiment (strain 1)", () => call("commit_genome_experiment", { strain_id: 1, req_sha256_hex: v.req_sha256_hex }));
  await step("G-05", "apply_tee_mutation_zero_trust", () => call("apply_tee_mutation_zero_trust", {
    strain_id: 1, req_sha256_hex: v.req_sha256_hex, raw_response_body: v.raw_response_body,
    signature_hex: v.signature_hex, tee_pubkey_hex: v.tee_pubkey_hex,
  }));

  // 4) Rantai NEP-245 — deposit == fee; transmute inventori-aware (amalgam lalu redactase)
  await step("G-04", "extract ignis", () => call("extract_spores", { strain_id: 1, spore_type: IGNIS, snacc_catalyst_fee: String(FE) }, FE));
  await step("G-04", "extract lumin", () => call("extract_spores", { strain_id: 1, spore_type: LUMIN, snacc_catalyst_fee: String(FE) }, FE));
  for (let i = 0; i < 8 && (await inv(IGNIS)) >= 2n; i++) {
    await step("G-04", `transmute resep1 (ignis→amalgam, iterasi ${i + 1})`, () => call("transmute_spores_to_enzyme", { strain_id: 1, spores_to_burn: 2, snacc_catalyst_fee: String(FE) }, DEP_DIET));
  }
  if ((await inv(IGNIS)) === 0n) await step("G-04", "extract ignis (satu lagi untuk resep2)", () => call("extract_spores", { strain_id: 1, spore_type: IGNIS, snacc_catalyst_fee: String(FE) }, FE));
  await step("G-04", "transmute resep2 (ignis+lumin→redactase)", () => call("transmute_spores_to_enzyme", { strain_id: 1, spores_to_burn: 2, snacc_catalyst_fee: String(FE) }, DEP_DIET));
  await step("G-04", "synthesize elixir-homeostasis (amalgam+redactase, deposit NOMINAL)", () =>
    call("synthesize_elixir", { strain_id: 1, elixir_type: "mt:elixir-homeostasis", enzymes_to_burn: 2, snacc_catalyst_fee: String(FE) }, FE));
  // (c) BUKTI inventori NEP-245 + solvabilitas V-04 (view baru) — pasca rantai produksi.
  for (const t of [IGNIS, LUMIN, "mt:enzyme-amalgam", "mt:enzyme-redactase", "mt:elixir-homeostasis"]) {
    await bukti(`get_inventory ${t} (strain 1)`, "get_inventory", { strain_id: 1, token_id: t });
  }
  await bukti("get_global_solvency pasca-produksi", "get_global_solvency");

  // 5) NPC + burn
  await step("G-13", "npc_buy_spores (npc-extractor, 50)", () => call("npc_buy_spores", { strain_id: 1, npc_id: "npc-extractor", buy_amount: 50 }));
  await step("G-17", "ft_burn (10^15 $SNACC)", () => call("ft_burn", { strain_id: 1, amount: "1000000000000000" }));

  // 6) Fusi ×2 (role E|F|S) → divide (EN-124 terbuka setelah merger)
  await step("G-06", "splice (1 absorbs 2)", () => call("splice_strains", { dominant_id: 1, absorbed_id: 2 }));
  await step("G-06", "splice (1 absorbs 3)", () => call("splice_strains", { dominant_id: 1, absorbed_id: 3 }));
  await step("G-09", "divide_strain (anak = strain 4)", () => call("divide_strain", { strain_id: 1 }));
  manifest.strain_ids = [1, 2, 3, 4]; manifest.token_ids = ["1", "2", "3", "4"];

  // 7) Dividen DK-033/044: kontribusi aether → tutup epoch → klaim
  await step("G-11", "synthesize_and_redeem_aether (kontribusi dividen)", () => call("synthesize_and_redeem_aether", { strain_id: 1, amount: "1000000000000000" }));
  await step("G-19", "advance_epoch (tutup epoch 0)", () => call("advance_epoch", {}));
  await step("G-11", "claim_industrial_dividend (epoch 0)", () => call("claim_industrial_dividend", { strain_id: 1, epoch: 0 }));
  await step("G-19", "advance_epoch ke-2", () => call("advance_epoch", {}));

  // 8) Vault sub-account (deposit ≥ 20 mN = 2×10^22)
  await step("G-21", "materialize_subaccount (deposit 20 mN)", () => call("materialize_subaccount", { strain_id: 1 }, 2n * 10n ** 22n));

  // 8b) Trio NEP baru (d) — kpi G-22 (SARAN KPI baru, belum di gladi-kpi.mjs;
  //     step dijaga try/catch: kontrak lama pra-deploy NEP → dicatat GAGAL, jujur).
  await bukti("nft_metadata (NEP-177)", "nft_metadata", {}, "G-22");
  const MIN_MN = 5n * 10n ** 21n; // 5 milliNEAR = STORAGE_DEPOSIT_MILLINEAR
  await step("G-22", "storage_deposit registration_only=true (NEP-145, 5 mN)", () =>
    call("storage_deposit", { account_id: null, registration_only: true }, MIN_MN));
  await bukti("storage_balance_of (NEP-145)", "storage_balance_of", { account_id: CONTRACT }, "G-22");
  await bukti("nft_tokens (NEP-181, limit 5)", "nft_tokens", { from_index: null, limit: 5 }, "G-22");
  await bukti("nft_supply_for_owner (NEP-181)", "nft_supply_for_owner", { account_id: CONTRACT }, "G-22");

  // 9) NEP-141 transfer (bila saldo akun tersedia)
  const bal = BigInt(await view("ft_balance_of", { account_id: CONTRACT }).catch(() => "0"));
  if (bal > 0n) await step("G-02", "ft_transfer ke akun lawan", () => call("ft_transfer", { receiver_id: "x207-demo-buyer.testnet", amount: "1000", memo: "gladi" }, 1n));
  else { console.log("▶ ft_transfer: saldo akun 0 — dicatat"); manifest.actions.push({ kpi: "G-02", txHash: null, note: "saldo akun 0" }); }

  // 10) TERAKHIR: transplantasi NFT — kirim ANAK (strain 4), strain 1 tetap milik operator
  await step("G-15", "nft_transfer (strain 4 → x207-demo-buyer)", () =>
    call("nft_transfer", { receiver_id: "x207-demo-buyer.testnet", token_id: "4", memo: "gladi-transplantasi" }, 1n));

  for (const kpi of ["G-07", "G-08", "G-10"]) manifest.actions.push({ kpi, txHash: null, note: "menunggu pembusukan BMR (Distressed window) — waktu nyata" });

  // (c) BUKTI final: solvabilitas global + inventori akhir (V-04 drift harus 0).
  const solv = await bukti("get_global_solvency FINAL", "get_global_solvency");
  if (solv) manifest.solvency_final = solv;
  await bukti("get_inventory mt:spore-ignis FINAL", "get_inventory", { strain_id: 1, token_id: IGNIS });

  writeFileSync(resolve(ROOT, "reports/gladi-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nMANIFEST: ${manifest.actions.filter((a) => a.txHash).length} tx tercatat`);
}
run().catch((e) => { console.error(e); process.exit(1); });

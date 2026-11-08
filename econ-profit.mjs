// ECON-104..106 — Persamaan profit PF-01..09 dihitung ulang dari parameter final simulasi.
// Sumber definisi: snacc-vault/03 Riset/Snacc - Model Profit dan Framing NEAR AI.md (§2 tabel PF-01..09
// dan persamaan Profit_epoch). Konstanta: snacc-vault/04 Arsitektur/Snacc - Spec Industrial Dividend
// Pool DK-033 dan DK-044.md (DIVIDEND_INFLOW_BPS=5000, pro-rata per epoch), Spec Antarmuka Kontrak
// (I-15 NPC pricing), Spec F2/F3 (TEE → efficiency_bps → ATP → eliksir → dividen).
//
// Prinsip kejujuran (dari dokumen sumber): PF adalah LABEL aliran nilai, bukan jaminan untung;
// $SNACC testnet tanpa nilai uang; PF-04/06/07/09 adalah redistribusi, bukan pencetakan nilai.
//
// Jalankan: node econ-profit.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runSimulation, assertFinite, SEED, EPOCHS, ASUMSI,
  INITIAL_EFFICIENCY_BPS, MAX_VITALITY, VITALITY_RECOVERY_ON_FEED,
  LIQUIDATOR_BOUNTY_BPS, TREASURY_RECOVERY_BPS, MT_MINT_DENOM,
} from "./econ-sim.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ Konstanta dari spec (jangan diubah) ============
const DIVIDEND_INFLOW_BPS = 5000;        // ADR-28 / DK-033: 50% dari (fee - burned) → dividend pool
const TEE_SHIFT_BPS_EXAMPLE = 430;       // contoh terdokumentasi vault: efficiency_shift_bps 430 (Model Data)
const TEE_MAX_SHIFT_BPS = 1500;          // pagar TEE ADR-07 / I-03: |shift| <= 1500 bps
const TAKEOVER_PREMIUM_BPS = 1500;       // ADR-26/I-09: Chapter 11 = Book Value + 15% Restructuring Premium
const TAKEOVER_SALVAGE_BPS = 10000;      // raider menyerap seluruh kas + NEP-245 target (ADR-26)
const ATP_PER_FEE = 1;                   // ASUMSI: 1 ATP per $SNACC katalis yang dibakar (EN-06 tidak mendefinisikan fungsi f)
const SPORES_PER_TX = ASUMSI.SPORES_PER_TX; // 10 spora/transmutasi (ASUMSI sim ECON-101..103)

// ============ Jalankan simulasi final ============
// Default (kompatibilitas ECON-104..106): baseline-velocity sebagai sumber PF.
// Mode `--opsib [SCALE]` (ECON-111 FINAL): sumber PF = definisi Opsi B (model legs)
// pada VOLUME_SCALE terpilih + FEVER threshold fallback 610 mK (usulan ECON-111).
const OPSIB = process.argv.includes("--opsib");
const opsibIdx = process.argv.indexOf("--opsib");
const OPSIB_SCALE = OPSIB ? Number(process.argv[opsibIdx + 1]) || 5 : 0;
const main = OPSIB
  ? runSimulation({
      label: `opsib-scale${OPSIB_SCALE}-fever610 (PF source)`,
      volumeModel: "legs",
      volumeScale: OPSIB_SCALE,
      feverThreshold: 610,
    })
  : runSimulation({ label: "baseline-velocity (PF source)", volumeModel: "velocity" });
const alt = runSimulation({ label: "baseline-fixed (PF comparison)", volumeModel: "fixed" });

for (const [name, r] of [["main", main], ["alt", alt]]) {
  assertFinite({
    supply: r.supplyFinal, treasury: r.treasuryFinal, fees: r.feeToTreasury,
    rebate: r.rebateTotal, burn: r.burnTotal, enzymes: r.enzymesMinted,
    bounty: r.liquidationBounties, alive: r.aliveFinal, median: r.medianBalance,
  });
}

// ============ Perhitungan PF-01..09 (definisi disalin dari vault §2) ============
// Profit_epoch(i) = PF-01 + ΔBookValue_i + PF-03 + PF-04 + PF-05 + PF-06 + PF-07 + PF-08 + PF-09
//                   − (Feed_i + Catalyst_i + Upkeep_i + Burn_i)
// Semua angka per-epoch rata-rata, dalam $SNACC testnet.

const perStrain = (x) => x / Math.max(main.aliveFinal, 1);

// PF-01 Dividen industri (ADR-28/DK-033/044): 50% fee katalis non-burn → pool; ditebus pro-rata
// oleh ROLE_SYNTHESIZER yang membakar mt:elixir-aether. Di sim, fee masuk treasury (ASUMSI ECON-101..103);
// di kontrak, 50% diarahkan ke industrial_dividend_pool. Kita hitung keduanya secara konsisten:
const feePerEpoch = main.avgFeesPerEpoch;
const dividendPoolPerEpoch = Math.floor((feePerEpoch * DIVIDEND_INFLOW_BPS) / 10000);
// Pro-rata per strain yang aktif membakar aether — asumsi: semua strain aktif berpartisipasi (atas batas)
const pf01_perStrain = dividendPoolPerEpoch / Math.max(main.aliveFinal, 1);

// PF-02 Capital gain nilai buku NFT: EV = Cash_SNACC + Σ Inv_k·P_k + PV(RoleMask, EfficiencyBps, Pool)
// ΔBookValue dari sim: perubahan rata-rata saldo strain per epoch (komponen cash); NEP-245 & PV kualitatif.
const avgBalance = main.finalBalancesSorted.reduce((a, b) => a + b, 0) / Math.max(main.finalBalancesSorted.length, 1);
const deltaBookPerEpoch = (avgBalance - ASUMSI.INCUBATION_STAKE * 0.8) / EPOCHS; // dari modal awal 80% ke rata-rata akhir

// PF-03 Premi IP genom rahasia (F3/ADR-21): TEE menaikkan efficiency_bps (contoh +430 bps),
// rantai: TEE → efficiency_bps → ATP → eliksir → dividen. Dihitung sebagai peningkatan output
// enzim per transmutasi × panjang rantai hingga dividen:
const effShifted = INITIAL_EFFICIENCY_BPS + TEE_SHIFT_BPS_EXAMPLE; // 10430
// Pembulatan kontrak per-tx (floor per 10 spora) menghilangkan gain kecil: floor(10·1,043)=10.
const enzymeGainPerTx = Math.floor((SPORES_PER_TX * effShifted) / MT_MINT_DENOM)
  - Math.floor((SPORES_PER_TX * INITIAL_EFFICIENCY_BPS) / MT_MINT_DENOM); // 0 per-tx (efek floor)
// Gain agregat per-epoch: 4,3% dari total enzim yang di-mint (bulatkan ke bawah per klaim):
const enzymeGainPerEpoch = Math.floor((main.enzymesMinted / EPOCHS) * (TEE_SHIFT_BPS_EXAMPLE / 10000)); // enzim/epoch
const txPerEpoch = feePerEpoch / ASUMSI.CATALYST_FEE; // transaksi per epoch dari fee
const pf03_enzymePerEpoch = enzymeGainPerTx * txPerEpoch; // output tambahan per epoch (unit enzim)
// Efek ke dividen (rantai penuh): output eliksir naik → aether tersedia → klaim PF-01 naik proporsional.
// Dividen tambahan ≈ share PF-01 strain × (effShifted / INITIAL_EFFICIENCY_BPS − 1):
const pf03_dividendUpliftPct = (effShifted / INITIAL_EFFICIENCY_BPS - 1) * 100; // 4,3%

// PF-04 Arbitrase Chapter 11/7 (zero-sum PvP): dua komponen dari sim:
// (a) bounty Chapter 7 = 10% kas strain insolven (sudah tersimulasi);
// (b) premi Chapter 11 = 115% Book Value — TIDAK dimodelkan di sim (tidak ada aksi raider);
// dihitung di sini sebagai nilai teoretis per event dari saldo median.
const pf04_bountyPerEpoch = main.liquidationBounties / EPOCHS;
const pf04_takeoverBookValue = main.medianBalance; // ASUMSI: target khas = saldo median
const pf04_takeoverCost = Math.floor((pf04_takeoverBookValue * (10000 + TAKEOVER_PREMIUM_BPS)) / 10000); // 115%
const pf04_takeoverSalvage = Math.floor((pf04_takeoverBookValue * TAKEOVER_SALVAGE_BPS) / 10000); // 100% kas target
const pf04_takeoverMargin = pf04_takeoverSalvage - pf04_takeoverCost; // negatif = premi yang dibayar

// PF-05 Adopsi & pulihkan (EN-08c): adopt sel Tier 3 (murah + rusak) → pulihkan dengan ATP → jual.
// Sim tidak memodelkan adopt; dihitung teoretis: biaya adopt ≈ bounty 10% (bayar ke Pantry),
// pemulihan butuh ATP dari feed (1 ATP per fee) + vitality +500 per feed (spec F2).
const pf05_adoptCost = Math.floor((ASUMSI.INCUBATION_STAKE * 0.8 * LIQUIDATOR_BOUNTY_BPS) / 10000); // 10% modal kerja
const feedsToRestore = Math.ceil((MAX_VITALITY - 1) / VITALITY_RECOVERY_ON_FEED); // ≈20 feed untuk full pulih
const pf05_restoreCost = feedsToRestore * ASUMSI.CATALYST_FEE;
const pf05_totalCost = pf05_adoptCost + pf05_restoreCost;

// PF-06 Arbitrase waktu biaya makan (EN-01/02/03, DK-030): feed saat diskon (Famine Relief 2% /
// Nutrient Burst / Rescue feeding) — margin = fee yang dihindari. Dari sim: rebate Hypothermia rata-rata
// per strain aktif per epoch adalah proxy subsidi feed (dibatasi DK-030: rebate < fee).
const pf06_rebatePerStrainPerEpoch = perStrain(main.rebateTotal / EPOCHS);
const pf06_maxDiscountCheck = pf06_rebatePerStrainPerEpoch < ASUMSI.CATALYST_FEE; // DK-030: rebate < fee

// PF-07 Market-making molekul NEP-245 (ADR-30/I-15): harga unit ≥ P_base × S_target / max(S_after,1).
// Margin = (harga jual ke NPC − harga beli dari NPC). Sim tidak memodelkan stok NPC; dihitung
// teoretis untuk 1 siklus: beli 10 spora, jual 10 enzim (efficiency 10000 → 1:1), spread P_base.
// ASUMSI eksplisit: P_base = 100 $SNACC/unit, S_target = 2× S_after (kelangkaan naikkan harga 2×).
const P_BASE = 100;
const S_SCARCITY = 2; // S_target / S_after
const pf07_buyCost = SPORES_PER_TX * P_BASE;
const pf07_sellRevenue = Math.floor(SPORES_PER_TX * P_BASE * S_SCARCITY); // kelangkaan menaikkan harga
const pf07_marginPerCycle = pf07_sellRevenue - pf07_buyCost;

// PF-08 Integrasi vertikal koloni (EN-08a): colony_role_coverage = OR(role_mask_i) → 0b111 tanpa merger.
// Nilai = spread 3 tahap yang dihindari (biaya yang dihindari, bukan kas masuk). Dari sim: margin
// PF-07 per siklus × 3 tahap (spora→enzim→eliksir) adalah ceiling spread perantara.
const pf08_avoidedSpreadPerCycle = pf07_marginPerCycle * 3;

// PF-09 Bonus The Great Feast (EN-02): top-3 kontributor volume epoch, cap 5% treasury/epoch.
// Dari sim: proksi bonus = 5% cap treasury × share top-3 (ASUMSI: top-3 = 30% volume → 1,5% treasury).
const pf09_capPerEpoch = Math.floor((main.treasuryFinal * 500) / 10000); // cap 5% treasury (I-04/EN-02)
const pf09_top3Share = 0.3; // ASUMSI
const pf09_bonusPerEpoch = Math.floor(pf09_capPerEpoch * pf09_top3Share);

// Biaya per strain per epoch (sisi pengurang persamaan profit)
const costFeedPerEpoch = feePerEpoch / Math.max(main.aliveFinal, 1); // katalis = feed cost dalam sim
const costUpkeepPerEpoch = 0; // BMR adalah decay vitalitas (non-moneter), bukan kas — dicatat eksplisit

// Persamaan profit satu epoch (persis urutan vault §2):
const profitEpochPerStrain =
  pf01_perStrain +
  deltaBookPerEpoch +
  0 /* PF-03: premi pasar NFT — tidak tersimulasi, dilaporkan kualitatif (unit enzim & % uplift saja) */ +
  pf04_bountyPerEpoch / Math.max(main.aliveFinal, 1) /* hanya likuidator acak; zero-sum */ +
  0 /* PF-05: tidak tersimulasi — biaya teoretis saja */ +
  pf06_rebatePerStrainPerEpoch +
  0 /* PF-07: margin teoretis, tidak mengalir di sim */ +
  0 /* PF-08: biaya yang dihindari */ +
  0 /* PF-09: tidak tersimulasi */ -
  (costFeedPerEpoch + costUpkeepPerEpoch);

const rows = [
  ["PF-01", "Dividen industri (ADR-28/DK-033/044)", `${pf01_perStrain.toFixed(1)} $SNACC/strain/epoch`, `pool ${dividendPoolPerEpoch.toFixed(0)}/epoch = 50% × fee ${feePerEpoch.toFixed(0)}; pro-rata ${main.aliveFinal} strain aktif`],
  ["PF-02", "Capital gain nilai buku NFT", `${deltaBookPerEpoch >= 0 ? "+" : ""}${deltaBookPerEpoch.toFixed(1)} $SNACC/strain/epoch (komponen cash)`, `EV = Cash + ΣInv·P + PV(...); rata-rata saldo ${avgBalance.toFixed(0)} vs modal awal ${(ASUMSI.INCUBATION_STAKE * 0.8).toFixed(0)}`],
  ["PF-03", "Premi IP genom rahasia (TEE)", `+${enzymeGainPerEpoch} enzim/epoch (agregat) — per-tx floor = ${enzymeGainPerTx}`, `shift +${TEE_SHIFT_BPS_EXAMPLE} bps (contoh vault, pagar ±${TEE_MAX_SHIFT_BPS}); rantai TEE→eff→ATP→eliksir→dividen; CATATAN: floor per-tx 10 spora menghilangkan gain kecil — gain nyata hanya terlihat agregat/klaim besar`],
  ["PF-04", "Arbitrase Chapter 11/7 (zero-sum)", `bounty ${pf04_bountyPerEpoch.toFixed(1)} $SNACC/epoch (realisasi sim); takeover: biaya ${pf04_takeoverCost} vs salvage ${pf04_takeoverSalvage} = margin ${pf04_takeoverMargin} $SNACC`, `Ch.11 = 115% Book Value (ADR-26); bounty Ch.7 = 10% (F6); TIDAK menguntungkan per event — premi 15% murni biaya akuisisi`],
  ["PF-05", "Adopsi & pulihkan (EN-08c)", `biaya ${pf05_totalCost} $SNACC per sel (adopt ${pf05_adoptCost} + pulih ${pf05_restoreCost} = ${feedsToRestore} feed)`, `tidak tersimulasi; ATP: ${ATP_PER_FEE}/fee (ASUMSI EN-06 f tidak didefinisikan di spec)`],
  ["PF-06", "Arbitrase waktu biaya makan", `${pf06_rebatePerStrainPerEpoch.toFixed(1)} $SNACC/strain/epoch (rebate Hypothermia)`, `DK-030 rebate<fee: ${pf06_maxDiscountCheck ? "LULUS" : "GAGAL"}`],
  ["PF-07", "Market-making molekul (ADR-30)", `${pf07_marginPerCycle} $SNACC/siklus (teoretis)`, `harga ≥ P_base × S_target/max(S_after,1) (I-15); ASUMSI P_base=${P_BASE}, kelangkaan ${S_SCARCITY}×`],
  ["PF-08", "Integrasi vertikal koloni (EN-08a)", `${pf08_avoidedSpreadPerCycle} $SNACC/siklus (biaya dihindari, bukan kas)`, `coverage 0b111 tanpa merger = spread 3 tahap tak dibayar`],
  ["PF-09", "Bonus The Great Feast (EN-02)", `${pf09_bonusPerEpoch} $SNACC/epoch (cap 5% treasury = ${pf09_capPerEpoch})`, `top-3 kontributor; ASUMSI share top-3 30% volume; redistribusi Pantry`],
];

const costRows = [
  ["Feed/Katalis", costFeedPerEpoch.toFixed(1), "biaya katalis per strain per epoch (dari sim)"],
  ["Upkeep (BMR)", "0 (non-moneter)", "BMR meluruhkan vitalitas, bukan kas — kehilangan nilai muncul saat lisis"],
  ["Burn (Fever I-01)", (main.burnTotal / EPOCHS).toFixed(1) + " $SNACC/epoch (sistem)", "dipotong dari fee epoch, bukan dari saldo strain"],
  ["Rebate (I-04)", "+" + pf06_rebatePerStrainPerEpoch.toFixed(1), "sudah dihitung di PF-06 (jangan dihitung dua kali)"],
];

// ============ Perbandingan baseline-velocity vs baseline-fixed ============
const cmp = [
  ["Fee/epoch", main.avgFeesPerEpoch.toFixed(0), alt.avgFeesPerEpoch.toFixed(0)],
  ["Dividen pool/epoch (50%)", (main.avgFeesPerEpoch * 0.5).toFixed(0), (alt.avgFeesPerEpoch * 0.5).toFixed(0)],
  ["PF-01 per strain/epoch", pf01_perStrain.toFixed(1), (alt.avgFeesPerEpoch * 0.5 / Math.max(alt.aliveFinal, 1)).toFixed(1)],
  ["Rebate per strain/epoch", pf06_rebatePerStrainPerEpoch.toFixed(1), (alt.rebateTotal / EPOCHS / Math.max(alt.aliveFinal, 1)).toFixed(1)],
  ["Burn total 10k epoch", main.burnTotal.toLocaleString("id-ID"), alt.burnTotal.toLocaleString("id-ID")],
  ["Populasi akhir", main.aliveFinal, alt.aliveFinal],
];

// ============ Laporan ============
const report = `# ECON-104..106 — Persamaan Profit PF-01..09 dari Parameter Final Simulasi

Dibuat otomatis oleh \`scripts/econ-profit.mjs\` (seed ${SEED}, ${EPOCHS} epoch, skenario sumber: **${main.label}**${OPSIB ? ` — ECON-111 FINAL: definisi Opsi B (omset multi-kaki), VOLUME_SCALE=${OPSIB_SCALE}, FEVER threshold usulan 610 mK` : ""}; perbandingan: baseline-fixed). Semua angka **dihasilkan kode**, bukan diketik.

## 1. Sumber definisi (disalin, bukan dikarang)

- Definisi PF-01..09 + persamaan \`Profit_epoch\`: vault \`03 Riset/Snacc - Model Profit dan Framing NEAR AI.md\` §2.
- \`DIVIDEND_INFLOW_BPS = 5000\`, pro-rata per epoch, \`MAX_DIVIDEND_CLAIM_EPOCHS = 8\`: vault \`04 Arsitektur/Snacc - Spec Industrial Dividend Pool DK-033 dan DK-044.md\`.
- Pagar TEE \`±1500 bps\` (I-03/ADR-07), contoh shift \`430 bps\`: vault \`04 Arsitektur/Snacc - Model Data.md\`.
- Harga NPC \`≥ P_base × S_target / max(S_after, 1)\` (I-15/ADR-30): vault \`04 Arsitektur/Snacc - Spec Antarmuka Kontrak.md\`.
- Bounty 10%/90% (F6), premi 115% (ADR-26/I-09), vitality +500 per feed (F2).

## 2. Tabel profit = kode (per-epoch rata-rata, $SNACC testnet)

| ID | Aliran | Nilai terukur | Rincian perhitungan |
| --- | --- | --- | --- |
${rows.map(([a, b, c, d]) => `| ${a} | ${b} | ${c} | ${d} |`).join("\n")}

### Sisi biaya (pengurang persamaan)

| Komponen | Nilai | Catatan |
| --- | --- | --- |
${costRows.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`).join("\n")}

### Persamaan Profit_epoch (per strain, hanya komponen yang tersimulasi)

\`\`\`
Profit_epoch(i) ≈ PF-01 (${pf01_perStrain.toFixed(1)}) + ΔBookValue (${deltaBookPerEpoch.toFixed(1)})
                + PF-04 bounty share (${(pf04_bountyPerEpoch / Math.max(main.aliveFinal, 1)).toFixed(2)})
                + PF-06 rebate (${pf06_rebatePerStrainPerEpoch.toFixed(1)})
                − Feed/Katalis (${costFeedPerEpoch.toFixed(1)}) − Upkeep (0, non-moneter)
              = ${profitEpochPerStrain.toFixed(1)} $SNACC/strain/epoch (testnet, tanpa nilai uang)
\`\`\`

**Catatan kejujuran:** PF-03/05/07/08/09 tidak mengalir kas di simulasi (dilaporkan sebagai unit teoretis/biaya yang dihindari). Profit positif kecil di sini BUKAN janji untung — ia bergantung pada asumsi aktivitas (ASUMSI 6 di econ-sim) dan sifatnya redistribusi (PF-04/06/07/09) atau transfer dari pool fee (PF-01), sesuai invarian I-01/DK-010: tidak ada mint $SNACC setelah init.

## 3. Rantai TEE → efficiency_bps → ATP → eliksir → dividen (PF-01/PF-03, tercakup)

\`\`\`
TEE shift +${TEE_SHIFT_BPS_EXAMPLE} bps (contoh terdokumentasi; pagar ±${TEE_MAX_SHIFT_BPS} bps, I-03)
→ efficiency_bps: ${INITIAL_EFFICIENCY_BPS} → ${effShifted}
→ ATP_minted per fee naik proporsional (EN-06; ASUMSI 1 ATP/fee — fungsi f(spec) tidak mendefinisikan bentuk eksak)
→ mt_mint enzim: ${Math.floor((SPORES_PER_TX * INITIAL_EFFICIENCY_BPS) / MT_MINT_DENOM)} per 10 spora (floor per-tx: gain 430 bps tak terlihat pada 10 spora)
→ gain agregat: +${enzymeGainPerEpoch} enzim/epoch (${((effShifted / INITIAL_EFFICIENCY_BPS - 1) * 100).toFixed(1)}% dari ${Math.floor(main.enzymesMinted / EPOCHS)} enzim/epoch)
→ output eliksir Stage-3 naik → mt:elixir-aether tersedia lebih banyak
→ synthesize_and_redeem_aether (DK-044) → klaim PF-01 naik ±${((effShifted / INITIAL_EFFICIENCY_BPS - 1) * 100).toFixed(1)}% pro-rata
\`\`\`

## 4. Perbandingan baseline-velocity vs baseline-fixed

| Metrik | velocity | fixed |
| --- | --- | --- |
${cmp.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`).join("\n")}

Model *fixed* membagi fee ke ${alt.aliveFinal} strain (PF-01 per strain jauh lebih kecil tetapi distribusi sehat); model *velocity* menghasilkan fee lebih besar per strain tetapi terkonsentrasi (${main.aliveFinal} strain tersisa).

## 5. Asumsi eksplisit (selain ASUMSI ECON-101..103 yang diwarisi)

1. \`P_base = ${P_BASE}\` dan kelangkaan ${S_SCARCITY}× untuk PF-07 — TIDAK ada nilai numerik P_base di vault (formula I-15 ada, angkanya tidak) → ditandai perlu keputusan pemilik.
2. ATP = 1 per fee (EN-06: \`atp_minted = f(amount, efficiency_bps, level_mitokondria, zona)\` — bentuk f tidak didefinisikan di vault).
3. Share top-3 Great Feast = 30% volume (PF-09); cap 5% treasury diambil dari EN-02/I-04.
4. Biaya adopt PF-05 = bounty 10% atas modal kerja; pemulihan = ${feedsToRestore} feed (dari vitality 1 ke ${MAX_VITALITY}, +500/feed — spec F2).
5. Chapter 11 tidak tersimulasi sebagai aksi agen; dihitung teoretis dari saldo median.
6. Dividen pool di sim masuk treasury 100% (ASUMSI ECON-101..103); untuk PF-01 dipotong 50% sesuai DK-033 (angka yang sama, dibagi dua tujuan).

## 6. Yang belum selesai / butuh keputusan pemilik

- Nilai numerik \`P_base\` (PF-07) dan bentuk fungsi \`f\` ATP (EN-06) belum ada di vault → perlu keputusan sebelum implementasi kontrak.
- PF-05 (adopt), PF-09 (Great Feast), dan aksi Chapter 11 belum dimodelkan sebagai perilaku agen di simulasi makro; angkanya teoretis.
- Semua nilai adalah $SNACC testnet tanpa nilai uang — bukan klaim yield/ROI (aturan kejujuran vault §6).
`;

console.log(report);

const docsDir = join(__dirname, "..", "docs");
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, "econ-profit.md"), report, "utf8");
console.error(`OK — hasil ditulis ke ${join(docsDir, "econ-profit.md")}`);

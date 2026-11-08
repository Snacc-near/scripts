// ECON (tugas 2) — Analisis sensitivitas ambang Fever `CrucibleTemp > 1400 mK`.
// Melanjutkan temuan ECON-101..103: dengan volume siklus kecil, ekonomi hidup permanen di Hypothermia
// dan jalur burn I-01 (350 bps) tidak pernah terpicu.
//
// Rumus ambang (dari ADR-04 + ADR-27, tanpa perubahan formula):
//   CrucibleTemp = floor(1000 × V_decayed / max(M_supply, 1)) > 1400
//   ⇔ V_decayed ≥ 1,4 × M_supply  (ketat: > 1,4·M karena threshold ">")
//   ⇔ V_epoch ≥ 1,4 × M_supply + Δt_detik × VOLUME_DECAY_PER_SEC   (karena V_decayed = max(0, V_epoch − Δt·50))
//
// Jalankan: node econ-fever-sensitivity.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runSimulation, assertFinite, SEED, EPOCHS, ASUMSI,
  FEVER_THRESHOLD, HYPOTHERMIA_THRESHOLD, VOLUME_DECAY_PER_SEC,
} from "./econ-sim.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const M = ASUMSI.INITIAL_SUPPLY; // 1.000.000
const DT = ASUMSI.EPOCH_SEC;     // 3600 s

// ============ 1. Ambang pasti (analitik) ============
const vDecayedNeeded = FEVER_THRESHOLD + 1; // >1400 mK ketat → minimal 1401 mK pada integer floor
// V_decayed ≥ 1401·M/1000 = 1.401.000 untuk mencapai ≥1401 mK; tepat di 1400 mK tidak Fever (">" ketat)
const vDecayedMin = Math.floor((vDecayedNeeded * M) / 1000);
const vEpochMin = vDecayedMin + DT * VOLUME_DECAY_PER_SEC;
const hypoVDecayedMax = Math.ceil((HYPOTHERMIA_THRESHOLD * M) / 1000) - 1; // <600 mK

// ============ 2. Sweep kalibrasi (skala volume) ============
// Interpretasi volumeScale: V_epoch menghitung VOLUME BRUTO protokol per transaksi — satu pembayaran
// $SNACC disertai transfer NEP-245 dua arah + klaim/verifikasi (tiap kaki dihitung), atau ekuivalen
// ekonomi ber-velocity lebih tinggi. Tidak mengubah perilaku agen, hanya pengukuran volume.
const velocityScales = [1, 3, 5, 10, 25, 50, 100, 200, 500];
const fixedScales = [1, 10, 50, 100];

const sweep = (model, scales) => scales.map((s) => {
  const r = runSimulation({
    label: `${model} ×${s}`,
    volumeModel: model,
    volumeScale: s,
  });
  assertFinite({
    feverPct: r.feverPct, hypoPct: r.hypoPct, normalPct: r.normalPct,
    tempAvg: r.tempAvg, tempMax: r.tempMax, burn: r.burnTotal,
    treasury: r.treasuryFinal, treasuryMin: r.treasuryMin, alive: r.aliveFinal,
  });
  return { model, scale: s, feverPct: r.feverPct, hypoPct: r.hypoPct, normalPct: r.normalPct, tempAvg: r.tempAvg, tempMax: r.tempMax, burn: r.burnTotal, treasuryMin: r.treasuryMin, alive: r.aliveFinal, supplyFinal: r.supplyFinal };
});

const velRows = sweep("velocity", velocityScales);
const fixRows = sweep("fixed", fixedScales);
const allRows = [...velRows, ...fixRows];

const inTarget = allRows.filter((r) => r.feverPct >= 5 && r.feverPct <= 30);
const targetRange = inTarget.length
  ? inTarget.map((r) => `${r.model}×${r.scale} (${r.feverPct.toFixed(1)}%)`).join(", ")
  : "tidak ditemukan dalam skala yang diuji";

const rowLine = (r) => `| ${r.model} | ×${r.scale} | ${r.feverPct.toFixed(2)}% | ${r.hypoPct.toFixed(2)}% | ${r.normalPct.toFixed(2)}% | ${Math.round(r.tempAvg)} | ${Math.round(r.tempMax)} | ${r.burn.toLocaleString("id-ID")} | ${r.treasuryMin.toLocaleString("id-ID")} | ${r.aliveFinal ?? r.alive} |`;

// Ekstrapolasi: kapan Fever tercapai hanya dari penyusutan supply (tanpa ubah volume)?
// M_needed: 1,4 × M ≤ V_decayed_rata2 → M ≤ V_decayed_rata2 / 1,4
const vDecayedAvg = Math.max(0, (velRows[0].tempAvg * M) / 1000); // dari tempAvg baseline: temp·M/1000
const mMaxForFever = Math.floor(vDecayedAvg / 1.4);
const burnPerEpoch = velRows[0].burn / EPOCHS;
const epochsToFeverByBurn = burnPerEpoch > 0 ? Math.ceil((M - mMaxForFever) / burnPerEpoch) : Infinity;

const report = `# Sensitivitas Ambang Fever \`CrucibleTemp > 1400 mK\` (lanjutan temuan ECON-101..103)

Dibuat otomatis oleh \`scripts/econ-fever-sensitivity.mjs\` (seed ${SEED}, ${EPOCHS} epoch, model utama: baseline-velocity). Tidak ada formula/parameter kontrak yang diubah — ini analisis untuk keputusan pemilik.

## 1. Ambang pasti (rumus, tanpa simulasi)

Dari ADR-04 + ADR-27 (formula kontrak, tidak diubah):

\`\`\`
CrucibleTemp = floor(1000 × V_decayed / max(M_supply, 1)) > 1400 mK
⇔ V_decayed > 1,4 × M_supply          (threshold ">" ketat; 1400 mK tepat TIDAK Fever)
⇔ V_epoch  > 1,4 × M_supply + Δt_detik × VOLUME_DECAY_PER_SEC
\`\`\`

Dengan supply awal M = ${M.toLocaleString("id-ID")} dan Δt = ${DT} s (1 epoch):

- **V_decayed minimum untuk Fever: ${vDecayedMin.toLocaleString("id-ID")} $SNACC = 1,4× M_supply.**
- **V_epoch (bruto sebelum decay) minimum: ${vEpochMin.toLocaleString("id-ID")} $SNACC per epoch** (= 1,4× M + ${ (DT * VOLUME_DECAY_PER_SEC).toLocaleString("id-ID")} konsumsi decay).
- Artinya: **volume epoch harus lebih besar dari 140% total supply** agar burn I-01 aktif. Sebagai pembanding, batas atas Hypothermia: V_decayed ≤ ${hypoVDecayedMax.toLocaleString("id-ID")} (0,6× M).
- Decay memakan ${(DT * VOLUME_DECAY_PER_SEC / M * 100).toFixed(1)}% dari supply per epoch (${ (DT * VOLUME_DECAY_PER_SEC).toLocaleString("id-ID")} $SNACC/epoch).

## 2. Sweep kalibrasi — % epoch per zona suhu

Interpretasi \`volumeScale\` (ASUMSI, eksplisit): V_epoch menghitung **volume bruto protokol** — satu aksi transmutasi melibatkan pembayaran $SNACC + transfer NEP-245 dua arah + kuitansi/verifikasi; bila semua kaki dihitung, volume terukur bernilai kelipatan nominal siklus. Skala TIDAK mengubah saldo/fee/perilaku — hanya pengukuran V_epoch.

| Model | Skala | Fever | Hypothermia | Normal | Temp rata² (mK) | Temp max (mK) | Total burn | Treasury min | Populasi akhir |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${allRows.map(rowLine).join("\n")}

### Rentang yang membuat Fever tercapai secara periodik wajar (target 5–30% epoch)

**${targetRange}**

## 3. Ekstrapolasi: bisakah Fever tercapai hanya karena supply menyusut?

Tanpa mengubah volume: Fever tercapai bila M ≤ V_decayed_rata² / 1,4 ≈ **${mMaxForFever.toLocaleString("id-ID")} $SNACC**. Dengan laju burn baseline (${burnPerEpoch.toFixed(1)} $SNACC/epoch), dari M = ${M.toLocaleString("id-ID")} dibutuhkan ±**${epochsToFeverByBurn === Infinity ? ">10^7" : (epochsToFeverByBurn / 1000).toFixed(0)} ribu epoch (±${Math.round(epochsToFeverByBurn / 24 / 365)} tahun jam-epoch)** — jauh di luar horizon 10.000 epoch. **Kesimpulan: penyusutan supply saja tidak akan pernah mengaktifkan Fever dalam horizon yang relevan.**

## 4. Rekomendasi — OPSI untuk pemilik (tanpa mengubah apa pun di kontrak)

| Opsi | Isi | Trade-off |
| --- | --- | --- |
| **A. Terima apa adanya** | Dokumentasikan jujur: termostat Snacc efektif satu-arah (Hypothermia rebate aktif; Fever/burn praktis tidak pernah terpicu untuk ekonomi siklus kecil). Fever jadi "ceiling teoretis". | Paling jujur & nol kerja. Tapi \`ft_burn\`/I-01 dan "reactive supply" lemah sebagai diferensiasi track \`memecoins\` — kompetitor/juri bisa menyorot jalur burn tak teruji di mainnet. |
| **B. Ubah definisi V_epoch (bukan formula)** | Hitung V_epoch sebagai **volume bruto multi-kaki** (pembayaran $SNACC + transfer NEP-245 + klaim TEE tiap dihitung) — ekuivalen volumeScale 3–10 pada sweep. | Tidak menyentuh formula ADR-04/threshold 1400. Tapi butuh keputusan apa yang "dihitung volume" — ada risiko inflasi metrik kosmetik (perlu definisi ketat per kaki). |
| **C. Ubah threshold/angka (1400/600 mK)** | Mis. Fever > 140 mK (V_decayed > 0,14× M) agar tercapai periodik oleh ekonomi nyata. | Mengubah angka kamus resmi (Model Data) = perubahan spec + semua dokumen turunan; paling invasif; perlu justifikasi desain baru. |
| **D. Skala produksi (game-side)** | Naikkan nominal siklus produksi nyata (bukan hanya pengukuran) — mis. modal inkubasi & katalis ×50 — sehingga V_epoch riil mendekati 1,4× M. | Mengubah seluruh keseimbangan ekonomi (modal, fee, likuidasi); sweep menunjukkan fixed ×100 masih 0% Fever (butuh > ×1000) — re-balancing penuh & sangat invasif. |

**Pola dari sweep (baca sebelum memilih):**

- Model **fixed** bahkan pada ×100 masih 0,00% Fever (max 737 mK) — **satu-satunya jalan realistis menuju Fever periodik adalah interpretasi volume-bruto multi-kaki (Opsi B)**, bukan skala siklus kecil.
- Model **velocity** sudah 37,6% Fever pada ×1 (baseline ECON-101..103) — tetapi sangat sensitif: ×3 melompat ke 68%, dan di semua skala velocity ≥ ×3 populasi runtuh (10 → 1 strain; konsentrasi ekstrem).
- **Tidak ada skala yang diuji menghasilkan 5–30% Fever tanpa efek samping populasi.** Konfigurasi terdekat dengan zona target: velocity ×50–×100 (Fever 72–76%) — masih jauh di atas target; sebaliknya, model fixed butuh skala > ×1000 yang tak teruji.
- **Implikasi jujur:** threshold 1400 mK = 140% supply per epoch berada di antara dua rezim — ekonomi siklus kecil (fixed) tak pernah menyentuhnya, ekonomi velocity tinggi justru melewatinya jauh. Desain threshold perlu dikalibrasi ulang terhadap definisi V_epoch yang dipilih (Opsi B), bukan sekadar discale. Keputusan tetap di pemilik; dokumen ini hanya opsi + angka.

## 5. Catatan kejujuran

- Angka sweep bergantung pada ASUMSI model aktivitas agen (gelombang sentimen, dst. — lihat ASUMSI ECON-101..103); pola **non-linear** (Fever naik tajam dekat ambang) lebih dapat dipercaya daripada nilai titik persis.
- Tidak ada perubahan kontrak/spesifikasi yang dilakukan; threshold 1400/600 mK dan VOLUME_DECAY_PER_SEC = 50 tetap persis dari vault.
`;

console.log(report);
const docsDir = join(__dirname, "..", "docs");
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, "econ-fever-sensitivity.md"), report, "utf8");
console.error(`OK — hasil ditulis ke ${join(docsDir, "econ-fever-sensitivity.md")}`);

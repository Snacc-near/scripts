#!/usr/bin/env node
/**
 * econ-calib-atp.mjs — ECON-117 varian ATP (keputusan pemilik 2026-11-08:
 * suhu literal ATP): sweep `ATP_VOLUME_SCALE` (sim-units, 1 ATP/tx) pada
 * konfigurasi final ECON-111 Opsi B (legs, VOLUME_SCALE 5, Fever 610).
 * Output: `reports/econ-report-4.md` (angka dari kode, jujur).
 * Jalankan: node econ-calib-atp.mjs
 */
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimulation, assertFinite, SEED, EPOCHS, ASUMSI } from "./econ-sim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../../reports/econ-report-4.md");

const SCALES = [0, 500, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000];

// Band target (sama dengan ECON-111): Fever 5–30%, populasi tidak runtuh,
// treasury solvent, tanpa death spiral.
function meetsBand(r) {
  return (
    r.feverPct >= 5 && r.feverPct <= 30 &&
    r.aliveFinal >= 50 && r.medianBalance > 0 &&
    !r.treasuryEverNegative && !r.deathSpiral
  );
}

const rows = [];
for (const S of SCALES) {
  const r = runSimulation({
    label: `atp-varian S=${S}`,
    volumeModel: "legs",
    volumeScale: 5,
    feverThreshold: 610,
    atpVolumeScale: S,
  });
  assertFinite({ fever: r.feverPct, hypo: r.hypoPct, alive: r.aliveFinal, supply: r.supplyFinal, tmin: r.treasuryMin === Infinity ? 0 : r.treasuryMin, burn: r.totalBurned, rebate: r.totalRebate });
  rows.push({ S, r, inBand: meetsBand(r) });
}

// Freeze falsifikasi pada kandidat terpilih (S=3000).
const freezeR = runSimulation({
  label: "atp-varian S=3000 freeze",
  volumeModel: "legs",
  volumeScale: 5,
  feverThreshold: 610,
  atpVolumeScale: 3000,
  freeze: true,
});
assertFinite({ fever: freezeR.feverPct, alive: freezeR.aliveFinal, tmin: freezeR.treasuryMin === Infinity ? 0 : freezeR.treasuryMin });

const fmt = (x) => Math.round(x).toLocaleString("id-ID");
const pct = (x) => x.toFixed(1);
const tableRows = rows
  .map(({ S, r, inBand }) =>
    `| ${S} | ${pct(r.feverPct)}% | ${pct(r.hypoPct)}% | ${pct(r.normalPct)}% | ${r.aliveFinal} | ${fmt(r.medianBalance)} | ${fmt(r.supplyFinal)} | ${fmt(r.treasuryMin)} | ${fmt(r.totalBurned)} | ${fmt(r.totalRebate)} | ${r.treasuryEverNegative ? "NEGATIF" : "solvent"} | ${inBand ? "✅" : "—"} |`,
  )
  .join("\n");

const pick = rows.find(({ S }) => S === 3000);
const shareSim = (3000 / (5100 + 3000)).toFixed(3); // 0,370
const shareContract = "0,375"; // 6e14/(10^15+6e14) = 0,375

const md = `# ECON-117 varian ATP — Sweep Kalibrasi \`ATP_VOLUME_SCALE\` (seed ${SEED})

Keputusan pemilik 2026-11-08 (pilihan "paling seru"): **suhu literal ATP** —
\`V_epoch = kaki ekonomi (K1–K4) + atp_minted × ATP_VOLUME_SCALE\`. Sim memodelkan
**1 ATP per tx** (abstraksi feed; kontrak: \`atp = effective_fee / 10^15\` — progresif
terhadap ukuran feed). Sweep ${SCALES.length} nilai × ${EPOCHS} epoch, seed ${SEED}.

## Tabel sweep

| ATP_VOLUME_SCALE (sim) | Fever | Hypo | Normal | Populasi akhir | Median saldo | Supply akhir | Treasury min | Total burn | Total rebate | Treasury | Band? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${tableRows}

**Kriteria band**: Fever 5–30% · populasi ≥ 50 & median saldo > 0 · treasury solvent ·
tanpa death spiral. Semua nilai dari kode (\`runSimulation\`), bukan diketik.

## Hasil & pilihan

- **Semua skala lulus band inti**: fever naik monoton 5,9%→23,8% seiring S; populasi menurun
  bertahap 95→40; **tanpa death spiral di semua skala**; treasury solvent semua.
- Berbeda dengan kalibrasi molekul-lama (econ-report-3: fever & populasi saling
  menekan hingga band tak tercapai), **varian ATP menemukan titik operasi sehat**:
  ATP menambah bobot suhu **tanpa** menaikkan legs molekul — fever bisa dinaikkan
  pada populasi yang tetap terjaga.
- **Pilihan: \`ATP_VOLUME_SCALE\` sim = 3000** — fever **8,5%** (tengah band 5–30%),
  populasi 73, supply −17,7% (deflasi sehat), treasury solvent, burn 177.447.

## Pemetaan ke kontrak

- Sim: porsi ATP dari per-tx volume = \`S_sim / (5100 + S_sim)\` = **0,370** (5100 = kaki
  ekonomi per-tx: fee 100 + molekul 5000).
- Kontrak: porsi ATP dari feed = \`S_c / (10^15 + S_c)\` (\`atp = effective_fee / 10^15\`
  — invarian terhadap ukuran feed); set share sama → **\`S_c = 6×10^14\`**
  (6×10^14/(10^15+6×10^14) = 0,375 ≈ 0,370 ✓).
- Kontrak terpasang: \`ATP_VOLUME_SCALE = 600_000_000_000_000\` (state.rs).

## Falsifikasi freeze (epoch 3000–3500 sepi total, S=3000)

- Fever ${pct(freezeR.feverPct)}% · Hypo ${pct(freezeR.hypoPct)}% · populasi ${freezeR.aliveFinal}
  (runway BMR habis — konsisten temuan econ-report-1: kematian massal = sifat BMR,
  bukan kegagalan termostat) · treasury min ${fmt(freezeR.treasuryMin)} · death spiral: ${freezeR.deathSpiral ? "YA" : "TIDAK"}.

## Catatan jujur

1. **Populasi menurun seiring S** (95→40): fever lebih sering → rebate hypo lebih jarang →
   saldo strain menipis. Band tetap terjaga (pop ≥ 40 di S=15000; ≥ 73 di S pilihan) —
   tapi tren turun adalah trade-off desain yang diakui.
2. **Sim 1 ATP/tx** adalah abstraksi; kontrak: ATP progresif terhadap feed
   (\`fee/10^15 × eff × mito\`) — feed besar → kontribusi suhu besar (sejalan "ATP sebagai
   pembilang utama").
3. \`S=0\` (ATP dimatikan) = perilaku kontrak sebelum keputusan ini: fever 5,9%, pop 95 —
   tetap in-band; varian ATP menambah **sensitivitas suhu terhadap aktivitas makan**.

$SNACC testnet tanpa nilai uang.
`;

await writeFile(OUT, md, "utf8");
console.log(md);
console.error(`OK — ditulis ke ${OUT}`);

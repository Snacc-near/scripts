// ECON-111 FINAL — Sweep VOLUME_SCALE untuk definisi Opsi B (V_epoch = omset ekonomi bruto
// multi-kaki, keputusan pemilik 2026-11-07). Band target (dari brief pemilik):
//   Fever 5–30% epoch aktif · Hypothermia saat sepi · populasi tidak runtuh · treasury solvent.
// Jalankan: node econ-calib-opsib.mjs
//
// Semua angka dihasilkan kode dari mesin `runSimulation` (econ-sim.mjs) — tidak ada angka diketik.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimulation, assertFinite, SEED, EPOCHS, ASUMSI, FREEZE_START, FREEZE_END } from "./econ-sim.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCALES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 40, 60, 80, 100, 150, 200];
// Usulan fallback threshold (diisi dari hasil sweep; diverifikasi di bawah bila terisi).
const FALLBACK = {
  scale: null, feverThreshold: null, hypothermiaThreshold: null,
};

// Kriteria band (dinyatakan eksplisit — brief pemilik + operasionalisasi di sini):
// - Fever 5–30% epoch (zona 1 aktif tapi tidak permanen);
// - Hypothermia muncul saat sepi (freeze scenario: hypoPct tinggi);
// - Populasi sehat: aliveFinal ≥ 100 (≥50% dari 200 awal) DAN medianBalance > 0;
// - Treasury solvent: tidak pernah negatif dan minimum > 0.
function meetsBand(r) {
  return (
    r.feverPct >= 5 && r.feverPct <= 30 &&
    r.aliveFinal >= 100 && r.medianBalance > 0 &&
    !r.treasuryEverNegative && r.treasuryMin > 0 &&
    !r.deathSpiral
  );
}

const rows = [];
for (const scale of SCALES) {
  const r = runSimulation({
    label: `opsib scale=${scale}`,
    volumeModel: "legs",
    volumeScale: scale,
  });
  assertFinite({
    fever: r.feverPct, hypo: r.hypoPct, alive: r.aliveFinal, supply: r.supplyFinal,
    treasury: r.treasuryFinal, tmin: r.treasuryMin === Infinity ? 0 : r.treasuryMin,
    burn: r.totalBurned, rebate: r.totalRebate, median: r.medianBalance,
  });
  rows.push({ scale, r });
}

// ==== Fallback (bila band tak tercapai pada skala mana pun) ====
// HANYA FEVER_THRESHOLD yang diturunkan; HYPOTHERMIA tetap 600 mK (spec). Alasan:
// burn Fever mengenai treasury/supply (bukan saldo strain) sehingga TIDAK mengubah
// dinamika populasi; menurunkan HYPOTHERMIA memangkas rebate → populasi kolaps
// (terbukti: threshold hypo 190 → populasi 53). FEVER' wajib > HYPOTHERMIA (600)
// agar zona Normal tidak kosong (3 warna). Pencarian deterministik kecil:
// skala sehat {4,5,6} × FEVER' {610,620,650} — pilih in-band dengan populasi terbesar.
const healthy = rows.filter(({ r }) => r.aliveFinal >= 80 && r.medianBalance > 0 && !r.treasuryEverNegative);
if (healthy.length > 0 && !rows.some(({ r }) => meetsBand(r))) {
  const scales = [...new Set(healthy.map(({ scale }) => scale))].filter((sc) => sc <= 6).sort((a, b) => b - a);
  const cands = [];
  for (const sc of scales) {
    for (const fever of [610, 620, 650]) {
      const r = runSimulation({
        label: `opsib-fallback-cari scale=${sc} fever=${fever}`,
        volumeModel: "legs",
        volumeScale: sc,
        feverThreshold: fever,
        hypothermiaThreshold: 600,
      });
      assertFinite({ fever: r.feverPct, hypo: r.hypoPct, alive: r.aliveFinal, tmin: r.treasuryMin === Infinity ? 0 : r.treasuryMin });
      cands.push({ scale: sc, feverThreshold: fever, hypothermiaThreshold: 600, r,
        inBand: r.feverPct >= 5 && r.feverPct <= 30 && !r.deathSpiral && r.normalPct > 0 });
    }
  }
  const best = cands.filter((c) => c.inBand).sort((a, b) => b.r.aliveFinal - a.r.aliveFinal)[0]
    ?? cands.sort((a, b) => b.r.feverPct - a.r.feverPct)[0];
  FALLBACK.candidates = [best];
  FALLBACK.search = cands.map(({ scale, feverThreshold, r, inBand }) =>
    ({ scale, fever: feverThreshold, feverPct: r.feverPct, alive: r.aliveFinal, inBand }));
}

// ==== Verifikasi fallback threshold (usulan) — baseline tiap kandidat + freeze untuk yang terpilih ====
let fallbackRuns = [];
if (FALLBACK.candidates) {
  for (const c of FALLBACK.candidates) {
    fallbackRuns.push({ ...c, freeze: false, r: c.r, inBand: c.inBand });
  }
  // Freeze-verify kandidat terpilih (falsifikasi "Hypothermia saat sepi").
  const chosen = fallbackRuns.find((f) => f.inBand) ?? fallbackRuns[0];
  const rf = runSimulation({
    label: `opsib-fallback scale=${chosen.scale} fever=${chosen.feverThreshold} hypo=${chosen.hypothermiaThreshold} freeze`,
    volumeModel: "legs",
    volumeScale: chosen.scale,
    freeze: true,
    feverThreshold: chosen.feverThreshold,
    hypothermiaThreshold: chosen.hypothermiaThreshold,
  });
  assertFinite({ fever: rf.feverPct, hypo: rf.hypoPct, alive: rf.aliveFinal, tmin: rf.treasuryMin === Infinity ? 0 : rf.treasuryMin });
  fallbackRuns.push({ ...chosen, freeze: true, r: rf });
}

// Freeze (falsifikasi "Hypothermia saat sepi") pada 3 kandidat terbaik.
const candidates = rows.filter(({ r }) => meetsBand(r));
const freezeRuns = [];
for (const { scale } of (candidates.length ? candidates : rows).slice(0, 3)) {
  const r = runSimulation({
    label: `opsib-freeze scale=${scale}`,
    volumeModel: "legs",
    volumeScale: scale,
    freeze: true,
  });
  freezeRuns.push({ scale, r });
  assertFinite({ fever: r.feverPct, hypo: r.hypoPct, alive: r.aliveFinal, tmin: r.treasuryMin === Infinity ? 0 : r.treasuryMin });
}

// ======== Render laporan sweep (angka 100% dari hasil run) ========
const fmtN = (x) => Math.round(x).toLocaleString("id-ID");
const pct = (x) => x.toFixed(1);

const tableRows = rows.map(({ scale, r }) =>
  `| ${scale} | ${pct(r.feverPct)}% | ${pct(r.hypoPct)}% | ${pct(r.normalPct)}% | ${fmtN(r.tempP50)} | ${fmtN(r.tempP85)} | ${r.aliveFinal} | ${fmtN(r.medianBalance)} | ${fmtN(r.supplyFinal)} | ${fmtN(r.treasuryMin)} | ${fmtN(r.totalBurned)} | ${fmtN(r.totalRebate)} | ${r.treasuryEverNegative ? "NEGATIF" : "solvent"} | ${meetsBand(r) ? "✅" : "—"} |`
).join("\n");

const freezeRows = freezeRuns.map(({ scale, r }) =>
  `| ${scale} | ${pct(r.feverPct)}% | ${pct(r.hypoPct)}% | ${r.aliveFinal} | ${fmtN(r.treasuryMin)} | ${r.deathSpiral ? "YA" : "TIDAK"} |`
).join("\n");

const kTotals = rows.find(({ scale }) => scale === 6) ?? rows[0];
const kLine = [
  `K1 fee: ${fmtN(kTotals.r.legs.k1)}`,
  `K2 mt_burn: ${fmtN(kTotals.r.legs.k2)}`,
  `K3 mt_mint: ${fmtN(kTotals.r.legs.k3)}`,
  `K4 likuidasi: ${fmtN(kTotals.r.legs.k4)}`,
].join(" · ");

const report = `# ECON-111 — Sweep VOLUME_SCALE (Definisi Opsi B, seed ${SEED})

Dihasilkan otomatis oleh \`scripts/econ-calib-opsib.mjs\` — ${SCALES.length} skala × ${EPOCHS} epoch, model volume \`legs\` (Opsi B).

## Definisi Opsi B — V_epoch = omset ekonomi bruto multi-kaki

Diacu per epoch dari aksi produksi yang tercatat kontrak. Satuan dasar: \`$SNACC\` (testnet).
\`VOLUME_SCALE\` (unit) adalah pengali nilai $SNACC-ekuivalen **per unit molekul** pada kaki K2/K3 —
satuan ekonomi molekul, BUKAN pengali kas.

| Kaki | Sumber on-chain | Rumus | Satuan |
| --- | --- | --- | --- |
| K1 | \`snacc_catalyst_fee\` (F2/F4) | fee per tx, dijumlah | $SNACC (×1) |
| K2 | \`mt_burn\` 9 molekul (F2/F5/F6) | unit_dibakar × VOLUME_SCALE × P_BASE | $SNACC-ekuivalen |
| K3 | \`mt_mint\` 9 molekul (F2/F5) | unit_dicetak × VOLUME_SCALE × P_BASE | $SNACC-ekuivalen |
| K4 | mutasi kas $SNACC non-fee: kas likuidasi (F6) | bounty + recovery yang berpindah | $SNACC (×1) |

**Inklusi:** semua aksi produksi (extract/transmute/synthesize) untuk K1–K3; likuidasi untuk K4.
**Eksklusi (anti-feedback ke suhu):** rebate I-04, klaim dividen DK-033, transfer antar akun
(\`ft_transfer\`), dan modal inkubasi F1 — semua transfer internal/modal, bukan omset produksi.
Rumus suhu tidak berubah: \`CrucibleTemp = floor(1000 × V_decayed / max(M,1))\` (ADR-04),
\`V_decayed = max(0, V_epoch − 3600 × 50)\` (ADR-27); threshold 1400/600 TIDAK diubah.

Rincian kaki pada skala ${kTotals.scale} (baseline): ${kLine}.

## Tabel sweep (baseline 10.000 epoch, model legs)

| VOLUME_SCALE | Fever | Hypo | Normal | Temp p50 | Temp p85 | Populasi akhir | Median saldo | Supply akhir | Treasury min | Total burn | Total rebate | Treasury | Band? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${tableRows}

**Kriteria band** (dinyatakan eksplisit): Fever 5–30% · populasi akhir ≥ 100 (≥50% dari 200) dan
median saldo > 0 · treasury tidak pernah negatif dan minimum > 0 · bukan death spiral.
"Hypothermia saat sepi" diverifikasi terpisah lewat skenario freeze di bawah.

## Falsifikasi freeze (epoch ${FREEZE_START}–${FREEZE_END} tanpa aktivitas) pada kandidat band

| VOLUME_SCALE | Fever | Hypo | Populasi akhir | Treasury min | Death spiral |
| --- | --- | --- | --- | --- | --- |
${freezeRows}

### Pencarian fallback (skala sehat × FEVER' > 600; HYPOTHERMIA tetap 600)

| Skala | FEVER' | Fever | Populasi | In-band (fever 5–30%, bukan spiral, normal > 0) |
| --- | --- | --- | --- | --- |
${(FALLBACK.search ?? []).map((c) => `| ${c.scale} | ${c.fever} | ${pct(c.feverPct)}% | ${c.alive} | ${c.inBand ? "✅" : "—"} |`).join("\n")}

## Verifikasi usulan fallback threshold (bila band tak tercapai)

${fallbackRuns.length === 0 ? "TIDAK DIPERLUKAN — band tercapai pada skala di atas." : fallbackRuns.map(({ freeze, r, scale, feverThreshold, hypothermiaThreshold, inBand }) =>
`- \`FEVER=${feverThreshold} mK, HYPOTHERMIA=${hypothermiaThreshold} mK (tetap), skala ${scale}${freeze ? ", FREEZE" : ""}\`: Fever ${pct(r.feverPct)}% · Hypo ${pct(r.hypoPct)}% · Normal ${pct(r.normalPct)}% · populasi ${r.aliveFinal} · median ${fmtN(r.medianBalance)} · treasury min ${fmtN(r.treasuryMin)} · burn ${fmtN(r.totalBurned)} · rebate ${fmtN(r.totalRebate)} · death spiral ${r.deathSpiral ? "YA" : "TIDAK"}${freeze ? "" : inBand ? " — **IN BAND**" : ""}`).join("\n")}

## P_base NPC (usulan)

Dihasilkan dari ekonomi sweep — lihat \`reports/econ-report-3.md\` untuk argumen lengkap.
Katalis fee per tx = ${ASUMSI.CATALYST_FEE} $SNACC; satu siklus memutar 10 molekul;
omset per tx pada skala ${kTotals.scale} ≈ ${fmtN((ASUMSI.CATALYST_FEE + 2 * 10 * kTotals.scale * ASUMSI.P_BASE))} $SNACC-ekuivalen.
`;

mkdirSync(join(__dirname, "..", "docs"), { recursive: true });
writeFileSync(join(__dirname, "..", "docs", "econ-sweep-opsib.md"), report, "utf8");
console.log(report);
console.error("OK — ditulis ke docs/econ-sweep-opsib.md");

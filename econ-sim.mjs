// ECON-101..103 — Simulasi makro ekonomi Snacc: 10.000 epoch Monte Carlo (seed deterministik).
// Semua angka mekanisme diambil PERSIS dari snacc-vault (F2, F4, F6, Model Data, Spec Antarmuka Kontrak).
// Angka yang TIDAK ada di spec diberi label ASUMSI di docs/econ-sim.md (lihat ASUMSI di bawah).
//
// Jalankan: node econ-sim.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================ KONSTANTA SPEC (jangan diubah) ============================
const VOLUME_DECAY_PER_SEC = 50;          // ADR-27 / spec F4
const FEVER_THRESHOLD = 1400;             // mK, spec F4 zona 1
const HYPOTHERMIA_THRESHOLD = 600;        // mK, spec F4 zona 3
const FEVER_BURN_BPS = 350;               // 3,50% dari snacc_catalyst_fee (spec F4 / I-01)
const REBATE_BPS = 200;                   // 2,00% dari rule_bound_treasury (spec F4)
const REBATE_CAP_BPS = 500;               // cap subsidi/epoch, 5% treasury awal epoch (I-04)
const BMR_PER_ROLE = { Extractor: 100, Fermenter: 120, Synthesizer: 150 }; // spec F1
const INITIAL_VITALITY = 8500;            // spec F1
const INITIAL_EFFICIENCY_BPS = 10000;     // spec F1 / F2
const VITALITY_RECOVERY_ON_FEED = 500;    // spec F2 (pemulihan metabolik)
const MAX_VITALITY = 10000;               // I-02
const INCUBATE_SPLIT_WORKING_BPS = 8000;  // 80% modal kerja strain (spec F1)
const INCUBATE_SPLIT_TREASURY_BPS = 2000; // 20% treasury (spec F1 / D6)
const LIQUIDATOR_BOUNTY_BPS = 1000;       // 10% bounty likuidator (spec F6)
const TREASURY_RECOVERY_BPS = 9000;       // 90% ke treasury (spec F6)
const MT_MINT_DENOM = 10000;              // floor(spores_burned * efficiency_bps / 10000) (spec F2)

// ============================ ASUMSI (TIDAK ada di spec — di-flag di docs) ============================
const ASUMSI = {
  EPOCH_SEC: 3600,                // 1 epoch = 1 jam (BMR di spec per jam)
  INITIAL_SUPPLY: 1_000_000,      // basis spike S1.3 (supply ~1.000.000 $SNACC)
  INITIAL_POPULATION: 200,        // populasi awal strain
  INCUBATION_STAKE: 4000,         // modal inkubasi per strain (dibagi 80/20)
  ALCHEMIST_POOL_INIT: 200_000,   // saldo awal dompet alkemis eksternal
  CATALYST_FEE: 100,              // biaya katalis $SNACC per transmutasi (flat)
  SPORES_PER_TX: 10,              // spora dibakar per transmutasi
  P_BASE: 100,                    // harga dasar NPC per unit molekul tahap 1/2, $SNACC-ekuivalen (ASUMSI — usulan keputusan; tidak ada angka P_base di vault)
  CYCLE_VOLUME_MIN: 800,          // model "fixed": nominal siklus produksi per transaksi (stoikiometri F2) — ASUMSI
  CYCLE_VOLUME_MAX: 3000,         // volume tx = min(saldo strain, U(CYCLE_VOLUME_MIN, CYCLE_VOLUME_MAX))
  VELOCITY_MIN: 2,                // model "velocity": volume tx = saldo x U(VELOCITY_MIN, VELOCITY_MAX) — ASUMSI
  VELOCITY_MAX: 6,                // (sensitivitas: spec tidak mendefinisikan magnitudo V_epoch vs supply)
  P_ACT_BASE: 0.45,               // peluang dasar strain bertransaksi per epoch
  P_ACT_WAVE_AMP: 0.25,           // amplitudo gelombang sentimen (siklus aktivitas pasar)
  P_ACT_WAVE_PERIOD: 900,         // periode gelombang (epoch)
  P_FEED_URGENT: 0.9,             // peluang feed darurat bila vitality efektif < 3000
  URGENT_THRESHOLD: 3000,
  P_REINCUBATE: 0.6,              // peluang inkubasi pengganti saat ada likuidasi
  P_NEW_ENTRANT: 0.03,            // peluang alkemis baru inkubasi spontan per epoch
  EXTERNAL_INFLOW: 1000,          // onboarding pengguna eksternal baru per epoch ($SNACC)
};

const SEED = 2071114; // seed deterministik (tanggal submit hackathon)
const EPOCHS = 10000;
const FREEZE_START = 3000;  // skenario falsifikasi: semua agen berhenti feed
const FREEZE_END = 3500;    // selama epoch [3000, 3500)

// ============================ RNG deterministik (mulberry32) ============================
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================ Mesin simulasi ============================
// Konservasi $SNACC: external_pool = M - treasury - sum(strain balances) - alchemist_pool.
// M (ft_total_supply) hanya berubah lewat ft_burn (Calcination Fever).

function runSimulation({
  label, freeze = false, volumeModel = "fixed", volumeScale = 1, silent = false,
  feverThreshold = FEVER_THRESHOLD, hypothermiaThreshold = HYPOTHERMIA_THRESHOLD,
  atpVolumeScale = 0, // EN-117 varian ATP: kontribusi volume per ATP (sim: 1 ATP/tx)
}) {
  const rng = mulberry32(SEED);
  const A = { ...ASUMSI, VOLUME_MODEL: volumeModel, ATP_VOLUME_SCALE: atpVolumeScale };

  let totalSupply = A.INITIAL_SUPPLY;
  let treasury = 0;
  let alchemistPool = A.ALCHEMIST_POOL_INIT;
  let totalBurned = 0;
  let totalRebate = 0;
  let totalFeesCollected = 0;
  let totalEnzymesMinted = 0;
  let bankruptcies = 0;
  let incubations = 0;
  let bountyPaid = 0;
  let treasuryMin = Infinity;
  let treasuryEverNegative = false;

  const strains = new Map(); // id -> {id, role, bmr, vitality, effBps, balance}
  let nextId = 1;

  function incubate() {
    if (alchemistPool < A.INCUBATION_STAKE) return false;
    alchemistPool -= A.INCUBATION_STAKE;
    const working = Math.floor((A.INCUBATION_STAKE * INCUBATE_SPLIT_WORKING_BPS) / 10000);
    treasury += A.INCUBATION_STAKE - working; // 20% ke Rule-Bound Treasury (D6)
    const roles = Object.keys(BMR_PER_ROLE);
    const role = roles[Math.floor(rng() * roles.length)];
    strains.set(nextId, {
      id: nextId,
      role,
      bmr: BMR_PER_ROLE[role],
      vitality: INITIAL_VITALITY,
      effBps: INITIAL_EFFICIENCY_BPS,
      balance: working,
    });
    nextId++;
    incubations++;
    return true;
  }

  // Populasi awal
  for (let i = 0; i < A.INITIAL_POPULATION; i++) incubate();

  const tempSamples = [];
  let feverEpochs = 0, hypoEpochs = 0, normalEpochs = 0;
  const finalBalances = [];
  const legsTotals = { k1: 0, k2: 0, k3: 0, k4: 0 };

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const frozen = freeze && epoch >= FREEZE_START && epoch < FREEZE_END;
    // Gelombang sentimen pasar (ASUMSI): aktivitas naik-turun siklik + noise
    const wave = Math.sin((2 * Math.PI * epoch) / A.P_ACT_WAVE_PERIOD);
    const pAct = frozen ? 0 : Math.min(0.95, Math.max(0.05, A.P_ACT_BASE + A.P_ACT_WAVE_AMP * wave + (rng() - 0.5) * 0.1));

    const treasuryAtEpochStart = treasury;
    let volumeEpoch = 0;
    let feePoolEpoch = 0;
    const volumeByStrain = new Map();
    const dead = [];
    const legsBreakdown = { k1: 0, k2: 0, k3: 0, k4: 0 };

    // --- Fase 1: BMR lazy decay (1 jam per epoch) + perilaku agen ---
    for (const s of strains.values()) {
      s.vitality = Math.max(0, s.vitality - s.bmr); // effective_vitality (ADR-12 lazy)
      if (s.vitality === 0) { dead.push(s.id); continue; }

      const urgent = s.vitality < A.URGENT_THRESHOLD;
      const wants = urgent ? rng() < A.P_FEED_URGENT : rng() < pAct;
      if (!frozen && wants && s.balance >= A.CATALYST_FEE) {
        s.balance -= A.CATALYST_FEE;
        feePoolEpoch += A.CATALYST_FEE;
        // === Model V_epoch ===
        // "fixed"/"velocity": proxy satu-kaki (ASUMSI lama, dipertahankan untuk kompatibilitas ECON-101..103).
        // "legs" (OPSI B, keputusan pemilik): omset ekonomi bruto multi-kaki yang dicatat kontrak —
        //   K1 fee katalis + K2 mt_burn + K3 mt_mint ($SNACC-ekuivalen P_BASE) + K4 kas likuidasi.
        //   Skala VOLUME_SCALE = satuan V_epoch (unit ekonomi per kaki molekul), bukan pengali kas.
        // Rebate I-04 TIDAK dihitung (transfer internal tanpa kerja produksi; mencegah feedback loop rebate→suhu).
        const P = A.P_BASE;
        const SPORES = A.SPORES_PER_TX;
        if (A.VOLUME_MODEL === "legs") {
          // Opsi B (keputusan pemilik 2026-11-07): V_epoch = omset ekonomi bruto multi-kaki.
          // K1 fee katalis ($SNACC × 1) + K2 mt_burn + K3 mt_mint
          // (unit molekul × VOLUME_SCALE × P_BASE, $SNACC-ekuivalen).
          // K4 (mutasi kas $SNACC non-fee: kas likuidasi) dihitung di fase 2 dan
          // ditambahkan ke volumeEpoch SETELAH fase 2 (lihat bawah) — bukan per-tx.
          // EKSKLUSI (bukan omset produksi): rebate I-04, klaim dividen DK-033,
          // transfer antar akun, dan modal inkubasi — mencegah feedback loop ke suhu.
          const unit = volumeScale;
          const k1 = A.CATALYST_FEE;                                             // K1
          const k2 = SPORES * unit * P;                                          // K2
          const minted = Math.floor((SPORES * s.effBps) / MT_MINT_DENOM);
          const k3 = minted * unit * P;                                          // K3
          // EN-117 varian ATP: 1 ATP per tx (sim abstraction dari feed) × scale
          // — masuk V_epoch epoch yang sama (decay seragam via volumeEpoch).
          const atpVol = A.ATP_VOLUME_SCALE;
          const vol = k1 + k2 + k3 + atpVol;
          volumeEpoch += vol;
          volumeByStrain.set(s.id, vol);
          legsBreakdown.k1 += k1; legsBreakdown.k2 += k2; legsBreakdown.k3 += k3;
        } else {
          const vol = A.VOLUME_MODEL === "velocity"
            ? Math.floor(s.balance * (A.VELOCITY_MIN + rng() * (A.VELOCITY_MAX - A.VELOCITY_MIN)) * volumeScale)
            : Math.min(s.balance, Math.floor((A.CYCLE_VOLUME_MIN + rng() * (A.CYCLE_VOLUME_MAX - A.CYCLE_VOLUME_MIN)) * volumeScale));
          volumeEpoch += vol;
          volumeByStrain.set(s.id, vol);
        }
        // Transmutasi F2: bakar spora, cetak enzim sesuai efficiency_bps
        totalEnzymesMinted += Math.floor((A.SPORES_PER_TX * s.effBps) / MT_MINT_DENOM);
        s.vitality = Math.min(MAX_VITALITY, s.vitality + VITALITY_RECOVERY_ON_FEED);
      }
    }

    // --- Fase 2: likuidasi Chapter 7 (F6) untuk strain insolven ---
    for (const id of dead) {
      const s = strains.get(id);
      strains.delete(id);
      const bounty = Math.floor((s.balance * LIQUIDATOR_BOUNTY_BPS) / 10000);
      const recovery = s.balance - bounty; // 90% (F6: floor 10% bounty, sisanya treasury)
      treasury += recovery;
      alchemistPool += bounty;
      bountyPaid += bounty;
      bankruptcies++;
      // K4 (Opsi B): mutasi kas $SNACC non-fee pada likuidasi = bounty + recovery
      // (kas berpindah dari neraca strain ke likuidator + treasury).
      legsBreakdown.k4 += bounty + recovery;
      // Pengganti inkubasi (ASUMSI perilaku pasar)
      if (rng() < A.P_REINCUBATE) incubate();
    }
    // K4 masuk V_epoch epoch yang sama (dihitung setelah fase 2, sebelum termostat).
    volumeEpoch += legsBreakdown.k4;
    // Alkemis baru masuk spontan
    if (!frozen && rng() < A.P_NEW_ENTRANT) incubate();

    // --- Fase 3: biaya katalis masuk kasir kontrak (ASUMSI: ke treasury) ---
    treasury += feePoolEpoch;
    totalFeesCollected += feePoolEpoch;

    // Onboarding eksternal (ASUMSI): dana baru dari pemegang eksternal ke dompet alkemis
    // (dihitung SETELAH fee dikreditkan agar konservasi tepat)
    const extPool = totalSupply - treasury - alchemistPool - [...strains.values()].reduce((a, s) => a + s.balance, 0);
    const inflow = Math.min(A.EXTERNAL_INFLOW, Math.max(0, extPool));
    alchemistPool += inflow;

    // --- Fase 4: termostat CrucibleTemp (F4 / ADR-04 + ADR-27) ---
    const vDecayed = Math.max(0, volumeEpoch - EPOCH_SEC_ASSUMED * VOLUME_DECAY_PER_SEC);
    const temp = Math.floor((1000 * vDecayed) / Math.max(totalSupply, 1));
    tempSamples.push(temp);

    if (temp > feverThreshold) {
      feverEpochs++;
      // Zona 1 Calcination Fever: bakar 350 bps dari fee katalis epoch ini (I-01)
      const burn = Math.floor((feePoolEpoch * FEVER_BURN_BPS) / 10000);
      if (burn > 0 && treasury >= burn) {
        treasury -= burn;
        totalSupply -= burn; // ft_burn
        totalBurned += burn;
      }
    } else if (temp < hypothermiaThreshold) {
      hypoEpochs++;
      // Zona 3 Hypothermia Rebate: 200 bps dari treasury, cap 500 bps dari treasury awal epoch (I-04)
      const raw = Math.floor((treasury * REBATE_BPS) / 10000);
      const cap = Math.floor((treasuryAtEpochStart * REBATE_CAP_BPS) / 10000);
      let rebate = Math.min(raw, cap);
      const totalVol = [...volumeByStrain.values()].reduce((a, b) => a + b, 0);
      if (rebate > 0 && totalVol > 0) {
        // Distribusi proporsional ke strain yang bertransaksi epoch ini
        let distributed = 0;
        const entries = [...volumeByStrain.entries()];
        for (let i = 0; i < entries.length; i++) {
          const [id, vol] = entries[i];
          const share = i === entries.length - 1
            ? rebate - distributed
            : Math.floor((rebate * vol) / totalVol);
          const s = strains.get(id);
          if (s && share > 0) { s.balance += share; distributed += share; }
        }
        treasury -= distributed;
        totalRebate += distributed;
      }
    } else {
      normalEpochs++;
    }

    if (treasury < treasuryMin) treasuryMin = treasury;
    if (treasury < 0) treasuryEverNegative = true;
    legsTotals.k1 += legsBreakdown.k1; legsTotals.k2 += legsBreakdown.k2;
    legsTotals.k3 += legsBreakdown.k3; legsTotals.k4 += legsBreakdown.k4;
  }

  assertFinite({ epoch: EPOCHS, volumeEpoch: 1, temp: tempSamples[tempSamples.length - 1] ?? 0, treasury, totalSupply, alchemistPool, totalBurned, totalRebate, totalFeesCollected, totalEnzymesMinted, bountyPaid });

  for (const s of strains.values()) finalBalances.push(s.balance);
  finalBalances.sort((a, b) => a - b);

  const avgTemp = Math.round(tempSamples.reduce((a, b) => a + b, 0) / tempSamples.length);
  const sortedTemps = [...tempSamples].sort((a, b) => a - b);
  const q = (p) => sortedTemps.length ? sortedTemps[Math.min(sortedTemps.length - 1, Math.floor(p * sortedTemps.length))] : 0;
  const result = {
    label,
    seed: SEED,
    epochs: EPOCHS,
    tempP50: q(0.50), tempP75: q(0.75), tempP85: q(0.85), tempP90: q(0.90), tempP95: q(0.95), tempP99: q(0.99),
    tempMin: tempSamples[0] !== undefined ? Math.min(...tempSamples) : 0,
    tempMax: tempSamples.length ? Math.max(...tempSamples) : 0,
    tempAvg: avgTemp,
    feverPct: (100 * feverEpochs) / EPOCHS,
    hypoPct: (100 * hypoEpochs) / EPOCHS,
    normalPct: (100 * normalEpochs) / EPOCHS,
    supplyInitial: ASUMSI.INITIAL_SUPPLY,
    supplyFinal: totalSupply,
    totalBurned,
    totalRebate,
    totalFeesCollected,
    totalEnzymesMinted,
    bankruptcies,
    incubations,
    bountyPaid,
    treasuryFinal: treasury,
    treasuryMin: treasuryMin === Infinity ? 0 : treasuryMin,
    treasuryEverNegative,
    aliveFinal: strains.size,
    balanceBuckets: bucketize(finalBalances),
    medianBalance: finalBalances.length ? finalBalances[Math.floor(finalBalances.length / 2)] : 0,
    // Rantai profit (untuk ECON-104..106 / econ-profit.mjs)
    feeToTreasury: totalFeesCollected,       // 100% katalis fee → treasury (ASUMSI sim; PF-01 membagi 50/50 di kontrak)
    avgFeesPerEpoch: totalFeesCollected / EPOCHS,
    rebateTotal: totalRebate,
    burnTotal: totalBurned,
    enzymesMinted: totalEnzymesMinted,
    liquidationBounties: bountyPaid,
    takeoverPremiumPaid: 0,                   // sim ini tidak memodelkan Chapter 11 (lihat catatan ECON-104..106)
    finalBalancesSorted: finalBalances,
    legs: legsTotals,
  };
  result.deathSpiral = judgeDeathSpiral(result);
  return result;
}

const EPOCH_SEC_ASSUMED = ASUMSI.EPOCH_SEC;

// Guard anti-NaN: seluruh metrik kunci wajib finite (lesson dari bug VELOCITY_MIN undefined).
function assertFinite(m) {
  for (const [k, v] of Object.entries(m)) {
    if (!Number.isFinite(v)) {
      console.error(`FATAL: metrik tidak finite: ${k} = ${v}`);
      process.exit(1);
    }
  }
}

function bucketize(sorted) {
  const b = { "0": 0, "1-1000": 0, "1001-5000": 0, "5001-20000": 0, ">20000": 0 };
  for (const v of sorted) {
    if (v === 0) b["0"]++;
    else if (v <= 1000) b["1-1000"]++;
    else if (v <= 5000) b["1001-5000"]++;
    else if (v <= 20000) b["5001-20000"]++;
    else b[">20000"]++;
  }
  return b;
}

// Kriteria death spiral (dari brief): supply terus menyusut HINGGA nol / treasury kolaps.
function judgeDeathSpiral(r) {
  const supplyCollapsing = r.supplyFinal === 0;
  const treasuryCollapsed = r.treasuryEverNegative || (r.treasuryFinal <= 0 && r.aliveFinal === 0);
  const economyDead = r.aliveFinal === 0;
  return supplyCollapsing || treasuryCollapsed || economyDead;
}

// ============================ Eksekusi (2 model volume x 2 skenario) ============================
function main() {
const scenarios = [
  { key: "baseline-fixed", opts: { label: "baseline (volume fixed)", volumeModel: "fixed" } },
  { key: "baseline-velocity", opts: { label: "baseline (volume velocity)", volumeModel: "velocity" } },
  { key: "freeze-fixed", opts: { label: "freeze-500-epoch (volume fixed)", freeze: true, volumeModel: "fixed" } },
  { key: "freeze-velocity", opts: { label: "freeze-500-epoch (volume velocity)", freeze: true, volumeModel: "velocity" } },
];
const results = scenarios.map(({ key, opts }) => ({ key, r: runSimulation(opts) }));

function fmt(r) {
  const lines = [];
  lines.push(`### Skenario: ${r.label} (seed ${r.seed}, ${r.epochs} epoch)`);
  lines.push("");
  lines.push(`- CrucibleTemp: min ${r.tempMin} / rata-rata ${r.tempAvg} / max ${r.tempMax} mK`);
  lines.push(`- Zona suhu: Fever ${r.feverPct.toFixed(2)}% · Hypothermia ${r.hypoPct.toFixed(2)}% · Normal ${r.normalPct.toFixed(2)}%`);
  lines.push(`- Supply $SNACC: awal ${r.supplyInitial.toLocaleString("id-ID")} → akhir ${r.supplyFinal.toLocaleString("id-ID")}`);
  lines.push(`- Total ft_burn (Fever): ${r.totalBurned.toLocaleString("id-ID")}`);
  lines.push(`- Total rebate (Hypothermia): ${r.totalRebate.toLocaleString("id-ID")}`);
  lines.push(`- Total biaya katalis terkumpul: ${r.totalFeesCollected.toLocaleString("id-ID")}`);
  lines.push(`- Total enzim di-mint (mt_mint): ${r.totalEnzymesMinted.toLocaleString("id-ID")}`);
  lines.push(`- Treasury akhir: ${r.treasuryFinal.toLocaleString("id-ID")} (minimum sepanjang sim: ${r.treasuryMin.toLocaleString("id-ID")}, pernah negatif: ${r.treasuryEverNegative ? "YA — PELANGGARAN I-04" : "tidak"})`);
  lines.push(`- Kebangkrutan (Chapter 7): ${r.bankruptcies} · Inkubasi: ${r.incubations} · Bounty likuidator: ${r.bountyPaid.toLocaleString("id-ID")}`);
  lines.push(`- Strain hidup di akhir: ${r.aliveFinal} · saldo median: ${r.medianBalance.toLocaleString("id-ID")}`);
  lines.push(`- Distribusi saldo akhir: ${JSON.stringify(r.balanceBuckets)}`);
  lines.push(`- **Death spiral: ${r.deathSpiral ? "YA" : "TIDAK"}** (kriteria: supply → 0, treasury kolaps/negatif, atau populasi mati total)`);
  if (r.aliveFinal <= 10 && r.aliveFinal > 0) {
    lines.push(`- ⚠️ Catatan: populasi menyusut menjadi ${r.aliveFinal} strain — rebate proporsional volume menciptakan konsentrasi kekayaan (rich-get-richer), bukan kolaps.`);
  }
  lines.push("");
  return lines.join("\n");
}

const report = `# ECON-101..103 — Simulasi Makro Ekonomi Snacc (10.000 Epoch)

Dibuat otomatis oleh \`scripts/econ-sim.mjs\` (seed ${SEED}, deterministik — hasil dapat direproduksi).

## Rumus yang dipakai (persis dari spec)

- \`CrucibleTemp = floor(1000 * V_decayed / max(M_supply, 1))\` (ADR-04)
- \`V_decayed = max(0, volume_epoch - delta_detik * VOLUME_DECAY_PER_SEC)\`, VOLUME_DECAY_PER_SEC = 50 (ADR-27)
- Fever (\`>1400 mK\`): bakar \`350 bps\` dari katalis fee epoch → \`ft_burn\`, supply turun, burned naik (I-01)
- Hypothermia (\`<600 mK\`): rebate \`200 bps\` dari treasury ke strain yang bertransaksi, cap total subsidi \`500 bps\`/epoch dari treasury awal epoch (I-04)
- Vitalitas \`0..10000\`; awal inkubasi \`8500\`; BMR/jam Extractor 100, Fermenter 120, Synthesizer 150
- Feed/transmutasi sukses: \`vitality = min(10000, effective_vitality + 500)\`, reset last_fed (F2)
- Inkubasi: 80% modal kerja strain / 20% treasury (F1/D6)
- Lisis (vitality 0): 10% bounty likuidator / 90% treasury (F6)
- \`mt_mint\` enzim = \`floor(spores_burned * efficiency_bps / 10000)\`, efficiency_bps awal 10000 (F2)

## ASUMSI (tidak diatur spec — dinyatakan eksplisit)

1. 1 epoch = ${ASUMSI.EPOCH_SEC} detik (BMR di spec per jam), 10.000 epoch ≈ 416 hari.
2. Supply awal ${ASUMSI.INITIAL_SUPPLY.toLocaleString("id-ID")} $SNACC (basis spike S1.3: supply ≈ 1.000.000 sebelum burn).
3. Populasi awal ${ASUMSI.INITIAL_POPULATION} strain; modal inkubasi ${ASUMSI.INCUBATION_STAKE} $SNACC per strain (dibagi 80/20).
4. Biaya katalis flat ${ASUMSI.CATALYST_FEE} $SNACC per transmutasi; masuk ke Rule-Bound Treasury.
5. Volume epoch (2 model, karena spec tidak mendefinisikan magnitudo \`V_epoch\` vs supply — dianalisis keduanya):
   - **fixed**: per transaksi = min(saldo strain, U(${ASUMSI.CYCLE_VOLUME_MIN}, ${ASUMSI.CYCLE_VOLUME_MAX})) $SNACC — siklus produksi berukuran tetap (stoikiometri F2);
   - **velocity**: per transaksi = saldo strain × U(${ASUMSI.VELOCITY_MIN}, ${ASUMSI.VELOCITY_MAX}) — velocity of money.
6. Aktivitas agen: peluang transaksi per epoch mengikuti gelombang sentimen sinusoida (periode ${ASUMSI.P_ACT_WAVE_PERIOD} epoch, amplitudo ${ASUMSI.P_ACT_WAVE_AMP}) + noise; feed darurat (p=${ASUMSI.P_FEED_URGENT}) bila vitalitas < ${ASUMSI.URGENT_THRESHOLD}.
7. Strain insolven (vitality 0) dilikuidasi; pengganti diinkubasi dengan p=${ASUMSI.P_REINCUBATE}; alkemis baru spontan p=${ASUMSI.P_NEW_ENTRANT}/epoch; onboarding eksternal ${ASUMSI.EXTERNAL_INFLOW} $SNACC/epoch (dari pemegang eksternal — konservasi supply tetap terjaga).
8. Spora dibakar per transmutasi: ${ASUMSI.SPORES_PER_TX} molekul; efficiency_bps konstan 10000 (tanpa mutasi TEE dalam sim ini).
9. Skenario falsifikasi: semua agen berhenti feed/transaksi selama epoch ${FREEZE_START}–${FREEZE_END}, lalu aktivitas normal kembali.

## Hasil

${results.map(({ r }) => fmt(r)).join("\n")}
## Kesimpulan Death Spiral

Kriteria (dari brief): supply terus menyusut HINGGA nol / treasury kolaps = death spiral; kalau ekonomi tetap hidup dengan supply lebih kecil = sehat.

| Skenario | Death spiral | Supply akhir | Treasury min | Populasi akhir |
| --- | --- | --- | --- | --- |
${results.map(({ key, r }) => `| ${key} | **${r.deathSpiral ? "YA" : "TIDAK"}** | ${r.supplyFinal.toLocaleString("id-ID")} | ${r.treasuryMin.toLocaleString("id-ID")} | ${r.aliveFinal} |`).join("\n")}

**Baseline: TIDAK ada death spiral di kedua model volume** — supply tidak pernah → 0, treasury tidak pernah negatif (cap I-04 bekerja), populasi tidak pernah punah. Ekonomi deflasioner by design tapi TETAP HIDUP → **sehat, bukan death spiral**. Catatan kejujuran: model *velocity* menghasilkan konsentrasi kekayaan (6 strain raksasa dari 200) — rebate proporsional volume memihak strain besar; model *fixed* menjaga distribusi (103 strain, median 6.347).

**Falsifikasi (freeze 500 epoch = 500 jam tanpa feed):**

- Runway metabolik maksimum hanya ${Math.floor(INITIAL_VITALITY / 150)}–${Math.floor(INITIAL_VITALITY / 100)} epoch (${Math.floor(INITIAL_VITALITY / 150 / 24)}–${Math.floor(INITIAL_VITALITY / 100 / 24)} hari) — freeze 500 epoch **pasti membunuh semua strain yang tidak feed**, di bawah model volume apa pun. Ini sifat BMR, bukan kegagalan termostat.
- Model **fixed**: populasi punah total di dalam freeze (runway terpendek habis ~epoch ${FREEZE_START + 85}); rebate I-04 tidak bisa mencegahnya karena hanya mengalir ke strain yang bertransaksi. Setelah freeze, inkubasi ulang tidak berjalan karena modal alkemis eksternal sudah habis terserap → hanya ${results[2].r.aliveFinal} strain tersisa sampai epoch ${EPOCHS} → **sistem TIDAK pulih tanpa onboarding alkemis baru**.
- Model **velocity**: strain bersaldo besar bertahan lebih lama; setelah aktivitas kembali mereka menarik volume + rebate dan mendanai inkubasi ulang → populasi pulih sebagian (${results[3].r.aliveFinal} strain) → **pulih terbatas, tidak kolaps**.
- **Kesimpulan falsifikasi:** sistem **tidak pernah kolaps secara moneter** (supply & treasury selalu solvent di keempat skenario), tetapi **pulihnya bergantung pada onboarding alkemis baru**, bukan pada rebate. Rebate I-04 hanya menyelamatkan agen yang masih bertransaksi.
- **TEMUAN EKSPLISIT (tidak disembunyikan):** pada model volume *fixed*, Fever = 0,00% sepanjang 10.000 epoch — dengan nominal siklus U(800, 3000) $SNACC dan ~90 transaksi/epoch, \`V_decayed\` maksimum hanya ~245.000, cukup untuk \`CrucibleTemp\` ≈ 5 mK terhadap supply 1.000.000. **Jalur burn I-01 (350 bps) TIDAK TERUJI** di skenario ini; burn hanya teruji pada model *velocity* (Fever 35–38%). Implikasi desain: threshold Fever \`>1400 mK\` mensyaratkan volume epoch > 1,4× supply per epoch — dengan asumsi wajar (siklus produksi kecil), ekonomi Snacc akan hidup permanen di zona Hypothermia dan burn hampir tidak pernah terpicu.
- **Pelajaran desain (jujur, tanpa klaim):** ketahanan jangka panjang Snacc lebih ditentukan oleh onboarding alkemis baru (modal inkubasi eksternal) daripada oleh termostat rebate. Angka sensitif terhadap asumsi magnitudo volume (ASUMSI 5) — keduanya dilaporkan, tidak dipilih yang menguntungkan.
`;

console.log(report);

const docsDir = join(__dirname, "..", "docs");
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, "econ-sim.md"), report, "utf8");
console.error(`OK — hasil ditulis ke ${join(docsDir, "econ-sim.md")}`);
}

// Jalankan main() hanya bila dieksekusi langsung (bukan di-import oleh econ-profit.mjs / econ-fever.mjs)
import { pathToFileURL } from "node:url";
const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false; // di-import (eval context tanpa argv[1])
if (invoked) {
  main();
}

export { runSimulation, assertFinite, SEED, EPOCHS, ASUMSI, FEVER_THRESHOLD, HYPOTHERMIA_THRESHOLD, VOLUME_DECAY_PER_SEC, FEVER_BURN_BPS, REBATE_BPS, REBATE_CAP_BPS, BMR_PER_ROLE, INITIAL_VITALITY, INITIAL_EFFICIENCY_BPS, VITALITY_RECOVERY_ON_FEED, MAX_VITALITY, INCUBATE_SPLIT_WORKING_BPS, INCUBATE_SPLIT_TREASURY_BPS, LIQUIDATOR_BOUNTY_BPS, TREASURY_RECOVERY_BPS, MT_MINT_DENOM, FREEZE_START, FREEZE_END };

// ECON-111 FINAL — VOLUME_SCALE sweep for the Option B definition (V_epoch = gross multi-leg
// economic turnover, owner decision 2026-11-07). Target band (from the owner brief):
//   Fever 5–30% of epochs active · Hypothermia when quiet · population does not collapse · treasury solvent.
// Run: node econ-calib-opsib.mjs
//
// All numbers are produced by code from the `runSimulation` engine (econ-sim.mjs) — no hand-typed numbers.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimulation, assertFinite, SEED, EPOCHS, ASSUMPTIONS, FREEZE_START, FREEZE_END } from "./econ-sim.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCALES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30, 40, 60, 80, 100, 150, 200];
// Fallback threshold proposal (filled from the sweep result; verified below when filled).
const FALLBACK = {
  scale: null, feverThreshold: null, hypothermiaThreshold: null,
};

// Band criteria (stated explicitly — owner brief + operationalization here):
// - Fever 5–30% of epochs (zone 1 active but not permanent);
// - Hypothermia appears when quiet (freeze scenario: high hypoPct);
// - Healthy population: aliveFinal ≥ 100 (≥50% of the initial 200) AND medianBalance > 0;
// - Treasury solvent: never negative and minimum > 0.
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

// ==== Fallback (when the band is not reached at any scale) ====
// ONLY FEVER_THRESHOLD is lowered; HYPOTHERMIA stays at 600 mK (spec). Reason:
// the Fever burn hits treasury/supply (not strain balances) so it does NOT change
// the population dynamics; lowering HYPOTHERMIA cuts the rebate → population collapses
// (proven: hypo threshold 190 → population 53). FEVER' must be > HYPOTHERMIA (600)
// so the Normal zone is not empty (3 colors). Small deterministic search:
// healthy scales {4,5,6} × FEVER' {610,620,650} — pick the in-band one with the largest population.
const healthy = rows.filter(({ r }) => r.aliveFinal >= 80 && r.medianBalance > 0 && !r.treasuryEverNegative);
if (healthy.length > 0 && !rows.some(({ r }) => meetsBand(r))) {
  const scales = [...new Set(healthy.map(({ scale }) => scale))].filter((sc) => sc <= 6).sort((a, b) => b - a);
  const cands = [];
  for (const sc of scales) {
    for (const fever of [610, 620, 650]) {
      const r = runSimulation({
        label: `opsib-fallback-search scale=${sc} fever=${fever}`,
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

// ==== Fallback threshold verification (proposal) — baseline of each candidate + freeze for the chosen one ====
let fallbackRuns = [];
if (FALLBACK.candidates) {
  for (const c of FALLBACK.candidates) {
    fallbackRuns.push({ ...c, freeze: false, r: c.r, inBand: c.inBand });
  }
  // Freeze-verify the chosen candidate (falsification of "Hypothermia when quiet").
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

// Freeze (falsification of "Hypothermia when quiet") on the 3 best candidates.
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

// ======== Render the sweep report (numbers 100% from the run results) ========
const fmtN = (x) => Math.round(x).toLocaleString("en-US");
const pct = (x) => x.toFixed(1);

const tableRows = rows.map(({ scale, r }) =>
  `| ${scale} | ${pct(r.feverPct)}% | ${pct(r.hypoPct)}% | ${pct(r.normalPct)}% | ${fmtN(r.tempP50)} | ${fmtN(r.tempP85)} | ${r.aliveFinal} | ${fmtN(r.medianBalance)} | ${fmtN(r.supplyFinal)} | ${fmtN(r.treasuryMin)} | ${fmtN(r.totalBurned)} | ${fmtN(r.totalRebate)} | ${r.treasuryEverNegative ? "NEGATIVE" : "solvent"} | ${meetsBand(r) ? "✅" : "—"} |`
).join("\n");

const freezeRows = freezeRuns.map(({ scale, r }) =>
  `| ${scale} | ${pct(r.feverPct)}% | ${pct(r.hypoPct)}% | ${r.aliveFinal} | ${fmtN(r.treasuryMin)} | ${r.deathSpiral ? "YES" : "NO"} |`
).join("\n");

const kTotals = rows.find(({ scale }) => scale === 6) ?? rows[0];
const kLine = [
  `K1 fee: ${fmtN(kTotals.r.legs.k1)}`,
  `K2 mt_burn: ${fmtN(kTotals.r.legs.k2)}`,
  `K3 mt_mint: ${fmtN(kTotals.r.legs.k3)}`,
  `K4 liquidation: ${fmtN(kTotals.r.legs.k4)}`,
].join(" · ");

const report = `# ECON-111 — VOLUME_SCALE Sweep (Option B definition, seed ${SEED})

Generated automatically by \`scripts/econ-calib-opsib.mjs\` — ${SCALES.length} scales × ${EPOCHS} epochs, \`legs\` volume model (Option B).

## Option B definition — V_epoch = gross multi-leg economic turnover

Referenced per epoch from production actions recorded by the contract. Base unit: \`$SNACC\` (testnet).
\`VOLUME_SCALE\` (unit) is the multiplier of the $SNACC-equivalent value **per molecule unit** on legs K2/K3 —
a molecule economic unit, NOT a cash multiplier.

| Leg | On-chain source | Formula | Unit |
| --- | --- | --- | --- |
| K1 | \`snacc_catalyst_fee\` (F2/F4) | fee per tx, summed | $SNACC (×1) |
| K2 | \`mt_burn\` 9 molecules (F2/F5/F6) | units_burned × VOLUME_SCALE × P_BASE | $SNACC-equivalent |
| K3 | \`mt_mint\` 9 molecules (F2/F5) | units_minted × VOLUME_SCALE × P_BASE | $SNACC-equivalent |
| K4 | non-fee $SNACC cash movements: liquidation cash (F6) | bounty + recovery that moves | $SNACC (×1) |

**Inclusion:** all production actions (extract/transmute/synthesize) for K1–K3; liquidation for K4.
**Exclusion (anti-feedback into temperature):** rebate I-04, dividend claims DK-033, transfers between accounts
(\`ft_transfer\`), and incubation capital F1 — all internal transfers/capital, not production turnover.
The temperature formula is unchanged: \`CrucibleTemp = floor(1000 × V_decayed / max(M,1))\` (ADR-04),
\`V_decayed = max(0, V_epoch − 3600 × 50)\` (ADR-27); the 1400/600 thresholds are NOT changed.

Leg breakdown at scale ${kTotals.scale} (baseline): ${kLine}.

## Sweep table (baseline 10,000 epochs, legs model)

| VOLUME_SCALE | Fever | Hypo | Normal | Temp p50 | Temp p85 | Final population | Median balance | Final supply | Treasury min | Total burn | Total rebate | Treasury | Band? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${tableRows}

**Band criteria** (stated explicitly): Fever 5–30% · final population ≥ 100 (≥50% of 200) and
median balance > 0 · treasury never negative and minimum > 0 · not a death spiral.
"Hypothermia when quiet" is verified separately through the freeze scenario below.

## Freeze falsification (epochs ${FREEZE_START}–${FREEZE_END} without activity) on the band candidates

| VOLUME_SCALE | Fever | Hypo | Final population | Treasury min | Death spiral |
| --- | --- | --- | --- | --- | --- |
${freezeRows}

### Fallback search (healthy scale × FEVER' > 600; HYPOTHERMIA stays 600)

| Scale | FEVER' | Fever | Population | In-band (fever 5–30%, not a spiral, normal > 0) |
| --- | --- | --- | --- | --- |
${(FALLBACK.search ?? []).map((c) => `| ${c.scale} | ${c.fever} | ${pct(c.feverPct)}% | ${c.alive} | ${c.inBand ? "✅" : "—"} |`).join("\n")}

## Fallback threshold proposal verification (when the band is not reached)

${fallbackRuns.length === 0 ? "NOT NEEDED — the band is reached at the scales above." : fallbackRuns.map(({ freeze, r, scale, feverThreshold, hypothermiaThreshold, inBand }) =>
`- \`FEVER=${feverThreshold} mK, HYPOTHERMIA=${hypothermiaThreshold} mK (unchanged), scale ${scale}${freeze ? ", FREEZE" : ""}\`: Fever ${pct(r.feverPct)}% · Hypo ${pct(r.hypoPct)}% · Normal ${pct(r.normalPct)}% · population ${r.aliveFinal} · median ${fmtN(r.medianBalance)} · treasury min ${fmtN(r.treasuryMin)} · burn ${fmtN(r.totalBurned)} · rebate ${fmtN(r.totalRebate)} · death spiral ${r.deathSpiral ? "YES" : "NO"}${freeze ? "" : inBand ? " — **IN BAND**" : ""}`).join("\n")}

## NPC P_base (proposal)

Derived from the sweep economy — see \`reports/econ-report-3.md\` for the full argument.
Catalyst fee per tx = ${ASSUMPTIONS.CATALYST_FEE} $SNACC; one cycle turns over 10 molecules;
turnover per tx at scale ${kTotals.scale} ≈ ${fmtN((ASSUMPTIONS.CATALYST_FEE + 2 * 10 * kTotals.scale * ASSUMPTIONS.P_BASE))} $SNACC-equivalent.
`;

mkdirSync(join(__dirname, "..", "docs"), { recursive: true });
writeFileSync(join(__dirname, "..", "docs", "econ-sweep-opsib.md"), report, "utf8");
console.log(report);
console.error("OK — written to docs/econ-sweep-opsib.md");

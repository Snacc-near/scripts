// ECON-104..106 — Profit equations PF-01..09 recomputed from the final simulation parameters.
// Definition source: private snacc-vault, research note "Profit Model and NEAR AI Framing" (§2 table PF-01..09
// and the Profit_epoch equation). Constants: private snacc-vault architecture notes — Industrial Dividend
// Pool Spec DK-033/DK-044 (DIVIDEND_INFLOW_BPS=5000, pro-rata per epoch), Contract Interface Spec
// (I-15 NPC pricing), Spec F2/F3 (TEE → efficiency_bps → ATP → elixir → dividend).
//
// Honesty principle (from the source document): PF is a LABEL of value flow, not a profit guarantee;
// $SNACC testnet has no monetary value; PF-04/06/07/09 are redistribution, not value creation.
//
// Run: node econ-profit.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runSimulation, assertFinite, SEED, EPOCHS, ASSUMPTIONS,
  INITIAL_EFFICIENCY_BPS, MAX_VITALITY, VITALITY_RECOVERY_ON_FEED,
  LIQUIDATOR_BOUNTY_BPS, TREASURY_RECOVERY_BPS, MT_MINT_DENOM,
} from "./econ-sim.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============ Constants from the spec (do not change) ============
const DIVIDEND_INFLOW_BPS = 5000;        // ADR-28 / DK-033: 50% of (fee - burned) → dividend pool
const TEE_SHIFT_BPS_EXAMPLE = 430;       // documented vault example: efficiency_shift_bps 430 (Data Model)
const TEE_MAX_SHIFT_BPS = 1500;          // TEE guard ADR-07 / I-03: |shift| <= 1500 bps
const TAKEOVER_PREMIUM_BPS = 1500;       // ADR-26/I-09: Chapter 11 = Book Value + 15% Restructuring Premium
const TAKEOVER_SALVAGE_BPS = 10000;      // the raider absorbs all of the target's cash + NEP-245 (ADR-26)
const ATP_PER_FEE = 1;                   // ASSUMPTION: 1 ATP per burned catalyst $SNACC (EN-06 does not define function f)
const SPORES_PER_TX = ASSUMPTIONS.SPORES_PER_TX; // 10 spores/transmutation (sim ASSUMPTION ECON-101..103)

// ============ Run the final simulation ============
// Default (ECON-104..106 compatibility): baseline-velocity as the PF source.
// Mode `--opsib [SCALE]` (ECON-111 FINAL): PF source = Option B definition (legs model)
// at the chosen VOLUME_SCALE + the final FEVER threshold 610 mK (ECON-111 FINAL, Kamus D7).
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

// ============ PF-01..09 computation (definitions copied from vault §2) ============
// Profit_epoch(i) = PF-01 + ΔBookValue_i + PF-03 + PF-04 + PF-05 + PF-06 + PF-07 + PF-08 + PF-09
//                   − (Feed_i + Catalyst_i + Upkeep_i + Burn_i)
// All numbers are per-epoch averages, in testnet $SNACC.

const perStrain = (x) => x / Math.max(main.aliveFinal, 1);

// PF-01 Industrial dividend (ADR-28/DK-033/044): 50% of non-burned catalyst fee → pool; redeemed pro-rata
// by ROLE_SYNTHESIZER burning mt:elixir-aether. In the sim, the fee goes to the treasury (ASSUMPTION ECON-101..103);
// in the contract, 50% is directed to industrial_dividend_pool. We compute both consistently:
const feePerEpoch = main.avgFeesPerEpoch;
const dividendPoolPerEpoch = Math.floor((feePerEpoch * DIVIDEND_INFLOW_BPS) / 10000);
// Pro-rata per strain actively burning aether — assumption: all active strains participate (upper bound)
const pf01_perStrain = dividendPoolPerEpoch / Math.max(main.aliveFinal, 1);

// PF-02 NFT book value capital gain: EV = Cash_SNACC + Σ Inv_k·P_k + PV(RoleMask, EfficiencyBps, Pool)
// ΔBookValue from the sim: change in the average strain balance per epoch (cash component); NEP-245 & PV qualitative.
const avgBalance = main.finalBalancesSorted.reduce((a, b) => a + b, 0) / Math.max(main.finalBalancesSorted.length, 1);
const deltaBookPerEpoch = (avgBalance - ASSUMPTIONS.INCUBATION_STAKE * 0.8) / EPOCHS; // from 80% initial capital to the final average

// PF-03 Secret genome IP premium (F3/ADR-21): the TEE raises efficiency_bps (example +430 bps),
// chain: TEE → efficiency_bps → ATP → elixir → dividend. Computed as the increase in enzyme
// output per transmutation × the chain length to the dividend:
const effShifted = INITIAL_EFFICIENCY_BPS + TEE_SHIFT_BPS_EXAMPLE; // 10430
// Per-tx contract rounding (floor per 10 spores) removes small gains: floor(10·1.043)=10.
const enzymeGainPerTx = Math.floor((SPORES_PER_TX * effShifted) / MT_MINT_DENOM)
  - Math.floor((SPORES_PER_TX * INITIAL_EFFICIENCY_BPS) / MT_MINT_DENOM); // 0 per-tx (floor effect)
// Aggregate gain per epoch: 4.3% of the total minted enzymes (rounded down per claim):
const enzymeGainPerEpoch = Math.floor((main.enzymesMinted / EPOCHS) * (TEE_SHIFT_BPS_EXAMPLE / 10000)); // enzymes/epoch
const txPerEpoch = feePerEpoch / ASSUMPTIONS.CATALYST_FEE; // transactions per epoch from the fee
const pf03_enzymePerEpoch = enzymeGainPerTx * txPerEpoch; // extra output per epoch (enzyme units)
// Effect on the dividend (full chain): elixir output rises → aether available → PF-01 claim rises proportionally.
// Extra dividend ≈ strain PF-01 share × (effShifted / INITIAL_EFFICIENCY_BPS − 1):
const pf03_dividendUpliftPct = (effShifted / INITIAL_EFFICIENCY_BPS - 1) * 100; // 4.3%

// PF-04 Chapter 11/7 arbitrage (zero-sum PvP): two components from the sim:
// (a) Chapter 7 bounty = 10% of the insolvent strain's cash (already simulated);
// (b) Chapter 11 premium = 115% Book Value — NOT modeled in the sim (no raider action);
// computed here as a theoretical per-event value from the median balance.
const pf04_bountyPerEpoch = main.liquidationBounties / EPOCHS;
const pf04_takeoverBookValue = main.medianBalance; // ASSUMPTION: typical target = median balance
const pf04_takeoverCost = Math.floor((pf04_takeoverBookValue * (10000 + TAKEOVER_PREMIUM_BPS)) / 10000); // 115%
const pf04_takeoverSalvage = Math.floor((pf04_takeoverBookValue * TAKEOVER_SALVAGE_BPS) / 10000); // 100% of target cash
const pf04_takeoverMargin = pf04_takeoverSalvage - pf04_takeoverCost; // negative = premium paid

// PF-05 Adopt & restore (EN-08c): adopt a Tier 3 cell (cheap + damaged) → restore with ATP → sell.
// The sim does not model adopt; computed theoretically: adopt cost ≈ 10% bounty (paid to the Pantry),
// restoration needs ATP from feed (1 ATP per fee) + vitality +500 per feed (spec F2).
const pf05_adoptCost = Math.floor((ASSUMPTIONS.INCUBATION_STAKE * 0.8 * LIQUIDATOR_BOUNTY_BPS) / 10000); // 10% working capital
const feedsToRestore = Math.ceil((MAX_VITALITY - 1) / VITALITY_RECOVERY_ON_FEED); // ≈20 feeds for full recovery
const pf05_restoreCost = feedsToRestore * ASSUMPTIONS.CATALYST_FEE;
const pf05_totalCost = pf05_adoptCost + pf05_restoreCost;

// PF-06 Feeding-cost time arbitrage (EN-01/02/03, DK-030): feed during a discount (Famine Relief 2% /
// Nutrient Burst / Rescue feeding) — margin = avoided fee. From the sim: the average Hypothermia rebate
// per active strain per epoch is a proxy for the feed subsidy (bounded by DK-030: rebate < fee).
const pf06_rebatePerStrainPerEpoch = perStrain(main.rebateTotal / EPOCHS);
const pf06_maxDiscountCheck = pf06_rebatePerStrainPerEpoch < ASSUMPTIONS.CATALYST_FEE; // DK-030: rebate < fee

// PF-07 NEP-245 molecule market-making (ADR-30/I-15): unit price ≥ P_base × S_target / max(S_after,1).
// Margin = (sell price to the NPC − buy price from the NPC). The sim does not model NPC stock; computed
// theoretically for 1 cycle: buy 10 spores, sell 10 enzymes (efficiency 10000 → 1:1), spread P_base.
// Explicit ASSUMPTION: P_base = 100 $SNACC/unit, S_target = 2× S_after (scarcity raises the price 2×).
const P_BASE = 100;
const S_SCARCITY = 2; // S_target / S_after
const pf07_buyCost = SPORES_PER_TX * P_BASE;
const pf07_sellRevenue = Math.floor(SPORES_PER_TX * P_BASE * S_SCARCITY); // scarcity raises the price
const pf07_marginPerCycle = pf07_sellRevenue - pf07_buyCost;

// PF-08 Colony vertical integration (EN-08a): colony_role_coverage = OR(role_mask_i) → 0b111 without a merger.
// Value = the avoided 3-stage spread (avoided cost, not cash inflow). From the sim: the PF-07 margin
// per cycle × 3 stages (spore→enzyme→elixir) is the intermediary spread ceiling.
const pf08_avoidedSpreadPerCycle = pf07_marginPerCycle * 3;

// PF-09 The Great Feast bonus (EN-02): top-3 epoch volume contributors, cap 5% of treasury/epoch.
// From the sim: bonus proxy = 5% treasury cap × top-3 share (ASSUMPTION: top-3 = 30% of volume → 1.5% of treasury).
const pf09_capPerEpoch = Math.floor((main.treasuryFinal * 500) / 10000); // cap 5% of treasury (I-04/EN-02)
const pf09_top3Share = 0.3; // ASSUMPTION
const pf09_bonusPerEpoch = Math.floor(pf09_capPerEpoch * pf09_top3Share);

// Cost per strain per epoch (the subtracting side of the profit equation)
const costFeedPerEpoch = feePerEpoch / Math.max(main.aliveFinal, 1); // catalyst = feed cost in the sim
const costUpkeepPerEpoch = 0; // BMR is vitality decay (non-monetary), not cash — noted explicitly

// One-epoch profit equation (exactly the vault §2 order):
const profitEpochPerStrain =
  pf01_perStrain +
  deltaBookPerEpoch +
  0 /* PF-03: NFT market premium — not simulated, reported qualitatively (enzyme units & % uplift only) */ +
  pf04_bountyPerEpoch / Math.max(main.aliveFinal, 1) /* random liquidators only; zero-sum */ +
  0 /* PF-05: not simulated — theoretical cost only */ +
  pf06_rebatePerStrainPerEpoch +
  0 /* PF-07: theoretical margin, does not flow in the sim */ +
  0 /* PF-08: avoided cost */ +
  0 /* PF-09: not simulated */ -
  (costFeedPerEpoch + costUpkeepPerEpoch);

const rows = [
  ["PF-01", "Industrial dividend (ADR-28/DK-033/044)", `${pf01_perStrain.toFixed(1)} $SNACC/strain/epoch`, `pool ${dividendPoolPerEpoch.toFixed(0)}/epoch = 50% × fee ${feePerEpoch.toFixed(0)}; pro-rata across ${main.aliveFinal} active strains`],
  ["PF-02", "NFT book value capital gain", `${deltaBookPerEpoch >= 0 ? "+" : ""}${deltaBookPerEpoch.toFixed(1)} $SNACC/strain/epoch (cash component)`, `EV = Cash + ΣInv·P + PV(...); average balance ${avgBalance.toFixed(0)} vs initial capital ${(ASSUMPTIONS.INCUBATION_STAKE * 0.8).toFixed(0)}`],
  ["PF-03", "Secret genome IP premium (TEE)", `+${enzymeGainPerEpoch} enzymes/epoch (aggregate) — per-tx floor = ${enzymeGainPerTx}`, `shift +${TEE_SHIFT_BPS_EXAMPLE} bps (vault example, guard ±${TEE_MAX_SHIFT_BPS}); chain TEE→eff→ATP→elixir→dividend; NOTE: the per-tx floor over 10 spores removes small gains — the real gain only shows in aggregate/large claims`],
  ["PF-04", "Chapter 11/7 arbitrage (zero-sum)", `bounty ${pf04_bountyPerEpoch.toFixed(1)} $SNACC/epoch (sim realization); takeover: cost ${pf04_takeoverCost} vs salvage ${pf04_takeoverSalvage} = margin ${pf04_takeoverMargin} $SNACC`, `Ch.11 = 115% Book Value (ADR-26); Ch.7 bounty = 10% (F6); NOT profitable per event — the 15% premium is purely an acquisition cost`],
  ["PF-05", "Adopt & restore (EN-08c)", `cost ${pf05_totalCost} $SNACC per cell (adopt ${pf05_adoptCost} + restore ${pf05_restoreCost} = ${feedsToRestore} feeds)`, `not simulated; ATP: ${ATP_PER_FEE}/fee (ASSUMPTION: EN-06 f is not defined in the spec)`],
  ["PF-06", "Feeding-cost time arbitrage", `${pf06_rebatePerStrainPerEpoch.toFixed(1)} $SNACC/strain/epoch (Hypothermia rebate)`, `DK-030 rebate<fee: ${pf06_maxDiscountCheck ? "PASS" : "FAIL"}`],
  ["PF-07", "Molecule market-making (ADR-30)", `${pf07_marginPerCycle} $SNACC/cycle (theoretical)`, `price ≥ P_base × S_target/max(S_after,1) (I-15); ASSUMPTION P_base=${P_BASE}, scarcity ${S_SCARCITY}×`],
  ["PF-08", "Colony vertical integration (EN-08a)", `${pf08_avoidedSpreadPerCycle} $SNACC/cycle (avoided cost, not cash)`, `coverage 0b111 without a merger = unpaid 3-stage spread`],
  ["PF-09", "The Great Feast bonus (EN-02)", `${pf09_bonusPerEpoch} $SNACC/epoch (cap 5% of treasury = ${pf09_capPerEpoch})`, `top-3 contributors; ASSUMPTION top-3 share 30% of volume; Pantry redistribution`],
];

const costRows = [
  ["Feed/Catalyst", costFeedPerEpoch.toFixed(1), "catalyst cost per strain per epoch (from the sim)"],
  ["Upkeep (BMR)", "0 (non-monetary)", "BMR decays vitality, not cash — value loss appears on lysis"],
  ["Burn (Fever I-01)", (main.burnTotal / EPOCHS).toFixed(1) + " $SNACC/epoch (system)", "deducted from the epoch fee, not from the strain balance"],
  ["Rebate (I-04)", "+" + pf06_rebatePerStrainPerEpoch.toFixed(1), "already counted in PF-06 (do not count twice)"],
];

// ============ Comparison baseline-velocity vs baseline-fixed ============
const cmp = [
  ["Fee/epoch", main.avgFeesPerEpoch.toFixed(0), alt.avgFeesPerEpoch.toFixed(0)],
  ["Dividend pool/epoch (50%)", (main.avgFeesPerEpoch * 0.5).toFixed(0), (alt.avgFeesPerEpoch * 0.5).toFixed(0)],
  ["PF-01 per strain/epoch", pf01_perStrain.toFixed(1), (alt.avgFeesPerEpoch * 0.5 / Math.max(alt.aliveFinal, 1)).toFixed(1)],
  ["Rebate per strain/epoch", pf06_rebatePerStrainPerEpoch.toFixed(1), (alt.rebateTotal / EPOCHS / Math.max(alt.aliveFinal, 1)).toFixed(1)],
  ["Total burn over 10k epochs", main.burnTotal.toLocaleString("en-US"), alt.burnTotal.toLocaleString("en-US")],
  ["Final population", main.aliveFinal, alt.aliveFinal],
];

// ============ Report ============
const report = `# ECON-104..106 — Profit Equations PF-01..09 from the Final Simulation Parameters

Generated automatically by \`scripts/econ-profit.mjs\` (seed ${SEED}, ${EPOCHS} epochs, source scenario: **${main.label}**${OPSIB ? ` — ECON-111 FINAL: Option B definition (multi-leg turnover), VOLUME_SCALE=${OPSIB_SCALE}, final FEVER threshold 610 mK` : ""}; comparison: baseline-fixed). All numbers are **produced by code**, not typed by hand.

## 1. Definition sources (copied, not invented)

- PF-01..09 definitions + the \`Profit_epoch\` equation: private vault, research note "Profit Model and NEAR AI Framing" §2.
- \`DIVIDEND_INFLOW_BPS = 5000\`, pro-rata per epoch, \`MAX_DIVIDEND_CLAIM_EPOCHS = 8\`: private vault, Industrial Dividend Pool Spec DK-033/DK-044.
- TEE guard \`±1500 bps\` (I-03/ADR-07), example shift \`430 bps\`: private vault, Data Model.
- NPC price \`≥ P_base × S_target / max(S_after, 1)\` (I-15/ADR-30): private vault, Contract Interface Spec.
- Bounty 10%/90% (F6), premium 115% (ADR-26/I-09), vitality +500 per feed (F2).

## 2. Profit table = code (per-epoch average, testnet $SNACC)

| ID | Flow | Measured value | Calculation details |
| --- | --- | --- | --- |
${rows.map(([a, b, c, d]) => `| ${a} | ${b} | ${c} | ${d} |`).join("\n")}

### Cost side (subtracted from the equation)

| Component | Value | Notes |
| --- | --- | --- |
${costRows.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`).join("\n")}

### Profit_epoch equation (per strain, only the simulated components)

\`\`\`
Profit_epoch(i) ≈ PF-01 (${pf01_perStrain.toFixed(1)}) + ΔBookValue (${deltaBookPerEpoch.toFixed(1)})
                + PF-04 bounty share (${(pf04_bountyPerEpoch / Math.max(main.aliveFinal, 1)).toFixed(2)})
                + PF-06 rebate (${pf06_rebatePerStrainPerEpoch.toFixed(1)})
                − Feed/Catalyst (${costFeedPerEpoch.toFixed(1)}) − Upkeep (0, non-monetary)
              = ${profitEpochPerStrain.toFixed(1)} $SNACC/strain/epoch (testnet, no monetary value)
\`\`\`

**Honesty note:** PF-03/05/07/08/09 carry no cash flow in the simulation (reported as theoretical units/avoided cost). A small positive profit here is NOT a profit promise — it depends on the activity assumptions (ASSUMPTION 6 in econ-sim) and is redistribution (PF-04/06/07/09) or a transfer from the fee pool (PF-01), per invariant I-01/DK-010: no $SNACC mint after init.

## 3. TEE → efficiency_bps → ATP → elixir → dividend chain (PF-01/PF-03, covered)

\`\`\`
TEE shift +${TEE_SHIFT_BPS_EXAMPLE} bps (documented example; guard ±${TEE_MAX_SHIFT_BPS} bps, I-03)
→ efficiency_bps: ${INITIAL_EFFICIENCY_BPS} → ${effShifted}
→ ATP_minted per fee rises proportionally (EN-06; ASSUMPTION 1 ATP/fee — the spec's f does not define the exact form)
→ mt_mint enzymes: ${Math.floor((SPORES_PER_TX * INITIAL_EFFICIENCY_BPS) / MT_MINT_DENOM)} per 10 spores (per-tx floor: the 430 bps gain is invisible over 10 spores)
→ aggregate gain: +${enzymeGainPerEpoch} enzymes/epoch (${((effShifted / INITIAL_EFFICIENCY_BPS - 1) * 100).toFixed(1)}% of ${Math.floor(main.enzymesMinted / EPOCHS)} enzymes/epoch)
→ Stage-3 elixir output rises → more mt:elixir-aether available
→ synthesize_and_redeem_aether (DK-044) → PF-01 claim rises about ${((effShifted / INITIAL_EFFICIENCY_BPS - 1) * 100).toFixed(1)}% pro-rata
\`\`\`

## 4. Comparison baseline-velocity vs baseline-fixed

| Metric | velocity | fixed |
| --- | --- | --- |
${cmp.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`).join("\n")}

The *fixed* model splits the fee across ${alt.aliveFinal} strains (PF-01 per strain is much smaller but the distribution is healthy); the *velocity* model yields a larger fee per strain but concentrated (${main.aliveFinal} strains remaining).

## 5. Explicit assumptions (besides the ECON-101..103 ASSUMPTIONS inherited)

1. \`P_base = ${P_BASE}\` (recorded in vault §13a, matching the contract \`P_BASE\`) and scarcity ${S_SCARCITY}× for PF-07 — the scarcity factor is an ASSUMPTION (the I-15 formula is in the vault, the 2× is not).
2. ATP = 1 per fee (EN-06: \`atp_minted = f(amount, efficiency_bps, level_mitokondria, zone)\` — the form of f is not defined in the vault).
3. Great Feast top-3 share = 30% of volume (PF-09); the 5% treasury cap is taken from EN-02/I-04.
4. PF-05 adopt cost = 10% bounty on working capital; restoration = ${feedsToRestore} feeds (from vitality 1 to ${MAX_VITALITY}, +500/feed — spec F2).
5. Chapter 11 is not simulated as an agent action; computed theoretically from the median balance.
6. The dividend pool in the sim goes 100% to the treasury (ASSUMPTION ECON-101..103); for PF-01 it is cut 50% per DK-033 (the same numbers, split between two destinations).

## 6. Unfinished / needs an owner decision

- The form of the ATP function \`f\` (EN-06) is not in the vault yet → a decision is needed before contract implementation.
- PF-05 (adopt), PF-09 (Great Feast), and Chapter 11 actions are not yet modeled as agent behavior in the macro simulation; their numbers are theoretical.
- All values are testnet $SNACC with no monetary value — not a yield/ROI claim (vault honesty rule §6).
`;

console.log(report);

const docsDir = join(__dirname, "..", "docs");
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, "econ-profit.md"), report, "utf8");
console.error(`OK — result written to ${join(docsDir, "econ-profit.md")}`);

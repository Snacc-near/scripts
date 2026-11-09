#!/usr/bin/env node
/**
 * demo-e2e.mjs — QA-138..140: a concise end-to-end demo (4 beats) with no private keys.
 *
 * Beats:
 *   1. Macro simulation (imports `econ-sim.mjs`, final ECON-111 Option B config:
 *      legs + VOLUME_SCALE 5 + Fever 610) → assert a living population, no death
 *      spiral, finite-number guards.
 *   2. Simulation conservation invariant (ASSUMPTION #7 fix): the identity
 *      `supplyFinal == treasuryFinal + alchemistPoolFinal + strainsBalanceFinal +
 *      externalPoolFinal` plus the `conservation.closes === true` assertion (the
 *      independent ledger in econ-sim). Cumulative rebate/bounty are NOT summed
 *      again (that used to double-count — see docs/asumsi-7-fix.md §1).
 *   3. Testnet views (read-only, no keys): `get_crucible_temp`,
 *      `get_macro_state`, `ft_total_supply`, `get_global_solvency` — must be
 *      reachable & parseable; `solvent == true` is expected, but a network
 *      failure is a WARNING (not an e2e failure — honest about limits).
 *   4. Summary + exit 0 (all core assertions passed).
 *
 * Usage: node demo-e2e.mjs   (umbrella alias: npm run demo:e2e)
 * $SNACC testnet has no monetary value.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimulation, assertFinite } from "./econ-sim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const RPC = arg("rpc", process.env.NEAR_RPC ?? "https://rpc.testnet.near.org");
const CONTRACT = arg("contract", process.env.CONTRACT_ID ?? "snacc-v001.testnet");

async function rpcView(method, args = {}) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "demo-e2e",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONTRACT,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 140)}`);
  // NEAR RPC: the JSON bytes live in `j.result.result` (number array) — NOT `j.result`.
  const bytes = j.result?.result;
  if (!bytes) throw new Error(`${method}: empty/unexpected result`);
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function main() {
  console.log("demo:e2e — 4 beats, QA-138..140 (no private keys)\n");

  // ---- Beat 1: macro simulation (final ECON-111 Option B config) ----
  console.log("[1/4] Macro simulation — Option B (legs, VOLUME_SCALE 5, Fever 610)…");
  const sim = runSimulation({
    label: "demo-e2e (final Option B)",
    volumeModel: "legs",
    volumeScale: 5,
    feverThreshold: 610,
  });
  assertFinite({
    supply: sim.supplyFinal,
    treasury: sim.treasuryFinal,
    alive: sim.aliveFinal,
    burn: sim.totalBurned,
    rebate: sim.totalRebate,
  });
  if (sim.aliveFinal === 0) fail("simulation: the population went fully extinct");
  if (sim.deathSpiral) fail("simulation: death spiral detected");
  if (sim.treasuryEverNegative) fail("simulation: the treasury went negative (I-04)");
  console.log(
    `   ✓ population ${sim.aliveFinal} · supply ${sim.supplyFinal.toLocaleString("en-US")} · ` +
      `burn ${sim.totalBurned.toLocaleString("en-US")} · Fever ${sim.feverPct.toFixed(1)}% · ` +
      `Hypo ${sim.hypoPct.toFixed(1)}% · treasury min ${sim.treasuryMin.toLocaleString("en-US")}`
  );

  // ---- Beat 2: simulation conservation invariant (ASSUMPTION #7 fix — docs/asumsi-7-fix.md §1/§7) ----
  console.log("[2/4] Simulation conservation invariant (component identity, no double counting)…");
  // Correct formula (asumsi-7-fix.md §2): supply = treasury + alchemist + Σ strain balances + external.
  // Cumulative rebate and bounty are NOT summed — that money already sits in balances.
  const distributedTotal =
    sim.treasuryFinal +
    sim.alchemistPoolFinal +
    sim.strainsBalanceFinal +
    sim.externalPoolFinal;
  const delta = sim.supplyFinal - distributedTotal;
  if (!Number.isFinite(delta)) fail("conservation: delta is not finite");
  if (sim.conservation?.closes !== true) {
    fail(`conservation: the ledger does not close (closes=${sim.conservation?.closes}, ` +
      `maxAbsDrift=${sim.conservation?.maxAbsDrift})`);
  }
  if (delta !== 0) fail(`conservation: component identity is not zero (delta=${delta})`);
  console.log(
    `   ✓ conservation CLOSED: supply=${sim.supplyFinal.toLocaleString("en-US")} = ` +
      `treasury ${sim.treasuryFinal.toLocaleString("en-US")} + alchemist ${sim.alchemistPoolFinal.toLocaleString("en-US")} + ` +
      `Σ strain ${sim.strainsBalanceFinal.toLocaleString("en-US")} + external ${sim.externalPoolFinal.toLocaleString("en-US")} · ` +
      `burned ${sim.totalBurned.toLocaleString("en-US")} · maxAbsDrift=${sim.conservation.maxAbsDrift}` +
      (sim.externalExhaustedEpoch != null
        ? ` · onboarding exhausted ~epoch ${sim.externalExhaustedEpoch} (the honest ASSUMPTION #7 limit)`
        : "")
  );

  // ---- Beat 3: testnet views (read-only; network failures are warnings) ----
  console.log(`[3/4] Testnet views ${CONTRACT} (read-only)…`);
  let live = {};
  for (const [viewName, method, args] of [
    ["crucible_temp", "get_crucible_temp", {}],
    ["macro", "get_macro_state", {}],
    ["ft_total_supply", "ft_total_supply", {}],
    ["solvency", "get_global_solvency", {}],
    ["nft_metadata", "nft_metadata", {}],
    ["storage_balance_bounds", "storage_balance_bounds", {}],
  ]) {
    try {
      live[viewName] = await rpcView(method, args);
      console.log(`   ✓ ${viewName}: ${JSON.stringify(live[viewName]).slice(0, 110)}`);
    } catch (e) {
      console.warn(`   ⚠️ ${viewName} unreachable (${String(e.message).slice(0, 90)}) — warning, not an e2e failure`);
    }
  }
  if (live.solvency && live.solvency.solvent === false) {
    console.warn("   ⚠️ the live contract reports solvent=false — check the drift in gladi-kpi");
  }

  // ---- Beat 4: summary + snapshot artifact ----
  console.log("[4/4] Summary & snapshot artifact…");
  const snapshot = {
    timestamp: new Date().toISOString(),
    contract: CONTRACT,
    rpc: RPC,
    sim: {
      final_population: sim.aliveFinal,
      supply_final: sim.supplyFinal,
      total_burned: sim.totalBurned,
      total_rebate: sim.totalRebate,
      fever_pct: sim.feverPct,
      hypo_pct: sim.hypoPct,
      death_spiral: sim.deathSpiral,
      conservation_closes: sim.conservation?.closes ?? null,
      conservation_max_abs_drift: sim.conservation?.maxAbsDrift ?? null,
    },
    live: {
      crucible_temp: live.crucible_temp ?? null,
      ft_total_supply: live.ft_total_supply ?? null,
      solvent: live.solvency?.solvent ?? null,
      nft_metadata_spec: live.nft_metadata?.spec ?? null,
      storage_min: live.storage_balance_bounds?.min ?? null,
    },
  };
  const outPath = resolve(HERE, "../docs/demo-e2e-snapshot.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`   ✓ snapshot: ${outPath}`);
  console.log(`\n✅ demo:e2e PASSED — 4 beats complete (conservation closes exactly; $SNACC testnet has no monetary value)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
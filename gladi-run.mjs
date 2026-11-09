#!/usr/bin/env node
// gladi-run.mjs v5 — gladi runner (testnet only) for the contract with the sandbox clock (`advance_sandbox_clock`).
//
//   node scripts/gladi-run.mjs                 # PHASE 1: birth -> fusion -> TEE -> production -> dividend -> NFT (creates a new manifest)
//   node scripts/gladi-retry.mjs --execute --advance   # PHASE 2: age strains (sandbox clock) -> hostile / adopt / ft_transfer / lysis
//   node scripts/gladi-run.mjs --finale        # PHASE 3: burst + rebate (feed) -> Fever thermostat (G-12) -> solvency evidence
//   node scripts/gladi-kpi.mjs                 # regenerate reports/gladi-kpi.md
//
// Contract behavior used (after the W4..W10 audit bundle):
//  * incubate_strain: NEAR deposit == stake (birth supply comes from a real stake); deposit 0 = debit the caller's $SNACC balance.
//  * sandbox clock: `advance_sandbox_clock(hours)` (owner-only, <=720 hours/call, .testnet accounts only) shifts the
//    contract's now_sec -> BMR aging (Distressed/Insolvent) and epoch closing (24 hours) can be tested within minutes.
//  * advance_epoch only after EPOCH_DURATION_SEC (24 sandbox hours); dividend claims after the epoch is closed.
//  * vault sub-account name: s-<id>-<tag>.<contract-account>; splice lowers BMR by 15%; MAX_COLONY_SIZE=5 (divide/adopt).
//
// ID plan (deterministic after migrate, ids start at 1):
//   1 Extractor (G-01)  2 Fermenter  3 Synthesizer  4 Extractor-2 (hostile raider, sent to buyer = G-15)
//   5 Synthesizer-2 (TEE target; vector evidence/tee-vector-live.json contains strain_id 5)
//   6 child of divide(1)   7 small Fermenter (hostile target)   8 Extractor (adopter)   9 small Fermenter owned by buyer (adopt target -> lysis)
// $SNACC testnet has no monetary value. No hash = no claim.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const { Account, JsonRpcProvider, FailoverRpcProvider, KeyPairSigner } = createRequire(resolve(here, "../../x207/sdk/package.json"))("near-api-js");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const FINALE = has("finale");

const CONTRACT = process.env.CONTRACT_ID ?? "snacc-v001.testnet";
const BUYER = "x207-demo-buyer.testnet";
if (!CONTRACT.endsWith(".testnet")) throw new Error("testnet only");
const RPCS = [process.env.NEAR_RPC, "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"].filter(Boolean);
const providers = RPCS.map((url) => new JsonRpcProvider({ url }));
const provider = providers.length > 1 && FailoverRpcProvider ? new FailoverRpcProvider(providers) : providers[0];
const keyOf = (p) => { const j = JSON.parse(readFileSync(p, "utf8")); return j.secret_key ?? j.private_key; };   // never printed
const KEYS = {
  main: resolve(ROOT, ".secrets/snacc/snacc-v001.testnet.json"),
  buyer: resolve(ROOT, ".secrets/testnet-demo/testnet/x207-demo-buyer.testnet.json"),
};
const ACCOUNT_ID = { main: CONTRACT, buyer: BUYER };
const accounts = {};
const acct = (who) => (accounts[who] ??= new Account(ACCOUNT_ID[who], provider, KeyPairSigner.fromSecretKey(keyOf(KEYS[who]))));

const MANIFEST = resolve(process.env.GLADI_MANIFEST ?? resolve(ROOT, "reports/gladi-manifest.json"));
const v = JSON.parse(readFileSync(existsSync(resolve(here, "../evidence/tee-vector-live.json")) ? resolve(here, "../evidence/tee-vector-live.json") : resolve(ROOT, "reports/tee-vector-live.json"), "utf8"));
// TEE target = the strain_id embedded in the vector payload (apply_tee_mutation_zero_trust rejects ERR_PAYLOAD_STRAIN_MISMATCH).
const TEE = Number(JSON.parse(JSON.parse(v.raw_response_body).choices[0].message.content).strain_id);

let manifest;
if (FINALE) manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
else manifest = {
  owner: CONTRACT, signer: CONTRACT, counterparty: BUYER,
  strain_ids: [], token_ids: [], supply_before: null, temp_before: null,
  tee_chat_id: v.chat_id, svg_token_id: String(TEE), materialize_strain_id: TEE, actions: [],
};
const save = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = /timeout|timed out|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|50[234]|429|rate.?limit|UNKNOWN_TRANSACTION|failover/i;
const failuresOf = (r) => (r?.receipts_outcome ?? []).map((o) => o.outcome?.status).filter((s) => s?.Failure).map((s) => JSON.stringify(s.Failure));
const eventsOf = (r) => (r?.receipts_outcome ?? []).flatMap((o) => o.outcome?.logs ?? []).filter((l) => l.startsWith("EVENT_JSON:"))
  .flatMap((l) => { try { return JSON.parse(l.slice(11)).data ?? []; } catch { return []; } });

/** Send one tx; returns {hash, events}. Throws on failure (message = contract cause). */
async function send(who, methodName, args, deposit = 0n, gasT = 300n) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await acct(who).callFunctionRaw({ contractId: CONTRACT, methodName, args, deposit, gas: gasT * 10n ** 12n, waitUntil: "FINAL" });
      const fails = failuresOf(r);
      if (fails.length) { const e = new Error(fails.join("|")); e.hash = r.transaction?.hash; throw e; }
      return { hash: r.transaction.hash, events: eventsOf(r) };
    } catch (e) {
      last = e;
      const st = (e.transactionResult?.receipts_outcome ?? []).map((o) => o.outcome?.status).filter((s) => s?.Failure).map((s) => JSON.stringify(s.Failure)).join("|");
      if (st) { e.message = st; e.hash = e.hash ?? e.transactionResult?.transaction?.hash; throw e; }
      if (attempt < 3 && TRANSIENT.test(String(e.message))) { await sleep(3000 * attempt); continue; }
      throw e;
    }
  }
  throw last;
}
const view = async (method, args = {}) => {
  const r = await provider.query({ request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
};
const clip = (s, n = 140) => String(s).replace(/\s+/g, " ").slice(0, n);
let lastEvents = [];
/** One gladi step. deposits = the sequence of deposits to try (transmute diet depends on the zone). */
const step = async (kpi, label, method, args, { who = "main", deposits = [0n], gas = 300n, note } = {}) => {
  console.log(`▶ ${label}`);
  let lastErr = null, hash = null;
  for (const dep of deposits) {
    try {
      const r = await send(who, method, args, dep, gas);
      manifest.actions.push({ kpi, txHash: r.hash, signer: ACCOUNT_ID[who], note: note ?? label });
      lastEvents = r.events;
      console.log(`  ✓ ${kpi} tx=${r.hash}`);
      save();
      return r;
    } catch (e) {
      lastErr = e; hash = e.hash ?? hash;
      if (!/ERR_STAKE_DEPOSIT_MISMATCH/.test(String(e.message)) || deposits.length === 1) break;
    }
  }
  console.log(`  ✗ ${clip(lastErr?.message)}${hash ? ` (tx ${hash})` : ""}`);
  manifest.actions.push({ kpi, txHash: null, note: `FAILED: ${label} — ${clip(lastErr?.message, 110)}${hash ? ` (failed tx ${hash})` : ""}` });
  save();
  return null;
};
const evidence = async (label, method, args = {}, kpi = "EVIDENCE") => {
  try {
    const val = await view(method, args);
    manifest.actions.push({ kpi, txHash: null, note: `${label}: ${clip(JSON.stringify(val), 220)}` });
    console.log(`  ✓ ${label} (view) → ${clip(JSON.stringify(val), 120)}`);
    save();
    return val;
  } catch (e) {
    manifest.actions.push({ kpi, txHash: null, note: `${label}: FAILED view — ${clip(e.message, 100)}` });
    console.log(`  ✗ ${label} (view) — ${clip(e.message, 100)}`);
    save();
    return null;
  }
};
const inv = async (s, t) => BigInt(await view("get_inventory", { strain_id: s, token_id: t }));
const snaccOf = async (s) => { const m = /💎\s*(\d+)/.exec(Buffer.from(((await view("nft_token", { token_id: String(s) })).metadata?.media ?? "").split(",", 2)[1] ?? "", "base64").toString("utf8")); return m ? BigInt(m[1]) : null; };

const FE = 10n ** 13n;                 // nominal catalyst fee
const FEES = [(FE * 8n) / 10n, FE];    // transmute: diet -20% (Fever zone for E / Hypothermia for S) or nominal
const IGNIS = "mt:spore-ignis", LUMIN = "mt:spore-lumin";
const NEAR = 10n ** 24n;

async function preflight() {
  const clk = await view("get_sandbox_clock");
  console.log(`sandbox clock: enabled=${clk[0]} offset=${clk[1]}s now_sec=${clk[2]}`);
  if (!clk[0]) throw new Error("sandbox clock DISABLED — this contract is not a .testnet account / is an old build");
  const births = (await view("get_macro_state")).total_births;
  if (!FINALE && Number(births) !== 0) throw new Error(`state is not fresh (total_births=${births}); run migrate first or use a new contract`);
  const a = await provider.query({ request_type: "view_account", finality: "final", account_id: CONTRACT });
  console.log(`NEAR spendable ${CONTRACT}: ${(Number(BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n) / 1e24).toFixed(3)}`);
  return clk;
}

/** PHASE 1 — everything that does not wait for aging. */
async function phase1() {
  manifest.supply_before = await view("ft_total_supply");
  manifest.temp_before = await view("get_crucible_temp").catch(() => 0);
  if (TEE !== 5) console.log(`⚠ the TEE vector contains strain_id=${TEE} (id plan: 5) — id mismatch, regenerate the vector via tee-live-vector.mjs`);
  const inc = (kpi, label, role, stake, spores, who = "main") =>
    step(kpi, label, "incubate_strain", { role, initial_snacc_stake: String(stake), initial_spores: spores }, { who, deposits: [BigInt(stake)] });

  // 1) Birth 1..5 (NEAR deposit == stake).
  await inc("G-01", "incubate Extractor (strain 1)", "Extractor", 6n * NEAR / 10n, 10);
  await inc("PREP", "incubate Fermenter (strain 2)", "Fermenter", 25n * NEAR / 100n, 10);
  await inc("PREP", "incubate Synthesizer (strain 3)", "Synthesizer", 25n * NEAR / 100n, 10);
  await inc("PREP", "incubate Extractor-2 (strain 4 — raider hostile)", "Extractor", 25n * NEAR / 100n, 10);
  await inc("PREP", "incubate Synthesizer-2 (strain 5 — target TEE)", "Synthesizer", 3n * NEAR / 10n, 10);

  // 2) Feed -> ATP (G-03). Volume is still dormant (EN-108) so the effective fee is small, atp_minted is still > 0.
  await step("G-03", "feed strain 1 (2e23)", "feed_strain", { strain_id: 1, amount: "200000000000000000000000" });
  await step("G-03", "feed strain 2 (5e22)", "feed_strain", { strain_id: 2, amount: "50000000000000000000000" });
  await evidence("get_global_solvency post-feed", "get_global_solvency");
  await step("PREP", "allocate_atp (1/1/1 — organelle effects EN-119, cost 3 ATP)", "allocate_atp", { strain_id: 1, mitokondria: 1, nukleus: 1, lisosom: 1 });

  // 3) Fusion x2 BEFORE the production chain (transmute needs role F from strain 2, synthesize needs S from strain 3).
  await step("G-06", "splice (1 absorbs 2 — role E|F)", "splice_strains", { dominant_id: 1, absorbed_id: 2 });
  await step("G-06", "splice (1 absorbs 3 — role E|F|S)", "splice_strains", { dominant_id: 1, absorbed_id: 3 });

  // 4) TEE zero-trust: target = the vector payload's strain_id.
  await step("G-05", "register_attested_signer", "register_attested_signer", { pubkey_hex: v.tee_pubkey_hex, attested_at_sec: Math.floor(Date.now() / 1000) });
  await step("G-05", `commit_genome_experiment (strain ${TEE})`, "commit_genome_experiment", { strain_id: TEE, req_sha256_hex: v.req_sha256_hex });
  await step("G-05", `apply_tee_mutation_zero_trust (strain ${TEE})`, "apply_tee_mutation_zero_trust", {
    strain_id: TEE, req_sha256_hex: v.req_sha256_hex, raw_response_body: v.raw_response_body,
    signature_hex: v.signature_hex, tee_pubkey_hex: v.tee_pubkey_hex,
  });

  // 5) NEP-245 chain for strain 1 (G-04): extract -> transmute -> synthesize.
  await step("G-04", "extract ignis", "extract_spores", { strain_id: 1, spore_type: IGNIS, snacc_catalyst_fee: String(FE) }, { deposits: [FE] });
  await step("G-04", "extract lumin", "extract_spores", { strain_id: 1, spore_type: LUMIN, snacc_catalyst_fee: String(FE) }, { deposits: [FE] });
  for (let i = 0; i < 3 && (await inv(1, IGNIS)) >= 2n; i++) {
    await step("G-04", `transmute recipe1 (ignis→amalgam, iteration ${i + 1})`, "transmute_spores_to_enzyme", { strain_id: 1, spores_to_burn: 2, snacc_catalyst_fee: String(FE) }, { deposits: FEES });
  }
  if ((await inv(1, IGNIS)) < 2n) await step("G-04", "extract ignis (for recipe2)", "extract_spores", { strain_id: 1, spore_type: IGNIS, snacc_catalyst_fee: String(FE) }, { deposits: [FE] });
  // recipe2 (redactase = 1 ignis + 1 lumin) is only chosen when ignis < 2: use up an even amount of ignis first.
  const ig = await inv(1, IGNIS);
  if (ig > 1n) await step("G-04", `transmute use up ignis (${ig - (ig % 2n)})`, "transmute_spores_to_enzyme", { strain_id: 1, spores_to_burn: Number(ig - (ig % 2n)), snacc_catalyst_fee: String(FE) }, { deposits: FEES });
  if ((await inv(1, IGNIS)) === 0n) await step("G-04", "extract ignis (one, recipe2)", "extract_spores", { strain_id: 1, spore_type: IGNIS, snacc_catalyst_fee: String(FE) }, { deposits: [FE] });
  await step("G-04", "transmute recipe2 (ignis+lumin→redactase)", "transmute_spores_to_enzyme", { strain_id: 1, spores_to_burn: 2, snacc_catalyst_fee: String(FE) }, { deposits: FEES });
  await step("G-04", "synthesize elixir-homeostasis (amalgam+redactase)", "synthesize_elixir", { strain_id: 1, elixir_type: "mt:elixir-homeostasis", enzymes_to_burn: 2, snacc_catalyst_fee: String(FE) }, { deposits: FEES.concat([]).reverse() });
  for (const t of [IGNIS, LUMIN, "mt:enzyme-amalgam", "mt:enzyme-redactase", "mt:elixir-homeostasis"]) await evidence(`get_inventory ${t} (strain 1)`, "get_inventory", { strain_id: 1, token_id: t });

  // 6) NPC + burn + divide.
  await step("G-13", "npc_buy_spores (npc-extractor, 50)", "npc_buy_spores", { strain_id: 1, npc_id: "npc-extractor", buy_amount: 50 });
  await step("G-17", "ft_burn (10^15 $SNACC)", "ft_burn", { strain_id: 1, amount: "1000000000000000" });
  await step("G-09", "divide_strain (child = strain 6)", "divide_strain", { strain_id: 1 });

  // 7) Dividend: the TEE strain absorbs strain 1 -> E|F|S + inventories merge -> elixir-aether (TEE-trait) -> epoch 0 contribution.
  await step("G-06", `splice (${TEE} absorbs 1 — role E|F|S + inventories merged)`, "splice_strains", { dominant_id: TEE, absorbed_id: 1 });
  const ig5 = await inv(TEE, IGNIS), burn5 = ig5 - (ig5 % 2n);
  if (burn5 >= 2n) await step("G-04", `transmute use up ignis (strain ${TEE})`, "transmute_spores_to_enzyme", { strain_id: TEE, spores_to_burn: Number(burn5), snacc_catalyst_fee: String(FE) }, { deposits: FEES });
  await step("G-04", `extract cryo (strain ${TEE})`, "extract_spores", { strain_id: TEE, spore_type: "mt:spore-cryo", snacc_catalyst_fee: String(FE) }, { deposits: [FE] });
  await step("G-04", `extract cryo #2 (strain ${TEE})`, "extract_spores", { strain_id: TEE, spore_type: "mt:spore-cryo", snacc_catalyst_fee: String(FE) }, { deposits: [FE] });
  await step("G-04", `transmute cryo→synthase (strain ${TEE})`, "transmute_spores_to_enzyme", { strain_id: TEE, spores_to_burn: 2, snacc_catalyst_fee: String(FE) }, { deposits: FEES });
  await step("G-04", `synthesize ELIXIR-AETHER (strain ${TEE}, TEE-trait)`, "synthesize_elixir", { strain_id: TEE, elixir_type: "mt:elixir-aether", enzymes_to_burn: 3, snacc_catalyst_fee: String(FE) }, { deposits: FEES.slice().reverse() });
  await step("G-11", "synthesize_and_redeem_aether (epoch 0 dividend contribution)", "synthesize_and_redeem_aether", { strain_id: TEE, amount: "1" });

  // 8) M&A target reserves (age through the sandbox clock in phase 2): 7 (hostile), 8 (adopter), 9 (adopt -> lysis, owned by buyer).
  await inc("PREP", "incubate small Fermenter (strain 7 — hostile target)", "Fermenter", 5n * NEAR / 100n, 0);
  await inc("PREP", "incubate Extractor (strain 8 — adopter)", "Extractor", 5n * NEAR / 10n, 0);
  await inc("PREP", "incubate small Fermenter owned by buyer (strain 9 — adopt/lysis target)", "Fermenter", 5n * NEAR / 100n, 0, "buyer");
  manifest.strain_ids = [1, 2, 3, 4, 6, 7, 8, 9, TEE]; manifest.token_ids = [String(TEE), "1", "2", "3", "4", "6", "7", "8", "9"];

  // 9) Vault sub-account (deposit >= 20 mN) on the TEE strain (alive) + physical account evidence.
  await step("G-21", `materialize_subaccount (strain ${TEE}, deposit 20 mN)`, "materialize_subaccount", { strain_id: TEE }, { deposits: [2n * 10n ** 22n] });
  await sleep(4000);
  const vs = await view("get_strain", { strain_id: TEE });
  try {
    const acc = await provider.query({ request_type: "view_account", finality: "final", account_id: vs.vault_subaccount });
    manifest.actions.push({ kpi: "EVIDENCE", txHash: null, note: `vault ${vs.vault_subaccount} EXISTS on-chain (amount=${acc.amount})` });
    console.log(`  ✓ vault ${vs.vault_subaccount} exists on-chain`);
  } catch (e) {
    manifest.actions.push({ kpi: "EVIDENCE", txHash: null, note: `vault ${vs.vault_subaccount} NOT found on-chain: ${clip(e.message, 80)}` });
    console.log(`  ✗ vault ${vs.vault_subaccount} does not exist: ${clip(e.message, 80)}`);
  }

  // 10) NEP trio (G-22): nft_metadata · storage_deposit registration_only · nft_tokens.
  await evidence("nft_metadata (NEP-177)", "nft_metadata", {}, "G-22");
  await step("G-22", "storage_deposit registration_only=true (NEP-145, 5 mN)", "storage_deposit", { account_id: null, registration_only: true }, { deposits: [5n * 10n ** 21n] });
  await evidence("storage_balance_of (NEP-145)", "storage_balance_of", { account_id: CONTRACT }, "G-22");
  await evidence("nft_tokens (NEP-181, limit 5)", "nft_tokens", { from_index: null, limit: 5 }, "G-22");
  await evidence("nft_supply_for_owner (NEP-181)", "nft_supply_for_owner", { account_id: CONTRACT }, "G-22");

  // 11) NFT transplant: strain 4 (hostile raider) -> buyer.
  await step("G-15", "nft_transfer (strain 4 → x207-demo-buyer)", "nft_transfer", { receiver_id: BUYER, token_id: "4", memo: "gladi-transplant" }, { deposits: [1n] });

  // 12) Sandbox clock +24 hours -> close epoch 0 -> claim dividend (G-11) -> feed the TEE strain (alive until phase 2).
  const clk = await step("PREP", "advance_sandbox_clock(24)", "advance_sandbox_clock", { hours: 24 }, { gas: 100n });
  if (clk) await evidence("get_sandbox_clock after +24 hours", "get_sandbox_clock");
  await step("G-19", "advance_epoch (close epoch 0)", "advance_epoch", {});
  await step("G-11", `claim_industrial_dividend (strain ${TEE}, epoch 0)`, "claim_industrial_dividend", { strain_id: TEE, epoch: 0 });
  await step("PREP", `feed strain ${TEE} (caretaker; 1e23)`, "feed_strain", { strain_id: TEE, amount: "100000000000000000000000" });
  const solv = await evidence("get_global_solvency PHASE-1", "get_global_solvency");
  if (solv) manifest.solvency_final = solv;
  save();
  console.log(`\nPHASE 1 done: ${manifest.actions.filter((a) => a.txHash).length} tx. Next: node scripts/gladi-retry.mjs --execute --advance`);
}

/** PHASE 3 — after phase 2 (lysis releases the Nutrient Burst; the sandbox clock is already ~72 hours in). */
async function finale() {
  await evidence("get_sandbox_clock FINALE", "get_sandbox_clock");
  const m0 = await view("get_macro_state");
  await evidence("get_macro_state before burst/rebate (zone + burst + I-04 quota)", "get_macro_state");
  // Pick the caretaker strain: owned by the contract, alive (eff>0), role Extractor (for extract), enough balance.
  let K = null;
  for (const id of [Number(manifest.materialize_strain_id ?? TEE), 6, 8]) {
    const s = await view("get_strain", { strain_id: id }).catch(() => null);
    if (s && s.owner_id === CONTRACT && !/Liquidated|SplicedBurned/.test(JSON.stringify(s.status)) && s.effective_vitality > 0 && (s.role_mask & 1)) { K = id; break; }
  }
  if (K === null) { console.log("✗ no live caretaker strain with role Extractor"); manifest.actions.push({ kpi: "G-12", txHash: null, note: "FAILED: no live caretaker strain" }); save(); return; }
  console.log(`caretaker/heater strain: ${K}`);
  const bal = (await snaccOf(K)) ?? 0n;
  const feedAmt = (bal / 4n).toString();

  // (a) BURST + REBATE: temp ~ 0 (volume decays/sandbox) -> Hypothermia; the feed triggers a rebate from the treasury and uses the Nutrient Burst discount.
  const tempBefore = await view("get_crucible_temp");
  // Tag G-18: this tx moves the I-04 treasury quota (epoch_treasury_spent rises by the rebate/burst discount, <= epoch_treasury_initial).
  const fedA = await step("G-18", `feed strain ${K} (Hypothermia temp=${tempBefore} + Nutrient Burst active)`, "feed_strain", { strain_id: K, amount: feedAmt });
  const m1 = await view("get_macro_state");
  const ev = lastEvents.find((e) => e.kind === "fed");
  manifest.actions.push({ kpi: "EVIDENCE", txHash: null, note: `BURST+REBATE: burst_bps=${ev?.burst_bps ?? "?"} (burst_until=${m0.nutrient_burst_until}, epoch=${m0.current_epoch}) · epoch_treasury_spent ${m0.epoch_treasury_spent} → ${m1.epoch_treasury_spent} · zone ${m0.last_zone} → ${m1.last_zone}${fedA ? "" : " · feed FAILED"}` });
  console.log(`  burst_bps=${ev?.burst_bps} treasury_spent ${m0.epoch_treasury_spent} → ${m1.epoch_treasury_spent}`);

  // (b) FEVER THERMOSTAT (G-12): a large catalyst fee breaks dormancy and pushes V/supply > 610 mK; then a feed (ATP trace).
  const supply = BigInt(await view("ft_total_supply"));
  const acc = await provider.query({ request_type: "view_account", finality: "final", account_id: CONTRACT });
  const spendable = BigInt(acc.amount) - BigInt(acc.storage_usage) * 10n ** 19n;
  let heat = (supply * 85n) / 100n;
  if (heat > spendable - 6n * NEAR / 10n) heat = spendable - 6n * NEAR / 10n;
  await step("G-12", `extract_spores(${K}, ignis, fee ${heat} — Hypothermia→Fever, breaks dormancy EN-108)`, "extract_spores", { strain_id: K, spore_type: IGNIS, snacc_catalyst_fee: heat.toString() }, { deposits: [heat] });
  const fedB = await step("G-12", `feed_strain(${K}) — full fee after leaving dormancy, ATP trace`, "feed_strain", { strain_id: K, amount: (((await snaccOf(K)) ?? 0n) / 2n).toString() });
  const macro = await view("get_macro_state");
  const temp = await view("get_crucible_temp");
  const evB = lastEvents.find((e) => e.kind === "fed");
  if (fedB && evB) {
    manifest.bukti_feed = { volume_epoch: macro.volume_epoch, temp_mk: temp, feed_amount: String(evB.base_fee), atp_minted_min: Number(evB.atp_minted), ATP_VOLUME_SCALE: "600000000000000" };
  }
  manifest.actions.push({ kpi: "EVIDENCE", txHash: null, note: `G-12 FINALE: temp=${temp} mK, V_epoch=${macro.volume_epoch}, supply=${macro.total_snacc_supply}, burned=${macro.total_snacc_burned}, zone=${macro.last_zone}` });
  console.log(`  temp=${temp} mK zone=${macro.last_zone}`);
  const solv = await evidence("get_global_solvency FINAL", "get_global_solvency");
  if (solv) manifest.solvency_final = solv;
  await evidence("get_macro_state FINAL (lyses/mergers/births/divides)", "get_macro_state");
  save();
  console.log("\nPHASE 3 done. Next: node scripts/gladi-kpi.mjs");
}

try {
  await preflight();
  if (FINALE) await finale(); else await phase1();
  save();
  console.log(`\nMANIFEST: ${manifest.actions.filter((a) => a.txHash).length} tx recorded → ${MANIFEST}`);
} catch (e) { console.error(e); process.exit(1); }

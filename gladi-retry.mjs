#!/usr/bin/env node
/**
 * gladi-retry.mjs — gladi stage 2: 4 KPIs waiting for the BMR aging of the reserve strains (GLADI-5).
 *
 *   node scripts/gladi-retry.mjs                 # = --preflight: view calls ONLY (no transactions)
 *   node scripts/gladi-retry.mjs --preflight
 *   node scripts/gladi-retry.mjs --execute [--only G-07,G-08] [--wait] [--force]
 *   node scripts/gladi-retry.mjs --execute --advance   # advance the contract's sandbox clock (advance_sandbox_clock) until each window opens
 *   node scripts/gladi-retry.mjs --dry-run [--force] [--only G-07,...] [--advance]   # (may be combined with --execute)
 *
 * Contract time = block time + sandbox clock offset (`get_sandbox_clock`). Without --advance the script waits real time
 * (--wait); with --advance (.testnet accounts only, caller = owner) the clock is advanced as needed (+ rounded up to 1 hour).
 *
 * Plan (id plan of gladi-run v5):
 *   G-07 hostile   raider = strain 4 (owned by x207-demo-buyer; buyer signs) -> target strain 7
 *                  (Distressed window 1..=2000 effective_vitality); seller 95% -> owner of strain 7.
 *   G-02 ft_transfer 1000 yocto $SNACC from the contract account balance (payout of G-07/G-08/G-10) -> buyer.
 *   G-08 adopt     adopter = strain 8 -> target strain 9 (owned by buyer; Distressed window), book_value 100% to the old owner.
 *   G-10 lysis     harvest_starving_strain(9) when effective_vitality == 0 (Tier 3).
 *
 * Preflight computes the earliest UTC hour of each KPI from the contract formula (state.rs `effective_vitality`):
 *   bmr_eff = bmr_per_hour * (10000 - 1000*lisosom) / 10000        (LYSOSOME_BMR_BPS_PER_LEVEL = 1000)
 *   eff(t)  = vitality - floor((t - last_fed_sec)/3600) * bmr_eff   (saturating)
 *   Distressed: 1 <= eff <= 2000 (HOSTILE/ADOPT)  ·  Insolvent: eff == 0 (lysis)
 * then checks the strain $SNACC balance (book value + 15% premium), raider ATP (>= 10), NEAR gas balance,
 * colony capacity (adopt: colony_active_count < MAX_COLONY_SIZE=5), buyer storage registration (ft_transfer),
 * and the key files.
 *
 * --execute: each KPI runs only when its window is open (or waits with --wait),
 * the result + tx hash is written to reports/gladi-manifest.json and then gladi-kpi.mjs is re-run so
 * reports/gladi-kpi.md contains status + hash. Credentials are read via a file PATH; keys are never printed.
 * Before sending, each signer's public key is matched against the on-chain access key (view_access_key).
 * Transactions are signed locally (hash computed locally): if the broadcast times out, the status is polled by that
 * hash so a tx that actually succeeded is still recorded; network errors are retried (max 3 attempts).
 *
 * --dry-run: builds EXACTLY each action (signer, receiver, method, args JSON, deposit, gas), prints it,
 * matches method/param names/#[payable] against contracts/snacc/src/lib.rs, and verifies that the key's
 * public key matches the account's access key (view_access_key). NO tx, the manifest is not written, the report
 * is not regenerated. Time windows are only reported (they never block the action display).
 *
 * --selftest --selftest-account <id.testnet> --selftest-key <path> [--selftest-fail]: tests the
 * sign + broadcast + parsing + manifest-writing path with ONE harmless tx
 * (storage_deposit registration_only of the test account itself). REQUIRES GLADI_MANIFEST=<temporary copy>;
 * forbidden for the buyer/contract accounts. --selftest-fail adds a harmless failing tx (ft_transfer with zero balance).
 *
 * $SNACC testnet has no monetary value. No hash = no claim.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const opt = (f) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = has("dry-run");
const SELFTEST = has("selftest");
const EXECUTE = has("execute") || DRY || SELFTEST;
if (EXECUTE && has("preflight")) { console.error("choose one: --preflight OR --execute/--dry-run/--selftest"); process.exit(2); }

// ---------- constants (Number Dictionary / state.rs) ----------
const CONTRACT = process.env.CONTRACT_ID ?? "snacc-v001.testnet";
const BUYER = "x207-demo-buyer.testnet";
const KEY_MAIN = resolve(ROOT, ".secrets/snacc/snacc-v001.testnet.json");
const KEY_BUYER = resolve(ROOT, ".secrets/testnet-demo/testnet/x207-demo-buyer.testnet.json");
const DEFAULT_MANIFEST = resolve(ROOT, "reports/gladi-manifest.json");
const MANIFEST = resolve(process.env.GLADI_MANIFEST ?? DEFAULT_MANIFEST);   // override ONLY for tests (temporary copy)
const LIB_RS = resolve(here, "../contracts/snacc/src/lib.rs");
// Id plan of gladi-run v5: 4 = raider (owned by buyer), 7 = hostile target, 8 = adopter, 9 = adopt target (owned by buyer) then lysis.
const RAIDER_HOSTILE = 4, TARGET_HOSTILE = 7, ADOPTER = 8, TARGET_ADOPT = 9, TARGET_LYSIS = 9;
const DISTRESSED_MAX = 2000;            // I-09: 1..=2000
const LYSOSOME_BPS_PER_LEVEL = 1000;    // EN-119
const HOSTILE_PREMIUM_BPS = 1500, BPS = 10000, HOSTILE_SELLER_BPS = 9500, MOLECULE_FLOOR_PRICE = 1n;
const HOSTILE_ATP_COST = 10n;           // EN-116/§13a: pay_atp(raider, 10) in hostile_takeover_splice
const MAX_COLONY_SIZE = 5;
const FT_AMOUNT = "1000";
const STORAGE_REG_YOCTO = 5n * 10n ** 21n;   // STORAGE_DEPOSIT_MILLINEAR = 5 (state.rs)
const SAFETY_SEC = 120;                 // margin over the clock boundary (block timestamp vs local clock)
const MIN_SPENDABLE_NEAR = 10n ** 23n;  // 0.1 NEAR per signer account (gas 100-200 Tgas << this)
const TOKENS = ["mt:spore-ignis", "mt:spore-cryo", "mt:spore-lumin", "mt:enzyme-amalgam", "mt:enzyme-redactase",
  "mt:enzyme-synthase", "mt:elixir-homunculus", "mt:elixir-homeostasis", "mt:elixir-aether"];
const RPCS = [process.env.NEAR_RPC, "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"].filter(Boolean);
const SIGNERS = { main: { id: CONTRACT, key: KEY_MAIN }, buyer: { id: BUYER, key: KEY_BUYER } };

// ---------- actions (the only place args/deposit/gas are built — used by --execute AND --dry-run) ----------
const A = {
  hostile: (nonce) => ({ kpi: "G-07", who: "buyer", method: "hostile_takeover_splice", args: { raider_strain_id: RAIDER_HOSTILE, distressed_target_id: TARGET_HOSTILE, expected_target_nonce: nonce }, deposit: 0n, gas: 200n,
    rule: `caller == raider(${RAIDER_HOSTILE}).owner_id (buyer); non-payable; raider.atp >= 10; raider.snacc >= book×115%` }),
  clock: (hours) => ({ kpi: "PREP", who: "main", method: "advance_sandbox_clock", args: { hours }, deposit: 0n, gas: 100n,
    rule: "owner-only (contract account); 1 <= hours <= 720; active only on .testnet accounts; non-payable" }),
  register: () => ({ kpi: "PREP", who: "main", method: "storage_deposit", args: { account_id: BUYER, registration_only: true }, deposit: STORAGE_REG_YOCTO, gas: 100n,
    rule: "#[payable]; a new registration requires >= 5 milliNEAR (excess is refunded)" }),
  ft: () => ({ kpi: "G-02", who: "main", method: "ft_transfer", args: { receiver_id: BUYER, amount: FT_AMOUNT, memo: "gladi-retry" }, deposit: 1n, gas: 100n,
    rule: "#[payable] requires EXACTLY 1 yocto; receiver registered for storage; sender account balance >= amount" }),
  adopt: (nonce) => ({ kpi: "G-08", who: "main", method: "adopt", args: { target_id: TARGET_ADOPT, raider_strain_id: ADOPTER, expected_target_nonce: nonce }, deposit: 0n, gas: 200n,
    rule: `caller == raider(${ADOPTER}).owner_id; non-payable; caller colony < ${MAX_COLONY_SIZE}; raider.snacc >= book (no premium)` }),
  lysis: () => ({ kpi: "G-10", who: "main", method: "harvest_starving_strain", args: { target_id: TARGET_LYSIS }, deposit: 0n, gas: 150n,
    rule: "permissionless; non-payable; requires effective_vitality == 0" }),
};
const fmtAction = (a) => `${a.kpi} signer=${SIGNERS[a.who].id} receiver=${CONTRACT} method=${a.method} args=${JSON.stringify(a.args)} deposit=${a.deposit}yocto gas=${a.gas}Tgas`;

/** Split Rust parameters at the top-level comma (ignore commas inside <> () []). */
function splitParams(s) {
  const out = []; let d = 0, cur = "";
  for (const ch of s) {
    if ("<([".includes(ch)) d++; else if (">)]".includes(ch)) d--;
    if (ch === "," && d === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
let LIB_SRC;
/** Match an action against the lib.rs ABI: method name, param names (exact), #[payable] vs deposit. Returns the list of errors. */
function abiCheck(a) {
  if (LIB_SRC === undefined) LIB_SRC = existsSync(LIB_RS) ? readFileSync(LIB_RS, "utf8") : null;
  if (!LIB_SRC) return { errs: [], note: "lib.rs not found — ABI check skipped" };
  const re = new RegExp(`pub fn ${a.method}\\s*\\(([^)]*)\\)`);
  const m = re.exec(LIB_SRC);
  if (!m) return { errs: [`method ${a.method} does not exist in lib.rs`] };
  const params = splitParams(m[1]).filter((p) => !/^&?\s*(mut\s+)?self\b/.test(p))
    .map((p) => ({ name: p.split(":")[0].trim(), optional: /:\s*Option\s*</.test(p) }));
  // attributes right above the fn (walk up while the line starts with #[ or //)
  const lines = LIB_SRC.slice(0, m.index).split("\n"); lines.pop();
  let payable = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("#[") || t.startsWith("//")) { if (t.startsWith("#[payable]")) payable = true; } else break;
  }
  const errs = [];
  const keys = Object.keys(a.args);
  for (const k of keys) if (!params.some((p) => p.name === k)) errs.push(`arg "${k}" is not in the signature (${params.map((p) => p.name).join(", ")})`);
  for (const p of params) if (!p.optional && !keys.includes(p.name)) errs.push(`required param "${p.name}" is not provided`);
  if (a.deposit > 0n && !payable) errs.push(`deposit ${a.deposit} but the method is NOT #[payable]`);
  return { errs, params: params.map((p) => p.name + (p.optional ? "?" : "")), payable };
}

// ---------- RPC (view-only; fallback between hosts) ----------
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    for (let a = 0; a < 2; a++) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "gladi-retry", method, params }) });
        const j = await res.json();
        if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
        return j.result;
      } catch (e) { last = e; await new Promise((r) => setTimeout(r, 300)); }
    }
  }
  throw last;
}
async function view(method, args = {}, account = CONTRACT) {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}
const viewAccount = (id) => rpc("query", { request_type: "view_account", finality: "final", account_id: id });
const headMs = async () => Number((await rpc("block", { finality: "final" })).header.timestamp) / 1e6;
/** Contract time (seconds) = final block time + sandbox clock offset (`get_sandbox_clock` -> [enabled, offset, now_sec]); fallback block time. */
async function contractNowSec() {
  try { const c = await view("get_sandbox_clock"); if (Array.isArray(c) && Number.isFinite(Number(c[2]))) return { now: Number(c[2]), offset: Number(c[1]), enabled: !!c[0] }; } catch { /* old contract without a sandbox clock */ }
  return { now: Math.floor((await headMs()) / 1000), offset: 0, enabled: false };
}

// ---------- BMR time model ----------
const bmrEff = (s) => Math.floor((s.bmr_per_hour * Math.max(0, BPS - s.organel.lisosom * LYSOSOME_BPS_PER_LEVEL)) / BPS);
const effAt = (s, tSec) => Math.max(0, s.vitality - Math.floor(Math.max(0, tSec - s.last_fed_sec) / 3600) * bmrEff(s));
/** First hour h (since last_fed) where eff<=2000 (Distressed) and eff==0 (Insolvent); null when BMR is 0 (does not age). */
function windows(s) {
  const b = bmrEff(s);
  if (b <= 0) return null;
  const hD = s.vitality <= DISTRESSED_MAX ? 0 : Math.ceil((s.vitality - DISTRESSED_MAX) / b);
  const h0 = Math.ceil(s.vitality / b);
  const hLastDistressed = Math.floor((s.vitality - 1) / b);   // last eff >= 1
  return {
    b, distressedFrom: s.last_fed_sec + hD * 3600 + SAFETY_SEC,
    insolventFrom: s.last_fed_sec + h0 * 3600 + SAFETY_SEC,
    windowOpensExact: s.last_fed_sec + hD * 3600, windowClosesExact: s.last_fed_sec + h0 * 3600,
    hasWindow: hD <= hLastDistressed,
  };
}
const iso = (sec) => new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, "Z");

// ---------- state ----------
async function strainState(id) {
  const s = await view("get_strain", { strain_id: id });
  const tok = await view("nft_token", { token_id: String(id) });
  const m = tok.metadata?.media ?? "";
  const svg = m.startsWith("data:image/svg+xml;base64,") ? Buffer.from(m.split(",", 2)[1], "base64").toString("utf8") : "";
  // strain $SNACC balance: there is no strain-balance view -> read from the on-chain SVG (svg.rs: "💎 {snacc} | ⚡ {atp} ATP", full u128).
  // A read failure is only a WARNING (the contract itself enforces the balance); do not block --execute.
  const bal = /💎\s*(\d+)\s*\|\s*⚡\s*(\d+)\s*ATP/.exec(svg);
  let inv = 0n;
  for (const t of TOKENS) inv += BigInt(await view("get_inventory", { strain_id: id, token_id: t }));
  return { ...s, snacc: bal ? BigInt(bal[1]) : null, svgAtp: bal ? BigInt(bal[2]) : null, inventoryUnits: inv, token_owner: tok.owner_id };
}
const book = (s) => (s.snacc ?? 0n) + s.inventoryUnits * MOLECULE_FLOOR_PRICE;
const dead = (s) => /Liquidated|SplicedBurned/.test(JSON.stringify(s.status));
async function spendable(id) {
  const a = await viewAccount(id);
  return BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n;
}

async function snapshot() {
  const { now, offset, enabled } = await contractNowSec();
  const st = {};
  for (const id of [RAIDER_HOSTILE, TARGET_HOSTILE, ADOPTER, TARGET_ADOPT]) st[id] = await strainState(id);
  const colony = await view("get_colony", { owner_id: CONTRACT });
  const ftMain = BigInt(await view("ft_balance_of", { account_id: CONTRACT }));
  const buyerReg = await view("storage_balance_of", { account_id: BUYER });
  const [spMain, spBuyer] = await Promise.all([spendable(CONTRACT), spendable(BUYER)]);
  return { now, offset, sandbox: enabled, st, colony, ftMain, buyerReg, spMain, spBuyer, keys: { main: existsSync(KEY_MAIN), buyer: existsSync(KEY_BUYER) } };
}

/** Compute each KPI's status from the snapshot. earliest = epoch seconds (null = not scheduled), blockers = non-time reasons. */
function plan(S) {
  const { now, st } = S;
  const out = {};
  // G-07 hostile
  {
    const raider = st[RAIDER_HOSTILE], tgt = st[TARGET_HOSTILE], w = windows(tgt), bl = [], warn = [];
    if (raider.owner_id !== BUYER) bl.push(`raider ${RAIDER_HOSTILE} is owned by ${raider.owner_id}, not ${BUYER} (the signer must own the raider)`);
    if (dead(raider)) bl.push(`raider ${RAIDER_HOSTILE} status ${JSON.stringify(raider.status)}`);
    if (dead(tgt)) bl.push(`target ${TARGET_HOSTILE} status ${JSON.stringify(tgt.status)} (already SplicedBurned/Liquidated)`);
    if (raider.snacc === null || tgt.snacc === null) warn.push("strain balance is not readable from the SVG (svg.rs format changed?) — check the balance manually; the contract enforces it");
    const payment = (book(tgt) * BigInt(BPS + HOSTILE_PREMIUM_BPS)) / BigInt(BPS);
    if (raider.snacc !== null && raider.snacc < payment) bl.push(`raider balance ${raider.snacc} < payment ${payment} (book ${book(tgt)} ×115%)`);
    if (BigInt(raider.atp_balance ?? 0) < HOSTILE_ATP_COST) bl.push(`raider ATP ${raider.atp_balance} < ${HOSTILE_ATP_COST} (ERR_NOT_ENOUGH_ATP)`);
    if (tgt.pending_callbacks !== 0) bl.push(`target pending_callbacks=${tgt.pending_callbacks}`);
    if (!S.keys.buyer) bl.push(`buyer key file does not exist (${KEY_BUYER})`);
    if (S.spBuyer < MIN_SPENDABLE_NEAR) bl.push(`buyer spendable NEAR ${S.spBuyer} < ${MIN_SPENDABLE_NEAR}`);
    if (!w) bl.push("target effective BMR is 0 — does not age");
    else if (!w.hasWindow) bl.push("target jumps over the Distressed window (eff drops from >2000 straight to 0)");
    out["G-07"] = { earliest: w?.distressedFrom ?? null, closes: w?.windowClosesExact ?? null, blockers: bl, warnings: warn, payment, sellerPayout: (payment * BigInt(HOSTILE_SELLER_BPS)) / BigInt(BPS), w };
  }
  // G-08 adopt
  {
    const adopter = st[ADOPTER], tgt = st[TARGET_ADOPT], w = windows(tgt), bl = [], warn = [];
    if (adopter.owner_id !== CONTRACT) bl.push(`adopter ${ADOPTER} is owned by ${adopter.owner_id}, not ${CONTRACT}`);
    if (dead(adopter)) bl.push(`adopter status ${JSON.stringify(adopter.status)}`);
    if (dead(tgt)) bl.push(`target ${TARGET_ADOPT} status ${JSON.stringify(tgt.status)}`);
    if (adopter.snacc === null || tgt.snacc === null) warn.push("strain balance is not readable from the SVG — check the balance manually; the contract enforces it");
    if (adopter.snacc !== null && adopter.snacc < book(tgt)) bl.push(`adopter balance ${adopter.snacc} < target book_value ${book(tgt)}`);
    if (S.colony.length >= MAX_COLONY_SIZE) bl.push(`colony ${CONTRACT} active=${S.colony.length} >= MAX_COLONY_SIZE=${MAX_COLONY_SIZE} (ERR_COLONY_FULL); drops to ${S.colony.length - 1} if G-07 burns strain ${TARGET_HOSTILE} first`);
    if (tgt.pending_callbacks !== 0) bl.push(`target pending_callbacks=${tgt.pending_callbacks}`);
    if (!S.keys.main) bl.push(`key file for ${CONTRACT} does not exist`);
    if (S.spMain < MIN_SPENDABLE_NEAR) bl.push(`spendable NEAR of ${CONTRACT} ${S.spMain} < ${MIN_SPENDABLE_NEAR}`);
    if (!w) bl.push("target effective BMR is 0 — does not age");
    else if (!w.hasWindow) bl.push("target jumps over the Distressed window");
    out["G-08"] = { earliest: w?.distressedFrom ?? null, closes: w?.windowClosesExact ?? null, blockers: bl, warnings: warn, bookValue: book(tgt), w };
  }
  // G-10 lysis
  {
    const tgt = st[TARGET_LYSIS], w = windows(tgt), bl = [];
    if (dead(tgt)) bl.push(`target ${TARGET_LYSIS} status ${JSON.stringify(tgt.status)}`);
    if (!S.keys.main) bl.push(`key file for ${CONTRACT} does not exist`);
    if (S.spMain < MIN_SPENDABLE_NEAR) bl.push(`spendable NEAR of ${CONTRACT} ${S.spMain} < ${MIN_SPENDABLE_NEAR}`);
    if (!w) bl.push("target effective BMR is 0 — does not age");
    out["G-10"] = { earliest: w?.insolventFrom ?? null, closes: null, blockers: bl, warnings: [], bounty: (tgt.snacc ?? 0n) / 10n, w };
  }
  // G-02 ft_transfer: needs an account balance >= 1000 (appears after the G-07 payout / adopt G-08 / bounty G-10)
  {
    const bl = [];
    if (!S.buyerReg) bl.push(`${BUYER} is not registered for storage yet — --execute will storage_deposit(registration_only) first (extra tx, deposit 5 mN)`);
    if (!S.keys.main) bl.push(`key file for ${CONTRACT} does not exist`);
    if (S.spMain < MIN_SPENDABLE_NEAR) bl.push(`spendable NEAR of ${CONTRACT} < ${MIN_SPENDABLE_NEAR}`);
    const have = S.ftMain >= BigInt(FT_AMOUNT);
    const src = ["G-07", "G-08", "G-10"].map((k) => out[k].earliest).filter((x) => x !== null);
    out["G-02"] = { earliest: have ? now : src.length ? Math.min(...src) : null, closes: null, blockers: bl, warnings: [], ftMain: S.ftMain, via: have ? "account balance is already sufficient" : "after the first balance-producing KPI (G-07/G-08/G-10)" };
  }
  return out;
}

// ---------- print preflight ----------
function printPreflight(S, P) {
  const { now, st } = S;
  console.log(`# gladi-retry PREFLIGHT (view-only, no transactions) — contract ${CONTRACT}`);
  console.log(`Now (contract time = final block + sandbox clock offset ${S.offset ?? 0}s${S.sandbox ? ", sandbox ACTIVE" : ""}): ${iso(now)}\n`);
  console.log("## Strain state (view get_strain + SVG balance)");
  for (const id of [RAIDER_HOSTILE, TARGET_HOSTILE, ADOPTER, TARGET_ADOPT]) {
    const s = st[id], w = windows(s);
    const calc = effAt(s, now);
    console.log(`- strain ${id} · owner=${s.owner_id} · status=${JSON.stringify(s.status)} · role_mask=${s.role_mask} · gen=${s.generation}`);
    console.log(`    vitality=${s.vitality} bmr/hour=${s.bmr_per_hour} lisosom=${s.organel.lisosom} bmr_eff=${bmrEff(s)} last_fed=${iso(s.last_fed_sec)}`);
    console.log(`    eff_vitality(view)=${s.effective_vitality} eff(computed)=${calc}${calc === s.effective_vitality ? " ✓" : " ≠ (block time / view difference)"} · nonce=${s.state_nonce} pending_cb=${s.pending_callbacks} · atp=${s.atp_balance}${s.svgAtp !== null && s.svgAtp !== BigInt(s.atp_balance) ? ` (SVG ${s.svgAtp} ≠ view!)` : ""}`);
    console.log(`    strain $SNACC balance=${s.snacc} · inventory=${s.inventoryUnits} units · book_value=${book(s)}`);
    if (w && id !== RAIDER_HOSTILE) console.log(`    Distressed window: ${iso(w.windowOpensExact)} → ${iso(w.windowClosesExact)} (eff 1..2000) · Insolvent (eff=0) starts ${iso(w.windowClosesExact)}`);
  }
  console.log(`\n## Balances & prerequisites`);
  console.log(`- ft_balance_of(${CONTRACT}) = ${S.ftMain} (G-02 needs >= ${FT_AMOUNT})`);
  console.log(`- storage ${BUYER}: ${S.buyerReg ? "registered" : "NOT registered"}`);
  console.log(`- spendable NEAR: ${CONTRACT}=${S.spMain} yocto · ${BUYER}=${S.spBuyer} yocto (min ${MIN_SPENDABLE_NEAR})`);
  console.log(`- active colony ${CONTRACT}: ${S.colony.length} strains (id ${S.colony.map((c) => c.strain_id).join(",")}) · MAX_COLONY_SIZE=${MAX_COLONY_SIZE}`);
  console.log(`- key files: ${CONTRACT}=${S.keys.main ? "present" : "MISSING"} · ${BUYER}=${S.keys.buyer ? "present" : "MISSING"} (contents are not read in preflight)`);
  console.log(`\n## Earliest UTC time of each KPI (window boundary + ${SAFETY_SEC}s margin)`);
  const rows = [
    ["G-07", `hostile ${RAIDER_HOSTILE}→${TARGET_HOSTILE}`, P["G-07"], P["G-07"].blockers.length ? "" : `payment≈${P["G-07"].payment} seller95%≈${P["G-07"].sellerPayout}`],
    ["G-02", `ft_transfer ${FT_AMOUNT}→${BUYER}`, P["G-02"], P["G-02"].via],
    ["G-08", `adopt ${ADOPTER}→${TARGET_ADOPT}`, P["G-08"], `book_value=${P["G-08"].bookValue}`],
    ["G-10", `lysis ${TARGET_LYSIS}`, P["G-10"], `bounty10%≈${P["G-10"].bounty}`],
  ];
  for (const [id, label, p, note] of rows) {
    const when = p.earliest === null ? "NOT SCHEDULED" : iso(p.earliest);
    const state = p.earliest === null ? "" : p.earliest <= now ? (p.closes && now >= p.closes ? " [WINDOW ALREADY CLOSED]" : " [READY NOW]") : ` [+${((p.earliest - now) / 3600).toFixed(1)} hours]`;
    console.log(`${id}  ${when}${state}  — ${label}${note ? ` · ${note}` : ""}`);
    if (p.closes) console.log(`        window closes: ${iso(p.closes)}`);
    for (const b of p.blockers) console.log(`        ⚠ ${b}`);
    for (const b of p.warnings ?? []) console.log(`        ℹ ${b}`);
  }
  console.log(`\nNote: G-02 = the earliest hour the account balance >= ${FT_AMOUNT} (follows the first balance-producing KPI). Preflight does NOT send transactions.`);
}

// ---------- signing runtime (near-api-js from the x207 sdk) ----------
const readKey = (p) => { const j = JSON.parse(readFileSync(p, "utf8")); const k = j.secret_key ?? j.private_key; if (!k) throw new Error("key field is missing"); return k; };   // never printed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = /timeout|timed out|time out|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|50[234]|429|rate.?limit|UNKNOWN_TRANSACTION|failover/i;

function runtime() {
  const near = createRequire(resolve(here, "../../x207/sdk/package.json"))("near-api-js");
  const { Account, JsonRpcProvider, FailoverRpcProvider, KeyPairSigner, actions, encodeTransaction, baseEncode } = near;
  const providers = RPCS.map((url) => new JsonRpcProvider({ url }));
  const provider = providers.length > 1 && FailoverRpcProvider ? new FailoverRpcProvider(providers) : providers[0];
  const accounts = {}, signers = {};
  const signerOf = (who) => (signers[who] ??= KeyPairSigner.fromSecretKey(readKey(SIGNERS[who].key)));
  const account = (who) => (accounts[who] ??= new Account(SIGNERS[who].id, provider, signerOf(who)));
  const keyOk = {};

  /** Does the key's public key == the account's on-chain access key? (view_access_key). Returns {ok,msg}. Does not print key contents. */
  async function verifyKey(who, action) {
    const S = SIGNERS[who];
    if (!existsSync(S.key)) return (keyOk[who] = { ok: false, msg: `key file does not exist (${S.key})` });
    let pk;
    try { pk = (await signerOf(who).getPublicKey()).toString(); }
    catch { return (keyOk[who] = { ok: false, msg: "key format is invalid (contents not printed)" }); }
    try {
      const k = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: S.id, public_key: pk });
      const perm = k.permission === "FullAccess" ? "FullAccess" : `FunctionCall${JSON.stringify(k.permission?.FunctionCall ?? k.permission)}`;
      let ok = true, extra = "";
      if (k.permission !== "FullAccess") {
        const fc = k.permission?.FunctionCall;
        ok = !!fc && fc.receiver_id === CONTRACT;
        if (!ok) extra = " ← not FullAccess and receiver ≠ contract";
        if (ok && action && action.deposit > 0n) { ok = false; extra = " ← a FunctionCall key must not carry a deposit"; }
      }
      return (keyOk[who] = { ok, pk, msg: `public key ${pk} matches on-chain access key ${S.id} · permission=${perm} · nonce=${k.nonce}${extra}` });
    } catch (e) {
      return (keyOk[who] = { ok: false, pk, msg: `public key ${pk} NOT found as an access key of ${S.id}: ${String(e.message).slice(0, 120)}` });
    }
  }

  const outcomeFailures = (r) => [...new Set([r.status, ...(r.receipts_outcome ?? []).map((o) => o.outcome?.status)].filter((s) => s?.Failure).map((s) => JSON.stringify(s.Failure)))];
  const successValue = (r) => {
    const v = r?.status?.SuccessValue;
    if (v === undefined || v === "") return "(empty)";
    try { return Buffer.from(v, "base64").toString("utf8").slice(0, 240); } catch { return "(unreadable)"; }
  };
  const txHashOf = (signed) => baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());

  // manifest loaded once; written atomically (tmp + rename)
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const saveManifest = () => { writeFileSync(MANIFEST + ".tmp", JSON.stringify(manifest, null, 2), "utf8"); renameSync(MANIFEST + ".tmp", MANIFEST); };
  const FINAL = (kpi) => manifest.actions.some((a) => a.kpi === kpi && a.txHash && a.signer);

  /** Send one action. Returns the hash (success) or null. DRY: only prints. */
  async function send(a) {
    const sid = SIGNERS[a.who].id;
    console.log(`${DRY ? "[DRY-RUN] " : ""}▶ ${fmtAction(a)}`);
    const abi = abiCheck(a);
    if (DRY) {
      console.log(`    contract rule: ${a.rule ?? "-"}`);
      console.log(`    ABI lib.rs: ${abi.note ?? `params=(${abi.params?.join(", ")}) payable=${abi.payable}`} → ${abi.errs.length ? "✗ " + abi.errs.join("; ") : "matches ✓"}`);
      const kk = await verifyKey(a.who, a);
      console.log(`    key ${sid}: ${kk.ok ? "✓" : "✗"} ${kk.msg}`);
      DRY_ERRORS.push(...abi.errs.map((e) => `${a.kpi}/${a.method}: ${e}`), ...(kk.ok ? [] : [`${a.kpi}: key ${sid}: ${kk.msg}`]));
      return "DRY";
    }
    const fail = (msg, hash) => {
      manifest.actions.push({ kpi: a.kpi, txHash: null, note: `FAILED gladi-retry ${a.method}: ${msg}${hash ? ` (tx ${hash})` : ""}`.slice(0, 400) });
      saveManifest();
      console.log(`  ✗ ${a.kpi} ${msg}${hash ? ` (tx ${hash})` : ""}`);
      return null;
    };
    if (abi.errs.length) return fail(`ABI mismatch: ${abi.errs.join("; ")}`);
    const kk = keyOk[a.who] ?? (await verifyKey(a.who, a));
    if (!kk.ok) return fail(`key ${sid} rejected: ${kk.msg}`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      let hash = null;
      try {
        const signed = await account(a.who).createSignedTransaction({ receiverId: CONTRACT, actions: [actions.functionCall(a.method, a.args, a.gas * 10n ** 12n, a.deposit)] });
        try { hash = txHashOf(signed); } catch { /* local hash is optional */ }
        let r;
        try { r = await provider.sendTransactionUntil(signed, "FINAL"); }
        catch (e) {
          if (!hash || !TRANSIENT.test(String(e.message ?? e))) throw e;
          console.log(`  … broadcast error (${String(e.message).slice(0, 80)}); polling status of tx ${hash}`);
          for (let i = 0; i < 12 && !r; i++) { await sleep(5000); try { r = await provider.viewTransactionStatus({ txHash: hash, accountId: sid, waitUntil: "FINAL" }); } catch { /* not indexed yet */ } }
          if (!r) throw e;
        }
        const fails = outcomeFailures(r);
        const realHash = r.transaction?.hash ?? hash;
        if (fails.length) return fail(fails.join("|").slice(0, 300), realHash);
        manifest.actions = manifest.actions.filter((x) => !(x.kpi === a.kpi && !x.txHash && /^waiting/.test(x.note ?? "")));
        manifest.actions.push({ kpi: a.kpi, txHash: realHash, signer: sid, note: `gladi-retry ${a.method} ${new Date().toISOString().slice(0, 16)}Z` });
        saveManifest();
        console.log(`  ✓ ${a.kpi} tx=${realHash} status=SUCCESS result=${successValue(r)}${hash && hash !== realHash ? ` (⚠ local hash ${hash} ≠ RPC)` : ""}`);
        return realHash;
      } catch (e) {
        const msg = String(e.message ?? e).slice(0, 200);
        if (attempt < 3 && TRANSIENT.test(msg)) { console.log(`  … attempt ${attempt} network error: ${msg.slice(0, 80)}; retrying`); await sleep(4000 * attempt); continue; }
        return fail(msg, hash);
      }
    }
    return null;
  }
  return { verifyKey, send, manifest, FINAL, saveManifest, provider };
}
const DRY_ERRORS = [];

// ---------- execute / dry-run ----------
async function execute() {
  const rt = runtime();
  const { send, FINAL, manifest } = rt;
  const only = opt("only")?.split(",").map((x) => x.trim().toUpperCase());
  if (MANIFEST !== DEFAULT_MANIFEST) console.log(`ℹ manifest override (GLADI_MANIFEST): ${MANIFEST}`);
  if (DRY) console.log(`# gladi-retry DRY-RUN — contract ${CONTRACT} · no tx, manifest is not written · time windows are only reported\n`);
  else for (const who of ["main", "buyer"]) { const k = await rt.verifyKey(who); console.log(`key ${SIGNERS[who].id}: ${k.ok ? "✓" : "✗"} ${k.msg}`); }

  const winNote = (p, now) => p.earliest === null ? "NOT SCHEDULED"
    : p.closes && now >= p.closes ? `WINDOW ALREADY CLOSED (${iso(p.closes)})`
    : now >= p.earliest ? `open (since ${iso(p.earliest)}${p.closes ? `, closes ${iso(p.closes)}` : ""})` : `not open yet (earliest ${iso(p.earliest)}, +${((p.earliest - now) / 3600).toFixed(1)} hours)`;
  const due = async (kpi) => {
    for (;;) {
      const S = await snapshot(), P = plan(S);
      const p = P[kpi];
      for (const w of p.warnings ?? []) console.log(`ℹ ${kpi} warning: ${w}`);
      // --advance: advance the contract's sandbox clock (owner-only, <=720 hours/call) until the KPI window opens.
      // Only for KPIs that wait for aging (not G-02); the clock shifts ALL strains, so it is only advanced as needed.
      const needHours = has("advance") && S.sandbox && kpi !== "G-02" && p.earliest !== null && S.now < p.earliest
        ? Math.min(720, Math.ceil((p.earliest - S.now) / 3600)) : 0;
      if (DRY) {
        console.log(`ℹ ${kpi} window: ${winNote(p, S.now)} · current blockers: ${p.blockers.length ? p.blockers.join("; ") : "none"}`);
        if (needHours > 0) await send(A.clock(needHours));
        return { S, P };
      }
      if (p.blockers.some((b) => !/not registered for storage/.test(b))) { console.log(`⏭ ${kpi} BLOCKED: ${p.blockers.join("; ")}`); return null; }
      if (p.earliest === null) { console.log(`⏭ ${kpi} not scheduled`); return null; }
      if (p.closes && S.now >= p.closes) { console.log(`⏭ ${kpi} window already closed (${iso(p.closes)})`); return null; }
      if (S.now >= p.earliest) return { S, P };
      if (needHours > 0) {
        console.log(`⏩ ${kpi}: sandbox clock +${needHours} hours (earliest window ${iso(p.earliest)}, contract now ${iso(S.now)})`);
        if (!(await send(A.clock(needHours)))) return null;
        continue;
      }
      if (!has("wait")) { console.log(`⏭ ${kpi} not time yet (earliest ${iso(p.earliest)}; use --wait to wait)`); return null; }
      const wait = Math.min(300, p.earliest - S.now + 5);
      console.log(`⏳ ${kpi} waiting for ${iso(p.earliest)} (checking again in ${wait}s)`);
      await sleep(wait * 1000);
    }
  };
  const want = (kpi) => (!only || only.includes(kpi)) && (DRY || has("force") || !FINAL(kpi) || (console.log(`⏭ ${kpi} already has a tx in the manifest (use --force to repeat)`), false));
  const g02 = async (S) => {
    if (S.ftMain < BigInt(FT_AMOUNT) && !DRY) { console.log(`⏭ G-02 account balance ${S.ftMain} < ${FT_AMOUNT} (run the balance-producing KPIs first)`); return; }
    if (S.ftMain < BigInt(FT_AMOUNT)) console.log(`ℹ G-02 [simulation] current account balance ${S.ftMain} < ${FT_AMOUNT}; it will be filled by the G-07/G-08/G-10 payout — the action is still printed`);
    if (!S.buyerReg) await send(A.register());
    await send(A.ft());
  };

  if (want("G-07")) {
    const c = await due("G-07");
    if (c) await send(A.hostile(c.S.st[TARGET_HOSTILE].state_nonce));
  }
  if (want("G-02")) {
    const c = await due("G-02");
    if (c) await g02(c.S);
  }
  if (want("G-08")) {
    const c = await due("G-08");
    if (c) await send(A.adopt(c.S.st[TARGET_ADOPT].state_nonce));
  }
  if (want("G-10")) {
    const c = await due("G-10");
    if (c) await send(A.lysis());
  }
  // G-02 a second time if a new balance appears after G-08/G-10 and G-02 has no tx yet
  if (!DRY && want("G-02")) await g02(await snapshot());

  if (DRY) {
    console.log(`\n# DRY-RUN finished: ${DRY_ERRORS.length ? `${DRY_ERRORS.length} ERRORS\n- ${DRY_ERRORS.join("\n- ")}` : "ABI + keys all match (0 errors)"}`);
    process.exit(DRY_ERRORS.length ? 1 : 0);
  }
  if (MANIFEST !== DEFAULT_MANIFEST) { console.log("\nℹ manifest override → gladi-kpi.md is not regenerated"); return; }
  console.log("\n▶ regenerating reports/gladi-kpi.md (gladi-kpi.mjs)");
  try { console.log(execFileSync(process.execPath, [resolve(here, "gladi-kpi.mjs")], { encoding: "utf8" }).split("\n").slice(-4).join("\n")); }
  catch (e) { console.log(String(e.stdout ?? e.message).split("\n").slice(-6).join("\n")); }   // exits 1 if any FAIL — the report is still written
}

// ---------- selftest: the sign + broadcast + parse + manifest path with a harmless tx ----------
async function selftest() {
  const id = opt("selftest-account"), key = opt("selftest-key");
  if (!id || !key) throw new Error("--selftest needs --selftest-account <id> --selftest-key <path>");
  if ([BUYER, CONTRACT].includes(id)) throw new Error("selftest must not use the buyer/contract accounts");
  if (MANIFEST === DEFAULT_MANIFEST) throw new Error("selftest requires GLADI_MANIFEST=<temporary copy>, not the real manifest");
  SIGNERS.test = { id, key: resolve(key) };
  const rt = runtime();
  const k = await rt.verifyKey("test"); console.log(`key ${id}: ${k.ok ? "✓" : "✗"} ${k.msg}`);
  if (!k.ok) throw new Error("test key does not match");
  const n0 = rt.manifest.actions.length;
  const reg = { kpi: "SELFTEST", who: "test", method: "storage_deposit", args: { account_id: id, registration_only: true }, deposit: STORAGE_REG_YOCTO, gas: 100n, rule: "storage registration of the test account itself" };
  const h = await rt.send(reg);
  const bal = await view("storage_balance_of", { account_id: id });
  console.log(`view storage_balance_of(${id}) = ${JSON.stringify(bal)} → ${h && bal ? "registered ✓" : "NOT YET ✗"}`);
  let hFail;
  if (has("selftest-fail")) {
    hFail = await rt.send({ kpi: "SELFTEST", who: "test", method: "ft_transfer", args: { receiver_id: id, amount: "1000", memo: "selftest" }, deposit: 1n, gas: 100n });
    console.log(`failure path: send returned ${hFail} (expected null)`);
  }
  const added = JSON.parse(readFileSync(MANIFEST, "utf8")).actions.slice(n0);
  console.log(`test manifest: +${added.length} entries →\n${added.map((x) => "  " + JSON.stringify(x)).join("\n")}`);
  if (!h || !bal || (has("selftest-fail") && hFail !== null)) process.exit(1);
}

// ---------- main ----------
try {
  if (SELFTEST) await selftest();
  else if (EXECUTE) await execute();
  else { const S = await snapshot(); printPreflight(S, plan(S)); }
} catch (e) { console.error(`gladi-retry: ${String(e.message ?? e)}`); process.exit(1); }

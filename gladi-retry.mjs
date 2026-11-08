#!/usr/bin/env node
/**
 * gladi-retry.mjs — gladi tahap-2: 4 KPI yang menunggu penuaan BMR strain cadangan (GLADI-5).
 *
 *   node scripts/gladi-retry.mjs                 # = --preflight: HANYA view call (tanpa transaksi)
 *   node scripts/gladi-retry.mjs --preflight
 *   node scripts/gladi-retry.mjs --execute [--only G-07,G-08] [--wait] [--force]
 *
 * Rencana (manifest `RENCANA GLADI-RETRY`):
 *   G-07 hostile   raider = strain 4 (milik x207-demo-buyer; buyer menandatangani) -> target strain 6
 *                  (jendela Distressed 1..=2000 effective_vitality); seller 95% -> pemilik strain 6.
 *   G-02 ft_transfer 1000 yocto $SNACC dari saldo akun kontrak (hasil payout G-07/G-08/G-10) -> buyer.
 *   G-08 adopt     adopter = strain 7 -> target strain 8 (jendela Distressed), book_value 100% ke pemilik lama.
 *   G-10 lisis     harvest_starving_strain(8) saat effective_vitality == 0 (Tier 3).
 *
 * Preflight menghitung jam UTC paling awal tiap KPI dari rumus kontrak (state.rs `effective_vitality`):
 *   bmr_eff = bmr_per_hour * (10000 - 1000*lisosom) / 10000        (LYSOSOME_BMR_BPS_PER_LEVEL = 1000)
 *   eff(t)  = vitality - floor((t - last_fed_sec)/3600) * bmr_eff   (saturating)
 *   Distressed: 1 <= eff <= 2000 (HOSTILE/ADOPT)  ·  Insolvent: eff == 0 (lisis)
 * lalu memeriksa saldo $SNACC strain (book value + premium 15%), saldo NEAR gas, kapasitas koloni
 * (adopt: colony_active_count < MAX_COLONY_SIZE=5), registrasi storage buyer (ft_transfer), dan file kunci.
 *
 * --execute: tiap KPI dijalankan hanya bila jendelanya sudah terbuka (atau tunggu dengan --wait),
 * hasil + tx hash ditulis ke reports/gladi-manifest.json lalu gladi-kpi.mjs dijalankan ulang agar
 * reports/gladi-kpi.md memuat status + hash. Kredensial dibaca lewat PATH file; kunci tak pernah dicetak.
 * $SNACC testnet tanpa nilai uang. Tanpa hash = tanpa klaim.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const opt = (f) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : undefined; };
const EXECUTE = has("execute");
if (EXECUTE && has("preflight")) { console.error("pilih salah satu: --preflight ATAU --execute"); process.exit(2); }

// ---------- konstanta (Kamus Angka / state.rs) ----------
const CONTRACT = process.env.CONTRACT_ID ?? "snacc-v001.testnet";
const BUYER = "x207-demo-buyer.testnet";
const KEY_MAIN = resolve(ROOT, ".secrets/snacc/snacc-v001.testnet.json");
const KEY_BUYER = resolve(ROOT, ".secrets/testnet-demo/testnet/x207-demo-buyer.testnet.json");
const MANIFEST = resolve(ROOT, "reports/gladi-manifest.json");
const RAIDER_HOSTILE = 4, TARGET_HOSTILE = 6, ADOPTER = 7, TARGET_ADOPT = 8, TARGET_LYSIS = 8;
const DISTRESSED_MAX = 2000;            // I-09: 1..=2000
const LYSOSOME_BPS_PER_LEVEL = 1000;    // EN-119
const HOSTILE_PREMIUM_BPS = 1500, BPS = 10000, HOSTILE_SELLER_BPS = 9500, MOLECULE_FLOOR_PRICE = 1n;
const MAX_COLONY_SIZE = 5;
const FT_AMOUNT = "1000";
const SAFETY_SEC = 120;                 // margin atas batas jam (timestamp blok vs jam lokal)
const MIN_SPENDABLE_NEAR = 10n ** 23n;  // 0,1 NEAR per akun penanda tangan (gas 100-200 Tgas << ini)
const TOKENS = ["mt:spore-ignis", "mt:spore-cryo", "mt:spore-lumin", "mt:enzyme-amalgam", "mt:enzyme-redactase",
  "mt:enzyme-synthase", "mt:elixir-homunculus", "mt:elixir-homeostasis", "mt:elixir-aether"];
const RPCS = [process.env.NEAR_RPC, "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"].filter(Boolean);

// ---------- RPC (view-only; fallback antar host) ----------
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

// ---------- model waktu BMR ----------
const bmrEff = (s) => Math.floor((s.bmr_per_hour * Math.max(0, BPS - s.organel.lisosom * LYSOSOME_BPS_PER_LEVEL)) / BPS);
const effAt = (s, tSec) => Math.max(0, s.vitality - Math.floor(Math.max(0, tSec - s.last_fed_sec) / 3600) * bmrEff(s));
/** Jam ke-h (sejak last_fed) pertama eff<=2000 (Distressed) dan eff==0 (Insolvent); null bila BMR 0 (tak menua). */
function windows(s) {
  const b = bmrEff(s);
  if (b <= 0) return null;
  const hD = s.vitality <= DISTRESSED_MAX ? 0 : Math.ceil((s.vitality - DISTRESSED_MAX) / b);
  const h0 = Math.ceil(s.vitality / b);
  const hLastDistressed = Math.floor((s.vitality - 1) / b);   // eff terakhir >= 1
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
  const bal = /💎\s*(\d+)/.exec(svg);                 // saldo $SNACC strain (SVG on-chain; tak ada view saldo-strain)
  let inv = 0n;
  for (const t of TOKENS) inv += BigInt(await view("get_inventory", { strain_id: id, token_id: t }));
  return { ...s, snacc: bal ? BigInt(bal[1]) : null, inventoryUnits: inv, token_owner: tok.owner_id };
}
const book = (s) => (s.snacc ?? 0n) + s.inventoryUnits * MOLECULE_FLOOR_PRICE;
const dead = (s) => /Liquidated|SplicedBurned/.test(JSON.stringify(s.status));
async function spendable(id) {
  const a = await viewAccount(id);
  return BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n;
}

async function snapshot() {
  const nowMs = await headMs();
  const now = Math.floor(nowMs / 1000);
  const st = {};
  for (const id of [RAIDER_HOSTILE, TARGET_HOSTILE, ADOPTER, TARGET_ADOPT]) st[id] = await strainState(id);
  const colony = await view("get_colony", { owner_id: CONTRACT });
  const ftMain = BigInt(await view("ft_balance_of", { account_id: CONTRACT }));
  const buyerReg = await view("storage_balance_of", { account_id: BUYER });
  const [spMain, spBuyer] = await Promise.all([spendable(CONTRACT), spendable(BUYER)]);
  return { now, st, colony, ftMain, buyerReg, spMain, spBuyer, keys: { main: existsSync(KEY_MAIN), buyer: existsSync(KEY_BUYER) } };
}

/** Hitung status tiap KPI dari snapshot. earliest = detik epoch (null = tak terjadwal), blockers = alasan non-waktu. */
function plan(S) {
  const { now, st } = S;
  const out = {};
  // G-07 hostile
  {
    const raider = st[RAIDER_HOSTILE], tgt = st[TARGET_HOSTILE], w = windows(tgt), bl = [];
    if (raider.owner_id !== BUYER) bl.push(`raider ${RAIDER_HOSTILE} milik ${raider.owner_id}, bukan ${BUYER} (penanda tangan harus pemilik raider)`);
    if (dead(raider)) bl.push(`raider ${RAIDER_HOSTILE} status ${JSON.stringify(raider.status)}`);
    if (dead(tgt)) bl.push(`target ${TARGET_HOSTILE} status ${JSON.stringify(tgt.status)} (sudah SplicedBurned/Liquidated)`);
    if (raider.snacc === null || tgt.snacc === null) bl.push("saldo strain tak terbaca dari SVG");
    const payment = (book(tgt) * BigInt(BPS + HOSTILE_PREMIUM_BPS)) / BigInt(BPS);
    if (raider.snacc !== null && raider.snacc < payment) bl.push(`saldo raider ${raider.snacc} < payment ${payment} (book ${book(tgt)} ×115%)`);
    if (tgt.pending_callbacks !== 0) bl.push(`target pending_callbacks=${tgt.pending_callbacks}`);
    if (!S.keys.buyer) bl.push(`file kunci buyer tak ada (${KEY_BUYER})`);
    if (S.spBuyer < MIN_SPENDABLE_NEAR) bl.push(`NEAR spendable buyer ${S.spBuyer} < ${MIN_SPENDABLE_NEAR}`);
    if (!w) bl.push("BMR efektif target 0 — tidak menua");
    else if (!w.hasWindow) bl.push("target melompati jendela Distressed (eff turun dari >2000 langsung 0)");
    out["G-07"] = { earliest: w?.distressedFrom ?? null, closes: w?.windowClosesExact ?? null, blockers: bl, payment, sellerPayout: (payment * BigInt(HOSTILE_SELLER_BPS)) / BigInt(BPS), w };
  }
  // G-08 adopt
  {
    const adopter = st[ADOPTER], tgt = st[TARGET_ADOPT], w = windows(tgt), bl = [];
    if (adopter.owner_id !== CONTRACT) bl.push(`adopter ${ADOPTER} milik ${adopter.owner_id}, bukan ${CONTRACT}`);
    if (dead(adopter)) bl.push(`adopter status ${JSON.stringify(adopter.status)}`);
    if (dead(tgt)) bl.push(`target ${TARGET_ADOPT} status ${JSON.stringify(tgt.status)}`);
    if (adopter.snacc !== null && adopter.snacc < book(tgt)) bl.push(`saldo adopter ${adopter.snacc} < book_value target ${book(tgt)}`);
    if (S.colony.length >= MAX_COLONY_SIZE) bl.push(`koloni ${CONTRACT} aktif=${S.colony.length} >= MAX_COLONY_SIZE=${MAX_COLONY_SIZE} (ERR_COLONY_FULL); turun ke ${S.colony.length - 1} bila G-07 membakar strain ${TARGET_HOSTILE} lebih dulu`);
    if (tgt.pending_callbacks !== 0) bl.push(`target pending_callbacks=${tgt.pending_callbacks}`);
    if (!S.keys.main) bl.push(`file kunci ${CONTRACT} tak ada`);
    if (S.spMain < MIN_SPENDABLE_NEAR) bl.push(`NEAR spendable ${CONTRACT} ${S.spMain} < ${MIN_SPENDABLE_NEAR}`);
    if (!w) bl.push("BMR efektif target 0 — tidak menua");
    else if (!w.hasWindow) bl.push("target melompati jendela Distressed");
    out["G-08"] = { earliest: w?.distressedFrom ?? null, closes: w?.windowClosesExact ?? null, blockers: bl, bookValue: book(tgt), w };
  }
  // G-10 lisis
  {
    const tgt = st[TARGET_LYSIS], w = windows(tgt), bl = [];
    if (dead(tgt)) bl.push(`target ${TARGET_LYSIS} status ${JSON.stringify(tgt.status)}`);
    if (!S.keys.main) bl.push(`file kunci ${CONTRACT} tak ada`);
    if (S.spMain < MIN_SPENDABLE_NEAR) bl.push(`NEAR spendable ${CONTRACT} ${S.spMain} < ${MIN_SPENDABLE_NEAR}`);
    if (!w) bl.push("BMR efektif target 0 — tidak menua");
    out["G-10"] = { earliest: w?.insolventFrom ?? null, closes: null, blockers: bl, bounty: (tgt.snacc ?? 0n) / 10n, w };
  }
  // G-02 ft_transfer: butuh saldo akun >= 1000 (muncul setelah payout G-07 / adopt G-08 / bounty G-10)
  {
    const bl = [];
    if (!S.buyerReg) bl.push(`${BUYER} belum terdaftar storage — --execute akan storage_deposit(registration_only) lebih dulu (tx tambahan, deposit 5 mN)`);
    if (!S.keys.main) bl.push(`file kunci ${CONTRACT} tak ada`);
    if (S.spMain < MIN_SPENDABLE_NEAR) bl.push(`NEAR spendable ${CONTRACT} < ${MIN_SPENDABLE_NEAR}`);
    const have = S.ftMain >= BigInt(FT_AMOUNT);
    const src = ["G-07", "G-08", "G-10"].map((k) => out[k].earliest).filter((x) => x !== null);
    out["G-02"] = { earliest: have ? now : src.length ? Math.min(...src) : null, closes: null, blockers: bl, ftMain: S.ftMain, via: have ? "saldo akun sudah cukup" : "setelah KPI penghasil saldo pertama (G-07/G-08/G-10)" };
  }
  return out;
}

// ---------- cetak preflight ----------
function printPreflight(S, P) {
  const { now, st } = S;
  console.log(`# gladi-retry PREFLIGHT (view-only, tanpa transaksi) — kontrak ${CONTRACT}`);
  console.log(`Sekarang (final block): ${iso(now)}\n`);
  console.log("## State strain (view get_strain + SVG saldo)");
  for (const id of [RAIDER_HOSTILE, TARGET_HOSTILE, ADOPTER, TARGET_ADOPT]) {
    const s = st[id], w = windows(s);
    const calc = effAt(s, now);
    console.log(`- strain ${id} · owner=${s.owner_id} · status=${JSON.stringify(s.status)} · role_mask=${s.role_mask} · gen=${s.generation}`);
    console.log(`    vitality=${s.vitality} bmr/jam=${s.bmr_per_hour} lisosom=${s.organel.lisosom} bmr_eff=${bmrEff(s)} last_fed=${iso(s.last_fed_sec)}`);
    console.log(`    eff_vitality(view)=${s.effective_vitality} eff(hitung)=${calc}${calc === s.effective_vitality ? " ✓" : " ≠ (selisih jam blok/ view)"} · nonce=${s.state_nonce} pending_cb=${s.pending_callbacks}`);
    console.log(`    saldo $SNACC strain=${s.snacc} · inventori=${s.inventoryUnits} unit · book_value=${book(s)}`);
    if (w && id !== RAIDER_HOSTILE) console.log(`    jendela Distressed: ${iso(w.windowOpensExact)} → ${iso(w.windowClosesExact)} (eff 1..2000) · Insolvent (eff=0) mulai ${iso(w.windowClosesExact)}`);
  }
  console.log(`\n## Saldo & prasyarat`);
  console.log(`- ft_balance_of(${CONTRACT}) = ${S.ftMain} (G-02 butuh >= ${FT_AMOUNT})`);
  console.log(`- storage ${BUYER}: ${S.buyerReg ? "terdaftar" : "BELUM terdaftar"}`);
  console.log(`- NEAR spendable: ${CONTRACT}=${S.spMain} yocto · ${BUYER}=${S.spBuyer} yocto (min ${MIN_SPENDABLE_NEAR})`);
  console.log(`- koloni aktif ${CONTRACT}: ${S.colony.length} strain (id ${S.colony.map((c) => c.strain_id).join(",")}) · MAX_COLONY_SIZE=${MAX_COLONY_SIZE}`);
  console.log(`- file kunci: ${CONTRACT}=${S.keys.main ? "ada" : "TIDAK ADA"} · ${BUYER}=${S.keys.buyer ? "ada" : "TIDAK ADA"} (isi tak dibaca di preflight)`);
  console.log(`\n## Jam UTC paling awal tiap KPI (batas jendela + ${SAFETY_SEC}s margin)`);
  const rows = [
    ["G-07", `hostile ${RAIDER_HOSTILE}→${TARGET_HOSTILE}`, P["G-07"], P["G-07"].blockers.length ? "" : `payment≈${P["G-07"].payment} seller95%≈${P["G-07"].sellerPayout}`],
    ["G-02", `ft_transfer ${FT_AMOUNT}→${BUYER}`, P["G-02"], P["G-02"].via],
    ["G-08", `adopt ${ADOPTER}→${TARGET_ADOPT}`, P["G-08"], `book_value=${P["G-08"].bookValue}`],
    ["G-10", `lisis ${TARGET_LYSIS}`, P["G-10"], `bounty10%≈${P["G-10"].bounty}`],
  ];
  for (const [id, label, p, note] of rows) {
    const when = p.earliest === null ? "TIDAK TERJADWAL" : iso(p.earliest);
    const state = p.earliest === null ? "" : p.earliest <= now ? (p.closes && now >= p.closes ? " [JENDELA SUDAH TUTUP]" : " [SIAP SEKARANG]") : ` [+${((p.earliest - now) / 3600).toFixed(1)} jam]`;
    console.log(`${id}  ${when}${state}  — ${label}${note ? ` · ${note}` : ""}`);
    if (p.closes) console.log(`        jendela tutup: ${iso(p.closes)}`);
    for (const b of p.blockers) console.log(`        ⚠ ${b}`);
  }
  console.log(`\nCatatan: G-02 = jam paling awal saldo akun >= ${FT_AMOUNT} (mengikuti KPI penghasil saldo pertama). Preflight TIDAK mengirim transaksi.`);
}

// ---------- execute ----------
async function execute() {
  const { Account, JsonRpcProvider, KeyPairSigner } = createRequire(resolve(here, "../../x207/sdk/package.json"))("near-api-js");
  const provider = new JsonRpcProvider({ url: RPCS[0] });
  const keyOf = (p) => { const j = JSON.parse(readFileSync(p, "utf8")); return j.secret_key ?? j.private_key; };   // tak pernah dicetak
  const acct = (id, p) => new Account(id, provider, KeyPairSigner.fromSecretKey(keyOf(p)));
  const main = acct(CONTRACT, KEY_MAIN), buyer = acct(BUYER, KEY_BUYER);
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const only = opt("only")?.split(",").map((x) => x.trim().toUpperCase());
  const FINAL = (kpi) => manifest.actions.some((a) => a.kpi === kpi && a.txHash && a.signer);

  const send = async (signer, signerId, kpi, methodName, args, deposit = 0n, gasTgas = 150n) => {
    console.log(`▶ ${kpi} ${signerId} → ${methodName} ${JSON.stringify(args)}`);
    try {
      const r = await signer.callFunctionRaw({ contractId: CONTRACT, methodName, args, deposit, gas: gasTgas * 10n ** 12n, waitUntil: "FINAL" });
      const fails = [r.status, ...(r.receipts_outcome ?? []).map((o) => o.outcome?.status)].filter((s) => s?.Failure).map((s) => JSON.stringify(s.Failure));
      if (fails.length) throw Object.assign(new Error(fails.join("|")), { failed: true });
      const hash = r.transaction.hash;
      manifest.actions = manifest.actions.filter((a) => !(a.kpi === kpi && !a.txHash && /^menunggu/.test(a.note ?? "")));
      manifest.actions.push({ kpi, txHash: hash, signer: signerId, note: `gladi-retry ${methodName} ${new Date().toISOString().slice(0, 16)}Z` });
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
      console.log(`  ✓ ${kpi} tx=${hash}`);
      return hash;
    } catch (e) {
      const msg = String(e.message ?? e).slice(0, 200);
      manifest.actions.push({ kpi, txHash: null, note: `GAGAL gladi-retry ${methodName}: ${msg}` });
      writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
      console.log(`  ✗ ${kpi} ${msg}`);
      return null;
    }
  };
  const due = async (kpi) => {
    for (;;) {
      const S = await snapshot(), P = plan(S);
      const p = P[kpi];
      if (p.blockers.some((b) => !/belum terdaftar storage/.test(b))) { console.log(`⏭ ${kpi} DIBLOKIR: ${p.blockers.join("; ")}`); return null; }
      if (p.earliest === null) { console.log(`⏭ ${kpi} tak terjadwal`); return null; }
      if (p.closes && S.now >= p.closes) { console.log(`⏭ ${kpi} jendela sudah tutup (${iso(p.closes)})`); return null; }
      if (S.now >= p.earliest) return { S, P };
      if (!has("wait")) { console.log(`⏭ ${kpi} belum waktunya (paling awal ${iso(p.earliest)}; pakai --wait untuk menunggu)`); return null; }
      const wait = Math.min(300, p.earliest - S.now + 5);
      console.log(`⏳ ${kpi} menunggu ${iso(p.earliest)} (cek lagi ${wait}s)`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  };
  const want = (kpi) => (!only || only.includes(kpi)) && (has("force") || !FINAL(kpi) || (console.log(`⏭ ${kpi} sudah punya tx di manifest (pakai --force untuk ulang)`), false));

  if (want("G-07")) {
    const c = await due("G-07");
    if (c) await send(buyer, BUYER, "G-07", "hostile_takeover_splice", { raider_strain_id: RAIDER_HOSTILE, distressed_target_id: TARGET_HOSTILE, expected_target_nonce: c.S.st[TARGET_HOSTILE].state_nonce }, 0n, 200n);
  }
  if (want("G-02")) {
    const c = await due("G-02");
    if (c && c.S.ftMain >= BigInt(FT_AMOUNT)) {
      if (!c.S.buyerReg) await send(main, CONTRACT, "PREP", "storage_deposit", { account_id: BUYER, registration_only: true }, 5n * 10n ** 21n, 100n);
      await send(main, CONTRACT, "G-02", "ft_transfer", { receiver_id: BUYER, amount: FT_AMOUNT, memo: "gladi-retry" }, 1n, 100n);
    } else if (c) console.log(`⏭ G-02 saldo akun ${c.S.ftMain} < ${FT_AMOUNT} (jalankan KPI penghasil saldo dulu)`);
  }
  if (want("G-08")) {
    const c = await due("G-08");
    if (c) await send(main, CONTRACT, "G-08", "adopt", { target_id: TARGET_ADOPT, raider_strain_id: ADOPTER, expected_target_nonce: c.S.st[TARGET_ADOPT].state_nonce }, 0n, 200n);
  }
  if (want("G-10")) {
    const c = await due("G-10");
    if (c) await send(main, CONTRACT, "G-10", "harvest_starving_strain", { target_id: TARGET_LYSIS }, 0n, 150n);
  }
  // G-02 kedua kali bila saldo baru muncul setelah G-08/G-10 dan G-02 belum punya tx
  if (want("G-02")) {
    const S = await snapshot();
    if (S.ftMain >= BigInt(FT_AMOUNT)) {
      if (!S.buyerReg) await send(main, CONTRACT, "PREP", "storage_deposit", { account_id: BUYER, registration_only: true }, 5n * 10n ** 21n, 100n);
      await send(main, CONTRACT, "G-02", "ft_transfer", { receiver_id: BUYER, amount: FT_AMOUNT, memo: "gladi-retry" }, 1n, 100n);
    }
  }
  console.log("\n▶ regenerasi reports/gladi-kpi.md (gladi-kpi.mjs)");
  try { console.log(execFileSync(process.execPath, [resolve(here, "gladi-kpi.mjs")], { encoding: "utf8" }).split("\n").slice(-4).join("\n")); }
  catch (e) { console.log(String(e.stdout ?? e.message).split("\n").slice(-6).join("\n")); }   // exit 1 bila ada FAIL — laporan tetap tertulis
}

// ---------- main ----------
try {
  if (EXECUTE) await execute();
  else { const S = await snapshot(); printPreflight(S, plan(S)); }
} catch (e) { console.error(`gladi-retry: ${String(e.message ?? e)}`); process.exit(1); }

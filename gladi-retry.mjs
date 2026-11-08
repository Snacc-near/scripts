#!/usr/bin/env node
/**
 * gladi-retry.mjs — gladi tahap-2: 4 KPI yang menunggu penuaan BMR strain cadangan (GLADI-5).
 *
 *   node scripts/gladi-retry.mjs                 # = --preflight: HANYA view call (tanpa transaksi)
 *   node scripts/gladi-retry.mjs --preflight
 *   node scripts/gladi-retry.mjs --execute [--only G-07,G-08] [--wait] [--force]
 *   node scripts/gladi-retry.mjs --dry-run [--force] [--only G-07,...]   # (boleh bersama --execute)
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
 * lalu memeriksa saldo $SNACC strain (book value + premium 15%), ATP raider (>= 10), saldo NEAR gas,
 * kapasitas koloni (adopt: colony_active_count < MAX_COLONY_SIZE=5), registrasi storage buyer (ft_transfer),
 * dan file kunci.
 *
 * --execute: tiap KPI dijalankan hanya bila jendelanya sudah terbuka (atau tunggu dengan --wait),
 * hasil + tx hash ditulis ke reports/gladi-manifest.json lalu gladi-kpi.mjs dijalankan ulang agar
 * reports/gladi-kpi.md memuat status + hash. Kredensial dibaca lewat PATH file; kunci tak pernah dicetak.
 * Sebelum mengirim, public key tiap penanda tangan dicocokkan dengan access key on-chain (view_access_key).
 * Transaksi ditandatangani sendiri (hash dihitung lokal): bila broadcast time-out, status dipoll lewat hash
 * itu supaya tx yang sebenarnya sukses tetap tercatat; galat jaringan di-retry (maks 3 percobaan).
 *
 * --dry-run: membangun PERSIS tiap aksi (signer, receiver, method, args JSON, deposit, gas), mencetaknya,
 * mencocokkan nama method/param/#[payable] dengan contracts/snacc/src/lib.rs, dan memastikan public key
 * kunci cocok dengan access key akun (view_access_key). TIDAK ada tx, manifest tidak ditulis, laporan
 * tidak diregenerasi. Jendela waktu hanya dilaporkan (tidak pernah menghalangi tampilan aksi).
 *
 * --selftest --selftest-account <id.testnet> --selftest-key <path> [--selftest-fail]: menguji jalur
 * tanda tangan + broadcast + parsing + penulisan manifest dengan SATU tx tak berbahaya
 * (storage_deposit registration_only akun uji sendiri). WAJIB GLADI_MANIFEST=<salinan sementara>;
 * dilarang untuk akun buyer/kontrak. --selftest-fail menambah tx gagal tak berbahaya (ft_transfer saldo 0).
 *
 * $SNACC testnet tanpa nilai uang. Tanpa hash = tanpa klaim.
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
if (EXECUTE && has("preflight")) { console.error("pilih salah satu: --preflight ATAU --execute/--dry-run/--selftest"); process.exit(2); }

// ---------- konstanta (Kamus Angka / state.rs) ----------
const CONTRACT = process.env.CONTRACT_ID ?? "snacc-v001.testnet";
const BUYER = "x207-demo-buyer.testnet";
const KEY_MAIN = resolve(ROOT, ".secrets/snacc/snacc-v001.testnet.json");
const KEY_BUYER = resolve(ROOT, ".secrets/testnet-demo/testnet/x207-demo-buyer.testnet.json");
const DEFAULT_MANIFEST = resolve(ROOT, "reports/gladi-manifest.json");
const MANIFEST = resolve(process.env.GLADI_MANIFEST ?? DEFAULT_MANIFEST);   // override HANYA utk uji (salinan sementara)
const LIB_RS = resolve(here, "../contracts/snacc/src/lib.rs");
const RAIDER_HOSTILE = 4, TARGET_HOSTILE = 6, ADOPTER = 7, TARGET_ADOPT = 8, TARGET_LYSIS = 8;
const DISTRESSED_MAX = 2000;            // I-09: 1..=2000
const LYSOSOME_BPS_PER_LEVEL = 1000;    // EN-119
const HOSTILE_PREMIUM_BPS = 1500, BPS = 10000, HOSTILE_SELLER_BPS = 9500, MOLECULE_FLOOR_PRICE = 1n;
const HOSTILE_ATP_COST = 10n;           // EN-116/§13a: pay_atp(raider, 10) di hostile_takeover_splice
const MAX_COLONY_SIZE = 5;
const FT_AMOUNT = "1000";
const STORAGE_REG_YOCTO = 5n * 10n ** 21n;   // STORAGE_DEPOSIT_MILLINEAR = 5 (state.rs)
const SAFETY_SEC = 120;                 // margin atas batas jam (timestamp blok vs jam lokal)
const MIN_SPENDABLE_NEAR = 10n ** 23n;  // 0,1 NEAR per akun penanda tangan (gas 100-200 Tgas << ini)
const TOKENS = ["mt:spore-ignis", "mt:spore-cryo", "mt:spore-lumin", "mt:enzyme-amalgam", "mt:enzyme-redactase",
  "mt:enzyme-synthase", "mt:elixir-homunculus", "mt:elixir-homeostasis", "mt:elixir-aether"];
const RPCS = [process.env.NEAR_RPC, "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"].filter(Boolean);
const SIGNERS = { main: { id: CONTRACT, key: KEY_MAIN }, buyer: { id: BUYER, key: KEY_BUYER } };

// ---------- aksi (satu-satunya tempat args/deposit/gas dibangun — dipakai --execute DAN --dry-run) ----------
const A = {
  hostile: (nonce) => ({ kpi: "G-07", who: "buyer", method: "hostile_takeover_splice", args: { raider_strain_id: RAIDER_HOSTILE, distressed_target_id: TARGET_HOSTILE, expected_target_nonce: nonce }, deposit: 0n, gas: 200n,
    rule: `caller == raider(${RAIDER_HOSTILE}).owner_id (buyer); non-payable; raider.atp >= 10; raider.snacc >= book×115%` }),
  register: () => ({ kpi: "PREP", who: "main", method: "storage_deposit", args: { account_id: BUYER, registration_only: true }, deposit: STORAGE_REG_YOCTO, gas: 100n,
    rule: "#[payable]; registrasi baru wajib >= 5 milliNEAR (kelebihan di-refund)" }),
  ft: () => ({ kpi: "G-02", who: "main", method: "ft_transfer", args: { receiver_id: BUYER, amount: FT_AMOUNT, memo: "gladi-retry" }, deposit: 1n, gas: 100n,
    rule: "#[payable] wajib TEPAT 1 yocto; penerima terdaftar storage; saldo akun pengirim >= amount" }),
  adopt: (nonce) => ({ kpi: "G-08", who: "main", method: "adopt", args: { target_id: TARGET_ADOPT, raider_strain_id: ADOPTER, expected_target_nonce: nonce }, deposit: 0n, gas: 200n,
    rule: `caller == raider(${ADOPTER}).owner_id; non-payable; koloni caller < ${MAX_COLONY_SIZE}; raider.snacc >= book (tanpa premium)` }),
  lysis: () => ({ kpi: "G-10", who: "main", method: "harvest_starving_strain", args: { target_id: TARGET_LYSIS }, deposit: 0n, gas: 150n,
    rule: "permissionless; non-payable; wajib effective_vitality == 0" }),
};
const fmtAction = (a) => `${a.kpi} signer=${SIGNERS[a.who].id} receiver=${CONTRACT} method=${a.method} args=${JSON.stringify(a.args)} deposit=${a.deposit}yocto gas=${a.gas}Tgas`;

/** Pisah parameter Rust di level komma teratas (abaikan komma di dalam <> () []). */
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
/** Cocokkan aksi dengan ABI lib.rs: nama method, nama param (tepat), #[payable] vs deposit. Mengembalikan daftar galat. */
function abiCheck(a) {
  if (LIB_SRC === undefined) LIB_SRC = existsSync(LIB_RS) ? readFileSync(LIB_RS, "utf8") : null;
  if (!LIB_SRC) return { errs: [], note: "lib.rs tak ditemukan — cek ABI dilewati" };
  const re = new RegExp(`pub fn ${a.method}\\s*\\(([^)]*)\\)`);
  const m = re.exec(LIB_SRC);
  if (!m) return { errs: [`method ${a.method} tidak ada di lib.rs`] };
  const params = splitParams(m[1]).filter((p) => !/^&?\s*(mut\s+)?self\b/.test(p))
    .map((p) => ({ name: p.split(":")[0].trim(), optional: /:\s*Option\s*</.test(p) }));
  // atribut tepat di atas fn (naik selama baris diawali #[ atau //)
  const lines = LIB_SRC.slice(0, m.index).split("\n"); lines.pop();
  let payable = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith("#[") || t.startsWith("//")) { if (t.startsWith("#[payable]")) payable = true; } else break;
  }
  const errs = [];
  const keys = Object.keys(a.args);
  for (const k of keys) if (!params.some((p) => p.name === k)) errs.push(`arg "${k}" tidak ada di signature (${params.map((p) => p.name).join(", ")})`);
  for (const p of params) if (!p.optional && !keys.includes(p.name)) errs.push(`param wajib "${p.name}" tidak diisi`);
  if (a.deposit > 0n && !payable) errs.push(`deposit ${a.deposit} tapi method TIDAK #[payable]`);
  return { errs, params: params.map((p) => p.name + (p.optional ? "?" : "")), payable };
}

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
  // saldo $SNACC strain: tak ada view saldo-strain -> dibaca dari SVG on-chain (svg.rs: "💎 {snacc} | ⚡ {atp} ATP", u128 penuh).
  // Kegagalan baca = PERINGATAN saja (kontrak sendiri yang menegakkan saldo); jangan memblokir --execute.
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
    const raider = st[RAIDER_HOSTILE], tgt = st[TARGET_HOSTILE], w = windows(tgt), bl = [], warn = [];
    if (raider.owner_id !== BUYER) bl.push(`raider ${RAIDER_HOSTILE} milik ${raider.owner_id}, bukan ${BUYER} (penanda tangan harus pemilik raider)`);
    if (dead(raider)) bl.push(`raider ${RAIDER_HOSTILE} status ${JSON.stringify(raider.status)}`);
    if (dead(tgt)) bl.push(`target ${TARGET_HOSTILE} status ${JSON.stringify(tgt.status)} (sudah SplicedBurned/Liquidated)`);
    if (raider.snacc === null || tgt.snacc === null) warn.push("saldo strain tak terbaca dari SVG (format svg.rs berubah?) — cek saldo manual; kontrak yang menegakkan");
    const payment = (book(tgt) * BigInt(BPS + HOSTILE_PREMIUM_BPS)) / BigInt(BPS);
    if (raider.snacc !== null && raider.snacc < payment) bl.push(`saldo raider ${raider.snacc} < payment ${payment} (book ${book(tgt)} ×115%)`);
    if (BigInt(raider.atp_balance ?? 0) < HOSTILE_ATP_COST) bl.push(`ATP raider ${raider.atp_balance} < ${HOSTILE_ATP_COST} (ERR_NOT_ENOUGH_ATP)`);
    if (tgt.pending_callbacks !== 0) bl.push(`target pending_callbacks=${tgt.pending_callbacks}`);
    if (!S.keys.buyer) bl.push(`file kunci buyer tak ada (${KEY_BUYER})`);
    if (S.spBuyer < MIN_SPENDABLE_NEAR) bl.push(`NEAR spendable buyer ${S.spBuyer} < ${MIN_SPENDABLE_NEAR}`);
    if (!w) bl.push("BMR efektif target 0 — tidak menua");
    else if (!w.hasWindow) bl.push("target melompati jendela Distressed (eff turun dari >2000 langsung 0)");
    out["G-07"] = { earliest: w?.distressedFrom ?? null, closes: w?.windowClosesExact ?? null, blockers: bl, warnings: warn, payment, sellerPayout: (payment * BigInt(HOSTILE_SELLER_BPS)) / BigInt(BPS), w };
  }
  // G-08 adopt
  {
    const adopter = st[ADOPTER], tgt = st[TARGET_ADOPT], w = windows(tgt), bl = [], warn = [];
    if (adopter.owner_id !== CONTRACT) bl.push(`adopter ${ADOPTER} milik ${adopter.owner_id}, bukan ${CONTRACT}`);
    if (dead(adopter)) bl.push(`adopter status ${JSON.stringify(adopter.status)}`);
    if (dead(tgt)) bl.push(`target ${TARGET_ADOPT} status ${JSON.stringify(tgt.status)}`);
    if (adopter.snacc === null || tgt.snacc === null) warn.push("saldo strain tak terbaca dari SVG — cek saldo manual; kontrak yang menegakkan");
    if (adopter.snacc !== null && adopter.snacc < book(tgt)) bl.push(`saldo adopter ${adopter.snacc} < book_value target ${book(tgt)}`);
    if (S.colony.length >= MAX_COLONY_SIZE) bl.push(`koloni ${CONTRACT} aktif=${S.colony.length} >= MAX_COLONY_SIZE=${MAX_COLONY_SIZE} (ERR_COLONY_FULL); turun ke ${S.colony.length - 1} bila G-07 membakar strain ${TARGET_HOSTILE} lebih dulu`);
    if (tgt.pending_callbacks !== 0) bl.push(`target pending_callbacks=${tgt.pending_callbacks}`);
    if (!S.keys.main) bl.push(`file kunci ${CONTRACT} tak ada`);
    if (S.spMain < MIN_SPENDABLE_NEAR) bl.push(`NEAR spendable ${CONTRACT} ${S.spMain} < ${MIN_SPENDABLE_NEAR}`);
    if (!w) bl.push("BMR efektif target 0 — tidak menua");
    else if (!w.hasWindow) bl.push("target melompati jendela Distressed");
    out["G-08"] = { earliest: w?.distressedFrom ?? null, closes: w?.windowClosesExact ?? null, blockers: bl, warnings: warn, bookValue: book(tgt), w };
  }
  // G-10 lisis
  {
    const tgt = st[TARGET_LYSIS], w = windows(tgt), bl = [];
    if (dead(tgt)) bl.push(`target ${TARGET_LYSIS} status ${JSON.stringify(tgt.status)}`);
    if (!S.keys.main) bl.push(`file kunci ${CONTRACT} tak ada`);
    if (S.spMain < MIN_SPENDABLE_NEAR) bl.push(`NEAR spendable ${CONTRACT} ${S.spMain} < ${MIN_SPENDABLE_NEAR}`);
    if (!w) bl.push("BMR efektif target 0 — tidak menua");
    out["G-10"] = { earliest: w?.insolventFrom ?? null, closes: null, blockers: bl, warnings: [], bounty: (tgt.snacc ?? 0n) / 10n, w };
  }
  // G-02 ft_transfer: butuh saldo akun >= 1000 (muncul setelah payout G-07 / adopt G-08 / bounty G-10)
  {
    const bl = [];
    if (!S.buyerReg) bl.push(`${BUYER} belum terdaftar storage — --execute akan storage_deposit(registration_only) lebih dulu (tx tambahan, deposit 5 mN)`);
    if (!S.keys.main) bl.push(`file kunci ${CONTRACT} tak ada`);
    if (S.spMain < MIN_SPENDABLE_NEAR) bl.push(`NEAR spendable ${CONTRACT} < ${MIN_SPENDABLE_NEAR}`);
    const have = S.ftMain >= BigInt(FT_AMOUNT);
    const src = ["G-07", "G-08", "G-10"].map((k) => out[k].earliest).filter((x) => x !== null);
    out["G-02"] = { earliest: have ? now : src.length ? Math.min(...src) : null, closes: null, blockers: bl, warnings: [], ftMain: S.ftMain, via: have ? "saldo akun sudah cukup" : "setelah KPI penghasil saldo pertama (G-07/G-08/G-10)" };
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
    console.log(`    eff_vitality(view)=${s.effective_vitality} eff(hitung)=${calc}${calc === s.effective_vitality ? " ✓" : " ≠ (selisih jam blok/ view)"} · nonce=${s.state_nonce} pending_cb=${s.pending_callbacks} · atp=${s.atp_balance}${s.svgAtp !== null && s.svgAtp !== BigInt(s.atp_balance) ? ` (SVG ${s.svgAtp} ≠ view!)` : ""}`);
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
    for (const b of p.warnings ?? []) console.log(`        ℹ ${b}`);
  }
  console.log(`\nCatatan: G-02 = jam paling awal saldo akun >= ${FT_AMOUNT} (mengikuti KPI penghasil saldo pertama). Preflight TIDAK mengirim transaksi.`);
}

// ---------- runtime tanda tangan (near-api-js dari sdk x207) ----------
const readKey = (p) => { const j = JSON.parse(readFileSync(p, "utf8")); const k = j.secret_key ?? j.private_key; if (!k) throw new Error("field kunci tak ada"); return k; };   // tak pernah dicetak
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

  /** Public key kunci == access key on-chain akun? (view_access_key). Mengembalikan {ok,msg}. Tak mencetak isi kunci. */
  async function verifyKey(who, action) {
    const S = SIGNERS[who];
    if (!existsSync(S.key)) return (keyOk[who] = { ok: false, msg: `file kunci tak ada (${S.key})` });
    let pk;
    try { pk = (await signerOf(who).getPublicKey()).toString(); }
    catch { return (keyOk[who] = { ok: false, msg: "format kunci tidak valid (isi tak dicetak)" }); }
    try {
      const k = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: S.id, public_key: pk });
      const perm = k.permission === "FullAccess" ? "FullAccess" : `FunctionCall${JSON.stringify(k.permission?.FunctionCall ?? k.permission)}`;
      let ok = true, extra = "";
      if (k.permission !== "FullAccess") {
        const fc = k.permission?.FunctionCall;
        ok = !!fc && fc.receiver_id === CONTRACT;
        if (!ok) extra = " ← bukan FullAccess dan receiver ≠ kontrak";
        if (ok && action && action.deposit > 0n) { ok = false; extra = " ← FunctionCall key tak boleh membawa deposit"; }
      }
      return (keyOk[who] = { ok, pk, msg: `public key ${pk} cocok access key on-chain ${S.id} · permission=${perm} · nonce=${k.nonce}${extra}` });
    } catch (e) {
      return (keyOk[who] = { ok: false, pk, msg: `public key ${pk} TIDAK ditemukan sebagai access key ${S.id}: ${String(e.message).slice(0, 120)}` });
    }
  }

  const outcomeFailures = (r) => [...new Set([r.status, ...(r.receipts_outcome ?? []).map((o) => o.outcome?.status)].filter((s) => s?.Failure).map((s) => JSON.stringify(s.Failure)))];
  const successValue = (r) => {
    const v = r?.status?.SuccessValue;
    if (v === undefined || v === "") return "(kosong)";
    try { return Buffer.from(v, "base64").toString("utf8").slice(0, 240); } catch { return "(tak terbaca)"; }
  };
  const txHashOf = (signed) => baseEncode(createHash("sha256").update(encodeTransaction(signed.transaction)).digest());

  // manifest dimuat sekali; ditulis atomik (tmp + rename)
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const saveManifest = () => { writeFileSync(MANIFEST + ".tmp", JSON.stringify(manifest, null, 2), "utf8"); renameSync(MANIFEST + ".tmp", MANIFEST); };
  const FINAL = (kpi) => manifest.actions.some((a) => a.kpi === kpi && a.txHash && a.signer);

  /** Kirim satu aksi. Mengembalikan hash (sukses) atau null. DRY: hanya cetak. */
  async function send(a) {
    const sid = SIGNERS[a.who].id;
    console.log(`${DRY ? "[DRY-RUN] " : ""}▶ ${fmtAction(a)}`);
    const abi = abiCheck(a);
    if (DRY) {
      console.log(`    aturan kontrak: ${a.rule ?? "-"}`);
      console.log(`    ABI lib.rs: ${abi.note ?? `params=(${abi.params?.join(", ")}) payable=${abi.payable}`} → ${abi.errs.length ? "✗ " + abi.errs.join("; ") : "cocok ✓"}`);
      const kk = await verifyKey(a.who, a);
      console.log(`    kunci ${sid}: ${kk.ok ? "✓" : "✗"} ${kk.msg}`);
      DRY_ERRORS.push(...abi.errs.map((e) => `${a.kpi}/${a.method}: ${e}`), ...(kk.ok ? [] : [`${a.kpi}: kunci ${sid}: ${kk.msg}`]));
      return "DRY";
    }
    const fail = (msg, hash) => {
      manifest.actions.push({ kpi: a.kpi, txHash: null, note: `GAGAL gladi-retry ${a.method}: ${msg}${hash ? ` (tx ${hash})` : ""}`.slice(0, 400) });
      saveManifest();
      console.log(`  ✗ ${a.kpi} ${msg}${hash ? ` (tx ${hash})` : ""}`);
      return null;
    };
    if (abi.errs.length) return fail(`ABI tak cocok: ${abi.errs.join("; ")}`);
    const kk = keyOk[a.who] ?? (await verifyKey(a.who, a));
    if (!kk.ok) return fail(`kunci ${sid} ditolak: ${kk.msg}`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      let hash = null;
      try {
        const signed = await account(a.who).createSignedTransaction({ receiverId: CONTRACT, actions: [actions.functionCall(a.method, a.args, a.gas * 10n ** 12n, a.deposit)] });
        try { hash = txHashOf(signed); } catch { /* hash lokal opsional */ }
        let r;
        try { r = await provider.sendTransactionUntil(signed, "FINAL"); }
        catch (e) {
          if (!hash || !TRANSIENT.test(String(e.message ?? e))) throw e;
          console.log(`  … broadcast galat (${String(e.message).slice(0, 80)}); poll status tx ${hash}`);
          for (let i = 0; i < 12 && !r; i++) { await sleep(5000); try { r = await provider.viewTransactionStatus({ txHash: hash, accountId: sid, waitUntil: "FINAL" }); } catch { /* belum terindeks */ } }
          if (!r) throw e;
        }
        const fails = outcomeFailures(r);
        const realHash = r.transaction?.hash ?? hash;
        if (fails.length) return fail(fails.join("|").slice(0, 300), realHash);
        manifest.actions = manifest.actions.filter((x) => !(x.kpi === a.kpi && !x.txHash && /^menunggu/.test(x.note ?? "")));
        manifest.actions.push({ kpi: a.kpi, txHash: realHash, signer: sid, note: `gladi-retry ${a.method} ${new Date().toISOString().slice(0, 16)}Z` });
        saveManifest();
        console.log(`  ✓ ${a.kpi} tx=${realHash} status=SUCCESS hasil=${successValue(r)}${hash && hash !== realHash ? ` (⚠ hash lokal ${hash} ≠ RPC)` : ""}`);
        return realHash;
      } catch (e) {
        const msg = String(e.message ?? e).slice(0, 200);
        if (attempt < 3 && TRANSIENT.test(msg)) { console.log(`  … percobaan ${attempt} galat jaringan: ${msg.slice(0, 80)}; ulang`); await sleep(4000 * attempt); continue; }
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
  if (DRY) console.log(`# gladi-retry DRY-RUN — kontrak ${CONTRACT} · tanpa tx, manifest tak ditulis · jendela waktu hanya dilaporkan\n`);
  else for (const who of ["main", "buyer"]) { const k = await rt.verifyKey(who); console.log(`kunci ${SIGNERS[who].id}: ${k.ok ? "✓" : "✗"} ${k.msg}`); }

  const winNote = (p, now) => p.earliest === null ? "TIDAK TERJADWAL"
    : p.closes && now >= p.closes ? `JENDELA SUDAH TUTUP (${iso(p.closes)})`
    : now >= p.earliest ? `terbuka (sejak ${iso(p.earliest)}${p.closes ? `, tutup ${iso(p.closes)}` : ""})` : `belum buka (paling awal ${iso(p.earliest)}, +${((p.earliest - now) / 3600).toFixed(1)} jam)`;
  const due = async (kpi) => {
    for (;;) {
      const S = await snapshot(), P = plan(S);
      const p = P[kpi];
      for (const w of p.warnings ?? []) console.log(`ℹ ${kpi} peringatan: ${w}`);
      if (DRY) {
        console.log(`ℹ ${kpi} jendela: ${winNote(p, S.now)} · blokir saat ini: ${p.blockers.length ? p.blockers.join("; ") : "tidak ada"}`);
        return { S, P };
      }
      if (p.blockers.some((b) => !/belum terdaftar storage/.test(b))) { console.log(`⏭ ${kpi} DIBLOKIR: ${p.blockers.join("; ")}`); return null; }
      if (p.earliest === null) { console.log(`⏭ ${kpi} tak terjadwal`); return null; }
      if (p.closes && S.now >= p.closes) { console.log(`⏭ ${kpi} jendela sudah tutup (${iso(p.closes)})`); return null; }
      if (S.now >= p.earliest) return { S, P };
      if (!has("wait")) { console.log(`⏭ ${kpi} belum waktunya (paling awal ${iso(p.earliest)}; pakai --wait untuk menunggu)`); return null; }
      const wait = Math.min(300, p.earliest - S.now + 5);
      console.log(`⏳ ${kpi} menunggu ${iso(p.earliest)} (cek lagi ${wait}s)`);
      await sleep(wait * 1000);
    }
  };
  const want = (kpi) => (!only || only.includes(kpi)) && (DRY || has("force") || !FINAL(kpi) || (console.log(`⏭ ${kpi} sudah punya tx di manifest (pakai --force untuk ulang)`), false));
  const g02 = async (S) => {
    if (S.ftMain < BigInt(FT_AMOUNT) && !DRY) { console.log(`⏭ G-02 saldo akun ${S.ftMain} < ${FT_AMOUNT} (jalankan KPI penghasil saldo dulu)`); return; }
    if (S.ftMain < BigInt(FT_AMOUNT)) console.log(`ℹ G-02 [simulasi] saldo akun saat ini ${S.ftMain} < ${FT_AMOUNT}; akan terisi payout G-07/G-08/G-10 — aksi tetap dicetak`);
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
  // G-02 kedua kali bila saldo baru muncul setelah G-08/G-10 dan G-02 belum punya tx
  if (!DRY && want("G-02")) await g02(await snapshot());

  if (DRY) {
    console.log(`\n# DRY-RUN selesai: ${DRY_ERRORS.length ? `${DRY_ERRORS.length} GALAT\n- ${DRY_ERRORS.join("\n- ")}` : "ABI + kunci semua cocok (0 galat)"}`);
    process.exit(DRY_ERRORS.length ? 1 : 0);
  }
  if (MANIFEST !== DEFAULT_MANIFEST) { console.log("\nℹ manifest override → gladi-kpi.md tidak diregenerasi"); return; }
  console.log("\n▶ regenerasi reports/gladi-kpi.md (gladi-kpi.mjs)");
  try { console.log(execFileSync(process.execPath, [resolve(here, "gladi-kpi.mjs")], { encoding: "utf8" }).split("\n").slice(-4).join("\n")); }
  catch (e) { console.log(String(e.stdout ?? e.message).split("\n").slice(-6).join("\n")); }   // exit 1 bila ada FAIL — laporan tetap tertulis
}

// ---------- selftest: jalur sign + broadcast + parse + manifest dengan tx tak berbahaya ----------
async function selftest() {
  const id = opt("selftest-account"), key = opt("selftest-key");
  if (!id || !key) throw new Error("--selftest butuh --selftest-account <id> --selftest-key <path>");
  if ([BUYER, CONTRACT].includes(id)) throw new Error("selftest dilarang memakai akun buyer/kontrak");
  if (MANIFEST === DEFAULT_MANIFEST) throw new Error("selftest wajib GLADI_MANIFEST=<salinan sementara>, bukan manifest asli");
  SIGNERS.test = { id, key: resolve(key) };
  const rt = runtime();
  const k = await rt.verifyKey("test"); console.log(`kunci ${id}: ${k.ok ? "✓" : "✗"} ${k.msg}`);
  if (!k.ok) throw new Error("kunci uji tidak cocok");
  const n0 = rt.manifest.actions.length;
  const reg = { kpi: "SELFTEST", who: "test", method: "storage_deposit", args: { account_id: id, registration_only: true }, deposit: STORAGE_REG_YOCTO, gas: 100n, rule: "registrasi storage akun uji sendiri" };
  const h = await rt.send(reg);
  const bal = await view("storage_balance_of", { account_id: id });
  console.log(`view storage_balance_of(${id}) = ${JSON.stringify(bal)} → ${h && bal ? "terdaftar ✓" : "BELUM ✗"}`);
  let hFail;
  if (has("selftest-fail")) {
    hFail = await rt.send({ kpi: "SELFTEST", who: "test", method: "ft_transfer", args: { receiver_id: id, amount: "1000", memo: "selftest" }, deposit: 1n, gas: 100n });
    console.log(`jalur gagal: send mengembalikan ${hFail} (diharapkan null)`);
  }
  const added = JSON.parse(readFileSync(MANIFEST, "utf8")).actions.slice(n0);
  console.log(`manifest uji: +${added.length} entri →\n${added.map((x) => "  " + JSON.stringify(x)).join("\n")}`);
  if (!h || !bal || (has("selftest-fail") && hFail !== null)) process.exit(1);
}

// ---------- main ----------
try {
  if (SELFTEST) await selftest();
  else if (EXECUTE) await execute();
  else { const S = await snapshot(); printPreflight(S, plan(S)); }
} catch (e) { console.error(`gladi-retry: ${String(e.message ?? e)}`); process.exit(1); }

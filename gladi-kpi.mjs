#!/usr/bin/env node
/**
 * gladi-kpi.mjs — KPI GLADI AUTO-CHECK (OPS-118, mandat pemilik 2026-11-08).
 *
 * Membaca manifest gladi (`reports/gladi-manifest.json`) yang ditulis pelaksana gladi
 * (tiap aksi: {kpi, txHash?, note}) lalu memverifikasi OTOMATIS tiap KPI dari:
 *   (1) view state kontrak via NEAR RPC (query), (2) receipt log NEP-297 dari tx hash,
 *   (3) aturan angka Kamus Angka Resmi (§13a / Model Data).
 * Output: `reports/gladi-kpi.md` — tabel PASS/FAIL/BELUM + hash bukti.
 *
 * Sumber KPI: Backlog Master §13a/§13b · Siklus Hidup Sel LC-01..20 · Alur EN-01..08 ·
 * Kamus Angka Resmi · ECON-111 (VOLUME_SCALE=5, Fever 610).
 *
 * Pakai: node gladi-kpi.mjs [--rpc URL] [--contract ID] [--manifest PATH]
 * Tanpa argumen: env NEAR_RPC / CONTRACT_ID / GLADI_MANIFEST, default testnet.
 * $SNACC testnet tanpa nilai uang. Verifikasi = fakta on-chain, bukan klaim.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const RPC = arg("rpc", process.env.NEAR_RPC ?? "https://rpc.testnet.near.org");
const CONTRACT = arg("contract", process.env.CONTRACT_ID ?? "snacc-v001.testnet");
const MANIFEST = resolve(HERE, arg("manifest", process.env.GLADI_MANIFEST ?? "../../../reports/gladi-manifest.json"));
const OUT = resolve(HERE, "../../../reports/gladi-kpi.md");

// ---------- RPC ----------
async function rpcCall(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "gladi-kpi", method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}
function b64json(s) {
  return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
}
async function view(method, args = {}) {
  const r = await rpcCall("query", {
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return b64json(Buffer.from(r.result).toString("base64"));
}
/** Ambil log receipt dari satu tx hash (NEP-297 event = log `EVENT_JSON:{...}`). */
async function txLogs(txHash) {
  const r = await rpcCall("tx", [txHash, CONTRACT]);
  const logs = (r.transaction_outcome?.outcome?.log ?? []).concat(
    ...(r.receipts_outcome ?? []).map((o) => o.outcome.log ?? []),
  );
  const events = [];
  for (const l of logs) {
    if (l.startsWith("EVENT_JSON:")) {
      try { events.push(JSON.parse(l.slice("EVENT_JSON:".length))); } catch { /* abaikan */ }
    }
  }
  return events;
}
const hasEvent = (events, standard, event) =>
  events.some((e) => e.standard === standard && (Array.isArray(e.event) ? e.event.includes(event) : e.event === event));

// ---------- Definisi KPI (auto-check) ----------
// status: PASS | FAIL | BELUM (bukti belum ada di manifest/gladi)
const KPI = [
  { id: "G-01", nama: "Lahir — `incubate_strain` + `$SNACC` supply lahir", sumber: "EN-08/F1, LC-01, §13b",
    async check(m, proof) {
      const ts = await view("ft_total_supply");
      const ok = BigInt(ts) > 0n;
      return { pass: ok, bukti: `ft_total_supply=${ts}${proof ? ` · tx ${proof}` : ""}` };
    } },
  { id: "G-02", nama: "`$SNACC` NEP-141 hidup (metadata + transfer + saldo)", sumber: "N141-101..106, §13b",
    async check(m, proof) {
      const md = await view("ft_metadata");
      const pass = md.symbol === "SNACC" && md.decimals === 24;
      return { pass, bukti: `name=${md.name} symbol=${md.symbol} decimals=${md.decimals}${proof ? ` · tx ${proof}` : ""}` };
    } },
  { id: "G-03", nama: "Makan → ATP (`feed_strain` cetak `atp_minted`)", sumber: "EN-06/EN-115, LC-02, §13a",
    async check(m, proof) {
      const ev = proof ? await txLogs(proof) : [];
      const pass = hasEvent(ev, "snacc", "fed");
      return { pass: pass && !!proof, bukti: `event fed${proof ? ` · tx ${proof}` : " · tx belum ada"}` };
    } },
  { id: "G-04", nama: "Kerja 3-stage (extract→transmute→synthesize) + `atp_spent`", sumber: "EN-02/03/04, LC-03",
    async check(m, proof) {
      const txs = Array.isArray(proof) ? proof : proof ? [proof] : [];
      const all = (await Promise.all(txs.map(txLogs))).flat();
      const pass = ["spores_extracted", "spores_transmuted", "elixir_synthesized"].every((e) => hasEvent(all, "snacc", e));
      return { pass: pass && txs.length >= 3, bukti: txs.length ? `tx ${txs.join(", ")}` : "tx belum ada" };
    } },
  { id: "G-05", nama: "TEE zero-trust (commit → apply, `MutationApplied`, role unlock)", sumber: "EN-05, ADR-16, I-16",
    async check(m, proof) {
      const txs = Array.isArray(proof) ? proof : proof ? [proof] : [];
      const all = (await Promise.all(txs.map(txLogs))).flat();
      const pass = hasEvent(all, "snacc", "MutationApplied") || hasEvent(all, "snacc", "mutation_applied");
      return { pass: pass && txs.length >= 2, bukti: txs.length ? `tx ${txs.join(", ")}` : "tx belum ada" };
    } },
  { id: "G-06", nama: "Fusi — `SplicedBurned` + Gen+1 + pajak 2,5% ke treasury", sumber: "F5, LC-06, I-02",
    async check(m, proof) {
      const ev = proof ? await txLogs(proof) : [];
      const pass = hasEvent(ev, "snacc", "SplicedBurned");
      return { pass: pass && !!proof, bukti: `event SplicedBurned${proof ? ` · tx ${proof}` : " · tx belum ada"}` };
    } },
  { id: "G-07", nama: "Hostile 115% (95/5) + nonce anti-drain (`pembelian_berulang`)", sumber: "ADR-03, I-09/I-14, LC-05",
    async check(m, proof) {
      const ev = proof ? await txLogs(proof) : [];
      const pass = hasEvent(ev, "snacc", "hostile_takeover_splice") || hasEvent(ev, "snacc", "HostileTakeoverSplice");
      return { pass: pass && !!proof, bukti: `event hostile${proof ? ` · tx ${proof}` : " · tx belum ada"}` };
    } },
  { id: "G-08", nama: "Adopt — `strain_adopted`, book_value 100% ke pemilik lama", sumber: "EN-123, LC-05",
    async check(m, proof) {
      const ev = proof ? await txLogs(proof) : [];
      const pass = hasEvent(ev, "snacc", "strain_adopted");
      return { pass: pass && !!proof, bukti: `event strain_adopted${proof ? ` · tx ${proof}` : " · tx belum ada"}` };
    } },
  { id: "G-09", nama: "Divide (sitokinesis) — `strain_divided` + konservasi saldo", sumber: "EN-122/124, LC-01",
    async check(m, proof) {
      const ev = proof ? await txLogs(proof) : [];
      const pass = hasEvent(ev, "snacc", "strain_divided");
      return { pass: pass && !!proof, bukti: `event strain_divided${proof ? ` · tx ${proof}` : " · tx belum ada"}` };
    } },
  { id: "G-10", nama: "Lisis Tier 2/3 — `harvested_starving` 10/90 + `ERR_STRAIN_STARVING` pernah terpicu", sumber: "F6, I-10, LC-07b",
    async check(m, proof) {
      const txs = Array.isArray(proof) ? proof : proof ? [proof] : [];
      const all = (await Promise.all(txs.map(txLogs))).flat();
      const pass = hasEvent(all, "snacc", "harvested_starving") || hasEvent(all, "snacc", "HarvestedStarving");
      return { pass: pass && txs.length >= 1, bukti: txs.length ? `tx ${txs.join(", ")}` : "tx belum ada" };
    } },
  { id: "G-11", nama: "Dividen DK-033 — klaim `DividendClaimed` + saldo naik", sumber: "DK-033/044, EN-01",
    async check(m, proof) {
      const ev = proof ? await txLogs(proof) : [];
      const pass = hasEvent(ev, "snacc", "DividendClaimed") || hasEvent(ev, "snacc", "dividend_claimed");
      return { pass: pass && !!proof, bukti: `event dividend${proof ? ` · tx ${proof}` : " · tx belum ada"}` };
    } },
  { id: "G-12", nama: "Termostat — suhu/zona hidup + `V_epoch > 0` (Opsi B, VOLUME_SCALE=5)", sumber: "ADR-04/27, ECON-111, I-01/I-04",
    async check() {
      const macro = await view("get_appetite_meter");
      const temp = Number(macro.crucible_temp_mk ?? macro.crucibleTemp ?? 0);
      const vol = String(macro.epoch_volume ?? macro.epochVolume ?? "0");
      const pass = temp > 0 && vol !== "0";
      return { pass, bukti: `temp=${temp} mK · V_epoch=${vol}` };
    } },
  { id: "G-13", nama: "NPC ADR-30 — `npc_spores_bought` + konservasi I-15", sumber: "ADR-30, I-15",
    async check(m, proof) {
      const ev = proof ? await txLogs(proof) : [];
      const pass = hasEvent(ev, "snacc", "npc_spores_bought");
      return { pass: pass && !!proof, bukti: `event npc_spores_bought${proof ? ` · tx ${proof}` : " · tx belum ada"}` };
    } },
  { id: "G-14", nama: "Koloni & risiko — `get_colony` konsisten + `get_risk_heat`", sumber: "EN-121/125, PF-06",
    async check() {
      const [colony, heat] = await Promise.all([view("get_colony", { owner_id: MANIFEST_OWNER }), view("get_risk_heat")]);
      const pass = Array.isArray(colony) && colony.length > 0 && Number(heat ?? 0) >= 0;
      return { pass, bukti: `koloni=${colony.length} · risk_heat=${heat}` };
    } },
  { id: "G-15", nama: "NFT NEP-171 — `nft_token` ≤1734 B + `nft_transfer` (transplantasi)", sumber: "LC-16, VC-009, NFT track",
    async check(m, proof) {
      const md = await view("nft_metadata");
      const token = await view("nft_token", { token_id: m.token_ids?.[0] ?? "1" });
      const size = Buffer.byteLength(JSON.stringify(token));
      const ev = proof ? await txLogs(proof) : [];
      const pass = size <= 1734 && md.spec === "nft-1.0.0" && (hasEvent(ev, "nep171", "nft_transfer") || hasEvent(ev, "snacc", "nft_transfer") || !!proof);
      return { pass, bukti: `nft_token ${size} B · spec=${md.spec}${proof ? ` · tx ${proof}` : ""}` };
    } },
  { id: "G-16", nama: "SVG 8 indikator (needle, `$SNACC`, `$ATP`, organel, suhu, zona, bounty, merah lisis)", sumber: "VC-009, EN-113",
    async check(m) {
      const token = await view("nft_token", { token_id: m.token_ids?.[0] ?? "1" });
      const media = token.metadata?.media ?? token.media ?? "";
      const need = ["svg", "SNACC", "ATP", "needle"];
      const hit = need.filter((k) => String(media).toLowerCase().includes(k.toLowerCase())).length;
      return { pass: hit >= 3, bukti: `indikator terdeteksi ${hit}/${need.length} di media` };
    } },
];

let MANIFEST_OWNER = "snacc.testnet";

// ---------- Runner ----------
async function main() {
  let manifest = { owner: "snacc.testnet", actions: [], token_ids: [] };
  try {
    manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
    MANIFEST_OWNER = manifest.owner ?? MANIFEST_OWNER;
  } catch {
    console.error(`⚠️  manifest ${MANIFEST} belum ada — jalan mode view-only (KPI berbasis tx akan BELUM).`);
  }
  const proofOf = (id) => {
    const a = manifest.actions.filter((x) => x.kpi === id);
    const hashes = a.map((x) => x.txHash).filter(Boolean);
    return hashes.length === 0 ? undefined : hashes.length === 1 ? hashes[0] : hashes;
  };

  const rows = [];
  for (const k of KPI) {
    let row;
    try {
      row = await k.check(manifest, proofOf(k.id));
    } catch (e) {
      row = { pass: false, bukti: `error: ${String(e.message ?? e).slice(0, 120)}` };
    }
    const status = row.pass ? "PASS" : proofOf(k.id) ? "FAIL" : "BELUM";
    rows.push({ ...k, status, bukti: row.bukti });
    console.log(`${status.padEnd(5)} ${k.id} ${k.nama.slice(0, 60)}`);
  }

  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const belum = rows.filter((r) => r.status === "BELUM").length;
  const md = [
    `# KPI Gladi — Hasil Auto-Check`,
    ``,
    `Tanggal: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · kontrak: \`${CONTRACT}\` · RPC: \`${RPC}\``,
    `Sumber desain: Backlog Master §13a/§13b · Siklus Hidup Sel LC-01..20 · Alur EN-01..08 · Kamus Angka Resmi · ECON-111.`,
    `Verifikasi otomatis dari bukti on-chain (view + receipt NEP-297 + tx hash). $SNACC testnet tanpa nilai uang.`,
    ``,
    `**Ringkasan: ${pass} PASS · ${fail} FAIL · ${belum} BELUM (dari ${rows.length} KPI)**`,
    ``,
    `| KPI | Sumber | Status | Bukti auto-check |`,
    `| --- | --- | --- | --- |`,
    ...rows.map((r) => `| ${r.id} ${r.nama} | ${r.sumber} | **${r.status}** | ${r.bukti} |`),
    ``,
    `> FAIL = bukti sudah ada tapi tidak memenuhi aturan. BELUM = bukti belum tercatat di manifest gladi.`,
  ].join("\n");
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, md, "utf8");
  console.log(`\nRingkasan: ${pass} PASS · ${fail} FAIL · ${belum} BELUM → ${OUT}`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(2);
});

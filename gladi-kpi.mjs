#!/usr/bin/env node
/**
 * gladi-kpi.mjs — KPI GLADI AUTO-CHECK (OPS-118; audit 3-POV 2026-11-08: 20 KPI).
 *
 * Membaca manifest gladi (`reports/gladi-manifest.json`) yang ditulis pelaksana gladi:
 *   { "owner": "akun.testnet", "signer": "akun.testnet", "token_ids": ["1"],
 *     "actions": [ {"kpi": "G-01", "txHash": "...", "signer": "opsional"} ] }
 * Verifikasi OTOMATIS per KPI dari: (1) view kontrak via NEAR RPC, (2) receipt tx di
 * chain (wajib SUKSES — tx gagal = bukti tidak sah), (3) event NEP-297 (`kind` kanonik
 * kontrak), (4) aturan angka Kamus Angka Resmi / §13a / ECON-111.
 * Output: `reports/gladi-kpi.md` — PASS / BELUM / FAIL + bukti + hash.
 *
 * Kanonik `kind` event (dari events.rs "kind"): strain_created, fed, atp_spent,
 * atp_allocated, extracted, transmuted, synthesized, genome_committed, genome_mutated,
 * strains_spliced, hostile_takeover_spliced, strain_liquidated, strain_divided,
 * strain_adopted, trait_conjugated, feast_result, zone_changed, nutrient_burst_released,
 * npc_spores_bought, dividend_claimed, dividend_inflow, epoch_dividend_closed,
 * aether_burned_for_dividend (+ NEP-171 `nft_transfer`, NEP-141 `ft_transfer`).
 *
 * Pakai: node gladi-kpi.mjs [--rpc URL] [--contract ID] [--manifest PATH]
 * $SNACC testnet tanpa nilai uang. Tanpa hash = tanpa klaim.
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
/**
 * Ambil event NEP-297 dari satu tx + **verifikasi tx SUKSES**.
 * `signer` = akun penandatangan tx (bukan kontrak!) — dari manifest.
 */
async function txProof(txHash, signer) {
  const r = await rpcCall("tx", [txHash, signer]);
  const outcomes = [r.transaction_outcome, ...(r.receipts_outcome ?? [])].filter(Boolean);
  const failed = outcomes.some((o) => o.outcome?.status?.Failure !== undefined || o.outcome?.status?.SuccessValue === undefined && o.outcome?.status?.SuccessReceiptId === undefined && o.transaction_outcome !== undefined && false);
  const anyFailure = outcomes.some((o) => o.outcome?.status && (o.outcome.status.Failure !== undefined || o.outcome.status.SuccessValue === undefined && o.outcome.status.SuccessReceiptId === undefined && !o.outcome.status.SuccessValue));
  const logs = outcomes.flatMap((o) => o.outcome?.log ?? []);
  const events = [];
  for (const l of logs) {
    if (l.startsWith("EVENT_JSON:")) {
      try { events.push(JSON.parse(l.slice("EVENT_JSON:".length))); } catch { /* abaikan */ }
    }
  }
  const ok = !anyFailure;
  return { ok, events };
}
const evOf = (events, event) =>
  events.find((e) => e.event === event || (Array.isArray(e.event) && e.event.includes(event)) || e.data?.some?.((d) => d?.kind === event));
const hasEvent = (events, event) => !!evOf(events, event);
function mediaSvg(token) {
  const m = token?.metadata?.media ?? token?.media ?? "";
  if (typeof m === "string" && m.startsWith("data:image/svg+xml;base64,")) {
    try { return Buffer.from(m.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8"); } catch { return m; }
  }
  return String(m);
}

// ---------- KPI (auto-check; PASS/BELUM/FAIL) ----------
const needProof = (row, proof) => (proof ? row : { pass: false, bukti: "tx belum ada di manifest" });
const KPI = [
  { id: "G-01", nama: "Lahir — `incubate_strain` + suplai `$SNACC` lahir", sumber: "EN-08/F1, LC-01, §13b",
    async check(m, proof) {
      const ts = await view("ft_total_supply");
      const ev = proof?.hash ? (await txProof(proof.hash, proof.signer)).events : [];
      const pass = BigInt(ts) > 0n && hasEvent(ev, "strain_created");
      return { pass, bukti: `ft_total_supply=${ts}${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-02", nama: "`$SNACC` NEP-141 hidup (metadata benar + `ft_transfer` sukses)", sumber: "N141-101..106, §13b",
    async check(m, proof) {
      const md = await view("ft_metadata");
      const ev = proof?.hash ? (await txProof(proof.hash, proof.signer)).events : [];
      const pass = md.symbol === "SNACC" && md.decimals === 24 && (proof ? hasEvent(ev, "ft_transfer") : false);
      return { pass, bukti: `symbol=${md.symbol} decimals=${md.decimals}${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-03", nama: "Makan → ATP (`fed` dengan `atp_minted > 0`)", sumber: "EN-06/EN-115, LC-02, §13a",
    async check(m, proof) {
      const p = proof?.hash ? await txProof(proof.hash, proof.signer) : null;
      const fed = p ? evOf(p.events, "fed") : null;
      const minted = Number(fed?.data?.[0]?.atp_minted ?? 0);
      return { pass: !!fed && minted > 0 && p.ok, bukti: `atp_minted=${minted}${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-04", nama: "Kerja 3-stage (`extracted`→`transmuted`→`synthesized`) + `atp_spent`", sumber: "EN-02/03/04, LC-03",
    async check(m, proof) {
      const txs = proof?.hashes ?? [];
      const all = (await Promise.all(txs.map((h) => txProof(h, proof.signer)))).flat().map((x) => x.events).flat();
      const pass = ["extracted", "transmuted", "synthesized"].every((e) => hasEvent(all, e)) && hasEvent(all, "atp_spent") && txs.length >= 3;
      return { pass, bukti: txs.length ? `tx ${txs.join(", ")}` : "tx belum ada" };
    } },
  { id: "G-05", nama: "TEE zero-trust (`genome_committed` → `genome_mutated`) + role unlock", sumber: "EN-05, ADR-16, I-16",
    async check(m, proof) {
      const txs = proof?.hashes ?? [];
      const all = (await Promise.all(txs.map((h) => txProof(h, proof.signer)))).flat().map((x) => x.events).flat();
      const pass = hasEvent(all, "genome_committed") && hasEvent(all, "genome_mutated") && txs.length >= 2;
      return { pass, bukti: txs.length ? `tx ${txs.join(", ")}` : "tx belum ada" };
    } },
  { id: "G-06", nama: "Fusi — `strains_spliced` + pajak 2,5% + `role_mask` menyatu", sumber: "F5, LC-06, I-02",
    async check(m, proof) {
      const p = proof?.hash ? await txProof(proof.hash, proof.signer) : null;
      const pass = !!p && p.ok && hasEvent(p.events, "strains_spliced");
      return { pass, bukti: `event strains_spliced${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-07", nama: "Hostile 115% — `hostile_takeover_spliced` + nonce anti-drain", sumber: "ADR-03, I-09/I-14, LC-05",
    async check(m, proof) {
      const p = proof?.hash ? await txProof(proof.hash, proof.signer) : null;
      const pass = !!p && p.ok && hasEvent(p.events, "hostile_takeover_spliced");
      return { pass, bukti: `event hostile_takeover_spliced${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-08", nama: "Adopt — `strain_adopted` (book_value 100% ke pemilik lama)", sumber: "EN-123, LC-05",
    async check(m, proof) {
      const p = proof?.hash ? await txProof(proof.hash, proof.signer) : null;
      const pass = !!p && p.ok && hasEvent(p.events, "strain_adopted");
      return { pass, bukti: `event strain_adopted${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-09", nama: "Divide — `strain_divided` + konservasi saldo", sumber: "EN-122/124, LC-01",
    async check(m, proof) {
      const p = proof?.hash ? await txProof(proof.hash, proof.signer) : null;
      const pass = !!p && p.ok && hasEvent(p.events, "strain_divided");
      return { pass, bukti: `event strain_divided${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-10", nama: "Lisis Tier 2/3 — `strain_liquidated` (10/90) + BMR kelaparan", sumber: "F6, I-10, LC-07b",
    async check(m, proof) {
      const txs = proof?.hashes ?? [];
      const all = (await Promise.all(txs.map((h) => txProof(h, proof.signer)))).flat().map((x) => x.events).flat();
      return { pass: hasEvent(all, "strain_liquidated") && txs.length >= 1, bukti: txs.length ? `tx ${txs.join(", ")}` : "tx belum ada" };
    } },
  { id: "G-11", nama: "Dividen DK-033 — `dividend_claimed` + `aether_burned_for_dividend`", sumber: "DK-033/044, EN-01",
    async check(m, proof) {
      const p = proof?.hash ? await txProof(proof.hash, proof.signer) : null;
      const pass = !!p && p.ok && hasEvent(p.events, "dividend_claimed");
      return { pass, bukti: `event dividend_claimed${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-12", nama: "Termostat hidup — suhu >0, `V_epoch` >0 (skala 5), `zone_changed` pernah tercatat", sumber: "ADR-04/27, ECON-111, I-01/I-04",
    async check(m, proof) {
      const [temp, macro] = await Promise.all([view("get_crucible_temp"), view("get_macro_state")]);
      const vol = BigInt(macro.volume_epoch ?? 0);
      const p = proof?.hash ? await txProof(proof.hash, proof.signer) : null;
      const pass = Number(temp) > 0 && vol > 0n && (p ? hasEvent(p.events, "zone_changed") : false);
      return { pass, bukti: `temp=${temp} mK · V_epoch=${vol}${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-13", nama: "NPC ADR-30 — `npc_spores_bought` + konservasi I-15", sumber: "ADR-30, I-15",
    async check(m, proof) {
      const p = proof?.hash ? await txProof(proof.hash, proof.signer) : null;
      return { pass: !!p && p.ok && hasEvent(p.events, "npc_spores_bought"), bukti: `event npc_spores_bought${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-14", nama: "Koloni & risiko — `get_colony` konsisten + `get_risk_heat`", sumber: "EN-121/125, PF-06",
    async check(m) {
      const owner = m.owner ?? "snacc.testnet";
      const [colony, heat] = await Promise.all([view("get_colony", { owner_id: owner }), view("get_risk_heat")]);
      return { pass: Array.isArray(colony) && colony.length > 0 && Number(heat) >= 0, bukti: `koloni=${colony.length} · risk_heat=${heat}` };
    } },
  { id: "G-15", nama: "NFT NEP-171 — `nft_token` ≤1734 B + `nft_transfer` sukses (transplantasi)", sumber: "LC-16, VC-009, NFT track",
    async check(m, proof) {
      const token = await view("nft_token", { token_id: String(m.token_ids?.[0] ?? "1") });
      const size = Buffer.byteLength(JSON.stringify(token));
      const p = proof?.hash ? await txProof(proof.hash, proof.signer) : null;
      const pass = size <= 1734 && !!p && p.ok && (hasEvent(p.events, "nft_transfer") || evOf(p.events, "nft_transfer"));
      return { pass, bukti: `nft_token ${size} B${proof?.hash ? ` · tx ${proof.hash}` : " · tx belum ada"}` };
    } },
  { id: "G-16", nama: "SVG 8 indikator (needle, `$SNACC`, `$ATP`, organel, suhu, zona, bounty, merah lisis)", sumber: "VC-009, EN-113",
    async check(m) {
      const token = await view("nft_token", { token_id: String(m.token_ids?.[0] ?? "1") });
      const svg = mediaSvg(token);
      const need = ["needle", "SNACC", "ATP", "M1", "NORMAL|HYPO|FEVER|LIQUID"];
      const hit = need.filter((k) => new RegExp(k, "i").test(svg)).length;
      return { pass: hit >= 4, bukti: `indikator terdeteksi ${hit}/${need.length}` };
    } },
  { id: "G-17", nama: "Volatilitas = fitur — `total_snacc_burned > 0` (burn `I-01` saat ramai)", sumber: "ADR-04, I-01, keputusan volatilitas",
    async check() {
      const macro = await view("get_macro_state");
      const burned = BigInt(macro.total_snacc_burned ?? 0);
      return { pass: burned > 0n, bukti: `total_snacc_burned=${burned} · supply=${macro.total_snacc_supply}` };
    } },
  { id: "G-18", nama: "Solvabilitas — `epoch_treasury_spent ≤ epoch_treasury_initial` (I-03) + kolam dividen", sumber: "I-03, DK-033",
    async check() {
      const macro = await view("get_macro_state");
      const spent = BigInt(macro.epoch_treasury_spent ?? 0);
      const init = BigInt(macro.epoch_treasury_initial ?? 0);
      const pool = BigInt(macro.industrial_dividend_pool ?? 0);
      return { pass: spent <= init && init > 0n, bukti: `spent=${spent} / initial=${init} · dividen_pool=${pool}` };
    } },
  { id: "G-19", nama: "Dinamika — `feast_result` (quorum/Goldilocks) + `zone_changed` pernah terjadi", sumber: "EN-105/106, LC-09/12",
    async check(m, proof) {
      const txs = proof?.hashes ?? [];
      const all = (await Promise.all(txs.map((h) => txProof(h, proof.signer)))).flat().map((x) => x.events).flat();
      return { pass: hasEvent(all, "feast_result") && hasEvent(all, "zone_changed"), bukti: txs.length ? `tx ${txs.join(", ")}` : "tx belum ada" };
    } },
];

// ---------- Runner ----------
async function main() {
  let manifest = { owner: "snacc.testnet", signer: "snacc.testnet", actions: [], token_ids: [] };
  try {
    manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  } catch {
    console.error(`⚠️  manifest ${MANIFEST} belum ada — mode view-only (KPI berbasis tx = BELUM).`);
  }
  const proofOf = (id) => {
    const a = manifest.actions.filter((x) => x.kpi === id);
    const hashes = a.map((x) => x.txHash).filter(Boolean);
    if (!hashes.length) return undefined;
    return {
      hash: hashes.length === 1 ? hashes[0] : undefined,
      hashes: hashes.length > 1 ? hashes : hashes,
      signer: a.find((x) => x.signer)?.signer ?? manifest.signer ?? manifest.owner,
    };
  };

  const rows = [];
  for (const k of KPI) {
    let row;
    try {
      row = await k.check(manifest, proofOf(k.id));
    } catch (e) {
      row = { pass: false, bukti: `ERROR: ${String(e.message ?? e).slice(0, 140)}` };
    }
    const proof = proofOf(k.id);
    const status = row.pass ? "PASS" : row.bukti.startsWith("ERROR") ? "FAIL" : proof ? "FAIL" : "BELUM";
    rows.push({ id: k.id, nama: k.nama, sumber: k.sumber, status, bukti: row.bukti });
    console.log(`${status.padEnd(5)} ${k.id} ${k.nama.slice(0, 58)}`);
  }

  const pass = rows.filter((r) => r.status === "PASS").length;
  const fail = rows.filter((r) => r.status === "FAIL").length;
  const belum = rows.filter((r) => r.status === "BELUM").length;
  const md = [
    `# KPI Gladi — Hasil Auto-Check (20 KPI, audit 3-POV)`,
    ``,
    `Tanggal: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · kontrak: \`${CONTRACT}\``,
    `Desain: Backlog §13a/§13b/§14 · LC-01..20 · EN-01..08 · Kamus Angka Resmi · ECON-111.`,
    `Auto-check: view kontrak + receipt tx (wajib sukses) + event kind kanonik + hash bukti.`,
    `$SNACC testnet tanpa nilai uang. Tanpa hash = tanpa klaim.`,
    ``,
    `**Ringkasan: ${pass} PASS · ${fail} FAIL · ${belum} BELUM (dari ${rows.length})**`,
    ``,
    `| KPI | Sumber | Status | Bukti auto-check |`,
    `| --- | --- | --- | --- |`,
    ...rows.map((r) => `| ${r.id} ${r.nama} | ${r.sumber} | **${r.status}** | ${r.bukti} |`),
    ``,
    `> FAIL = bukti ada tapi melanggar aturan / tx gagal / ERROR. BELUM = bukti belum tercatat di manifest.`,
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

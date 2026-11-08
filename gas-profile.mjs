#!/usr/bin/env node
/**
 * gas-profile.mjs — SEC-110: profil gas per RECEIPT dari tx gladi, diukur dari
 * receipt on-chain (bukan estimasi). Kebijakan `ADR-01`: satu receipt < 6 TGas —
 * script ini men-assert itu dan menandai pelanggar.
 *
 * Sumber: `reports/gladi-manifest.json` (kpi, txHash, signer, note).
 * RPC: `--rpc` (default https://near-testnet.drpc.org).
 * Output: `reports/gas-profile.md` (tabel per method: receipt terbesar + status).
 * Exit 1 bila ada receipt ≥ 6 TGas (pelanggaran ADR-01) — exit 0 = aman.
 *
 * Pakai: node gas-profile.mjs [--rpc URL] [--manifest PATH] [--out PATH]
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}
const RPC = arg("rpc", process.env.NEAR_RPC ?? "https://near-testnet.drpc.org");
const MANIFEST = resolve(arg("manifest", "../../../reports/gladi-manifest.json"));
const OUT = resolve(arg("out", "../../../reports/gas-profile.md"));
const BATAS_TGAS = 6; // ADR-01: satu receipt < 6 TGas

async function rpcCall(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "gas-profile", method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

function methodOf(note) {
  const m = (note ?? "").trim();
  if (!m) return "(tanpa note)";
  if (m.startsWith("GAGAL")) return "(tx gagal)";
  return m.split(/[\s(]/)[0].toLowerCase();
}

const fmt = (g) => (g / 1e12).toFixed(3);

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const actions = (manifest.actions ?? []).filter((a) => a.txHash);
  const seen = new Set();
  const perMethod = new Map(); // method → { maxReceiptTgas, totalTgas, n, pelanggar[] }
  let errorRpc = 0;
  let gagalEksekusi = 0;

  for (const a of actions) {
    if (seen.has(a.txHash)) continue;
    seen.add(a.txHash);
    const method = methodOf(a.note);
    try {
      const r = await rpcCall("tx", [a.txHash, a.signer ?? manifest.signer]);
      const outs = [r.transaction_outcome, ...(r.receipts_outcome ?? [])].filter(Boolean);
      if (!outs.length) {
        errorRpc++;
        continue;
      }
      const receipts = outs.map((o) => ({
        gas: o.outcome?.gas_burnt ?? 0,
        gagal:
          o.outcome?.status?.Failure !== undefined ||
          (o.outcome?.status?.SuccessValue === undefined &&
            o.outcome?.status?.SuccessReceiptId === undefined),
      }));
      const maxReceipt = Math.max(...receipts.map((x) => x.gas));
      const total = receipts.reduce((acc, x) => acc + x.gas, 0);
      const anyGagal = receipts.some((x) => x.gagal);
      if (anyGagal) gagalEksekusi++;
      const slot = perMethod.get(method) ?? {
        maxReceiptTgas: 0,
        totalTgas: 0,
        n: 0,
        pelanggar: [],
      };
      slot.n++;
      slot.totalTgas += total;
      if (maxReceipt > slot.maxReceiptTgas) slot.maxReceiptTgas = maxReceipt;
      if (maxReceipt / 1e12 >= BATAS_TGAS) {
        slot.pelanggar.push(`${a.txHash.slice(0, 8)} (receipt ${fmt(maxReceipt)} Tgas)`);
      }
      perMethod.set(method, slot);
    } catch (e) {
      errorRpc++;
      console.error(`  ⚠️ ${a.txHash.slice(0, 8)} (${method}): ${String(e.message ?? e).slice(0, 110)}`);
    }
  }

  const rows = [...perMethod.entries()]
    .sort((a, b) => b[1].maxReceiptTgas - a[1].maxReceiptTgas)
    .map(([method, s]) => {
      const status = s.pelanggar.length
        ? `❌ PELANGGAR ADR-01 (${s.pelanggar.join(", ")})`
        : "✅ < 6 TGas";
      return `| \`${method}\` | ${s.n} | ${fmt(s.maxReceiptTgas)} | ${fmt(s.totalTgas)} | ${status} |`;
    });

  const pelanggarTotal = [...perMethod.values()].reduce((a, s) => a + s.pelanggar.length, 0);
  const md = `# SEC-110 — Profil Gas per Receipt (kebijakan ADR-01: receipt < 6 TGas)

Dihasilkan otomatis oleh \`scripts/gas-profile.mjs\` dari \`reports/gladi-manifest.json\`
(${seen.size} hash unik diukur; ${errorRpc} error RPC; ${gagalEksekusi} tx gagal dieksekusi).
RPC: \`${RPC}\`. Kolom "receipt terbesar" = \`gas_burnt\` receipt TUNGGAL terbesar dalam tx
(bukan total tx — total tx bisa > 6 TGas karena multi-receipt; kebijakan ADR-01 mengikat
**per receipt**).

**Hasil: ${pelanggarTotal} pelanggar ADR-01 dari ${seen.size} tx.** ${pelanggarTotal === 0 ? "Semua receipt < 6 TGas ✓" : "PERIKSA method berikut ⚠️"}

| Method | n (tx) | Receipt terbesar (Tgas) | Total tx (Tgas) | Status ADR-01 |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## Catatan

- Kolom "Total tx" = Σ gas_burnt seluruh receipt tx — informasi, BUKAN subjek kebijakan ADR-01.
- \`materialize_subaccount\` wajar di atas rata-rata: \`create_account\` + transfer + callback 2 receipt.
- Angka dari receipt on-chain testnet; berbeda antar-run karena state. Sample kecil — bukan klaim biaya produksi.
- Script ini identik sumber datanya dengan \`econ-gas.mjs\` (ECON-107..108); SEC-110 fokus pada kebijakan **per-receipt**, ECON pada transparansi total.

$SNACC testnet tanpa nilai uang.
`;

  await writeFile(OUT, md, "utf8");
  console.log(md);
  console.error(`OK — ditulis ke ${OUT}; pelanggar ADR-01: ${pelanggarTotal}`);
  process.exit(pelanggarTotal > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * gas-profile.mjs — SEC-110: per-RECEIPT gas profile of the gladi txs, measured from
 * on-chain receipts (not estimates). Policy `ADR-01`: a single receipt < 6 TGas —
 * this script asserts that and flags violators.
 *
 * Source: `reports/gladi-manifest.json` (kpi, txHash, signer, note).
 * RPC: `--rpc` (default https://near-testnet.drpc.org).
 * Output: `reports/gas-profile.md` (table per method: largest receipt + status).
 * Exits 1 if any receipt ≥ 6 TGas (ADR-01 violation) — exit 0 = safe.
 *
 * Usage: node gas-profile.mjs [--rpc URL] [--manifest PATH] [--out PATH]
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
const LIMIT_TGAS = 6; // ADR-01: a single receipt < 6 TGas

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
  if (!m) return "(no note)";
  if (m.startsWith("FAILED")) return "(failed tx)";
  return m.split(/[\s(]/)[0].toLowerCase();
}

const fmt = (g) => (g / 1e12).toFixed(3);

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const actions = (manifest.actions ?? []).filter((a) => a.txHash);
  const seen = new Set();
  const perMethod = new Map(); // method → { maxReceiptTgas, totalTgas, n, violators[] }
  let rpcErrors = 0;
  let executionFailures = 0;

  for (const a of actions) {
    if (seen.has(a.txHash)) continue;
    seen.add(a.txHash);
    const method = methodOf(a.note);
    try {
      const r = await rpcCall("tx", [a.txHash, a.signer ?? manifest.signer]);
      const outs = [r.transaction_outcome, ...(r.receipts_outcome ?? [])].filter(Boolean);
      if (!outs.length) {
        rpcErrors++;
        continue;
      }
      const receipts = outs.map((o) => ({
        gas: o.outcome?.gas_burnt ?? 0,
        failed:
          o.outcome?.status?.Failure !== undefined ||
          (o.outcome?.status?.SuccessValue === undefined &&
            o.outcome?.status?.SuccessReceiptId === undefined),
      }));
      const maxReceipt = Math.max(...receipts.map((x) => x.gas));
      const total = receipts.reduce((acc, x) => acc + x.gas, 0);
      const anyFailed = receipts.some((x) => x.failed);
      if (anyFailed) executionFailures++;
      const slot = perMethod.get(method) ?? {
        maxReceiptTgas: 0,
        totalTgas: 0,
        n: 0,
        violators: [],
      };
      slot.n++;
      slot.totalTgas += total;
      if (maxReceipt > slot.maxReceiptTgas) slot.maxReceiptTgas = maxReceipt;
      if (maxReceipt / 1e12 >= LIMIT_TGAS) {
        slot.violators.push(`${a.txHash.slice(0, 8)} (receipt ${fmt(maxReceipt)} Tgas)`);
      }
      perMethod.set(method, slot);
    } catch (e) {
      rpcErrors++;
      console.error(`  ⚠️ ${a.txHash.slice(0, 8)} (${method}): ${String(e.message ?? e).slice(0, 110)}`);
    }
  }

  const rows = [...perMethod.entries()]
    .sort((a, b) => b[1].maxReceiptTgas - a[1].maxReceiptTgas)
    .map(([method, s]) => {
      const status = s.violators.length
        ? `❌ ADR-01 VIOLATOR (${s.violators.join(", ")})`
        : "✅ < 6 TGas";
      return `| \`${method}\` | ${s.n} | ${fmt(s.maxReceiptTgas)} | ${fmt(s.totalTgas)} | ${status} |`;
    });

  const violatorsTotal = [...perMethod.values()].reduce((a, s) => a + s.violators.length, 0);
  const md = `# SEC-110 — Gas Profile per Receipt (policy ADR-01: receipt < 6 TGas)

Generated automatically by \`scripts/gas-profile.mjs\` from \`reports/gladi-manifest.json\`
(${seen.size} unique hashes measured; ${rpcErrors} RPC errors; ${executionFailures} txs failed on execution).
RPC: \`${RPC}\`. The "largest receipt" column = the largest SINGLE receipt \`gas_burnt\` within a tx
(not the tx total — a tx total can exceed 6 TGas because of multiple receipts; the ADR-01 policy binds
**per receipt**).

**Result: ${violatorsTotal} ADR-01 violators out of ${seen.size} txs.** ${violatorsTotal === 0 ? "All receipts < 6 TGas ✓" : "CHECK the following methods ⚠️"}

| Method | n (tx) | Largest receipt (Tgas) | Tx total (Tgas) | ADR-01 status |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## Notes

- The "Tx total" column = Σ gas_burnt of all receipts in the tx — informational, NOT subject to the ADR-01 policy.
- \`materialize_subaccount\` is expected to run above average: \`create_account\` + transfer + 2-receipt callback.
- Numbers come from on-chain testnet receipts; they differ between runs because of state. Small sample — not a production cost claim.
- This script has the same data source as \`econ-gas.mjs\` (ECON-107..108); SEC-110 focuses on the **per-receipt** policy, ECON on total transparency.

$SNACC testnet has no monetary value.
`;

  await writeFile(OUT, md, "utf8");
  console.log(md);
  console.error(`OK — written to ${OUT}; ADR-01 violators: ${violatorsTotal}`);
  process.exit(violatorsTotal > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});

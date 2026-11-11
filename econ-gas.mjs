#!/usr/bin/env node
// econ-gas.mjs — ECON-107..108: gas per epoch loop vs the NEP-141 `ft_transfer` baseline.
//
// Honesty principle (Backlog Master, ECON-107..108): this is TRANSPARENCY, not a savings claim.
// Every number comes from the on-chain outcome of the rehearsal transactions listed in
// `evidence/gladi-manifest.json`, read from the NearBlocks v3 explorer API (`GET /v3/txns/<hash>`,
// no API key). Nothing is estimated and nothing is extrapolated beyond the explicit "epoch loop"
// compositions below, which are labelled as assumptions. `$SNACC` has no monetary value; the NEAR
// figures are gas fees, not prices.
//
// Why the explorer and not RPC `tx`: a pruned RPC node answers NOT_OBSERVED for transactions older than
// a few epochs, so the rehearsal receipts are no longer readable there; the explorer keeps them.
//
// Metrics per transaction (`outcomes_agg` / `actions_agg` of the explorer response):
//   burnt_gas    gas_used — Σ gas_burnt over the whole receipt tree (conversion + execution + the
//                gas-refund receipt). It is the same quantity RPC reports per receipt, summed.
//   fee          transaction_fee — yoctoNEAR actually burnt (gas_burnt × gas price at execution).
//   prepaid_gas  gas_attached — what the signer locked up front (the unused part is refunded).
//
// Usage:
//   SNACC_EXPLORER_API=<explorer api base url> node econ-gas.mjs [--manifest PATH] [--json OUT]
//   --api URL      overrides SNACC_EXPLORER_API. There is no default on purpose: the operator names the
//                  network the manifest was recorded on (the base URL differs per network).
//   --root DIR     umbrella root (default: parent of this script; or SNACC_ROOT)
// Exit code: 0 ok · 1 no baseline / no measured tx · 2 fatal error.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TGAS = 1e12;

// Epoch-loop compositions. These are ASSUMPTIONS about what a player does in one epoch, built only from
// methods that exist in the contract (`allocate_atp` is limited to once per epoch by its quota; the others
// are discretionary). They are not a measurement of real player behaviour.
export const EPOCH_LOOPS = [
  { id: "keep-alive", label: "keep-alive (feed only)", methods: ["feed_strain"] },
  { id: "minimal-active", label: "minimal active (feed + allocate)", methods: ["feed_strain", "allocate_atp"] },
  {
    id: "full-production",
    label: "full production (feed + allocate + 3-stage chain)",
    methods: ["feed_strain", "allocate_atp", "extract_spores", "transmute_spores_to_enzyme", "synthesize_elixir"],
  },
];

/** Reduce one explorer `/v3/txns/<hash>` payload to the measured row. Returns null when unusable. */
export function summarizeTx(hash, payload) {
  const d = payload?.data;
  const call = (d?.actions ?? []).find((a) => a.action === "FUNCTION_CALL");
  if (!d || !call?.method || d.outcomes_agg?.gas_used === undefined || d.outcomes_agg?.transaction_fee === undefined) {
    return null;
  }
  return {
    hash,
    method: call.method,
    burntGas: BigInt(d.outcomes_agg.gas_used),
    prepaidGas: BigInt(d.actions_agg?.gas_attached ?? 0),
    fee: BigInt(d.outcomes_agg.transaction_fee),
    failed: d.outcomes?.status !== true,
  };
}

/** Group measured rows by method. Failed transactions are listed separately and never averaged. */
export function aggregate(rows) {
  const by = new Map();
  const failed = [];
  for (const r of rows) {
    if (r.failed) {
      failed.push(r);
      continue;
    }
    const s = by.get(r.method) ?? { method: r.method, burnt: [], prepaid: [], fee: [] };
    s.burnt.push(r.burntGas);
    s.prepaid.push(r.prepaidGas);
    s.fee.push(r.fee);
    by.set(r.method, s);
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0n) / BigInt(xs.length);
  const methods = [...by.values()].map((s) => ({
    method: s.method,
    n: s.burnt.length,
    burntMean: mean(s.burnt),
    burntMin: s.burnt.reduce((a, b) => (b < a ? b : a)),
    burntMax: s.burnt.reduce((a, b) => (b > a ? b : a)),
    prepaidMean: mean(s.prepaid),
    feeMean: mean(s.fee),
  }));
  methods.sort((a, b) => (a.burntMean < b.burntMean ? 1 : a.burntMean > b.burntMean ? -1 : 0));
  return { methods, failed };
}

/** Cost of one epoch loop from measured per-method means. Missing methods are reported, not guessed. */
export function loopCost(methods, loop) {
  const byName = new Map(methods.map((m) => [m.method, m]));
  const missing = loop.methods.filter((name) => !byName.has(name));
  if (missing.length) return { ...loop, missing, burnt: null, fee: null };
  return {
    ...loop,
    missing: [],
    burnt: loop.methods.reduce((a, name) => a + byName.get(name).burntMean, 0n),
    fee: loop.methods.reduce((a, name) => a + byName.get(name).feeMean, 0n),
  };
}

export const tgas = (g) => (Number(g) / TGAS).toFixed(3);
export const near = (y) => (Number(y) / 1e24).toFixed(6);

function arg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTx(api, hash) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${api}/v3/txns/${hash}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 429) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error("HTTP 429 (rate limited)");
}

async function main() {
  const argv = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(arg(argv, "root", process.env.SNACC_ROOT ?? resolve(here, "..")));
  const api = (arg(argv, "api", process.env.SNACC_EXPLORER_API) ?? "").replace(/\/+$/, "");
  if (!api) {
    console.error("SNACC_EXPLORER_API (or --api) is required: the explorer API base url of the manifest's network.");
    process.exit(2);
  }
  const manifestPath = resolve(arg(argv, "manifest", resolve(root, "evidence/gladi-manifest.json")));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const hashes = [...new Set((manifest.actions ?? []).map((a) => a.txHash).filter(Boolean))];

  const rows = [];
  const unreadable = [];
  for (const hash of hashes) {
    try {
      const row = summarizeTx(hash, await fetchTx(api, hash));
      if (row) rows.push(row);
      else unreadable.push({ hash, reason: "no function call / outcome fields" });
    } catch (e) {
      unreadable.push({ hash, reason: String(e.message ?? e) });
    }
    await sleep(150);
  }

  const { methods, failed } = aggregate(rows);
  const baseline = methods.find((m) => m.method === "ft_transfer");
  if (!baseline) {
    console.error(`no measured ft_transfer baseline (${rows.length} txs read, ${unreadable.length} unreadable)`);
    process.exit(1);
  }
  const loops = EPOCH_LOOPS.map((l) => loopCost(methods, l));
  const ratio = (g) => (Number(g) / Number(baseline.burntMean)).toFixed(2);

  console.log(`measured ${rows.length} of ${hashes.length} txs (${unreadable.length} unreadable, ${failed.length} failed on execution)\n`);
  console.log("| method | n | burnt mean (TGas) | burnt min..max (TGas) | prepaid mean (TGas) | fee mean (NEAR) | x ft_transfer |");
  console.log("| --- | ---: | ---: | --- | ---: | ---: | ---: |");
  for (const m of methods) {
    console.log(
      `| \`${m.method}\` | ${m.n} | ${tgas(m.burntMean)} | ${tgas(m.burntMin)}..${tgas(m.burntMax)} | ${tgas(m.prepaidMean)} | ${near(m.feeMean)} | ${ratio(m.burntMean)} |`,
    );
  }
  console.log("\n| epoch loop | methods | burnt (TGas) | fee (NEAR) | x ft_transfer |");
  console.log("| --- | --- | ---: | ---: | ---: |");
  for (const l of loops) {
    if (l.burnt === null) {
      console.log(`| ${l.label} | ${l.methods.join(" + ")} | not measured (missing: ${l.missing.join(", ")}) | — | — |`);
    } else {
      console.log(`| ${l.label} | ${l.methods.join(" + ")} | ${tgas(l.burnt)} | ${near(l.fee)} | ${ratio(l.burnt)} |`);
    }
  }
  for (const u of unreadable) console.error(`unreadable ${u.hash.slice(0, 8)}: ${u.reason.slice(0, 100)}`);

  const out = arg(argv, "json", "");
  if (out) {
    const report = {
      measuredAt: new Date().toISOString(),
      txListed: hashes.length,
      txRead: rows.length,
      txUnreadable: unreadable.length,
      txFailed: failed.length,
      methods: methods.map((m) => ({
        method: m.method,
        n: m.n,
        burntMean: m.burntMean.toString(),
        burntMin: m.burntMin.toString(),
        burntMax: m.burntMax.toString(),
        prepaidMean: m.prepaidMean.toString(),
        feeMean: m.feeMean.toString(),
      })),
      loops: loops.map((l) => ({
        id: l.id,
        methods: l.methods,
        missing: l.missing,
        burnt: l.burnt?.toString() ?? null,
        fee: l.fee?.toString() ?? null,
      })),
    };
    await writeFile(resolve(out), JSON.stringify(report, null, 2) + "\n", "utf8");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}

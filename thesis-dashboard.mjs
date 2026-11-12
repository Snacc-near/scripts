#!/usr/bin/env node
// thesis-dashboard.mjs — RES-115: thesis metrics summary (offline, fail-closed).
//
// Track: `thesis` ("judged on the evidence").
// Everything here is TESTNET (`snacc-v001.testnet`). Snacc is testnet-only; no mainnet deployment exists.
// This script never queries the chain. It evaluates a RECORDED snapshot from the 2026-11-09 rehearsal
// (docs/evidence-pack.md, evidence/gladi-manifest.json) and prints, for every number, the tx hash that
// backs it or the words "not verified". For live re-checks run `npm run verify:thesis` (umbrella repo).
//
// Status vocabulary (nothing is ever "proven" by default; missing input => NOT VERIFIED):
//   VERIFIED      the check passes on the supplied data AND at least one evidence tx hash is attached.
//   RECORDED      the check passes on a recorded view snapshot; there is no tx hash for it.
//   COMPUTED      arithmetic on constants only; not a measurement.
//   NOT VERIFIED  the check failed or an input was missing.
//
// Metrics:
//   M1: on-chain SVG storage arithmetic (1,734-byte budget; the baseline is an ASSUMPTION), falsifier F-01.
//   M2: supply contraction (explicit burns on chain), falsifier F-02.
//   M3: TEE ed25519 signature re-verification, falsifier F-03.
//   M4: global solvency view (drift = 0), rules I-01 / I-04 / I-15.
//
// Usage:
//   node thesis-dashboard.mjs [--out PATH] [--root UMBRELLA_ROOT]

import { writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, createPublicKey, verify } from "node:crypto";

export const CONTRACT = "snacc-v001.testnet";
export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";

export const THESIS_METRICS = {
  svgBytes: 1734, // byte BUDGET for the on-chain SVG (real SVGs in the rehearsal were 448–480 B)
  baselineBytes: 11129, // ASSUMED static-metadata baseline (not a measurement)
  storageSavingPct: 84.42,
  claimedNearPerNft: 0.01734,
};

/** Evidence tx hashes from the rehearsal manifest (all on `snacc-v001.testnet`). */
export const EVIDENCE_TX = {
  ftBurn: "ERBRL4rTS6JHEKVsSumLYtru1hXsSYWdkGJH8d1krJaL", // evidence-pack M3
  thermostatFever: "CfBR8pFNCGAjCAX21pSMQY9rdjQ2cVKonkzacFjmZpM8", // evidence-pack M4 (burn of part of the fee)
  teeRegisterSigner: "BovEAtK5gUZ6dthCX5Cn6qHnmZZ9bhtSTpGuYXRqYgfw", // evidence-pack P2
  teeCommit: "EnXBEETdyG4TcjmrzGgJxzczGcxMshXZuEBorG8yHwDC", // evidence-pack P3
  teeApply: "B8xdaukdnf3Fh9ZkMNfXxXW7TrHVLZLeXQNdYyBtD2AG", // evidence-pack P3
};

/** Recorded snapshot (rehearsal 2026-11-09). Values were read via views; there is no tx hash for a view. */
export const RECORDED_SNAPSHOT = {
  readAt: "2026-11-09",
  total_snacc_supply: "2214172107344538958560658", // view ft_total_supply (evidence-pack M2)
  total_snacc_burned: "35827892655461041439342", // view get_macro_state (evidence-pack M3)
  total_minted: "2250000000000000000000000", // view get_global_solvency (evidence-pack C2)
  drift: "0", // view get_global_solvency
};

const txRef = (h) => ({ txHash: h, url: `${EXPLORER_TX}${h}` });

/** Evaluates the storage arithmetic (F-01). This is arithmetic on constants plus the mainnet price; not a measurement. */
export function evaluateStorageMetric(runtimeStorageAmountPerByte = 10_000_000_000_000_000_000n) {
  const costYocto = runtimeStorageAmountPerByte * BigInt(THESIS_METRICS.svgBytes);
  const costNear = Number(costYocto) / 1e24;
  const savingPct = (1 - THESIS_METRICS.svgBytes / THESIS_METRICS.baselineBytes) * 100;

  const costMatch = Math.abs(costNear - THESIS_METRICS.claimedNearPerNft) <= 0.0002;
  const savingMatch = Math.abs(savingPct - THESIS_METRICS.storageSavingPct) <= 0.5;

  return {
    id: "M1_STORAGE_OPTIMIZATION",
    title: "On-chain SVG storage arithmetic (budget 1,734 B)",
    status: costMatch && savingMatch ? "COMPUTED" : "NOT VERIFIED",
    value: `${costNear.toFixed(5)} NEAR / NFT (budget; real SVGs were 448–480 B)`,
    savingsPct: `${savingPct.toFixed(2)}% (against an ASSUMED ${THESIS_METRICS.baselineBytes} B baseline)`,
    svgBytes: THESIS_METRICS.svgBytes,
    baselineBytes: THESIS_METRICS.baselineBytes,
    evidence: [],
    evidenceNote: "No tx hash: arithmetic only. Price per byte is read from the mainnet protocol config by `npm run verify:thesis` (F-01); the baseline is an assumption.",
    falsifierStatus: "F-01 arithmetic consistent (baseline assumed)",
  };
}

/** Evaluates the supply contraction check (F-02). `peak_supply` must be supplied; there is no fallback. */
export function evaluateSupplyContractionMetric(macroState = {}, evidenceTxHashes = []) {
  const supplyRaw = macroState.total_snacc_supply ?? macroState.totalSnaccSupply;
  const burnedRaw = macroState.total_snacc_burned ?? macroState.totalSnaccBurned;
  const peakRaw = macroState.peak_supply;
  const complete = supplyRaw != null && burnedRaw != null && peakRaw != null;

  const supply = complete ? BigInt(supplyRaw) : 0n;
  const burned = complete ? BigInt(burnedRaw) : 0n;
  const peakSupply = complete ? BigInt(peakRaw) : 0n;

  const burnVerified = complete && burned > 0n;
  const supplyBounded = complete && supply <= peakSupply;
  const hasTx = evidenceTxHashes.length > 0;
  const passes = burnVerified && supplyBounded;

  return {
    id: "M2_SUPPLY_CONTRACTION",
    title: "Supply contraction (explicit ft_burn on chain)",
    status: passes && hasTx ? "VERIFIED" : passes ? "RECORDED" : "NOT VERIFIED",
    currentSupply: supply.toString(),
    totalBurned: burned.toString(),
    isBounded: supplyBounded,
    burnMonotonic: burnVerified,
    evidence: evidenceTxHashes.map(txRef),
    evidenceNote: hasTx ? "Burn txs attached." : "No tx hash attached: not verified by transaction.",
    falsifierStatus: passes ? "F-02 consistent with the recorded snapshot" : "F-02 not verified (missing or failing input)",
  };
}

/**
 * Re-verifies a TEE response vector offline (ed25519 over `<model>:<req_sha256>:<res_sha256>`).
 * Returns true ONLY when the signed text matches and the signature verifies; any error returns false.
 */
export function verifyTeeVector(v, model = "z-ai/glm-5.3-flash") {
  try {
    if (!v || !v.raw_response_body || !v.req_sha256_hex || !v.tee_pubkey_hex || !v.signature_hex) return false;
    const resSha = createHash("sha256").update(v.raw_response_body).digest("hex");
    const signedText = `${model}:${v.req_sha256_hex}:${resSha}`;
    if (v.signed_text !== undefined && signedText !== v.signed_text) return false;
    const pub = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(v.tee_pubkey_hex, "hex").toString("base64url") },
      format: "jwk",
    });
    return verify(null, Buffer.from(signedText, "utf8"), pub, Buffer.from(v.signature_hex, "hex")) === true;
  } catch {
    return false;
  }
}

/** Evaluates the TEE signature check (F-03). Defaults are fail-closed: nothing is verified unless the caller says so. */
export function evaluateTeeZeroTrustMetric(teeReport = {}, evidenceTxHashes = []) {
  const signatureVerified = teeReport.signatureVerified === true;
  const antiReplayGuarded = teeReport.antiReplayGuarded === true;
  const hasTx = evidenceTxHashes.length > 0;

  return {
    id: "M3_TEE_ZERO_TRUST",
    title: "TEE response signature re-verification (ed25519)",
    status: signatureVerified && hasTx ? "VERIFIED" : signatureVerified ? "RECORDED" : "NOT VERIFIED",
    model: teeReport.model ?? "z-ai/glm-5.3-flash",
    cryptoAlgorithm: "ed25519 (env::ed25519_verify)",
    signatureVerified,
    antiReplayGuarded,
    evidence: evidenceTxHashes.map(txRef),
    evidenceNote:
      "Signature check is an offline re-computation over the recorded vector. It shows a valid signature, not enclave attestation (not verified). " +
      (antiReplayGuarded ? "Replay guard: supplied by caller." : "Replay guard: not verified here (no rejection tx recorded)."),
    falsifierStatus: signatureVerified ? "F-03 signature re-verified offline" : "F-03 not verified",
  };
}

/** Evaluates the global solvency view (drift = 0). Missing data is NOT VERIFIED. */
export function evaluateMacroSolvencyMetric(solvencyData = {}) {
  const hasDrift = solvencyData.drift !== undefined && solvencyData.drift !== null;
  const drift = hasDrift ? BigInt(solvencyData.drift) : 0n;
  const isSolvent = solvencyData.solvent === true;
  const passes = hasDrift && isSolvent && drift === 0n;

  return {
    id: "M4_CIRCULAR_SOLVENCY",
    title: "Global solvency view (drift = 0)",
    status: passes ? "RECORDED" : "NOT VERIFIED",
    driftYocto: hasDrift ? drift.toString() : "unknown",
    evidence: [],
    evidenceNote: `View get_global_solvency read ${solvencyData.readAt ?? "at an unknown time"}; no tx hash for a view.`,
    falsifierStatus: passes ? "Recorded view: drift 0 (I-01 / I-04 / I-15)" : "Not verified (missing or failing input)",
  };
}

/** SQL query TEMPLATES for public replication. Not executed by this script. Snacc is testnet-only. */
export function generateDuneAnalyticsQueries() {
  const label = "-- query template — not executed; Snacc is testnet-only";
  return [
    {
      name: "snacc_storage_economics_dune.sql",
      description: "Template: storage rent arithmetic for a 1,734-byte budget vs an ASSUMED static-metadata baseline",
      sql: `${label}
-- Dune Analytics: Snacc Storage Economics Comparison (arithmetic only)
SELECT
  1734 AS snacc_svg_bytes_budget,
  11129 AS assumed_static_baseline_bytes,
  (1 - (1734.0 / 11129.0)) * 100 AS storage_savings_percent_vs_assumed_baseline,
  (1734 * 1e19) / 1e24 AS near_cost_per_nft;
`,
    },
    {
      name: "snacc_thermostat_burns_dune.sql",
      description: "Template: NEP-141 ft_burn receipts on snacc-v001.testnet",
      sql: `${label}
-- Dune Analytics: Snacc Thermostat NEP-141 Burns (testnet contract)
SELECT
  block_timestamp,
  tx_hash,
  (args->>'amount')::numeric / 1e24 AS burned_snacc_amount,
  args->>'memo' AS burn_reason
FROM near.receipt_actions
WHERE receiver_id = 'snacc-v001.testnet'
  AND method_name = 'ft_burn'
ORDER BY block_timestamp DESC;
`,
    },
    {
      name: "snacc_great_feast_leaderboard_dune.sql",
      description: "Template: top feeders per epoch from feed_strain calls on snacc-v001.testnet",
      sql: `${label}
-- Dune Analytics: Snacc The Great Feast Top Feeders (testnet contract)
SELECT
  (args->>'epoch')::integer AS epoch,
  args->>'strain_id' AS strain_id,
  (args->>'effective_fee')::numeric / 1e18 AS fee_snacc,
  args->>'atp_minted' AS atp_minted
FROM near.receipt_actions
WHERE receiver_id = 'snacc-v001.testnet'
  AND method_name = 'feed_strain'
ORDER BY epoch DESC, fee_snacc DESC;
`,
    },
  ];
}

function arg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

async function loadTeeVector(root) {
  try {
    return JSON.parse(await readFile(resolve(root, "evidence/tee-vector-live.json"), "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const outPath = arg(argv, "out", "");
  const here = dirname(fileURLToPath(import.meta.url));
  const root = arg(argv, "root", process.env.SNACC_ROOT ?? resolve(here, ".."));

  const vector = await loadTeeVector(root);
  const signatureVerified = verifyTeeVector(vector);

  const metrics = [
    evaluateStorageMetric(10_000_000_000_000_000_000n),
    evaluateSupplyContractionMetric(
      {
        total_snacc_supply: RECORDED_SNAPSHOT.total_snacc_supply,
        total_snacc_burned: RECORDED_SNAPSHOT.total_snacc_burned,
        peak_supply: RECORDED_SNAPSHOT.total_minted,
      },
      [EVIDENCE_TX.ftBurn, EVIDENCE_TX.thermostatFever],
    ),
    evaluateTeeZeroTrustMetric(
      { signatureVerified, model: "z-ai/glm-5.3-flash" },
      signatureVerified ? [EVIDENCE_TX.teeRegisterSigner, EVIDENCE_TX.teeCommit, EVIDENCE_TX.teeApply] : [],
    ),
    evaluateMacroSolvencyMetric({ drift: RECORDED_SNAPSHOT.drift, solvent: true, readAt: RECORDED_SNAPSHOT.readAt }),
  ];

  const queries = generateDuneAnalyticsQueries();

  console.log(`THESIS METRICS — ${CONTRACT} (NEAR testnet). Offline evaluation of a recorded snapshot (${RECORDED_SNAPSHOT.readAt}); nothing is queried live.`);
  for (const m of metrics) {
    console.log(`[${m.status}] ${m.id} — ${m.title}`);
    console.log(`       Check: ${m.falsifierStatus}`);
    if (m.value) console.log(`       Value: ${m.value} (Savings: ${m.savingsPct})`);
    if (m.totalBurned) console.log(`       Burned: ${m.totalBurned} yoctoSNACC (recorded view; tx evidence below)`);
    if (m.evidence.length) for (const e of m.evidence) console.log(`       Evidence tx: ${e.url}`);
    console.log(`       Note: ${m.evidenceNote}`);
  }
  if (!vector) console.log(`TEE vector not found under ${resolve(root, "evidence")}: M3 is NOT VERIFIED.`);

  if (outPath) {
    await writeFile(resolve(outPath), JSON.stringify({ metrics, queries }, null, 2), "utf8");
    console.log(`Saved dashboard data to: ${outPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

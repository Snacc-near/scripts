// thesis-dashboard.test.mjs — RES-115: unit tests for the thesis metrics module (fail-closed behaviour).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateStorageMetric,
  evaluateSupplyContractionMetric,
  evaluateTeeZeroTrustMetric,
  evaluateMacroSolvencyMetric,
  generateDuneAnalyticsQueries,
  verifyTeeVector,
  EVIDENCE_TX,
} from "./thesis-dashboard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("evaluateStorageMetric is labelled COMPUTED (arithmetic, assumed baseline), never verified", () => {
  const res = evaluateStorageMetric(10_000_000_000_000_000_000n);
  assert.equal(res.status, "COMPUTED");
  assert.equal(res.svgBytes, 1734);
  assert.equal(res.baselineBytes, 11129);
  assert.ok(res.savingsPct.startsWith("84.42"));
  assert.ok(res.savingsPct.includes("ASSUMED"));
  assert.ok(res.value.includes("0.01734"));
  assert.deepEqual(res.evidence, []);
});

test("evaluateStorageMetric with a wrong price per byte is NOT VERIFIED", () => {
  assert.equal(evaluateStorageMetric(1n).status, "NOT VERIFIED");
});

test("evaluateSupplyContractionMetric is VERIFIED only with a tx hash attached", () => {
  const state = { total_snacc_supply: "1000", total_snacc_burned: "50", peak_supply: "1100" };
  const withTx = evaluateSupplyContractionMetric(state, [EVIDENCE_TX.ftBurn]);
  assert.equal(withTx.status, "VERIFIED");
  assert.equal(withTx.burnMonotonic, true);
  assert.equal(withTx.isBounded, true);
  assert.equal(withTx.evidence[0].url, `https://testnet.nearblocks.io/txns/${EVIDENCE_TX.ftBurn}`);
  assert.equal(evaluateSupplyContractionMetric(state).status, "RECORDED");
});

test("evaluateSupplyContractionMetric fails closed on missing inputs and on an absent peak", () => {
  assert.equal(evaluateSupplyContractionMetric({}).status, "NOT VERIFIED");
  // No fallback peak (the old `supply + burned` fallback made the bound a tautology).
  assert.equal(
    evaluateSupplyContractionMetric({ total_snacc_supply: "1000", total_snacc_burned: "50" }, ["x"]).status,
    "NOT VERIFIED",
  );
  assert.equal(
    evaluateSupplyContractionMetric({ total_snacc_supply: "1200", total_snacc_burned: "50", peak_supply: "1100" }, ["x"]).status,
    "NOT VERIFIED",
  );
});

test("evaluateTeeZeroTrustMetric defaults to NOT VERIFIED (fail-closed)", () => {
  const res = evaluateTeeZeroTrustMetric();
  assert.equal(res.status, "NOT VERIFIED");
  assert.equal(res.signatureVerified, false);
  assert.equal(res.antiReplayGuarded, false);
  assert.equal(evaluateTeeZeroTrustMetric({}).status, "NOT VERIFIED");
  assert.equal(evaluateTeeZeroTrustMetric({ signatureVerified: "true" }).status, "NOT VERIFIED");
});

test("evaluateTeeZeroTrustMetric is VERIFIED only with a verified signature and tx evidence", () => {
  assert.equal(evaluateTeeZeroTrustMetric({ signatureVerified: true }, [EVIDENCE_TX.teeApply]).status, "VERIFIED");
  assert.equal(evaluateTeeZeroTrustMetric({ signatureVerified: true }).status, "RECORDED");
});

test("verifyTeeVector rejects missing, empty and tampered vectors", () => {
  assert.equal(verifyTeeVector(undefined), false);
  assert.equal(verifyTeeVector({}), false);
  assert.equal(verifyTeeVector({ raw_response_body: "x", req_sha256_hex: "00", tee_pubkey_hex: "00", signature_hex: "00" }), false);
});

test("verifyTeeVector accepts the recorded vector when present and rejects a tampered copy", () => {
  const p = resolve(HERE, "..", "evidence", "tee-vector-live.json");
  if (!existsSync(p)) return; // only available inside the umbrella repo
  const v = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(verifyTeeVector(v), true);
  assert.equal(verifyTeeVector({ ...v, raw_response_body: v.raw_response_body + " " }), false);
});

test("evaluateMacroSolvencyMetric is RECORDED (view, no tx) only with explicit zero drift and solvent=true", () => {
  const res = evaluateMacroSolvencyMetric({ drift: 0, solvent: true, readAt: "2026-11-09" });
  assert.equal(res.status, "RECORDED");
  assert.equal(res.driftYocto, "0");
  assert.deepEqual(res.evidence, []);
  assert.ok(res.evidenceNote.includes("no tx hash"));
});

test("evaluateMacroSolvencyMetric fails closed on missing or failing data", () => {
  assert.equal(evaluateMacroSolvencyMetric().status, "NOT VERIFIED");
  assert.equal(evaluateMacroSolvencyMetric({ solvent: true }).status, "NOT VERIFIED");
  assert.equal(evaluateMacroSolvencyMetric({ drift: 0 }).status, "NOT VERIFIED");
  assert.equal(evaluateMacroSolvencyMetric({ drift: 5, solvent: true }).status, "NOT VERIFIED");
});

test("generateDuneAnalyticsQueries: templates are labelled, target testnet, never mainnet", () => {
  const queries = generateDuneAnalyticsQueries();
  assert.ok(queries.length >= 3);
  for (const q of queries) {
    assert.ok(q.name.endsWith(".sql"));
    assert.ok(q.sql.includes("SELECT"));
    assert.ok(q.sql.includes("query template — not executed; Snacc is testnet-only"));
    assert.ok(!q.sql.includes("snacc-v001.near"));
  }
  assert.ok(queries.some((q) => q.sql.includes("snacc-v001.testnet")));
});

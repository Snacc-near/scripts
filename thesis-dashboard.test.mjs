// thesis-dashboard.test.mjs — RES-115: unit tests for empirical thesis proof dashboard module.
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStorageMetric,
  evaluateSupplyContractionMetric,
  evaluateTeeZeroTrustMetric,
  evaluateMacroSolvencyMetric,
  generateDuneAnalyticsQueries,
} from "./thesis-dashboard.mjs";

test("evaluateStorageMetric confirms 84.42% storage savings and 0.01734 NEAR per NFT", () => {
  const res = evaluateStorageMetric(10_000_000_000_000_000_000n);
  assert.equal(res.status, "PROVEN");
  assert.equal(res.svgBytes, 1734);
  assert.equal(res.baselineBytes, 11129);
  assert.ok(res.savingsPct.startsWith("84.42"));
  assert.ok(res.value.includes("0.01734"));
  assert.ok(res.falsifierStatus.includes("F-01 SATISFIED"));
});

test("evaluateSupplyContractionMetric validates burn and bound", () => {
  const res = evaluateSupplyContractionMetric({
    total_snacc_supply: "1000",
    total_snacc_burned: "50",
    peak_supply: "1100",
  });
  assert.equal(res.status, "PROVEN");
  assert.equal(res.burnMonotonic, true);
  assert.equal(res.isBounded, true);
  assert.ok(res.falsifierStatus.includes("F-02 SATISFIED"));
});

test("evaluateTeeZeroTrustMetric validates ed25519 and anti-replay", () => {
  const res = evaluateTeeZeroTrustMetric({
    signatureVerified: true,
    antiReplayGuarded: true,
  });
  assert.equal(res.status, "PROVEN");
  assert.equal(res.cryptoAlgorithm, "ed25519 (env::ed25519_verify)");
  assert.ok(res.falsifierStatus.includes("F-03 SATISFIED"));
});

test("evaluateMacroSolvencyMetric checks zero drift", () => {
  const res = evaluateMacroSolvencyMetric({ drift: 0, solvent: true });
  assert.equal(res.status, "PROVEN");
  assert.equal(res.driftYocto, "0");
  assert.ok(res.falsifierStatus.includes("CONSERVED"));
});

test("generateDuneAnalyticsQueries generates at least 3 queries", () => {
  const queries = generateDuneAnalyticsQueries();
  assert.ok(queries.length >= 3);
  for (const q of queries) {
    assert.ok(q.name.endsWith(".sql"));
    assert.ok(q.sql.includes("SELECT"));
  }
});

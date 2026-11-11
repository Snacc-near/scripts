// econ-gas.test.mjs — ECON-107..108: unit tests for the pure parts of econ-gas.mjs (no network).
// Fixture shapes follow the explorer `/v3/txns/<hash>` response; the ft_transfer numbers are copied from a real
// rehearsal transaction (G-02), the others are small synthetic rows that only exercise the arithmetic.
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTx, aggregate, loopCost, EPOCH_LOOPS, tgas, near } from "./econ-gas.mjs";

const payload = (method, gasUsed, fee, attached, status = true) => ({
  data: {
    actions: [{ action: "FUNCTION_CALL", method }],
    actions_agg: { gas_attached: String(attached) },
    outcomes: { status },
    outcomes_agg: { gas_used: String(gasUsed), transaction_fee: String(fee) },
  },
});

test("summarizeTx reads gas, fee and prepaid gas as bigint", () => {
  const row = summarizeTx("h1", payload("ft_transfer", "2833231030707", "261004846820700000000", "100000000000000"));
  assert.equal(row.method, "ft_transfer");
  assert.equal(row.burntGas, 2833231030707n);
  assert.equal(row.fee, 261004846820700000000n);
  assert.equal(row.prepaidGas, 100000000000000n);
  assert.equal(row.failed, false);
});

test("summarizeTx rejects payloads without a function call or outcome fields", () => {
  assert.equal(summarizeTx("h", { data: { actions: [{ action: "TRANSFER" }], outcomes_agg: {} } }), null);
  assert.equal(summarizeTx("h", { data: null }), null);
  assert.equal(summarizeTx("h", {}), null);
});

test("summarizeTx marks an unsuccessful outcome as failed", () => {
  assert.equal(summarizeTx("h", payload("feed_strain", 5, 5, 5, false)).failed, true);
});

test("aggregate averages per method and keeps failed rows out of the mean", () => {
  const rows = [
    summarizeTx("a", payload("feed_strain", 10_000, 100, 1_000)),
    summarizeTx("b", payload("feed_strain", 30_000, 300, 1_000)),
    summarizeTx("c", payload("feed_strain", 999_999, 999, 1_000, false)),
    summarizeTx("d", payload("ft_transfer", 4_000, 40, 1_000)),
  ];
  const { methods, failed } = aggregate(rows);
  const feed = methods.find((m) => m.method === "feed_strain");
  assert.equal(feed.n, 2);
  assert.equal(feed.burntMean, 20_000n);
  assert.equal(feed.burntMin, 10_000n);
  assert.equal(feed.burntMax, 30_000n);
  assert.equal(feed.feeMean, 200n);
  assert.equal(failed.length, 1);
  assert.equal(methods[0].method, "feed_strain", "sorted by burnt mean, heaviest first");
});

test("loopCost sums the measured means and never guesses a missing method", () => {
  const rows = [
    summarizeTx("a", payload("feed_strain", 10_000, 100, 1)),
    summarizeTx("b", payload("allocate_atp", 6_000, 60, 1)),
  ];
  const { methods } = aggregate(rows);
  const minimal = loopCost(methods, EPOCH_LOOPS.find((l) => l.id === "minimal-active"));
  assert.equal(minimal.burnt, 16_000n);
  assert.equal(minimal.fee, 160n);
  assert.deepEqual(minimal.missing, []);

  const full = loopCost(methods, EPOCH_LOOPS.find((l) => l.id === "full-production"));
  assert.equal(full.burnt, null);
  assert.deepEqual(full.missing, ["extract_spores", "transmute_spores_to_enzyme", "synthesize_elixir"]);
});

test("every loop only references method names that exist in the contract spec list", () => {
  const known = new Set([
    "feed_strain",
    "allocate_atp",
    "extract_spores",
    "transmute_spores_to_enzyme",
    "synthesize_elixir",
  ]);
  for (const loop of EPOCH_LOOPS) for (const m of loop.methods) assert.ok(known.has(m), m);
});

test("unit formatters", () => {
  assert.equal(tgas(2_833_231_030_707n), "2.833");
  assert.equal(near(261_004_846_820_700_000_000n), "0.000261");
});

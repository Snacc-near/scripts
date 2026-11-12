// social-leaderboard.test.mjs — RES-113: unit tests for SocialDB leaderboard publication module.
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatSocialPost,
  buildSocialDbPayload,
  SOCIAL_DB_CONTRACT,
  resolveApiBase,
  FIXTURE_DATA,
  FIXTURE_BANNER,
} from "./social-leaderboard.mjs";

test("SOCIAL_DB_CONTRACT points to standard social.near", () => {
  assert.equal(SOCIAL_DB_CONTRACT, "social.near");
});

test("formatSocialPost formats podium with top 3 feeders", () => {
  const post = formatSocialPost({
    epoch: 2,
    crucibleTempMk: 650,
    zone: "FEVER",
    feastVolume: "200000000000000000000",
    feastTarget: "100000000000000000000",
    topFeeders: [
      { account_id: "alice.near", amount: "100000000000000000000" },
      { account_id: "bob.near", amount: "50000000000000000000" },
      { account_id: "charlie.near", amount: "25000000000000000000" },
      { account_id: "david.near", amount: "10000000000000000000" },
    ],
  });

  assert.ok(post.includes("The Great Feast Leaderboard (Epoch 2)"));
  assert.ok(post.includes("`FEVER`"));
  assert.ok(post.includes("🥇 **#1 `alice.near`**"));
  assert.ok(post.includes("🥈 **#2 `bob.near`**"));
  assert.ok(post.includes("🥉 **#3 `charlie.near`**"));
  // 4th feeder is excluded from podium (top 3 cap)
  assert.ok(!post.includes("david.near"));
  assert.ok(post.includes("#SocialDB"));
});

test("formatSocialPost handles empty feeders gracefully", () => {
  const post = formatSocialPost({
    epoch: 0,
    topFeeders: [],
  });
  assert.ok(post.includes("No feeder contributions recorded"));
});

test("buildSocialDbPayload constructs compliant SocialDB set structure", () => {
  const text = "Hello SocialDB!";
  const payload = buildSocialDbPayload("alkemis.near", text);

  assert.ok(payload.data["alkemis.near"]);
  const post = payload.data["alkemis.near"].post;
  assert.ok(post.main);
  const parsedMain = JSON.parse(post.main);
  assert.equal(parsedMain.type, "md");
  assert.equal(parsedMain.text, text);

  const index = payload.data["alkemis.near"].index;
  assert.ok(index.post);
  const parsedIndex = JSON.parse(index.post);
  assert.equal(parsedIndex.key, "main");
});

test("buildSocialDbPayload rejects empty account ID", () => {
  assert.throws(() => buildSocialDbPayload("", "test"), /Invalid account ID/);
});

test("resolveApiBase has no default and fails with a clear message", () => {
  assert.throws(() => resolveApiBase([], {}), /No API base configured/);
  assert.equal(resolveApiBase(["--api", "http://x"], {}), "http://x");
  assert.equal(resolveApiBase([], { SNACC_API_BASE: "http://env" }), "http://env");
  assert.equal(resolveApiBase([], { VITE_API_BASE: "http://vite" }), "http://vite");
});

test("fixture data is invented, testnet-only, and labelled", () => {
  assert.ok(FIXTURE_BANNER.includes("FIXTURE"));
  assert.ok(FIXTURE_DATA.network.includes("FIXTURE"));
  for (const f of FIXTURE_DATA.topFeeders) assert.ok(f.account_id.endsWith(".testnet"));
});

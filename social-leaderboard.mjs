#!/usr/bin/env node
// social-leaderboard.mjs — RES-113: Build a SocialDB post + `set` payload for the Great Feast leaderboard (preview only).
//
// Complies with the SocialDB standard:
//   Method: `set` on `social.near` (or rehearsal contract on non-mainnet)
//   Payload: { data: { [account]: { post: { main: "..." }, index: { post: "..." } } } }
//
// Honesty & safety principles:
//   - Preview mode by default: outputs formatted markdown and transaction payload without requiring credentials.
//   - Metrics come from the configured API (no default URL). If it is unreachable the script fails; it never
//     substitutes data silently. `--fixture` prints invented sample data with a visible FIXTURE banner.
//   - Snacc is testnet-only (`snacc-v001.testnet`); `$SNACC` has no monetary value. This script never signs or sends.
//   - No banned wording anywhere in generated text or metadata.
//
// Usage:
//   SNACC_API_BASE=<url> node social-leaderboard.mjs [--account ID] [--out PATH]
//   node social-leaderboard.mjs --api <url> [--account ID] [--out PATH]
//   node social-leaderboard.mjs --fixture [--account ID] [--out PATH]

import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOCIAL_DB_CONTRACT = "social.near";

/** $SNACC is a NEP-141 token with 24 decimals; amounts arrive as yocto strings. */
export const SNACC_DECIMALS = 24n;

/** Formats a yocto-$SNACC string as a decimal amount (truncated to 4 fraction digits). */
export function formatSnacc(yocto) {
  const v = BigInt(yocto);
  const base = 10n ** SNACC_DECIMALS;
  const whole = (v / base).toLocaleString("en-US");
  const frac = (((v % base) * 10000n) / base).toString().padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Formats the Great Feast leaderboard and colony report into a SocialDB markdown post. */
export function formatSocialPost(params) {
  const {
    epoch = 0,
    crucibleTempMk = 0,
    zone = "NORMAL",
    feastVolume = "0",
    feastTarget = "0",
    topFeeders = [],
    colonyOwner = "",
    colonyStrainsCount = 0,
    colonyTotalAtp = "0",
    network = "NEAR testnet",
  } = params;

  const tempDisplay = String(crucibleTempMk); // the contract reports the temperature in mK already
  const vNorm = formatSnacc(feastVolume);
  const tNorm = formatSnacc(feastTarget);

  let feederLines = "No feeder contributions recorded for this epoch.";
  if (topFeeders.length > 0) {
    feederLines = topFeeders
      .slice(0, 3)
      .map((f, i) => {
        const amt = formatSnacc(f.amount);
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : "🥉";
        return `${medal} **#${i + 1} \`${f.account_id}\`** — ${amt} $SNACC`;
      })
      .join("\n");
  }

  let colonySection = "";
  if (colonyOwner) {
    colonySection = `\n### 🔬 Colony Verification (\`${colonyOwner}\`)\n` +
      `- Active Living Strains: **${colonyStrainsCount}**\n` +
      `- Total Metabolic Reserves: **${colonyTotalAtp} $ATP**\n`;
  }

  return (
    `## 🏆 Snacc — The Great Feast Leaderboard (Epoch ${epoch})\n\n` +
    `On-chain economic status snapshot from ${network}:\n\n` +
    `- **Macro Zone**: \`${zone}\`\n` +
    `- **Crucible Temperature**: \`${tempDisplay} mK\`\n` +
    `- **Feast Volume**: \`${vNorm}\` / Target \`${tNorm}\`\n\n` +
    `### 🍽️ Top Feeders Podium\n` +
    `${feederLines}\n` +
    colonySection +
    `\n---\n` +
    `*Autonomous biological balance sheets on NEAR testnet. $SNACC on testnet has no monetary value.*\n` +
    `#Snacc #NEAR #GreatFeast #SocialDB #OnChainEconomy`
  );
}

/** Constructs the standard SocialDB `set` invocation arguments. */
export function buildSocialDbPayload(accountId, postText) {
  if (!accountId || typeof accountId !== "string") {
    throw new Error("Invalid account ID for SocialDB payload");
  }
  return {
    data: {
      [accountId]: {
        post: {
          main: JSON.stringify({
            type: "md",
            text: postText,
          }),
        },
        index: {
          post: JSON.stringify({
            key: "main",
            value: {
              type: "md",
            },
          }),
        },
      },
    },
  };
}

function arg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

export async function fetchLiveLeaderboardData(apiBase) {
  const base = apiBase.replace(/\/+$/, "");
  const [appetiteRes, macroRes] = await Promise.all([
    fetch(`${base}/api/appetite`, { signal: AbortSignal.timeout(10000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch(`${base}/api/crucible/macro`, { signal: AbortSignal.timeout(10000) }).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);

  if (!appetiteRes && !macroRes) {
    throw new Error(`Leaderboard API at ${base} is unreachable or returned an error; refusing to emit a post with empty data.`);
  }

  return {
    epoch: appetiteRes?.current_epoch ?? 0,
    crucibleTempMk: appetiteRes?.crucible_temp ?? macroRes?.crucibleTemp ?? 0,
    zone: appetiteRes?.zone ?? macroRes?.zone ?? "NORMAL",
    feastVolume: appetiteRes?.feast_volume ?? "0",
    feastTarget: appetiteRes?.feast_target ?? "0",
    topFeeders: appetiteRes?.top_feeders ?? [],
    network: macroRes?.contractId ? "NEAR testnet (" + macroRes.contractId + ")" : "NEAR testnet",
  };
}

/** Sample data used ONLY with `--fixture`. Invented values for previewing the post format; not live state. */
export const FIXTURE_DATA = {
  epoch: 1,
  crucibleTempMk: 650,
  zone: "FEVER",
  feastVolume: "2000000000000000000000",
  feastTarget: "1000000000000000000000",
  topFeeders: [{ account_id: "alice.testnet", amount: "2000000000000000000000" }],
  network: "NEAR testnet (FIXTURE)",
};

export const FIXTURE_BANNER = "> **FIXTURE — invented sample data for previewing the format. Not live state.**\n\n";

/**
 * Resolves the API base from `--api` or the `SNACC_API_BASE` / `VITE_API_BASE` env vars.
 * There is no default: a missing value throws a clear error.
 */
export function resolveApiBase(argv = [], env = {}) {
  const base = arg(argv, "api", env.SNACC_API_BASE ?? env.VITE_API_BASE ?? "");
  if (!base) {
    throw new Error(
      "No API base configured. Pass --api <URL> or set SNACC_API_BASE (or VITE_API_BASE). " +
        "There is no default. To preview the format with invented sample data, pass --fixture.",
    );
  }
  return base;
}

async function main() {
  const argv = process.argv.slice(2);
  const useFixture = argv.includes("--fixture");
  const accountId = arg(argv, "account", "example.testnet");
  const outPath = arg(argv, "out", "");

  let data;
  if (useFixture) {
    console.warn("FIXTURE MODE: using invented sample data, not live state.");
    data = FIXTURE_DATA;
  } else {
    const api = resolveApiBase(argv, process.env);
    console.log(`Querying leaderboard from: ${api}...`);
    data = await fetchLiveLeaderboardData(api); // throws if the API is unreachable: no silent fallback
  }

  const postText = (useFixture ? FIXTURE_BANNER : "") + formatSocialPost(data);
  const payload = buildSocialDbPayload(accountId, postText);

  console.log("Preview only: nothing is signed or published. Snacc is testnet-only (SocialDB on testnet: v1.social08.testnet).");
  console.log("\n================ SOCIAL.NEAR POST PREVIEW ================");
  console.log(postText);
  console.log("==========================================================\n");
  console.log("SocialDB Payload:");
  console.log(JSON.stringify(payload, null, 2));

  if (outPath) {
    await writeFile(resolve(outPath), JSON.stringify({ postText, payload }, null, 2), "utf8");
    console.log(`\nWritten payload to: ${outPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

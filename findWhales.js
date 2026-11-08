const ethers = require("ethers");
const axios = require("axios");
const fs = require("fs");

const RPC_URL = process.env.RPC_URL;
const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
const SUBGRAPH_ID = "Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211";
const GRAPH_URL = `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${SUBGRAPH_ID}`;

const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

// ─── CONFIG ───────────────────────────────────────────────
const MAX_PAGES     = 100;   // 100 x 100 = 10,000 users
const PAGE_SIZE     = 100;
const HF_THRESHOLD  = 1.3;   // HF < 1.3 wale monitor
const MIN_DEBT_USD  = 200;   // Min $200 debt
const TOP_N_WHALES  = 200;   // Top 200 save karo
const BATCH_SIZE    = 10;    // 10 parallel RPC calls
const GRAPH_DELAY   = 250;   // ms between graph pages
const RPC_DELAY     = 150;   // ms between batches

// ─── HELPER: Sleep ────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── HELPER: Retry wrapper ────────────────────────────────
async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(delay * (i + 1));
    }
  }
}

// ─── STEP 1: Graph se users fetch ─────────────────────────
async function fetchAllUsers() {
  let allUsers = [];
  let lastId = "0x0000000000000000000000000000000000000000";

  console.log(`📡 Fetching up to ${MAX_PAGES * PAGE_SIZE} users from The Graph...\n`);

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const query = `{
        users(
          first: ${PAGE_SIZE},
          where: { borrowedReservesCount_gt: 0, id_gt: "${lastId}" },
          orderBy: id,
          orderDirection: asc
        ) { id borrowedReservesCount }
      }`;

      const res = await withRetry(() =>
        axios.post(GRAPH_URL, { query }, {
          headers: { "Content-Type": "application/json" },
          timeout: 20000
        })
      );

      const users = res?.data?.data?.users || [];
      if (users.length === 0) break;

      allUsers = allUsers.concat(users);
      lastId = users[users.length - 1].id;

      process.stdout.write(
        `\r📄 Page ${page + 1}/${MAX_PAGES} | Users: ${allUsers.length}`
      );

      await sleep(GRAPH_DELAY);

    } catch (err) {
      console.log(`\n⚠️  Page ${page + 1} failed: ${err.message} — continuing...`);
      await sleep(2000);
    }
  }

  console.log(`\n\n✅ Total users fetched: ${allUsers.length}\n`);
  return allUsers;
}

// ─── STEP 2: On-chain HF check ────────────────────────────
async function checkHealthFactors(users, pool) {
  const whales = [];
  let checked = 0;
  let errors = 0;

  console.log(`🔍 Checking HF on-chain for ${users.length} users...\n`);

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (user) => {
        const data = await withRetry(() => pool.getUserAccountData(user.id), 2, 500);
        const hf = parseFloat(ethers.utils.formatUnits(data.healthFactor, 18));
        const debtUsd = parseFloat(ethers.utils.formatUnits(data.totalDebtBase, 8));
        const collateralUsd = parseFloat(ethers.utils.formatUnits(data.totalCollateralBase, 8));
        return { id: user.id, hf, debtUsd, collateralUsd };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        const { id, hf, debtUsd, collateralUsd } = result.value;
        checked++;

        if (hf > 0 && hf < HF_THRESHOLD && debtUsd > MIN_DEBT_USD) {
          whales.push({
            address: id,
            healthFactor: parseFloat(hf.toFixed(6)),
            debtUsd: parseFloat(debtUsd.toFixed(2)),
            collateralUsd: parseFloat(collateralUsd.toFixed(2))
          });

          const icon =
            hf < 1.0  ? "🚨" :
            hf < 1.05 ? "🔴" :
            hf < 1.10 ? "🟠" :
            hf < 1.20 ? "🟡" : "🟢";

          console.log(
            `${icon} ${id} | HF: ${hf.toFixed(4)} | Debt: $${debtUsd.toFixed(0)} | Col: $${collateralUsd.toFixed(0)}`
          );
        }
      } else {
        errors++;
      }
    }

    process.stdout.write(
      `\r⏳ ${Math.min(i + BATCH_SIZE, users.length)}/${users.length} checked | Whales: ${whales.length} | Errors: ${errors}`
    );

    await sleep(RPC_DELAY);
  }

  console.log(`\n`);
  return { whales, checked, errors };
}

// ─── MAIN ─────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   FIND WHALES — ULTRA v3 (10K SCAN)     ║");
  console.log("╚══════════════════════════════════════════╝\n");

  if (!RPC_URL || !GRAPH_API_KEY) {
    console.error("❌ ENV vars missing: RPC_URL / GRAPH_API_KEY");
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);

  // Step 1: Fetch users
  const users = await fetchAllUsers();
  if (users.length === 0) {
    console.error("❌ No users fetched — aborting");
    process.exit(1);
  }

  // Step 2: Check HF
  const { whales, checked, errors } = await checkHealthFactors(users, pool);

  // Step 3: Sort by HF ascending (most dangerous first)
  whales.sort((a, b) => a.healthFactor - b.healthFactor);

  // Step 4: Take top N
  const topWhales = whales.slice(0, TOP_N_WHALES);

  // Step 5: Save
  fs.writeFileSync("whales.json", JSON.stringify(topWhales, null, 2));

  // ─── Summary ──────────────────────────────────────────
  console.log("╔══════════════════════════════════════════╗");
  console.log("║              SCAN COMPLETE               ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`✅ Users checked  : ${checked}`);
  console.log(`🐋 Whales found   : ${whales.length}`);
  console.log(`💾 Saved to JSON  : ${topWhales.length}`);
  console.log(`❌ RPC errors     : ${errors}\n`);

  const danger    = topWhales.filter(w => w.healthFactor < 1.0).length;
  const critical  = topWhales.filter(w => w.healthFactor >= 1.0 && w.healthFactor < 1.05).length;
  const high      = topWhales.filter(w => w.healthFactor >= 1.05 && w.healthFactor < 1.10).length;
  const medium    = topWhales.filter(w => w.healthFactor >= 1.10 && w.healthFactor < 1.20).length;
  const watch     = topWhales.filter(w => w.healthFactor >= 1.20).length;

  console.log(`🚨 Liquidatable NOW (HF<1.0)  : ${danger}`);
  console.log(`🔴 Critical  (1.0–1.05)        : ${critical}`);
  console.log(`🟠 High Risk (1.05–1.10)       : ${high}`);
  console.log(`🟡 Medium    (1.10–1.20)       : ${medium}`);
  console.log(`🟢 Watch     (1.20–1.30)       : ${watch}\n`);

  console.log("🏆 TOP 10 MOST DANGEROUS WHALES:");
  topWhales.slice(0, 10).forEach((w, i) => {
    const icon =
      w.healthFactor < 1.0  ? "🚨" :
      w.healthFactor < 1.05 ? "🔴" :
      w.healthFactor < 1.10 ? "🟠" : "🟡";
    console.log(
      `${i+1}. ${icon} ${w.address} | HF: ${w.healthFactor.toFixed(4)} | Debt: $${w.debtUsd.toFixed(0)}`
    );
  });
}

main().catch(console.error);

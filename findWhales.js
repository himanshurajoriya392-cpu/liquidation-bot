const ethers = require("ethers");
const axios  = require("axios");
const fs     = require("fs");

const RPC_URL       = process.env.RPC_URL;
const GRAPH_API_KEY = process.env.GRAPH_API_KEY;
const SUBGRAPH_ID   = "Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211";
const GRAPH_URL     = `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
const AAVE_POOL     = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const POOL_ABI      = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

const MAX_PAGES  = 80;
const PAGE_SIZE  = 100;
const HF_MAX     = 1.3;
const MIN_DEBT   = 200;
const TOP_N      = 200;
const BATCH_SIZE = 15;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) { if (i === retries - 1) throw e; await sleep(1000 * (i + 1)); }
  }
}

async function fetchUsers() {
  let all = [], lastId = "0x0000000000000000000000000000000000000000";
  console.log(`📡 Graph se users fetch ho rahe hain...\n`);

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const query = `{ users(first:${PAGE_SIZE}, where:{borrowedReservesCount_gt:0, id_gt:"${lastId}"}, orderBy:id, orderDirection:asc) { id } }`;
      const res = await withRetry(() =>
        axios.post(GRAPH_URL, { query }, {
          headers: { "Content-Type": "application/json" },
          timeout: 20000
        })
      );
      const users = res?.data?.data?.users || [];
      if (users.length === 0) break;
      all = all.concat(users);
      lastId = users[users.length - 1].id;
      process.stdout.write(`\r📄 Page ${page+1}/${MAX_PAGES} | Users: ${all.length}`);
      await sleep(250);
    } catch (e) {
      console.log(`\n⚠️  Page ${page+1} error: ${e.message}`);
      await sleep(2000);
    }
  }
  console.log(`\n✅ Total users fetched: ${all.length}\n`);
  return all;
}

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║     FIND WHALES — ULTRA (8K SCAN)       ║");
  console.log("╚══════════════════════════════════════════╝\n");

  if (!RPC_URL || !GRAPH_API_KEY) {
    console.error("❌ ENV missing: RPC_URL / GRAPH_API_KEY");
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const pool     = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);
  const users    = await fetchUsers();

  if (!users.length) {
    console.error("❌ No users fetched!");
    process.exit(1);
  }

  const whales = [];
  let checked = 0, errors = 0;
  console.log(`🔍 HF check ho raha hai ${users.length} users ka...\n`);

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(async (user) => {
        const data    = await withRetry(() => pool.getUserAccountData(user.id), 2);
        const hf      = parseFloat(ethers.utils.formatUnits(data.healthFactor, 18));
        const debtUsd = parseFloat(ethers.utils.formatUnits(data.totalDebtBase, 8));
        const colUsd  = parseFloat(ethers.utils.formatUnits(data.totalCollateralBase, 8));
        return { id: user.id, hf, debtUsd, colUsd };
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        checked++;
        const { id, hf, debtUsd, colUsd } = r.value;
        if (hf > 0 && hf < HF_MAX && debtUsd > MIN_DEBT) {
          whales.push({
            address: id,
            healthFactor: parseFloat(hf.toFixed(6)),
            debtUsd: parseFloat(debtUsd.toFixed(2)),
            collateralUsd: parseFloat(colUsd.toFixed(2))
          });
          const icon = hf < 1.0 ? "🚨" : hf < 1.05 ? "🔴" : hf < 1.10 ? "🟠" : hf < 1.20 ? "🟡" : "🟢";
          console.log(`${icon} ${id} | HF: ${hf.toFixed(4)} | Debt: $${debtUsd.toFixed(0)}`);
        }
      } else {
        errors++;
      }
    }

    process.stdout.write(
      `\r⏳ ${Math.min(i + BATCH_SIZE, users.length)}/${users.length} | Whales: ${whales.length} | Errors: ${errors}`
    );

    // ✅ Auto-save har 500 users pe — timeout se bachao
    if (whales.length > 0 && i % 500 === 0) {
      const temp = whales
        .slice()
        .sort((a, b) => a.healthFactor - b.healthFactor)
        .slice(0, TOP_N);
      fs.writeFileSync("whales.json", JSON.stringify(temp, null, 2));
      console.log(`\n💾 Auto-saved ${temp.length} whales...`);
    }

    await sleep(150);
  }

  // Final save
  whales.sort((a, b) => a.healthFactor - b.healthFactor);
  const top = whales.slice(0, TOP_N);
  fs.writeFileSync("whales.json", JSON.stringify(top, null, 2));

  console.log(`\n\n╔══════════════════════════════════════════╗`);
  console.log(`║            SCAN COMPLETE                 ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`✅ Checked : ${checked}`);
  console.log(`🐋 Whales  : ${whales.length}`);
  console.log(`💾 Saved   : ${top.length}`);
  console.log(`❌ Errors  : ${errors}`);

  console.log(`\n🏆 TOP 5 DANGEROUS:`);
  top.slice(0, 5).forEach((w, i) => {
    const icon = w.healthFactor < 1.0 ? "🚨" : w.healthFactor < 1.05 ? "🔴" : w.healthFactor < 1.10 ? "🟠" : "🟡";
    console.log(`${i+1}. ${icon} ${w.address} | HF: ${w.healthFactor.toFixed(4)} | Debt: $${w.debtUsd.toFixed(0)}`);
  });
}

main().catch(console.error);

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const POOL_ABI = ["function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"];
const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);
const GRAPH_KEY = process.env.GRAPH_API_KEY;
const SUBGRAPH_ID = "Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211";

async function getAddresses() {
  const all = new Set();
  const pages = [0, 1000, 2000, 3000, 4000];

  for (const skip of pages) {
    try {
      const url = `https://gateway.thegraph.com/api/${GRAPH_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
      const query = `{
        users(first: 1000, skip: ${skip}, where: { borrowedReservesCount_gt: 0 }) {
          id
        }
      }`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query })
      });
      const json = await res.json();
      const users = json.data?.users || [];
      users.forEach(u => all.add(u.id));
      console.log(`Page skip=${skip} → ${users.length} users | Total: ${all.size}`);
      await new Promise(r => setTimeout(r, 300));
    } catch(e) {
      console.log(`Page ${skip} failed: ${e.message}`);
    }
  }
  return [...all];
}

async function main() {
  console.log("=== WHALE FINDER v2 — 5000 addresses ===");
  const addresses = await getAddresses();
  console.log(`\nTotal addresses: ${addresses.length}`);
  console.log("On-chain verify ho raha hai...\n");

  const whales = [];
  for (let i = 0; i < addresses.length; i++) {
    try {
      const d = await pool.getUserAccountData(addresses[i]);
      const debt = parseFloat(ethers.utils.formatUnits(d.totalDebtBase, 8));
      const hf = parseFloat(ethers.utils.formatUnits(d.healthFactor, 18));
      const coll = parseFloat(ethers.utils.formatUnits(d.totalCollateralBase, 8));

      if (debt > 5000) {
        whales.push({
          address: addresses[i],
          debtUsd: debt,
          collateralUsd: coll,
          healthFactor: hf
        });
        if (hf < 1.1) {
          console.log(`🚨 NEAR LIQUIDATION: ${addresses[i]} | HF: ${hf.toFixed(4)} | Debt: $${debt.toFixed(0)}`);
        } else {
          console.log(`✅ ${addresses[i]} | HF: ${hf.toFixed(3)} | Debt: $${debt.toFixed(0)}`);
        }
      }
    } catch(e) {}

    if (i % 100 === 0) console.log(`Progress: ${i}/${addresses.length} | Whales: ${whales.length}`);
    await new Promise(r => setTimeout(r, 80));
  }

  // Sort by HF (lowest first = most at risk)
  whales.sort((a, b) => a.healthFactor - b.healthFactor);
  fs.writeFileSync("whales.json", JSON.stringify(whales, null, 2));
  console.log(`\n✅ DONE! ${whales.length} whales saved!`);
  console.log(`Top 3 at risk:`);
  whales.slice(0, 3).forEach(w => {
    console.log(`  ${w.address} | HF: ${w.healthFactor.toFixed(4)} | Debt: $${w.debtUsd.toFixed(0)}`);
  });
}

main().catch(console.error);

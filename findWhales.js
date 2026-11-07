require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const POOL_ABI = ["function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"];
const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);

const GRAPH_KEY = process.env.GRAPH_API_KEY;
const SUBGRAPH_ID = "Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211";

async function fetchFromGraph(skip) {
    const url = `https://gateway.thegraph.com/api/${GRAPH_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
    const query = `{ users(first: 1000, skip: ${skip}, where: { borrowedReservesCount_gt: 0 }) { id } }`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
    const json = await res.json();
    return json.data.users.map(u => u.id);
}

async function main() {
    console.log("=== STARTING MASS DISCOVERY (5000 CANDIDATES) ===");
    let allAddrs = [];
    for(let i=0; i<5; i++) {
        const p = await fetchFromGraph(i * 1000);
        allAddrs = allAddrs.concat(p);
        console.log(`Fetched ${allAddrs.length} addresses...`);
    }

    const whales = [];
    const batchSize = 20; // 20 whales check at once

    for(let i=0; i < allAddrs.length; i += batchSize) {
        const batch = allAddrs.slice(i, i + batchSize);
        await Promise.all(batch.map(async (addr) => {
            try {
                const d = await pool.getUserAccountData(addr);
                const hf = parseFloat(ethers.utils.formatUnits(d.healthFactor, 18));
                const debt = parseFloat(ethers.utils.formatUnits(d.totalDebtBase, 8));
                // Debt > $1000 and HF < 1.25 (Only High Risk)
                if (debt > 1000 && hf < 1.25) {
                    whales.push({ address: addr, debt, hf });
                }
            } catch(e) {}
        }));
        if(i % 500 === 0) console.log(`Verified ${i}/${allAddrs.length}...`);
    }

    whales.sort((a,b) => a.hf - b.hf);
    fs.writeFileSync("whales.json", JSON.stringify(whales, null, 2));
    console.log(`\n✅ TARGETS LOCKED: ${whales.length} High-Risk Whales in whales.json`);
}
main();

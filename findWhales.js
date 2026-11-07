require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);

const POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const POOL_ABI = ["function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"];
const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);

const GRAPH_KEY = process.env.GRAPH_API_KEY;
const SUBGRAPH_ID = "Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211";

async function getWhalesFromGraph() {
    const url = `https://gateway.thegraph.com/api/${GRAPH_KEY}/subgraphs/id/${SUBGRAPH_ID}`;
    const query = `{
        users(first: 1000, where: { borrowedReservesCount_gt: 0 }) {
            id
            borrowedReservesCount
        }
    }`;

    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query })
    });

    const json = await res.json();
    if (json.errors) throw new Error(JSON.stringify(json.errors));
    return json.data.users.map(u => u.id);
}

async function main() {
    console.log("=== WHALE FINDER STARTING ===");
    
    let addresses = [];
    
    try {
        console.log("Graph se addresses fetch ho rahe hain...");
        addresses = await getWhalesFromGraph();
        console.log(`Graph se mila: ${addresses.length} addresses`);
    } catch(e) {
        console.log("Graph failed:", e.message);
        process.exit(1);
    }

    const whales = [];
    console.log("\nOn-chain verify ho raha hai...");

    for(let i = 0; i < addresses.length; i++) {
        try {
            const data = await pool.getUserAccountData(addresses[i]);
            const debt = parseFloat(ethers.utils.formatUnits(data.totalDebtBase, 8));
            const hf = parseFloat(ethers.utils.formatUnits(data.healthFactor, 18));
            const coll = parseFloat(ethers.utils.formatUnits(data.totalCollateralBase, 8));

            if(debt > 10000) {
                whales.push({ address: addresses[i], debtUsd: debt, collateralUsd: coll, healthFactor: hf });
                console.log(`✅ WHALE: ${addresses[i]} | Debt: $${debt.toFixed(0)} | HF: ${hf.toFixed(3)}`);
            }

            if(i % 50 === 0) console.log(`Progress: ${i}/${addresses.length}`);
        } catch(e) {}

        await new Promise(r => setTimeout(r, 100));
    }

    whales.sort((a,b) => a.healthFactor - b.healthFactor);
    fs.writeFileSync("whales.json", JSON.stringify(whales, null, 2));
    console.log(`\n✅ DONE! ${whales.length} whales saved to whales.json`);
}

main().catch(console.error);

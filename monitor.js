require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const POOL_ABI = ["function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"];
const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);

async function main() {
    console.log("=== MONITOR ACTIVE — Watching for HF < 1.0 ===");
    
    const whalesRaw = JSON.parse(fs.readFileSync("whales.json"));
    const addrs = whalesRaw.map(w => w.address);
    console.log(`Monitoring ${addrs.length} whales...\n`);

    while(true) {
        for(const addr of addrs) {
            try {
                const d = await pool.getUserAccountData(addr);
                const hf = parseFloat(ethers.utils.formatUnits(d.healthFactor, 18));
                const debt = parseFloat(ethers.utils.formatUnits(d.totalDebtBase, 8));

                if(hf < 1.0 && debt > 1000) {
                    const msg = `\n🚨🚨 LIQUIDATABLE! 🚨🚨
Address: ${addr}
Health Factor: ${hf.toFixed(4)}
Debt: $${debt.toFixed(0)}
Collateral: $${parseFloat(ethers.utils.formatUnits(d.totalCollateralBase, 8)).toFixed(0)}
Time: ${new Date().toISOString()}\n`;
                    
                    console.log(msg);
                    fs.appendFileSync("ALERTS.txt", msg);
                } else if(hf < 1.1) {
                    console.log(`⚠️  NEAR: ${addr} | HF: ${hf.toFixed(4)} | Debt: $${debt.toFixed(0)}`);
                }
            } catch(e) {}
            
            await new Promise(r => setTimeout(r, 200));
        }
        
        console.log(`[${new Date().toLocaleTimeString()}] Scan complete. Next scan in 30s...`);
        await new Promise(r => setTimeout(r, 30000));
    }
}

main().catch(console.error);

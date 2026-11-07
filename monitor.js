require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const POOL_ABI = ["function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"];
const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);

async function main() {
  console.log("=== MONITOR v2 ACTIVE ===");
  
  const whales = JSON.parse(fs.readFileSync("whales.json"));
  console.log(`Monitoring ${whales.length} whales | Scan every 15s\n`);

  while(true) {
    for (const whale of whales) {
      try {
        const d = await pool.getUserAccountData(whale.address);
        const hf = parseFloat(ethers.utils.formatUnits(d.healthFactor, 18));
        const debt = parseFloat(ethers.utils.formatUnits(d.totalDebtBase, 8));

        if (hf < 1.0 && debt > 1000) {
          const alert = `🚨 LIQUIDATABLE | ${whale.address} | HF: ${hf.toFixed(4)} | Debt: $${debt.toFixed(0)} | ${new Date().toISOString()}`;
          console.log(alert);
          fs.appendFileSync("ALERTS.txt", alert + "\n");
        } else if (hf < 1.05) {
          console.log(`⚠️  NEAR: ${whale.address} | HF: ${hf.toFixed(4)} | $${debt.toFixed(0)}`);
        }
      } catch(e) {}

      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`[${new Date().toLocaleTimeString()}] Scan done. Next in 15s...`);
    await new Promise(r => setTimeout(r, 15000));
  }
}

main().catch(console.error);

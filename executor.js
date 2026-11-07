require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const FLASH_LIQUIDATOR = "0xD70eF29B779bA5D6Bab6e5d5B9867b75A3c5b84F";
const POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";

const liquidator = new ethers.Contract(FLASH_LIQUIDATOR, ["function liquidate(address collateral, address debt, address user, uint256 amount) external"], wallet);
const pool = new ethers.Contract(POOL_ADDR, ["function getUserAccountData(address user) view returns (uint256, uint256, uint256, uint256, uint256, uint256)"], provider);

async function main() {
    const whales = JSON.parse(fs.readFileSync("whales.json"));
    console.log(`Monitoring ${whales.length} High-Risk targets...`);

    for (let whale of whales) {
        try {
            const [, debtBase, , , , hfBase] = await pool.getUserAccountData(whale.address);
            const hf = parseFloat(ethers.utils.formatUnits(hfBase, 18));
            
            if (hf < 1.0) {
                console.log(`🚨 STRIKING: ${whale.address} | HF: ${hf}`);
                // Simplified call - actual assets will be fetched inside contract or pre-scripted
                // Here we trigger the liquidation
                // Note: For speed, we assume the debt/collateral are known or fetched
                // I will add the asset-fetcher in the final executor version
                console.log("Triggering Flash Loan Liquidation...");
            }
        } catch(e) {}
    }
    console.log("Scan Complete.");
}
main();

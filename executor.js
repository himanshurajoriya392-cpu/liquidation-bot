require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const FLASH_LIQUIDATOR = "0x010DD267EebAd6CE3844b10fFDd2C893a5B016F8";
const POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const DATA_PROVIDER = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";
const AAVE_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";

const LIQUIDATOR_ABI = ["function liquidate(address collateral, address debt, address user, uint256 amount) external"];
const POOL_ABI = ["function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"];
const DATA_ABI = ["function getUserReservesData(address provider, address user) view returns (tuple(address underlyingAsset, uint256 scaledATokenBalance, bool usageAsCollateralEnabledOnUser, uint256 stableBorrowRate, uint256 scaledVariableDebt, uint256 principalStableDebt, uint256 creditDelegationAllowance)[], uint8)"];

const liquidator = new ethers.Contract(FLASH_LIQUIDATOR, LIQUIDATOR_ABI, wallet);
const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);
const dataProvider = new ethers.Contract(DATA_PROVIDER, DATA_ABI, provider);

async function getAssets(user) {
    try {
        const [reserves] = await dataProvider.getUserReservesData(AAVE_PROVIDER, user);
        let bestDebt = null, bestColl = null;
        let maxDebt = ethers.BigNumber.from(0);
        let maxColl = ethers.BigNumber.from(0);
        for (const r of reserves) {
            if (r.scaledVariableDebt.gt(maxDebt)) { maxDebt = r.scaledVariableDebt; bestDebt = r.underlyingAsset; }
            if (r.usageAsCollateralEnabledOnUser && r.scaledATokenBalance.gt(maxColl)) { maxColl = r.scaledATokenBalance; bestColl = r.underlyingAsset; }
        }
        return { bestDebt, bestColl };
    } catch(e) { return { bestDebt: null, bestColl: null }; }
}

async function execute(addr, hf, debt) {
    console.log(`\n🚨 LIQUIDATING: ${addr} | HF: ${hf} | Debt: $${debt}`);
    const { bestDebt, bestColl } = await getAssets(addr);
    if (!bestDebt || !bestColl) { console.log("❌ Assets not found"); return; }
    try {
        const tx = await liquidator.liquidate(bestColl, bestDebt, addr, ethers.constants.MaxUint256, { gasLimit: 900000, gasPrice: ethers.utils.parseUnits("300", "gwei") });
        console.log(`⏳ TX: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`✅ SUCCESS! Block: ${receipt.blockNumber}`);
        fs.appendFileSync("PROFITS.txt", `${new Date().toISOString()} | ${addr} | TX: ${tx.hash}\n`);
    } catch(e) { console.log(`❌ Failed: ${e.message.slice(0, 100)}`); }
}

async function main() {
    console.log("=== EXECUTOR v4 — SINGLE SCAN ===");
    const whales = JSON.parse(fs.readFileSync("whales.json"));
    const list = Array.isArray(whales) ? whales : whales.whales || [];
    console.log(`Scanning ${list.length} whales...\n`);

    for (const whale of list) {
        try {
            const addr = whale.address || whale;
            const d = await pool.getUserAccountData(addr);
            const hf = parseFloat(ethers.utils.formatUnits(d.healthFactor, 18));
            const debt = parseFloat(ethers.utils.formatUnits(d.totalDebtBase, 8));

            if (hf < 1.0 && debt > 1000) {
                await execute(addr, hf, debt);
            } else if (hf < 1.05) {
                console.log(`⚠️ NEAR: ${addr} | HF: ${hf.toFixed(4)} | $${debt.toFixed(0)}`);
            }
        } catch(e) {}
        await new Promise(r => setTimeout(r, 200));
    }
    console.log("\n✅ Scan Complete.");
}

main().catch(console.error);

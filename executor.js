require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Contract Addresses
const FLASH_LIQUIDATOR = "0xD70eF29B779bA5D6Bab6e5d5B9867b75A3c5b84F";
const POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const DATA_PROVIDER = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";

// ABIs
const LIQUIDATOR_ABI = [
  "function liquidate(address collateral, address debt, address user, uint256 amount) external"
];

const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

const DATA_PROVIDER_ABI = [
  "function getUserReservesData(address provider, address user) view returns (tuple(address underlyingAsset, uint256 scaledATokenBalance, bool usageAsCollateralEnabledOnUser, uint256 stableBorrowRate, uint256 scaledVariableDebt, uint256 principalStableDebt, uint256 creditDelegationAllowance)[], uint8)"
];

const AAVE_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";

const liquidator = new ethers.Contract(FLASH_LIQUIDATOR, LIQUIDATOR_ABI, wallet);
const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);
const dataProvider = new ethers.Contract(DATA_PROVIDER, DATA_PROVIDER_ABI, provider);

function loadWhales() {
  const raw = JSON.parse(fs.readFileSync("whales.json"));
  return raw.map(w => w.address);
}

async function getUserAssets(userAddr) {
  try {
    const [reserves] = await dataProvider.getUserReservesData(AAVE_PROVIDER, userAddr);
    
    let bestDebt = null;
    let bestCollateral = null;
    let maxDebt = ethers.BigNumber.from(0);
    let maxColl = ethers.BigNumber.from(0);

    for (const r of reserves) {
      // Find biggest debt
      if (r.scaledVariableDebt.gt(maxDebt)) {
        maxDebt = r.scaledVariableDebt;
        bestDebt = r.underlyingAsset;
      }
      // Find biggest collateral
      if (r.usageAsCollateralEnabledOnUser && r.scaledATokenBalance.gt(maxColl)) {
        maxColl = r.scaledATokenBalance;
        bestCollateral = r.underlyingAsset;
      }
    }

    return { bestDebt, bestCollateral };
  } catch(e) {
    return { bestDebt: null, bestCollateral: null };
  }
}

async function tryLiquidate(addr, hf, debtUsd) {
  console.log(`\n🚨 LIQUIDATING: ${addr}`);
  console.log(`   HF: ${hf.toFixed(4)} | Debt: $${debtUsd.toFixed(0)}`);

  const { bestDebt, bestCollateral } = await getUserAssets(addr);

  if (!bestDebt || !bestCollateral) {
    console.log("   ❌ Could not get assets — skipping");
    return;
  }

  console.log(`   Debt Asset: ${bestDebt}`);
  console.log(`   Collateral: ${bestCollateral}`);

  try {
    // Max liquidation = 50% of debt
    const amount = ethers.constants.MaxUint256;

    const tx = await liquidator.liquidate(
      bestCollateral,
      bestDebt,
      addr,
      amount,
      { gasLimit: 800000 }
    );

    console.log(`   ⏳ TX Sent: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ SUCCESS! Block: ${receipt.blockNumber}`);
    fs.appendFileSync("PROFITS.txt", `${new Date().toISOString()} | ${addr} | TX: ${tx.hash}\n`);
  } catch(e) {
    console.log(`   ❌ Failed: ${e.message.slice(0, 100)}`);
  }
}

async function main() {
  console.log("=== EXECUTOR ACTIVE ===");
  console.log(`Liquidator Contract: ${FLASH_LIQUIDATOR}`);
  console.log(`Wallet: ${wallet.address}`);

  const whales = loadWhales();
  console.log(`Monitoring ${whales.length} whales...\n`);

  while(true) {
    for(const addr of whales) {
      try {
        const d = await pool.getUserAccountData(addr);
        const hf = parseFloat(ethers.utils.formatUnits(d.healthFactor, 18));
        const debt = parseFloat(ethers.utils.formatUnits(d.totalDebtBase, 8));

        if(hf < 1.0 && debt > 1000) {
          await tryLiquidate(addr, hf, debt);
        } else if(hf < 1.05) {
          console.log(`⚠️  NEAR: ${addr} | HF: ${hf.toFixed(4)} | $${debt.toFixed(0)}`);
        }
      } catch(e) {}

      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[${new Date().toLocaleTimeString()}] Scan done. Next in 30s...`);
    await new Promise(r => setTimeout(r, 30000));
  }
}

main().catch(console.error);

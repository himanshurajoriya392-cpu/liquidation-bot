require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const FLASH_LIQUIDATOR = "0xD70eF29B779bA5D6Bab6e5d5B9867b75A3c5b84F";
const POOL_ADDR = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const DATA_PROVIDER = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";
const AAVE_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";

const LIQUIDATOR_ABI = [
  "function liquidate(address collateral, address debt, address user, uint256 amount) external"
];
const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];
const DATA_ABI = [
  "function getUserReservesData(address provider, address user) view returns (tuple(address underlyingAsset, uint256 scaledATokenBalance, bool usageAsCollateralEnabledOnUser, uint256 stableBorrowRate, uint256 scaledVariableDebt, uint256 principalStableDebt, uint256 creditDelegationAllowance)[], uint8)"
];

const liquidator = new ethers.Contract(FLASH_LIQUIDATOR, LIQUIDATOR_ABI, wallet);
const pool = new ethers.Contract(POOL_ADDR, POOL_ABI, provider);
const dataProvider = new ethers.Contract(DATA_PROVIDER, DATA_ABI, provider);

const executed = new Set();

function loadWhales() {
  const raw = JSON.parse(fs.readFileSync("whales.json"));
  return raw;
}

async function getAssets(user) {
  try {
    const [reserves] = await dataProvider.getUserReservesData(AAVE_PROVIDER, user);
    let bestDebt = null, bestColl = null;
    let maxDebt = ethers.BigNumber.from(0);
    let maxColl = ethers.BigNumber.from(0);

    for (const r of reserves) {
      if (r.scaledVariableDebt.gt(maxDebt)) {
        maxDebt = r.scaledVariableDebt;
        bestDebt = r.underlyingAsset;
      }
      if (r.usageAsCollateralEnabledOnUser && r.scaledATokenBalance.gt(maxColl)) {
        maxColl = r.scaledATokenBalance;
        bestColl = r.underlyingAsset;
      }
    }
    return { bestDebt, bestColl };
  } catch(e) {
    return { bestDebt: null, bestColl: null };
  }
}

async function execute(addr, hf, debt) {
  if (executed.has(addr)) return;
  executed.add(addr);

  console.log(`\n🚨🚨 LIQUIDATING: ${addr}`);
  console.log(`   HF: ${hf.toFixed(6)} | Debt: $${debt.toFixed(0)}`);

  const { bestDebt, bestColl } = await getAssets(addr);
  if (!bestDebt || !bestColl) {
    console.log("   ❌ Assets not found");
    executed.delete(addr);
    return;
  }

  try {
    const tx = await liquidator.liquidate(
      bestColl,
      bestDebt,
      addr,
      ethers.constants.MaxUint256,
      { gasLimit: 900000, gasPrice: ethers.utils.parseUnits("100", "gwei") }
    );
    console.log(`   ⏳ TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ SUCCESS! Block: ${receipt.blockNumber}`);

    const log = `${new Date().toISOString()} | ${addr} | HF:${hf} | Debt:$${debt} | TX:${tx.hash}\n`;
    fs.appendFileSync("PROFITS.txt", log);
    console.log(`   💰 PROFIT LOGGED!`);
  } catch(e) {
    console.log(`   ❌ Error: ${e.message.slice(0, 150)}`);
    executed.delete(addr);
  }
}

async function main() {
  console.log("=== EXECUTOR v2 ACTIVE ===");
  console.log(`Contract: ${FLASH_LIQUIDATOR}`);
  console.log(`Wallet: ${wallet.address}`);

  const whales = loadWhales();
  console.log(`Monitoring ${whales.length} whales | Scan every 15s\n`);

  while(true) {
    for (const whale of whales) {
      try {
        const d = await pool.getUserAccountData(whale.address);
        const hf = parseFloat(ethers.utils.formatUnits(d.healthFactor, 18));
        const debt = parseFloat(ethers.utils.formatUnits(d.totalDebtBase, 8));

        if (hf < 1.0 && debt > 1000) {
          await execute(whale.address, hf, debt);
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

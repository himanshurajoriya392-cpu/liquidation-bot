const ethers = require("ethers");
const fs = require("fs");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

const FLASH_LIQUIDATOR = "0x010DD267EebAd6CE3844b10fFDd2C893a5B016F8";
const AAVE_DATA_PROVIDER = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";

const DATA_PROVIDER_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

const LIQUIDATOR_ABI = [
  "function liquidate(address collateralAsset, address debtAsset, address user, uint256 debtAmount, bool receiveAToken) external"
];

// Token addresses on Polygon
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI:  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  AAVE: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B"
};

async function getTopDebtAsset(provider, userAddress) {
  const dataProvider = new ethers.Contract(AAVE_DATA_PROVIDER, [
    "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)"
  ], provider);

  let maxDebt = ethers.BigNumber.from(0);
  let debtToken = null;

  for (const [name, addr] of Object.entries(TOKENS)) {
    try {
      const data = await dataProvider.getUserReserveData(addr, userAddress);
      const totalDebt = data.currentStableDebt.add(data.currentVariableDebt);
      if (totalDebt.gt(maxDebt)) {
        maxDebt = totalDebt;
        debtToken = { name, addr };
      }
    } catch (e) {}
  }
  return { debtToken, maxDebt };
}

async function getTopCollateral(provider, userAddress) {
  const dataProvider = new ethers.Contract(AAVE_DATA_PROVIDER, [
    "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)"
  ], provider);

  let maxCollateral = ethers.BigNumber.from(0);
  let collateralToken = null;

  for (const [name, addr] of Object.entries(TOKENS)) {
    try {
      const data = await dataProvider.getUserReserveData(addr, userAddress);
      if (data.usageAsCollateralEnabled && data.currentATokenBalance.gt(maxCollateral)) {
        maxCollateral = data.currentATokenBalance;
        collateralToken = { name, addr };
      }
    } catch (e) {}
  }
  return { collateralToken, maxCollateral };
}

async function main() {
  console.log("=== EXECUTOR v5 — REAL-TIME HF SCAN ===\n");

  if (!RPC_URL || !PRIVATE_KEY || !WALLET_ADDRESS) {
    console.error("❌ ENV vars missing! RPC_URL / PRIVATE_KEY / WALLET_ADDRESS check karo.");
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // Load whales
  let whales = [];
  try {
    whales = JSON.parse(fs.readFileSync("whales.json", "utf8"));
    console.log(`📋 Loaded ${whales.length} whales from whales.json\n`);
  } catch (e) {
    console.error("❌ whales.json not found!");
    process.exit(1);
  }

  const pool = new ethers.Contract(
    AAVE_DATA_PROVIDER,
    DATA_PROVIDER_ABI,
    provider
  );

  const liquidator = new ethers.Contract(
    FLASH_LIQUIDATOR,
    LIQUIDATOR_ABI,
    wallet
  );

  let liquidationFired = false;

  for (const whale of whales) {
    try {
      const data = await pool.getUserAccountData(whale.address);
      const hf = parseFloat(ethers.utils.formatUnits(data.healthFactor, 18));
      const debtUsd = parseFloat(ethers.utils.formatUnits(data.totalDebtBase, 8));
      const collateralUsd = parseFloat(ethers.utils.formatUnits(data.totalCollateralBase, 8));

      console.log(`👤 ${whale.address}`);
      console.log(`   HF: ${hf.toFixed(4)} | Debt: $${debtUsd.toFixed(0)} | Collateral: $${collateralUsd.toFixed(0)}`);

      if (hf < 1.0 && debtUsd > 100) {
        console.log(`   🚨 LIQUIDATABLE! Initiating flash loan liquidation...`);

        // Find debt and collateral tokens
        const { debtToken, maxDebt } = await getTopDebtAsset(provider, whale.address);
        const { collateralToken } = await getTopCollateral(provider, whale.address);

        if (!debtToken || !collateralToken) {
          console.log(`   ⚠️  Could not identify debt/collateral token. Skipping.`);
          continue;
        }

        // Liquidate 50% of debt (Aave rule)
        const debtAmount = maxDebt.div(2);

        console.log(`   💰 Debt Token: ${debtToken.name} | Collateral Token: ${collateralToken.name}`);
        console.log(`   💸 Liquidating ${ethers.utils.formatUnits(debtAmount, 6)} ${debtToken.name}...`);

        try {
          const tx = await liquidator.liquidate(
            collateralToken.addr,
            debtToken.addr,
            whale.address,
            debtAmount,
            false,
            { gasLimit: 1500000, gasPrice: ethers.utils.parseUnits("150", "gwei") }
          );
          console.log(`   ✅ TX Sent! Hash: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`   🎉 CONFIRMED! Gas used: ${receipt.gasUsed.toString()}`);
          liquidationFired = true;
        } catch (txErr) {
          console.log(`   ❌ TX Failed: ${txErr.message}`);
        }
      } else if (hf < 1.05) {
        console.log(`   ⚠️  DANGER ZONE — Watch closely!`);
      } else {
        console.log(`   ✅ Safe`);
      }
      console.log("");

    } catch (err) {
      console.log(`❌ Error for ${whale.address}: ${err.message}\n`);
    }
  }

  console.log("=== SCAN COMPLETE ===");
  if (!liquidationFired) {
    console.log("💤 No liquidatable positions found this run. Bot will check again in 15 min.");
  }
}

main().catch(console.error);

const ethers = require("ethers");
const fs = require("fs");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

const AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const AAVE_DATA_PROVIDER = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";
const FLASH_LIQUIDATOR = "0x010DD267EebAd6CE3844b10fFDd2C893a5B016F8";

const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

const DATA_PROVIDER_ABI = [
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)"
];

const LIQUIDATOR_ABI = [
  "function liquidate(address collateralAsset, address debtAsset, address user, uint256 debtAmount, bool receiveAToken) external"
];

const TOKENS = {
  USDC:   { addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6  },
  USDT:   { addr: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6  },
  DAI:    { addr: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
  WMATIC: { addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
  WETH:   { addr: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC:   { addr: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8  },
  AAVE:   { addr: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18 }
};

async function getTopDebtToken(dataProvider, userAddress) {
  let maxDebt = ethers.BigNumber.from(0);
  let debtToken = null;
  let debtDecimals = 6;

  for (const [name, token] of Object.entries(TOKENS)) {
    try {
      const data = await dataProvider.getUserReserveData(token.addr, userAddress);
      const totalDebt = data.currentStableDebt.add(data.currentVariableDebt);
      if (totalDebt.gt(maxDebt)) {
        maxDebt = totalDebt;
        debtToken = { name, addr: token.addr };
        debtDecimals = token.decimals;
      }
    } catch (e) {}
  }
  return { debtToken, maxDebt, debtDecimals };
}

async function getTopCollateralToken(dataProvider, userAddress) {
  let maxCollateral = ethers.BigNumber.from(0);
  let collateralToken = null;

  for (const [name, token] of Object.entries(TOKENS)) {
    try {
      const data = await dataProvider.getUserReserveData(token.addr, userAddress);
      if (data.usageAsCollateralEnabled && data.currentATokenBalance.gt(maxCollateral)) {
        maxCollateral = data.currentATokenBalance;
        collateralToken = { name, addr: token.addr };
      }
    } catch (e) {}
  }
  return { collateralToken, maxCollateral };
}

async function main() {
  console.log("=== EXECUTOR v6 — REAL-TIME HF SCAN ===\n");

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

  // Contracts
  const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);
  const dataProvider = new ethers.Contract(AAVE_DATA_PROVIDER, DATA_PROVIDER_ABI, provider);
  const liquidator = new ethers.Contract(FLASH_LIQUIDATOR, LIQUIDATOR_ABI, wallet);

  let liquidationFired = false;

  for (const whale of whales) {
    try {
      const data = await pool.getUserAccountData(whale.address);
      const hf = parseFloat(ethers.utils.formatUnits(data.healthFactor, 18));
      const debtUsd = parseFloat(ethers.utils.formatUnits(data.totalDebtBase, 8));
      const collateralUsd = parseFloat(ethers.utils.formatUnits(data.totalCollateralBase, 8));

      console.log(`👤 ${whale.address}`);
      console.log(`   HF: ${hf.toFixed(4)} | Debt: $${debtUsd.toFixed(0)} | Collateral: $${collateralUsd.toFixed(0)}`);

      // ✅ LIQUIDATION ZONE
      if (hf < 1.0 && debtUsd > 100) {
        console.log(`   🚨 LIQUIDATABLE! Flash loan liquidation shuru...`);

        const { debtToken, maxDebt, debtDecimals } = await getTopDebtToken(dataProvider, whale.address);
        const { collateralToken } = await getTopCollateralToken(dataProvider, whale.address);

        if (!debtToken || !collateralToken) {
          console.log(`   ⚠️  Debt/Collateral token identify nahi hua. Skip.`);
          continue;
        }

        // Aave max 50% debt liquidation rule
        const debtAmount = maxDebt.div(2);

        console.log(`   💰 Debt: ${debtToken.name} | Collateral: ${collateralToken.name}`);
        console.log(`   💸 Liquidating: ${ethers.utils.formatUnits(debtAmount, debtDecimals)} ${debtToken.name}`);

        try {
          const tx = await liquidator.liquidate(
            collateralToken.addr,
            debtToken.addr,
            whale.address,
            debtAmount,
            false,
            {
              gasLimit: 1500000,
              gasPrice: ethers.utils.parseUnits("150", "gwei")
            }
          );
          console.log(`   ✅ TX Sent! Hash: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`   🎉 CONFIRMED! Block: ${receipt.blockNumber} | Gas used: ${receipt.gasUsed.toString()}`);
          liquidationFired = true;

        } catch (txErr) {
          console.log(`   ❌ TX Failed: ${txErr.message}`);
        }

      // ⚠️ DANGER ZONE
      } else if (hf >= 1.0 && hf < 1.05) {
        console.log(`   ⚠️  DANGER ZONE — Bahut karib hai liquidation se!`);

      // 👀 WATCH ZONE  
      } else if (hf >= 1.05 && hf < 1.10) {
        console.log(`   👀 WATCH ZONE — Nazar rakho.`);

      // ✅ SAFE
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
    console.log("💤 No liquidatable positions found. Next check in 15 min.");
  } else {
    console.log("🎉 Liquidation executed! Profit wallet mein aa gaya hoga.");
  }
}

main().catch(console.error);

const ethers = require("ethers");
const fs = require("fs");

// ─── ENV ──────────────────────────────────────────────────
const RPC_URL       = process.env.RPC_URL;
const PRIVATE_KEY   = process.env.PRIVATE_KEY;
const WALLET_ADDRESS= process.env.WALLET_ADDRESS;

// ─── CONTRACTS ────────────────────────────────────────────
const AAVE_POOL          = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const AAVE_DATA_PROVIDER = "0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654";
const FLASH_LIQUIDATOR   = "0x010DD267EebAd6CE3844b10fFDd2C893a5B016F8";

// ─── ABIs ─────────────────────────────────────────────────
const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

const DATA_PROVIDER_ABI = [
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)"
];

const LIQUIDATOR_ABI = [
  "function liquidate(address collateralAsset, address debtAsset, address user, uint256 debtAmount, bool receiveAToken) external"
];

// ─── TOKENS ───────────────────────────────────────────────
const TOKENS = {
  USDC:   { addr: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6,  liqBonus: 1.045 },
  USDT:   { addr: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6,  liqBonus: 1.045 },
  DAI:    { addr: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, liqBonus: 1.045 },
  WMATIC: { addr: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, liqBonus: 1.05  },
  WETH:   { addr: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, liqBonus: 1.05  },
  WBTC:   { addr: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8,  liqBonus: 1.05  },
  AAVE:   { addr: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, liqBonus: 1.075 }
};

// ─── CONFIG ───────────────────────────────────────────────
const GAS_LIMIT       = 1500000;
const GAS_PRICE_GWEI  = 150;
const MATIC_USD_PRICE = 0.85;    // Approximate — update if needed
const MIN_PROFIT_USD  = 10;      // Minimum $10 profit — warna skip
const FLASH_LOAN_FEE  = 0.0009;  // 0.09% Aave flash loan fee

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Get top debt token ───────────────────────────────────
async function getTopDebtToken(dataProvider, userAddr) {
  let maxDebt = ethers.BigNumber.from(0);
  let result = null;

  for (const [name, token] of Object.entries(TOKENS)) {
    try {
      const d = await dataProvider.getUserReserveData(token.addr, userAddr);
      const totalDebt = d.currentStableDebt.add(d.currentVariableDebt);
      if (totalDebt.gt(maxDebt)) {
        maxDebt = totalDebt;
        result = { name, addr: token.addr, decimals: token.decimals, amount: totalDebt };
      }
    } catch (_) {}
  }
  return result;
}

// ─── Get top collateral token ─────────────────────────────
async function getTopCollateralToken(dataProvider, userAddr) {
  let maxCol = ethers.BigNumber.from(0);
  let result = null;

  for (const [name, token] of Object.entries(TOKENS)) {
    try {
      const d = await dataProvider.getUserReserveData(token.addr, userAddr);
      if (d.usageAsCollateralEnabled && d.currentATokenBalance.gt(maxCol)) {
        maxCol = d.currentATokenBalance;
        result = { name, addr: token.addr, decimals: token.decimals, liqBonus: token.liqBonus };
      }
    } catch (_) {}
  }
  return result;
}

// ─── Estimate profit ──────────────────────────────────────
function estimateProfit(debtUsd, liqBonus) {
  const liquidateAmount   = debtUsd * 0.5;              // 50% of debt
  const collateralGained  = liquidateAmount * liqBonus; // Bonus collateral
  const flashLoanFee      = liquidateAmount * FLASH_LOAN_FEE;
  const gasCostUsd        = (GAS_LIMIT * GAS_PRICE_GWEI * 1e-9) * MATIC_USD_PRICE;
  const profit            = collateralGained - liquidateAmount - flashLoanFee - gasCostUsd;

  return {
    liquidateAmount: liquidateAmount.toFixed(2),
    collateralGained: collateralGained.toFixed(2),
    flashLoanFee: flashLoanFee.toFixed(2),
    gasCostUsd: gasCostUsd.toFixed(2),
    profit: profit.toFixed(2),
    isProfitable: profit > MIN_PROFIT_USD
  };
}

// ─── MAIN ─────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   EXECUTOR — ULTRA v7 REAL-TIME SCAN    ║");
  console.log("╚══════════════════════════════════════════╝\n");

  if (!RPC_URL || !PRIVATE_KEY || !WALLET_ADDRESS) {
    console.error("❌ ENV missing: RPC_URL / PRIVATE_KEY / WALLET_ADDRESS");
    process.exit(1);
  }

  const provider   = new ethers.providers.JsonRpcProvider(RPC_URL);
  const wallet     = new ethers.Wallet(PRIVATE_KEY, provider);
  const pool       = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);
  const dataProvider = new ethers.Contract(AAVE_DATA_PROVIDER, DATA_PROVIDER_ABI, provider);
  const liquidator = new ethers.Contract(FLASH_LIQUIDATOR, LIQUIDATOR_ABI, wallet);

  // ── Load whales ─────────────────────────────────────────
  let whales = [];
  try {
    whales = JSON.parse(fs.readFileSync("whales.json", "utf8"));
    console.log(`📋 Loaded: ${whales.length} whales\n`);
  } catch (e) {
    console.error("❌ whales.json not found!");
    process.exit(1);
  }

  // ── Wallet balance check ─────────────────────────────────
  const balance = await provider.getBalance(WALLET_ADDRESS);
  const balanceMatic = parseFloat(ethers.utils.formatEther(balance));
  console.log(`💼 Wallet Balance: ${balanceMatic.toFixed(4)} MATIC\n`);

  if (balanceMatic < 0.5) {
    console.error("⚠️  Balance bahut kam hai — gas ke liye kam se kam 0.5 MATIC chahiye!");
  }

  // ── Counters ─────────────────────────────────────────────
  let liquidatable = 0;
  let executed     = 0;
  let skippedLoss  = 0;
  let safe         = 0;

  // ── Scan ─────────────────────────────────────────────────
  for (let i = 0; i < whales.length; i++) {
    const whale = whales[i];

    try {
      const data     = await pool.getUserAccountData(whale.address);
      const hf       = parseFloat(ethers.utils.formatUnits(data.healthFactor, 18));
      const debtUsd  = parseFloat(ethers.utils.formatUnits(data.totalDebtBase, 8));
      const colUsd   = parseFloat(ethers.utils.formatUnits(data.totalCollateralBase, 8));

      const icon =
        hf < 1.0  ? "🚨" :
        hf < 1.05 ? "🔴" :
        hf < 1.10 ? "🟠" :
        hf < 1.20 ? "🟡" : "✅";

      console.log(`[${i+1}/${whales.length}] ${icon} ${whale.address}`);
      console.log(`   HF: ${hf.toFixed(4)} | Debt: $${debtUsd.toFixed(0)} | Col: $${colUsd.toFixed(0)}`);

      // ── LIQUIDATABLE ──────────────────────────────────────
      if (hf < 1.0 && debtUsd > 100) {
        liquidatable++;
        console.log(`   🚨 LIQUIDATABLE! Profit check karte hain...`);

        // Find tokens
        const debtToken = await getTopDebtToken(dataProvider, whale.address);
        const colToken  = await getTopCollateralToken(dataProvider, whale.address);

        if (!debtToken || !colToken) {
          console.log(`   ⚠️  Token identify nahi hua — skip\n`);
          continue;
        }

        // Profit estimation
        const est = estimateProfit(debtUsd, colToken.liqBonus);

        console.log(`   💰 Debt Token     : ${debtToken.name}`);
        console.log(`   🏦 Collateral     : ${colToken.name} (${((colToken.liqBonus-1)*100).toFixed(1)}% bonus)`);
        console.log(`   📊 Liquidate Amt  : $${est.liquidateAmount}`);
        console.log(`   💵 Flash Loan Fee : $${est.flashLoanFee}`);
        console.log(`   ⛽ Gas Cost       : $${est.gasCostUsd}`);
        console.log(`   🎯 Est. Profit    : $${est.profit}`);

        if (!est.isProfitable) {
          console.log(`   ❌ Loss mein hoga — SKIP (Profit $${est.profit} < Min $${MIN_PROFIT_USD})\n`);
          skippedLoss++;
          continue;
        }

        console.log(`   ✅ PROFITABLE! TX bhej raha hoon...`);

        // 50% of debt
        const debtAmount = debtToken.amount.div(2);

        try {
          const tx = await liquidator.liquidate(
            colToken.addr,
            debtToken.addr,
            whale.address,
            debtAmount,
            false,
            {
              gasLimit: GAS_LIMIT,
              gasPrice: ethers.utils.parseUnits(String(GAS_PRICE_GWEI), "gwei")
            }
          );

          console.log(`   📤 TX Sent: ${tx.hash}`);
          console.log(`   ⏳ Confirmation ka wait...`);

          const receipt = await tx.wait();

          if (receipt.status === 1) {
            console.log(`   🎉 SUCCESS! Block: ${receipt.blockNumber}`);
            console.log(`   💸 Gas Used: ${receipt.gasUsed.toString()}`);
            console.log(`   💰 Est. Profit Received: ~$${est.profit}`);
            executed++;
          } else {
            console.log(`   ❌ TX Reverted! Block: ${receipt.blockNumber}`);
          }

        } catch (txErr) {
          console.log(`   ❌ TX Error: ${txErr.message.substring(0, 100)}`);
        }

      } else if (hf >= 1.0 && hf < 1.05) {
        console.log(`   🔴 CRITICAL — Bahut karib hai, next run mein fire ho sakta hai!`);
      } else if (hf >= 1.05 && hf < 1.10) {
        console.log(`   🟠 HIGH RISK — Nazar rakho`);
      } else if (hf >= 1.10 && hf < 1.20) {
        console.log(`   🟡 MEDIUM — Monitor`);
      } else {
        safe++;
        console.log(`   ✅ Safe`);
      }

      console.log("");

    } catch (err) {
      console.log(`❌ Error [${whale.address}]: ${err.message.substring(0, 80)}\n`);
    }

    // Small delay between whales
    await sleep(100);
  }

  // ── Final Summary ─────────────────────────────────────────
  console.log("╔══════════════════════════════════════════╗");
  console.log("║              SCAN SUMMARY                ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`📋 Total Scanned    : ${whales.length}`);
  console.log(`🚨 Liquidatable     : ${liquidatable}`);
  console.log(`🎉 Executed         : ${executed}`);
  console.log(`❌ Skipped (loss)   : ${skippedLoss}`);
  console.log(`✅ Safe             : ${safe}`);
  console.log(`⏰ Next scan        : ~15 min`);

  if (executed > 0) {
    console.log(`\n💰 LIQUIDATION HUI! Check your wallet!`);
  } else if (liquidatable > 0) {
    console.log(`\n⚠️  Liquidatable positions mili lekin TX profitable nahi thi.`);
  } else {
    console.log(`\n💤 Koi liquidatable position nahi mili. Bot monitor kar raha hai.`);
  }
}

main().catch(console.error);

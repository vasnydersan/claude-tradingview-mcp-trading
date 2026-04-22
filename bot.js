/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via Coinbase Advanced if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["COINBASE_API_KEY", "COINBASE_PRIVATE_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  // Credentials already in environment (Railway) — skip .env file check entirely
  if (missing.length === 0) {
    const csvPath = new URL("trades.csv", import.meta.url).pathname;
    console.log(`\n📄 Trade log: ${csvPath}`);
    return;
  }

  // Local dev — help user create their .env
  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — creating one for you...\n");
    writeFileSync(
      ".env",
      [
        "# Coinbase Advanced credentials",
        "COINBASE_API_KEY=",
        "COINBASE_PRIVATE_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try { execSync("open .env"); } catch {}
    console.log("Fill in your Coinbase Advanced credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
  console.log("Add the missing values to your .env then re-run: node bot.js\n");
  try { execSync("open .env"); } catch {}
  process.exit(0);
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];
  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");
    check("Price above VWAP (buyers in control)", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);
    check("Price above EMA(8) (uptrend confirmed)", `> ${ema8.toFixed(2)}`, price.toFixed(2), price > ema8);
    check("RSI(3) below 30 (snap-back setup in uptrend)", "< 30", rsi3.toFixed(2), rsi3 < 30);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5);
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");
    check("Price below VWAP (sellers in control)", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
    check("Price below EMA(8) (downtrend confirmed)", `< ${ema8.toFixed(2)}`, price.toFixed(2), price < ema8);
    check("RSI(3) above 70 (reversal setup in downtrend)", "> 70", rsi3.toFixed(2), rsi3 > 70);
    const dist = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${dist.toFixed(2)}%`, dist < 1.5);
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  return { results, allPass: results.every((r) => r.pass) };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(`🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`);
    return false;
  }
  console.log(`✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`);
  return true;
}

// ─── Coinbase Advanced Execution ─────────────────────────────────────────────

function createCoinbaseJWT(method, path) {
  const keyName = CONFIG.coinbase.apiKey;
  const privateKey = CONFIG.coinbase.privateKey;
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyName })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: keyName, iss: "cdp", nbf: now, exp: now + 120,
    uri: `${method} api.coinbase.com${path}`,
  })).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  return `${signingInput}.${sign.sign(privateKey, "base64url")}`;
}

async function placeCoinbaseOrder(symbol, side, sizeUSD) {
  const productId = toCoinbaseProductId(symbol);
  const path = "/api/v3/brokerage/orders";
  const jwt = createCoinbaseJWT("POST", path);
  const body = JSON.stringify({
    client_order_id: `claude-bot-${Date.now()}`,
    product_id: productId,
    side: side.toUpperCase(),
    order_configuration: {
      market_market_ioc: side.toUpperCase() === "BUY"
        ? { quote_size: sizeUSD.toFixed(2) }
        : { base_size: (sizeUSD / 1).toFixed(8) },
    },
  });
  const res = await fetch(`${CONFIG.coinbase.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body,
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Coinbase order failed: ${data.error || data.message || res.status}`);
  }
  return { orderId: data.order_id, productId: data.product_id, side: data.side };
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

const CSV_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Side", "Quantity",
  "Price", "Total USD", "Fee (est.)", "Net Amount", "Order ID", "Mode", "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(`📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`);
  }
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  let side = "", quantity = "", totalUSD = "", fee = "", netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED"; orderId = "BLOCKED"; notes = `Failed: ${failed}`;
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.006).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [date, time, "Coinbase Advanced", logEntry.symbol, side, quantity,
    logEntry.price.toFixed(2), totalUSD, fee, netAmount, orderId, mode, `"${notes}"`].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found."); return; }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));
  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);
  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  const log = loadLog();
  if (!checkTradeLimits(log)) { console.log("\nBot stopping — trade limits reached for today."); return; }

  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  Current price: $${price.toFixed(2)}`);
  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) { console.log("\n⚠️  Not enough data. Exiting."); return; }

  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(), symbol: CONFIG.symbol, timeframe: CONFIG.timeframe,
    price, indicators: { ema8, vwap, rsi3 }, conditions: results, allPass, tradeSize,
    orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading,
    limits: { maxTradeSizeUSD: CONFIG.maxTradeSizeUSD, maxTradesPerDay: CONFIG.maxTradesPerDay, tradesToday: countTodaysTrades(log) },
  };

  if (!allPass) {
    console.log(`🚫 TRADE BLOCKED`);
    results.filter((r) => !r.pass).forEach((f) => console.log(`   - ${f.label}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);
    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`);
      try {
        const order = await placeCoinbaseOrder(CONFIG.symbol, "buy", tradeSize);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  writeTradeCsv(logEntry);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => { console.error("Bot error:", err); process.exit(1); });
}

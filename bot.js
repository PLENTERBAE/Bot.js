require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ─────────────────────────────────────────
// DATABASE IN-MEMORY
// ─────────────────────────────────────────
const db = {};
let cachedSolPrice = 150;
let solPriceLastFetch = 0;

function getUser(id) {
  if (!db[id]) {
    db[id] = { sol: 10, portfolio: {}, txHistory: [] };
  }
  return db[id];
}

// ─────────────────────────────────────────
// HARGA SOL (cache 30 detik)
// ─────────────────────────────────────────
async function getSolPrice() {
  const now = Date.now();
  if (now - solPriceLastFetch < 30000) return cachedSolPrice;
  try {
    const r = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { timeout: 4000 }
    );
    cachedSolPrice = r.data?.solana?.usd || cachedSolPrice;
    solPriceLastFetch = now;
  } catch (_) {}
  return cachedSolPrice;
}

// ─────────────────────────────────────────
// HARGA TOKEN: BIRDEYE + FALLBACK DEXSCREENER
// ─────────────────────────────────────────
async function getTokenInfo(ca) {
  // --- Coba Birdeye ---
  try {
    const [priceRes, metaRes] = await Promise.allSettled([
      axios.get(`https://public-api.birdeye.so/defi/price?address=${ca}`, {
        headers: { 'X-API-KEY': process.env.BIRDEYE_KEY || 'demo' },
        timeout: 4000,
      }),
      axios.get(`https://public-api.birdeye.so/defi/token_overview?address=${ca}`, {
        headers: { 'X-API-KEY': process.env.BIRDEYE_KEY || 'demo' },
        timeout: 4000,
      }),
    ]);

    const price = priceRes.status === 'fulfilled' ? priceRes.value.data?.data?.value : null;
    const meta = metaRes.status === 'fulfilled' ? metaRes.value.data?.data : null;

    if (price) {
      return {
        price,
        name: meta?.name || 'Unknown',
        symbol: meta?.symbol || '???',
        change24h: meta?.priceChange24hPercent || 0,
        liquidity: meta?.liquidity || 0,
        volume24h: meta?.v24hUSD || 0,
        fdv: meta?.fdv || 0,
        mc: meta?.mc || 0,
        source: 'Birdeye ⚡',
      };
    }
  } catch (_) {}

  // --- Fallback DexScreener ---
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${ca}?_=${Date.now()}`,
      { timeout: 5000 }
    );
    const pair = res.data?.pairs?.[0];
    if (!pair) return null;
    return {
      price: parseFloat(pair.priceUsd || 0),
      name: pair.baseToken.name,
      symbol: pair.baseToken.symbol,
      change24h: parseFloat(pair.priceChange?.h24 || 0),
      liquidity: pair.liquidity?.usd || 0,
      volume24h: pair.volume?.h24 || 0,
      fdv: pair.fdv || 0,
      mc: pair.marketCap || 0,
      source: 'DexScreener',
    };
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────
// FORMAT HELPERS
// ─────────────────────────────────────────
function fmt(n, dec = 6) {
  if (!n || isNaN(n)) return '0';
  if (n < 0.000001) return n.toExponential(2);
  return parseFloat(n.toFixed(dec)).toString();
}

function fmtUSD(n) {
  if (!n || isNaN(n)) return '$0.00';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${parseFloat(n.toFixed(2))}`;
}

function fmtNum(n) {
  if (!n || isNaN(n)) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return parseFloat(n.toFixed(2)).toString();
}

function pnlEmoji(pct) {
  if (pct >= 200) return '🔥';
  if (pct >= 100) return '🚀';
  if (pct >= 50) return '💰';
  if (pct >= 20) return '📈';
  if (pct >= 0) return '🟢';
  if (pct >= -20) return '🔴';
  if (pct >= -50) return '📉';
  return '💀';
}

function timeNow() {
  return new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
}

function shortCA(ca) {
  return `${ca.slice(0, 4)}...${ca.slice(-4)}`;
}

// ─────────────────────────────────────────
// TOKEN CARD TEXT (reusable)
// ─────────────────────────────────────────
function buildTokenText(info, ca, solPrice, userPos) {
  const priceInSol = info.price / solPrice;
  const chg = info.change24h || 0;
  const chgEmoji = chg >= 0 ? '🟢' : '🔴';
  const chgSign = chg >= 0 ? '+' : '';

  let posLine = '';
  if (userPos && userPos.amount > 0) {
    const valNow = userPos.amount * info.price / solPrice;
    const pct = ((valNow - userPos.solSpent) / userPos.solSpent) * 100;
    posLine =
      `\n💼 <b>POSISI KAMU</b>\n` +
      `   Qty   : <code>${fmtNum(userPos.amount)}</code>\n` +
      `   Entry : <code>$${fmt(userPos.avgPrice, 8)}</code>\n` +
      `   Now   : <code>$${fmt(info.price, 8)}</code>\n` +
      `   Nilai : <code>${fmt(valNow, 4)} SOL</code>\n` +
      `   PnL   : ${pnlEmoji(pct)} <b>${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b>\n`;
  }

  return (
    `🪙 <b>${info.name}</b>  <code>$${info.symbol}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 Price  : <code>$${fmt(info.price, 8)}</code>\n` +
    `◎  SOL    : <code>${fmt(priceInSol, 10)}</code>\n` +
    `${chgEmoji} 24h    : <b>${chgSign}${chg.toFixed(2)}%</b>\n` +
    `💧 Liq    : <b>${fmtUSD(info.liquidity)}</b>\n` +
    `📊 Vol 24h: <b>${fmtUSD(info.volume24h)}</b>\n` +
    `🏷  MC     : <b>${fmtUSD(info.mc || info.fdv)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    posLine +
    `📋 <code>${ca}</code>\n` +
    `⚡ ${info.source} | 🕐 ${timeNow()}`
  );
}

function buildTokenKeyboard(ca) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🟢 Buy 0.5 SOL', `buy_0.5_${ca}`),
      Markup.button.callback('🟢 Buy 1 SOL', `buy_1_${ca}`),
    ],
    [
      Markup.button.callback('🟢 Buy 5 SOL', `buy_5_${ca}`),
      Markup.button.callback('🟢 Buy 10 SOL', `buy_10_${ca}`),
    ],
    [
      Markup.button.callback('🔴 Sell 25%', `sell_25_${ca}`),
      Markup.button.callback('🔴 Sell 50%', `sell_50_${ca}`),
      Markup.button.callback('🔴 Sell 100%', `sell_100_${ca}`),
    ],
    [
      Markup.button.callback('← Back', `back_${ca}`),
      Markup.button.callback('🔄 Refresh', `refresh_${ca}`),
    ],
  ]);
}

// ─────────────────────────────────────────
// PNL CARD
// ─────────────────────────────────────────
function buildPnlCard(symbol, ca, solIn, solOut, tokenAmt, priceSell, pnlPct, solPrice) {
  const isProfit = pnlPct >= 0;
  const usdPnl = (solOut - solIn) * solPrice;
  const sign = isProfit ? '+' : '';
  const bar = isProfit
    ? '🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢'
    : '🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴';

  return (
    `${bar}\n` +
    `${pnlEmoji(pnlPct)} <b>TROJAN — Sell Confirmed</b>\n` +
    `${bar}\n\n` +
    `<b>${symbol} — (${shortCA(ca)})</b>\n` +
    `Sell Amount : <code>${fmtNum(tokenAmt)} ${symbol}</code>\n` +
    `Sell Price  : <code>$${fmt(priceSell, 8)}</code>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 Modal    : <code>${fmt(solIn, 4)} SOL</code>\n` +
    `💵 Dapat    : <code>${fmt(solOut, 4)} SOL</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${pnlEmoji(pnlPct)} PnL       : <b>${sign}${pnlPct.toFixed(2)}%</b>\n` +
    `💲 USD      : <b>${sign}${fmtUSD(Math.abs(usdPnl))}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🕐 ${timeNow()}`
  );
}

// ─────────────────────────────────────────
// /start
// ─────────────────────────────────────────
bot.start(async (ctx) => {
  const user = getUser(ctx.from.id);
  const solPrice = await getSolPrice();
  await ctx.replyWithHTML(
    `🏴‍☠️ <b>TROJAN BOT SIMULATOR</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Hei <b>${ctx.from.first_name}</b>, siap trading?\n\n` +
    `◎ Saldo  : <b>${fmt(user.sol, 4)} SOL</b>\n` +
    `💵 USD   : <b>${fmtUSD(user.sol * solPrice)}</b>\n\n` +
    `📌 Kirim <b>Contract Address</b> token Solana\n` +
    `   untuk melihat harga & mulai trading.\n\n` +
    `⚡ Powered by Birdeye (realtime)`,
    Markup.keyboard([
      ['📊 Portfolio', '📜 History'],
      ['💰 Saldo', '❓ Help'],
    ]).resize()
  );
});

// ─────────────────────────────────────────
// SALDO
// ─────────────────────────────────────────
bot.hears('💰 Saldo', async (ctx) => {
  const user = getUser(ctx.from.id);
  const solPrice = await getSolPrice();
  // hitung total nilai portfolio
  let portVal = 0;
  for (const ca of Object.keys(user.portfolio)) {
    const pos = user.portfolio[ca];
    const info = await getTokenInfo(ca).catch(() => null);
    if (info) portVal += (pos.amount * info.price) / solPrice;
  }
  const total = user.sol + portVal;
  await ctx.replyWithHTML(
    `💰 <b>SALDO</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `◎ Available : <code>${fmt(user.sol, 4)} SOL</code>\n` +
    `📦 Portfolio : <code>${fmt(portVal, 4)} SOL</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💼 Total    : <b>${fmt(total, 4)} SOL</b>\n` +
    `💵 USD      : <b>${fmtUSD(total * solPrice)}</b>\n` +
    `🕐 ${timeNow()}`
  );
});

// ─────────────────────────────────────────
// PORTFOLIO
// ─────────────────────────────────────────
async function buildPortfolioText(userId) {
  const user = getUser(userId);
  const solPrice = await getSolPrice();
  const keys = Object.keys(user.portfolio);

  if (keys.length === 0) {
    return (
      `📊 <b>PORTFOLIO</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Belum ada posisi terbuka.\n\n` +
      `◎ Available : <b>${fmt(user.sol, 4)} SOL</b>`
    );
  }

  let totalInvested = 0, totalNow = 0;
  let rows = '';

  for (const ca of keys) {
    const pos = user.portfolio[ca];
    const info = await getTokenInfo(ca).catch(() => null);
    const priceNow = info?.price || pos.avgPrice;
    const valNow = (pos.amount * priceNow) / solPrice;
    const pct = ((valNow - pos.solSpent) / pos.solSpent) * 100;
    totalInvested += pos.solSpent;
    totalNow += valNow;

    const sym = info?.symbol || pos.symbol;
    rows +=
      `\n▸ <b>${sym}</b>  <code>${shortCA(ca)}</code>\n` +
      `  Qty   : <code>${fmtNum(pos.amount)}</code>\n` +
      `  Entry : <code>$${fmt(pos.avgPrice, 8)}</code>\n` +
      `  Now   : <code>$${fmt(priceNow, 8)}</code>\n` +
      `  Value : <code>${fmt(valNow, 4)} SOL</code>  (${fmtUSD(valNow * solPrice)})\n` +
      `  PnL   : ${pnlEmoji(pct)} <b>${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b>\n`;
  }

  const totalPct = totalInvested > 0 ? ((totalNow - totalInvested) / totalInvested) * 100 : 0;
  const grandTotal = user.sol + totalNow;

  return (
    `📊 <b>PORTFOLIO</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━` +
    rows +
    `\n━━━━━━━━━━━━━━━━━━━━\n` +
    `◎ Available : <code>${fmt(user.sol, 4)} SOL</code>\n` +
    `📥 Invested  : <code>${fmt(totalInvested, 4)} SOL</code>\n` +
    `📤 Nilai Now : <code>${fmt(totalNow, 4)} SOL</code>\n` +
    `${pnlEmoji(totalPct)} Total PnL  : <b>${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(2)}%</b>\n` +
    `💼 Net Worth : <b>${fmt(grandTotal, 4)} SOL</b>  (${fmtUSD(grandTotal * solPrice)})\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🕐 ${timeNow()}`
  );
}

function buildPortfolioKeyboard(userId) {
  const user = getUser(userId);
  const keys = Object.keys(user.portfolio);
  const rows = [];
  // Tombol Sell per token
  for (const ca of keys) {
    const pos = user.portfolio[ca];
    rows.push([Markup.button.callback(`🔴 Sell ${pos.symbol}`, `sellmenu_${ca}`)]);
  }
  rows.push([Markup.button.callback('🔄 Refresh Portfolio', 'refresh_portfolio')]);
  return Markup.inlineKeyboard(rows);
}

bot.hears(['📊 Portfolio', '/portfolio'], async (ctx) => {
  const msg = await ctx.replyWithHTML('⏳ Memuat portfolio...');
  const text = await buildPortfolioText(ctx.from.id);
  const kb = buildPortfolioKeyboard(ctx.from.id);
  await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, text, {
    parse_mode: 'HTML',
    ...kb,
  });
});

bot.action('refresh_portfolio', async (ctx) => {
  await ctx.answerCbQuery('Memperbarui...');
  const text = await buildPortfolioText(ctx.from.id);
  const kb = buildPortfolioKeyboard(ctx.from.id);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
});

// ─────────────────────────────────────────
// SELL MENU dari Portfolio (pilih %)
// ─────────────────────────────────────────
bot.action(/^sellmenu_(.+)$/, async (ctx) => {
  const ca = ctx.match[1];
  await ctx.answerCbQuery();
  const user = getUser(ctx.from.id);
  const pos = user.portfolio[ca];
  if (!pos) return;

  const info = await getTokenInfo(ca).catch(() => null);
  const solPrice = await getSolPrice();
  const priceNow = info?.price || pos.avgPrice;
  const valNow = (pos.amount * priceNow) / solPrice;
  const pct = ((valNow - pos.solSpent) / pos.solSpent) * 100;

  const text =
    `🔴 <b>SELL — ${pos.symbol}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Qty   : <code>${fmtNum(pos.amount)}</code>\n` +
    `Entry : <code>$${fmt(pos.avgPrice, 8)}</code>\n` +
    `Now   : <code>$${fmt(priceNow, 8)}</code>\n` +
    `Value : <code>${fmt(valNow, 4)} SOL</code>\n` +
    `PnL   : ${pnlEmoji(pct)} <b>${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Pilih berapa % yang ingin dijual:`;

  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('Sell 25%', `sell_25_${ca}`),
        Markup.button.callback('Sell 50%', `sell_50_${ca}`),
      ],
      [
        Markup.button.callback('Sell 75%', `sell_75_${ca}`),
        Markup.button.callback('Sell 100%', `sell_100_${ca}`),
      ],
      [Markup.button.callback('← Back', 'refresh_portfolio')],
    ]),
  }).catch(() => {});
});

// ─────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────
bot.hears(['📜 History', '/history'], async (ctx) => {
  const user = getUser(ctx.from.id);
  if (user.txHistory.length === 0) {
    return ctx.replyWithHTML(
      `📜 <b>HISTORY</b>\n━━━━━━━━━━━━━━━━━━━━\nBelum ada transaksi.`
    );
  }
  const last = user.txHistory.slice(-15).reverse();
  let text = `📜 <b>HISTORY</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  for (const tx of last) {
    const icon = tx.type === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    text += `${icon}  <b>${tx.symbol}</b>\n`;
    if (tx.type === 'BUY') {
      text += `  ${fmt(tx.solAmount, 4)} SOL → ${fmtNum(tx.tokenAmount)} token\n`;
    } else {
      text += `  ${fmtNum(tx.tokenAmount)} token → ${fmt(tx.solAmount, 4)} SOL\n`;
      if (tx.pnlPct !== undefined) {
        text += `  PnL: ${pnlEmoji(tx.pnlPct)} <b>${tx.pnlPct >= 0 ? '+' : ''}${tx.pnlPct.toFixed(2)}%</b>\n`;
      }
    }
    text += `  <i>${tx.time}</i>\n\n`;
  }
  await ctx.replyWithHTML(text);
});

// ─────────────────────────────────────────
// HELP
// ─────────────────────────────────────────
bot.hears('❓ Help', async (ctx) => {
  await ctx.replyWithHTML(
    `❓ <b>PANDUAN</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `1️⃣ Kirim <b>Contract Address</b> Solana\n` +
    `   → Harga live + tombol Buy/Sell\n\n` +
    `2️⃣ <b>Buy:</b> 0.5 / 1 / 5 / 10 SOL\n\n` +
    `3️⃣ <b>Sell dari token card:</b>\n` +
    `   Sell 25% / 50% / 100%\n\n` +
    `4️⃣ <b>Sell dari Portfolio:</b>\n` +
    `   Tekan 🔴 Sell [Token]\n\n` +
    `5️⃣ Setiap jual → <b>PnL Card</b> otomatis keluar\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⚡ Birdeye (realtime) + DexScreener fallback`
  );
});

// ─────────────────────────────────────────
// DETEKSI CONTRACT ADDRESS
// ─────────────────────────────────────────
async function sendTokenCard(ctx, ca) {
  const loadMsg = await ctx.replyWithHTML('⏳ Fetching price...');
  const [info, solPrice] = await Promise.all([getTokenInfo(ca), getSolPrice()]);

  if (!info || !info.price) {
    return ctx.telegram.editMessageText(
      ctx.chat.id, loadMsg.message_id, undefined,
      '❌ Token tidak ditemukan atau liquidity = 0.', { parse_mode: 'HTML' }
    );
  }

  const user = getUser(ctx.from.id);
  const text = buildTokenText(info, ca, solPrice, user.portfolio[ca]);
  const kb = buildTokenKeyboard(ca);

  await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, undefined, text, {
    parse_mode: 'HTML', ...kb,
  });
}

bot.on('text', async (ctx) => {
  const txt = ctx.message.text.trim();
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(txt)) {
    await sendTokenCard(ctx, txt);
  }
});

// ─────────────────────────────────────────
// REFRESH HARGA
// ─────────────────────────────────────────
bot.action(/^refresh_([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
  const ca = ctx.match[1];
  await ctx.answerCbQuery('Memperbarui...');
  const [info, solPrice] = await Promise.all([getTokenInfo(ca), getSolPrice()]);
  if (!info) return;
  const user = getUser(ctx.from.id);
  const text = buildTokenText(info, ca, solPrice, user.portfolio[ca]);
  const kb = buildTokenKeyboard(ca);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
});

// BACK (dari token card ke token card versi refresh)
bot.action(/^back_(.+)$/, async (ctx) => {
  const ca = ctx.match[1];
  await ctx.answerCbQuery();
  const [info, solPrice] = await Promise.all([getTokenInfo(ca), getSolPrice()]);
  if (!info) return;
  const user = getUser(ctx.from.id);
  const text = buildTokenText(info, ca, solPrice, user.portfolio[ca]);
  const kb = buildTokenKeyboard(ca);
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
});

// ─────────────────────────────────────────
// BUY
// ─────────────────────────────────────────
bot.action(/^buy_(\d+\.?\d*)_([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
  const solAmount = parseFloat(ctx.match[1]);
  const ca = ctx.match[2];
  const user = getUser(ctx.from.id);

  if (user.sol < solAmount) {
    return ctx.answerCbQuery(`❌ Saldo tidak cukup! Punya ${fmt(user.sol, 4)} SOL`, { show_alert: true });
  }
  await ctx.answerCbQuery('⏳ Eksekusi...');

  const [info, solPrice] = await Promise.all([getTokenInfo(ca), getSolPrice()]);
  if (!info?.price) return ctx.reply('❌ Gagal ambil harga');

  const usdSpent = solAmount * solPrice;
  const tokenReceived = usdSpent / info.price;

  if (!user.portfolio[ca]) {
    user.portfolio[ca] = { ca, symbol: info.symbol, amount: 0, avgPrice: 0, solSpent: 0 };
  }
  const pos = user.portfolio[ca];
  const prevCost = pos.avgPrice * pos.amount;
  pos.amount += tokenReceived;
  pos.avgPrice = (prevCost + info.price * tokenReceived) / pos.amount;
  pos.solSpent += solAmount;
  pos.symbol = info.symbol;
  user.sol = parseFloat((user.sol - solAmount).toFixed(9));

  user.txHistory.push({
    type: 'BUY', symbol: info.symbol, ca,
    solAmount, tokenAmount: tokenReceived,
    priceUsd: info.price, time: timeNow(),
  });

  await ctx.replyWithHTML(
    `✅ <b>BUY — ${info.symbol}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `◎ Spent  : <code>${fmt(solAmount, 4)} SOL</code>  (${fmtUSD(usdSpent)})\n` +
    `📦 Recv  : <code>${fmtNum(tokenReceived)} ${info.symbol}</code>\n` +
    `💲 Price : <code>$${fmt(info.price, 8)}</code>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `◎ Remaining : <b>${fmt(user.sol, 4)} SOL</b>\n` +
    `🕐 ${timeNow()}`
  );
});

// ─────────────────────────────────────────
// SELL (dari token card ATAU sell menu)
// ─────────────────────────────────────────
bot.action(/^sell_(\d+)_([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
  const pct = parseInt(ctx.match[1]);
  const ca = ctx.match[2];
  const user = getUser(ctx.from.id);
  const pos = user.portfolio[ca];

  if (!pos || pos.amount <= 0) {
    return ctx.answerCbQuery('❌ Kamu tidak punya token ini!', { show_alert: true });
  }
  await ctx.answerCbQuery('⏳ Eksekusi...');

  const [info, solPrice] = await Promise.all([getTokenInfo(ca), getSolPrice()]);
  if (!info?.price) return ctx.reply('❌ Gagal ambil harga');

  const tokenSold = pos.amount * (pct / 100);
  const usdReceived = tokenSold * info.price;
  const solReceived = usdReceived / solPrice;
  const solSpentPortion = pos.solSpent * (pct / 100);
  const pnlPct = ((solReceived - solSpentPortion) / solSpentPortion) * 100;

  // Update posisi
  pos.amount = parseFloat((pos.amount - tokenSold).toFixed(9));
  pos.solSpent = parseFloat((pos.solSpent - solSpentPortion).toFixed(9));
  user.sol = parseFloat((user.sol + solReceived).toFixed(9));
  if (pos.amount < 0.000001 || pct === 100) delete user.portfolio[ca];

  user.txHistory.push({
    type: 'SELL', symbol: info.symbol, ca,
    solAmount: solReceived, tokenAmount: tokenSold,
    priceUsd: info.price, pnlPct, time: timeNow(),
  });

  const card = buildPnlCard(info.symbol, ca, solSpentPortion, solReceived, tokenSold, info.price, pnlPct, solPrice);
  await ctx.replyWithHTML(card);

  // Update tombol di pesan lama (hapus sell menu jika dari portfolio)
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
});

// ─────────────────────────────────────────
// LAUNCH
// ─────────────────────────────────────────
bot.launch().then(() => console.log('✅ Trojan Bot Simulator RUNNING'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

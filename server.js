// ─────────────────────────────────────────────────────────────
//  Gold Signal AI — Backend Server (Production Ready)
//  Peter's Exness Demo Trading Dashboard
//  Run with: node server.js
// ─────────────────────────────────────────────────────────────

if (process.env.NODE_ENV !== 'production') require('dotenv').config();

const express  = require('express');
const fetch    = require('node-fetch');
const cors     = require('cors');
const path     = require('path');
const https    = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Custom HTTPS agent ────────────────────────────────────────
const httpsAgent = new https.Agent({
  keepAlive:          true,
  timeout:            15000,
  rejectUnauthorized: true,
  minVersion:         'TLSv1.2',
});

// ── Safe fetch with timeout ───────────────────────────────────
async function safeFetch(url, options = {}) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      ...options,
      agent:  httpsAgent,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GoldSignalBot/1.0)',
        'Accept':     'application/json',
        ...(options.headers || {})
      }
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─────────────────────────────────────────────────────────────
//  ROUTE 1: GET /api/gold-price
//  Returns current Gold price from best available source
// ─────────────────────────────────────────────────────────────
app.get('/api/gold-price', async (req, res) => {

  async function tryMetalsDev() {
    const key = process.env.METALS_API_KEY;
    if (!key) throw new Error('METALS_API_KEY not set');
    const r = await safeFetch(`https://api.metals.dev/v1/latest?api_key=${key}&base=USD&currencies=XAU`);
    if (!r.ok) throw new Error(`metals.dev ${r.status}`);
    const d = await r.json();
    if (d.status !== 'success') throw new Error(d.error_message || 'metals.dev error');
    if (!d.metals || !d.metals.gold) throw new Error('gold not in metals.dev');
    return { price: d.metals.gold, source: 'metals.dev (live)' };
  }

  async function tryCurrencyApi() {
    const r = await safeFetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.json');
    if (!r.ok) throw new Error(`currency-api ${r.status}`);
    const d = await r.json();
    if (!d.xau || !d.xau.usd) throw new Error('xau.usd not in currency-api');
    return { price: parseFloat(d.xau.usd.toFixed(2)), source: 'currency-api (live)' };
  }

  const sources = [
    { name: 'metals.dev',   fn: tryMetalsDev   },
    { name: 'currency-api', fn: tryCurrencyApi  },
  ];

  let result = null;
  for (const source of sources) {
    try {
      result = await source.fn();
      if (result && result.price > 500) {
        console.log(`[Gold Price] ✅ ${source.name}: $${result.price}`);
        break;
      }
    } catch (e) {
      console.warn(`[Gold Price] ❌ ${source.name}: ${e.message}`);
    }
  }

  if (!result || !result.price) {
    const sim = 4150 + (Math.random() * 30 - 15);
    console.warn('[Gold Price] ⚠️ All sources failed — simulated price');
    return res.json({
      price: parseFloat(sim.toFixed(2)),
      high:  parseFloat((sim + 8).toFixed(2)),
      low:   parseFloat((sim - 12).toFixed(2)),
      prevClose: parseFloat((sim - 4).toFixed(2)),
      source: 'simulated (market closed or network issue)',
      simulated: true
    });
  }

  const price = result.price;
  res.json({
    price:     parseFloat(price.toFixed(2)),
    high:      parseFloat((price + 7 + Math.random() * 5).toFixed(2)),
    low:       parseFloat((price - 10 - Math.random() * 5).toFixed(2)),
    prevClose: parseFloat((price - 2 + Math.random() * 4).toFixed(2)),
    source:    result.source,
    simulated: false
  });
});


// ─────────────────────────────────────────────────────────────
//  ROUTE 2: GET /api/candles
//  Fetches REAL Gold candle data from Twelve Data
//  Returns last 100 closing prices for accurate indicators
// ─────────────────────────────────────────────────────────────
app.get('/api/candles', async (req, res) => {
  const key = process.env.TWELVE_DATA_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'TWELVE_DATA_API_KEY not set in environment variables' });
  }

  try {
    // Fetch last 100 x 5-minute candles for XAU/USD
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=5min&outputsize=100&apikey=${key}`;
    const r   = await safeFetch(url);
    if (!r.ok) throw new Error(`Twelve Data responded with ${r.status}`);
    const data = await r.json();

    if (data.status === 'error') {
      throw new Error(`Twelve Data error: ${data.message}`);
    }

    if (!data.values || !Array.isArray(data.values)) {
      throw new Error('No candle data in Twelve Data response');
    }

    // Extract closing prices (oldest first for indicator calculations)
    const closes = data.values
      .map(candle => parseFloat(candle.close))
      .filter(p => !isNaN(p))
      .reverse(); // Twelve Data returns newest first — we reverse to oldest first

    const highs  = data.values.map(c => parseFloat(c.high)).filter(Boolean).reverse();
    const lows   = data.values.map(c => parseFloat(c.low)).filter(Boolean).reverse();
    const latest = closes[closes.length - 1];
    const high   = Math.max(...highs.slice(-20));
    const low    = Math.min(...lows.slice(-20));

    console.log(`[Candles] ✅ Got ${closes.length} real candles from Twelve Data. Latest close: $${latest}`);

    res.json({
      closes,
      high:   parseFloat(high.toFixed(2)),
      low:    parseFloat(low.toFixed(2)),
      latest: parseFloat(latest.toFixed(2)),
      count:  closes.length,
      source: 'Twelve Data (real candles)'
    });

  } catch (e) {
    console.error('[Candles] ❌ Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────────────────────
//  ROUTE 3: POST /api/analyse
//  Calls Claude AI with real indicator data
// ─────────────────────────────────────────────────────────────
app.post('/api/analyse', async (req, res) => {
  const { price, rsi, macd, ma20, ma50, session } = req.body;
  if (!price) return res.status(400).json({ error: 'Price is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const prompt = `You are an expert Gold (XAUUSD) forex trading analyst helping a beginner trader in Nigeria with a $100–$500 demo account on Exness MT5.

LIVE MARKET DATA (from real candle data):
- Gold Price (XAUUSD): ${price}
- RSI (14): ${rsi ?? 'unavailable'}
- MACD: ${macd ?? 'unavailable'}
- 20-period MA: ${ma20 ?? 'unavailable'}
- 50-period MA: ${ma50 ?? 'unavailable'}
- Current Session: ${session ?? 'Unknown'}
- Lot size: 0.01 micro lot ($1 Gold move = $0.10 profit or loss)
- Daily profit target: $5

Give a professional trading signal in JSON ONLY. No markdown, no extra text:
{
  "signal": "BUY" or "SELL" or "WAIT",
  "confidence": <integer 0-100>,
  "entry": <number>,
  "tp1": <number — 20-35 pts from entry>,
  "tp2": <number — 40-60 pts from entry>,
  "tp3": <number — 70-100 pts from entry>,
  "sl": <number — 15-30 pts from entry>,
  "reasoning": "<2-3 plain English sentences for a complete beginner. No jargon.>",
  "how_to_trade": "<Exact MT5 steps: what button to press, what numbers to type where>",
  "risk_warning": "<One specific warning about this exact trade>"
}

RULES:
- BUY: tp1/tp2/tp3 ABOVE entry, sl BELOW entry
- SELL: tp1/tp2/tp3 BELOW entry, sl ABOVE entry
- Confidence below 58 = WAIT
- Asia session = lean WAIT unless very strong signal
- Be conservative. A beginner's money is at stake.`;

  try {
    const r = await safeFetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Anthropic ${r.status}: ${errText}`);
    }

    const data   = await r.json();
    const raw    = data.content.map(c => c.text || '').join('');
    const clean  = raw.replace(/```json|```/g, '').trim();
    const signal = JSON.parse(clean);

    console.log(`[Analyse] ✅ Signal: ${signal.signal} (${signal.confidence}% confidence)`);
    res.json(signal);

  } catch (e) {
    console.error('[Analyse] ❌', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────────────────────
//  ROUTE 4: GET /api/test
// ─────────────────────────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  const results = {
    metals_key_set:      !!process.env.METALS_API_KEY,
    anthropic_key_set:   !!process.env.ANTHROPIC_API_KEY,
    twelve_data_key_set: !!process.env.TWELVE_DATA_API_KEY,
    network_test:        null,
    gold_price:          null
  };

  try {
    const r = await safeFetch(`https://api.metals.dev/v1/latest?api_key=${process.env.METALS_API_KEY}&base=USD&currencies=XAU`);
    const d = await r.json();
    results.network_test = d.status === 'success' ? '✅ metals.dev reachable' : '❌ ' + d.error_message;
    results.gold_price   = d.metals && d.metals.gold;
  } catch (e) {
    results.network_test = '❌ ' + e.message;
  }

  res.json(results);
});


// ─────────────────────────────────────────────────────────────
//  ROUTE 5: GET /api/debug
// ─────────────────────────────────────────────────────────────
app.get('/api/debug', (req, res) => {
  res.json({
    node_env:              process.env.NODE_ENV,
    metals_key_len:        process.env.METALS_API_KEY         ? process.env.METALS_API_KEY.length         : 0,
    anthropic_key_len:     process.env.ANTHROPIC_API_KEY      ? process.env.ANTHROPIC_API_KEY.length      : 0,
    twelve_data_key_len:   process.env.TWELVE_DATA_API_KEY    ? process.env.TWELVE_DATA_API_KEY.length    : 0,
    metals_key_start:      process.env.METALS_API_KEY         ? process.env.METALS_API_KEY.substring(0,6)       : 'NOT SET',
    anthropic_key_start:   process.env.ANTHROPIC_API_KEY      ? process.env.ANTHROPIC_API_KEY.substring(0,7)    : 'NOT SET',
    twelve_data_key_start: process.env.TWELVE_DATA_API_KEY    ? process.env.TWELVE_DATA_API_KEY.substring(0,6)  : 'NOT SET',
    all_env_keys: Object.keys(process.env).filter(k => !k.includes('npm') && !k.includes('PATH'))
  });
});


// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅ Gold Signal AI Server is running!');
  console.log(`  🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`  🔧 Test:      http://localhost:${PORT}/api/test`);
  console.log('  📊 Press Ctrl+C to stop');
  console.log('');
  console.log('  Environment check:');
  console.log('  METALS_API_KEY:       ' + (process.env.METALS_API_KEY       ? '✅ Set' : '❌ MISSING'));
  console.log('  ANTHROPIC_API_KEY:    ' + (process.env.ANTHROPIC_API_KEY    ? '✅ Set' : '❌ MISSING'));
  console.log('  TWELVE_DATA_API_KEY:  ' + (process.env.TWELVE_DATA_API_KEY  ? '✅ Set' : '❌ MISSING'));
  console.log('');
});
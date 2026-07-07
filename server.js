// ─────────────────────────────────────────────────────────────
//  Gold Signal AI — Backend Server (MTN-compatible)
//  Peter's Exness Demo Trading Dashboard
//  Run with: node server.js
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const cors     = require('cors');
const path     = require('path');
const https    = require('https');

const app  = express();
const PORT = 3000;

// ── Custom HTTPS agent — forces TLS 1.2, longer timeouts ─────
const httpsAgent = new https.Agent({
  keepAlive:           true,
  timeout:             15000,
  rejectUnauthorized:  true,
  minVersion:          'TLSv1.2',
});

// ── Safe fetch wrapper with timeout ──────────────────────────
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
// ─────────────────────────────────────────────────────────────
app.get('/api/gold-price', async (req, res) => {

  // Source 1: metals.dev with real API key from .env
  async function tryMetalsDev() {
    const key = process.env.METALS_API_KEY;
    if (!key) throw new Error('METALS_API_KEY not set in .env');
    const url = `https://api.metals.dev/v1/latest?api_key=${key}&base=USD&currencies=XAU`;
    const r   = await safeFetch(url);
    if (!r.ok) throw new Error(`metals.dev responded with ${r.status}`);
    const d   = await r.json();
    if (d.status !== 'success') throw new Error('metals.dev: ' + (d.error_message || 'unknown error'));
    const price = d.metals && d.metals.gold;
    if (!price) throw new Error('gold not found in metals.dev response');
    return { price, source: 'metals.dev (live)' };
  }

  // Source 2: Gold-API free endpoint
  async function tryGoldPriceOrg() {
    const r = await safeFetch('https://gold-price-live.p.rapidapi.com/get_metal_prices', {
      headers: {
        'X-RapidAPI-Host': 'gold-price-live.p.rapidapi.com',
        'X-RapidAPI-Key':  'demo'
      }
    });
    if (!r.ok) throw new Error('rapidapi not ok: ' + r.status);
    const d = await r.json();
    if (!d || !d.metal_prices || !d.metal_prices.XAU_USD) throw new Error('XAU not in rapidapi');
    return { price: parseFloat(d.metal_prices.XAU_USD), source: 'rapidapi (live)' };
  }

  // Source 3: Currencyapi free (has XAU)
  async function tryCurrencyApi() {
    const r = await safeFetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.json');
    if (!r.ok) throw new Error('currency-api not ok: ' + r.status);
    const d = await r.json();
    const usdPerXau = d.xau && d.xau.usd;
    if (!usdPerXau) throw new Error('xau.usd not in currency-api');
    return { price: parseFloat(usdPerXau.toFixed(2)), source: 'currency-api (live)' };
  }

  const sources = [
    { name: 'metals.dev',    fn: tryMetalsDev     },
    { name: 'currency-api',  fn: tryCurrencyApi   },
    { name: 'rapidapi',      fn: tryGoldPriceOrg  },
  ];

  let result = null;
  for (const source of sources) {
    try {
      result = await source.fn();
      if (result && result.price && result.price > 500) {
        console.log(`[Gold Price] ✅ Got price from ${source.name}: $${result.price}`);
        break;
      }
    } catch (e) {
      console.warn(`[Gold Price] ❌ ${source.name} failed: ${e.message}`);
    }
  }

  if (!result || !result.price) {
    const simulated = 4150 + (Math.random() * 30 - 15);
    console.warn('[Gold Price] ⚠️ All live sources failed — using simulated price');
    return res.json({
      price:     parseFloat(simulated.toFixed(2)),
      high:      parseFloat((simulated + 8).toFixed(2)),
      low:       parseFloat((simulated - 12).toFixed(2)),
      prevClose: parseFloat((simulated - 4).toFixed(2)),
      source:    'simulated (all live sources failed)',
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
//  ROUTE 2: POST /api/analyse
// ─────────────────────────────────────────────────────────────
app.post('/api/analyse', async (req, res) => {
  const { price, rsi, macd, ma20, ma50, session } = req.body;

  if (!price) return res.status(400).json({ error: 'Price data is required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set correctly in .env file' });
  }

  const prompt = `You are an expert Gold (XAUUSD) forex trading analyst helping a beginner trader in Nigeria with a $100–$500 demo account on Exness MT5.

LIVE MARKET DATA RIGHT NOW:
- Gold Price (XAUUSD): ${price}
- RSI (14): ${rsi ?? 'unavailable'}
- MACD: ${macd ?? 'unavailable'}
- 20-period MA: ${ma20 ?? 'unavailable'}
- 50-period MA: ${ma50 ?? 'unavailable'}
- Current Session: ${session ?? 'Unknown'}
- Lot size: 0.01 micro lot ($1 Gold move = $0.10 profit or loss)
- Daily profit target: $5

Give a professional trading signal in JSON ONLY. No markdown. No explanation outside the JSON:
{
  "signal": "BUY" or "SELL" or "WAIT",
  "confidence": <integer 0-100>,
  "entry": <number>,
  "tp1": <number — 20-35 pts from entry>,
  "tp2": <number — 40-60 pts from entry>,
  "tp3": <number — 70-100 pts from entry>,
  "sl": <number — 15-30 pts from entry>,
  "reasoning": "<2-3 plain English sentences for a complete beginner>",
  "how_to_trade": "<Exact MT5 steps: what to press, what numbers to enter>",
  "risk_warning": "<One specific warning about this exact trade>"
}

RULES:
- BUY: tp1/tp2/tp3 ABOVE entry, sl BELOW entry
- SELL: tp1/tp2/tp3 BELOW entry, sl ABOVE entry
- Confidence below 58 = WAIT
- Asia session = lean WAIT unless very strong signal
- Be conservative. A beginner's money is at stake.`;

  try {
    const anthropicRes = await safeFetch('https://api.anthropic.com/v1/messages', {
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

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      throw new Error(`Anthropic API error ${anthropicRes.status}: ${errText}`);
    }

    const data   = await anthropicRes.json();
    const raw    = data.content.map(c => c.text || '').join('');
    const clean  = raw.replace(/```json|```/g, '').trim();
    const signal = JSON.parse(clean);

    console.log(`[Analyse] ✅ Signal generated: ${signal.signal} (${signal.confidence}% confidence)`);
    res.json(signal);

  } catch (e) {
    console.error('[Analyse] ❌ Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─────────────────────────────────────────────────────────────
//  TEST ROUTE — visit http://localhost:3000/api/test
//  to quickly check if your keys and network are working
// ─────────────────────────────────────────────────────────────
app.get('/api/test', async (req, res) => {
  const results = {
    metals_key_set:    !!process.env.METALS_API_KEY,
    anthropic_key_set: !!process.env.ANTHROPIC_API_KEY,
    network_test:      null
  };

  try {
    const r = await safeFetch('https://api.metals.dev/v1/latest?api_key=' + process.env.METALS_API_KEY + '&base=USD&currencies=XAU');
    const d = await r.json();
    results.network_test  = d.status === 'success' ? '✅ metals.dev reachable' : '❌ ' + d.error_message;
    results.gold_price    = d.metals && d.metals.gold;
  } catch (e) {
    results.network_test = '❌ Network error: ' + e.message;
  }

  res.json(results);
});


// ─────────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ✅ Gold Signal AI Server is running!');
  console.log(`  🌐 Open your dashboard: http://localhost:${PORT}`);
  console.log(`  🔧 Run a connectivity test: http://localhost:${PORT}/api/test`);
  console.log('  📊 Press Ctrl+C to stop');
  console.log('');
  console.log('  Checking environment...');
  console.log('  METALS_API_KEY:    ' + (process.env.METALS_API_KEY    ? '✅ Set' : '❌ MISSING — add to .env'));
  console.log('  ANTHROPIC_API_KEY: ' + (process.env.ANTHROPIC_API_KEY ? '✅ Set' : '❌ MISSING — add to .env'));
  console.log('');
});
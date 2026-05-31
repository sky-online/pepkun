const fs   = require('fs');
const path = require('path');

const USAGE_FILE = path.join(__dirname, '../../data/usage.jsonl');

// モデルごとの単価（$/million tokens）
const PRICING = {
  'claude-sonnet-4-6': {
    input: 3.0, output: 15.0, cache_read: 0.30, cache_write: 3.75,
  },
  'claude-haiku-4-5-20251001': {
    input: 0.80, output: 4.0, cache_read: 0.08, cache_write: 1.00,
  },
};

function calcCost(model, usage) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  const M = 1_000_000;
  return (
    (usage.input_tokens              || 0) / M * p.input  +
    (usage.output_tokens             || 0) / M * p.output +
    (usage.cache_read_input_tokens   || 0) / M * p.cache_read  +
    (usage.cache_creation_input_tokens || 0) / M * p.cache_write
  );
}

function logUsage(model, usage, type = 'unknown') {
  try {
    const dir = path.dirname(USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const entry = {
      ts:    new Date().toISOString(),
      type,
      model,
      input:        usage.input_tokens              || 0,
      output:       usage.output_tokens             || 0,
      cache_read:   usage.cache_read_input_tokens   || 0,
      cache_write:  usage.cache_creation_input_tokens || 0,
      cost_usd:     parseFloat(calcCost(model, usage).toFixed(6)),
    };
    fs.appendFileSync(USAGE_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('[usage-logger]', e.message);
  }
}

function readUsage() {
  if (!fs.existsSync(USAGE_FILE)) return [];
  return fs.readFileSync(USAGE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

module.exports = { logUsage, readUsage, calcCost };

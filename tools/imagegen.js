// 画像生成ツール（Google Gemini 画像モデル）
// 使い方: node tools/imagegen.js "<プロンプト>" [枚数=3] [出力名=icon]
//   キーは PepKun/.env の GEMINI_API_KEY（gitignore済み・コミットしない）
//   モデルは GEMINI_IMAGE_MODEL で変更可
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs'), path = require('path');

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const [prompt, n = '3', name = 'icon'] = process.argv.slice(2);
if (!key) { console.error('GEMINI_API_KEY が .env にありません'); process.exit(1); }
if (!prompt) { console.error('プロンプトを指定してください'); process.exit(1); }

const outDir = path.join(__dirname, '..', 'design', 'generated');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  for (let i = 1; i <= Number(n); i++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const j = await r.json();
    if (!r.ok) { console.error('API error', r.status, JSON.stringify(j).slice(0, 300)); process.exit(1); }
    const img = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
    if (!img) { console.error('画像が返りませんでした', JSON.stringify(j).slice(0, 300)); continue; }
    const fp = path.join(outDir, `${name}-${stamp}-${i}.png`);
    fs.writeFileSync(fp, Buffer.from(img.data, 'base64'));
    console.log('saved', fp);
  }
})();

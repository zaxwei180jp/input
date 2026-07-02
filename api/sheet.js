// /api/sheet.js — Vercel Serverless Function
// 用 Google 服務帳號把掃描資料寫入 Google Sheet
//
// 需要的環境變數（Vercel 專案設定 → Environment Variables）：
//   GOOGLE_SERVICE_KEY : 服務帳號金鑰 JSON 的完整內容（整份貼上）
//   SHEET_ID           : 試算表 ID（網址 /d/ 與 /edit 中間那串）
//   SHEET_NAME         : 分頁名稱（宅配資料庫）

export default async function handler(req, res) {
  // 同源呼叫不需要 CORS 設定；保留 POST 限制
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { records } = req.body || {};
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ ok: false, error: 'no records' });
    }

    const keyRaw = process.env.GOOGLE_SERVICE_KEY;
    const sheetId = process.env.SHEET_ID;
    const sheetName = process.env.SHEET_NAME || '宅配資料庫';
    if (!keyRaw || !sheetId) {
      return res.status(500).json({ ok: false, error: 'server not configured' });
    }
    const key = JSON.parse(keyRaw);

    // ── 取得 access token（JWT 換 token，不用外部套件）──
    const token = await getAccessToken(key);

    // ── 組資料列：A日期 B客編 C物流 D單號 E件數 F備註 G重量 H出貨(空) ──
    const values = records.map(r => [
      r.date || '', r.b || '', r.c || '', String(r.d || ''),
      Number(r.e) || 1, r.f || '',
      (r.g === '' || r.g == null) ? '' : Number(r.g), ''
    ]);

    // ── append 到分頁 ──
    const range = encodeURIComponent(sheetName + '!A:H');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(502).json({ ok: false, error: data.error?.message || 'sheets api error' });
    }

    return res.status(200).json({
      ok: true,
      written: values.length,
      updatedRange: data.updates?.updatedRange || ''
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}

/* ── 服務帳號 JWT → access token ── */
async function getAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const input = header + '.' + claim;
  const signature = await signRS256(input, key.private_key);
  const jwt = input + '.' + signature;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('token error: ' + JSON.stringify(data));
  return data.access_token;
}

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signRS256(input, privateKeyPem) {
  const crypto = await import('node:crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(input);
  const sig = sign.sign(privateKeyPem);
  return sig.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

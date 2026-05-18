const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3001;
const TEMP_DIR = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(cors({ origin: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/api/image-proxy', async (req, res) => {
  const imgUrl = req.query.url;
  if (!imgUrl) return res.status(400).json({error:'Missing url'});
  try {
    const apiRes = await fetch(imgUrl, { timeout: 30000 });
    if (!apiRes.ok) return res.status(apiRes.status).send('Upstream error');
    const buf = Buffer.from(await apiRes.arrayBuffer());
    res.set('Cache-Control', 'public, max-age=3600');
    res.type(apiRes.headers.get('content-type') || 'image/png');
    res.send(buf);
  } catch(e) {
    res.status(500).send('Proxy error: ' + e.message);
  }
});

// Local image upload (stores temporarily, serves via /api/temp/)
app.post('/api/upload', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  try {
    const ext = req.headers['content-type']?.includes('png') ? '.png' : '.jpg';
    const name = crypto.randomBytes(16).toString('hex') + ext;
    fs.writeFileSync(path.join(TEMP_DIR, name), req.body);
    res.json({ url: `${req.protocol}://${req.get('host')}/api/temp/${name}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/temp/:name', (req, res) => {
  const file = path.join(TEMP_DIR, path.basename(req.params.name));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// Generic proxy for any API call (bypass CORS)
app.all('/api/fetch', express.json({ limit: '10mb' }), async (req, res) => {
  const { url, method, headers, body: reqBody } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const options = { method: method || 'GET', headers: { 'User-Agent': 'Mozilla/5.0', ...(headers || {}) }, timeout: 300000 };
    if (reqBody && method !== 'GET') options.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);
    const apiRes = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    const buf = await apiRes.arrayBuffer();
    res.status(apiRes.status).type(apiRes.headers.get('content-type') || 'application/octet-stream').send(Buffer.from(buf));
  } catch(e) {
    res.status(500).send('Proxy error: ' + e.message);
  }
});

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/proxy', async (req, res) => {
  const { url, apiKey, model, messages, maxTokens } = req.body;
  if (!url || !apiKey || !model || !messages) {
    return res.status(400).json({ error: 'Missing required fields: url, apiKey, model, messages' });
  }

  let base = url.replace(/\/+$/, '');
  const v1m = base.match(/(\/v1)\/?$/i);
  base = v1m ? base.slice(0, -v1m[0].length) + '/v1' : base + '/v1';
  const targetUrl = base + '/chat/completions';
  console.log('Proxy URL:', targetUrl, 'Model:', model);
  const body = JSON.stringify({ model, messages, max_tokens: maxTokens || 1024, stream: false });

  try {
      const data = await new Promise((resolve, reject) => {
        const isHttps = targetUrl.startsWith('https://');
        const requester = isHttps ? https : http;
        const parsed = new URL(targetUrl);
        const req2 = requester.request({
          hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search, method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: 300000
        }, (res2) => {
        let chunks = [];
        res2.on('data', chunk => chunks.push(chunk));
        res2.on('error', e => reject({ status: 500, text: 'Response stream error: ' + e.message }));
        res2.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res2.statusCode !== 200) {
            console.log(`API error ${res2.statusCode}: ${text.substring(0, 300)}`);
            reject({ status: res2.statusCode, text });
            return;
          }
          try { resolve(JSON.parse(text)); }
          catch(e) { reject({ status: 500, text: 'Invalid JSON: ' + text.substring(0, 200) }); }
        });
      });
      req2.on('error', e => reject({ status: 500, text: e.message }));
      req2.on('timeout', () => { req2.destroy(); reject({ status: 500, text: 'Timeout' }); });
      req2.write(body);
      req2.end();
    });
    console.log(`API OK - choices:${data.choices?.length || 0} model:${data.model}`);
    res.json(data);
  } catch (err) {
    const status = err.status || 500;
    const text = err.text || err.message || 'Unknown error';
    console.error(`Proxy error ${status}: ${text.substring(0,200)}`);
    res.status(status).json({ error: text, status: status });
  }
});

app.post('/api/proxy-image', async (req, res) => {
  const { url, apiKey, model, prompt, n, size } = req.body;
  if (!url || !apiKey || !model || !prompt) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  let base = url.replace(/\/+$/, '');
  const v1m = base.match(/(\/v1)\/?$/i);
  base = v1m ? base.slice(0, -v1m[0].length) + '/v1' : base + '/v1';
  const targetUrl = base + '/images/generations';
  const body = JSON.stringify({ model, prompt, n: n || 1, size: size || '1024x1024' });
  try {
    const data = await new Promise((resolve, reject) => {
      const isHttps = targetUrl.startsWith('https://');
      const requester = isHttps ? https : http;
      const parsed = new URL(targetUrl);
      const req2 = requester.request({
        hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) },
        timeout: 300000
      }, (res2) => {
        let chunks = [];
        res2.on('data', c => chunks.push(c));
        res2.on('error', e => reject({ status: 500, text: 'Response stream error: ' + e.message }));
        res2.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res2.statusCode !== 200) { reject({ status: res2.statusCode, text }); return; }
          try { resolve(JSON.parse(text)); } catch(e) { reject({ status: 500, text: 'Invalid JSON' }); }
        });
      });
      req2.on('error', e => reject({ status: 500, text: e.message }));
      req2.on('timeout', () => { req2.destroy(); reject({ status: 500, text: 'Timeout' }); });
      req2.write(body); req2.end();
    });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.text || err.message });
  }
});

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason?.message || reason);
});

app.listen(PORT, () => {
  console.log(`Proxy server running at http://localhost:${PORT}`);
  console.log(`Frontend should use: http://localhost:${PORT}/api/proxy`);
});

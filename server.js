const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const zlib = require('zlib');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname), { index: 'index.html' }));

app.get('/api/image-proxy', (req, res) => {
  const imgUrl = req.query.url;
  if (!imgUrl) return res.status(400).json({error:'Missing url'});
  const curlPath = process.env.WINDIR + '\\System32\\curl.exe';
  const child = spawn(curlPath, ['-s', '-L', imgUrl], { timeout: 30000, windowsHide: true });
  const chunks = [];
  child.stdout.on('data', c => chunks.push(c));
  child.stdout.on('end', () => { res.set('Cache-Control', 'public, max-age=3600'); res.send(Buffer.concat(chunks)); });
  child.on('error', e => res.status(500).send('Proxy error: ' + e.message));
  child.on('exit', code => { if (code !== 0 && chunks.length === 0) res.status(500).send('Proxy failed: ' + code); });
});

// Free image hosting upload
app.post('/api/upload', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  try {
    const b64 = req.body.toString('base64');
    const formData = `key=6d207e02198a847aa98d0a2a901485a5&source=${encodeURIComponent(b64)}&format=json`;
    const result = await new Promise((resolve, reject) => {
      const r = https.request('https://freeimage.host/api/1/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formData) },
        timeout: 30000
      }, (res2) => {
        let d = []; res2.on('data', c => d.push(c));
        res2.on('end', () => {
          const t = Buffer.concat(d).toString();
          if (res2.statusCode !== 200) return reject({ status: res2.statusCode, text: t });
          try { resolve(JSON.parse(t)); } catch(e) { reject({ status: 500, text: t }); }
        });
      });
      r.on('error', e => reject({ status: 500, text: e.message }));
      r.write(formData); r.end();
    });
    const url = result?.image?.url?.replace(/\\\//g, '/');
    if (url) res.json({ url });
    else res.status(500).json({ error: 'Upload failed', detail: result });
  } catch(e) { res.status(500).json({ error: e.text || e.message }); }
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
  const body = JSON.stringify({ model, messages, max_tokens: maxTokens || 1024 });

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

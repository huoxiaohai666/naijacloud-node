#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');
const net = require('net');

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 8080);
const XRAY_PORT = PORT + 1000 < 65535 ? PORT + 1000 : PORT - 1000;
const UUID = process.env.UUID || '8bd8f357-2019-43d7-9a82-5f218cc038c4';
const RAW_PATH = process.env.WS_PATH || '/app-ws';
const WS_PATH = RAW_PATH.startsWith('/') ? RAW_PATH : `/${RAW_PATH}`;

const HERE = __dirname;
const XRAY_BIN = path.join(HERE, 'xray');
const CONFIG_PATH = path.join(HERE, 'xray-config.json');
const ZIP_PATH = path.join(HERE, 'xray-download.zip');

const XRAY_ZIP_URL =
  process.env.XRAY_ZIP_URL ||
  'https://github.com/XTLS/Xray-core/releases/download/v26.10.21/Xray-linux-64.zip';

function die(msg) {
  console.error(`[wispbyte-ws] FATAL: ${msg}`);
  process.exit(1);
}

function buildConfig() {
  return {
    log: { loglevel: process.env.XRAY_LOGLEVEL || 'info' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: XRAY_PORT,
        protocol: 'vless',
        settings: {
          clients: [{ id: UUID, email: 'naijacloud-ws' }],
          decryption: 'none',
        },
        streamSettings: {
          network: 'ws',
          security: 'none',
          wsSettings: {
            path: WS_PATH,
          },
        },
        sniffing: {
          enabled: true,
          destOverride: ['http', 'tls', 'quic'],
        },
      },
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
  };
}

function fetchToFile(url, dest, redirectsLeft) {
  const left = redirectsLeft == null ? 5 : redirectsLeft;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        timeout: 120000,
        headers: { 'User-Agent': 'wispbyte-xray-ws-skill/1.0' },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return reject(new Error('too many redirects'));
          return fetchToFile(res.headers.location, dest, left - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`download HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('download timeout')));
  });
}

/** Minimal ZIP reader: find local-file entry named `xray` (basename match) and inflate. */
function extractXrayFromZip(zipBuf, destPath) {
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
  let offset = 0;
  while (offset + 30 <= zipBuf.length) {
    const i = zipBuf.indexOf(sig, offset);
    if (i < 0) break;
    const compression = zipBuf.readUInt16LE(i + 8);
    const compSize = zipBuf.readUInt32LE(i + 18);
    const uncompSize = zipBuf.readUInt32LE(i + 22);
    const nameLen = zipBuf.readUInt16LE(i + 26);
    const extraLen = zipBuf.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd + extraLen + compSize > zipBuf.length) {
      offset = i + 4;
      continue;
    }
    const name = zipBuf.slice(nameStart, nameEnd).toString('utf8');
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + compSize;
    const base = name.split('/').pop();
    if (base === 'xray') {
      const compressed = zipBuf.slice(dataStart, dataEnd);
      let raw;
      if (compression === 0) {
        raw = compressed;
      } else if (compression === 8) {
        raw = zlib.inflateRawSync(compressed);
      } else {
        throw new Error(`unsupported ZIP compression ${compression} for ${name}`);
      }
      if (uncompSize && raw.length !== uncompSize) {
        if (uncompSize > 0 && Math.abs(raw.length - uncompSize) > 0) {
          console.warn(
            `[wispbyte-ws] size note: inflated=${raw.length} header=${uncompSize} for ${name}`
          );
        }
      }
      fs.writeFileSync(destPath, raw);
      fs.chmodSync(destPath, 0o755);
      return raw.length;
    }
    offset = dataEnd;
  }
  throw new Error('xray entry not found in zip');
}

async function downloadWithRetry(url, dest, attempts) {
  let last;
  for (let n = 1; n <= attempts; n++) {
    try {
      console.log(`downloading xray-core, attempt ${n}`);
      await fetchToFile(url, dest);
      return;
    } catch (e) {
      last = e;
      console.error(`[wispbyte-ws] download failed attempt ${n}: ${e.message}`);
      try {
        fs.unlinkSync(dest);
      } catch (_) {}
    }
  }
  throw last || new Error('download failed');
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) {
    try {
      fs.chmodSync(XRAY_BIN, 0o755);
    } catch (_) {}
    const st = fs.statSync(XRAY_BIN);
    if (st.size > 1000000) {
      console.log(`[wispbyte-ws] reusing cached xray, bytes: ${st.size}`);
      return;
    }
  }

  await downloadWithRetry(XRAY_ZIP_URL, ZIP_PATH, 3);
  const zipBuf = fs.readFileSync(ZIP_PATH);
  const bytes = extractXrayFromZip(zipBuf, XRAY_BIN);
  console.log(`xray extracted, bytes: ${bytes}`);
  try {
    fs.unlinkSync(ZIP_PATH);
  } catch (_) {}
}

async function main() {
  if (!UUID || UUID === 'CHANGE_ME') {
    console.warn('[wispbyte-ws] WARNING: UUID is still CHANGE_ME — set env UUID before real use');
  }
  if (!Number.isFinite(PORT) || PORT <= 0) {
    die(`invalid PORT/SERVER_PORT: ${process.env.SERVER_PORT || process.env.PORT}`);
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(buildConfig(), null, 2));
  console.log(`starting xray on internal port ${XRAY_PORT} path ${WS_PATH}, front on ${PORT}`);

  // Front server: platform health check needs GET / -> 2xx; requests under
  // WS_PATH (XHTTP packet-up POST/GET) are reverse-proxied to internal xray.
  const front = http.createServer((req, res) => {
    if (req.url && req.url.startsWith(WS_PATH)) {
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: XRAY_PORT,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (up) => {
          console.log(`[front] ${req.method} ${req.url} -> ${up.statusCode}`);
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        }
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('bad gateway');
      });
      req.pipe(upstream);
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });

  front.on('upgrade', (req, socket, head) => {
    if (req.url && req.url.startsWith(WS_PATH)) {
      const upstream = net.connect(XRAY_PORT, '127.0.0.1', () => {
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
        for (const [k, v] of Object.entries(req.headers)) {
          upstream.write(`${k}: ${v}\r\n`);
        }
        upstream.write('\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    } else {
      socket.destroy();
    }
  });
  await new Promise((resolve) => front.listen(PORT, '0.0.0.0', resolve));
  console.log(`front server listening on ${PORT}`);

  await ensureXray();

  const child = spawn(XRAY_BIN, ['run', '-c', CONFIG_PATH], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    console.error(`[wispbyte-ws] xray exited code=${code} signal=${signal}`);
    process.exit(code || 1);
  });

  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
}

main().catch((err) => die(err.stack || err.message));

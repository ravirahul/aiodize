// Favicons for project URLs, fetched from the site itself and cached in data/favicons.
// Refuses private/loopback addresses (also on every redirect), so a note can't make Aiodize probe the LAN.
'use strict';
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const DIR = path.join(__dirname, '..', 'data', 'favicons');
const INDEX = path.join(DIR, 'index.json');
fs.mkdirSync(DIR, { recursive: true });
let index = {}; try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch {}
const saveIndex = () => fs.writeFileSync(INDEX, JSON.stringify(index, null, 1));
const RETRY = 864e5; // failed hosts are retried after a day

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:') && privateIp(v.slice(7));
}
async function publicUrl(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http');
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('private address');
  return url;
}
// GET with manual redirects (each hop re-checked), a timeout and a size cap.
async function get(u, max) {
  for (let hop = 0; hop < 4; hop++) {
    const url = await publicUrl(u);
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Aiodize/0.7 (favicon)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), url).href; continue; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > max) throw new Error('too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Error('too large');
    return { buf, type: (res.headers.get('content-type') || '').split(';')[0].trim(), url: url.href };
  }
  throw new Error('too many redirects');
}

function pickIcon(html, base) {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]);
  const cands = [];
  for (const l of links) {
    const rel = (/rel\s*=\s*["']([^"']+)["']/i.exec(l) || [])[1] || '';
    const href = (/href\s*=\s*["']([^"']+)["']/i.exec(l) || [])[1];
    if (!href || !/\bicon\b/i.test(rel)) continue;
    const size = parseInt((/sizes\s*=\s*["'](\d+)/i.exec(l) || [])[1] || (/apple-touch/i.test(rel) ? 180 : 32), 10);
    cands.push({ href: new URL(href, base).href, score: (size >= 32 && size <= 256 ? 1000 : 0) + Math.min(size, 256) + (/\.svg/i.test(href) ? 50 : 0) });
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.map(c => c.href).concat(new URL('/favicon.ico', base).href);
}

const inflight = new Map();
async function fetchIcon(siteUrl) {
  const host = new URL(siteUrl).hostname;
  const e = index[host];
  if (e && (e.file || Date.now() - e.ts < RETRY)) return e;
  if (inflight.has(host)) return inflight.get(host);
  const p = (async () => {
    let icons = [new URL('/favicon.ico', siteUrl).href];
    try { const page = await get(siteUrl, 1.5e6); if (/html/.test(page.type)) icons = pickIcon(page.buf.toString('utf8'), page.url); } catch {}
    for (const ic of icons) {
      try {
        const r = await get(ic, 400e3);
        const type = /^image\//.test(r.type) ? r.type : /\.ico$/i.test(ic) ? 'image/x-icon' : '';
        if (!type || r.buf.length < 60) continue;
        const ext = type.includes('svg') ? 'svg' : type.includes('png') ? 'png' : type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'ico';
        const file = host.replace(/[^a-z0-9.-]/gi, '_') + '.' + ext;
        fs.writeFileSync(path.join(DIR, file), r.buf);
        return (index[host] = { file, type, ts: Date.now() });
      } catch {}
    }
    return (index[host] = { file: '', ts: Date.now() });
  })().finally(() => { inflight.delete(host); saveIndex(); });
  inflight.set(host, p);
  return p;
}

function cached(host) {
  const e = index[host];
  if (!e || !e.file) return null;
  try { return { buf: fs.readFileSync(path.join(DIR, e.file)), type: e.type }; } catch { return null; }
}

const has = host => !!(index[host] && index[host].file);

module.exports = { fetchIcon, cached, has, privateIp };

// PlayAlong server: serves the app and keeps the songbook in one JSON file.
// No dependencies: Node's own http, fs and crypto modules only.
//
// Settings (Railway → service → Variables):
//   APP_PASSCODE  the passcode for the songbook. Without it the app opens but nothing can be read or saved.
//   PORT          set by Railway.
// Storage: attach a Railway volume (any mount path). Railway then sets RAILWAY_VOLUME_MOUNT_PATH and the
// songbook lives there. Without a volume, Railway wipes the files on every deploy, so the app says so.

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = VOLUME || process.env.DATA_DIR || path.join(ROOT, 'data');
const ON_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const PERSISTENT = !ON_RAILWAY || Boolean(VOLUME);
const PASSCODE = (process.env.APP_PASSCODE || '').trim();
const COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA || '';
const SONGS_FILE = path.join(DATA_DIR, 'songs.json');

const COOKIE = 'playalong_session';
const SESSION_DAYS = 180;
const MAX_BODY = 4 * 1024 * 1024;

/* ---------- the songbook ---------- */

const songs = new Map();
let storeError = '';
let writing = Promise.resolve();

async function loadSongs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(SONGS_FILE, 'utf8'));
    for (const s of saved.songs || []) if (s && validId(s.id)) songs.set(s.id, s);
  } catch (e) {
    // A file that exists but can't be read is left untouched, and saving is refused, so nothing overwrites it.
    if (e.code !== 'ENOENT') storeError = `The songbook file could not be read (${e.message}).`;
  }
}

// Write to a temporary file, then rename over the old one, so a crash mid-write never leaves half a file.
function saveSongs() {
  const snapshot = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), songs: [...songs.values()] });
  writing = writing.catch(() => {}).then(async () => {
    const tmp = `${SONGS_FILE}.tmp`;
    await fs.writeFile(tmp, snapshot);
    await fs.rename(tmp, SONGS_FILE);
  });
  return writing;
}

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);

const TEXT_LIMITS = { title: 200, artist: 200, key: 20, time: 20, notes: 5000, body: 100000 };
const NUMBER_FIELDS = ['capo', 'bpm', 'length', 'leadIn', 'outro', 'transpose', 'updatedAt'];

// Keep only the fields a song has, with sane types and sizes.
function cleanSong(input, base = {}) {
  const out = { ...base };
  for (const [k, max] of Object.entries(TEXT_LIMITS)) {
    if (k in input) out[k] = typeof input[k] === 'string' ? input[k].slice(0, max) : '';
  }
  for (const k of NUMBER_FIELDS) {
    if (k in input) out[k] = typeof input[k] === 'number' && Number.isFinite(input[k]) ? input[k] : null;
  }
  if ('example' in input) out.example = input.example === true;
  return out;
}

/* ---------- signing in ---------- */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sessionKey = () => crypto.createHmac('sha256', PASSCODE).update('playalong-session-v1').digest();
const sign = (value) => crypto.createHmac('sha256', sessionKey()).update(value).digest('base64url');
const sameBytes = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function newSession() {
  const expires = String(Date.now() + SESSION_DAYS * 864e5);
  return `${expires}.${sign(expires)}`;
}

// Changing APP_PASSCODE changes the signing key, which signs everyone out.
function signedIn(req) {
  if (!PASSCODE) return false;
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [expires, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!expires || !sig || !(Number(expires) > Date.now())) return false;
  return sameBytes(Buffer.from(sig), Buffer.from(sign(expires)));
}

function sessionCookie(req, value, maxAge) {
  const secure = ON_RAILWAY || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// After 8 wrong passcodes from one address, wait 15 minutes.
const attempts = new Map();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}
function lockedOut(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() > a.until) { attempts.delete(ip); return false; }
  return a.count >= 8;
}
function noteFailure(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() > a.until) attempts.set(ip, { count: 1, until: Date.now() + 15 * 60e3 });
  else a.count++;
}

/* ---------- http helpers ---------- */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(req) {
  // Saves must be JSON: a form posted from another site can't send that, which blocks cross-site writes.
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Send JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'That is too much to save at once.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'That request could not be read.');
  }
}

/* ---------- the API ---------- */

function requireWritable() {
  if (storeError) throw new HttpError(503, storeError);
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/session') {
    return send(res, 200, {
      signedIn: signedIn(req),
      passcodeSet: Boolean(PASSCODE),
      persistentStorage: PERSISTENT,
      storeError: storeError || null,
    });
  }

  if (route === 'POST /api/login') {
    const ip = clientIp(req);
    if (!PASSCODE) throw new HttpError(503, 'Set APP_PASSCODE in Railway first.');
    if (lockedOut(ip)) throw new HttpError(429, 'Too many wrong tries. Wait 15 minutes, then try again.');
    const { passcode } = await readJson(req);
    if (typeof passcode !== 'string' || !sameBytes(sha(passcode.trim()), sha(PASSCODE))) {
      noteFailure(ip);
      throw new HttpError(401, 'That passcode isn’t right.');
    }
    attempts.delete(ip);
    return send(res, 200, { signedIn: true }, { 'Set-Cookie': sessionCookie(req, newSession(), SESSION_DAYS * 86400) });
  }

  if (route === 'POST /api/logout') {
    return send(res, 200, { signedIn: false }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // Everything below needs the passcode.
  if (!signedIn(req)) throw new HttpError(401, 'Sign in first.');

  if (route === 'GET /api/songs') return send(res, 200, { songs: [...songs.values()] });

  if (route === 'GET /api/export') {
    const day = new Date().toISOString().slice(0, 10);
    return send(res, 200, { version: 1, exportedAt: new Date().toISOString(), songs: [...songs.values()] }, {
      'Content-Disposition': `attachment; filename="playalong-songs-${day}.json"`,
    });
  }

  if (route === 'POST /api/songs') {
    requireWritable();
    const song = cleanSong(await readJson(req), { id: crypto.randomUUID() });
    songs.set(song.id, song);
    await saveSongs();
    return send(res, 201, song);
  }

  // Bring in songs from an export, skipping any already here (same title and artist).
  if (route === 'POST /api/import') {
    requireWritable();
    const { songs: incoming } = await readJson(req);
    if (!Array.isArray(incoming)) throw new HttpError(400, 'That file has no songs in it.');
    const have = new Set([...songs.values()].map((s) => `${s.title}\u0001${s.artist}`.toLowerCase()));
    let added = 0, skipped = 0;
    for (const item of incoming) {
      if (!item || typeof item !== 'object' || typeof item.title !== 'string' || !item.title.trim()) { skipped++; continue; }
      const sig = `${item.title}\u0001${item.artist || ''}`.toLowerCase();
      if (have.has(sig)) { skipped++; continue; }
      const song = cleanSong(item, { id: crypto.randomUUID() });
      songs.set(song.id, song);
      have.add(sig);
      added++;
    }
    if (added) await saveSongs();
    return send(res, 200, { added, skipped });
  }

  const m = url.pathname.match(/^\/api\/songs\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!validId(id)) throw new HttpError(404, 'No such song.');
    if (req.method === 'GET') {
      if (!songs.has(id)) throw new HttpError(404, 'No such song.');
      return send(res, 200, songs.get(id));
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      requireWritable();
      if (req.method === 'PATCH' && !songs.has(id)) throw new HttpError(404, 'No such song.');
      const base = req.method === 'PATCH' ? songs.get(id) : { id };
      const song = cleanSong(await readJson(req), base);
      song.id = id;
      songs.set(id, song);
      await saveSongs();
      return send(res, 200, song);
    }
    if (req.method === 'DELETE') {
      requireWritable();
      songs.delete(id);
      await saveSongs();
      return send(res, 200, { deleted: id });
    }
  }

  throw new HttpError(404, 'Not found.');
}

/* ---------- static files ---------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gz': 'application/gzip', '.txt': 'text/plain; charset=utf-8',
};

async function staticFile(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Not allowed.');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Bad address.'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found.');
  let data;
  try { data = await fs.readFile(file); } catch { throw new HttpError(404, 'Not found.'); }
  const ext = path.extname(file);
  const cache = ext === '.html' ? 'no-cache' : rel.startsWith('/ocr/') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400';
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, 'Content-Length': data.length });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/* ---------- start ---------- */

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        return send(res, 200, { ok: true, commit: COMMIT || null, persistentStorage: PERSISTENT, storeError: storeError || null });
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return await staticFile(req, res, url);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Something went wrong on the server.' : e.message });
    }
  });
}

export async function start(port = PORT) {
  await loadSongs();
  const server = createServer();
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  console.log(`PlayAlong on port ${server.address().port}; songs in ${SONGS_FILE}` +
    `${PERSISTENT ? '' : ' (NOT permanent: attach a Railway volume)'}${PASSCODE ? '' : '; APP_PASSCODE is not set'}`);
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((e) => { console.error(e); process.exit(1); });
}

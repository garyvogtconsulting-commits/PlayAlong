// Starts the real server in a child process with a temporary songbook and drives it over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASSCODE = 'test-passcode-123';

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('PlayAlong on port')) resolve(); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { port, child, base: `http://127.0.0.1:${port}` };
}

let srv, dataDir;
before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'playalong-'));
  srv = await startServer({ APP_PASSCODE: PASSCODE, DATA_DIR: dataDir, RAILWAY_ENVIRONMENT: '', RAILWAY_PROJECT_ID: '', RAILWAY_VOLUME_MOUNT_PATH: '' });
});
after(async () => { srv.child.kill(); await rm(dataDir, { recursive: true, force: true }); });

const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function signIn() {
  const res = await fetch(`${srv.base}/api/login`, { method: 'POST', ...json({ passcode: PASSCODE }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

test('health check answers', async () => {
  const res = await fetch(`${srv.base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('serves the app and its language data', async () => {
  const page = await fetch(`${srv.base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>PlayAlong<\/title>/);
  const lang = await fetch(`${srv.base}/ocr/eng.traineddata.gz`, { method: 'HEAD' });
  assert.equal(lang.status, 200);
  assert.equal(lang.headers.get('content-type'), 'application/gzip');
});

test('songs are private until you sign in', async () => {
  assert.equal((await fetch(`${srv.base}/api/songs`)).status, 401);
  assert.equal((await fetch(`${srv.base}/api/export`)).status, 401);
  const session = await (await fetch(`${srv.base}/api/session`)).json();
  assert.deepEqual([session.signedIn, session.passcodeSet], [false, true]);
});

test('a wrong passcode is refused', async () => {
  const res = await fetch(`${srv.base}/api/login`, { method: 'POST', ...json({ passcode: 'nope' }) });
  assert.equal(res.status, 401);
});

test('save, change, list and delete a song', async () => {
  const cookie = await signIn();
  const h = { headers: { cookie, 'Content-Type': 'application/json' } };
  const made = await (await fetch(`${srv.base}/api/songs`, { method: 'POST', ...h, body: JSON.stringify({ title: 'Test Song', length: 200, body: '[G]Hello', junk: 'dropped' }) })).json();
  assert.ok(made.id);
  assert.equal(made.junk, undefined, 'unknown fields are dropped');

  const patched = await (await fetch(`${srv.base}/api/songs/${made.id}`, { method: 'PATCH', ...h, body: JSON.stringify({ transpose: 2 }) })).json();
  assert.deepEqual([patched.title, patched.transpose], ['Test Song', 2]);

  const replaced = await (await fetch(`${srv.base}/api/songs/${made.id}`, { method: 'PUT', ...h, body: JSON.stringify({ title: 'Renamed', length: 180 }) })).json();
  assert.deepEqual([replaced.title, replaced.body], ['Renamed', undefined], 'PUT replaces the whole song');

  const list = await (await fetch(`${srv.base}/api/songs`, h)).json();
  assert.equal(list.songs.length, 1);

  // it is really on disk
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'songs.json'), 'utf8'));
  assert.equal(onDisk.songs[0].title, 'Renamed');

  assert.equal((await fetch(`${srv.base}/api/songs/${made.id}`, { method: 'DELETE', ...h })).status, 200);
  assert.equal((await (await fetch(`${srv.base}/api/songs`, h)).json()).songs.length, 0);
});

test('backup and import, skipping songs already there', async () => {
  const cookie = await signIn();
  const h = { headers: { cookie, 'Content-Type': 'application/json' } };
  const songs = [{ title: 'One', artist: 'A', body: 'x' }, { title: 'Two', artist: 'B' }, { title: '' }];
  let r = await (await fetch(`${srv.base}/api/import`, { method: 'POST', ...h, body: JSON.stringify({ songs }) })).json();
  assert.deepEqual(r, { added: 2, skipped: 1 });
  r = await (await fetch(`${srv.base}/api/import`, { method: 'POST', ...h, body: JSON.stringify({ songs }) })).json();
  assert.deepEqual(r, { added: 0, skipped: 3 }, 're-importing adds nothing');
  const backup = await fetch(`${srv.base}/api/export`, h);
  assert.match(backup.headers.get('content-disposition'), /attachment; filename="playalong-songs-/);
  assert.equal((await backup.json()).songs.length, 2);
});

test('saves must be JSON, so another site cannot post a form', async () => {
  const cookie = await signIn();
  const res = await fetch(`${srv.base}/api/songs`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
  assert.equal(res.status, 415);
});

test('files outside the app folder cannot be read', async () => {
  for (const p of ['/../server.js', '/%2e%2e/server.js', '/..%2fpackage.json', '/ocr/../../server.js']) {
    const res = await fetch(`${srv.base}${p}`);
    assert.notEqual(res.status, 200, p);
  }
});

test('without a passcode set, nothing can be read or saved', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'playalong-'));
  const open = await startServer({ APP_PASSCODE: '', DATA_DIR: dir });
  try {
    const session = await (await fetch(`${open.base}/api/session`)).json();
    assert.equal(session.passcodeSet, false);
    assert.equal((await fetch(`${open.base}/api/songs`)).status, 401);
    assert.equal((await fetch(`${open.base}/api/login`, { method: 'POST', ...json({ passcode: '' }) })).status, 503);
  } finally { open.child.kill(); await rm(dir, { recursive: true, force: true }); }
});

test('on Railway without a volume, the app says songs are not permanent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'playalong-'));
  const rail = await startServer({ APP_PASSCODE: PASSCODE, DATA_DIR: dir, RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '' });
  try {
    const health = await (await fetch(`${rail.base}/healthz`)).json();
    assert.equal(health.persistentStorage, false);
  } finally { rail.child.kill(); await rm(dir, { recursive: true, force: true }); }
});

test('an unreadable songbook file is never overwritten', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'playalong-'));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(dir, 'songs.json'), '{ this is not json');
  const broken = await startServer({ APP_PASSCODE: PASSCODE, DATA_DIR: dir });
  try {
    const login = await fetch(`${broken.base}/api/login`, { method: 'POST', ...json({ passcode: PASSCODE }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const res = await fetch(`${broken.base}/api/songs`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"title":"x"}' });
    assert.equal(res.status, 503);
    assert.equal(await readFile(path.join(dir, 'songs.json'), 'utf8'), '{ this is not json');
  } finally { broken.child.kill(); await rm(dir, { recursive: true, force: true }); }
});

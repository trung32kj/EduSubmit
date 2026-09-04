/**
 * Kiểm thử tầng bảo mật: đăng nhập, CSRF, header, và các đường công khai.
 *
 * Dùng DB tạm trong thư mục temp — KHÔNG bao giờ đụng vào data/app.db thật.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baitap-sec-'));
process.env.APP_DATA = TMP;
process.env.NODE_ENV = 'test';

const { app } = await import('../server.js');
const auth = await import('../src/auth.js');
const dbmod = await import('../src/db.js');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dbmod.run(
    'INSERT INTO admins (username, password_hash, password_changed_at, created_at) VALUES (?, ?, 0, ?)',
    'admin',
    auth.hashPasswordSync('matkhau-that-dai'),
    Date.now(),
  );
});

after(() => {
  server?.close();
  dbmod.db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const J = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
const post = (url, body, headers = {}) =>
  fetch(base + url, { method: 'POST', headers: { ...J, ...headers }, body: JSON.stringify(body) });

/**
 * Xoá bộ đếm đăng nhập sai.
 *
 * Cơ chế khoá tạm là toàn cục theo (tên đăng nhập, IP), nên nếu không dọn thì
 * mỗi test dò mật khẩu sai sẽ làm các test sau bị 429 — lỗi dây chuyền chứ không
 * phải lỗi thật.
 */
const clearLockouts = () => dbmod.run('DELETE FROM login_attempts');

const loginOk = async () => {
  clearLockouts();
  const res = await post('/api/admin/login', { username: 'admin', password: 'matkhau-that-dai' });
  assert.equal(res.status, 200);
  return res;
};

// ------------------------------------------------------------ mật khẩu

test('chuỗi hash hỏng KHÔNG cho qua mọi mật khẩu', async () => {
  // Base64 rỗng và base64 rác đều cho buffer dài 0; scrypt keylen 0 trả buffer
  // dài 0 và timingSafeEqual(rỗng, rỗng) = true -> mọi mật khẩu đều "đúng".
  const salt = Buffer.from('saltsaltsalt').toString('base64');
  for (const bad of [
    `scrypt$32768$8$1$${salt}$`,
    `scrypt$32768$8$1$${salt}$!!!!`,
    `scrypt$1$1$1$${salt}$${salt}`, // params bị hạ xuống cho nhanh
    'scrypt$32768$8$1$$',
    'khong-phai-hash',
    '',
    null,
    undefined,
  ]) {
    assert.equal(await auth.verifyPassword('bất kỳ', bad), false, `phải chặn: ${bad}`);
  }
});

test('mật khẩu đúng thì vẫn qua, sai thì không', async () => {
  const h = auth.hashPasswordSync('matkhau-cua-toi');
  assert.equal(await auth.verifyPassword('matkhau-cua-toi', h), true);
  assert.equal(await auth.verifyPassword('matkhau-cua-t0i', h), false);
});

test('tên đăng nhập sai và đúng mất thời gian tương đương', async () => {
  // Không có hash giả thì user không tồn tại trả lời tức thì còn user thật mất
  // ~80ms — chênh đủ để dò ra tên đăng nhập bằng một request.
  const time = async (username) => {
    clearLockouts();
    const t = process.hrtime.bigint();
    await post('/api/admin/login', { username, password: 'sai' });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const real = await time('admin');
  const fake = await time('khong-ton-tai-' + Math.random());
  const ratio = Math.max(real, fake) / Math.min(real, fake);
  assert.ok(ratio < 3, `chênh lệch quá lớn: ${real.toFixed(0)}ms vs ${fake.toFixed(0)}ms`);
  clearLockouts();
});

// ------------------------------------------------------------ CSRF

test('request từ site khác bị chặn, cùng nguồn thì không', async () => {
  const body = { username: 'admin', password: 'matkhau-that-dai' };
  clearLockouts();

  // SameSite=Lax chặn cross-site, nhưng "site" bỏ qua số cổng: localhost:8080 là
  // cùng site với localhost:3000. Sec-Fetch-Site mới phân biệt được.
  const crossSite = await post('/api/admin/login', body, { 'sec-fetch-site': 'same-site' });
  assert.equal(crossSite.status, 403);

  const crossOrigin = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
    body: JSON.stringify(body),
  });
  assert.equal(crossOrigin.status, 403);

  const ok = await post('/api/admin/login', body);
  assert.equal(ok.status, 200);
});

// ------------------------------------------------------------ headers

test('có đủ header bảo mật', async () => {
  const res = await fetch(base + '/login.html');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('không còn script/handler inline nào trong HTML (CSP script-src self)', () => {
  // CSP không dùng nonce được vì HTML do express.static phục vụ; nên mọi script
  // phải nằm ở file riêng.
  const dir = path.join(import.meta.dirname, '..', 'public');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, `${name} còn inline script`);
    assert.doesNotMatch(html, /\son(click|load|error|submit|change)=/i, `${name} còn inline handler`);
  }
});

// ------------------------------------------------------------ khoá đăng nhập

test('sai nhiều lần thì bị khoá tạm, và mốc khoá lưu trong DB', async () => {
  clearLockouts();
  const u = 'admin';
  for (let i = 0; i < 6; i++) {
    await post('/api/admin/login', { username: u, password: 'sai' });
  }
  const locked = await post('/api/admin/login', { username: u, password: 'matkhau-that-dai' });
  assert.equal(locked.status, 429);
  assert.match((await locked.json()).error, /Thử lại sau/);

  // Ghi vào DB chứ không chỉ trong RAM: nếu chỉ RAM thì restart server là reset.
  const row = dbmod.get('SELECT fails FROM login_attempts ORDER BY fails DESC LIMIT 1');
  assert.ok(row && row.fails >= 6, `fails = ${row?.fails}`);

  clearLockouts();
});

// ------------------------------------------------ session và đổi mật khẩu

test('đổi mật khẩu làm mất hiệu lực phiên đang đăng nhập', async () => {
  const login = await loginOk();
  const cookie = login.headers.getSetCookie()[0].split(';')[0];

  const before = await fetch(base + '/api/admin/students', { headers: { cookie } });
  assert.equal(before.status, 200);

  // Không kiểm mốc này thì bị chiếm tài khoản, đổi mật khẩu vẫn không đá kẻ kia
  // ra được vì cookie còn dùng tiếp 30 ngày.
  dbmod.run('UPDATE admins SET password_changed_at = ? WHERE username = ?', Date.now() + 1000, 'admin');
  const after = await fetch(base + '/api/admin/students', { headers: { cookie } });
  assert.equal(after.status, 401);

  dbmod.run('UPDATE admins SET password_changed_at = 0 WHERE username = ?', 'admin');
});

test('id phiên được cấp mới sau khi đăng nhập', async () => {
  const first = await loginOk();
  const second = await loginOk();
  const sid = (r) => r.headers.getSetCookie()[0].split(';')[0];
  assert.notEqual(sid(first), sid(second));
});

test('__secret__ không bị coi là phiên và không bị ghi đè', async () => {
  const store = new auth.SqliteStore();
  const before = dbmod.get('SELECT data FROM sessions WHERE sid = ?', auth.SECRET_SID);
  assert.ok(before, 'phải có hàng secret');

  await new Promise((r) => store.set(auth.SECRET_SID, { cookie: {}, adminId: 99 }, r));
  const after = dbmod.get('SELECT data FROM sessions WHERE sid = ?', auth.SECRET_SID);
  assert.equal(after.data, before.data, 'khoá ký cookie bị ghi đè');

  const asSession = await new Promise((r) => store.get(auth.SECRET_SID, (e, s) => r(s)));
  assert.equal(asSession, null);
});

// ------------------------------------------------ đường công khai

test('phải đăng nhập mới xem được API admin và ảnh', async () => {
  for (const url of ['/api/admin/students', '/api/admin/assignments', '/files/1', '/api/admin/storage']) {
    const res = await fetch(base + url);
    assert.equal(res.status, 401, url);
  }
});

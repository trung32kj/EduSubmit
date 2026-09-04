/**
 * Mã PIN cho từng bài tập, và việc chạy sau tunnel/proxy.
 *
 * Khi web mở ra internet, link nộp bài chỉ là một chuỗi: ai có nó là nộp được.
 * PIN là thứ chỉ người trong lớp biết.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baitap-pin-'));
process.env.APP_DATA = TMP;
process.env.NODE_ENV = 'test';

const { app } = await import('../server.js');
const auth = await import('../src/auth.js');
const dbmod = await import('../src/db.js');

let server;
let base;
let cookie;
let clsId;

const jpeg = (seed, size = 300) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
    Buffer.alloc(size, seed),
    Buffer.from([0xff, 0xd9]),
  ]);

const H = () => ({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie });
const post = async (url, body) => {
  const res = await fetch(base + url, { method: 'POST', headers: H(), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const getJ = async (url) => (await fetch(base + url, { headers: H() })).json();

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
  const res = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ username: 'admin', password: 'matkhau-that-dai' }),
  });
  cookie = res.headers.getSetCookie()[0].split(';')[0];

  clsId = (await post('/api/admin/classes', { name: 'Lớp PIN' })).body.class.id;
  await post('/api/admin/students/import', { classId: clsId, text: 'Đỗ Đình Đạt\nTrần Tường Vy' });
});

after(() => {
  server?.close();
  dbmod.db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

/**
 * Nộp bài như học viên. jar giữ cookie session để mô phỏng cùng một trình duyệt.
 *
 * PIN gửi qua header x-pin, giống trang nộp thật: server kiểm PIN trước khi bóc
 * multipart nên không đọc được PIN từ body.
 */
async function submitAs(slug, studentId, buf, { pin, jar } = {}) {
  const fd = new FormData();
  fd.append('studentId', String(studentId));
  fd.append(`f_${studentId}_0`, new Blob([buf], { type: 'image/jpeg' }), 'anh.jpg');
  const headers = { 'sec-fetch-site': 'same-origin' };
  if (pin !== undefined) headers['x-pin'] = pin;
  if (jar?.cookie) headers.cookie = jar.cookie;
  const res = await fetch(base + `/api/public/a/${slug}/submit`, { method: 'POST', headers, body: fd });
  const sc = res.headers.getSetCookie()?.[0];
  if (jar && sc) jar.cookie = sc.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

const search = (slug, q, pin) => {
  const qs = new URLSearchParams({ q });
  if (pin !== undefined) qs.set('pin', pin);
  return fetch(base + `/api/public/a/${slug}/students?${qs}`);
};

test('bài tập không có PIN thì nộp như cũ, và API công khai nói needsPin = false', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Không PIN', classId: clsId })).body.assignment;
  assert.equal(a.pin, null);

  const meta = await (await fetch(base + `/api/public/a/${a.slug}`)).json();
  assert.equal(meta.assignment.needsPin, false);

  const st = (await getJ(`/api/admin/students?classId=${clsId}`)).students[0];
  assert.equal((await submitAs(a.slug, st.id, jpeg(1))).status, 200);
});

test('bật PIN: sai hoặc thiếu PIN thì không nộp được, đúng PIN thì nộp được', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Có PIN', classId: clsId, pin: true }))
    .body.assignment;
  assert.match(a.pin, /^\d{4}$/, 'PIN tự sinh là 4 chữ số');

  // API công khai chỉ nói CÓ cần PIN, không bao giờ trả giá trị PIN.
  const meta = await (await fetch(base + `/api/public/a/${a.slug}`)).json();
  assert.equal(meta.assignment.needsPin, true);
  assert.equal(meta.assignment.pin, undefined, 'KHÔNG được lộ PIN cho học viên');

  const st = (await getJ(`/api/admin/students?classId=${clsId}`)).students[0];

  const noPin = await submitAs(a.slug, st.id, jpeg(2));
  assert.equal(noPin.status, 401);
  assert.match(noPin.body.error, /PIN/);

  const wrong = await submitAs(a.slug, st.id, jpeg(3), { pin: '0000' === a.pin ? '1111' : '0000' });
  assert.equal(wrong.status, 401);

  assert.equal((await submitAs(a.slug, st.id, jpeg(4), { pin: a.pin })).status, 200);
});

test('có PIN thì cũng không tra được tên — danh sách lớp là thứ PIN cần bảo vệ', async () => {
  const a = (await post('/api/admin/assignments', { title: 'PIN chắn tra tên', classId: clsId, pin: true }))
    .body.assignment;

  const noPin = await search(a.slug, 'do dinh');
  assert.equal(noPin.status, 401, 'không có PIN thì không dò được danh sách lớp');

  const withPin = await search(a.slug, 'do dinh', a.pin);
  assert.equal(withPin.status, 200);
  assert.equal((await withPin.json()).students.length, 1);
});

test('PIN đúng một lần thì nhớ trong session, không phải gõ lại', async () => {
  const a = (await post('/api/admin/assignments', { title: 'PIN nhớ', classId: clsId, pin: true }))
    .body.assignment;
  const st = (await getJ(`/api/admin/students?classId=${clsId}`)).students;

  const jar = {};
  // Bước xác nhận PIN riêng (trang nộp gọi trước khi cho chọn ảnh).
  const check = await fetch(base + `/api/public/a/${a.slug}/pin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ pin: a.pin }),
  });
  assert.equal(check.status, 200);
  jar.cookie = check.headers.getSetCookie()[0].split(';')[0];

  // Lần nộp sau KHÔNG gửi PIN nữa mà vẫn phải được.
  assert.equal((await submitAs(a.slug, st[0].id, jpeg(5), { jar })).status, 200);
  assert.equal((await submitAs(a.slug, st[1].id, jpeg(6), { jar })).status, 200);
});

test('dò PIN bị chặn sau nhiều lần sai', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Chống dò PIN', classId: clsId, pin: true }))
    .body.assignment;
  const st = (await getJ(`/api/admin/students?classId=${clsId}`)).students[0];

  // 4 chữ số chỉ có 10.000 khả năng — không giới hạn thì thử hết trong vài phút.
  let blocked = false;
  for (let i = 0; i < 15; i++) {
    const r = await submitAs(a.slug, st.id, jpeg(7), { pin: String(9000 + i) });
    if (r.status === 429) {
      blocked = true;
      break;
    }
  }
  assert.ok(blocked, 'phải bị chặn trước khi dò xong');
});

test('bật / tắt / đổi PIN từ trang admin', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Đổi PIN', classId: clsId })).body.assignment;
  assert.equal(a.pin, null);

  const on = await post(`/api/admin/assignments/${a.id}/pin`, { action: 'on' });
  assert.match(on.body.assignment.pin, /^\d{4}$/);

  const renewed = await post(`/api/admin/assignments/${a.id}/pin`, { action: 'on' });
  assert.notEqual(renewed.body.assignment.pin, on.body.assignment.pin, 'đổi mã ra mã khác');

  const off = await post(`/api/admin/assignments/${a.id}/pin`, { action: 'off' });
  assert.equal(off.body.assignment.pin, null);

  // Đặt tay, và chặn giá trị không hợp lệ.
  const set = await post(`/api/admin/assignments/${a.id}/pin`, { action: 'set', pin: '246810' });
  assert.equal(set.body.assignment.pin, '246810');
  for (const bad of ['12', 'abcd', '1234567', '12a4']) {
    const r = await post(`/api/admin/assignments/${a.id}/pin`, { action: 'set', pin: bad });
    assert.equal(r.status, 400, `PIN "${bad}" phải bị chặn`);
  }
});

test('sửa bài tập mà không nhắc tới pin thì KHÔNG đổi mã đang dùng', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Giữ PIN', classId: clsId, pin: true }))
    .body.assignment;
  const res = await fetch(base + `/api/admin/assignments/${a.id}`, {
    method: 'PATCH',
    headers: H(),
    body: JSON.stringify({ title: 'Đổi tên thôi' }),
  });
  const updated = (await res.json()).assignment;
  assert.equal(updated.title, 'Đổi tên thôi');
  assert.equal(updated.pin, a.pin, 'PIN phải giữ nguyên');
});

test('endpoint link nói rõ link dùng được ở đâu, và trả PIN cho admin', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Link', classId: clsId, pin: true }))
    .body.assignment;
  const info = await getJ(`/api/admin/assignments/${a.id}/link`);
  assert.equal(info.pin, a.pin, 'admin ĐƯỢC xem PIN để đọc cho lớp');
  // Chưa đặt BASE_URL -> vẫn là chế độ LAN, có gợi ý IP.
  assert.equal(info.publicUrl, null);
  assert.ok(Array.isArray(info.lanUrls));
});

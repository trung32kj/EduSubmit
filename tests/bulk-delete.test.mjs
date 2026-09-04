/**
 * Chọn nhiều học viên rồi xoá một lượt.
 *
 * Quy tắc quan trọng: bạn đã nộp bài thì CHỈ ẩn (bài nộp và ảnh giữ nguyên),
 * bạn chưa nộp gì thì xoá hẳn — giống hệt đường xoá lẻ, không được khác.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baitap-bulkdel-'));
process.env.APP_DATA = TMP;
process.env.NODE_ENV = 'test';

const { app } = await import('../server.js');
const auth = await import('../src/auth.js');
const dbmod = await import('../src/db.js');

let server;
let base;
let cookie;

const jpeg = (seed, size = 512) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
    Buffer.alloc(size, seed),
    Buffer.from([0xff, 0xd9]),
  ]);

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
});

after(() => {
  server?.close();
  dbmod.db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const H = () => ({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie });
const post = async (url, body) => {
  const res = await fetch(base + url, { method: 'POST', headers: H(), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const getJ = async (url) => (await fetch(base + url, { headers: H() })).json();

async function submitAs(slug, studentId, buf) {
  const fd = new FormData();
  fd.append('studentId', String(studentId));
  fd.append(`f_${studentId}_0`, new Blob([buf], { type: 'image/jpeg' }), 'anh.jpg');
  const res = await fetch(base + `/api/public/a/${slug}/submit`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: fd,
  });
  return res.status;
}

test('bạn chưa nộp bài thì xoá hẳn, bạn đã nộp thì chỉ ẩn', async () => {
  const cls = (await post('/api/admin/classes', { name: 'Lớp Xoá' })).body.class;
  await post('/api/admin/students/import', {
    classId: cls.id,
    text: 'Vũ Minh Quân\nĐặng Thị Hương\nĐỗ Đình Đạt',
  });
  const st = (await getJ(`/api/admin/students?classId=${cls.id}`)).students;
  const daNop = st.find((s) => s.name === 'Đỗ Đình Đạt');

  const asg = (await post('/api/admin/assignments', { title: 'BT', classId: cls.id })).body.assignment;
  const { slug } = await getJ(`/api/admin/assignments/${asg.id}/link`);
  assert.equal(await submitAs(slug, daNop.id, jpeg(3)), 200);

  const r = await post('/api/admin/students/bulk-delete', { ids: st.map((s) => s.id) });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, 2, 'hai bạn chưa nộp bị xoá hẳn');
  assert.equal(r.body.hidden, 1, 'bạn đã nộp chỉ bị ẩn');

  const all = (await getJ('/api/admin/students?all=1')).students;
  const names = all.map((s) => s.name);
  assert.ok(names.includes('Đỗ Đình Đạt'), 'bạn đã nộp vẫn còn trong DB');
  assert.ok(!names.includes('Vũ Minh Quân'), 'bạn chưa nộp đã bị xoá hẳn');
  assert.equal(all.find((s) => s.name === 'Đỗ Đình Đạt').isActive, false);

  // Ảnh của bạn bị ẩn KHÔNG được mất — đó chính là lý do phải ẩn thay vì xoá.
  const ov = await getJ(`/api/admin/assignments/${asg.id}/overview`);
  assert.equal(ov.orphans.length, 1, 'bài nộp của bạn bị ẩn vẫn thấy được');
  assert.equal(ov.orphans[0].imageCount, 1, 'ảnh vẫn còn nguyên');
});

test('id trùng lặp và id không tồn tại không làm sai kết quả', async () => {
  const cls = (await post('/api/admin/classes', { name: 'Lớp Trùng Id' })).body.class;
  await post('/api/admin/students/import', { classId: cls.id, text: 'Lê Thị Bình' });
  const st = (await getJ(`/api/admin/students?classId=${cls.id}`)).students[0];

  const r = await post('/api/admin/students/bulk-delete', { ids: [st.id, st.id, st.id, 999999] });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, 1, 'id trùng chỉ tính một lần');
  assert.equal(r.body.notFound, 1, 'báo lại id không tồn tại');
});

test('dữ liệu vào không hợp lệ bị chặn bằng 400, không phải 500', async () => {
  for (const ids of [undefined, [], 'khong-phai-mang', { a: 1 }, ['abc', null, -1, 0]]) {
    const r = await post('/api/admin/students/bulk-delete', { ids });
    assert.equal(r.status, 400, `ids = ${JSON.stringify(ids)} phải bị chặn`);
    assert.ok(r.body.error, 'phải có thông báo lỗi');
  }
  const tooMany = await post('/api/admin/students/bulk-delete', {
    ids: Array.from({ length: 501 }, (_, i) => i + 1),
  });
  assert.equal(tooMany.status, 400, 'quá 500 id thì chặn');
});

test('cần đăng nhập mới xoá được', async () => {
  const res = await fetch(base + '/api/admin/students/bulk-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ ids: [1] }),
  });
  assert.equal(res.status, 401);
});

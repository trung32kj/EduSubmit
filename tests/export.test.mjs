/**
 * Xuất ảnh ra file ZIP: lọc theo trạng thái, chỉ lấy lần nộp mới nhất, và endpoint
 * đếm trước để nút hiện được số ảnh + dung lượng.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baitap-zip-'));
process.env.APP_DATA = TMP;
process.env.NODE_ENV = 'test';

const { app } = await import('../server.js');
const auth = await import('../src/auth.js');
const dbmod = await import('../src/db.js');

let server;
let base;
let cookie;

const jpeg = (seed, size = 400) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
    Buffer.alloc(size, seed),
    Buffer.from([0xff, 0xd9]),
  ]);

let asg;
let slug;
let students;

// Một before duy nhất: hai hook before riêng biệt không đảm bảo thứ tự, hook thứ
// hai đã chạy khi `base` còn chưa được đặt.
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

  const cls = (await post('/api/admin/classes', { name: 'Lớp ZIP' })).class;
  await post('/api/admin/students/import', {
    classId: cls.id,
    text: 'Đỗ Đình Đạt\nTrần Tường Vy, STT 07\nLê Thị Bình\nVũ Minh Quân',
  });
  students = (await getJ(`/api/admin/students?classId=${cls.id}`)).students;
  asg = (await post('/api/admin/assignments', { title: 'Bài tập tuần 1', classId: cls.id })).assignment;
  slug = (await getJ(`/api/admin/assignments/${asg.id}/link`)).slug;

  // Đạt: 1 ảnh, duyệt đạt. Vy: nộp 2 lần, bị từ chối. Bình: chờ duyệt. Quân: chưa nộp.
  const byName = Object.fromEntries(students.map((s) => [s.name, s]));
  await submitAs(slug, byName['Đỗ Đình Đạt'].id, jpeg(1));
  await submitAs(slug, byName['Trần Tường Vy'].id, jpeg(2));
  await submitAs(slug, byName['Trần Tường Vy'].id, jpeg(3));
  await submitAs(slug, byName['Lê Thị Bình'].id, jpeg(4));

  const ov = await getJ(`/api/admin/assignments/${asg.id}/overview`);
  const subOf = Object.fromEntries(ov.students.map((s) => [s.name, s.submissionId]));
  await patch(`/api/admin/submissions/${subOf['Đỗ Đình Đạt']}`, { status: 'approved' });
  await patch(`/api/admin/submissions/${subOf['Trần Tường Vy']}`, { status: 'rejected' });
});

after(() => {
  server?.close();
  dbmod.db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const H = () => ({ 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie });
const post = async (url, body) =>
  (await fetch(base + url, { method: 'POST', headers: H(), body: JSON.stringify(body) })).json();
const getJ = async (url) => (await fetch(base + url, { headers: H() })).json();
const patch = (url, body) =>
  fetch(base + url, { method: 'PATCH', headers: H(), body: JSON.stringify(body) });

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

/** Đọc tên các entry trong ZIP bằng Python (có sẵn trên máy), để kiểm thật. */
function zipEntries(buf) {
  const p = path.join(TMP, 'out.zip');
  fs.writeFileSync(p, buf);
  const out = execFileSync('python', [
    '-c',
    'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({"bad":z.testzip(),"names":z.namelist()}))',
    p,
  ]);
  return JSON.parse(out.toString());
}


test('export-info đếm đúng, tách theo trạng thái và theo lần nộp', async () => {
  const info = await getJ(`/api/admin/assignments/${asg.id}/export-info`);
  assert.equal(info.total, 4, '4 ảnh đã nộp (Vy nộp 2 lần)');
  assert.equal(info.latestTotal, 3, 'chỉ lần nộp mới nhất thì Vy còn 1 ảnh');
  assert.equal(info.byStatus.approved.count, 1);
  assert.equal(info.byStatus.rejected.count, 2, 'Vy có 2 ảnh, cả hai đều thuộc bài bị từ chối');
  assert.equal(info.byStatus.rejected.latestCount, 1);
  assert.equal(info.byStatus.pending.count, 1);
  assert.ok(info.totalBytes > 0, 'có báo dung lượng để người dùng biết trước');
});

test('ZIP tải được, đọc được, tên file là tên học viên', async () => {
  const res = await fetch(base + `/api/admin/assignments/${asg.id}/export.zip`, { headers: H() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  // Tên file có dấu tiếng Việt phải đi qua filename*.
  assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/);

  const z = zipEntries(Buffer.from(await res.arrayBuffer()));
  assert.equal(z.bad, null, 'ZIP không hỏng');
  assert.equal(z.names.length, 4);
  assert.ok(z.names.some((n) => n === 'Đỗ Đình Đạt.jpg'), 'giữ nguyên dấu tiếng Việt');
  // Ghi chú đi kèm tên để phân biệt hai bạn trùng tên.
  assert.ok(z.names.some((n) => n.includes('Trần Tường Vy (STT 07)')));
  // Ảnh của lần nộp cũ nằm trong thư mục riêng.
  assert.ok(z.names.some((n) => n.startsWith('lan-nop-1/')), 'ảnh lần nộp cũ vào thư mục riêng');
});

test('lọc theo trạng thái chỉ lấy đúng bài ở trạng thái đó', async () => {
  const res = await fetch(base + `/api/admin/assignments/${asg.id}/export.zip?status=approved`, {
    headers: H(),
  });
  assert.equal(res.status, 200);
  // Tên file ZIP nói rõ đây là bản đã lọc.
  assert.match(decodeURIComponent(res.headers.get('content-disposition')), /đạt/);

  const z = zipEntries(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(z.names, ['Đỗ Đình Đạt.jpg']);
});

test('latest=1 bỏ ảnh của các lần nộp trước', async () => {
  const res = await fetch(base + `/api/admin/assignments/${asg.id}/export.zip?latest=1`, {
    headers: H(),
  });
  const z = zipEntries(Buffer.from(await res.arrayBuffer()));
  assert.equal(z.names.length, 3);
  assert.ok(!z.names.some((n) => n.startsWith('lan-nop-')), 'không còn ảnh lần nộp cũ');
});

test('không có ảnh nào khớp thì báo 404 rõ ràng, không trả ZIP rỗng', async () => {
  // Bài tập bắt buộc thuộc một lớp, nên tạo lớp riêng cho ca "chưa ai nộp".
  const cls = (await post('/api/admin/classes', { name: 'Lớp trống' })).class;
  const empty = (await post('/api/admin/assignments', { title: 'Chưa ai nộp', classId: cls.id }))
    .assignment;
  const res = await fetch(base + `/api/admin/assignments/${empty.id}/export.zip`, { headers: H() });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /chưa có ảnh nào/i);
});

test('status không hợp lệ bị chặn, và phải đăng nhập mới tải được', async () => {
  const bad = await fetch(base + `/api/admin/assignments/${asg.id}/export.zip?status=hack`, {
    headers: H(),
  });
  assert.equal(bad.status, 400);

  const noAuth = await fetch(base + `/api/admin/assignments/${asg.id}/export.zip`);
  assert.equal(noAuth.status, 401);

  const infoNoAuth = await fetch(base + `/api/admin/assignments/${asg.id}/export-info`);
  assert.equal(infoNoAuth.status, 401);
});

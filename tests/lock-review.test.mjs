/**
 * Khoá / mở nhận bài, duyệt hàng loạt, và tuỳ chọn cho nộp muộn.
 *
 * Trọng tâm: hết giờ là TỰ khoá (không cần ai bấm gì), và "duyệt hết" không
 * được ghi đè lên bài giáo viên đã đánh "cần nộp lại".
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baitap-lock-'));
process.env.APP_DATA = TMP;
process.env.NODE_ENV = 'test';

const { app } = await import('../server.js');
const auth = await import('../src/auth.js');
const dbmod = await import('../src/db.js');

let server;
let base;
let cookie;
let clsId;
let students;

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
const patch = async (url, body) => {
  const res = await fetch(base + url, { method: 'PATCH', headers: H(), body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function submitAs(slug, studentId, buf) {
  const fd = new FormData();
  fd.append('studentId', String(studentId));
  fd.append(`f_${studentId}_0`, new Blob([buf], { type: 'image/jpeg' }), 'anh.jpg');
  const res = await fetch(base + `/api/public/a/${slug}/submit`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: fd,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Admin tải ảnh hộ — đường này KHÔNG kiểm deadline. */
async function adminUpload(assignmentId, studentId, buf) {
  const fd = new FormData();
  fd.append(`f_${studentId}_0`, new Blob([buf], { type: 'image/jpeg' }), 'anh.jpg');
  const res = await fetch(base + `/api/admin/assignments/${assignmentId}/bulk`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', cookie },
    body: fd,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

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

  clsId = (await post('/api/admin/classes', { name: 'Lớp khoá' })).body.class.id;
  await post('/api/admin/students/import', {
    classId: clsId,
    text: 'Đỗ Đình Đạt\nTrần Tường Vy\nLê Thị Bình\nVũ Minh Quân',
  });
  students = (await getJ(`/api/admin/students?classId=${clsId}`)).students;
});

after(() => {
  server?.close();
  dbmod.db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('hết giờ là TỰ khoá, không cần ai bấm gì', async () => {
  const a = (await post('/api/admin/assignments', {
    title: 'Đã quá hạn',
    classId: clsId,
    dueAt: Date.now() - 60_000,
  })).body.assignment;

  assert.equal(a.isOpen, false, 'quá hạn thì isOpen = false ngay');
  assert.equal(a.isClosed, false, 'nhưng KHÔNG phải do bị khoá tay');

  const meta = await (await fetch(base + `/api/public/a/${a.slug}`)).json();
  assert.equal(meta.assignment.isOpen, false, 'trang nộp thấy đúng là đã đóng');

  const r = await submitAs(a.slug, students[0].id, jpeg(1));
  assert.equal(r.status, 403);
  assert.match(r.body.error, /quá hạn/);

  // Admin vẫn tải ảnh hộ được sau hạn.
  assert.equal((await adminUpload(a.id, students[0].id, jpeg(2))).body.savedCount, 1);
});

test('allowLate: quá hạn vẫn nhận, và bài được đánh dấu muộn', async () => {
  const a = (await post('/api/admin/assignments', {
    title: 'Cho nộp muộn',
    classId: clsId,
    dueAt: Date.now() - 60_000,
    allowLate: true,
  })).body.assignment;

  assert.equal(a.allowLate, true);
  assert.equal(a.isOpen, true, 'vẫn nhận bài');
  assert.equal(a.inLateWindow, true, 'nhưng đang trong giờ bù');

  const meta = await (await fetch(base + `/api/public/a/${a.slug}`)).json();
  assert.equal(meta.assignment.inLateWindow, true, 'học viên phải biết bài sẽ bị đánh muộn');

  assert.equal((await submitAs(a.slug, students[0].id, jpeg(3))).status, 200);

  const ov = await getJ(`/api/admin/assignments/${a.id}/overview`);
  const row = ov.students.find((s) => s.studentId === students[0].id);
  assert.equal(row.late, true, 'bảng tổng hợp gắn nhãn nộp muộn');
  assert.equal(ov.counts.late, 1);
});

test('tắt allowLate thì khoá lại ngay', async () => {
  const a = (await post('/api/admin/assignments', {
    title: 'Bật rồi tắt',
    classId: clsId,
    dueAt: Date.now() - 60_000,
    allowLate: true,
  })).body.assignment;
  assert.equal((await submitAs(a.slug, students[1].id, jpeg(4))).status, 200);

  const off = await patch(`/api/admin/assignments/${a.id}`, { allowLate: false });
  assert.equal(off.body.assignment.isOpen, false);
  assert.equal((await submitAs(a.slug, students[2].id, jpeg(5))).status, 403);
});

test('sửa bài tập mà không nhắc allowLate thì không đổi tuỳ chọn đó', async () => {
  const a = (await post('/api/admin/assignments', {
    title: 'Giữ allowLate',
    classId: clsId,
    dueAt: Date.now() - 60_000,
    allowLate: true,
  })).body.assignment;
  const r = await patch(`/api/admin/assignments/${a.id}`, { title: 'Đổi tên thôi' });
  assert.equal(r.body.assignment.allowLate, true);
  assert.equal(r.body.assignment.isOpen, true);
});

test('nút khoá / mở: lật trạng thái và chặn ngay', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Khoá tay', classId: clsId })).body.assignment;
  assert.equal(a.isOpen, true);

  // Không truyền gì thì lật trạng thái hiện tại.
  const locked = await post(`/api/admin/assignments/${a.id}/lock`, {});
  assert.equal(locked.body.assignment.isClosed, true);
  assert.equal(locked.body.assignment.isOpen, false);

  const blocked = await submitAs(a.slug, students[0].id, jpeg(6));
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /đã đóng/);

  const opened = await post(`/api/admin/assignments/${a.id}/lock`, { closed: false });
  assert.equal(opened.body.assignment.isClosed, false);
  assert.equal((await submitAs(a.slug, students[0].id, jpeg(7))).status, 200);
});

test('khoá tay thắng cả allowLate — giáo viên vẫn là người quyết định cuối', async () => {
  const a = (await post('/api/admin/assignments', {
    title: 'Khoá dù cho muộn',
    classId: clsId,
    dueAt: Date.now() - 60_000,
    allowLate: true,
  })).body.assignment;
  await post(`/api/admin/assignments/${a.id}/lock`, { closed: true });

  const r = await submitAs(a.slug, students[0].id, jpeg(8));
  assert.equal(r.status, 403);
  assert.match(r.body.error, /đã đóng/);
});

test('duyệt hàng loạt theo danh sách id', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Duyệt loạt', classId: clsId })).body.assignment;
  for (const s of students.slice(0, 3)) await submitAs(a.slug, s.id, jpeg(10 + s.id));

  let ov = await getJ(`/api/admin/assignments/${a.id}/overview`);
  const ids = ov.students.filter((s) => s.submissionId).map((s) => s.submissionId);
  assert.equal(ids.length, 3);

  const r = await post(`/api/admin/assignments/${a.id}/review-bulk`, {
    ids,
    status: 'approved',
    adminNote: 'Cả lớp làm tốt.',
  });
  assert.equal(r.body.updated, 3);

  ov = await getJ(`/api/admin/assignments/${a.id}/overview`);
  assert.equal(ov.counts.approved, 3);
  assert.equal(ov.counts.pending, 0);
  for (const s of ov.students.filter((x) => x.submissionId)) {
    assert.equal(s.adminNote, 'Cả lớp làm tốt.');
    assert.ok(s.reviewedAt, 'phải ghi mốc thời gian duyệt');
  }
});

test('all=true chỉ duyệt bài CHỜ DUYỆT, không ghi đè bài đã đánh cần nộp lại', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Duyệt hết', classId: clsId })).body.assignment;
  for (const s of students) await submitAs(a.slug, s.id, jpeg(20 + s.id));

  let ov = await getJ(`/api/admin/assignments/${a.id}/overview`);
  const first = ov.students.find((s) => s.submissionId);
  // Giáo viên đã cân nhắc và đánh "cần nộp lại" cho bạn này.
  await patch(`/api/admin/submissions/${first.submissionId}`, {
    status: 'rejected',
    adminNote: 'Ảnh mờ.',
  });

  const r = await post(`/api/admin/assignments/${a.id}/review-bulk`, { all: true, status: 'approved' });
  assert.equal(r.body.updated, 3, 'chỉ 3 bài chờ duyệt được đánh đạt');

  ov = await getJ(`/api/admin/assignments/${a.id}/overview`);
  const stillRejected = ov.students.find((s) => s.submissionId === first.submissionId);
  assert.equal(stillRejected.status, 'rejected', 'quyết định của giáo viên không bị ghi đè');
  assert.equal(stillRejected.adminNote, 'Ảnh mờ.', 'ghi chú riêng cũng còn nguyên');
  assert.equal(ov.counts.approved, 3);
});

test('không truyền adminNote thì giữ nguyên ghi chú riêng của từng bài', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Giữ ghi chú', classId: clsId })).body.assignment;
  await submitAs(a.slug, students[0].id, jpeg(31));
  const ov = await getJ(`/api/admin/assignments/${a.id}/overview`);
  const sub = ov.students.find((s) => s.submissionId).submissionId;
  await patch(`/api/admin/submissions/${sub}`, { adminNote: 'Ghi chú riêng' });

  await post(`/api/admin/assignments/${a.id}/review-bulk`, { ids: [sub], status: 'approved' });
  const after = await getJ(`/api/admin/assignments/${a.id}/overview`);
  const row = after.students.find((s) => s.submissionId === sub);
  assert.equal(row.status, 'approved');
  assert.equal(row.adminNote, 'Ghi chú riêng');
});

test('duyệt hàng loạt không sửa được bài của bài tập khác', async () => {
  const a1 = (await post('/api/admin/assignments', { title: 'BT một', classId: clsId })).body.assignment;
  const a2 = (await post('/api/admin/assignments', { title: 'BT hai', classId: clsId })).body.assignment;
  await submitAs(a1.slug, students[0].id, jpeg(41));
  await submitAs(a2.slug, students[1].id, jpeg(42));

  const ov2 = await getJ(`/api/admin/assignments/${a2.id}/overview`);
  const otherSub = ov2.students.find((s) => s.submissionId).submissionId;

  // Gửi id của bài tập KHÁC vào endpoint của a1.
  const r = await post(`/api/admin/assignments/${a1.id}/review-bulk`, {
    ids: [otherSub],
    status: 'approved',
  });
  assert.equal(r.body.updated, 0, 'id ngoài phạm vi bài tập bị bỏ qua');

  const after = await getJ(`/api/admin/assignments/${a2.id}/overview`);
  assert.equal(after.students.find((s) => s.submissionId === otherSub).status, 'pending');
});

test('dữ liệu vào không hợp lệ bị chặn bằng 400, và phải đăng nhập', async () => {
  const a = (await post('/api/admin/assignments', { title: 'Kiểm tham số', classId: clsId })).body.assignment;

  for (const body of [
    { status: 'hack', ids: [1] },
    { status: 'approved' },
    { status: 'approved', ids: [] },
    { status: 'approved', ids: 'khong-phai-mang' },
    { ids: [1] },
  ]) {
    const r = await post(`/api/admin/assignments/${a.id}/review-bulk`, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} phải bị chặn`);
  }

  const noAuth = await fetch(base + `/api/admin/assignments/${a.id}/lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ closed: true }),
  });
  assert.equal(noAuth.status, 401);
});

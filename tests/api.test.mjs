/**
 * Integration test: chạy server thật, DB tạm trong os.tmpdir().
 *
 * DB và thư mục ảnh trỏ vào tmpdir qua APP_DATA, và server listen(0) lấy cổng
 * ngẫu nhiên — để `npm test` KHÔNG BAO GIỜ xoá dữ liệu thật trong data/app.db.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baitap-test-'));
process.env.APP_DATA = TMP;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret-khong-dung-that';

const { app } = await import('../server.js');
const { createAdmin } = await import('../src/auth.js');
const dbmod = await import('../src/db.js');

let server;
let base;
let cookie = '';

const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.alloc(64, 2),
]);
const NOT_IMAGE = Buffer.from('#!/bin/sh\necho khong phai anh\n');

let defaultClassId;

before(async () => {
  createAdmin('admin', 'matkhau123');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'matkhau123' }),
  });
  assert.equal(res.status, 200);
  cookie = res.headers.getSetCookie()[0].split(';')[0];

  // Bài tập BẮT BUỘC thuộc một lớp, nên mọi test cần một lớp sẵn.
  const cls = await api('POST', '/api/admin/classes', { name: 'Lớp test' });
  assert.equal(cls.status, 201, cls.text);
  defaultClassId = cls.body.class.id;
});

after(() => {
  server?.close();
  try {
    dbmod.db.close();
  } catch {
    /* đã đóng */
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// --------------------------------------------------------------- tiện ích

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* không phải JSON */
  }
  return { status: res.status, body: json, text };
}

async function postForm(url, form, withCookie = true) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: withCookie ? { cookie } : {},
    body: form,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* không phải JSON */
  }
  return { status: res.status, body: json, text };
}

const file = (buf, name) => new File([buf], name, { type: 'image/jpeg' });

async function makeAssignment(overrides = {}) {
  const r = await api('POST', '/api/admin/assignments', {
    title: 'Bài tập test',
    classId: defaultClassId,
    ...overrides,
  });
  assert.equal(r.status, 201, r.text);
  return r.body.assignment;
}

async function importStudents(text) {
  const r = await api('POST', '/api/admin/students/import', { text, classId: defaultClassId });
  assert.equal(r.status, 200, r.text);
  const list = await api('GET', '/api/admin/students');
  return list.body.students;
}

// --------------------------------------------------------------- các test

test('chưa đăng nhập thì không vào được API admin và không xem được ảnh', async () => {
  const res = await fetch(`${base}/api/admin/assignments`);
  assert.equal(res.status, 401);
  const img = await fetch(`${base}/files/1`);
  assert.equal(img.status, 401);
});

test('nhập danh sách: cho phép trùng tên, có ghi chú phân biệt', async () => {
  const students = await importStudents(
    'Nguyễn Văn A,STT 1\nNguyễn Văn A,STT 2\nĐỗ Đình Đạt\nTrần Tường Vy\nLê Thị Bình',
  );
  assert.equal(students.length, 5);
  const dups = students.filter((s) => s.duplicate);
  assert.equal(dups.length, 2, 'hai bạn trùng tên đều được đánh dấu');
  assert.deepEqual(dups.map((s) => s.note).sort(), ['STT 1', 'STT 2']);
});

test('gợi ý tên: gõ không dấu, gõ tên riêng, gõ liền không cách', async () => {
  const slug = (await makeAssignment()).slug;
  const q = async (s) =>
    (await api('GET', `/api/public/a/${slug}/students?q=${encodeURIComponent(s)}`)).body.students;

  // đ không phân rã dưới NFD -> nếu chuẩn hoá sai thì đây trả rỗng.
  assert.ok((await q('do dinh')).some((s) => s.name === 'Đỗ Đình Đạt'), 'gõ không dấu');
  // Người Việt tự gọi mình bằng tên riêng; tìm theo prefix cả tên thì trượt.
  assert.ok((await q('vy')).some((s) => s.name === 'Trần Tường Vy'), 'gõ tên riêng');
  assert.ok((await q('nguyenvana')).length >= 2, 'gõ liền không cách');
  assert.equal((await q('khongcoai')).length, 0);
});

test('gợi ý tên: q lặp lại hoặc q=% không làm lộ danh sách và không 500', async () => {
  const slug = (await makeAssignment()).slug;
  // ?q=a&q=b cho array -> bind array vào node:sqlite sẽ throw 500 nếu không chặn.
  const dup = await api('GET', `/api/public/a/${slug}/students?q=a&q=b`);
  assert.equal(dup.status, 400, dup.text);
  // % không escape thì LIKE '%%%' trả về cả lớp.
  const pct = await api('GET', `/api/public/a/${slug}/students?q=%25`);
  assert.equal(pct.status, 200);
  assert.equal(pct.body.students.length, 0, 'không được trả về cả danh sách');
});

test('deadline: học viên nộp sau hạn bị chặn, admin vẫn nộp hộ được', async () => {
  const students = (await api('GET', '/api/admin/students')).body.students;
  const target = students.find((s) => s.name === 'Đỗ Đình Đạt');

  const past = await makeAssignment({ title: 'Đã quá hạn', dueAt: Date.now() - 60_000 });
  const meta = await api('GET', `/api/public/a/${past.slug}`);
  assert.equal(meta.body.assignment.isOpen, false, 'trang nộp phải biết là đã đóng');

  const form = new FormData();
  form.append('studentId', String(target.id));
  form.append('f_x_0', file(JPEG, 'anh.jpg'));
  const blocked = await postForm(`/api/public/a/${past.slug}/submit`, form, false);
  assert.equal(blocked.status, 403, blocked.text);
  assert.match(blocked.body.error, /quá hạn/i);

  // Admin nộp hộ: KHÔNG bị chặn bởi deadline.
  const adminForm = new FormData();
  adminForm.append(`f_${target.id}_0`, file(JPEG, 'nop-ho.jpg'));
  const ok = await postForm(`/api/admin/assignments/${past.id}/bulk`, adminForm);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.savedCount, 1);
});

test('đóng bài tập bằng tay cũng chặn học viên nộp', async () => {
  const a = await makeAssignment({ title: 'Đóng bằng tay' });
  await api('PATCH', `/api/admin/assignments/${a.id}`, { isClosed: true });
  const students = (await api('GET', '/api/admin/students')).body.students;

  const form = new FormData();
  form.append('studentId', String(students[0].id));
  form.append('f_x_0', file(JPEG, 'anh.jpg'));
  const r = await postForm(`/api/public/a/${a.slug}/submit`, form, false);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /đã đóng/i);
});

test('nộp lại: ảnh vào ĐÚNG bài nộp cũ, không nhảy sang bạn khác', async () => {
  // Regression cho bẫy lastInsertRowid: sau nhánh DO UPDATE của UPSERT,
  // last_insert_rowid() trả về rowid của lần INSERT trước (id của bạn khác)
  // -> ảnh bị gắn sai người, không báo lỗi gì.
  const a = await makeAssignment({ title: 'Nộp lại' });
  const students = (await api('GET', '/api/admin/students')).body.students;
  const [s1, s2] = students;

  const submit = async (studentId, name) => {
    const form = new FormData();
    form.append(`f_${studentId}_0`, file(JPEG, name));
    const r = await postForm(`/api/admin/assignments/${a.id}/bulk`, form);
    assert.equal(r.status, 200, r.text);
  };

  await submit(s1.id, 'a1.jpg'); // tạo submission #1
  await submit(s2.id, 'b1.jpg'); // tạo submission #2
  await submit(s1.id, 'a2.jpg'); // đi vào nhánh DO UPDATE

  const ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  const row1 = ov.body.students.find((s) => s.studentId === s1.id);
  const row2 = ov.body.students.find((s) => s.studentId === s2.id);
  assert.equal(row1.imageCount, 2, 'cả 2 ảnh phải thuộc bạn thứ nhất');
  assert.equal(row2.imageCount, 1, 'bạn thứ hai không được nhận thêm ảnh lạ');
  assert.equal(row1.attemptNo, 2, 'đếm số lần nộp');
});

test('nộp lại đưa bài đã duyệt về trạng thái chờ duyệt', async () => {
  const a = await makeAssignment({ title: 'Duyệt rồi nộp lại' });
  const student = (await api('GET', '/api/admin/students')).body.students[0];

  const form = new FormData();
  form.append(`f_${student.id}_0`, file(JPEG, 'x.jpg'));
  await postForm(`/api/admin/assignments/${a.id}/bulk`, form);

  let ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  const subId = ov.body.students.find((s) => s.studentId === student.id).submissionId;

  const approved = await api('PATCH', `/api/admin/submissions/${subId}`, {
    status: 'approved',
    adminNote: 'Đạt',
  });
  assert.equal(approved.body.submission.status, 'approved');

  const form2 = new FormData();
  form2.append(`f_${student.id}_0`, file(JPEG, 'y.jpg'));
  await postForm(`/api/admin/assignments/${a.id}/bulk`, form2);

  ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  const row = ov.body.students.find((s) => s.studentId === student.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.attemptNo, 2);
});

test('một file bị loại giữa lô: các ảnh còn lại vẫn gán ĐÚNG người', async () => {
  // Nếu ghép ảnh với học viên theo thứ tự mảng thì file bị loại làm req.files
  // ngắn hơn mảng id -> mọi ảnh phía sau gán sai người mà không báo lỗi.
  const a = await makeAssignment({ title: 'Lô có file lỗi' });
  const students = (await api('GET', '/api/admin/students')).body.students.slice(0, 3);

  const form = new FormData();
  form.append(`f_${students[0].id}_0`, file(JPEG, 'ok1.jpg'));
  form.append(`f_${students[1].id}_1`, file(NOT_IMAGE, 'virus.jpg')); // sẽ bị loại
  form.append(`f_${students[2].id}_2`, file(PNG, 'ok2.png'));

  const r = await postForm(`/api/admin/assignments/${a.id}/bulk`, form);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.savedCount, 2);
  assert.equal(r.body.errors.length, 1);
  assert.match(r.body.errors[0].error, /JPG, PNG/i);

  const ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  const at = (id) => ov.body.students.find((s) => s.studentId === id).imageCount;
  assert.equal(at(students[0].id), 1);
  assert.equal(at(students[1].id), 0, 'bạn có file lỗi không được nhận ảnh của ai khác');
  assert.equal(at(students[2].id), 1);
});

test('chỉ nhận ảnh thật, kiểm bằng magic bytes chứ không tin mimetype', async () => {
  const a = await makeAssignment({ title: 'Kiểm định dạng' });
  const student = (await api('GET', '/api/admin/students')).body.students[0];

  // Client khai image/jpeg nhưng nội dung là shell script.
  const form = new FormData();
  form.append(
    `f_${student.id}_0`,
    new File([NOT_IMAGE], 'fake.jpg', { type: 'image/jpeg' }),
  );
  const r = await postForm(`/api/admin/assignments/${a.id}/bulk`, form);
  assert.equal(r.body.savedCount, 0);
  assert.equal(r.body.errors.length, 1);

  // Không được để lại file rác trên đĩa.
  const files = fs.readdirSync(path.join(TMP, 'uploads'));
  assert.ok(!files.some((f) => f.includes('fake')), 'file bị loại không được ghi ra đĩa');
});

test('HEIC của iPhone bị từ chối kèm hướng dẫn cụ thể', async () => {
  const a = await makeAssignment({ title: 'HEIC' });
  const student = (await api('GET', '/api/admin/students')).body.students[0];
  const heic = Buffer.concat([
    Buffer.alloc(4, 0),
    Buffer.from('ftypheic'),
    Buffer.alloc(64, 3),
  ]);

  const form = new FormData();
  form.append(`f_${student.id}_0`, file(heic, 'IMG_0001.HEIC'));
  const r = await postForm(`/api/admin/assignments/${a.id}/bulk`, form);
  assert.equal(r.body.savedCount, 0);
  assert.match(r.body.errors[0].error, /HEIC/);
  assert.match(r.body.errors[0].error, /Tương thích nhất/);
});

test('gán lại bài nộp sang bạn khác', async () => {
  const a = await makeAssignment({ title: 'Gán lại' });
  const students = (await api('GET', '/api/admin/students')).body.students;
  const [wrong, right] = students;

  const form = new FormData();
  form.append(`f_${wrong.id}_0`, file(JPEG, 'anh.jpg'));
  await postForm(`/api/admin/assignments/${a.id}/bulk`, form);

  let ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  const subId = ov.body.students.find((s) => s.studentId === wrong.id).submissionId;

  const moved = await api('PATCH', `/api/admin/submissions/${subId}`, { studentId: right.id });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.body.submission.studentId, right.id);

  ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  assert.equal(ov.body.students.find((s) => s.studentId === wrong.id).imageCount, 0);
  assert.equal(ov.body.students.find((s) => s.studentId === right.id).imageCount, 1);
});

test('gán lại sang bạn ĐÃ có bài nộp thì dồn ảnh, không vỡ UNIQUE', async () => {
  const a = await makeAssignment({ title: 'Gán lại và dồn' });
  const students = (await api('GET', '/api/admin/students')).body.students;
  const [from, to] = students;

  for (const [id, name] of [[from.id, 'a.jpg'], [to.id, 'b.jpg']]) {
    const form = new FormData();
    form.append(`f_${id}_0`, file(JPEG, name));
    await postForm(`/api/admin/assignments/${a.id}/bulk`, form);
  }

  let ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  const fromSub = ov.body.students.find((s) => s.studentId === from.id).submissionId;

  const r = await api('PATCH', `/api/admin/submissions/${fromSub}`, { studentId: to.id });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.mergedInto, 'phải báo là đã dồn vào bài nộp có sẵn');

  ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  assert.equal(ov.body.students.find((s) => s.studentId === from.id).imageCount, 0);
  assert.equal(ov.body.students.find((s) => s.studentId === to.id).imageCount, 2);
});

test('xoá ảnh cuối cùng thì bỏ luôn bài nộp và xoá file trên đĩa', async () => {
  const a = await makeAssignment({ title: 'Xoá ảnh' });
  const student = (await api('GET', '/api/admin/students')).body.students[0];

  const form = new FormData();
  form.append(`f_${student.id}_0`, file(JPEG, 'x.jpg'));
  await postForm(`/api/admin/assignments/${a.id}/bulk`, form);

  const ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  const subId = ov.body.students.find((s) => s.studentId === student.id).submissionId;
  const imgs = await api('GET', `/api/admin/submissions/${subId}/images`);
  const before = fs.readdirSync(path.join(TMP, 'uploads')).length;

  const del = await api('DELETE', `/api/admin/images/${imgs.body.images[0].id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.submissionRemoved, true);
  assert.equal(fs.readdirSync(path.join(TMP, 'uploads')).length, before - 1);

  const after = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  assert.equal(after.body.students.find((s) => s.studentId === student.id).status, 'missing');
});

test('xoá bài tập thì dọn sạch cả DB và file ảnh', async () => {
  const a = await makeAssignment({ title: 'Sẽ bị xoá' });
  const students = (await api('GET', '/api/admin/students')).body.students.slice(0, 2);

  const form = new FormData();
  form.append(`f_${students[0].id}_0`, file(JPEG, 'a.jpg'));
  form.append(`f_${students[1].id}_1`, file(PNG, 'b.png'));
  await postForm(`/api/admin/assignments/${a.id}/bulk`, form);

  const before = fs.readdirSync(path.join(TMP, 'uploads')).length;
  const del = await api('DELETE', `/api/admin/assignments/${a.id}`);
  assert.equal(del.status, 200, del.text);
  assert.equal(del.body.removedFiles, 2);
  assert.equal(fs.readdirSync(path.join(TMP, 'uploads')).length, before - 2);

  // FK có ON DELETE CASCADE (foreign_keys mặc định = 1 ở node:sqlite) nên
  // các hàng con phải sạch, không lỗi FOREIGN KEY constraint failed.
  assert.equal(dbmod.get('SELECT COUNT(*) AS n FROM submissions WHERE assignment_id = ?', a.id).n, 0);
  assert.equal(
    dbmod.get('SELECT COUNT(*) AS n FROM submission_images').n,
    dbmod.get('SELECT COUNT(*) AS n FROM submission_images i JOIN submissions s ON s.id = i.submission_id').n,
    'không còn ảnh mồ côi',
  );
});

test('học viên nộp bài qua link: lưu tên đã gõ và IP để đối chiếu', async () => {
  const a = await makeAssignment({ title: 'Học viên tự nộp' });
  const student = (await api('GET', '/api/admin/students')).body.students.find(
    (s) => s.name === 'Trần Tường Vy',
  );

  const form = new FormData();
  form.append('studentId', String(student.id));
  form.append('typedName', 'tuong vy');
  form.append('f_x_0', file(JPEG, 'bai-lam.jpg'));
  const r = await postForm(`/api/public/a/${a.slug}/submit`, form, false);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.savedCount, 1);
  assert.equal(r.body.studentName, 'Trần Tường Vy');

  const ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  const row = ov.body.students.find((s) => s.studentId === student.id);
  assert.equal(row.status, 'pending');
  assert.equal(row.typedName, 'tuong vy', 'giữ tên học viên đã gõ để đối chiếu khi tranh chấp');

  const imgs = await api('GET', `/api/admin/submissions/${row.submissionId}/images`);
  assert.equal(imgs.body.images[0].uploadedBy, 'student');
  assert.ok(imgs.body.submission.ip, 'có lưu IP');
});

test('nộp mà không có ảnh nào hợp lệ thì không tạo bài nộp rỗng', async () => {
  const a = await makeAssignment({ title: 'Không ảnh hợp lệ' });
  const student = (await api('GET', '/api/admin/students')).body.students[0];

  const form = new FormData();
  form.append('studentId', String(student.id));
  form.append('f_x_0', file(NOT_IMAGE, 'rac.jpg'));
  const r = await postForm(`/api/public/a/${a.slug}/submit`, form, false);
  assert.equal(r.status, 400, r.text);

  const ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  assert.equal(ov.body.students.find((s) => s.studentId === student.id).status, 'missing');
});

test('API match đoán tên từ tên file, để trống khi trùng tên', async () => {
  const r = await api('POST', '/api/admin/match', {
    filenames: ['Đỗ Đình Đạt.jpg', 'IMG_20260831_120301.jpg', 'Nguyễn Văn A.jpg'],
  });
  assert.equal(r.status, 200, r.text);
  const [dat, img, dup] = r.body.matches;
  assert.ok(dat.studentId, 'tên rõ ràng thì tự chọn');
  assert.equal(img.studentId, null, 'ảnh máy chụp thì để trống');
  assert.equal(dup.studentId, null, 'trùng tên thì để admin tự chọn');
  assert.equal(dup.ambiguous, true);
});

test('bảng tổng hợp đếm đúng và đánh dấu nộp muộn', async () => {
  const a = await makeAssignment({ title: 'Đếm', dueAt: Date.now() - 60_000 });
  const students = (await api('GET', '/api/admin/students')).body.students;

  const form = new FormData();
  form.append(`f_${students[0].id}_0`, file(JPEG, 'a.jpg'));
  await postForm(`/api/admin/assignments/${a.id}/bulk`, form);

  const ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  assert.equal(ov.body.counts.total, students.length);
  assert.equal(ov.body.counts.pending, 1);
  assert.equal(ov.body.counts.missing, students.length - 1);
  assert.equal(ov.body.counts.late, 1, 'nộp sau hạn phải được đánh dấu');
});

test('export ZIP đặt tên file theo tên học viên', async () => {
  const a = await makeAssignment({ title: 'Xuất ZIP' });
  const students = (await api('GET', '/api/admin/students')).body.students.slice(0, 2);

  const form = new FormData();
  form.append(`f_${students[0].id}_0`, file(JPEG, 'x.jpg'));
  form.append(`f_${students[1].id}_1`, file(PNG, 'y.png'));
  await postForm(`/api/admin/assignments/${a.id}/bulk`, form);

  const res = await fetch(`${base}/api/admin/assignments/${a.id}/export.zip`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await res.arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'là file ZIP hợp lệ');

  // Tên trong ZIP là UTF-8 (bit 11) nên tên có dấu tiếng Việt đọc được.
  const text = zip.toString('utf8');
  assert.ok(text.includes(students[0].name.split(' ').pop()), 'tên học viên có trong ZIP');
});

test('ảnh chỉ admin xem được, và được cache vĩnh viễn', async () => {
  const a = await makeAssignment({ title: 'Xem ảnh' });
  const student = (await api('GET', '/api/admin/students')).body.students[0];

  const form = new FormData();
  form.append(`f_${student.id}_0`, file(JPEG, 'z.jpg'));
  await postForm(`/api/admin/assignments/${a.id}/bulk`, form);

  const ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  const subId = ov.body.students.find((s) => s.studentId === student.id).submissionId;
  const imgs = await api('GET', `/api/admin/submissions/${subId}/images`);
  const url = imgs.body.images[0].url;

  const anon = await fetch(base + url);
  assert.equal(anon.status, 401);

  const authed = await fetch(base + url, { headers: { cookie } });
  assert.equal(authed.status, 200);
  assert.equal(authed.headers.get('content-type'), 'image/jpeg');
  assert.match(authed.headers.get('cache-control'), /immutable/);
});

test('QR trả về PNG và không cache (IP LAN có thể đổi)', async () => {
  const a = await makeAssignment({ title: 'QR' });
  const res = await fetch(`${base}/api/admin/assignments/${a.id}/qr.png`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const png = Buffer.from(await res.arrayBuffer());
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const link = await api('GET', `/api/admin/assignments/${a.id}/link`);
  assert.ok(link.body.url.endsWith(`/s/${a.slug}`));
  assert.ok(Array.isArray(link.body.lanUrls));
});

test('trang nộp /s/:slug trả về HTML', async () => {
  const a = await makeAssignment({ title: 'Trang nộp' });
  const res = await fetch(`${base}/s/${a.slug}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('sửa tên học viên thì cập nhật luôn cột chuẩn hoá', async () => {
  const students = await importStudents('Nguyen Van Sai');
  const target = students.find((s) => s.name === 'Nguyen Van Sai');

  const r = await api('PATCH', `/api/admin/students/${target.id}`, { name: 'Nguyễn Văn Sửa' });
  assert.equal(r.status, 200, r.text);

  const a = await makeAssignment({ title: 'Sau khi sửa tên' });
  const found = await api('GET', `/api/public/a/${a.slug}/students?q=nguyen van sua`);
  assert.ok(
    found.body.students.some((s) => s.name === 'Nguyễn Văn Sửa'),
    'tìm được bằng tên mới, nghĩa là name_normalized đã cập nhật',
  );
});

test('xoá học viên đã có bài nộp thì chỉ ẩn đi, không mất bài', async () => {
  const students = await importStudents('Bạn Sẽ Chuyển Lớp');
  const target = students.find((s) => s.name === 'Bạn Sẽ Chuyển Lớp');
  const a = await makeAssignment({ title: 'Ẩn học viên' });

  const form = new FormData();
  form.append(`f_${target.id}_0`, file(JPEG, 'a.jpg'));
  await postForm(`/api/admin/assignments/${a.id}/bulk`, form);

  const del = await api('DELETE', `/api/admin/students/${target.id}`);
  assert.equal(del.body.deactivated, true, 'không xoá hẳn khi còn bài nộp');

  const ov = await api('GET', `/api/admin/assignments/${a.id}/overview`);
  assert.ok(
    !ov.body.students.some((s) => s.studentId === target.id),
    'không còn trong danh sách chính',
  );
  assert.ok(
    ov.body.orphans.some((o) => o.studentId === target.id && o.imageCount === 1),
    'nhưng bài nộp vẫn thấy được ở phần riêng',
  );
});

test('id không hợp lệ trả 400, không phải 500', async () => {
  for (const url of [
    '/api/admin/assignments/abc/overview',
    '/api/admin/submissions/0/images',
    '/api/admin/images/-1',
    '/api/admin/students/xyz',
  ]) {
    const r = await api('GET', url);
    assert.ok(r.status === 400 || r.status === 404, `${url} -> ${r.status}`);
  }
});

test('thiếu dữ liệu bắt buộc thì báo lỗi rõ ràng', async () => {
  assert.equal((await api('POST', '/api/admin/assignments', { title: '   ' })).status, 400);
  assert.equal((await api('POST', '/api/admin/students/import', { text: '' })).status, 400);
  assert.equal((await api('POST', '/api/admin/match', { filenames: 'khong-phai-mang' })).status, 400);
});

test('phiên đăng nhập sống qua restart, và secret không bị coi là session', async () => {
  // Store nằm trên SQLite chứ không phải MemoryStore, nên đăng nhập không mất
  // mỗi lần server khởi động lại (chạy dev với --watch thì rất hay gặp).
  const store = new (await import('../src/auth.js')).SqliteStore();

  await new Promise((r) => store.set('sid-test', { cookie: { maxAge: 60_000 }, adminId: 1 }, r));
  const loaded = await new Promise((r) => store.get('sid-test', (e, s) => r(s)));
  assert.equal(loaded.adminId, 1);

  // Hàng __secret__ giữ SESSION_SECRET tự sinh, không phải session -> store
  // phải bỏ qua nó, và tác vụ dọn dẹp không được xoá nó.
  const { SECRET_SID } = await import('../src/auth.js');
  const asSession = await new Promise((r) => store.get(SECRET_SID, (e, s) => r(s)));
  assert.equal(asSession, null);

  // Dữ liệu session hỏng thì coi như chưa đăng nhập, không trả 500.
  dbmod.run('UPDATE sessions SET data = ? WHERE sid = ?', 'khong-phai-json', 'sid-test');
  const broken = await new Promise((r) => store.get('sid-test', (e, s) => r({ err: e, s })));
  assert.equal(broken.err, null);
  assert.equal(broken.s, null);
});

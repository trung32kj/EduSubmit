/**
 * Kiểm thử phần chống gian lận và quản lý nhiều lớp.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'baitap-cheat-'));
process.env.APP_DATA = TMP;
process.env.NODE_ENV = 'test';

const { app } = await import('../server.js');
const auth = await import('../src/auth.js');
const dbmod = await import('../src/db.js');

let server;
let base;
let cookie;

/** JPEG hợp lệ tối thiểu, nội dung phụ thuộc seed để hash khác nhau. */
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
const post = async (url, body) =>
  (await fetch(base + url, { method: 'POST', headers: H(), body: JSON.stringify(body) })).json();
const getJ = async (url) => (await fetch(base + url, { headers: H() })).json();

/** Nộp bài như học viên (không đăng nhập). */
async function submitAs(slug, studentId, buf, jar) {
  const fd = new FormData();
  fd.append('studentId', String(studentId));
  fd.append('typedName', 'test');
  fd.append(`f_${studentId}_0`, new Blob([buf], { type: 'image/jpeg' }), 'anh.jpg');
  const headers = { 'sec-fetch-site': 'same-origin' };
  if (jar?.cookie) headers.cookie = jar.cookie;
  const res = await fetch(base + `/api/public/a/${slug}/submit`, { method: 'POST', headers, body: fd });
  const setCookie = res.headers.getSetCookie()?.[0];
  if (jar && setCookie) jar.cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json() };
}

test('mỗi lớp là một danh sách riêng biệt', async () => {
  const a = (await post('/api/admin/classes', { name: 'Lớp A' })).class;
  const b = (await post('/api/admin/classes', { name: 'Lớp B' })).class;
  await post('/api/admin/students/import', { classId: a.id, text: 'Nguyễn Văn A\nĐỗ Đình Đạt' });
  await post('/api/admin/students/import', { classId: b.id, text: 'Nguyễn Văn A\nLê Thị Bình' });

  const inA = (await getJ(`/api/admin/students?classId=${a.id}`)).students;
  const inB = (await getJ(`/api/admin/students?classId=${b.id}`)).students;
  assert.equal(inA.length, 2);
  assert.equal(inB.length, 2);

  // Trùng tên giữa hai lớp khác nhau là bình thường -> KHÔNG gắn nhãn trùng.
  assert.equal(inA.find((s) => s.name === 'Nguyễn Văn A').duplicate, false);

  const all = (await getJ('/api/admin/students')).students;
  assert.equal(all.length, 4);
});

test('bảng tổng hợp chỉ gồm học viên của lớp bài tập đó', async () => {
  const cls = (await post('/api/admin/classes', { name: 'Lớp C' })).class;
  await post('/api/admin/students/import', { classId: cls.id, text: 'Trần Tường Vy\nVũ Minh Quân' });
  const asg = (await post('/api/admin/assignments', { title: 'BT lớp C', classId: cls.id })).assignment;

  const ov = await getJ(`/api/admin/assignments/${asg.id}/overview`);
  // Nếu không lọc theo lớp thì bảng của lớp C sẽ đầy tên các lớp khác ở trạng
  // thái "chưa nộp".
  assert.equal(ov.counts.total, 2);
  assert.equal(ov.assignment.className, 'Lớp C');
});

test('học viên lớp khác không tìm thấy tên mình và không nộp được', async () => {
  const c1 = (await post('/api/admin/classes', { name: 'Lớp D' })).class;
  const c2 = (await post('/api/admin/classes', { name: 'Lớp E' })).class;
  await post('/api/admin/students/import', { classId: c1.id, text: 'Phạm Hoàng Nam' });
  await post('/api/admin/students/import', { classId: c2.id, text: 'Đặng Thị Hương' });
  const asg = (await post('/api/admin/assignments', { title: 'BT lớp D', classId: c1.id })).assignment;
  const { slug } = await getJ(`/api/admin/assignments/${asg.id}/link`);

  const search = async (q) =>
    (await (await fetch(base + `/api/public/a/${slug}/students?q=${encodeURIComponent(q)}`)).json()).students;

  assert.equal((await search('pham hoang')).length, 1);
  assert.equal((await search('dang thi')).length, 0, 'không được thấy tên lớp khác');

  const outsider = (await getJ(`/api/admin/students?classId=${c2.id}`)).students[0];
  const res = await submitAs(slug, outsider.id, jpeg(1));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /không thuộc lớp/);
});

test('gõ 1 ký tự thì không trả kết quả (chống dò cả danh sách lớp)', async () => {
  const cls = (await post('/api/admin/classes', { name: 'Lớp F' })).class;
  await post('/api/admin/students/import', { classId: cls.id, text: 'Ngô Thanh Hà\nBùi Văn Tú' });
  const asg = (await post('/api/admin/assignments', { title: 'BT lớp F', classId: cls.id })).assignment;
  const { slug } = await getJ(`/api/admin/assignments/${asg.id}/link`);

  // LIKE '%a%' với q 1 ký tự thì chỉ cần lặp bảng chữ cái là ra gần hết lớp.
  const one = await (await fetch(base + `/api/public/a/${slug}/students?q=a`)).json();
  assert.equal(one.students.length, 0);
  assert.match(one.hint, /2 chữ/);

  const two = await (await fetch(base + `/api/public/a/${slug}/students?q=ha`)).json();
  assert.ok(two.students.length >= 1);
});

test('ảnh trùng giữa hai học viên bị phát hiện', async () => {
  const cls = (await post('/api/admin/classes', { name: 'Lớp G' })).class;
  await post('/api/admin/students/import', { classId: cls.id, text: 'Học Viên Một\nHọc Viên Hai\nHọc Viên Ba' });
  const asg = (await post('/api/admin/assignments', { title: 'BT lớp G', classId: cls.id })).assignment;
  const { slug } = await getJ(`/api/admin/assignments/${asg.id}/link`);
  const st = (await getJ(`/api/admin/students?classId=${cls.id}`)).students;

  const shared = jpeg(42);
  const jar = {};
  // Hai bạn nộp ĐÚNG cùng một file (chuyển cho nhau qua Zalo rồi mỗi người nộp).
  await submitAs(slug, st[0].id, shared, jar);
  await submitAs(slug, st[1].id, shared, jar);
  // Bạn thứ ba nộp ảnh khác.
  await submitAs(slug, st[2].id, jpeg(7), {});

  const ov = await getJ(`/api/admin/assignments/${asg.id}/overview`);
  assert.equal(ov.counts.duplicate, 2, 'phải phát hiện đúng 2 bạn trùng ảnh');

  const flagged = ov.students.filter((s) => s.duplicateImages);
  assert.equal(flagged.length, 2);
  // Nêu rõ trùng với ai, để admin xử lý được.
  assert.deepEqual(flagged[0].duplicateImages[0].withNames, [flagged[1].name]);

  const clean = ov.students.find((s) => s.studentId === st[2].id);
  assert.equal(clean.duplicateImages, null);
});

test('cùng một bạn nộp lại đúng ảnh cũ thì KHÔNG bị coi là gian lận', async () => {
  const cls = (await post('/api/admin/classes', { name: 'Lớp H' })).class;
  await post('/api/admin/students/import', { classId: cls.id, text: 'Một Bạn Thôi' });
  const asg = (await post('/api/admin/assignments', { title: 'BT lớp H', classId: cls.id })).assignment;
  const { slug } = await getJ(`/api/admin/assignments/${asg.id}/link`);
  const st = (await getJ(`/api/admin/students?classId=${cls.id}`)).students[0];

  const same = jpeg(99);
  const jar = {};
  await submitAs(slug, st.id, same, jar);
  await submitAs(slug, st.id, same, jar);

  const ov = await getJ(`/api/admin/assignments/${asg.id}/overview`);
  assert.equal(ov.counts.duplicate, 0, 'nộp lại ảnh của chính mình chỉ là lỡ tay');
});

test('bài đã duyệt ĐẠT không bị kéo về chờ duyệt khi có người nộp thêm', async () => {
  const cls = (await post('/api/admin/classes', { name: 'Lớp I' })).class;
  await post('/api/admin/students/import', { classId: cls.id, text: 'Bạn Đã Đạt' });
  const asg = (await post('/api/admin/assignments', { title: 'BT lớp I', classId: cls.id })).assignment;
  const { slug } = await getJ(`/api/admin/assignments/${asg.id}/link`);
  const st = (await getJ(`/api/admin/students?classId=${cls.id}`)).students[0];

  const jar = {};
  await submitAs(slug, st.id, jpeg(11), jar);
  let ov = await getJ(`/api/admin/assignments/${asg.id}/overview`);
  const subId = ov.students[0].submissionId;

  await fetch(base + `/api/admin/submissions/${subId}`, {
    method: 'PATCH',
    headers: H(),
    body: JSON.stringify({ status: 'approved' }),
  });

  // Ai có link cũng nộp được dưới tên bất kỳ; nếu nộp mà reset trạng thái thì một
  // request là đủ xoá sạch công chấm bài của cả lớp.
  const again = await submitAs(slug, st.id, jpeg(12), jar);
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyApproved, true);

  ov = await getJ(`/api/admin/assignments/${asg.id}/overview`);
  assert.equal(ov.students[0].status, 'approved');
  assert.equal(ov.students[0].attemptNo, 2, 'vẫn phải ghi nhận là lần nộp mới');
});

test('một trình duyệt chỉ nộp thay được tối đa 2 bạn', async () => {
  const cls = (await post('/api/admin/classes', { name: 'Lớp J' })).class;
  await post('/api/admin/students/import', { classId: cls.id, text: 'Bạn Một\nBạn Hai\nBạn Ba\nBạn Bốn' });
  const asg = (await post('/api/admin/assignments', { title: 'BT lớp J', classId: cls.id })).assignment;
  const { slug } = await getJ(`/api/admin/assignments/${asg.id}/link`);
  const st = (await getJ(`/api/admin/students?classId=${cls.id}`)).students;

  // Link nộp bài không xác định được người nộp, nên đây là chốt duy nhất cản việc
  // một người lần lượt nộp rác dưới tên cả lớp.
  const jar = {};
  assert.equal((await submitAs(slug, st[0].id, jpeg(1), jar)).status, 200);
  assert.equal((await submitAs(slug, st[1].id, jpeg(2), jar)).status, 200);
  const third = await submitAs(slug, st[2].id, jpeg(3), jar);
  assert.equal(third.status, 429);
  assert.match(third.body.error, /2 bạn khác/);

  // Nộp thêm cho bạn ĐÃ nộp từ máy này thì vẫn được.
  assert.equal((await submitAs(slug, st[0].id, jpeg(4), jar)).status, 200);

  // Trình duyệt khác (jar mới) thì không bị ảnh hưởng.
  assert.equal((await submitAs(slug, st[2].id, jpeg(5), {})).status, 200);
});

test('xoá lớp thì xoá bài tập nhưng giữ học viên', async () => {
  const cls = (await post('/api/admin/classes', { name: 'Lớp K' })).class;
  await post('/api/admin/students/import', { classId: cls.id, text: 'Giữ Lại Tôi' });
  const asg = (await post('/api/admin/assignments', { title: 'BT lớp K', classId: cls.id })).assignment;
  const { slug } = await getJ(`/api/admin/assignments/${asg.id}/link`);
  const st = (await getJ(`/api/admin/students?classId=${cls.id}`)).students[0];
  await submitAs(slug, st.id, jpeg(77), {});

  const res = await (await fetch(base + `/api/admin/classes/${cls.id}`, { method: 'DELETE', headers: H() })).json();
  assert.equal(res.removedAssignments, 1);
  assert.equal(res.keptStudents, 1);
  assert.equal(res.removedFiles, 1);

  // Học viên còn nguyên, chỉ là không thuộc lớp nào nữa.
  const still = dbmod.get('SELECT class_id FROM students WHERE id = ?', st.id);
  assert.ok(still);
  assert.equal(still.class_id, null);
  // Ảnh trên đĩa cũng phải bị dọn, không để rác.
  assert.equal(dbmod.get('SELECT COUNT(*) AS n FROM assignments WHERE id = ?', asg.id).n, 0);
});

/**
 * Chạy một bản demo hoàn toàn riêng biệt để xem giao diện.
 *
 * Dữ liệu nằm trong thư mục tạm của hệ thống, KHÔNG đụng vào data/app.db thật —
 * dùng để thử giao diện hoặc hướng dẫn người khác mà không sợ lẫn dữ liệu.
 *
 *   node scripts/demo.js          (mặc định cổng 3100)
 *   PORT=4000 node scripts/demo.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), 'baitap-demo');
fs.mkdirSync(dir, { recursive: true });

process.env.APP_DATA = dir;
process.env.PORT = process.env.PORT || '3100';

const { run, get, getReturning } = await import('../src/db.js');
const { hashPasswordSync } = await import('../src/auth.js');
const { saveImage } = await import('../src/upload.js');

const now = Date.now();

if (!get('SELECT id FROM admins LIMIT 1')) {
  run(
    'INSERT INTO admins (username, password_hash, password_changed_at, created_at) VALUES (?, ?, ?, ?)',
    'demo',
    hashPasswordSync('demo-mat-khau'),
    now,
    now,
  );

  const cls = getReturning(
    'INSERT INTO classes (name, note, is_active, created_at) VALUES (?, ?, 1, ?) RETURNING id',
    'Lớp 9A',
    '',
    now,
  );
  const cls2 = getReturning(
    'INSERT INTO classes (name, note, is_active, created_at) VALUES (?, ?, 1, ?) RETURNING id',
    'Lớp 9B',
    '',
    now,
  );

  const { normalize, squash } = await import('../src/norm.js');
  const addStudent = (name, note, classId) =>
    getReturning(
      `INSERT INTO students (name, name_normalized, name_squashed, note, class_id, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?) RETURNING id`,
      name,
      normalize(name),
      squash(name),
      note,
      classId,
      now,
    ).id;

  const ids = {};
  for (const [name, note] of [
    ['Nguyễn Văn A', 'STT 01'],
    ['Nguyễn Văn A', 'STT 02'],
    ['Đỗ Đình Đạt', ''],
    ['Trần Tường Vy', ''],
    ['Lê Thị Bình', ''],
    ['Phạm Hoàng Nam', ''],
    ['Đặng Thị Hương', ''],
    ['Vũ Minh Quân', ''],
  ]) {
    ids[name + note] = addStudent(name, note, cls.id);
  }
  for (const name of ['Hoàng Thị Mai', 'Bùi Văn Tú', 'Ngô Thanh Hà']) {
    addStudent(name, '', cls2.id);
  }

  const asg = getReturning(
    `INSERT INTO assignments (title, description, due_at, is_closed, slug, class_id, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?) RETURNING id`,
    'Bài tập tuần 1 — chụp ảnh vở',
    'Chụp rõ trang vở, thấy được ngày làm bài.',
    now + 3 * 86400000,
    'demoslug01',
    cls.id,
    now,
  );
  getReturning(
    `INSERT INTO assignments (title, description, due_at, is_closed, slug, class_id, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?) RETURNING id`,
    'Bài tập tuần 2 — ảnh thí nghiệm',
    '',
    now - 86400000,
    'demoslug02',
    cls.id,
    now,
  );

  /** JPEG hợp lệ tối thiểu; cùng seed thì cùng hash -> dùng để tạo ca "ảnh trùng". */
  const jpeg = (seed, size = 4000) =>
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
      Buffer.alloc(size, seed),
      Buffer.from([0xff, 0xd9]),
    ]);

  const shared = jpeg(42);
  const plan = [
    ['Đỗ Đình Đạt', jpeg(1), 'approved', 'Ảnh rõ, đạt.'],
    ['Trần Tường Vy', shared, 'pending', ''],
    ['Lê Thị Bình', shared, 'pending', ''],
    ['Nguyễn Văn ASTT 01', jpeg(4), 'rejected', 'Ảnh mờ, chụp lại trang 2.'],
    ['Phạm Hoàng Nam', jpeg(5), 'pending', ''],
  ];

  for (const [key, buf, status, note] of plan) {
    const info = await saveImage(buf);
    const sub = getReturning(
      `INSERT INTO submissions (assignment_id, student_id, status, admin_note, submitted_at, attempt_no, reviewed_at)
       VALUES (?, ?, ?, ?, ?, 1, ?) RETURNING id, attempt_no`,
      asg.id,
      ids[key],
      status,
      note,
      now,
      status === 'pending' ? null : now,
    );
    run(
      `INSERT INTO submission_images
         (submission_id, stored_name, original_name, size_bytes, mime, attempt_no, uploaded_by, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 'admin', ?, ?)`,
      sub.id,
      info.storedName,
      key + '.jpg',
      info.size,
      info.mime,
      info.sha256,
      now,
    );
  }

  console.log(`\n  Đã tạo dữ liệu demo trong ${dir}`);
}

console.log('  Đăng nhập demo:  demo / demo-mat-khau');
console.log('  (Bản demo, dữ liệu tách riêng khỏi data/app.db)\n');

await import('../server.js');

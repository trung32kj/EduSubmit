/**
 * Tầng DB: mở kết nối, PRAGMA, migration, transaction, và bọc các bẫy của
 * node:sqlite lại thành API dễ dùng.
 *
 * node:sqlite khác better-sqlite3 ở nhiều điểm quan trọng — xem chú thích
 * ở từng hàm. Mọi truy vấn nên đi qua các helper trong file này để những chỗ
 * khác không phải nhớ các bẫy đó.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export const DATA_DIR = process.env.APP_DATA
  ? path.resolve(process.env.APP_DATA)
  : path.join(ROOT, 'data');

export const UPLOADS_DIR = process.env.APP_UPLOADS
  ? path.resolve(process.env.APP_UPLOADS)
  : path.join(DATA_DIR, 'uploads');

export const DB_PATH = process.env.APP_DB
  ? path.resolve(process.env.APP_DB)
  : path.join(DATA_DIR, 'app.db');

// DatabaseSync KHÔNG tự tạo thư mục cha -> ERR_SQLITE_ERROR "unable to open
// database file". Phải mkdir trước khi mở.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH, { timeout: 5000 });

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`);

/**
 * node:sqlite THROW khi bind true/false/undefined:
 *   ERR_INVALID_ARG_TYPE: Provided value cannot be bound to SQLite parameter
 * Nên phải quy đổi trước mọi lần bind.
 */
function coerce(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint' || typeof v === 'string' || v instanceof Uint8Array) return v;
  // Object/array lọt tới driver sẽ throw 500; ném lỗi rõ ràng ở đây.
  throw new TypeError(`Giá trị không bind được vào SQLite: ${typeof v}`);
}

const coerceAll = (params) => params.map(coerce);

export function run(sql, ...params) {
  return db.prepare(sql).run(...coerceAll(params));
}

export function get(sql, ...params) {
  return db.prepare(sql).get(...coerceAll(params));
}

export function all(sql, ...params) {
  return db.prepare(sql).all(...coerceAll(params));
}

/**
 * INSERT rồi trả về hàng vừa ghi.
 *
 * KHÔNG dùng lastInsertRowid cho câu UPSERT: khi rơi vào nhánh DO UPDATE,
 * last_insert_rowid() giữ nguyên rowid của lần INSERT TRƯỚC ĐÓ (tức là id của
 * một bản ghi khác), và changes = 1 ở cả hai nhánh nên cũng không phân biệt
 * được. Luôn dùng RETURNING + .get() (.run() bỏ mất hàng RETURNING).
 */
export function getReturning(sql, ...params) {
  return db.prepare(sql).get(...coerceAll(params));
}

/**
 * node:sqlite không có db.transaction() như better-sqlite3 -> tự làm.
 * Bắt buộc dùng cho import danh sách và bulk upload để không còn dữ liệu nửa vời.
 */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback lỗi thì cũng không che lỗi gốc */
    }
    throw err;
  }
}

/** node:sqlite không có db.pragma() -> đọc bằng truy vấn thường. */
export function pragma(name) {
  const row = get(`PRAGMA ${name}`);
  return row ? Object.values(row)[0] : undefined;
}

/**
 * Migration theo phiên bản, dùng PRAGMA user_version làm mốc.
 *
 * Mỗi migration chỉ chạy một lần và không bao giờ được sửa sau khi đã phát hành
 * — muốn đổi schema thì thêm migration mới. `ALTER TABLE ADD COLUMN` không
 * idempotent (thêm lại cột đã có sẽ throw "duplicate column name"), nên cơ chế
 * đánh số phiên bản là bắt buộc, không thể chỉ dựa vào IF NOT EXISTS.
 */
const MIGRATIONS = [
  // v1 — schema ban đầu
  () => db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    -- KHÔNG UNIQUE trên tên: lớp Việt Nam hay có 2 bạn trùng tên,
    -- phân biệt bằng cột note (STT, lớp, nickname).
    CREATE TABLE IF NOT EXISTS students (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      name_normalized TEXT NOT NULL,
      name_squashed  TEXT NOT NULL,
      note           TEXT NOT NULL DEFAULT '',
      group_name     TEXT,
      is_active      INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_students_norm ON students(name_normalized);
    CREATE INDEX IF NOT EXISTS idx_students_squashed ON students(name_squashed);

    CREATE TABLE IF NOT EXISTS assignments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      -- epoch milliseconds, KHÔNG phải chuỗi ISO: datetime-local trả giờ local
      -- không timezone, so chuỗi với toISOString() lệch 7 tiếng ở Việt Nam.
      due_at      INTEGER,
      is_closed   INTEGER NOT NULL DEFAULT 0,
      slug        TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
      admin_note    TEXT NOT NULL DEFAULT '',
      attempt_no    INTEGER NOT NULL DEFAULT 1,
      typed_name    TEXT,
      ip            TEXT,
      user_agent    TEXT,
      submitted_at  INTEGER NOT NULL,
      reviewed_at   INTEGER,
      UNIQUE (assignment_id, student_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sub_assignment ON submissions(assignment_id);

    CREATE TABLE IF NOT EXISTS submission_images (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      stored_name   TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      mime          TEXT NOT NULL DEFAULT '',
      attempt_no    INTEGER NOT NULL DEFAULT 1,
      -- ở đây chứ không ở submissions: 1 submission có thể gồm cả ảnh học viên
      -- tự nộp lẫn ảnh admin upload hộ.
      uploaded_by   TEXT NOT NULL DEFAULT 'student',
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_img_submission ON submission_images(submission_id);

    CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
  `),

  // v2 — nhiều lớp, và hash ảnh để phát hiện nộp trùng
  () => db.exec(`
    CREATE TABLE IF NOT EXISTS classes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      is_active  INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    ALTER TABLE students    ADD COLUMN class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL;
    ALTER TABLE assignments ADD COLUMN class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE;

    CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_class ON assignments(class_id);

    -- SHA-256 của đúng byte ảnh: hai bạn nộp cùng một file thì hash giống nhau.
    ALTER TABLE submission_images ADD COLUMN sha256 TEXT;
    CREATE INDEX IF NOT EXISTS idx_img_sha ON submission_images(sha256);
  `),

  // v3 — dữ liệu cũ chưa có lớp: dồn hết vào một lớp mặc định, để mọi truy vấn
  // lọc theo lớp không làm học viên cũ biến mất khỏi giao diện.
  () => {
    const hasData =
      get('SELECT COUNT(*) AS n FROM students').n > 0 ||
      get('SELECT COUNT(*) AS n FROM assignments').n > 0;
    if (!hasData) return;

    const cls = getReturning(
      'INSERT INTO classes (name, note, is_active, created_at) VALUES (?, ?, 1, ?) RETURNING id',
      'Lớp của tôi',
      'Tự tạo khi nâng cấp — đổi tên được',
      Date.now(),
    );
    run('UPDATE students SET class_id = ? WHERE class_id IS NULL', cls.id);
    run('UPDATE assignments SET class_id = ? WHERE class_id IS NULL', cls.id);
  },

  // v4 — đếm số lần đăng nhập sai. Ghi vào DB chứ không giữ trong RAM: nếu chỉ
  // trong RAM thì kẻ dò mật khẩu chỉ cần chờ server restart là được reset.
  () => db.exec(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      key     TEXT PRIMARY KEY,
      fails   INTEGER NOT NULL DEFAULT 0,
      last_at INTEGER NOT NULL
    );

    -- Mốc đổi mật khẩu: session cấp trước mốc này bị vô hiệu, để việc đổi mật
    -- khẩu thật sự đá được kẻ đang đăng nhập ra.
    ALTER TABLE admins ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0;
  `),

  // v5 — dấu vết theo TỪNG ảnh, không phải theo bài nộp.
  // Ai có link cũng nộp được dưới tên bất kỳ, nên khi có tranh chấp ("em đã nộp
  // rồi mà") thì cần biết từng ảnh do ai gửi, không phải chỉ người gửi cuối cùng.
  () => db.exec(`
    ALTER TABLE submission_images ADD COLUMN typed_name TEXT;
    ALTER TABLE submission_images ADD COLUMN ip TEXT;
    ALTER TABLE submission_images ADD COLUMN user_agent TEXT;
  `),

  // v6 — mã PIN cho từng bài tập.
  // Khi web mở ra internet, link nộp bài chỉ là một chuỗi: ai có nó là nộp được.
  // PIN là thứ chỉ người trong lớp biết (giáo viên đọc/chiếu lên bảng).
  () => db.exec(`
    ALTER TABLE assignments ADD COLUMN pin TEXT;
  `),
];

export function migrate() {
  const current = Number(pragma('user_version')) || 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    // ALTER TABLE chạy được trong transaction, nên một migration lỗi giữa đường
    // không để lại schema nửa vời.
    tx(() => {
      MIGRATIONS[v]();
      // PRAGMA không nhận tham số bind -> nội suy, nhưng v là số nguyên do ta
      // tự sinh nên không có đường cho dữ liệu ngoài lọt vào.
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

migrate();

/** Lớp đang được chọn để làm việc; null = xem tất cả các lớp. */
export function classExists(id) {
  return !!get('SELECT id FROM classes WHERE id = ?', id);
}

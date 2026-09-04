/**
 * Sao lưu toàn bộ dữ liệu: DB + ảnh.
 *
 *   node scripts/backup.js [thư-mục-đích]
 *
 * Với WAL, phải copy cả app.db, app.db-wal và app.db-shm cùng lúc — chỉ copy
 * mỗi app.db có thể mất những ghi chép mới nhất còn nằm trong file -wal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, UPLOADS_DIR, db } from '../src/db.js';

const stamp = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .replace('T', '_')
  .slice(0, 19);

const destRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(path.dirname(DB_PATH), 'backups');
const dest = path.join(destRoot, stamp);

fs.mkdirSync(dest, { recursive: true });

// Dồn nội dung file -wal vào file .db chính trước khi copy, để bản sao lưu
// tự đủ và không phụ thuộc vào việc copy được cả 3 file đúng thời điểm.
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch (err) {
  console.warn('Không checkpoint được WAL:', err.message);
}

let dbFiles = 0;
for (const suffix of ['', '-wal', '-shm']) {
  const src = DB_PATH + suffix;
  if (!fs.existsSync(src)) continue;
  fs.copyFileSync(src, path.join(dest, path.basename(src)));
  dbFiles++;
}

let images = 0;
let bytes = 0;
if (fs.existsSync(UPLOADS_DIR)) {
  const target = path.join(dest, 'uploads');
  fs.mkdirSync(target, { recursive: true });
  for (const name of fs.readdirSync(UPLOADS_DIR)) {
    const src = path.join(UPLOADS_DIR, name);
    const stat = fs.statSync(src);
    if (!stat.isFile()) continue;
    fs.copyFileSync(src, path.join(target, name));
    images++;
    bytes += stat.size;
  }
}

db.close();

console.log(`Đã sao lưu vào: ${dest}`);
console.log(`  ${dbFiles} file dữ liệu, ${images} ảnh (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log('\nĐể phục hồi: dừng server, copy các file này về đúng thư mục data/.');

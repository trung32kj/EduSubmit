/**
 * Tạo hoặc đổi mật khẩu tài khoản admin.
 *
 *   node scripts/create-admin.js                 -> hỏi trên terminal
 *   node scripts/create-admin.js admin matkhau   -> không cần hỏi
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { run, get, tx } from '../src/db.js';
import { hashPasswordSync, SECRET_SID } from '../src/auth.js';

const [argUser, argPass] = process.argv.slice(2);

let username = argUser;
let password = argPass;

if (!username || !password) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  username = username || (await rl.question('Tên đăng nhập: '));
  password = password || (await rl.question('Mật khẩu: '));
  rl.close();
}

username = String(username).trim();
password = String(password);

if (!username) {
  console.error('Thiếu tên đăng nhập.');
  process.exit(1);
}
// 8 ký tự là mức tối thiểu còn chấp nhận được; dưới mức đó thì dò được kể cả khi
// đã có cơ chế khoá tạm.
if (password.length < 8) {
  console.error('Mật khẩu phải từ 8 ký tự. Nên dùng một câu ngắn dễ nhớ.');
  process.exit(1);
}

const now = Date.now();
const existing = get('SELECT id FROM admins WHERE username = ?', username);

if (existing) {
  // Đổi mật khẩu PHẢI đá mọi phiên đang đăng nhập ra: nếu không thì khi bị chiếm
  // tài khoản, đổi mật khẩu cũng vô ích vì kẻ kia vẫn còn cookie dùng được 30 ngày.
  const removed = tx(() => {
    run(
      'UPDATE admins SET password_hash = ?, password_changed_at = ? WHERE id = ?',
      hashPasswordSync(password),
      now,
      existing.id,
    );
    const n = get('SELECT COUNT(*) AS n FROM sessions WHERE sid <> ?', SECRET_SID).n;
    run('DELETE FROM sessions WHERE sid <> ?', SECRET_SID);
    return n;
  });
  console.log(`Đã đổi mật khẩu cho "${username}".`);
  if (removed) console.log(`Đã đăng xuất ${removed} phiên đang mở.`);
} else {
  run(
    'INSERT INTO admins (username, password_hash, password_changed_at, created_at) VALUES (?, ?, ?, ?)',
    username,
    hashPasswordSync(password),
    now,
    now,
  );
  console.log(`Đã tạo admin "${username}".`);
}

/**
 * Chặn dò mật khẩu và spam: đếm số lần thất bại theo khoá, tăng thời gian chờ.
 *
 * Lưu trong bộ nhớ là đủ cho một máy chạy local, nhưng khoá đăng nhập thì ghi
 * vào DB: nếu chỉ giữ trong RAM thì kẻ dò chỉ cần chờ server restart là reset.
 */
import { get, run } from './db.js';
import { HttpError } from './shared.js';

/** Bộ đếm trong bộ nhớ, có giới hạn số khoá để không phình vô hạn. */
export function createRateLimiter({ max, windowMs, maxKeys = 5000 }) {
  const hits = new Map();

  const prune = (now) => {
    for (const [key, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
    // Vẫn quá nhiều khoá -> bỏ các khoá cũ nhất (Map giữ thứ tự chèn).
    if (hits.size > maxKeys) {
      const excess = hits.size - maxKeys;
      let i = 0;
      for (const key of hits.keys()) {
        if (i++ >= excess) break;
        hits.delete(key);
      }
    }
  };

  const timer = setInterval(() => prune(Date.now()), Math.min(windowMs, 5 * 60 * 1000));
  timer.unref();

  return {
    /** true = còn lượt. false = đã vượt giới hạn. */
    take(key) {
      const now = Date.now();
      const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (arr.length >= max) {
        hits.set(key, arr);
        return false;
      }
      arr.push(now);
      hits.set(key, arr);
      if (hits.size > maxKeys) prune(now);
      return true;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// ------------------------------------------------------- khoá đăng nhập admin

const LOGIN = {
  // Sau 5 lần sai thì bắt đầu chờ; mỗi lần sai tiếp theo chờ gấp đôi, tối đa 15 phút.
  freeAttempts: 5,
  baseDelayMs: 15 * 1000,
  maxDelayMs: 15 * 60 * 1000,
  // Quên hết lần sai cũ sau 1 giờ không ai thử.
  forgetAfterMs: 60 * 60 * 1000,
};

function loginKey(username, ip) {
  // Khoá theo cả tên đăng nhập và IP: dò một tài khoản từ nhiều IP vẫn bị chặn,
  // mà một IP dò nhiều tài khoản cũng bị chặn.
  return `login:${username.toLowerCase()}|${ip}`;
}

/** Còn phải chờ bao nhiêu ms nữa mới được thử tiếp. 0 = thử được ngay. */
export function loginLockoutMs(username, ip) {
  const row = get('SELECT * FROM login_attempts WHERE key = ?', loginKey(username, ip));
  if (!row) return 0;
  if (Date.now() - row.last_at > LOGIN.forgetAfterMs) return 0;

  const over = row.fails - LOGIN.freeAttempts;
  if (over <= 0) return 0;
  const delay = Math.min(LOGIN.baseDelayMs * 2 ** (over - 1), LOGIN.maxDelayMs);
  return Math.max(0, row.last_at + delay - Date.now());
}

export function recordLoginFailure(username, ip) {
  const key = loginKey(username, ip);
  const now = Date.now();
  const row = get('SELECT fails, last_at FROM login_attempts WHERE key = ?', key);
  // Đã lâu không ai thử thì đếm lại từ đầu.
  const fails = row && now - row.last_at <= LOGIN.forgetAfterMs ? row.fails + 1 : 1;
  run(
    `INSERT INTO login_attempts (key, fails, last_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, last_at = excluded.last_at`,
    key,
    fails,
    now,
  );
  return fails;
}

export function clearLoginFailures(username, ip) {
  run('DELETE FROM login_attempts WHERE key = ?', loginKey(username, ip));
}

export function throwIfLockedOut(username, ip) {
  const waitMs = loginLockoutMs(username, ip);
  if (waitMs <= 0) return;
  const secs = Math.ceil(waitMs / 1000);
  const text = secs >= 60 ? `${Math.ceil(secs / 60)} phút` : `${secs} giây`;
  throw new HttpError(429, `Sai quá nhiều lần. Thử lại sau ${text}.`);
}

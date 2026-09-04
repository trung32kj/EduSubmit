/**
 * Đăng nhập admin: băm mật khẩu bằng scrypt (node:crypto, không cần native dep)
 * và session store lưu trên SQLite.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Store } from 'express-session';
import { run, get } from './db.js';

// N=32768 THROW ERR_CRYPTO_INVALID_SCRYPT_PARAMS với maxmem mặc định (~32MB).
// Phải truyền maxmem tường minh. Params lưu luôn vào chuỗi hash để sau này
// đổi được mà không phải reset mật khẩu cũ.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEYLEN = 64;

// Chỉ nhận các bộ tham số ta thực sự phát hành. Không có allowlist thì một chuỗi
// hash bị sửa thành "1$1$1" sẽ verify tức thì với chi phí gần bằng 0.
const ALLOWED_PARAMS = new Set(['32768$8$1', '16384$8$1']);

/**
 * Bản async. scryptSync mất ~137ms và CHẶN event loop, nên vài request đăng nhập
 * đồng thời là đủ làm cả server (kể cả đường nộp bài của học viên) treo.
 */
const scryptAsync = promisify(crypto.scrypt);

/**
 * Hash giả để so khi không tìm thấy tài khoản.
 *
 * Không có nó thì username sai trả lời tức thì còn username đúng mất ~137ms —
 * chênh 1000 lần, đủ để dò ra tên đăng nhập chỉ bằng một request.
 */
const DUMMY_HASH = hashPasswordSync(crypto.randomBytes(32).toString('hex'));

export const SECRET_SID = '__secret__';

function encode(salt, key) {
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Dùng cho script tạo admin (chạy một lần, chặn event loop không sao). */
export function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  return encode(salt, crypto.scryptSync(password, salt, KEYLEN, SCRYPT));
}

export const hashPassword = hashPasswordSync;

/** Tách và kiểm chuỗi hash. Trả null nếu chuỗi không đúng khuôn. */
function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [scheme, N, r, p, saltB64, keyB64] = parts;
  if (scheme !== 'scrypt') return null;
  if (!ALLOWED_PARAMS.has(`${N}$${r}$${p}`)) return null;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  // Base64 rỗng hoặc rác ("!!!!") đều cho buffer dài 0; scrypt với keylen 0 trả
  // buffer dài 0 và timingSafeEqual(rỗng, rỗng) = TRUE -> mọi mật khẩu đều đúng.
  if (salt.length < 8 || expected.length !== KEYLEN) return null;

  return { N: Number(N), r: Number(r), p: Number(p), salt, expected };
}

export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  // Vẫn tiêu tốn thời gian tương đương khi chuỗi hash hỏng, để không thành một
  // kênh đo thời gian mới.
  const target = parsed ?? parseHash(DUMMY_HASH);
  try {
    const actual = await scryptAsync(password, target.salt, KEYLEN, {
      N: target.N,
      r: target.r,
      p: target.p,
      maxmem: SCRYPT.maxmem,
    });
    // timingSafeEqual THROW nếu 2 buffer khác độ dài -> so length trước.
    if (actual.length !== target.expected.length) return false;
    const ok = crypto.timingSafeEqual(actual, target.expected);
    return parsed ? ok : false;
  } catch {
    return false;
  }
}

export function findAdmin(username) {
  return get('SELECT * FROM admins WHERE username = ?', username);
}

/**
 * Kiểm mật khẩu cho một tên đăng nhập. Luôn chạy scrypt dù tài khoản có tồn tại
 * hay không, nên thời gian trả lời không tiết lộ tên đăng nhập nào là thật.
 */
export async function authenticate(username, password) {
  const admin = findAdmin(username);
  const ok = await verifyPassword(password, admin ? admin.password_hash : DUMMY_HASH);
  return ok && admin ? admin : null;
}

export function createAdmin(username, password) {
  return run(
    'INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)',
    username,
    hashPasswordSync(password),
    Date.now(),
  );
}

/** Chặn API admin. Trả JSON 401 để trang web tự chuyển về /login. */
export function requireAdmin(req, res, next) {
  if (!req.session?.adminId) {
    return res.status(401).json({ error: 'Cần đăng nhập' });
  }
  // Tài khoản bị xoá, hoặc mật khẩu đã đổi sau khi session này được cấp -> hết
  // hiệu lực. Không kiểm thì đổi mật khẩu vẫn không đá được kẻ đang đăng nhập ra,
  // mà đó chính là việc cần làm khi nghi bị chiếm tài khoản.
  const admin = get('SELECT id, password_changed_at FROM admins WHERE id = ?', req.session.adminId);
  if (!admin || (admin.password_changed_at ?? 0) > (req.session.issuedAt ?? 0)) {
    return req.session.destroy(() =>
      res.status(401).json({ error: 'Phiên đăng nhập đã hết hiệu lực. Đăng nhập lại.' }),
    );
  }
  next();
}

/**
 * Session store trên SQLite.
 *
 * MemoryStore mặc định mất hết session mỗi lần restart server (chạy `npm run dev`
 * với --watch thì cứ vài phút lại phải đăng nhập lại) và mỗi lượt xem trang của
 * học viên tạo thêm 1 entry rác không bao giờ được thu hồi.
 */
export class SqliteStore extends Store {
  constructor() {
    super();
    this.cleanup();
    // Dọn session hết hạn mỗi giờ; unref để không giữ process sống khi test.
    this.timer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    this.timer.unref();
  }

  cleanup() {
    try {
      run('DELETE FROM sessions WHERE expires_at < ? AND sid <> ?', Date.now(), SECRET_SID);
    } catch {
      /* bảng chưa có thì lần sau */
    }
  }

  get(sid, cb) {
    if (sid === SECRET_SID) return cb(null, null);
    try {
      const row = get('SELECT data, expires_at FROM sessions WHERE sid = ?', sid);
      if (!row) return cb(null, null);
      if (row.expires_at < Date.now()) {
        run('DELETE FROM sessions WHERE sid = ?', sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch {
      // Dữ liệu session hỏng: coi như chưa đăng nhập, đừng trả 500.
      cb(null, null);
    }
  }

  set(sid, session, cb) {
    // __secret__ giữ khoá ký cookie, không phải session. Ghi đè nó sẽ làm mất
    // hiệu lực mọi phiên đăng nhập.
    if (sid === SECRET_SID) return cb(null);
    try {
      const ttl = session.cookie?.maxAge ?? 30 * 24 * 60 * 60 * 1000;
      run(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
        sid,
        JSON.stringify(session),
        Date.now() + ttl,
      );
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    if (sid === SECRET_SID) return cb(null);
    try {
      run('DELETE FROM sessions WHERE sid = ?', sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, session, cb) {
    this.set(sid, session, cb);
  }
}

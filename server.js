/**
 * Web nộp bài tập bằng ảnh chứng minh.
 *
 * Chạy:  npm start   (mặc định http://localhost:3000)
 * Tạo admin lần đầu:  npm run create-admin
 */
import express from 'express';
import session from 'express-session';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import multer from 'multer';
import { get, run, DATA_DIR, UPLOADS_DIR, DB_PATH } from './src/db.js';
import {
  SqliteStore,
  requireAdmin,
  authenticate,
  SECRET_SID,
} from './src/auth.js';
import { securityHeaders, csrfGuard } from './src/http-guard.js';
import { throwIfLockedOut, recordLoginFailure, clearLoginFailures } from './src/ratelimit.js';
import { adminRouter, serveImage } from './src/routes/admin.js';
import { publicRouter } from './src/routes/public.js';
import { str, HttpError } from './src/shared.js';
import { multerErrorMessage } from './src/upload.js';

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT) || 3000;

// Chạy local nên tự sinh secret nếu chưa có, nhưng cảnh báo: đổi secret thì
// mọi session đang đăng nhập bị mất.
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  const row = get('SELECT data FROM sessions WHERE sid = ?', SECRET_SID);
  if (row) {
    SECRET = row.data;
  } else {
    SECRET = crypto.randomBytes(32).toString('hex');
    run(
      'INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)',
      SECRET_SID,
      SECRET,
      // Rất xa trong tương lai để tác vụ dọn session không xoá mất.
      Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
    );
  }
}

const app = express();
app.disable('x-powered-by');

/**
 * Chạy sau reverse proxy / tunnel (Cloudflare, ngrok, nginx…).
 *
 * Chỉ bật khi THẬT SỰ có proxy: khi bật, Express tin header X-Forwarded-For, nên
 * nếu không có proxy thì client tự khai IP giả để lách giới hạn tần suất và ghi
 * IP sai vào bài nộp.
 *
 * Giá trị: số bước proxy (thường '1'), 'loopback', hoặc danh sách IP.
 */
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v);
}

app.use(securityHeaders);

app.use(express.json({ limit: '1mb' }));
// Express 5 mặc định extended = false; ở đây form đều gửi JSON hoặc multipart.
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use(
  session({
    name: 'sid',
    secret: SECRET,
    store: new SqliteStore(),
    // Mặc định true sẽ tạo 1 hàng session rác cho MỖI lượt xem trang của học viên.
    saveUninitialized: false,
    resave: false,
    cookie: {
      httpOnly: true,
      // 'strict' thay vì 'lax': không có luồng nào cần cookie khi điều hướng từ
      // site khác sang, nên chọn mức chặt hơn.
      sameSite: 'strict',
      // Bật cờ secure khi chạy sau HTTPS. Đặt HTTPS=1, hoặc suy ra từ BASE_URL
      // để chạy qua tunnel là tự đúng, không phải nhớ thêm một biến nữa.
      secure: process.env.HTTPS === '1' || (process.env.BASE_URL ?? '').startsWith('https://'),
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }),
);

// Chặn CSRF cho mọi request làm thay đổi dữ liệu, kể cả đường nộp bài công khai.
app.use(csrfGuard);

// --------------------------------------------------------------- đăng nhập

app.post('/api/admin/login', async (req, res) => {
  const username = str(req.body?.username, 100)?.trim();
  const password = str(req.body?.password, 200);
  if (!username || !password) {
    return res.status(400).json({ error: 'Nhập tên đăng nhập và mật khẩu' });
  }

  // Khoá tạm sau nhiều lần sai, thời gian chờ tăng dần. Kiểm TRƯỚC khi chạy
  // scrypt để việc dò mật khẩu không còn là cách làm treo server.
  const ip = req.ip ?? '';
  throwIfLockedOut(username, ip);

  // authenticate() luôn chạy scrypt dù tài khoản có tồn tại hay không, nên thời
  // gian trả lời không tiết lộ tên đăng nhập nào là thật.
  const admin = await authenticate(username, password);
  if (!admin) {
    recordLoginFailure(username, ip);
    return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
  }

  clearLoginFailures(username, ip);

  // Cấp session id mới sau khi đăng nhập: nếu kẻ tấn công cắm được một session id
  // vào trình duyệt thì id đó cũng không trở thành phiên đã đăng nhập.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Không tạo được phiên đăng nhập' });
    req.session.adminId = admin.id;
    req.session.username = admin.username;
    // Mốc để so với password_changed_at: đổi mật khẩu là vô hiệu session cũ.
    req.session.issuedAt = Date.now();
    res.json({ ok: true, username: admin.username });
  });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  if (!req.session?.adminId) return res.status(401).json({ error: 'Chưa đăng nhập' });
  res.json({ username: req.session.username });
});

// ------------------------------------------------------------------ routes

app.use('/api/public', publicRouter);
app.use('/api/admin', requireAdmin, adminRouter);
app.get('/files/:imageId', requireAdmin, serveImage);

// Trang nộp bài của học viên: /s/<slug>
app.get('/s/:slug', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'submit.html'));
});

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

app.get('/', (req, res) => res.redirect('/admin'));

// Express 5: app.get('*') THROW ngay khi boot (path-to-regexp v8).
// Fallback phải là '/*splat' hoặc app.use().
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Không có API này' });
  res.status(404).sendFile(path.join(ROOT, 'public', '404.html'));
});

// Error middleware BẮT BUỘC đúng 4 tham số, kể cả ở Express 5.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: multerErrorMessage(err) });
  }
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? 'Lỗi máy chủ. Xem log để biết chi tiết.' : err.message,
  });
});

// ------------------------------------------------------------------- start

export { app };

// Chỉ tự listen khi chạy trực tiếp; test import app rồi tự listen(0).
if (process.env.NODE_ENV !== 'test') {
  // Bind 0.0.0.0 để điện thoại trong cùng Wi-Fi vào được (lần đầu Windows
  // Firewall sẽ hỏi -> phải bấm Allow, không thì máy khác không kết nối được).
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Bài tập ảnh chứng minh`);
    console.log(`  Admin:    http://localhost:${PORT}/admin`);
    console.log(`  Dữ liệu:  ${DB_PATH}`);
    console.log(`  Ảnh:      ${UPLOADS_DIR}`);

    // Học viên quét QR bằng điện thoại phải dùng IP LAN; localhost trên điện
    // thoại là chính nó nên không bao giờ tới được máy này.
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
      .map((n) => `http://${n.address}:${PORT}`);
    if (lan.length && !process.env.BASE_URL) {
      console.log(`  Điện thoại cùng Wi-Fi: ${lan.join('  hoặc  ')}`);
    }
    console.log('');

    if (!get('SELECT id FROM admins LIMIT 1')) {
      console.log('  Chưa có tài khoản admin. Chạy: npm run create-admin\n');
    }
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Cổng ${PORT} đang bị chiếm. Có thể server đã chạy ở cửa sổ khác.`);
      console.error(`  Đổi cổng: PORT=3001 npm start\n`);
      process.exit(1);
    }
    throw err;
  });
}

void DATA_DIR;

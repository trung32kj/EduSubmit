# EduSubmit — Web nộp bài tập bằng ảnh chứng minh

Web nội bộ cho giáo viên: quản lý nhiều lớp, đăng bài tập, học viên nộp ảnh chứng
minh, xem bảng tổng hợp và duyệt bài. Chỉ giáo viên cần tài khoản — học viên nộp
qua link/QR riêng của từng bài tập.

Không cần build step, không cần cài database server. Bốn dependency; toàn bộ dữ
liệu nằm trong một file SQLite (`data/app.db`).

## Chạy

Cần Node 22.5 trở lên (`node:sqlite` là module có sẵn từ bản này).

```bash
npm install
```

```bash
npm run create-admin
```

```bash
npm start
```

Mở http://localhost:3000 — đăng nhập rồi bắt đầu từ **Danh sách lớp**: tạo lớp
trước, sau đó dán danh sách học viên vào lớp đó.

## Lưu trữ dữ liệu (SQLite)

Dữ liệu nằm trong **một file SQLite** duy nhất: `data/app.db`. Không phải cài
MySQL/Postgres, không phải chạy service nào — copy file đó đi đâu là mang cả dữ
liệu theo. Ảnh học viên nộp lưu thành file riêng trong `data/uploads/`, tên là UUID.

Dùng `node:sqlite` (module có sẵn trong Node 22.5+) nên không cần dependency nào
để nói chuyện với database, và không có bước biên dịch native.

Các bảng: `classes`, `students`, `assignments`, `submissions`, `submission_images`,
`admins`, `sessions`, `login_attempts`. Xem [src/db.js](src/db.js) để biết chi tiết.

Schema đổi theo **migration đánh số** (`PRAGMA user_version`): mỗi migration chạy
đúng một lần, chạy trong transaction, và tự động chạy khi khởi động. Nâng cấp từ
bản cũ không mất dữ liệu — bản v3 còn tự tạo lớp mặc định rồi dồn học viên cũ vào
đó, để không ai biến mất khỏi giao diện sau khi thêm tính năng nhiều lớp.

Cấu hình sẵn `WAL` + `foreign_keys=ON` + `busy_timeout`. Vì đang dùng WAL, khi sao
lưu phải copy cả ba file `app.db`, `app.db-wal`, `app.db-shm` — `npm run backup` lo
việc đó (nó `wal_checkpoint` trước khi copy).

Hai lưu ý khi vận hành:

- Đừng để thư mục `data/` dưới OneDrive/Dropbox. Client sync giữ handle vào file
  và gây `SQLITE_BUSY` ngắt quãng.
- Đừng chạy hai lần `npm start` cùng lúc trên cùng một `data/`. Cổng bị chiếm sẽ
  báo lỗi rõ ràng, nhưng nếu bạn đổi cổng thì hai tiến trình sẽ tranh nhau ghi.

Muốn đổi sang Postgres sau này thì mọi truy vấn đều đi qua các helper trong
`src/db.js`, nên đó là chỗ duy nhất phải sửa.

## Xem thử giao diện

```bash
npm run demo
```

Chạy ở cổng 3100 với dữ liệu mẫu (2 lớp, 11 học viên, 2 bài tập, có sẵn một ca
"ảnh trùng" để xem). Đăng nhập `demo` / `demo-mat-khau`. Dữ liệu nằm trong thư mục
tạm của hệ thống nên **không lẫn vào `data/app.db` thật**.

## Màu sắc

Chủ đạo trắng + xanh nước biển. Toàn bộ màu khai báo ở `:root` trong
[app.css](public/css/app.css) — đổi ở đó là đổi cả app.

| Biến | Việc |
|---|---|
| `--accent` `#0a5c9c` | Nút, link, tiêu đề cột |
| `--accent-deep` `#083f68` | Thanh điều hướng, tiêu đề |
| `--accent-soft` / `--accent-soft-2` | Nền nhạt: dòng đang trỏ, ô mở rộng, khối số liệu |
| `--line-input` `#7896aa` | Viền ô nhập (đậm hơn viền trang trí) |

Mỗi cặp chữ/nền đều đã tính tỉ lệ tương phản, đạt tối thiểu 4.5:1 cho chữ nhỏ và
3:1 cho viền ô nhập. Nếu đổi mã màu thì phải tính lại — ước lượng bằng mắt rất dễ
tạo ra chữ mờ mà người mắt kém không đọc được.

## Việc thường làm

**Tạo lớp và nhập danh sách.** Mỗi bài tập thuộc một lớp, và học viên chỉ thấy tên
bạn cùng lớp mình khi nộp bài. Dán tên vào ô, mỗi dòng một bạn. Hai bạn trùng tên
là chuyện bình thường — thêm ghi chú sau dấu phẩy để phân biệt:

```
Nguyễn Văn A, STT 01
Nguyễn Văn A, STT 02
Đỗ Đình Đạt
```

Dán trực tiếp từ Excel hoặc chọn file CSV cũng được.

**Tải nhiều ảnh của nhiều bạn cùng lúc.** Vào bài tập → *Tải ảnh lên* → kéo-thả
cả đống ảnh. Hệ thống đoán tên từ tên file, bạn sửa những dòng đoán sai rồi bấm
tải lên. Ảnh tải từ Zalo (`IMG_20260901_080102.jpg`) không có tên người nên sẽ
để trống — gõ tên vào ô ở dòng đó, gõ không dấu cũng tìm ra. Nhiều ảnh cùng một
bạn thì dùng nút *Gán các dòng trống cho…*.

**Duyệt bài.** Bảng tổng hợp → *Xem ảnh* → *Đạt* hoặc *Cần nộp lại* kèm ghi chú.
Bạn nào chọn sai tên thì dùng *Gán cho bạn khác*.

**Ảnh trùng.** Nếu hai bạn nộp đúng cùng một file (chuyển ảnh cho nhau rồi mỗi
người nộp), bảng tổng hợp gắn nhãn đỏ *ảnh trùng* kèm tên bạn kia. So bằng nội
dung ảnh nên đổi tên file không lách được. Cùng một bạn nộp lại ảnh cũ của chính
mình thì không bị tính.

**Nhắc bạn chưa nộp.** Nút *Copy danh sách chưa nộp* cho ra danh sách tên, mỗi
dòng một tên, dán thẳng vào Zalo.

**Lấy ảnh về máy.** Nút *Tải ZIP* — tên file trong ZIP là tên học viên.

## Học viên nộp bài

Mỗi bài tập có một link và một mã QR (nút *Link & QR*). Học viên mở link, gõ tên
mình (có gợi ý, tối thiểu 2 chữ), chọn ảnh, nộp. Không cần tài khoản.

Quá hạn là học viên không nộp được nữa, nhưng bạn vẫn upload hộ được qua *Tải ảnh lên*.

**Để điện thoại quét QR vào được:** điện thoại và máy này phải cùng mạng Wi-Fi, và
QR phải chứa IP LAN chứ không phải `localhost` (điện thoại hiểu `localhost` là
chính nó). Cửa sổ *Link & QR* hiện sẵn link LAN đúng để bạn kiểm tra. Hai lưu ý:

- Lần đầu chạy, Windows Firewall sẽ hỏi — bấm **Allow** cho mạng Private.
- IP LAN đổi theo DHCP, nên QR đã in có thể hết hiệu lực. Đặt `BASE_URL` nếu bạn
  có địa chỉ cố định:

```bash
BASE_URL=http://192.168.1.40:3000 npm start
```

## Bảo mật

Những gì đã có:

- Mật khẩu băm bằng scrypt, sai nhiều lần thì khoá tạm với thời gian chờ tăng dần
  (mốc khoá lưu trong database nên restart server không reset).
- Đổi mật khẩu bằng `npm run create-admin` **đá mọi phiên đang đăng nhập ra** —
  cần thiết khi nghi bị chiếm tài khoản.
- Chống CSRF, chống dò tên đăng nhập qua thời gian phản hồi, security headers
  (CSP, nosniff, frame-ancestors, Referrer-Policy).
- Ảnh kiểm bằng magic bytes, phục vụ với `nosniff` + CSP sandbox, nằm ngoài thư mục web.
- Học viên chỉ tìm được tên trong lớp của bài tập, cần tối thiểu 2 chữ, có giới
  hạn tần suất — để không ai dò được cả danh sách lớp.
- Một trình duyệt chỉ nộp thay được tối đa 2 bạn cho mỗi bài tập.
- Bài đã duyệt *Đạt* không bị kéo về *Chờ duyệt* khi có người nộp thêm.

Còn lại: chạy HTTP trong LAN nên ai bắt được gói tin trong mạng vẫn đọc được
cookie. Khi có HTTPS thì đặt `HTTPS=1` để bật cờ `secure` cho cookie.

Về việc chặn Developer Tools / F12: không làm được, và cũng không nên tin vào đó.
Mọi thứ chạy trên máy người dùng đều can thiệp được — tắt JS, gọi thẳng API bằng
`curl`, dùng trình duyệt khác. Vì vậy mọi kiểm tra quan trọng đều nằm ở server
(hạn nộp, lớp, hạn mức, phát hiện ảnh trùng), và đó là chỗ duy nhất đáng đặt niềm tin.

## Sao lưu

```bash
npm run backup
```

Copy cả database và toàn bộ ảnh vào `data/backups/<thời-điểm>/`. Phục hồi: dừng
server, copy các file đó về lại `data/`. **Bản sao lưu chứa khoá ký cookie, hash
mật khẩu và toàn bộ ảnh của học viên** — giữ nó cẩn thận như dữ liệu gốc.

## Kiểm thử

```bash
npm test
```

75 test. Dùng database tạm trong thư mục temp của hệ thống, không đụng vào
`data/app.db`.

## Cấu trúc

| Đường dẫn | Việc |
|---|---|
| `server.js` | Khởi động, đăng nhập, mount route, xử lý lỗi |
| `src/db.js` | Kết nối SQLite, migration theo phiên bản, transaction |
| `src/norm.js` | Chuẩn hoá tên tiếng Việt (dùng chung mọi nơi) |
| `src/match.js` | Đoán tên học viên từ tên file |
| `src/auth.js` | Băm mật khẩu, session store trên SQLite |
| `src/ratelimit.js` | Giới hạn tần suất, khoá đăng nhập |
| `src/http-guard.js` | Security headers, chống CSRF |
| `src/upload.js` | Kiểm ảnh bằng magic bytes, hash, hạn mức dung lượng |
| `src/zip.js` | Ghi ZIP không nén, không cần thư viện ngoài |
| `src/routes/` | API admin và API công khai |
| `public/` | Giao diện — HTML + ES module, không build step |
| `data/` | `app.db` và thư mục `uploads/` (không commit) |

Bốn dependency: express, multer, express-session, qrcode. SQLite dùng
`node:sqlite` có sẵn trong Node 22.5+.

Mọi script đều nằm ở file riêng trong `public/js/` (không có script inline), để CSP
chặn được `script-src 'self'`.

## Biến môi trường

| Biến | Mặc định | Việc |
|---|---|---|
| `PORT` | `3000` | Cổng |
| `BASE_URL` | tự đoán từ request | URL nhúng vào QR |
| `HTTPS` | — | Đặt `1` khi chạy sau HTTPS để bật cookie `secure` |
| `TRUST_PROXY` | — | Chỉ đặt khi thật sự có reverse proxy |
| `SESSION_SECRET` | tự sinh, lưu vào DB | Khoá ký cookie |
| `MAX_TOTAL_MB` | `5120` | Trần dung lượng thư mục ảnh |
| `APP_DATA` | `./data` | Thư mục dữ liệu |
| `APP_DB` / `APP_UPLOADS` | trong `APP_DATA` | Đường dẫn riêng cho DB / ảnh |

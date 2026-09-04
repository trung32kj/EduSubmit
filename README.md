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

**Tạo lớp trước, rồi mới tạo bài tập.** Bài tập **bắt buộc** thuộc một lớp — không
có lớp thì bảng tổng hợp trống và không học viên nào nộp được. Học viên chỉ thấy tên
bạn cùng lớp mình khi nộp bài.

Nhập danh sách: dán tên vào ô, mỗi dòng một bạn. Hai bạn trùng tên là chuyện bình
thường — thêm ghi chú sau dấu phẩy để phân biệt:

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

**Xoá nhiều bạn một lượt.** Tick checkbox ở đầu mỗi dòng (hoặc checkbox tổng ở
hàng tiêu đề để chọn hết những bạn đang hiện theo bộ lọc). Thanh hành động xuất
hiện kèm số lượng đã chọn; xác nhận sẽ hiện đúng danh sách tên sắp xoá. Bạn đã
nộp bài thì chỉ bị ẩn khỏi danh sách, bài nộp và ảnh giữ nguyên.

**Lấy ảnh về máy.** Nút *Tải ảnh về (ZIP)*. Chọn được tải tất cả hay chỉ một
trạng thái (đã đạt / chờ duyệt / cần nộp lại), và bỏ ảnh của các lần nộp cũ. Hộp
thoại hiện trước số ảnh và dung lượng để không bấm tải rồi ngồi đợi mấy trăm MB.
Tên file trong ZIP là tên học viên, kèm ghi chú nếu có — mở ra là biết ảnh của ai.

**Ảnh trùng.** Nếu hai bạn nộp đúng cùng một file (chuyển ảnh cho nhau rồi mỗi
người nộp), bảng tổng hợp gắn nhãn đỏ *ảnh trùng* kèm tên bạn kia. So bằng nội
dung ảnh nên đổi tên file không lách được. Cùng một bạn nộp lại ảnh cũ của chính
mình thì không bị tính.

**Nhắc bạn chưa nộp.** Nút *Copy danh sách chưa nộp* cho ra danh sách tên, mỗi
dòng một tên, dán thẳng vào Zalo.

## Học viên nộp bài

Mỗi bài tập có một link và một mã QR (nút *Link & QR*). Học viên mở link, gõ tên
mình (có gợi ý, tối thiểu 2 chữ), chọn ảnh, nộp. Không cần tài khoản.

Quá hạn là học viên không nộp được nữa, nhưng bạn vẫn upload hộ được qua *Tải ảnh lên*.

### Mã PIN

Bật PIN cho bài tập nào cần: nút *Bật PIN* trong cửa sổ *Link & QR*, hoặc tick khi
tạo bài tập. Hệ thống sinh mã 4 số, bạn đọc cho lớp. Không có mã thì **không nộp
được và cũng không tra được tên bạn nào trong lớp** — danh sách lớp chính là thứ
PIN cần bảo vệ. Nhập sai nhiều lần thì bị khoá tạm, nên không dò được 10.000 mã.

Học viên chỉ nhập PIN một lần cho mỗi bài tập; nộp thêm ảnh sau đó không phải gõ lại.

Nên bật PIN nếu link đi ra ngoài lớp — link chỉ là một chuỗi, ai có nó là nộp được.

### Cho học viên nộp từ bất kỳ đâu

Mặc định web chỉ chạy trong mạng nội bộ: điện thoại phải cùng Wi-Fi với máy này,
và mã QR chứa IP LAN (IP đổi theo DHCP nên QR đã in có thể hết hiệu lực).

Muốn học viên nộp từ nhà, cần một địa chỉ công khai — domain riêng, hoặc một tunnel
(Cloudflare Tunnel, ngrok, Tailscale Funnel…). Sau khi có địa chỉ đó, chạy:

```bash
BASE_URL=https://baitap.example.com TRUST_PROXY=1 npm start
```

Hai biến này làm ba việc:

| Biến | Việc |
|---|---|
| `BASE_URL` | Mã QR chứa địa chỉ công khai thay vì IP LAN; giao diện ngừng hiện gợi ý "phải cùng Wi-Fi"; cookie tự bật cờ `secure` nếu là `https://` |
| `TRUST_PROXY=1` | Lấy đúng IP học viên từ header của proxy, để giới hạn tần suất và dấu vết bài nộp không bị dồn hết về IP của proxy |

**Đừng đặt `TRUST_PROXY` khi chạy trực tiếp** — khi bật, server tin header
`X-Forwarded-For`, nên không có proxy thì client tự khai IP giả để lách giới hạn.

Khi ra internet thì **nên bật PIN** cho mọi bài tập, và nhớ rằng máy phải bật để
web chạy. Muốn tắt máy vẫn nộp được thì phải deploy lên VPS.

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
- Mã PIN cho từng bài tập: không có mã thì không nộp được **và không tra được tên**;
  nhập sai nhiều lần bị khoá tạm.
- Một trình duyệt chỉ nộp thay được tối đa 2 bạn cho mỗi bài tập.
- Bài đã duyệt *Đạt* không bị kéo về *Chờ duyệt* khi có người nộp thêm.

Còn lại: chạy HTTP trong LAN thì ai bắt được gói tin trong mạng vẫn đọc được
cookie. Chạy qua HTTPS (domain hoặc tunnel) thì cookie tự bật cờ `secure`.

Về việc chặn Developer Tools / F12: không làm được, và cũng không nên tin vào đó.
Mọi thứ chạy trên máy người dùng đều can thiệp được — tắt JS, gọi thẳng API bằng
`curl`, dùng trình duyệt khác. Vì vậy mọi kiểm tra quan trọng đều nằm ở server
(hạn nộp, lớp, hạn mức, phát hiện ảnh trùng), và đó là chỗ duy nhất đáng đặt niềm tin.

## Deploy lên hosting (domain riêng)

Ví dụ với Railway và domain `alotrle.xyz`. Các nền tảng khác (Render, Fly.io) làm
tương tự — điểm quan trọng là cả ba việc dưới đây.

### 1. Tạo service từ GitHub

Vào [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo**
→ chọn repo này. Railway đọc [railway.toml](railway.toml) nên không cần cấu hình build.

### 2. Tạo volume — bắt buộc, làm trước khi deploy

Đây là bước dễ bỏ sót nhất và **hậu quả là mất sạch dữ liệu**. Container của
hosting không giữ file: mỗi lần deploy lại, `data/app.db` và toàn bộ ảnh học sinh
biến mất. Volume là ổ đĩa lưu lâu dài.

Trong project → chuột phải canvas → **Volume** → mount vào `/app/data`.

Railway đặt code ở `/app`, nên volume phải mount vào `/app/data` để khớp với
đường dẫn `./data` mà app dùng. Mount vào `/data` là không ăn.

### 3. Đặt biến môi trường

Service → **Variables**:

| Biến | Giá trị | Vì sao cần |
|---|---|---|
| `APP_DATA` | `/app/data` | Trỏ dữ liệu vào volume |
| `BASE_URL` | `https://alotrle.xyz` | QR chứa domain thật; cookie tự bật cờ `secure` |
| `TRUST_PROXY` | `1` | Lấy đúng IP học viên, không dồn hết về IP của proxy |
| `SESSION_SECRET` | một chuỗi dài ngẫu nhiên | Giữ nguyên qua các lần deploy để không đăng xuất |
| `ADMIN_USERNAME` | tên đăng nhập bạn muốn | Tạo tài khoản đầu tiên (hosting không có terminal) |
| `ADMIN_PASSWORD` | mật khẩu ≥ 8 ký tự | Xoá biến này sau khi đăng nhập được |

`ADMIN_USERNAME` / `ADMIN_PASSWORD` **chỉ có tác dụng khi chưa có admin nào**, nên
không dùng được để đổi mật khẩu hay chiếm tài khoản có sẵn.

### 4. Nối domain

Service → **Settings** → **Networking** → **+ Custom Domain** → nhập `alotrle.xyz`.
Railway đưa **hai** bản ghi: một `CNAME` và một `TXT`.

Vào nhà cung cấp DNS của bạn (`alotrle.xyz` đang dùng nameserver `nicnames.com`)
và thêm **cả hai**. Thiếu `TXT` thì domain vẫn trả 404 dù `CNAME` đã trỏ đúng —
Railway dùng `TXT` để xác minh bạn sở hữu domain.

`alotrle.xyz` là domain gốc (apex) nên `CNAME` ở gốc cần nhà cung cấp hỗ trợ
CNAME flattening / ALIAS / ANAME. Nếu nicnames không có, chuyển DNS sang
Cloudflare (miễn phí) rồi tạo CNAME ở đó.

Chờ DNS lan (thường vài phút, có thể tới 72 giờ). Railway tự cấp SSL.

### 5. Kiểm tra

```bash
curl -i https://alotrle.xyz/healthz
```

Ra `200 OK` là xong. Đăng nhập ở `https://alotrle.xyz/admin`, rồi xoá
`ADMIN_PASSWORD` khỏi Variables.

### Lưu ý

- **Trong repo có file `CNAME`** — đó là của GitHub Pages, không liên quan tới
  Railway. Nếu bạn đã tắt GitHub Pages thì xoá file đó đi cho đỡ nhầm.
- Ảnh nằm trên volume nên **`npm run backup` chạy trên hosting không tiện**. Dùng
  nút *Tải ảnh về (ZIP)* trong web để lấy ảnh, và `railway volume files download`
  để lấy `app.db`.
- Volume có giới hạn dung lượng theo gói. Đặt `MAX_TOTAL_MB` thấp hơn dung lượng
  volume để app từ chối nhận ảnh trước khi ổ đĩa đầy.
- Redeploy service có volume sẽ **có một khoảng ngắn ngừng phục vụ** — Railway
  không cho hai deploy cùng mount một volume, tránh hỏng dữ liệu.

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

93 test. Dùng database tạm trong thư mục temp của hệ thống, không đụng vào
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
| `BASE_URL` | tự đoán từ request | Địa chỉ công khai: nhúng vào QR, và bật cờ cookie `secure` nếu là `https://` |
| `TRUST_PROXY` | — | Đặt `1` khi có proxy/tunnel, để lấy đúng IP học viên. Đừng đặt khi chạy trực tiếp |
| `HTTPS` | — | Đặt `1` để bật cookie `secure` khi `BASE_URL` không phải https |
| `SESSION_SECRET` | tự sinh, lưu vào DB | Khoá ký cookie |
| `MAX_TOTAL_MB` | `5120` | Trần dung lượng thư mục ảnh |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | Tạo admin đầu tiên khi deploy lên hosting; chỉ có tác dụng khi chưa có admin nào |
| `APP_DATA` | `./data` | Thư mục dữ liệu (trên hosting: trỏ vào volume) |
| `APP_DB` / `APP_UPLOADS` | trong `APP_DATA` | Đường dẫn riêng cho DB / ảnh |

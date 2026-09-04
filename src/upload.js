/**
 * Nhận file ảnh: kiểm tra bằng magic bytes rồi mới ghi ra đĩa.
 *
 * Dùng memoryStorage chứ không diskStorage vì fileFilter của multer KHÔNG nhận
 * được nội dung file (chỉ có mimetype do client tự khai, không tin được), nên
 * không thể sniff magic bytes ở đó. Với memoryStorage ta kiểm rồi mới ghi —
 * không để file lạ nằm trên đĩa dù chỉ một lúc.
 */
import multer from 'multer';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { UPLOADS_DIR } from './db.js';

export const MAX_FILE_BYTES = 6 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 6;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES_PER_REQUEST,
    fields: 40,
    fieldSize: 64 * 1024,
    // Chặn cả số phần của multipart: không có nó thì một request với hàng nghìn
    // phần rỗng vẫn bắt server bóc từng phần.
    parts: MAX_FILES_PER_REQUEST + 45,
  },
});

/** Nhận diện loại ảnh thật từ mấy byte đầu, bỏ qua mimetype client khai. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)/.test(brand)) return 'image/heic';
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  return null;
}

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

const EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export class ImageRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageRejected';
    this.status = 400;
  }
}

/**
 * Kiểm 1 file rồi ghi ra đĩa. Trả { storedName, mime, size, sha256 }.
 * Tên file lưu là UUID nên tự tránh được tên cấm của Windows (CON, PRN, COM1...).
 */
export async function saveImage(buffer) {
  const mime = sniffImage(buffer);

  if (mime === 'image/heic') {
    throw new ImageRejected(
      'Ảnh định dạng HEIC của iPhone không hiển thị được trên web. ' +
        'Vào Cài đặt > Camera > Định dạng > chọn "Tương thích nhất" rồi chụp lại, ' +
        'hoặc gửi ảnh qua Zalo/Messenger (sẽ tự chuyển thành JPG).',
    );
  }
  if (!mime || !ALLOWED.has(mime)) {
    throw new ImageRejected('Chỉ nhận ảnh JPG, PNG hoặc WEBP.');
  }
  if (buffer.length === 0) {
    throw new ImageRejected('File rỗng.');
  }

  // Hash đúng byte ảnh: hai người nộp cùng một file thì hash giống nhau, kể cả
  // khi đã đổi tên file. Đây là tín hiệu chống gian lận đáng tin nhất.
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  const storedName = crypto.randomUUID() + EXT[mime];
  await fs.writeFile(path.join(UPLOADS_DIR, storedName), buffer);
  noteBytesWritten(buffer.length);
  return { storedName, mime, size: buffer.length, sha256 };
}

/**
 * Đường dẫn tuyệt đối của ảnh, đã kiểm chắc chắn nằm trong UPLOADS_DIR.
 *
 * Không dùng startsWith để kiểm: "...\uploads-evil".startsWith("...\uploads")
 * là true. path.relative mới đúng.
 */
export function resolveUpload(storedName) {
  const full = path.resolve(UPLOADS_DIR, String(storedName));
  const rel = path.relative(UPLOADS_DIR, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/** Xoá file ảnh, bỏ qua nếu file đã không còn. */
export async function deleteStoredFiles(storedNames) {
  await Promise.all(
    storedNames.map(async (name) => {
      const full = resolveUpload(name);
      if (!full) return;
      await fs.unlink(full).catch(() => {});
    }),
  );
}

/** Dịch lỗi của multer thành thông báo tiếng Việt. */
export function multerErrorMessage(err) {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return `Ảnh quá lớn (tối đa ${MAX_FILE_BYTES / 1024 / 1024}MB mỗi ảnh).`;
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_PART_COUNT':
      return `Quá nhiều ảnh trong một lượt (tối đa ${MAX_FILES_PER_REQUEST}).`;
    case 'LIMIT_UNEXPECTED_FILE':
      return 'Tên trường file không đúng định dạng.';
    default:
      return 'Tải ảnh lên thất bại.';
  }
}

// ------------------------------------------------------- hạn mức dung lượng

/**
 * Trần dung lượng thư mục ảnh.
 *
 * Không có trần này thì đường nộp bài công khai có thể ghi đầy ổ đĩa: 40 học viên
 * × 6 lượt × 6 ảnh trong 10 phút là hàng GB. Mặc định 5GB, đổi qua biến môi trường.
 */
export const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_MB || 5120) * 1024 * 1024;

let cachedUsage = null;
let cachedAt = 0;
const USAGE_TTL_MS = 30 * 1000;

/** Tổng dung lượng ảnh đang lưu, có cache để không quét thư mục mỗi request. */
export async function uploadsUsage() {
  if (cachedUsage !== null && Date.now() - cachedAt < USAGE_TTL_MS) return cachedUsage;
  let total = 0;
  try {
    const names = await fs.readdir(UPLOADS_DIR);
    for (const name of names) {
      try {
        const st = await fs.stat(path.join(UPLOADS_DIR, name));
        if (st.isFile()) total += st.size;
      } catch {
        /* file vừa bị xoá */
      }
    }
  } catch {
    total = 0;
  }
  cachedUsage = total;
  cachedAt = Date.now();
  return total;
}

/** Cộng dồn vào con số đang cache, đỡ phải quét lại thư mục sau mỗi lần ghi. */
export function noteBytesWritten(n) {
  if (cachedUsage !== null) cachedUsage += n;
}

export async function assertStorageAvailable() {
  const used = await uploadsUsage();
  if (used >= MAX_TOTAL_BYTES) {
    const err = new Error(
      'Dung lượng ảnh đã đầy. Giáo viên cần tải ZIP về rồi xoá bài tập cũ để giải phóng chỗ.',
    );
    err.status = 507;
    throw err;
  }
}

// ------------------------------------------------------ giới hạn xử lý đồng thời

/**
 * Chỉ cho vài request upload chạy cùng lúc.
 *
 * memoryStorage giữ toàn bộ ảnh trong RAM, nên nhiều request song song là cách
 * đơn giản nhất để làm hết bộ nhớ server. Xếp hàng thì chậm hơn chút nhưng không sập.
 */
const MAX_CONCURRENT_UPLOADS = 3;
let active = 0;
const queue = [];

export function uploadGate(req, res, next) {
  if (active < MAX_CONCURRENT_UPLOADS) {
    active++;
    finishOnResponse(res);
    return next();
  }
  if (queue.length > 40) {
    return res.status(503).json({ error: 'Máy chủ đang quá tải. Chờ một lát rồi nộp lại.' });
  }
  queue.push(() => {
    active++;
    finishOnResponse(res);
    next();
  });
}

function finishOnResponse(res) {
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    active--;
    const nextInQueue = queue.shift();
    if (nextInQueue) nextInQueue();
  };
  res.on('finish', release);
  res.on('close', release);
}

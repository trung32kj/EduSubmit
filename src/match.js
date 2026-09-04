/**
 * Đoán xem một file ảnh là của học viên nào, dựa vào tên file.
 *
 * Thực tế: ảnh tải từ Zalo/Messenger thường tên kiểu IMG_20260831_120301.jpg,
 * KHÔNG chứa tên người. Nên tỉ lệ đoán được sẽ thấp và bảng xác nhận ở
 * bulk.html là UI chính, không phải tiện ích phụ. Nguyên tắc: thà để trống
 * còn hơn đoán bừa.
 */
import { normalize, squash, tokens, lastToken } from './norm.js';

/** Ngưỡng để tự chọn sẵn: điểm cao và bỏ xa ứng viên thứ nhì. */
export const AUTO_SCORE = 0.7;
export const AUTO_MARGIN = 0.15;

/**
 * Rút phần có thể là tên người ra khỏi tên file.
 *
 * Thứ tự BẮT BUỘC: bỏ dấu (ASCII-fold) TRƯỚC, rồi mới cắt tiền tố.
 * \W = [^A-Za-z0-9_] nên nó ăn luôn chữ Việt: "Đỗ Đình Đạt.HEIC" nếu cắt
 * trước sẽ thành "nh dat" -> mọi bạn tên Đặng/Đỗ/Đinh/Đoàn đều đoán sai.
 */
export function nameFromFilename(filename) {
  const base = String(filename ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '');

  const cleaned = normalize(base)
    .replace(/[._\-+]+/g, ' ')
    // Bỏ mọi ký tự không phải chữ/số còn lại: "(1)", "[copy]", "#2"...
    .replace(/[^a-z0-9 ]+/g, ' ');

  // Từ khoá vô nghĩa mà điện thoại / app chat / admin tự thêm vào tên file.
  const NOISE = new Set([
    'img', 'image', 'photo', 'picture', 'pic', 'screenshot', 'scr', 'dsc', 'vid', 'video',
    'zalo', 'messenger', 'fb', 'viber', 'whatsapp', 'telegram',
    'received', 'download', 'downloaded', 'copy', 'final', 'new', 'at', 'of',
    'baitap', 'bt', 'nop', 'bai', 'tap', 'assignment', 'hw', 'homework',
    'tuan', 'ngay', 'buoi', 'lop', 'anh',
  ]);

  const out = [];
  for (const raw of cleaned.split(' ')) {
    if (!raw) continue;
    // Cắt chữ số ở hai đầu: "dodinhdat2" -> "dodinhdat" (đặt tên kiểu này rất
    // hay gặp), "dsc00123" -> "dsc" (rồi bị lọc như từ khoá rác).
    const tok = raw.replace(/^\d+/, '').replace(/\d+$/, '');
    // Còn số ở giữa hoặc rỗng -> là ngày tháng / mã máy ảnh, không phải tên người.
    if (!tok || /\d/.test(tok)) continue;
    if (NOISE.has(tok)) continue;
    out.push(tok);
  }

  return out.join(' ');
}

/** Điểm giống nhau giữa tên rút từ file và tên 1 học viên, trong [0,1]. */
export function scoreCandidate(guess, student) {
  const g = normalize(guess);
  if (!g) return 0;

  const sNorm = student.name_normalized || normalize(student.name);
  const sSquash = student.name_squashed || squash(student.name);

  if (g === sNorm) return 1;

  const gSquash = squash(guess);
  // "nguyenvana.jpg" -> khớp "Nguyễn Văn A"
  if (gSquash && gSquash === sSquash) return 0.97;

  const gTokens = tokens(guess);
  const sTokens = sNorm ? sNorm.split(' ') : [];
  if (!gTokens.length || !sTokens.length) return 0;

  const sSet = new Set(sTokens);
  const matched = gTokens.filter((t) => sSet.has(t));

  // Tên học viên nằm trọn trong tên file (kèm rác): "zalo bai tap Nguyen Van A"
  if (sTokens.every((t) => gTokens.includes(t))) {
    return sTokens.length >= 2 ? 0.92 : 0.6;
  }

  // Tên file nằm trọn trong tên học viên: "Van A" -> "Nguyễn Văn A"
  if (gTokens.every((t) => sSet.has(t)) && gTokens.length >= 2) return 0.85;

  if (!matched.length) {
    // Tên file dạng liền không dấu chứa trọn tên học viên.
    if (gSquash.length >= 6 && gSquash.includes(sSquash)) return 0.8;
    return 0;
  }

  const overlap = matched.length / Math.max(gTokens.length, sTokens.length);

  // Khớp đúng tên riêng (token cuối) đáng tin hơn khớp họ, vì cả lớp họ Nguyễn.
  const given = lastToken(student.name);
  const bonus = given && gTokens.includes(given) ? 0.15 : 0;

  // Một token trùng mà lại là họ phổ biến thì gần như vô nghĩa.
  if (matched.length === 1 && !bonus) return Math.min(0.45, overlap);

  return Math.min(0.9, overlap + bonus);
}

/**
 * Đoán cho 1 tên file. Trả { filename, guess, candidates[], studentId, confidence, ambiguous }.
 * studentId = null nghĩa là để admin tự chọn.
 */
export function matchFilename(filename, students, ambiguousNorms) {
  const guess = nameFromFilename(filename);

  const scored = students
    .map((s) => ({ id: s.id, name: s.name, note: s.note ?? '', score: scoreCandidate(guess, s) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'vi'));

  const candidates = scored.slice(0, 3);
  const top = candidates[0];
  const second = candidates[1];

  let studentId = null;
  let ambiguous = false;

  if (top) {
    const topStudent = students.find((s) => s.id === top.id);
    // Trùng tên với bạn khác -> không bao giờ tự chọn, kể cả điểm 1.0.
    const collides = ambiguousNorms?.has(topStudent?.name_normalized);
    const margin = top.score - (second?.score ?? 0);
    if (collides) {
      ambiguous = true;
    } else if (top.score >= AUTO_SCORE && margin >= AUTO_MARGIN) {
      studentId = top.id;
    }
  }

  return {
    filename: String(filename ?? ''),
    guess,
    candidates,
    studentId,
    confidence: top ? Number(top.score.toFixed(2)) : 0,
    ambiguous,
  };
}

/** Tập các name_normalized xuất hiện nhiều hơn 1 lần trong danh sách. */
export function findAmbiguousNames(students) {
  const count = new Map();
  for (const s of students) {
    const key = s.name_normalized || normalize(s.name);
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
}

/** Đoán cho cả danh sách tên file. */
export function matchFilenames(filenames, students) {
  const ambiguousNorms = findAmbiguousNames(students);
  return filenames.map((f) => matchFilename(f, students, ambiguousNorms));
}

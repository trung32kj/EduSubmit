/** Tiện ích dùng chung cho các route. */
import { normalize, squash, escapeLike, lastToken } from './norm.js';
import { all } from './db.js';

/**
 * Tìm các ảnh bị nộp trùng trong cùng một bài tập.
 *
 * Hai người nộp đúng cùng một file (chuyển cho nhau qua Zalo rồi mỗi người nộp)
 * sẽ có sha256 giống nhau, kể cả khi đã đổi tên file. Đây là tín hiệu chống gian
 * lận đáng tin nhất vì nó dựa trên nội dung ảnh, không dựa vào thứ gì phía client.
 *
 * Chỉ so trong PHẠM VI MỘT BÀI TẬP: cùng một bạn nộp lại ảnh cũ cho bài khác là
 * chuyện bình thường, không phải gian lận.
 *
 * Trả Map: sha256 -> [{ studentId, studentName, note, imageId, submissionId }]
 * chỉ gồm các hash xuất hiện ở NHIỀU HƠN MỘT học viên.
 */
export function findDuplicateImages(assignmentId) {
  const rows = all(
    `SELECT i.id AS image_id, i.sha256, i.submission_id,
            st.id AS student_id, st.name, st.note
     FROM submission_images i
     JOIN submissions sub ON sub.id = i.submission_id
     JOIN students st ON st.id = sub.student_id
     WHERE sub.assignment_id = ? AND i.sha256 IS NOT NULL
     ORDER BY i.id`,
    assignmentId,
  );

  const byHash = new Map();
  for (const r of rows) {
    if (!byHash.has(r.sha256)) byHash.set(r.sha256, []);
    byHash.get(r.sha256).push({
      imageId: r.image_id,
      submissionId: r.submission_id,
      studentId: r.student_id,
      studentName: r.name,
      note: r.note,
    });
  }

  const dups = new Map();
  for (const [hash, items] of byHash) {
    // Cùng một bạn nộp 2 lần cùng một ảnh chỉ là lỡ tay, không phải gian lận.
    const distinctStudents = new Set(items.map((i) => i.studentId));
    if (distinctStudents.size > 1) dups.set(hash, items);
  }
  return dups;
}

/**
 * Bài tập còn nhận bài nộp không.
 *
 * Một hàm duy nhất cho cả API meta và API submit, để trang nộp không bao giờ
 * hiện "còn mở" trong khi server lại chặn. Đường admin upload hộ KHÔNG gọi hàm
 * này (admin vẫn nộp hộ được sau hạn).
 */
export function isOpen(assignment) {
  if (!assignment) return false;
  if (assignment.is_closed) return false;
  if (assignment.due_at == null) return true;
  return Date.now() <= assignment.due_at;
}

export function assignmentPublic(a) {
  return {
    title: a.title,
    description: a.description,
    dueAt: a.due_at,
    isClosed: !!a.is_closed,
    isOpen: isOpen(a),
    // Chỉ nói CÓ hay KHÔNG cần PIN, không bao giờ trả giá trị PIN ra ngoài.
    needsPin: !!a.pin,
  };
}

/** Đọc 1 giá trị chuỗi từ query/body: ?q=a&q=b cho array, bind array sẽ throw 500. */
export function str(value, maxLen = 500) {
  if (typeof value !== 'string') return null;
  return value.slice(0, maxLen);
}

export function intId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Đọc mốc thời gian: nhận epoch ms hoặc chuỗi datetime-local. */
export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (value.trim() !== '' && Number.isFinite(asNum) && /^\d+$/.test(value.trim())) {
      return Math.trunc(asNum);
    }
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const badRequest = (msg) => new HttpError(400, msg);
export const notFound = (msg = 'Không tìm thấy') => new HttpError(404, msg);

/**
 * Tìm học viên theo tên gõ vào, tối đa `limit` kết quả.
 *
 * Chỉ truy vấn trên name_normalized / name_squashed: LIKE và LOWER của SQLite
 * chỉ hiểu ASCII ('NGUYỄN' LIKE '%nguyễn%' = 0) nên tìm trên cột name thô sẽ
 * phân biệt chữ hoa/thường ở các ký tự có dấu.
 *
 * Xếp hạng ưu tiên khớp tên riêng (token cuối): người Việt tự gọi mình bằng tên
 * riêng, gõ "Vy" phải ra "Trần Tường Vy". Tìm theo prefix vô dụng vì cả lớp họ Nguyễn.
 *
 * classId: giới hạn trong một lớp. BẮT BUỘC truyền ở trang nộp bài của học viên,
 * nếu không thì học viên lớp A gõ tên sẽ thấy tên các bạn lớp B.
 */
export function searchStudents(q, limit = 8, classId = undefined) {
  const nq = normalize(q);
  const sq = squash(q);
  if (!nq) return [];

  const scopeClause = classId === undefined ? '' : 'AND class_id IS ?';
  const params = [`%${escapeLike(nq)}%`, `%${escapeLike(sq)}%`];
  if (classId !== undefined) params.push(classId);

  const rows = all(
    `SELECT id, name, note, name_normalized, name_squashed
     FROM students
     WHERE is_active = 1
       AND (name_normalized LIKE ? ESCAPE '\\' OR name_squashed LIKE ? ESCAPE '\\')
       ${scopeClause}
     LIMIT 200`,
    ...params,
  );

  const scored = rows.map((r) => {
    let rank = 0;
    if (r.name_normalized === nq || r.name_squashed === sq) rank = 100;
    else if (lastToken(r.name).startsWith(nq)) rank = 80;
    else if (r.name_normalized.startsWith(nq)) rank = 60;
    else if (r.name_squashed.includes(sq)) rank = 40;
    else rank = 20;
    return { ...r, rank };
  });

  scored.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name, 'vi'));

  // Đánh dấu các tên trùng nhau để giao diện hiện note làm dấu phân biệt và
  // không tự chọn giúp.
  const count = new Map();
  for (const r of scored) count.set(r.name_normalized, (count.get(r.name_normalized) ?? 0) + 1);

  return scored.slice(0, limit).map((r) => ({
    id: r.id,
    name: r.name,
    note: r.note,
    duplicate: (count.get(r.name_normalized) ?? 0) > 1,
  }));
}

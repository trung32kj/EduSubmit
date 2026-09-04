/** API cho học viên nộp bài (không cần đăng nhập). */
import express from 'express';
import crypto from 'node:crypto';
import { get, run, getReturning, tx } from '../db.js';
import { displayName } from '../norm.js';
import {
  isOpen,
  assignmentPublic,
  str,
  intId,
  badRequest,
  notFound,
  searchStudents,
  HttpError,
} from '../shared.js';
import { createRateLimiter } from '../ratelimit.js';
import {
  upload,
  uploadGate,
  saveImage,
  deleteStoredFiles,
  assertStorageAvailable,
  ImageRejected,
} from '../upload.js';

export const publicRouter = express.Router();

/**
 * Giới hạn tần suất nộp, tính theo (bài tập, học viên) — KHÔNG theo IP.
 * Cả lớp dùng chung 1 Wi-Fi nên chung 1 IP; giới hạn theo IP sẽ chặn từ bạn thứ
 * 5 trở đi. Giới hạn theo IP để rất rộng, chỉ để cản việc spam thật sự.
 */
const perStudent = createRateLimiter({ max: 6, windowMs: 10 * 60 * 1000 });
const perIp = createRateLimiter({ max: 300, windowMs: 10 * 60 * 1000 });
// Tìm tên: cả lớp cùng gõ nên phải rộng, nhưng vẫn phải có — nếu không thì chỉ
// cần lặp vài trăm cặp chữ cái là dò ra toàn bộ danh sách lớp.
const searchPerIp = createRateLimiter({ max: 240, windowMs: 10 * 60 * 1000 });
// Dò PIN: 4 số chỉ có 10.000 khả năng, không giới hạn thì thử hết trong vài phút.
const pinPerIp = createRateLimiter({ max: 12, windowMs: 10 * 60 * 1000 });

/**
 * Kiểm mã PIN của bài tập.
 *
 * Khi web mở ra internet, link nộp bài chỉ là một chuỗi — ai có nó là vào được.
 * PIN là thứ chỉ người trong lớp biết. Bài tập không đặt PIN thì bỏ qua bước này.
 *
 * PIN đọc từ query hoặc header `x-pin`, KHÔNG từ body: hàm này chạy trước multer
 * (để request sai PIN không nạp cả trăm MB ảnh vào RAM), mà lúc đó body multipart
 * còn chưa được bóc nên `req.body` rỗng. Riêng bước xác nhận PIN (JSON) thì body
 * đã có sẵn nhờ express.json().
 *
 * PIN đã đúng một lần thì ghi vào session để học viên không phải gõ lại mỗi lần
 * nộp thêm ảnh.
 */
function checkPin(req, a) {
  if (!a.pin) return;

  const okKey = `pin_ok_${a.id}`;
  if (req.session?.[okKey]) return;

  const given = str(req.query.pin ?? req.get('x-pin') ?? req.body?.pin, 20)?.trim();
  if (!given) throw new HttpError(401, 'Bài tập này cần mã PIN. Hỏi giáo viên mã của lớp.');

  if (!pinPerIp.take(`pin:${a.id}:${req.ip ?? ''}`)) {
    throw new HttpError(429, 'Nhập sai mã PIN quá nhiều lần. Chờ một lát rồi thử lại.');
  }

  // PIN chỉ 4 số nên so sánh thời gian hằng không thêm nhiều giá trị, nhưng vẫn
  // dùng cho nhất quán và để không rò rỉ độ dài.
  const a1 = Buffer.from(String(given));
  const b1 = Buffer.from(String(a.pin));
  const ok = a1.length === b1.length && crypto.timingSafeEqual(a1, b1);
  if (!ok) throw new HttpError(401, 'Mã PIN không đúng.');

  if (req.session) req.session[okKey] = true;
}

function getAssignmentBySlug(slug) {
  const s = str(slug, 40);
  if (!s) throw badRequest('Link không hợp lệ');
  const a = get('SELECT * FROM assignments WHERE slug = ?', s);
  if (!a) throw notFound('Link nộp bài không tồn tại');
  return a;
}

/**
 * Nạp bài tập và kiểm còn nhận bài không, TRƯỚC khi multer đọc body.
 *
 * Nếu để multer chạy trước thì một request tới slug không tồn tại, tới bài tập đã
 * đóng, hay từ người đã vượt giới hạn vẫn khiến server nạp cả trăm MB ảnh vào RAM
 * rồi mới từ chối — vài request song song là đủ làm hết bộ nhớ.
 */
function loadOpenAssignment(req, res, next) {
  const a = getAssignmentBySlug(req.params.slug);
  if (!isOpen(a)) {
    throw new HttpError(
      403,
      a.is_closed
        ? 'Bài tập đã đóng, không nhận thêm bài nộp.'
        : 'Đã quá hạn nộp bài. Liên hệ giáo viên để được nộp bù.',
    );
  }
  req.assignment = a;
  next();
}

/** Kiểm hạn mức trước khi nhận byte nào của ảnh. */
async function checkQuota(req, res, next) {
  const a = req.assignment;
  const studentId = intId(req.query.studentId ?? req.get('x-student-id'));
  const ip = req.ip ?? '';

  if (!perIp.take(`ip:${ip}`)) {
    throw new HttpError(429, 'Máy chủ đang nhận quá nhiều bài nộp. Chờ một lát rồi thử lại.');
  }
  // studentId thật nằm trong body (multer chưa đọc), nên ở đây chỉ dùng được giá
  // trị client gửi kèm ở query/header. Không tin được nhưng vẫn hữu ích: người
  // dùng thật luôn gửi đúng, còn kẻ spam thì đã bị chặn bởi hạn mức IP.
  if (studentId && !perStudent.take(`s:${a.id}:${studentId}`)) {
    throw new HttpError(429, 'Bạn đã nộp quá nhiều lần trong ít phút. Chờ một lát rồi thử lại.');
  }
  // Ổ đĩa đã đầy thì từ chối trước khi nạp ảnh vào RAM.
  await assertStorageAvailable();
  next();
}

/**
 * Kiểm PIN trước khi cho tra tên hoặc nộp bài.
 *
 * Đặt TRƯỚC multer: nếu để sau thì một request sai PIN vẫn khiến server nạp cả
 * trăm MB ảnh vào RAM rồi mới từ chối.
 */
function requirePin(req, res, next) {
  checkPin(req, req.assignment);
  next();
}

publicRouter.get('/a/:slug', (req, res) => {
  const a = getAssignmentBySlug(req.params.slug);
  res.json({ assignment: assignmentPublic(a) });
});

/** Xác nhận PIN riêng một bước, để trang nộp bài hỏi PIN trước khi chọn ảnh. */
publicRouter.post('/a/:slug/pin', (req, res) => {
  const a = getAssignmentBySlug(req.params.slug);
  if (!a.pin) return res.json({ ok: true, needsPin: false });
  checkPin(req, a);
  res.json({ ok: true, needsPin: true });
});

/**
 * Gợi ý tên học viên. Không bao giờ trả cả danh sách lớp.
 *
 * Yêu cầu tối thiểu 2 ký tự và có giới hạn tần suất: LIKE '%q%' với q 1 ký tự thì
 * chỉ cần lặp bảng chữ cái là dò được gần hết danh sách lớp — mà đó là thông tin
 * cá nhân của học sinh.
 */
publicRouter.get('/a/:slug/students', (req, res) => {
  const a = getAssignmentBySlug(req.params.slug);
  // Đóng bài rồi thì không cần tra tên nữa; để mở là để ngỏ đường dò danh sách.
  if (!isOpen(a)) return res.json({ students: [] });

  // Bài tập có PIN thì phải qua PIN mới tra được tên — nếu không thì danh sách lớp
  // vẫn dò được dù đã đặt PIN, mà đó là thứ PIN cần bảo vệ nhất.
  checkPin(req, a);

  if (!searchPerIp.take(`q:${req.ip ?? ''}`)) {
    throw new HttpError(429, 'Bạn tìm quá nhiều lần. Chờ một lát rồi thử lại.');
  }

  // ?q=a&q=b cho array: bind array vào node:sqlite sẽ throw -> 500. Chặn ở đây.
  const q = str(req.query.q, 64);
  if (q === null) throw badRequest('Thiếu tham số q');
  const trimmed = q.trim();
  if (trimmed.length < 2) return res.json({ students: [], hint: 'Gõ ít nhất 2 chữ' });
  // Giới hạn trong lớp của bài tập: học viên lớp A không được thấy tên lớp B.
  res.json({ students: searchStudents(trimmed, 8, a.class_id) });
});

/**
 * Học viên nộp ảnh.
 *
 * Chặn nếu bài tập đã đóng hoặc quá hạn (yêu cầu 7) — kiểm ở middleware phía
 * trước multer. Ghép ảnh với học viên bằng fieldname như đường bulk của admin,
 * dù ở đây chỉ có 1 học viên.
 */
publicRouter.post(
  '/a/:slug/submit',
  loadOpenAssignment,
  // PIN trước quota: sai PIN thì không nên bị trừ lượt nộp.
  requirePin,
  checkQuota,
  // Xếp hàng: memoryStorage giữ ảnh trong RAM nên nhiều request song song sẽ
  // làm hết bộ nhớ. Đặt SAU checkQuota để request bị từ chối không phải chờ.
  uploadGate,
  upload.any(),
  async (req, res) => {
    const a = req.assignment;

    const studentId = intId(req.body?.studentId);
    if (!studentId) throw badRequest('Chưa chọn tên của bạn trong danh sách');
    const student = get('SELECT * FROM students WHERE id = ? AND is_active = 1', studentId);
    if (!student) throw badRequest('Không tìm thấy tên này trong danh sách lớp');
    // Chặn nộp chéo lớp: client có thể gửi studentId bất kỳ, không chỉ id mà
    // autocomplete trả về.
    if (a.class_id != null && student.class_id !== a.class_id) {
      throw badRequest('Bạn không thuộc lớp của bài tập này.');
    }

    const files = req.files ?? [];
    if (!files.length) throw badRequest('Chưa chọn ảnh nào');

    const ip = req.ip ?? '';
    // Lần này với studentId thật từ body — khoá này mới là khoá không lách được.
    if (!perStudent.take(`s:${a.id}:${studentId}`)) {
      throw new HttpError(429, 'Bạn đã nộp quá nhiều lần trong ít phút. Chờ một lát rồi thử lại.');
    }

    const typedName = displayName(str(req.body?.typedName, 200) ?? '');
    const userAgent = str(req.get('user-agent'), 300) ?? '';
    const now = Date.now();

    // Một trình duyệt chỉ được nộp thay tối đa 2 bạn cho mỗi bài tập.
    // Link nộp bài không xác định được người nộp, nên đây là chốt duy nhất cản
    // việc một người lần lượt nộp rác dưới tên cả lớp. Cho 2 chứ không phải 1 vì
    // có nhà hai chị em dùng chung điện thoại.
    const submittedKey = `a${a.id}`;
    const already = req.session.submitted?.[submittedKey] ?? [];
    if (!already.includes(studentId) && already.length >= 2) {
      throw new HttpError(
        429,
        'Điện thoại này đã nộp bài cho 2 bạn khác trong bài tập này. ' +
          'Nếu cần nộp thêm cho bạn khác, nhờ giáo viên tải ảnh lên hộ.',
      );
    }

    const saved = [];
    const errors = [];
    try {
      for (const file of files) {
        try {
          const info = await saveImage(file.buffer);
          saved.push({ ...info, originalName: file.originalname ?? '' });
        } catch (err) {
          if (err instanceof ImageRejected) {
            errors.push({ name: file.originalname, error: err.message });
          } else {
            throw err;
          }
        }
      }

      if (!saved.length) {
        // Không ảnh nào hợp lệ -> đừng tạo bài nộp rỗng, và đừng đưa bài đã duyệt
        // về lại trạng thái chờ duyệt.
        throw new HttpError(400, errors[0]?.error ?? 'Không nhận được ảnh hợp lệ.');
      }

      const result = tx(() => {
        // Bài đã DUYỆT ĐẠT thì KHÔNG bị kéo về 'pending'.
        // Ai có link cũng nộp được dưới tên bất kỳ, nên nếu reset trạng thái thì
        // một request là đủ xoá sạch công chấm bài của cả lớp. Giáo viên vẫn thấy
        // ảnh mới (bảng tổng hợp so thời điểm ảnh với reviewed_at để gắn nhãn).
        const sub = getReturning(
          `INSERT INTO submissions
             (assignment_id, student_id, status, submitted_at, attempt_no, typed_name, ip, user_agent)
           VALUES (?, ?, 'pending', ?, 1, ?, ?, ?)
           ON CONFLICT(assignment_id, student_id) DO UPDATE SET
             attempt_no = submissions.attempt_no + 1,
             status = CASE WHEN submissions.status = 'approved' THEN 'approved' ELSE 'pending' END,
             reviewed_at = CASE WHEN submissions.status = 'approved' THEN submissions.reviewed_at ELSE NULL END,
             submitted_at = excluded.submitted_at
           RETURNING id, attempt_no, status`,
          a.id,
          studentId,
          now,
          typedName,
          ip,
          userAgent,
        );

        for (const item of saved) {
          run(
            `INSERT INTO submission_images
               (submission_id, stored_name, original_name, size_bytes, mime, attempt_no,
                uploaded_by, sha256, typed_name, ip, user_agent, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'student', ?, ?, ?, ?, ?)`,
            sub.id,
            item.storedName,
            item.originalName,
            item.size,
            item.mime,
            sub.attempt_no,
            item.sha256,
            typedName,
            ip,
            userAgent,
            now,
          );
        }
        return sub;
      });

      // Ghi nhận trình duyệt này đã nộp cho bạn nào (chỉ tạo session khi nộp
      // thật, nên xem trang không sinh ra hàng session rác).
      if (!req.session.submitted) req.session.submitted = {};
      if (!req.session.submitted[submittedKey]) req.session.submitted[submittedKey] = [];
      if (!req.session.submitted[submittedKey].includes(studentId)) {
        req.session.submitted[submittedKey].push(studentId);
      }

      res.json({
        ok: true,
        studentName: student.name,
        savedCount: saved.length,
        attemptNo: result.attempt_no,
        alreadyApproved: result.status === 'approved',
        errors,
      });
    } catch (err) {
      await deleteStoredFiles(saved.map((s) => s.storedName));
      throw err;
    }
  },
);

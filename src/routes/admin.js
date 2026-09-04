/** API cho admin. Mọi route ở đây đã qua requireAdmin ở server.js. */
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { all, get, run, getReturning, tx } from '../db.js';
import { displayName, normalize, squash, parseRoster, safeFileName } from '../norm.js';
import { matchFilenames } from '../match.js';
import {
  isOpen,
  str,
  intId,
  parseTimestamp,
  badRequest,
  notFound,
  searchStudents,
  findDuplicateImages,
} from '../shared.js';
import {
  upload,
  uploadGate,
  saveImage,
  deleteStoredFiles,
  resolveUpload,
  assertStorageAvailable,
  uploadsUsage,
  MAX_TOTAL_BYTES,
  ImageRejected,
} from '../upload.js';
import { createZipStream } from '../zip.js';

export const adminRouter = express.Router();

// ------------------------------------------------------------------- lớp

/**
 * Đọc tham số lớp từ query/body.
 * - undefined  -> không lọc (xem tất cả các lớp)
 * - null       -> chỉ những bản ghi chưa gán lớp
 * - số         -> lớp cụ thể
 */
function classScope(value) {
  if (value === undefined || value === '') return undefined;
  if (value === null || value === 'null' || value === 'none') return null;
  const id = intId(value);
  if (!id) throw badRequest('classId không hợp lệ');
  if (!get('SELECT id FROM classes WHERE id = ?', id)) throw notFound('Không có lớp này');
  return id;
}

adminRouter.get('/classes', (req, res) => {
  const rows = all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM students WHERE class_id = c.id AND is_active = 1) AS student_count,
            (SELECT COUNT(*) FROM assignments WHERE class_id = c.id) AS assignment_count
     FROM classes c
     ORDER BY c.is_active DESC, c.name COLLATE NOCASE`,
  );
  // Dữ liệu chưa gán lớp vẫn phải thấy được, nếu không nó biến mất khỏi giao diện.
  const unassigned = get(
    'SELECT COUNT(*) AS n FROM students WHERE class_id IS NULL AND is_active = 1',
  ).n;
  res.json({
    classes: rows.map((c) => ({
      id: c.id,
      name: c.name,
      note: c.note,
      isActive: !!c.is_active,
      studentCount: c.student_count,
      assignmentCount: c.assignment_count,
    })),
    unassignedStudents: unassigned,
  });
});

adminRouter.post('/classes', (req, res) => {
  const name = displayName(str(req.body?.name, 100) ?? '');
  if (!name) throw badRequest('Cần có tên lớp');
  const row = getReturning(
    'INSERT INTO classes (name, note, is_active, created_at) VALUES (?, ?, 1, ?) RETURNING *',
    name,
    str(req.body?.note, 200) ?? '',
    Date.now(),
  );
  res.status(201).json({ class: { id: row.id, name: row.name, note: row.note, isActive: true } });
});

adminRouter.patch('/classes/:id', (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const existing = get('SELECT * FROM classes WHERE id = ?', id);
  if (!existing) throw notFound('Không có lớp này');

  const name = req.body?.name === undefined ? null : displayName(str(req.body.name, 100) ?? '');
  if (name !== null && !name) throw badRequest('Tên lớp không được để trống');

  const row = getReturning(
    'UPDATE classes SET name = ?, note = ?, is_active = ? WHERE id = ? RETURNING *',
    name ?? existing.name,
    req.body?.note === undefined ? existing.note : (str(req.body.note, 200) ?? ''),
    req.body?.isActive === undefined ? existing.is_active : !!req.body.isActive,
    id,
  );
  res.json({ class: { id: row.id, name: row.name, note: row.note, isActive: !!row.is_active } });
});

/**
 * Xoá lớp. Bài tập của lớp bị xoá theo (ON DELETE CASCADE) nên phải xoá cả ảnh
 * trên đĩa; học viên chỉ bị bỏ khỏi lớp (ON DELETE SET NULL) chứ không mất.
 */
adminRouter.delete('/classes/:id', async (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  if (!get('SELECT id FROM classes WHERE id = ?', id)) throw notFound('Không có lớp này');

  const files = all(
    `SELECT i.stored_name FROM submission_images i
     JOIN submissions s ON s.id = i.submission_id
     JOIN assignments a ON a.id = s.assignment_id
     WHERE a.class_id = ?`,
    id,
  ).map((r) => r.stored_name);

  const studentCount = get('SELECT COUNT(*) AS n FROM students WHERE class_id = ?', id).n;
  const assignmentCount = get('SELECT COUNT(*) AS n FROM assignments WHERE class_id = ?', id).n;

  run('DELETE FROM classes WHERE id = ?', id);
  await deleteStoredFiles(files);
  res.json({ ok: true, removedAssignments: assignmentCount, keptStudents: studentCount, removedFiles: files.length });
});

// ---------------------------------------------------------------- học viên

adminRouter.get('/students', (req, res) => {
  const includeInactive = str(req.query.all) === '1';
  const classId = classScope(req.query.classId);

  const where = [];
  const params = [];
  if (!includeInactive) where.push('s.is_active = 1');
  if (classId !== undefined) {
    // IS thay vì = để so được với NULL (lọc "chưa gán lớp").
    where.push('s.class_id IS ?');
    params.push(classId);
  }

  const rows = all(
    `SELECT s.id, s.name, s.note, s.group_name, s.is_active, s.name_normalized, s.class_id,
            c.name AS class_name,
            (SELECT COUNT(*) FROM submissions WHERE student_id = s.id) AS submission_count
     FROM students s
     LEFT JOIN classes c ON c.id = s.class_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.name COLLATE NOCASE`,
    ...params,
  );
  // Đánh dấu tên trùng để giao diện nhắc admin điền ghi chú phân biệt.
  const count = new Map();
  for (const r of rows) count.set(r.name_normalized, (count.get(r.name_normalized) ?? 0) + 1);
  res.json({
    students: rows.map((r) => ({
      id: r.id,
      name: r.name,
      note: r.note,
      groupName: r.group_name,
      classId: r.class_id,
      className: r.class_name,
      isActive: !!r.is_active,
      submissionCount: r.submission_count,
      duplicate: (count.get(r.name_normalized) ?? 0) > 1,
    })),
  });
});

/** Thêm nhiều học viên từ text dán vào hoặc nội dung file CSV. */
adminRouter.post('/students/import', (req, res) => {
  const text = str(req.body?.text, 200_000);
  const groupName = str(req.body?.groupName, 100) || null;
  const classId = classScope(req.body?.classId) ?? null;
  if (!text || !text.trim()) throw badRequest('Chưa có tên nào.');

  const parsed = parseRoster(text);
  if (!parsed.length) throw badRequest('Không đọc được tên nào từ nội dung đã dán.');

  const now = Date.now();
  // Một transaction cho cả danh sách: lỗi giữa đường thì không để lại
  // danh sách nhập nửa vời.
  const result = tx(() => {
    const insert = 'INSERT INTO students (name, name_normalized, name_squashed, note, group_name, class_id, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)';
    let added = 0;
    const duplicatesInDb = [];
    const seenInPaste = new Map();

    for (const item of parsed) {
      const norm = normalize(item.name);
      if (!norm) continue;

      // Trùng ngay trong nội dung dán: rất có thể là dán 2 lần, bỏ qua bản sau
      // nếu ghi chú cũng giống nhau.
      const key = norm + '|' + normalize(item.note);
      if (seenInPaste.has(key)) continue;
      seenInPaste.set(key, true);

      // Trùng tên chỉ tính TRONG CÙNG LỚP: hai lớp khác nhau có bạn cùng tên là
      // chuyện bình thường, không cần cảnh báo.
      const existing = get(
        'SELECT id, note FROM students WHERE name_normalized = ? AND is_active = 1 AND class_id IS ?',
        norm,
        classId,
      );
      // Cho phép trùng tên (lớp Việt Nam hay có), nhưng báo lại để admin biết
      // mà điền ghi chú phân biệt.
      if (existing) duplicatesInDb.push(item.name);

      run(insert, displayName(item.name), norm, squash(item.name), item.note ?? '', groupName, classId, now);
      added++;
    }
    return { added, duplicatesInDb };
  });

  res.json({
    added: result.added,
    skipped: parsed.length - result.added,
    duplicates: result.duplicatesInDb,
  });
});

adminRouter.patch('/students/:id', (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const existing = get('SELECT * FROM students WHERE id = ?', id);
  if (!existing) throw notFound('Không có học viên này');

  const name = req.body?.name === undefined ? null : displayName(str(req.body.name, 200) ?? '');
  const note = req.body?.note === undefined ? null : (str(req.body.note, 200) ?? '');
  const groupName = req.body?.groupName === undefined ? undefined : str(req.body.groupName, 100);
  const isActive = req.body?.isActive === undefined ? undefined : !!req.body.isActive;
  const classId = req.body?.classId === undefined ? undefined : classScope(req.body.classId) ?? null;

  if (name !== null && !name) throw badRequest('Tên không được để trống');

  run(
    `UPDATE students
     SET name = ?, name_normalized = ?, name_squashed = ?, note = ?, group_name = ?, class_id = ?, is_active = ?
     WHERE id = ?`,
    name ?? existing.name,
    name ? normalize(name) : existing.name_normalized,
    name ? squash(name) : existing.name_squashed,
    note ?? existing.note,
    groupName === undefined ? existing.group_name : groupName,
    classId === undefined ? existing.class_id : classId,
    isActive === undefined ? existing.is_active : isActive,
    id,
  );
  res.json({ ok: true });
});

/** Xoá học viên. Có bài nộp thì chỉ ẩn đi, trừ khi ép xoá hẳn. */
adminRouter.delete('/students/:id', async (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const force = str(req.query.force) === '1';

  const count = get('SELECT COUNT(*) AS n FROM submissions WHERE student_id = ?', id).n;
  if (count > 0 && !force) {
    run('UPDATE students SET is_active = 0 WHERE id = ?', id);
    return res.json({ ok: true, deactivated: true, submissionCount: count });
  }

  // Thu tên file TRƯỚC khi xoá: cascade dọn hàng trong DB nhưng không xoá
  // file trên đĩa.
  const files = all(
    `SELECT i.stored_name FROM submission_images i
     JOIN submissions s ON s.id = i.submission_id
     WHERE s.student_id = ?`,
    id,
  ).map((r) => r.stored_name);

  run('DELETE FROM students WHERE id = ?', id);
  await deleteStoredFiles(files);
  res.json({ ok: true, deleted: true, removedFiles: files.length });
});

adminRouter.get('/students/search', (req, res) => {
  const q = str(req.query.q, 64);
  if (q === null) throw badRequest('Thiếu tham số q');
  const classId = classScope(req.query.classId);
  res.json({ students: searchStudents(q, 8, classId) });
});

/** Dung lượng ảnh đang dùng, để admin biết khi nào cần dọn. */
adminRouter.get('/storage', async (req, res) => {
  const used = await uploadsUsage();
  const perAssignment = all(
    `SELECT a.id, a.title, COUNT(i.id) AS images, COALESCE(SUM(i.size_bytes), 0) AS bytes
     FROM assignments a
     LEFT JOIN submissions s ON s.assignment_id = a.id
     LEFT JOIN submission_images i ON i.submission_id = s.id
     GROUP BY a.id
     ORDER BY bytes DESC`,
  );
  res.json({
    usedBytes: used,
    limitBytes: MAX_TOTAL_BYTES,
    percent: Math.round((used / MAX_TOTAL_BYTES) * 100),
    assignments: perAssignment.map((r) => ({
      id: r.id,
      title: r.title,
      images: r.images,
      bytes: r.bytes,
    })),
  });
});

// ---------------------------------------------------------------- bài tập

function newSlug() {
  // base32 không có chữ dễ nhầm, đủ ngắn để gõ tay từ màn chiếu.
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function assignmentRow(a) {
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    dueAt: a.due_at,
    isClosed: !!a.is_closed,
    isOpen: isOpen(a),
    slug: a.slug,
    classId: a.class_id ?? null,
    className: a.class_name ?? null,
    createdAt: a.created_at,
    submittedCount: a.submitted_count ?? undefined,
    pendingCount: a.pending_count ?? undefined,
    studentCount: a.student_count ?? undefined,
  };
}

adminRouter.get('/assignments', (req, res) => {
  const classId = classScope(req.query.classId);
  const rows = all(
    `SELECT a.*, c.name AS class_name,
            (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id) AS submitted_count,
            (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id AND status = 'pending') AS pending_count,
            -- Số học viên của ĐÚNG lớp bài tập này, không phải tổng cả trường.
            (SELECT COUNT(*) FROM students s WHERE s.is_active = 1 AND s.class_id IS a.class_id) AS student_count
     FROM assignments a
     LEFT JOIN classes c ON c.id = a.class_id
     ${classId === undefined ? '' : 'WHERE a.class_id IS ?'}
     ORDER BY a.created_at DESC`,
    ...(classId === undefined ? [] : [classId]),
  );
  res.json({ assignments: rows.map(assignmentRow) });
});

adminRouter.post('/assignments', (req, res) => {
  const title = displayName(str(req.body?.title, 200) ?? '');
  if (!title) throw badRequest('Cần có tên bài tập');
  const description = str(req.body?.description, 5000) ?? '';
  // epoch ms; datetime-local của trình duyệt được đổi sang ms ở phía client.
  const dueAt = parseTimestamp(req.body?.dueAt);
  const classId = classScope(req.body?.classId) ?? null;

  const row = getReturning(
    `INSERT INTO assignments (title, description, due_at, is_closed, slug, class_id, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?) RETURNING *`,
    title,
    description,
    dueAt,
    newSlug(),
    classId,
    Date.now(),
  );
  res.status(201).json({ assignment: assignmentRow(row) });
});

adminRouter.patch('/assignments/:id', (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const existing = get('SELECT * FROM assignments WHERE id = ?', id);
  if (!existing) throw notFound('Không có bài tập này');

  const title = req.body?.title === undefined ? null : displayName(str(req.body.title, 200) ?? '');
  if (title !== null && !title) throw badRequest('Tên bài tập không được để trống');
  const classId = req.body?.classId === undefined ? undefined : classScope(req.body.classId) ?? null;

  const row = getReturning(
    `UPDATE assignments SET title = ?, description = ?, due_at = ?, is_closed = ?, class_id = ?
     WHERE id = ? RETURNING *`,
    title ?? existing.title,
    req.body?.description === undefined ? existing.description : (str(req.body.description, 5000) ?? ''),
    req.body?.dueAt === undefined ? existing.due_at : parseTimestamp(req.body.dueAt),
    req.body?.isClosed === undefined ? existing.is_closed : !!req.body.isClosed,
    classId === undefined ? existing.class_id : classId,
    id,
  );
  res.json({ assignment: assignmentRow(row) });
});

adminRouter.delete('/assignments/:id', async (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  if (!get('SELECT id FROM assignments WHERE id = ?', id)) throw notFound('Không có bài tập này');

  // Thu tên file trước khi xoá; cascade không dọn file trên đĩa.
  const files = all(
    `SELECT i.stored_name FROM submission_images i
     JOIN submissions s ON s.id = i.submission_id
     WHERE s.assignment_id = ?`,
    id,
  ).map((r) => r.stored_name);

  run('DELETE FROM assignments WHERE id = ?', id);
  await deleteStoredFiles(files);
  res.json({ ok: true, removedFiles: files.length });
});

/**
 * Bảng tổng hợp: MỌI học viên đang hoạt động, kèm bài nộp nếu có.
 * Danh sách ảnh không trả ở đây (nặng) — giao diện gọi /submissions/:id/images
 * khi admin mở dòng ra xem.
 */
adminRouter.get('/assignments/:id/overview', (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const assignment = get(
    'SELECT a.*, c.name AS class_name FROM assignments a LEFT JOIN classes c ON c.id = a.class_id WHERE a.id = ?',
    id,
  );
  if (!assignment) throw notFound('Không có bài tập này');

  // Chỉ học viên của LỚP bài tập này. Nếu lấy tất cả thì bảng tổng hợp của lớp 9A
  // sẽ đầy tên lớp 9B ở trạng thái "chưa nộp".
  const rows = all(
    `SELECT st.id AS student_id, st.name, st.note, st.name_normalized,
            sub.id AS submission_id, sub.status, sub.admin_note, sub.attempt_no,
            sub.submitted_at, sub.reviewed_at, sub.typed_name,
            (SELECT COUNT(*) FROM submission_images WHERE submission_id = sub.id) AS image_count
     FROM students st
     LEFT JOIN submissions sub ON sub.student_id = st.id AND sub.assignment_id = ?
     WHERE st.is_active = 1 AND st.class_id IS ?
     ORDER BY st.name COLLATE NOCASE`,
    id,
    assignment.class_id ?? null,
  );

  const dupCount = new Map();
  for (const r of rows) dupCount.set(r.name_normalized, (dupCount.get(r.name_normalized) ?? 0) + 1);

  const students = rows.map((r) => ({
    studentId: r.student_id,
    name: r.name,
    note: r.note,
    duplicate: (dupCount.get(r.name_normalized) ?? 0) > 1,
    submissionId: r.submission_id,
    status: r.submission_id ? r.status : 'missing',
    adminNote: r.admin_note ?? '',
    attemptNo: r.attempt_no ?? 0,
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at,
    typedName: r.typed_name,
    imageCount: r.image_count ?? 0,
    // Nộp sau hạn: hiện nhãn đỏ cho admin biết.
    late: !!(r.submitted_at && assignment.due_at && r.submitted_at > assignment.due_at),
  }));

  const counts = { total: students.length, missing: 0, pending: 0, approved: 0, rejected: 0, late: 0 };
  for (const s of students) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
    if (s.late) counts.late++;
  }

  // Ảnh trùng: hai bạn nộp đúng cùng một file. Gắn cờ vào từng học viên để
  // bảng tổng hợp hiện nhãn ngay, không phải mở từng dòng ra mới thấy.
  const dups = findDuplicateImages(id);
  const dupBySubmission = new Map();
  for (const [hash, items] of dups) {
    for (const item of items) {
      const others = items.filter((o) => o.studentId !== item.studentId);
      if (!dupBySubmission.has(item.submissionId)) dupBySubmission.set(item.submissionId, []);
      dupBySubmission.get(item.submissionId).push({
        hash: hash.slice(0, 12),
        withNames: [...new Set(others.map((o) => o.studentName + (o.note ? ` (${o.note})` : '')))],
      });
    }
  }
  for (const s of students) {
    const d = s.submissionId ? dupBySubmission.get(s.submissionId) : null;
    s.duplicateImages = d ?? null;
  }
  counts.duplicate = students.filter((s) => s.duplicateImages).length;

  // Bài nộp của học viên KHÔNG có trong danh sách ở trên vẫn phải thấy được:
  // bạn đã bị ẩn, hoặc đã được chuyển sang lớp khác sau khi nộp. Nếu không hiện
  // thì ảnh biến mất khỏi bảng tổng hợp mà không rõ vì sao.
  const shownIds = new Set(rows.map((r) => r.student_id));
  const orphans = all(
    `SELECT sub.id AS submission_id, sub.status, sub.attempt_no, sub.submitted_at,
            st.id AS student_id, st.name, st.note, st.is_active, c.name AS class_name,
            (SELECT COUNT(*) FROM submission_images WHERE submission_id = sub.id) AS image_count
     FROM submissions sub
     JOIN students st ON st.id = sub.student_id
     LEFT JOIN classes c ON c.id = st.class_id
     WHERE sub.assignment_id = ?`,
    id,
  )
    .filter((r) => !shownIds.has(r.student_id))
    .map((r) => ({
      studentId: r.student_id,
      name: r.name,
      note: r.note,
      submissionId: r.submission_id,
      status: r.status,
      attemptNo: r.attempt_no,
      submittedAt: r.submitted_at,
      imageCount: r.image_count,
      // Lý do không nằm trong danh sách chính, để admin biết cách xử lý.
      reason: r.is_active ? `đã chuyển sang ${r.class_name ?? 'lớp khác'}` : 'đã ẩn khỏi danh sách',
      inactive: !r.is_active,
    }));

  res.json({ assignment: assignmentRow(assignment), students, orphans, counts });
});

// ------------------------------------------------- xem / duyệt / sửa bài nộp

adminRouter.get('/submissions/:id/images', (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const sub = get(
    `SELECT sub.*, st.name AS student_name, st.note AS student_note
     FROM submissions sub JOIN students st ON st.id = sub.student_id
     WHERE sub.id = ?`,
    id,
  );
  if (!sub) throw notFound('Không có bài nộp này');

  const images = all(
    `SELECT id, original_name, size_bytes, mime, attempt_no, uploaded_by, sha256,
            typed_name, ip, created_at
     FROM submission_images WHERE submission_id = ? ORDER BY attempt_no DESC, id DESC`,
    id,
  );

  // Ảnh này có bạn nào khác cũng nộp không? Tra trong phạm vi bài tập.
  const dups = findDuplicateImages(sub.assignment_id);

  res.json({
    submission: {
      id: sub.id,
      studentId: sub.student_id,
      studentName: sub.student_name,
      studentNote: sub.student_note,
      status: sub.status,
      adminNote: sub.admin_note,
      attemptNo: sub.attempt_no,
      submittedAt: sub.submitted_at,
      reviewedAt: sub.reviewed_at,
      typedName: sub.typed_name,
      ip: sub.ip,
      userAgent: sub.user_agent,
    },
    images: images.map((i) => {
      const shared = i.sha256 ? dups.get(i.sha256) : null;
      const others = shared
        ? [...new Set(
            shared
              .filter((o) => o.studentId !== sub.student_id)
              .map((o) => o.studentName + (o.note ? ` (${o.note})` : '')),
          )]
        : [];
      return {
        id: i.id,
        url: `/files/${i.id}`,
        originalName: i.original_name,
        sizeBytes: i.size_bytes,
        mime: i.mime,
        attemptNo: i.attempt_no,
        uploadedBy: i.uploaded_by,
        createdAt: i.created_at,
        // Dấu vết theo TỪNG ảnh: một bài nộp có thể gồm ảnh của nhiều lần gửi từ
        // nhiều thiết bị, cột trên bảng submissions chỉ giữ được lần cuối.
        typedName: i.typed_name,
        ip: i.ip,
        // Danh sách bạn khác cũng nộp đúng ảnh này; rỗng nghĩa là không trùng.
        duplicateWith: others,
      };
    }),
    // Ảnh của lần nộp mới nhất; các lần trước làm mờ ở giao diện.
    currentAttempt: sub.attempt_no,
  });
});

const STATUSES = new Set(['pending', 'approved', 'rejected']);

/**
 * Duyệt bài, ghi chú, hoặc GÁN LẠI sang học viên khác.
 *
 * Gán lại là bắt buộc phải có: 1 QR dùng chung + học viên tự gõ tên thì kiểu gì
 * cũng có bạn chọn sai tên. Không có endpoint này thì phải sửa tay trong DB.
 */
adminRouter.patch('/submissions/:id', (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const existing = get('SELECT * FROM submissions WHERE id = ?', id);
  if (!existing) throw notFound('Không có bài nộp này');

  const status = req.body?.status === undefined ? null : str(req.body.status, 20);
  if (status !== null && !STATUSES.has(status)) throw badRequest('Trạng thái không hợp lệ');
  const adminNote = req.body?.adminNote === undefined ? null : (str(req.body.adminNote, 2000) ?? '');
  const newStudentId = req.body?.studentId === undefined ? null : intId(req.body.studentId);

  if (req.body?.studentId !== undefined && !newStudentId) throw badRequest('studentId không hợp lệ');

  const result = tx(() => {
    let merged = false;

    if (newStudentId && newStudentId !== existing.student_id) {
      if (!get('SELECT id FROM students WHERE id = ?', newStudentId)) {
        throw badRequest('Không có học viên này');
      }
      const target = get(
        'SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?',
        existing.assignment_id,
        newStudentId,
      );
      if (target) {
        // Học viên đích đã có bài nộp: dồn ảnh sang đó rồi bỏ bài nộp cũ,
        // vì UNIQUE(assignment_id, student_id) không cho tồn tại 2 hàng.
        const nextAttempt = target.attempt_no + 1;
        run(
          'UPDATE submission_images SET submission_id = ?, attempt_no = ? WHERE submission_id = ?',
          target.id,
          nextAttempt,
          id,
        );
        run(
          `UPDATE submissions SET attempt_no = ?, status = 'pending', reviewed_at = NULL, submitted_at = ?
           WHERE id = ?`,
          nextAttempt,
          Math.max(target.submitted_at, existing.submitted_at),
          target.id,
        );
        run('DELETE FROM submissions WHERE id = ?', id);
        merged = true;
        return { id: target.id, merged };
      }
      run('UPDATE submissions SET student_id = ? WHERE id = ?', newStudentId, id);
    }

    if (status !== null || adminNote !== null) {
      run(
        'UPDATE submissions SET status = ?, admin_note = ?, reviewed_at = ? WHERE id = ?',
        status ?? existing.status,
        adminNote ?? existing.admin_note,
        status !== null ? Date.now() : existing.reviewed_at,
        id,
      );
    }
    return { id, merged };
  });

  const row = get(
    `SELECT sub.*, st.name AS student_name FROM submissions sub
     JOIN students st ON st.id = sub.student_id WHERE sub.id = ?`,
    result.id,
  );
  res.json({
    submission: {
      id: row.id,
      studentId: row.student_id,
      studentName: row.student_name,
      status: row.status,
      adminNote: row.admin_note,
      attemptNo: row.attempt_no,
      reviewedAt: row.reviewed_at,
    },
    mergedInto: result.merged ? result.id : null,
  });
});

/** Xoá 1 ảnh nộp sai. Xoá hết ảnh thì bỏ luôn hàng bài nộp cho khỏi treo. */
adminRouter.delete('/images/:id', async (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const img = get('SELECT * FROM submission_images WHERE id = ?', id);
  if (!img) throw notFound('Không có ảnh này');

  const removedSubmission = tx(() => {
    run('DELETE FROM submission_images WHERE id = ?', id);
    const left = get(
      'SELECT COUNT(*) AS n FROM submission_images WHERE submission_id = ?',
      img.submission_id,
    ).n;
    if (left === 0) {
      run('DELETE FROM submissions WHERE id = ?', img.submission_id);
      return true;
    }
    return false;
  });

  await deleteStoredFiles([img.stored_name]);
  res.json({ ok: true, submissionRemoved: removedSubmission });
});

/** Phục vụ ảnh. Chỉ admin, và ảnh nằm NGOÀI thư mục static. */
export function serveImage(req, res, next) {
  const id = intId(req.params.imageId);
  if (!id) return res.status(400).json({ error: 'id không hợp lệ' });
  const img = get('SELECT stored_name, mime FROM submission_images WHERE id = ?', id);
  if (!img) return res.status(404).json({ error: 'Không có ảnh này' });

  const full = resolveUpload(img.stored_name);
  // Kiểm tồn tại TRƯỚC khi gửi: header đã gửi rồi thì không đổi ENOENT thành 404 được.
  if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'File ảnh không còn' });

  res.type(img.mime || 'application/octet-stream');
  // Đây là byte do người ngoài tải lên. mime lấy từ magic bytes chứ không tin
  // client, nhưng vẫn khoá thêm: không cho trình duyệt tự đoán lại kiểu file, và
  // cắt mọi khả năng thực thi nếu file là dạng lai (JPEG lồng HTML).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Content-Disposition', `inline; filename="${path.basename(img.stored_name)}"`);
  // Tên file là UUID nên nội dung không bao giờ đổi -> cache vĩnh viễn,
  // lần xem thứ hai của bảng tổng hợp là tức thì.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(full, (err) => {
    if (err && !res.headersSent) next(err);
  });
}

// ------------------------------------------------------------ bulk upload

/**
 * Bước 1: đoán ảnh nào của bạn nào, chỉ từ TÊN FILE.
 *
 * Browser đọc tên file ở local rồi gửi lên đây, chưa gửi ảnh — nên không cần
 * thư mục staging trên server và admin sửa lại xong mới thật sự upload.
 */
adminRouter.post('/match', (req, res) => {
  const filenames = req.body?.filenames;
  if (!Array.isArray(filenames)) throw badRequest('Cần danh sách filenames');
  if (filenames.length > 500) throw badRequest('Tối đa 500 file mỗi lượt');
  const classId = classScope(req.body?.classId);

  const names = filenames.map((f) => (typeof f === 'string' ? f.slice(0, 300) : ''));
  // Chỉ đoán trong lớp của bài tập: đoán sang lớp khác thì luôn sai.
  const students = all(
    `SELECT id, name, note, name_normalized, name_squashed FROM students
     WHERE is_active = 1 ${classId === undefined ? '' : 'AND class_id IS ?'}`,
    ...(classId === undefined ? [] : [classId]),
  );

  res.json({
    matches: matchFilenames(names, students),
    students: students.map((s) => ({ id: s.id, name: s.name, note: s.note })),
  });
});

/**
 * Bước 2: nhận 1 LÔ ảnh (client chia lô ~5 file, mỗi lô 1 request).
 *
 * Ghép ảnh với học viên bằng FIELDNAME "f_<studentId>_<i>", không bằng thứ tự
 * mảng: nếu 1 file bị loại thì req.files ngắn hơn mảng id và mọi ảnh phía sau
 * gán sai người mà không báo lỗi. Ngoài ra multer chỉ thấy các text field đến
 * TRƯỚC file trong stream, nên field studentIds append sau sẽ là undefined.
 *
 * Đường này KHÔNG kiểm deadline: admin nộp hộ được cả sau hạn (yêu cầu 3 + 7).
 */
adminRouter.post('/assignments/:id/bulk', uploadGate, upload.any(), async (req, res) => {
  const assignmentId = intId(req.params.id);
  if (!assignmentId) throw badRequest('id không hợp lệ');
  if (!get('SELECT id FROM assignments WHERE id = ?', assignmentId)) {
    throw notFound('Không có bài tập này');
  }
  const files = req.files ?? [];
  if (!files.length) throw badRequest('Chưa chọn ảnh nào');
  await assertStorageAvailable();

  // Tên file gốc do client gửi kèm (đã giải mã đúng ở browser). originalname của
  // multer có thể bị mojibake ("Nguyá»n VÄn A") tuỳ trình duyệt.
  let clientNames = {};
  if (typeof req.body?.names === 'string') {
    try {
      const parsed = JSON.parse(req.body.names);
      if (parsed && typeof parsed === 'object') clientNames = parsed;
    } catch {
      /* không có thì dùng originalname */
    }
  }

  const now = Date.now();
  const saved = [];
  const errors = [];

  try {
    for (const file of files) {
      const m = /^f_(\d+)_/.exec(file.fieldname);
      const studentId = m ? Number(m[1]) : null;
      const displayFileName =
        (typeof clientNames[file.fieldname] === 'string' ? clientNames[file.fieldname] : null) ??
        file.originalname ??
        '';

      if (!studentId || !get('SELECT id FROM students WHERE id = ?', studentId)) {
        errors.push({ fieldname: file.fieldname, name: displayFileName, error: 'Chưa gán học viên hợp lệ' });
        continue;
      }
      try {
        const info = await saveImage(file.buffer);
        saved.push({ ...info, studentId, fieldname: file.fieldname, originalName: displayFileName });
      } catch (err) {
        if (err instanceof ImageRejected) {
          errors.push({ fieldname: file.fieldname, name: displayFileName, error: err.message });
        } else {
          throw err;
        }
      }
    }

    if (saved.length) {
      // Cả lô trong 1 transaction: lỗi giữa đường không để lại hàng mồ côi.
      tx(() => {
        const byStudent = new Map();
        for (const s of saved) {
          if (!byStudent.has(s.studentId)) byStudent.set(s.studentId, []);
          byStudent.get(s.studentId).push(s);
        }

        for (const [studentId, items] of byStudent) {
          // RETURNING + .get(): lastInsertRowid sau nhánh DO UPDATE trả về rowid
          // của lần insert TRƯỚC (id của học viên khác) -> ảnh gắn sai bài nộp.
          const sub = getReturning(
            `INSERT INTO submissions (assignment_id, student_id, status, submitted_at, attempt_no)
             VALUES (?, ?, 'pending', ?, 1)
             ON CONFLICT(assignment_id, student_id) DO UPDATE SET
               attempt_no = submissions.attempt_no + 1,
               status = 'pending',
               reviewed_at = NULL,
               submitted_at = excluded.submitted_at
             RETURNING id, attempt_no`,
            assignmentId,
            studentId,
            now,
          );

          for (const item of items) {
            run(
              `INSERT INTO submission_images
                 (submission_id, stored_name, original_name, size_bytes, mime, attempt_no, uploaded_by, sha256, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?)`,
              sub.id,
              item.storedName,
              item.originalName,
              item.size,
              item.mime,
              sub.attempt_no,
              item.sha256,
              now,
            );
          }
        }
      });
    }
  } catch (err) {
    // Ghi DB thất bại -> dọn file đã ghi ra đĩa, không để rác.
    await deleteStoredFiles(saved.map((s) => s.storedName));
    throw err;
  }

  res.json({ savedCount: saved.length, errors });
});

// ------------------------------------------------------------- QR & export

/** URL gốc để nhúng vào QR. */
export function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

adminRouter.get('/assignments/:id/qr.png', async (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const a = get('SELECT slug FROM assignments WHERE id = ?', id);
  if (!a) throw notFound('Không có bài tập này');

  const url = `${baseUrl(req)}/s/${a.slug}`;
  const png = await QRCode.toBuffer(url, { type: 'png', width: 512, margin: 2 });
  res.type('image/png');
  // IP LAN có thể đổi theo DHCP -> không cache.
  res.setHeader('Cache-Control', 'no-store');
  res.send(png);
});

/** Link nộp bài + gợi ý IP LAN, để admin tự kiểm trước khi chiếu QR cho lớp. */
adminRouter.get('/assignments/:id/link', async (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const a = get('SELECT slug FROM assignments WHERE id = ?', id);
  if (!a) throw notFound('Không có bài tập này');

  const os = await import('node:os');
  const lanIps = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .map((n) => n.address);

  const port = process.env.PORT || 3000;
  res.json({
    slug: a.slug,
    url: `${baseUrl(req)}/s/${a.slug}`,
    baseUrlFromEnv: process.env.BASE_URL ?? null,
    lanUrls: lanIps.map((ip) => `http://${ip}:${port}/s/${a.slug}`),
  });
});

/** Tải toàn bộ ảnh của 1 bài tập, tên file trong ZIP là tên học viên. */
adminRouter.get('/assignments/:id/export.zip', (req, res) => {
  const id = intId(req.params.id);
  if (!id) throw badRequest('id không hợp lệ');
  const a = get('SELECT * FROM assignments WHERE id = ?', id);
  if (!a) throw notFound('Không có bài tập này');

  const rows = all(
    `SELECT i.stored_name, i.attempt_no, st.name AS student_name, st.note AS student_note,
            sub.status, sub.attempt_no AS current_attempt
     FROM submission_images i
     JOIN submissions sub ON sub.id = i.submission_id
     JOIN students st ON st.id = sub.student_id
     WHERE sub.assignment_id = ?
     ORDER BY st.name COLLATE NOCASE, i.attempt_no, i.id`,
    id,
  );

  const entries = [];
  for (const r of rows) {
    const full = resolveUpload(r.stored_name);
    if (!full) continue;
    const ext = path.extname(r.stored_name) || '.jpg';
    const noteSuffix = r.student_note ? ` (${safeFileName(r.student_note)})` : '';
    // Ảnh của lần nộp cũ cho vào thư mục riêng để không lẫn với bài hiện tại.
    const folder = r.attempt_no < r.current_attempt ? `lan-nop-${r.attempt_no}/` : '';
    entries.push({
      name: `${folder}${safeFileName(r.student_name)}${noteSuffix}${ext}`,
      path: full,
    });
  }

  const zipName = `${safeFileName(a.title) || 'bai-tap'}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  // filename* để tên có dấu tiếng Việt không bị hỏng.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="export.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
  );
  createZipStream(entries).pipe(res);
});

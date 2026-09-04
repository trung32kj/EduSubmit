import {
  api, el, $, clear, mount, setAlert, renderTopbar, formatTime, formatBytes,
  relativeDeadline, statusBadge, copyText, toast, withBusy, debounce,
  confirmDialog, pickStudentDialog, openLightbox,
} from '/js/app.js';
import { openZipDialog } from '/js/zip-dialog.js';

renderTopbar('/admin.html');

const id = new URLSearchParams(location.search).get('id');
if (!id) {
  location.href = '/admin.html';
  // Không throw thì đoạn dưới vẫn chạy và gọi API với id=null, hiện lỗi nhoáng
  // lên trước khi trang kịp chuyển.
  throw new Error('thiếu id');
}

let data = null;
const expanded = new Set();
/**
 * Bài nộp đang được tick để duyệt hàng loạt.
 *
 * Lưu theo submissionId chứ không theo dòng: bảng vẽ lại sau mỗi lần gõ vào ô
 * tìm kiếm, nếu bám vào dòng thì lựa chọn sẽ mất.
 */
const selected = new Set();
// Cache ảnh theo submissionId: mỗi lần render lại (gõ vào ô tìm, mở thêm dòng)
// mà gọi lại API thì gõ 6 chữ với 3 dòng đang mở là 18 request.
const imageCache = new Map();
// Ghi chú đang gõ dở, giữ lại qua các lần render — nếu không thì bấm "Đạt" ở
// dòng khác là mất sạch chữ vừa gõ mà không báo gì.
const noteDrafts = new Map();

$('#bulk-link').href = `/bulk.html?id=${id}`;
$('#zip-btn').addEventListener('click', () => openZipDialog(id, data?.assignment?.title));

async function load() {
  try {
    data = await api('GET', `/api/admin/assignments/${id}/overview`);
  } catch (err) {
    setAlert($('#alert'), err.message);
    return;
  }
  document.title = `${data.assignment.title} — Bài tập ảnh chứng minh`;
  $('#title').textContent = data.assignment.title;
  $('#filter').disabled = false;
  $('#status-filter').disabled = false;
  // Bỏ khỏi danh sách chọn những bài không còn trong dữ liệu mới.
  const live = new Set(data.students.filter((s) => s.submissionId).map((s) => s.submissionId));
  for (const sid of selected) if (!live.has(sid)) selected.delete(sid);
  renderMeta();
  render();
  renderOrphans();
}

function renderMeta() {
  const a = data.assignment;
  const c = data.counts;
  const dl = relativeDeadline(a.dueAt);
  const host = clear($('#meta'));

  // mount() thay .append(): .append() gốc in ra chữ "null" khi nhận null, còn
  // description/className thì có thể rỗng.
  mount(host,
    el('div', { class: 'row small' },
      a.isClosed
        ? el('span', { class: 'badge missing', text: 'Đã đóng' })
        : a.isOpen
          ? a.inLateWindow
            ? el('span', { class: 'badge late long', text: 'Quá hạn — vẫn nhận, đánh dấu muộn' })
            : el('span', { class: 'badge approved', text: 'Đang nhận bài' })
          : el('span', { class: 'badge late long', text: 'Hết hạn, đã tự khoá' }),
      a.className ? el('span', { class: 'badge info', text: a.className }) : null,
      a.pin ? el('span', { class: 'badge info', text: `PIN ${a.pin}` }) : null,
      el('span', { class: 'muted' }, a.dueAt ? `Hạn: ${formatTime(a.dueAt)} · ${dl.text}` : 'Không có hạn nộp'),
      // Khoá / mở ngay tại đây: sau khi hết giờ, việc hay làm nhất là mở lại cho
      // một bạn nộp bù rồi khoá lại.
      el('button', {
        class: a.isClosed ? 'small primary' : 'small ghost',
        text: a.isClosed ? 'Mở nhận bài' : 'Khoá nhận bài',
        onclick: (e) => toggleLock(e.currentTarget, a),
      }),
    ),
    a.description ? el('p', { class: 'small muted', style: 'white-space:pre-wrap;margin:0', text: a.description }) : null,
    el('div', { class: 'stat-row' },
      stat(c.total - c.missing, `Đã nộp / ${c.total}`),
      stat(c.pending, 'Chờ duyệt'),
      stat(c.approved, 'Đạt'),
      stat(c.rejected, 'Cần nộp lại'),
      stat(c.missing, 'Chưa nộp'),
      c.late ? stat(c.late, 'Nộp muộn') : null,
      c.duplicate ? stat(c.duplicate, 'Ảnh trùng') : null,
    ),
  );
}

const stat = (n, label) => el('div', { class: 'stat' }, el('b', { text: String(n) }), el('span', { text: label }));

/** Khoá / mở nhận bài. Không mở hộp thoại Sửa chỉ để tick một ô. */
async function toggleLock(btn, a) {
  const r = await withBusy(btn, '…', () =>
    api('POST', `/api/admin/assignments/${id}/lock`, { closed: !a.isClosed }),
  );
  if (!r) return;
  toast(r.assignment.isClosed ? 'Đã khoá — học viên không nộp được nữa.' : 'Đã mở lại cho học viên nộp.');
  await load();
}

// Debounce: mỗi ký tự gõ vào mà render lại cả bảng thì các dòng đang mở bị vẽ lại
// liên tục, nhấp nháy và tốn request.
$('#filter').addEventListener('input', debounce(render, 200));
$('#status-filter').addEventListener('change', render);

function visibleRows() {
  const q = $('#filter').value.trim().toLowerCase();
  const status = $('#status-filter').value;
  return data.students.filter(
    (s) =>
      (!status || s.status === status) &&
      (!q || (s.name + ' ' + (s.note ?? '')).toLowerCase().includes(q)),
  );
}

function render() {
  if (!data) return;
  const rows = visibleRows();

  // Giữ chỗ đang cuộn. render() dựng lại cả bảng, không giữ thì mỗi lần bấm
  // "Đạt" là trang nhảy về đầu — cảm giác như tải lại trang.
  const oldWrap = $('#list .table-wrap');
  const innerScroll = oldWrap?.scrollTop ?? 0;
  const pageScroll = window.scrollY;
  const activeId = document.activeElement?.id || null;

  const host = clear($('#list'));

  if (!rows.length) {
    // Nói rõ vì sao trống và phải làm gì, thay vì chỉ "Danh sách lớp còn trống".
    const a = data.assignment;
    mount(host, el('div', { class: 'empty stack' },
      data.students.length
        ? el('p', { text: 'Không có bạn nào khớp bộ lọc.' })
        : a.classId
          ? el('p', {}, `Lớp "${a.className}" chưa có học viên nào. `,
              el('a', { href: '/students.html', text: 'Thêm học viên vào lớp' }), ' rồi quay lại đây.')
          : el('p', {}, 'Bài tập này chưa thuộc lớp nào nên không có danh sách học viên. ',
              el('button', { class: 'small primary', text: 'Gán lớp cho bài tập', onclick: assignClass })),
    ));
    return;
  }

  const tbody = el('tbody');
  for (const s of rows) {
    tbody.append(rowFor(s));
    if (expanded.has(s.submissionId)) tbody.append(detailRow(s));
  }

  // Checkbox tổng: chỉ chọn những bài ĐANG HIỆN theo bộ lọc, và chỉ những bài
  // đã nộp — chọn cả dòng người dùng không thấy là cách dễ duyệt oan nhất.
  const selectable = rows.filter((s) => s.submissionId);
  const headCheck = el('input', {
    type: 'checkbox',
    'aria-label': 'Chọn tất cả bài đang hiện',
    disabled: selectable.length === 0,
    onchange: (e) => {
      if (e.currentTarget.checked) for (const s of selectable) selected.add(s.submissionId);
      else for (const s of selectable) selected.delete(s.submissionId);
      render();
    },
  });

  host.append(el('div', {
    class: 'table-wrap',
    tabindex: 0,
    role: 'region',
    'aria-label': 'Danh sách bài nộp',
  },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { class: 'check-col' }, headCheck),
        el('th', { text: 'Học viên' }),
        el('th', { text: 'Trạng thái' }),
        el('th', { class: 'num', text: 'Ảnh' }),
        el('th', { text: 'Nộp lúc' }),
        el('th', { text: '' }),
      )),
      tbody,
    ),
  ));

  updateReviewBar(rows, headCheck);
  restoreScroll(innerScroll, pageScroll, activeId);
}

/**
 * Trả lại vị trí cuộn và ô đang focus sau khi vẽ lại bảng.
 *
 * Không có bước này thì mỗi lần duyệt một bài là trang nhảy về đầu, người dùng
 * tưởng trang tự tải lại.
 */
function restoreScroll(innerScroll, pageScroll, activeId) {
  const wrap = $('#list .table-wrap');
  if (wrap && innerScroll) wrap.scrollTop = innerScroll;
  if (pageScroll) window.scrollTo({ top: pageScroll, behavior: 'instant' });
  if (activeId) document.getElementById(activeId)?.focus({ preventScroll: true });
}

function rowFor(s) {
  const canOpen = !!s.submissionId;
  const isOpen = expanded.has(s.submissionId);
  const check = canOpen
    ? el('input', {
        type: 'checkbox',
        checked: selected.has(s.submissionId),
        'aria-label': `Chọn bài của ${s.name}`,
        onchange: (e) => {
          if (e.currentTarget.checked) selected.add(s.submissionId);
          else selected.delete(s.submissionId);
          // Chỉ cập nhật thanh hành động và màu dòng, KHÔNG vẽ lại cả bảng — vẽ
          // lại sẽ làm mất ghi chú đang gõ ở dòng khác.
          e.currentTarget.closest('tr')?.classList.toggle('row-selected', e.currentTarget.checked);
          updateReviewBar(visibleRows(), $('#list thead input[type="checkbox"]'));
        },
      })
    : null;

  return el('tr', { class: selected.has(s.submissionId) ? 'row-selected' : null },
    el('td', { class: 'check-col' }, check),
    el('td', {},
      el('div', { style: 'font-weight:550' }, s.name,
        s.note ? el('span', { class: 'muted small', text: ` (${s.note})` }) : null),
      s.duplicate && !s.note
        ? el('div', { class: 'small muted', text: 'trùng tên — nên thêm ghi chú để phân biệt' })
        : null,
      s.typedName && s.typedName.toLowerCase() !== s.name.toLowerCase()
        ? el('div', { class: 'small muted', text: `tự gõ: ${s.typedName}` })
        : null,
    ),
    el('td', { dataset: { label: 'Trạng thái' } },
      el('div', { class: 'row tight' },
        statusBadge(s.status),
        s.late ? el('span', { class: 'badge late', text: 'muộn' }) : null,
        s.attemptNo > 1 ? el('span', { class: 'badge info', text: `lần ${s.attemptNo}` }) : null,
        // Ảnh trùng với bạn khác: dấu hiệu gian lận đáng tin nhất, phải thấy ngay
        // ở bảng chứ không phải mở từng dòng mới biết.
        s.duplicateImages
          ? el('span', {
              class: 'badge rejected',
              title: `Trùng ảnh với: ${s.duplicateImages.flatMap((d) => d.withNames).join(', ')}`,
              text: 'ảnh trùng',
            })
          : null,
      ),
      s.duplicateImages
        ? el('div', { class: 'small', style: 'color:var(--bad)', text: `giống ảnh của ${s.duplicateImages.flatMap((d) => d.withNames).join(', ')}` })
        : null,
      s.adminNote ? el('div', { class: 'small muted truncate', style: 'max-width:230px', text: s.adminNote }) : null,
    ),
    el('td', { class: 'num small', dataset: { label: 'Ảnh' }, text: s.imageCount ? String(s.imageCount) : '—' }),
    el('td', { class: 'small muted', dataset: { label: 'Nộp lúc' }, text: s.submittedAt ? formatTime(s.submittedAt) : '—' }),
    el('td', {},
      el('div', { class: 'row tight', style: 'justify-content:flex-end' },
        canOpen
          ? el('button', {
              class: 'small',
              'aria-expanded': String(isOpen),
              text: isOpen ? 'Đóng' : 'Xem ảnh',
              onclick: () => {
                if (isOpen) expanded.delete(s.submissionId);
                else expanded.add(s.submissionId);
                render();
              },
            })
          : el('span', { class: 'muted small', text: 'chưa có bài' }),
      ),
    ),
  );
}

/**
 * Ảnh chỉ tải khi admin mở dòng ra: một lớp 40 bạn × 3 ảnh 4MB là ~500MB,
 * không thể nhồi hết vào một trang. Có cache nên mở lại là tức thì.
 */
function detailRow(s) {
  // 6 cột: checkbox + học viên + trạng thái + ảnh + nộp lúc + nút.
  const cell = el('td', { colspan: 6, class: 'detail-cell' });

  const cached = imageCache.get(s.submissionId);
  if (cached) {
    cell.append(detailBody(s, cached.submission, cached.images, cached.currentAttempt));
    return el('tr', {}, cell);
  }

  cell.append(el('div', { class: 'row' },
    el('span', { class: 'spinner' }),
    el('span', { class: 'small muted', text: 'Đang tải ảnh…' })));

  api('GET', `/api/admin/submissions/${s.submissionId}/images`)
    .then((res) => {
      imageCache.set(s.submissionId, res);
      // Chỉ vẽ nếu ô này còn trong trang: render() có thể đã thay nó rồi.
      if (cell.isConnected) {
        clear(cell).append(detailBody(s, res.submission, res.images, res.currentAttempt));
      }
    })
    .catch((err) => {
      if (cell.isConnected) clear(cell).append(el('div', { class: 'alert err', text: err.message }));
    });

  return el('tr', {}, cell);
}

function detailBody(s, submission, images, currentAttempt) {
  const noteInput = el('input', {
    type: 'text',
    value: noteDrafts.get(submission.id) ?? submission.adminNote ?? '',
    maxlength: 2000,
    'aria-label': `Ghi chú cho ${s.name}`,
    placeholder: 'Ghi chú cho học viên (ví dụ: ảnh mờ, chụp lại trang 2)',
  });
  noteInput.addEventListener('input', () => noteDrafts.set(submission.id, noteInput.value));

  const setStatus = (btn, status) =>
    withBusy(btn, 'Đang lưu…', async () => {
      await api('PATCH', `/api/admin/submissions/${submission.id}`, { status, adminNote: noteInput.value });
      noteDrafts.delete(submission.id);
      imageCache.delete(submission.id);
      toast(status === 'approved' ? 'Đã duyệt đạt.' : status === 'rejected' ? 'Đã yêu cầu nộp lại.' : 'Đã chuyển về chờ duyệt.');
      await load();
    });

  const thumbs = el('div', { class: 'thumbs' });
  images.forEach((img, i) => {
    const old = img.attemptNo < currentAttempt;
    const caption = `${s.name} — ${img.originalName || 'ảnh'} (${formatBytes(img.sizeBytes)})`;
    thumbs.append(el('div', { class: old ? 'thumb old' : 'thumb' },
      // Bọc trong <button> để mở xem to được bằng bàn phím.
      el('button', {
        class: 'zoom',
        'aria-label': `Xem to ảnh ${i + 1} của ${s.name}`,
        onclick: () => openLightbox(img.url, caption),
      },
        el('img', { src: img.url, alt: '', loading: 'lazy', width: 132, height: 132 }),
      ),
      el('button', {
        class: 'del',
        text: '✕',
        'aria-label': `Xoá ảnh ${i + 1} của ${s.name}`,
        title: 'Xoá ảnh này',
        onclick: (e) => removeImage(e.currentTarget, img, s),
      }),
      img.duplicateWith?.length
        ? el('span', { class: 'tag', style: 'background:rgb(179 38 30 / 88%)', text: `trùng: ${img.duplicateWith.join(', ')}` })
        : old ? el('span', { class: 'tag', text: `lần ${img.attemptNo}` })
        : img.uploadedBy === 'admin' ? el('span', { class: 'tag', text: 'bạn upload hộ' }) : null,
    ));
  });

  return el('div', { class: 'stack', style: 'padding:6px 0 12px' },
    thumbs,
    el('div', { class: 'row' },
      el('div', { class: 'grow', style: 'min-width:220px' }, noteInput),
      el('button', { class: 'small primary', text: 'Đạt', onclick: (e) => setStatus(e.currentTarget, 'approved') }),
      el('button', { class: 'small danger', text: 'Cần nộp lại', onclick: (e) => setStatus(e.currentTarget, 'rejected') }),
      submission.status !== 'pending'
        ? el('button', { class: 'small ghost', text: 'Về chờ duyệt', onclick: (e) => setStatus(e.currentTarget, 'pending') })
        : null,
      el('button', {
        class: 'small ghost',
        text: 'Gán cho bạn khác',
        onclick: (e) => reassign(e.currentTarget, submission, s, images[0]?.url),
      }),
    ),
    el('div', { class: 'small muted' },
      `Nộp lần ${submission.attemptNo}`,
      submission.reviewedAt ? ` · duyệt lúc ${formatTime(submission.reviewedAt)}` : '',
      // IP theo từng ảnh (xem nhãn dưới mỗi ảnh) đáng tin hơn, cột này chỉ là
      // lần gửi cuối cùng.
      submission.ip ? ` · IP lần cuối ${submission.ip}` : '',
    ),
  );
}

/**
 * Thanh duyệt hàng loạt: chỉ xuất hiện khi đã chọn ít nhất một bài.
 * Nói rõ trong số đã chọn có bao nhiêu bài đang chờ duyệt, để không ai vô tình
 * ghi đè lên bài đã đánh "cần nộp lại".
 */
function updateReviewBar(rows, headCheck) {
  const chosen = rows.filter((s) => s.submissionId && selected.has(s.submissionId));
  const bar = $('#review-bar');
  bar.hidden = chosen.length === 0;

  const selectable = rows.filter((s) => s.submissionId);
  if (headCheck) {
    headCheck.checked = chosen.length > 0 && chosen.length === selectable.length;
    // Trạng thái nửa: chọn một phần. Không có nó thì tick tổng trông như "chưa
    // chọn gì" dù đang chọn 3/10 bài.
    headCheck.indeterminate = chosen.length > 0 && chosen.length < selectable.length;
  }

  if (!chosen.length) return;
  const pending = chosen.filter((s) => s.status === 'pending').length;
  $('#review-count').textContent =
    `Đã chọn ${chosen.length} bài` + (pending < chosen.length ? ` (${pending} đang chờ duyệt)` : '');
}

$('#review-clear').addEventListener('click', () => {
  selected.clear();
  render();
});

$('#review-approve').addEventListener('click', (e) => reviewSelected(e.currentTarget, 'approved'));
$('#review-reject').addEventListener('click', (e) => reviewSelected(e.currentTarget, 'rejected'));

async function reviewSelected(btn, status) {
  const chosen = visibleRows().filter((s) => s.submissionId && selected.has(s.submissionId));
  if (!chosen.length) return;

  const label = status === 'approved' ? 'Đạt' : 'Cần nộp lại';
  const dup = chosen.filter((s) => s.duplicateImages).length;
  const notPending = chosen.filter((s) => s.status !== 'pending').length;

  const lines = [`${chosen.length} bài sẽ được đánh "${label}".`];
  // Cảnh báo đúng chỗ đáng cảnh báo: duyệt đạt cho bài trùng ảnh là bỏ qua dấu
  // hiệu gian lận rõ nhất mà hệ thống tìm được.
  if (dup && status === 'approved') {
    lines.push(`Lưu ý: ${dup} bài có ảnh TRÙNG với bạn khác.`);
  }
  if (notPending) {
    lines.push(`${notPending} bài đã được duyệt trước đó sẽ bị ghi đè.`);
  }

  let note = '';
  const noteInput = el('input', {
    type: 'text',
    maxlength: 2000,
    'aria-label': 'Ghi chú chung',
    placeholder: status === 'rejected' ? 'Ví dụ: ảnh mờ, chụp lại' : 'Ghi chú chung (không bắt buộc)',
    oninput: (e) => { note = e.currentTarget.value; },
  });

  const ok = await confirmDialog({
    title: `Đánh "${label}" cho ${chosen.length} bài?`,
    message: lines.join('\n'),
    confirmLabel: label,
    danger: status === 'rejected',
    previewText: chosen
      .map((s) => `• ${s.name}${s.note ? ` (${s.note})` : ''}${s.duplicateImages ? ' — ẢNH TRÙNG' : ''}`)
      .join('\n'),
    extra: noteInput,
  });
  if (!ok) return;

  const r = await withBusy(btn, 'Đang lưu…', () =>
    api('POST', `/api/admin/assignments/${id}/review-bulk`, {
      ids: chosen.map((s) => s.submissionId),
      status,
      // Ghi chú rỗng thì không gửi, để không xoá mất ghi chú riêng của từng bài.
      ...(note.trim() ? { adminNote: note } : {}),
    }),
  );
  if (!r) return;

  selected.clear();
  for (const s of chosen) imageCache.delete(s.submissionId);
  toast(`Đã đánh "${label}" cho ${r.updated} bài.`);
  await load();
}

async function removeImage(btn, img, s) {
  const ok = await confirmDialog({
    title: 'Xoá ảnh này?',
    message: `Ảnh của ${s.name}. Không hoàn lại được.`,
    confirmLabel: 'Xoá ảnh',
    previewImage: img.url,
  });
  if (!ok) return;
  await withBusy(btn, '…', async () => {
    const r = await api('DELETE', `/api/admin/images/${img.id}`);
    imageCache.delete(s.submissionId);
    toast(r.submissionRemoved ? 'Đã xoá ảnh cuối, bài nộp chuyển về "chưa nộp".' : 'Đã xoá ảnh.');
    if (r.submissionRemoved) expanded.delete(s.submissionId);
    await load();
  });
}

/**
 * Gán lại bài nộp sang bạn khác.
 *
 * Học viên chọn sai tên là chuyện chắc chắn xảy ra khi cả lớp dùng một link.
 * Hộp thoại có ô gợi ý tên + xem được ảnh đang gán, thay cho window.prompt.
 */
async function reassign(btn, submission, s, previewUrl) {
  const target = await pickStudentDialog({
    title: 'Gán bài nộp cho bạn khác',
    subtitle: `Đang là bài của ${s.name}${s.note ? ` (${s.note})` : ''}. Chọn bạn đúng:`,
    preview: previewUrl,
    confirmLabel: 'Chuyển',
    classId: data.assignment.classId,
  });
  if (!target) return;

  if (target.id === s.studentId) return toast('Vẫn là bạn đó, không có gì thay đổi.', 'info');

  await withBusy(btn, 'Đang chuyển…', async () => {
    const r = await api('PATCH', `/api/admin/submissions/${submission.id}`, { studentId: target.id });
    expanded.delete(submission.id);
    imageCache.clear();
    toast(r.mergedInto ? `Đã dồn ảnh vào bài nộp có sẵn của ${target.name}.` : `Đã chuyển sang ${target.name}.`);
    await load();
  });
}

function renderOrphans() {
  const card = $('#orphan-card');
  if (!data.orphans?.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const host = clear($('#orphans'));
  const tbody = el('tbody');
  for (const o of data.orphans) {
    tbody.append(el('tr', {},
      el('td', {}, o.name, o.note ? el('span', { class: 'muted small', text: ` (${o.note})` }) : null),
      el('td', { dataset: { label: 'Lý do' }, class: 'small muted', text: o.reason ?? '' }),
      el('td', { dataset: { label: 'Trạng thái' } }, statusBadge(o.status)),
      el('td', { class: 'num small', dataset: { label: 'Ảnh' }, text: String(o.imageCount) }),
      el('td', { class: 'small muted', dataset: { label: 'Nộp lúc' }, text: formatTime(o.submittedAt) }),
    ));
  }
  host.append(el('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Bài nộp ngoài danh sách' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Học viên' }), el('th', { text: 'Lý do' }), el('th', { text: 'Trạng thái' }),
        el('th', { class: 'num', text: 'Ảnh' }), el('th', { text: 'Nộp lúc' }),
      )),
      tbody,
    ),
  ));
}

/** Con số "chưa nộp" không dùng được ngay — cần danh sách tên để dán vào Zalo. */
$('#copy-missing').addEventListener('click', async (e) => {
  if (!data) return;
  const missing = data.students.filter((s) => s.status === 'missing');
  if (!missing.length) return toast('Cả lớp đã nộp đủ.', 'ok');
  const text = missing.map((s) => s.name + (s.note ? ` (${s.note})` : '')).join('\n');
  const ok = await copyText(text);
  void e;
  toast(ok ? `Đã copy ${missing.length} tên chưa nộp.` : 'Không copy được, hãy chọn bằng tay.', ok ? 'ok' : 'err');
});

$('#link-btn').addEventListener('click', (e) =>
  withBusy(e.currentTarget, 'Đang tải…', async () => {
    const info = await api('GET', `/api/admin/assignments/${id}/link`);
    const qrUrl = `/api/admin/assignments/${id}/qr.png?t=${Date.now()}`;
    $('#qr').src = qrUrl;
    $('#link-input').value = info.url;
    $('#qr-zoom').onclick = () => openLightbox(qrUrl, info.url);
    renderPin(info.pin);

    const hint = $('#lan-hint');
    if (info.publicUrl) {
      // Có BASE_URL nghĩa là đang chạy qua domain/tunnel: nộp từ đâu cũng được.
      hint.className = 'alert ok small';
      hint.textContent = 'Link này mở được từ bất kỳ đâu, không cần cùng Wi-Fi.';
    } else if (info.url.includes('localhost') || info.url.includes('127.0.0.1')) {
      hint.className = 'alert warn small';
      hint.textContent = info.lanUrls.length
        ? `Điện thoại KHÔNG mở được link localhost. Dùng link trong cùng Wi-Fi: ${info.lanUrls.join(' hoặc ')}`
        : 'Điện thoại không mở được link localhost. Cần chạy server ở địa chỉ mà điện thoại truy cập được.';
    } else {
      hint.className = 'alert info small';
      hint.textContent =
        'Link này chỉ dùng được trong cùng mạng Wi-Fi. Muốn học viên nộp từ nhà thì ' +
        'chạy server qua domain hoặc tunnel rồi đặt biến BASE_URL — xem README.';
    }
    $('#link-dlg').showModal();
  }),
);

/** Hiện mã PIN và các nút bật/tắt/đổi mã. */
function renderPin(pin) {
  const box = $('#pin-value');
  const toggle = $('#pin-toggle');
  const renew = $('#pin-new');
  const hint = $('#pin-hint');

  if (pin) {
    box.textContent = pin;
    box.hidden = false;
    toggle.textContent = 'Tắt PIN';
    renew.hidden = false;
    hint.textContent = 'Đọc mã này cho lớp. Không có mã thì không nộp được, dù có link.';
  } else {
    box.textContent = '';
    box.hidden = true;
    toggle.textContent = 'Bật PIN';
    renew.hidden = true;
    hint.textContent = 'Chưa đặt PIN — ai có link cũng nộp được. Nên bật nếu link đi ra ngoài lớp.';
  }

  // renderPin phải chạy SAU khi withBusy kết thúc: withBusy lưu nhãn nút lúc bắt
  // đầu rồi khôi phục ở finally, nên nếu đổi nhãn bên trong thì nó bị ghi đè lại.
  toggle.onclick = async (e) => {
    const r = await withBusy(e.currentTarget, '…', () =>
      api('POST', `/api/admin/assignments/${id}/pin`, { action: pin ? 'off' : 'on' }),
    );
    if (!r) return;
    renderPin(r.assignment.pin);
    toast(r.assignment.pin ? `Đã bật PIN: ${r.assignment.pin}` : 'Đã tắt PIN.');
    await load();
  };

  renew.onclick = async (e) => {
    const ok = await confirmDialog({
      title: 'Đổi mã PIN?',
      message: 'Mã cũ sẽ không dùng được nữa. Bạn phải đọc mã mới cho lớp.',
      confirmLabel: 'Đổi mã',
      danger: false,
    });
    if (!ok) return;
    const r = await withBusy(e.currentTarget, '…', () =>
      api('POST', `/api/admin/assignments/${id}/pin`, { action: 'on' }),
    );
    if (!r) return;
    renderPin(r.assignment.pin);
    toast(`Mã PIN mới: ${r.assignment.pin}`);
    await load();
  };
}

$('#link-input').addEventListener('click', (e) => e.target.select());

$('#copy-link').addEventListener('click', async () => {
  const ok = await copyText($('#link-input').value);
  toast(ok ? 'Đã copy link.' : 'Không copy được.', ok ? 'ok' : 'err');
});
$('#link-close').addEventListener('click', () => $('#link-dlg').close());
$('#link-dlg').addEventListener('click', (e) => {
  if (e.target === $('#link-dlg')) $('#link-dlg').close();
});

/**
 * Gán lớp cho bài tập chưa có lớp.
 *
 * Bài tập tạo trước khi có ràng buộc "phải chọn lớp" có thể còn class_id rỗng.
 * Không có đường sửa thì nó hỏng vĩnh viễn: bảng tổng hợp trống và không học viên
 * nào nộp được.
 */
async function assignClass() {
  let list;
  try {
    list = (await api('GET', '/api/admin/classes')).classes.filter((c) => c.isActive);
  } catch (err) {
    return toast(err.message, 'err');
  }
  if (!list.length) {
    return toast('Chưa có lớp nào. Vào trang "Danh sách lớp" tạo lớp trước.', 'err');
  }

  const sel = el('select', {},
    list.map((c) => el('option', { value: String(c.id), text: `${c.name} (${c.studentCount} học viên)` })),
  );

  const ok = await confirmDialog({
    title: 'Gán lớp cho bài tập này',
    message: 'Chọn lớp — bảng tổng hợp sẽ hiện danh sách học viên của lớp đó.',
    confirmLabel: 'Gán lớp',
    danger: false,
    extra: sel,
  });
  if (!ok) return;

  try {
    await api('PATCH', `/api/admin/assignments/${id}`, { classId: sel.value });
    toast('Đã gán lớp.');
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
}

load();

import {
  api, el, $, clear, setAlert, renderTopbar, formatTime, formatBytes,
  relativeDeadline, statusBadge, copyText, toast, withBusy, debounce,
  confirmDialog, pickStudentDialog, openLightbox,
} from '/js/app.js';

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
// Cache ảnh theo submissionId: mỗi lần render lại (gõ vào ô tìm, mở thêm dòng)
// mà gọi lại API thì gõ 6 chữ với 3 dòng đang mở là 18 request.
const imageCache = new Map();
// Ghi chú đang gõ dở, giữ lại qua các lần render — nếu không thì bấm "Đạt" ở
// dòng khác là mất sạch chữ vừa gõ mà không báo gì.
const noteDrafts = new Map();

$('#bulk-link').href = `/bulk.html?id=${id}`;
$('#zip-link').href = `/api/admin/assignments/${id}/export.zip`;

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
  renderMeta();
  render();
  renderOrphans();
}

function renderMeta() {
  const a = data.assignment;
  const c = data.counts;
  const dl = relativeDeadline(a.dueAt);
  const host = clear($('#meta'));

  host.append(
    el('div', { class: 'row small' },
      a.isClosed
        ? el('span', { class: 'badge missing', text: 'Đã đóng' })
        : a.isOpen
          ? el('span', { class: 'badge approved', text: 'Đang nhận bài' })
          : el('span', { class: 'badge late long', text: 'Hết hạn, không nhận bài mới' }),
      a.className ? el('span', { class: 'badge info', text: a.className }) : null,
      el('span', { class: 'muted' }, a.dueAt ? `Hạn: ${formatTime(a.dueAt)} · ${dl.text}` : 'Không có hạn nộp'),
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
  const host = clear($('#list'));

  if (!rows.length) {
    host.append(el('div', { class: 'empty', text: data.students.length ? 'Không có bạn nào khớp bộ lọc.' : 'Danh sách lớp còn trống.' }));
    return;
  }

  const tbody = el('tbody');
  for (const s of rows) {
    tbody.append(rowFor(s));
    if (expanded.has(s.submissionId)) tbody.append(detailRow(s));
  }

  host.append(el('div', {
    class: 'table-wrap',
    tabindex: 0,
    role: 'region',
    'aria-label': 'Danh sách bài nộp',
  },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Học viên' }),
        el('th', { text: 'Trạng thái' }),
        el('th', { class: 'num', text: 'Ảnh' }),
        el('th', { text: 'Nộp lúc' }),
        el('th', { text: '' }),
      )),
      tbody,
    ),
  ));
}

function rowFor(s) {
  const canOpen = !!s.submissionId;
  const isOpen = expanded.has(s.submissionId);
  return el('tr', {},
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
  const cell = el('td', { colspan: 5, class: 'detail-cell' });

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

async function removeImage(btn, img, s) {
  const ok = await confirmDialog({
    title: 'Xoá ảnh này?',
    message: `Ảnh của ${s.name}. Không hoàn lại được.`,
    confirmLabel: 'Xoá ảnh',
    preview: img.url,
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

    const hint = $('#lan-hint');
    if (info.url.includes('localhost') || info.url.includes('127.0.0.1')) {
      hint.className = 'alert warn small';
      hint.textContent = info.lanUrls.length
        ? `Điện thoại KHÔNG mở được link localhost. Dùng link trong cùng Wi-Fi: ${info.lanUrls.join(' hoặc ')}`
        : 'Điện thoại không mở được link localhost. Cần chạy server ở địa chỉ mà điện thoại truy cập được.';
    } else {
      hint.className = 'alert info small';
      hint.textContent = 'Điện thoại phải ở cùng mạng Wi-Fi với máy này. Lần đầu Windows Firewall sẽ hỏi — bấm Allow.';
    }
    $('#link-dlg').showModal();
  }),
);

$('#link-input').addEventListener('click', (e) => e.target.select());

$('#copy-link').addEventListener('click', async () => {
  const ok = await copyText($('#link-input').value);
  toast(ok ? 'Đã copy link.' : 'Không copy được.', ok ? 'ok' : 'err');
});
$('#link-close').addEventListener('click', () => $('#link-dlg').close());
$('#link-dlg').addEventListener('click', (e) => {
  if (e.target === $('#link-dlg')) $('#link-dlg').close();
});

load();

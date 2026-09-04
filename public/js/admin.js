import {
  api, el, $, clear, mount, setAlert, renderTopbar, formatTime, formatBytes,
  relativeDeadline, toDatetimeLocal, fromDatetimeLocal, copyText, toast,
  withBusy, confirmDialog,
} from '/js/app.js';

renderTopbar('/admin.html');

let editingId = null;
let classes = [];
/** Bài tập đang hiện, tra theo id — cần để biết bài tập đó đã có PIN chưa. */
const assignmentById = new Map();
let currentClass = localStorage.getItem('classFilter') || '';

async function load() {
  try {
    const [cls, { assignments }] = await Promise.all([
      api('GET', '/api/admin/classes'),
      api('GET', '/api/admin/assignments' + (currentClass ? `?classId=${currentClass}` : '')),
    ]);
    classes = cls.classes;
    renderClassFilter();
    render(assignments);
    loadStorage();
  } catch (err) {
    setAlert($('#alert'), err.message);
  }
}

function renderClassFilter() {
  const sel = clear($('#class-filter'));
  sel.append(el('option', { value: '', text: 'Tất cả các lớp' }));
  for (const c of classes) {
    sel.append(el('option', { value: String(c.id), text: `${c.name} (${c.studentCount})` }));
  }
  sel.value = currentClass;

  const dlgSel = clear($('#class'));
  const activeClasses = classes.filter((c) => c.isActive);
  if (!activeClasses.length) {
    // Không có lớp thì không tạo được bài tập, nói thẳng ra thay vì để người dùng
    // bấm Lưu rồi mới nhận lỗi.
    dlgSel.append(el('option', { value: '', text: '— chưa có lớp nào —' }));
  } else {
    dlgSel.append(el('option', { value: '', text: '— chọn lớp —' }));
    for (const c of activeClasses) {
      dlgSel.append(el('option', { value: String(c.id), text: c.name }));
    }
  }

  $('#roster-hint').textContent = classes.length
    ? `${classes.length} lớp · ${classes.reduce((n, c) => n + c.studentCount, 0)} học viên`
    : 'Chưa có lớp nào — tạo lớp ở trang Danh sách lớp';
}

$('#class-filter').addEventListener('change', () => {
  currentClass = $('#class-filter').value;
  if (currentClass) localStorage.setItem('classFilter', currentClass);
  else localStorage.removeItem('classFilter');
  load();
});

/** Ảnh nằm trên ổ đĩa máy này, một lớp 40 bạn × 10 bài là đầy rất nhanh. */
async function loadStorage() {
  try {
    const s = await api('GET', '/api/admin/storage');
    const box = $('#storage');
    box.hidden = false;
    box.className = s.percent >= 85 ? 'alert err small' : s.percent >= 60 ? 'alert warn small' : 'small muted';
    box.textContent =
      `Ảnh đang dùng ${formatBytes(s.usedBytes)} / ${formatBytes(s.limitBytes)} (${s.percent}%).` +
      (s.percent >= 60 ? ' Tải ZIP về rồi xoá bài tập cũ để giải phóng chỗ.' : '');
  } catch {
    /* không quan trọng, bỏ qua */
  }
}

function render(assignments) {
  assignmentById.clear();
  for (const a of assignments) assignmentById.set(a.id, a);
  const host = clear($('#list'));

  if (!assignments.length) {
    mount(host,
      el('div', { class: 'empty stack' },
        el('p', { text: currentClass ? 'Lớp này chưa có bài tập nào.' : 'Chưa có bài tập nào.' }),
        classes.length === 0
          ? el('p', { class: 'small' }, 'Nên tạo lớp và nhập ', el('a', { href: '/students.html', text: 'danh sách lớp' }), ' trước.')
          : null,
      ),
    );
    return;
  }

  const tbody = el('tbody');
  for (const a of assignments) {
    const dl = relativeDeadline(a.dueAt);
    tbody.append(el('tr', {},
      el('td', {},
        el('div', {}, el('a', { href: `/assignment.html?id=${a.id}`, text: a.title, style: 'font-weight:570' })),
        el('div', { class: 'row tight small', style: 'margin-top:3px' },
          a.isClosed ? el('span', { class: 'badge missing', text: 'Đã đóng' })
            : a.isOpen ? el('span', { class: 'badge approved', text: 'Đang mở' })
            : el('span', { class: 'badge late', text: 'Hết hạn' }),
          a.className ? el('span', { class: 'badge info', text: a.className }) : null,
          a.pin ? el('span', { class: 'badge info', text: `PIN ${a.pin}` }) : null,
        ),
      ),
      el('td', { class: 'small', dataset: { label: 'Hạn nộp' } },
        el('div', { text: a.dueAt ? formatTime(a.dueAt) : 'Không có hạn' }),
        a.dueAt ? el('div', { class: 'small', style: dl.late ? 'color:var(--bad)' : 'color:var(--ink-3)', text: dl.text }) : null,
      ),
      el('td', { class: 'num', dataset: { label: 'Đã nộp' } }, `${a.submittedCount}/${a.studentCount}`),
      el('td', { class: 'num', dataset: { label: 'Chờ duyệt' } },
        a.pendingCount > 0
          ? el('span', { class: 'badge pending', text: String(a.pendingCount) })
          : el('span', { class: 'muted', text: '0' })),
      el('td', {},
        el('div', { class: 'row tight', style: 'justify-content:flex-end' },
          el('button', { class: 'small', text: 'Link nộp', onclick: (e) => showLink(e.currentTarget, a) }),
          el('a', { class: 'btn small', href: `/bulk.html?id=${a.id}`, text: 'Tải ảnh lên' }),
          el('button', { class: 'small ghost', text: 'Sửa', onclick: () => openDialog(a) }),
          el('button', { class: 'small ghost', text: 'Xoá', onclick: (e) => remove(e.currentTarget, a) }),
        ),
      ),
    ));
  }

  host.append(el('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Danh sách bài tập' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Bài tập' }),
        el('th', { text: 'Hạn nộp' }),
        el('th', { class: 'num', text: 'Đã nộp' }),
        el('th', { class: 'num', text: 'Chờ duyệt' }),
        el('th', { text: '' }),
      )),
      tbody,
    ),
  ));
}

function showLink(btn, a) {
  return withBusy(btn, '…', async () => {
    const info = await api('GET', `/api/admin/assignments/${a.id}/link`);
    const ok = await copyText(info.url);
    toast(ok ? `Đã copy link: ${info.url}` : info.url, 'info');
  });
}

async function remove(btn, a) {
  const ok = await confirmDialog({
    title: `Xoá "${a.title}"?`,
    message: `${a.submittedCount} bài nộp và toàn bộ ảnh của bài tập này sẽ bị xoá vĩnh viễn.\n\nNếu cần giữ ảnh, hãy tải ZIP về trước.`,
    confirmLabel: 'Xoá vĩnh viễn',
  });
  if (!ok) return;
  await withBusy(btn, '…', async () => {
    const r = await api('DELETE', `/api/admin/assignments/${a.id}`);
    toast(`Đã xoá, kèm ${r.removedFiles} ảnh.`);
    await load();
  });
}

function openDialog(a) {
  editingId = a?.id ?? null;
  $('#dlg-title').textContent = a ? 'Sửa bài tập' : 'Tạo bài tập';
  $('#title').value = a?.title ?? '';
  $('#description').value = a?.description ?? '';
  $('#due').value = toDatetimeLocal(a?.dueAt);
  $('#closed').checked = !!a?.isClosed;
  $('#use-pin').checked = a ? !!a.pin : false;
  // Tạo mới thì mặc định theo lớp đang xem, đỡ phải chọn lại.
  $('#class').value = a ? String(a.classId ?? '') : currentClass;
  setAlert($('#dlg-alert'), '');
  $('#dlg').showModal();
  $('#title').focus();
}

$('#new-btn').addEventListener('click', () => openDialog(null));
$('#cancel').addEventListener('click', () => $('#dlg').close());
$('#dlg').addEventListener('click', (e) => {
  if (e.target === $('#dlg')) $('#dlg').close();
});

$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  return withBusy($('#save'), 'Đang lưu…', async () => {
    const payload = {
      title: $('#title').value,
      description: $('#description').value,
      // datetime-local là giờ local -> đổi sang epoch ms ngay ở client.
      dueAt: fromDatetimeLocal($('#due').value),
      isClosed: $('#closed').checked,
      classId: $('#class').value || null,
    };

    // PIN: chỉ gửi khi trạng thái tick khác với hiện tại, để lần sửa bài tập
    // không vô tình đổi mã PIN đang dùng.
    const wantPin = $('#use-pin').checked;
    const editing = editingId ? assignmentById.get(editingId) : null;
    const hadPin = !!editing?.pin;
    if (wantPin !== hadPin) payload.pin = wantPin;
    if (!payload.title.trim()) {
      setAlert($('#dlg-alert'), 'Cần có tên bài tập');
      $('#title').focus();
      return;
    }
    // Chặn ngay ở đây thay vì để server trả lỗi: bài tập không có lớp thì bảng
    // tổng hợp luôn trống và không học viên nào nộp được.
    if (!payload.classId) {
      setAlert(
        $('#dlg-alert'),
        classes.some((c) => c.isActive)
          ? 'Chọn lớp cho bài tập này.'
          : 'Chưa có lớp nào. Vào trang "Danh sách lớp" tạo lớp trước.',
      );
      $('#class').focus();
      return;
    }
    try {
      if (editingId) await api('PATCH', `/api/admin/assignments/${editingId}`, payload);
      else await api('POST', '/api/admin/assignments', payload);
    } catch (err) {
      setAlert($('#dlg-alert'), err.message);
      return;
    }
    $('#dlg').close();
    toast(editingId ? 'Đã lưu.' : 'Đã tạo bài tập.');
    await load();
  });
});

load();

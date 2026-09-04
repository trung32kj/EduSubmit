import {
  api, el, $, clear, setAlert, renderTopbar, toast, withBusy, debounce, confirmDialog,
} from '/js/app.js';

renderTopbar('/students.html');

let students = [];
let classes = [];
// Lớp đang xem: null = tất cả, 'none' = chưa gán lớp, số = id lớp.
let currentClass = localStorage.getItem('classFilter') || '';

// Xem trước số dòng ngay khi dán, để biết có dán thiếu không.
$('#paste').addEventListener('input', () => {
  const n = $('#paste').value.split(/\r?\n/).filter((l) => l.trim()).length;
  $('#preview-hint').textContent = n ? `${n} dòng` : '';
});

$('#csv').addEventListener('change', async () => {
  const file = $('#csv').files[0];
  if (!file) return;
  // File CSV từ Excel có thể là UTF-8 hoặc có BOM; server đã xử lý BOM.
  $('#paste').value = await file.text();
  $('#paste').dispatchEvent(new Event('input'));
  toast(`Đã đọc ${file.name}. Kiểm tra rồi bấm "Thêm vào danh sách".`, 'info');
});

$('#import-btn').addEventListener('click', (e) =>
  withBusy(e.currentTarget, 'Đang thêm…', async () => {
    const text = $('#paste').value;
    if (!text.trim()) {
      setAlert($('#alert'), 'Chưa dán tên nào.');
      return;
    }
    const classId = $('#import-class').value;
    if (!classId) {
      setAlert($('#alert'), 'Chọn lớp cho các bạn này. Chưa có lớp thì tạo một lớp ở phần trên.');
      return;
    }

    const r = await api('POST', '/api/admin/students/import', {
      text,
      groupName: $('#group').value || null,
      classId,
    });
    $('#paste').value = '';
    $('#csv').value = '';
    $('#preview-hint').textContent = '';

    let msg = `Đã thêm ${r.added} học viên.`;
    if (r.skipped) msg += ` Bỏ qua ${r.skipped} dòng trùng lặp hoàn toàn.`;
    if (r.duplicates.length) {
      setAlert(
        $('#alert'),
        `${msg} Có ${r.duplicates.length} tên trùng với bạn đã có trong lớp này: ${r.duplicates.join(', ')}. ` +
          'Nên thêm ghi chú cho từng bạn để phân biệt.',
        'warn',
      );
    } else {
      setAlert($('#alert'), msg, 'ok');
    }
    // Xem luôn lớp vừa nhập vào.
    currentClass = classId;
    localStorage.setItem('classFilter', classId);
    await loadAll();
  }),
);

$('#filter').addEventListener('input', debounce(render, 200));
$('#show-inactive').addEventListener('change', () => loadStudents());

// ---------------------------------------------------------------- lớp

async function loadAll() {
  await loadClasses();
  await loadStudents();
}

async function loadClasses() {
  try {
    const r = await api('GET', '/api/admin/classes');
    classes = r.classes;
    renderClasses(r.unassignedStudents);
  } catch (err) {
    setAlert($('#alert'), err.message);
  }
}

function renderClasses(unassigned) {
  // Ô chọn lớp khi nhập danh sách.
  const importSel = clear($('#import-class'));
  importSel.append(el('option', { value: '', text: classes.length ? '— chọn lớp —' : '— chưa có lớp nào —' }));
  for (const c of classes.filter((c) => c.isActive)) {
    importSel.append(el('option', { value: String(c.id), text: c.name }));
  }
  if (currentClass && currentClass !== 'none') importSel.value = currentClass;

  // Ô lọc lớp ở bảng danh sách.
  const filterSel = clear($('#class-filter'));
  filterSel.append(el('option', { value: '', text: 'Tất cả các lớp' }));
  for (const c of classes) {
    filterSel.append(el('option', {
      value: String(c.id),
      text: `${c.name} (${c.studentCount})${c.isActive ? '' : ' — đã đóng'}`,
    }));
  }
  if (unassigned) {
    filterSel.append(el('option', { value: 'none', text: `Chưa gán lớp (${unassigned})` }));
  }
  filterSel.value = currentClass;

  // Danh sách lớp để đổi tên / xoá.
  const host = clear($('#class-list'));
  if (!classes.length) {
    host.append(el('p', { class: 'small muted', style: 'margin:0', text: 'Chưa có lớp nào. Tạo một lớp để bắt đầu.' }));
    return;
  }
  for (const c of classes) {
    const nameInput = el('input', {
      type: 'text',
      value: c.name,
      maxlength: 100,
      'aria-label': `Tên lớp ${c.name}`,
      style: 'max-width:200px',
    });
    const saveBtn = el('button', {
      class: 'small primary',
      text: 'Lưu',
      hidden: true,
      onclick: (e) =>
        withBusy(e.currentTarget, '…', async () => {
          await api('PATCH', `/api/admin/classes/${c.id}`, { name: nameInput.value });
          toast('Đã đổi tên lớp.');
          await loadAll();
        }),
    });
    nameInput.addEventListener('input', () => { saveBtn.hidden = false; });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });

    host.append(el('div', { class: 'row tight', style: 'padding:4px 0' },
      nameInput,
      el('span', { class: 'small muted', text: `${c.studentCount} học viên · ${c.assignmentCount} bài tập` }),
      el('div', { class: 'grow' }),
      saveBtn,
      el('button', {
        class: 'small ghost',
        text: 'Xoá lớp',
        onclick: (e) => removeClass(e.currentTarget, c),
      }),
    ));
  }
}

$('#new-class-btn').addEventListener('click', (e) =>
  withBusy(e.currentTarget, 'Đang tạo…', async () => {
    const name = $('#new-class-name').value.trim();
    if (!name) {
      setAlert($('#alert'), 'Nhập tên lớp.');
      return;
    }
    const r = await api('POST', '/api/admin/classes', { name });
    $('#new-class-name').value = '';
    currentClass = String(r.class.id);
    localStorage.setItem('classFilter', currentClass);
    toast(`Đã tạo lớp ${r.class.name}.`);
    await loadAll();
  }),
);

async function removeClass(btn, c) {
  const ok = await confirmDialog({
    title: `Xoá lớp "${c.name}"?`,
    message:
      `${c.assignmentCount} bài tập của lớp này sẽ bị xoá vĩnh viễn, kèm toàn bộ ảnh đã nộp.\n\n` +
      `${c.studentCount} học viên KHÔNG bị xoá — chỉ bỏ khỏi lớp, bạn gán lại lớp khác được.`,
    confirmLabel: 'Xoá lớp và bài tập',
  });
  if (!ok) return;
  await withBusy(btn, '…', async () => {
    const r = await api('DELETE', `/api/admin/classes/${c.id}`);
    toast(`Đã xoá lớp, kèm ${r.removedAssignments} bài tập và ${r.removedFiles} ảnh. Giữ lại ${r.keptStudents} học viên.`);
    if (currentClass === String(c.id)) {
      currentClass = '';
      localStorage.removeItem('classFilter');
    }
    await loadAll();
  });
}

$('#class-filter').addEventListener('change', () => {
  currentClass = $('#class-filter').value;
  if (currentClass) localStorage.setItem('classFilter', currentClass);
  else localStorage.removeItem('classFilter');
  loadStudents();
});

// ------------------------------------------------------------ học viên

/**
 * Các bạn đang được tick chọn.
 *
 * Lưu theo id chứ không theo dòng trong bảng: bảng được vẽ lại sau mỗi lần gõ
 * vào ô tìm kiếm, nếu bám vào dòng thì lựa chọn sẽ mất.
 */
const selected = new Set();

async function loadStudents() {
  try {
    const params = new URLSearchParams();
    if ($('#show-inactive').checked) params.set('all', '1');
    if (currentClass) params.set('classId', currentClass);
    const r = await api('GET', '/api/admin/students?' + params);
    students = r.students;
    // Bỏ khỏi danh sách chọn những bạn không còn trong dữ liệu mới.
    const live = new Set(students.map((s) => s.id));
    for (const id of selected) if (!live.has(id)) selected.delete(id);
    render();
  } catch (err) {
    setAlert($('#alert'), err.message);
  }
}

function visibleStudents() {
  const q = $('#filter').value.trim().toLowerCase();
  return q ? students.filter((s) => (s.name + ' ' + s.note).toLowerCase().includes(q)) : students;
}

function render() {
  const shown = visibleStudents();

  const active = students.filter((s) => s.isActive).length;
  $('#count').textContent = `${active} đang học${students.length > active ? `, ${students.length - active} đã ẩn` : ''}`;

  const host = clear($('#list'));
  if (!shown.length) {
    updateBulkBar([]);
    host.append(el('div', {
      class: 'empty',
      text: students.length
        ? 'Không có bạn nào khớp.'
        : currentClass
          ? 'Lớp này chưa có học viên. Dán tên ở trên để thêm.'
          : 'Danh sách còn trống. Dán tên ở trên để bắt đầu.',
    }));
    return;
  }

  // Checkbox tổng: tick = chọn hết những bạn ĐANG HIỆN (theo bộ lọc), không phải
  // cả danh sách — chọn cả những dòng người dùng không thấy là cách dễ xoá oan nhất.
  const headCheck = el('input', {
    type: 'checkbox',
    'aria-label': 'Chọn tất cả các bạn đang hiện',
    onchange: (e) => {
      if (e.currentTarget.checked) for (const s of shown) selected.add(s.id);
      else for (const s of shown) selected.delete(s.id);
      render();
    },
  });

  const tbody = el('tbody');
  for (const s of shown) tbody.append(el('tr', { class: selected.has(s.id) ? 'row-selected' : null }, ...cells(s)));

  host.append(el('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': 'Danh sách học viên' },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { class: 'check-col' }, headCheck),
        el('th', { text: 'Tên' }),
        el('th', { text: 'Ghi chú' }),
        el('th', { text: 'Lớp' }),
        el('th', { class: 'num', text: 'Đã nộp' }),
        el('th', { text: '' }),
      )),
      tbody,
    ),
  ));

  updateBulkBar(shown, headCheck);
}

/** Thanh hành động chỉ xuất hiện khi có ít nhất một bạn được chọn. */
function updateBulkBar(shown, headCheck) {
  const chosen = shown.filter((s) => selected.has(s.id));
  const bar = $('#bulk-bar');
  bar.hidden = chosen.length === 0;

  if (headCheck) {
    headCheck.checked = chosen.length > 0 && chosen.length === shown.length;
    // Trạng thái nửa: chọn một phần. Không có nó thì tick tổng trông như "chưa
    // chọn gì" dù đang chọn 3/10 bạn.
    headCheck.indeterminate = chosen.length > 0 && chosen.length < shown.length;
  }

  if (!chosen.length) return;
  const withWork = chosen.filter((s) => s.submissionCount > 0).length;
  $('#bulk-count').textContent =
    `Đã chọn ${chosen.length} bạn` + (withWork ? ` (${withWork} bạn đã nộp bài)` : '');
}

$('#bulk-clear').addEventListener('click', () => {
  selected.clear();
  render();
});

$('#bulk-delete').addEventListener('click', (e) => bulkDelete(e.currentTarget));

async function bulkDelete(btn) {
  const chosen = visibleStudents().filter((s) => selected.has(s.id));
  if (!chosen.length) return;

  const withWork = chosen.filter((s) => s.submissionCount > 0);
  const noWork = chosen.filter((s) => s.submissionCount === 0);

  const lines = [];
  if (noWork.length) lines.push(`${noWork.length} bạn chưa nộp bài nào → xoá hẳn.`);
  if (withWork.length) {
    lines.push(
      `${withWork.length} bạn đã nộp bài → chỉ ẩn khỏi danh sách, bài nộp và ảnh giữ nguyên.`,
    );
  }

  const ok = await confirmDialog({
    title: `Xoá ${chosen.length} bạn đã chọn?`,
    message: lines.join('\n\n'),
    confirmLabel: 'Xoá',
    // Cho xem đúng những tên sắp bị xoá: danh sách dài thì rất dễ tick nhầm.
    preview: chosen
      .map((s) => `• ${s.name}${s.note ? ` (${s.note})` : ''}${s.submissionCount ? ` — ${s.submissionCount} bài` : ''}`)
      .join('\n'),
  });
  if (!ok) return;

  await withBusy(btn, 'Đang xoá…', async () => {
    const r = await api('POST', '/api/admin/students/bulk-delete', { ids: chosen.map((s) => s.id) });
    selected.clear();
    const parts = [];
    if (r.deleted) parts.push(`xoá ${r.deleted} bạn`);
    if (r.hidden) parts.push(`ẩn ${r.hidden} bạn (bài nộp vẫn còn)`);
    toast('Đã ' + (parts.join(', ') || 'xong') + '.');
    await loadAll();
  });
}

function cells(s) {
  const check = el('input', {
    type: 'checkbox',
    checked: selected.has(s.id),
    'aria-label': `Chọn ${s.name}`,
    onchange: (e) => {
      if (e.currentTarget.checked) selected.add(s.id);
      else selected.delete(s.id);
      // Chỉ cập nhật thanh hành động và màu dòng, KHÔNG vẽ lại cả bảng — vẽ lại
      // sẽ làm mất nội dung đang gõ ở các ô sửa tên khác.
      e.currentTarget.closest('tr')?.classList.toggle('row-selected', e.currentTarget.checked);
      updateBulkBar(visibleStudents(), $('#list thead input[type="checkbox"]'));
    },
  });

  const nameInput = el('input', {
    type: 'text',
    value: s.name,
    maxlength: 200,
    'aria-label': `Tên của ${s.name}`,
    class: 'inline-edit',
  });
  const noteInput = el('input', {
    type: 'text',
    value: s.note,
    maxlength: 200,
    'aria-label': `Ghi chú của ${s.name}`,
    class: 'inline-edit',
    placeholder: s.duplicate ? 'cần ghi chú để phân biệt' : 'ghi chú',
  });

  const markDirty = () => { saveBtn.hidden = false; };
  nameInput.addEventListener('input', markDirty);
  noteInput.addEventListener('input', markDirty);

  const saveBtn = el('button', {
    class: 'small primary',
    text: 'Lưu',
    hidden: true,
    onclick: (e) =>
      withBusy(e.currentTarget, '…', async () => {
        await api('PATCH', `/api/admin/students/${s.id}`, { name: nameInput.value, note: noteInput.value });
        toast('Đã lưu.');
        await loadStudents();
      }),
  });

  const onEnter = (e) => { if (e.key === 'Enter') saveBtn.click(); };
  nameInput.addEventListener('keydown', onEnter);
  noteInput.addEventListener('keydown', onEnter);

  return [
    el('td', { class: 'check-col' }, check),
    el('td', { class: 'name-cell' },
      nameInput,
      s.duplicate ? el('span', { class: 'badge info', text: 'trùng tên', style: 'margin-left:4px' }) : null,
      s.isActive ? null : el('span', { class: 'badge missing', text: 'đã ẩn', style: 'margin-left:4px' }),
    ),
    el('td', { dataset: { label: 'Ghi chú' } }, noteInput),
    el('td', { class: 'small muted', dataset: { label: 'Lớp' }, text: s.className ?? 'chưa gán' }),
    el('td', { class: 'num small', dataset: { label: 'Đã nộp' }, text: String(s.submissionCount) }),
    el('td', {},
      el('div', { class: 'row tight', style: 'justify-content:flex-end' },
        saveBtn,
        s.isActive
          ? el('button', { class: 'small ghost', text: 'Xoá', onclick: (e) => remove(e.currentTarget, s) })
          : el('button', {
              class: 'small ghost',
              text: 'Bỏ ẩn',
              onclick: (e) =>
                withBusy(e.currentTarget, '…', async () => {
                  await api('PATCH', `/api/admin/students/${s.id}`, { isActive: true });
                  toast('Đã bỏ ẩn.');
                  await loadStudents();
                }),
            }),
      ),
    ),
  ];
}

async function remove(btn, s) {
  const hasWork = s.submissionCount > 0;
  const ok = await confirmDialog({
    title: hasWork ? `Ẩn "${s.name}" khỏi danh sách?` : `Xoá "${s.name}"?`,
    message: hasWork
      ? `Bạn này đã nộp ${s.submissionCount} bài. Bài nộp và ảnh vẫn được giữ nguyên, chỉ ẩn tên khỏi danh sách lớp.`
      : 'Bạn này chưa nộp bài nào nên sẽ bị xoá hẳn.',
    confirmLabel: hasWork ? 'Ẩn khỏi danh sách' : 'Xoá',
  });
  if (!ok) return;
  await withBusy(btn, '…', async () => {
    const r = await api('DELETE', `/api/admin/students/${s.id}`);
    toast(r.deactivated ? 'Đã ẩn khỏi danh sách, bài nộp vẫn còn.' : 'Đã xoá.');
    await loadAll();
  });
}

loadAll();

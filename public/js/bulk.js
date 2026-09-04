import {
  api, el, $, clear, setAlert, renderTopbar, toast, withBusy,
  attachCombo, pickStudentDialog, openLightbox,
} from '/js/app.js';

renderTopbar('/admin.html');

const id = new URLSearchParams(location.search).get('id');
if (!id) {
  location.href = '/admin.html';
  throw new Error('thiếu id');
}
$('#back').href = `/assignment.html?id=${id}`;

// Mỗi ảnh: { file, previewUrl, studentId, studentName, candidates, ambiguous, done, error, combo, tr }
let rows = [];
let uploading = false;
let assignment = null;

api('GET', `/api/admin/assignments/${id}/overview`)
  .then((r) => {
    assignment = r.assignment;
    const label = `Tải ảnh lên — ${assignment.title}`;
    $('#title').textContent = label;
    document.title = label;
    if (assignment.className) {
      // Tên lớp người dùng đặt đã có chữ "Lớp" -> không thêm lần nữa.
      $('#class-hint').textContent = `${assignment.className} · ${r.counts.total} học viên`;
    }
  })
  .catch((err) => setAlert($('#alert'), err.message));

// ------------------------------------------------------------ chọn / kéo-thả

$('#files').addEventListener('change', () => addFiles([...$('#files').files]));

const dropZone = $('#drop-zone');
let dragDepth = 0;

// Chỉ nhận thả vào đúng vùng đã ghi "kéo-thả vào đây", và có phản hồi khi kéo qua
// — trước đây kéo 40 file vào mà không có dấu hiệu gì cho biết trang có nhận không.
dropZone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragover', (e) => e.preventDefault());
dropZone.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropZone.classList.remove('dragging');
  }
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('dragging');
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) addFiles(files);
  else toast('Không có file ảnh nào trong thứ bạn vừa thả.', 'err');
});

async function addFiles(files) {
  if (!files.length) return;
  setAlert($('#alert'), '');

  const fresh = files.map((file) => ({
    file,
    previewUrl: URL.createObjectURL(file),
    studentId: null,
    studentName: null,
    candidates: [],
    ambiguous: false,
    done: false,
    error: null,
    combo: null,
    tr: null,
  }));
  rows = rows.concat(fresh);

  $('#grid-card').hidden = false;
  render();

  // Bước 1: chỉ gửi TÊN FILE lên để đoán, chưa gửi ảnh. Browser đã đọc tên file
  // đúng ở local nên không phụ thuộc vào originalname của multer (có thể mojibake).
  try {
    const { matches } = await api('POST', '/api/admin/match', {
      filenames: fresh.map((r) => r.file.name),
      classId: assignment?.classId ?? undefined,
    });
    matches.forEach((m, i) => {
      const row = fresh[i];
      row.candidates = m.candidates;
      row.ambiguous = m.ambiguous;
      if (m.studentId) {
        row.studentId = m.studentId;
        row.studentName = m.candidates[0]?.name ?? null;
      }
    });
    render();
  } catch (err) {
    setAlert($('#alert'), `Không đoán được tên: ${err.message} Bạn vẫn gán tay được.`, 'warn');
  }
}

// ----------------------------------------------------------------- bảng gán

function render() {
  // Dọn combo cũ: mỗi cái gắn listener vào window để đặt lại vị trí danh sách.
  for (const r of rows) r.combo?.destroy();

  const host = clear($('#grid'));
  updateSummary();

  if (!rows.length) {
    $('#grid-card').hidden = true;
    return;
  }

  const tbody = el('tbody');
  rows.forEach((row, i) => tbody.append(rowEl(row, i)));

  host.append(el('div', {
    // KHÔNG dùng .table-wrap ở đây: overflow:auto sẽ CẮT MẤT danh sách gợi ý tên,
    // mà đó là thao tác chính của cả trang này. Bảng xác nhận chỉ dùng một lần
    // nên để trang tự cuộn là đủ.
    class: 'grid-wrap',
  },
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'Ảnh' }),
        el('th', { text: 'File' }),
        el('th', { text: 'Học viên', style: 'min-width:240px' }),
        el('th', { text: '' }),
      )),
      tbody,
    ),
  ));
}

function rowEl(row, index) {
  const tr = el('tr', { class: row.studentId ? 'match-row' : 'match-row unassigned' });
  row.tr = tr;

  const preview = el('button', {
    class: 'zoom',
    'aria-label': `Xem to ${row.file.name}`,
    onclick: () => openLightbox(row.previewUrl, row.file.name),
  }, el('img', { class: 'preview', src: row.previewUrl, alt: '', loading: 'lazy' }));

  if (row.done) {
    tr.append(
      el('td', { dataset: { label: 'Ảnh' } }, preview),
      el('td', { class: 'fname truncate', dataset: { label: 'File' }, text: row.file.name }),
      el('td', { dataset: { label: 'Học viên' } },
        el('span', { class: 'badge approved long', text: `Đã tải lên — ${row.studentName ?? ''}` })),
      el('td', {}),
    );
    return tr;
  }

  const inputId = `assign-${index}`;
  const input = el('input', {
    type: 'text',
    id: inputId,
    'aria-label': `Học viên cho ảnh ${row.file.name}`,
    value: row.studentName ?? '',
    placeholder: 'Gõ tên (không dấu cũng được)…',
  });
  const cell = el('td', { dataset: { label: 'Học viên' } });
  cell.append(input);

  row.combo = attachCombo(input, {
    search: async (q) => {
      const url = `/api/admin/students/search?q=${encodeURIComponent(q)}` +
        (assignment?.classId ? `&classId=${assignment.classId}` : '');
      return (await api('GET', url)).students;
    },
    onPick: (s) => {
      row.studentId = s?.id ?? null;
      row.studentName = s?.name ?? null;
      // Chỉ sửa dòng này và dòng tổng, KHÔNG render lại cả bảng: render lại làm
      // mất vị trí cuộn và mất focus giữa lúc đang gán 80 ảnh.
      tr.className = row.studentId ? 'match-row' : 'match-row unassigned';
      updateSummary();
    },
  });
  if (row.studentId && row.studentName) {
    row.combo.setPicked({ id: row.studentId, name: row.studentName });
  }

  // Gợi ý bấm 1 lần: nhanh hơn gõ, và là chỗ duy nhất giải quyết trùng tên.
  const hints = el('div', { class: 'row tight small', style: 'margin-top:5px' });
  if (row.ambiguous) {
    hints.append(el('span', { class: 'badge info', text: 'trùng tên — chọn đúng bạn' }));
  }
  for (const c of row.candidates.slice(0, 3)) {
    if (c.id === row.studentId) continue;
    // Điểm quá thấp thì chỉ là trùng một chữ ("Thị") — hiện ra chỉ gây nhiễu.
    if (c.score < 0.45 && !row.ambiguous) continue;
    hints.append(el('button', {
      class: 'small ghost',
      text: `${c.name}${c.note ? ` (${c.note})` : ''}`,
      onclick: (e) => {
        row.studentId = c.id;
        row.studentName = c.name;
        row.combo.setPicked(c);
        tr.className = 'match-row';
        // Ẩn nút vừa bấm thay vì vẽ lại bảng — vẽ lại thì nút biến mất, focus rơi
        // xuống body và Tab tiếp theo quay về đầu trang.
        e.currentTarget.hidden = true;
        updateSummary();
      },
    }));
  }
  if (hints.children.length) cell.append(hints);

  tr.append(
    el('td', { dataset: { label: 'Ảnh' } }, preview),
    el('td', { dataset: { label: 'File' } },
      el('div', { class: 'fname truncate', text: row.file.name, title: row.file.name }),
      row.error ? el('div', { class: 'small', style: 'color:var(--bad)', text: row.error }) : null,
    ),
    cell,
    el('td', {},
      el('button', {
        class: 'small ghost',
        text: '✕',
        'aria-label': `Bỏ ảnh ${row.file.name}`,
        title: 'Bỏ ảnh này',
        onclick: () => {
          URL.revokeObjectURL(row.previewUrl);
          row.combo?.destroy();
          rows.splice(rows.indexOf(row), 1);
          render();
        },
      }),
    ),
  );
  return tr;
}

function updateSummary() {
  const assigned = rows.filter((r) => r.studentId && !r.done).length;
  const doneCount = rows.filter((r) => r.done).length;
  const empty = rows.length - assigned - doneCount;
  $('#summary').textContent =
    `${rows.length} ảnh · đã gán ${assigned} · còn trống ${empty}` +
    (doneCount ? ` · đã tải lên ${doneCount}` : '');
  $('#upload-btn').disabled = uploading || assigned === 0;
  $('#upload-btn').textContent = uploading ? 'Đang tải lên…' : `Tải lên ${assigned} ảnh`;
}

/** Nhiều ảnh của cùng 1 bạn là trường hợp thường gặp nhất, nên làm 1 nút. */
$('#assign-rest').addEventListener('click', async () => {
  const empty = rows.filter((r) => !r.studentId && !r.done);
  if (!empty.length) return toast('Không còn dòng trống.', 'info');

  const target = await pickStudentDialog({
    title: `Gán ${empty.length} ảnh chưa có tên`,
    subtitle: 'Chọn học viên sẽ nhận tất cả các ảnh chưa gán:',
    confirmLabel: `Gán ${empty.length} ảnh`,
    classId: assignment?.classId,
  });
  if (!target) return;

  for (const row of empty) {
    row.studentId = target.id;
    row.studentName = target.name;
  }
  render();
  toast(`Đã gán ${empty.length} ảnh cho ${target.name}.`);
});

$('#clear-all').addEventListener('click', () => {
  for (const r of rows) {
    URL.revokeObjectURL(r.previewUrl);
    r.combo?.destroy();
  }
  rows = [];
  $('#files').value = '';
  clear($('#upload-result'));
  render();
});

// ------------------------------------------------------------------- upload

const BATCH = 5;

function setProgress(pct, text) {
  const bar = $('#progress');
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.firstElementChild.style.width = pct + '%';
  $('#progress-text').textContent = text;
}

/** Gửi 1 lô với tiến độ byte thật. fetch không báo được tiến độ upload. */
function uploadBatch(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/admin/assignments/${id}/bulk`);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* không phải JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data ?? {});
      else if (xhr.status === 401) {
        location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
        reject(new Error('Cần đăng nhập lại'));
      } else reject(new Error(data?.error ?? `Không tải lên được (mã ${xhr.status}).`));
    });
    xhr.addEventListener('error', () => reject(new Error('Mất kết nối. Kiểm tra mạng rồi thử lại.')));
    xhr.addEventListener('timeout', () => reject(new Error('Mạng quá chậm, lô này chưa gửi xong. Thử lại.')));
    xhr.timeout = 180000;
    xhr.send(form);
  });
}

/**
 * Tải lên theo LÔ nhỏ, mỗi lô 1 request.
 *
 * Một request 80 file thì vượt limit, và nếu file thứ 57 lỗi thì cả request đổ
 * bể sau khi đã tải mấy trăm MB — browser báo lỗi network chung, không đọc được
 * JSON. Chia lô: lỗi chỉ mất 1 lô, có progress thật, retry được.
 *
 * Ghép ảnh với học viên bằng FIELDNAME "f_<studentId>_<i>", không theo thứ tự
 * mảng: file bị loại giữa đường sẽ làm lệch toàn bộ phần sau.
 */
$('#upload-btn').addEventListener('click', async () => {
  const todo = rows.filter((r) => r.studentId && !r.done);
  if (!todo.length) return;

  uploading = true;
  clear($('#upload-result'));
  $('#progress').hidden = false;
  setProgress(0, `0/${todo.length} ảnh`);
  updateSummary();

  let uploaded = 0;
  const failures = [];

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const form = new FormData();
    const names = {};

    batch.forEach((row, k) => {
      const field = `f_${row.studentId}_${i + k}`;
      form.append(field, row.file, row.file.name);
      // Gửi kèm tên file đúng: originalname của multer có thể bị mojibake.
      names[field] = row.file.name;
    });
    form.append('names', JSON.stringify(names));

    try {
      const data = await uploadBatch(form, (frac) => {
        const pct = ((i + batch.length * frac) / todo.length) * 100;
        setProgress(pct, `${i + Math.round(batch.length * frac)}/${todo.length} ảnh`);
      });

      const errorByField = new Map((data.errors ?? []).map((e) => [e.fieldname, e.error]));
      batch.forEach((row, k) => {
        const field = `f_${row.studentId}_${i + k}`;
        if (errorByField.has(field)) {
          row.error = errorByField.get(field);
          failures.push({ name: row.file.name, error: row.error });
        } else {
          row.done = true;
          row.error = null;
          uploaded++;
        }
      });
    } catch (err) {
      for (const row of batch) {
        row.error = err.message;
        failures.push({ name: row.file.name, error: err.message });
      }
    }

    setProgress(((i + batch.length) / todo.length) * 100, `${Math.min(i + batch.length, todo.length)}/${todo.length} ảnh`);
    render();
  }

  uploading = false;
  $('#progress').hidden = true;
  setProgress(0, '');
  render();

  const result = clear($('#upload-result'));
  if (uploaded) {
    result.append(el('div', { class: 'alert ok' },
      `Đã tải lên ${uploaded} ảnh. `,
      el('a', { href: `/assignment.html?id=${id}`, text: 'Xem bảng tổng hợp →' }),
    ));
  }
  if (failures.length) {
    result.append(el('div', { class: 'alert err stack' },
      el('div', { text: `${failures.length} ảnh không tải được — bấm "Tải lên" lần nữa để thử lại:` }),
      el('ul', { style: 'margin:6px 0 0;padding-left:20px' },
        failures.slice(0, 10).map((f) => el('li', { class: 'small', text: `${f.name}: ${f.error}` })),
      ),
    ));
  }
  if (uploaded && !failures.length) {
    // Dọn các dòng đã xong để lần kéo-thả tiếp theo bắt đầu sạch sẽ.
    setTimeout(() => {
      for (const r of rows.filter((x) => x.done)) {
        URL.revokeObjectURL(r.previewUrl);
        r.combo?.destroy();
      }
      rows = rows.filter((r) => !r.done);
      $('#files').value = '';
      render();
    }, 2000);
  }
});

void withBusy;

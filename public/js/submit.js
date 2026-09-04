import {
  el, $, clear, setAlert, formatTime, relativeDeadline, attachCombo,
  openLightbox, httpMessage,
} from '/js/app.js';

const slug = location.pathname.split('/').filter(Boolean).pop();
let assignment = null;
let picked = null;
// { file, url, done } — giữ url để thu hồi được, không tạo lại mỗi lần vẽ.
let items = [];

/** Fetch không kèm chuyển hướng đăng nhập (trang này không cần tài khoản). */
async function get(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('Mất kết nối. Kiểm tra Wi-Fi rồi thử lại.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? httpMessage(res.status));
  return data;
}

try {
  const r = await get(`/api/public/a/${encodeURIComponent(slug)}`);
  assignment = r.assignment;
  $('#loading').hidden = true;
  $('#app').hidden = false;
  renderHeader();
} catch (err) {
  $('#loading').hidden = true;
  $('#app').hidden = false;
  clear($('#app')).append(el('div', { class: 'alert err', text: err.message }));
}

function renderHeader() {
  document.title = `Nộp bài: ${assignment.title}`;
  $('#title').textContent = assignment.title;
  $('#description').textContent = assignment.description ?? '';

  const dl = relativeDeadline(assignment.dueAt);
  const dline = $('#deadline');
  if (assignment.dueAt) {
    dline.textContent = `Hạn nộp: ${formatTime(assignment.dueAt)} — ${dl.text}`;
    dline.style.color = dl.late ? 'var(--bad)' : 'var(--ink-2)';
  } else {
    dline.textContent = 'Không có hạn nộp';
    dline.className = 'small muted';
  }

  if (!assignment.isOpen) {
    // Cùng một hàm isOpen() ở server quyết định, nên trang này không bao giờ
    // hiện "còn mở" trong khi server lại chặn.
    $('#closed-box').hidden = false;
    $('#closed-box').textContent = assignment.isClosed
      ? 'Bài tập đã đóng, không nhận thêm bài nộp. Liên hệ giáo viên nếu bạn cần nộp bù.'
      : 'Đã quá hạn nộp bài. Liên hệ giáo viên để được nộp bù.';
    return;
  }

  // Có PIN thì hỏi PIN trước. Không cho thấy ô gõ tên ngay vì gợi ý tên chính là
  // danh sách lớp — đó là thứ PIN cần bảo vệ.
  if (assignment.needsPin) {
    $('#pin-form').hidden = false;
    $('#pin').focus();
    setupPinForm();
    return;
  }

  $('#form').hidden = false;
  setupForm();
}

/** Mã PIN đã xác nhận, gửi kèm mọi request sau đó. */
let pin = '';

function setupPinForm() {
  $('#pin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#pin-submit');
    const value = $('#pin').value.trim();
    setAlert($('#pin-alert'), '');
    if (!value) {
      setAlert($('#pin-alert'), 'Nhập mã PIN.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Đang kiểm tra…';
    try {
      const res = await fetch(`/api/public/a/${encodeURIComponent(slug)}/pin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin: value }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? httpMessage(res.status));

      pin = value;
      $('#pin-form').hidden = true;
      $('#form').hidden = false;
      setupForm();
      $('#name').focus();
    } catch (err) {
      setAlert($('#pin-alert'), err.message);
      $('#pin').select();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Tiếp tục';
    }
  });
}

function setupForm() {
  attachCombo($('#name'), {
    // Server yêu cầu tối thiểu 2 ký tự (1 ký tự thì chỉ cần lặp bảng chữ cái là
    // dò được cả danh sách lớp).
    minChars: 2,
    search: async (q) => {
      const qs = new URLSearchParams({ q });
      // PIN phải gửi kèm: server chặn cả đường tra tên khi bài tập có PIN.
      if (pin) qs.set('pin', pin);
      return (await get(`/api/public/a/${encodeURIComponent(slug)}/students?${qs}`)).students;
    },
    onPick: (s) => {
      picked = s;
      const box = $('#picked');
      box.hidden = !s;
      if (s) {
        box.textContent = `Bạn đang nộp với tên: ${s.name}${s.note ? ` (${s.note})` : ''}`;
      }
    },
  });

  $('#photos').addEventListener('change', () => {
    for (const it of items) URL.revokeObjectURL(it.url);
    items = [...$('#photos').files].map((file) => ({
      file,
      url: URL.createObjectURL(file),
      done: false,
    }));
    renderPreviews();
  });

  $('#form').addEventListener('submit', submit);
  $('#again').addEventListener('click', () => {
    $('#done').hidden = true;
    $('#form').hidden = false;
    for (const it of items) URL.revokeObjectURL(it.url);
    items = [];
    $('#photos').value = '';
    renderPreviews();
    setAlert($('#alert'), '');
    setProgress(0, '');
  });
}

function renderPreviews() {
  const host = clear($('#previews'));
  items.forEach((it, i) => {
    host.append(el('div', { class: it.done ? 'thumb old' : 'thumb' },
      el('button', {
        class: 'zoom',
        type: 'button',
        'aria-label': `Xem to ảnh ${i + 1}`,
        onclick: () => openLightbox(it.url, `Ảnh ${i + 1}/${items.length}`),
      },
        el('img', { src: it.url, alt: `Ảnh đã chọn ${i + 1}/${items.length}`, width: 132, height: 132 }),
      ),
      it.done
        ? el('span', { class: 'tag', text: 'đã gửi' })
        : el('button', {
            class: 'del',
            text: '✕',
            type: 'button',
            'aria-label': `Bỏ ảnh ${i + 1}`,
            title: 'Bỏ ảnh này',
            onclick: () => {
              URL.revokeObjectURL(it.url);
              items.splice(i, 1);
              renderPreviews();
            },
          }),
    ));
  });
}

/**
 * Thu nhỏ ảnh trước khi gửi: ảnh điện thoại 4MB thành ~300KB.
 * Mạng lớp học thường yếu, và không cần độ phân giải gốc để xem bài.
 *
 * Dùng resizeWidth/resizeHeight của createImageBitmap để trình duyệt giải mã
 * thẳng ra kích thước đích: giải mã ảnh 12MP ra RGBA đầy đủ là ~48MB, đủ để
 * điện thoại 2GB RAM đóng tab giữa lúc nộp bài.
 */
async function downscale(file) {
  const MAX = 1600;
  let bitmap = null;
  let canvas = null;
  try {
    const probe = await createImageBitmap(file);
    const w = probe.width;
    const h = probe.height;
    if (w <= MAX && h <= MAX && file.size < 1.5 * 1024 * 1024) {
      probe.close?.();
      return file;
    }
    const scale = Math.min(1, MAX / Math.max(w, h));
    const tw = Math.round(w * scale);
    const th = Math.round(h * scale);
    probe.close?.();

    bitmap = await createImageBitmap(file, {
      resizeWidth: tw,
      resizeHeight: th,
      resizeQuality: 'high',
    });
    canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, tw, th);

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    const base = file.name.replace(/\.[^.]+$/, '');
    return new File([blob], base + '.jpg', { type: 'image/jpeg' });
  } catch {
    // Ảnh lạ hoặc hết bộ nhớ: gửi nguyên bản, server vẫn kiểm được.
    return file;
  } finally {
    bitmap?.close?.();
    // Giải phóng bộ đệm canvas ngay, quan trọng trên iOS.
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

const BATCH = 3;

function setProgress(pct, text) {
  const bar = $('#progress');
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.firstElementChild.style.width = pct + '%';
  $('#progress-text').textContent = text;
}

/** Gửi 1 lô, có tiến độ byte thật. fetch không báo được tiến độ upload. */
function uploadBatch(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/public/a/${encodeURIComponent(slug)}/submit`);
    // Gửi PIN qua header, không qua form: server kiểm PIN TRƯỚC khi bóc multipart
    // (để request sai PIN không nạp cả trăm MB ảnh vào RAM), lúc đó body chưa đọc được.
    if (pin) xhr.setRequestHeader('x-pin', pin);
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
      else reject(new Error(data?.error ?? httpMessage(xhr.status)));
    });
    xhr.addEventListener('error', () => reject(new Error('Mất kết nối. Kiểm tra Wi-Fi rồi thử lại.')));
    xhr.addEventListener('timeout', () => reject(new Error('Mạng quá chậm, gửi ảnh không xong. Thử lại.')));
    xhr.timeout = 120000;
    xhr.send(form);
  });
}

async function submit(e) {
  e.preventDefault();
  setAlert($('#alert'), '');

  if (!picked) {
    setAlert($('#alert'), 'Hãy chọn đúng tên của bạn trong danh sách gợi ý.');
    $('#name').focus();
    return;
  }
  const todo = items.filter((it) => !it.done);
  if (!todo.length) {
    setAlert($('#alert'), items.length ? 'Tất cả ảnh đã gửi xong.' : 'Hãy chọn ít nhất một ảnh.');
    return;
  }

  const btn = $('#submit');
  btn.disabled = true;
  btn.textContent = 'Đang nộp…';
  $('#progress').hidden = false;
  setProgress(0, 'Đang chuẩn bị…');

  let sent = 0;
  let failed = 0;
  const problems = [];
  // Thu nhỏ ảnh chiếm 40% thanh tiến độ: trên điện thoại yếu, mỗi ảnh mất 0.5-2
  // giây, không tính vào thì thanh đứng ở 0% suốt cả chục giây và học viên tưởng
  // web treo rồi bấm lại.
  const RESIZE_SHARE = 0.4;
  let prepared = 0;

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const form = new FormData();
    form.append('studentId', String(picked.id));
    form.append('typedName', $('#name').value);

    try {
      for (const [k, it] of batch.entries()) {
        setProgress(
          (prepared / todo.length) * RESIZE_SHARE * 100,
          `Đang thu nhỏ ảnh ${prepared + 1}/${todo.length}…`,
        );
        const small = await downscale(it.file);
        form.append(`f_${picked.id}_${i + k}`, small, small.name);
        prepared++;
      }

      const data = await uploadBatch(form, (frac) => {
        const base = RESIZE_SHARE + ((i / todo.length) * (1 - RESIZE_SHARE));
        const span = (batch.length / todo.length) * (1 - RESIZE_SHARE);
        setProgress((base + span * frac) * 100, `Đang gửi ảnh ${i + batch.length}/${todo.length}…`);
      });

      sent += data.savedCount ?? 0;
      for (const err of data.errors ?? []) problems.push(err.error);
      // Đánh dấu từng ảnh đã gửi: bấm "Nộp bài" lần nữa chỉ gửi phần còn thiếu,
      // không gửi trùng.
      for (const it of batch) it.done = true;
    } catch (err) {
      // Lô này lỗi thì bỏ lô này, các lô sau vẫn thử — không mất công những ảnh
      // đã gửi được.
      failed += batch.length;
      problems.push(err.message);
    }
    renderPreviews();
  }

  btn.disabled = false;
  btn.textContent = 'Nộp bài';
  $('#progress').hidden = true;
  setProgress(0, '');

  if (sent && !failed) {
    $('#form').hidden = true;
    $('#done').hidden = false;
    $('#done-title').textContent = `Đã nộp ${sent} ảnh. Cảm ơn ${picked.name}!`;
    $('#done-detail').textContent = problems.length
      ? `Có ${problems.length} ảnh không nhận được: ${problems[0]}`
      : 'Giáo viên sẽ xem và duyệt bài của bạn.';
    return;
  }

  if (sent) {
    setAlert(
      $('#alert'),
      `Đã gửi được ${sent} ảnh, còn ${failed} ảnh chưa gửi. ` +
        'Bấm "Nộp bài" lần nữa để gửi phần còn lại — ảnh đã gửi sẽ không bị trùng. ' +
        (problems[0] ?? ''),
      'warn',
    );
  } else {
    setAlert($('#alert'), problems[0] ?? 'Không gửi được ảnh nào. Thử lại.');
  }
}

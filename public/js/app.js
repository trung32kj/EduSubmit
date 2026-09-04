/** Tiện ích dùng chung cho các trang. Không bundler, chỉ ES module. */

/**
 * Lọc tham số ?next= trước khi gán vào location.href.
 *
 * Gán location.href = "javascript:fetch(...)" từ một script cùng nguồn sẽ THỰC
 * THI đoạn mã đó trong nguồn của trang, với quyền của admin đang đăng nhập.
 * "//evil.example" thì thành chuyển hướng ra ngoài. Chỉ nhận đường dẫn nội bộ
 * bắt đầu bằng một dấu "/" và không phải "//" hay "/\".
 */
export function safeNextUrl(raw, fallback = '/admin.html') {
  if (typeof raw !== 'string') return fallback;
  return /^\/[^/\\]/.test(raw) ? raw : fallback;
}

/** Gọi API JSON. Ném Error với message tiếng Việt từ server. */
export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch chỉ reject khi không kết nối được. Message gốc là tiếng Anh của
    // trình duyệt ("Failed to fetch") — không đưa thứ đó cho người dùng.
    throw new Error('Mất kết nối. Kiểm tra Wi-Fi rồi thử lại.');
  }

  if (res.status === 401 && !url.includes('/me')) {
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
    throw new Error('Cần đăng nhập');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* không phải JSON */
  }
  if (!res.ok) throw new Error(data?.error ?? httpMessage(res.status));
  return data;
}

/** Thông báo cuối cùng khi server không trả JSON — "Lỗi 502" không giúp được gì. */
export function httpMessage(status) {
  if (status === 413) return 'Ảnh quá lớn, máy chủ không nhận. Chọn ảnh nhỏ hơn.';
  if (status === 429) return 'Bạn thao tác quá nhanh. Chờ một lát rồi thử lại.';
  if (status === 507) return 'Máy chủ đã hết chỗ lưu ảnh. Nhắn cho giáo viên.';
  if (status >= 500) return 'Máy chủ đang lỗi. Thử lại sau một lát.';
  if (status === 404) return 'Không tìm thấy dữ liệu này. Có thể nó đã bị xoá.';
  return `Không thực hiện được (mã ${status}).`;
}

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'xlink:href']);

/**
 * Tạo element. Mọi text đi qua textContent, không bao giờ innerHTML —
 * tên học viên và ghi chú là dữ liệu người dùng nhập.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) {
      // Chỉ nhận hàm. Chuỗi sẽ rơi xuống setAttribute('onclick', ...) và ĐƯỢC
      // THỰC THI — không để dữ liệu người dùng đi vào đường đó dù hiện chưa có
      // chỗ nào truyền chuỗi.
      if (typeof v === 'function') node.addEventListener(k.slice(2), v);
      else throw new TypeError(`el(): "${k}" phải là hàm, không phải ${typeof v}`);
    } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') node[k] = v;
    else if (URL_ATTRS.has(k)) {
      // Chặn javascript: / data: lọt vào href/src.
      const url = String(v);
      if (!/^(?:\/|#|https?:|blob:|mailto:)/.test(url)) {
        throw new TypeError(`el(): "${k}" có URL không hợp lệ`);
      }
      node.setAttribute(k, url);
    } else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function setAlert(node, message, kind = 'err') {
  if (!node) return;
  node.className = message ? `alert ${kind}` : 'alert';
  // role="alert" là assertive: chỉ dùng cho lỗi. Thông báo thành công dùng
  // status để không cắt ngang thứ trình đọc màn hình đang đọc.
  node.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  node.textContent = message ?? '';
}

const STATUS_TEXT = {
  pending: 'Chờ duyệt',
  approved: 'Đạt',
  // Phải khớp với chữ ở mọi nơi khác ("Cần nộp lại"): nhãn trong bảng nói một
  // kiểu mà nút và bộ lọc nói kiểu khác thì rất khó đối chiếu.
  rejected: 'Cần nộp lại',
  missing: 'Chưa nộp',
};

export const statusText = (s) => STATUS_TEXT[s] ?? s;

export function statusBadge(status) {
  return el('span', { class: `badge ${status}`, text: statusText(status) });
}

/** Giờ Việt Nam, đọc được ngay. Mốc thời gian trong DB là epoch ms. */
export function formatTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBytes(n) {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** Còn bao lâu / đã quá hạn bao lâu. */
export function relativeDeadline(dueAt) {
  if (!dueAt) return { text: 'Không có hạn nộp', late: false };
  const diff = dueAt - Date.now();
  const late = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60000);
  const unit =
    mins < 60
      ? `${mins} phút`
      : mins < 60 * 48
        ? `${Math.round(mins / 60)} giờ`
        : `${Math.round(mins / 1440)} ngày`;
  return { text: late ? `Đã quá hạn ${unit}` : `Còn ${unit}`, late };
}

/** epoch ms -> chuỗi cho <input type="datetime-local"> (giờ local). */
export function toDatetimeLocal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * <input type="datetime-local"> -> epoch ms.
 * Trình duyệt trả giờ local không có timezone; new Date(...) hiểu đúng là giờ
 * local nên .getTime() ra mốc UTC chính xác. Đừng so sánh chuỗi ISO với nhau.
 */
export function fromDatetimeLocal(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Copy vào clipboard, có đường lùi cho trình duyệt cũ / http. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  }
}

/** Thông báo nổi góc dưới. Lỗi thì không tự tắt — người dùng cần đọc kịp. */
export function toast(message, kind = 'ok') {
  let host = $('#toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host' });
    document.body.append(host);
  }
  // Quá 3 thông báo thì bỏ cái cũ nhất, không thì một vòng lặp lỗi phủ kín màn hình.
  while (host.children.length >= 3) host.firstElementChild.remove();

  const isErr = kind === 'err';
  const node = el('div', {
    class: `alert ${kind} toast`,
    // role="status" là polite: thông báo lỗi sẽ bị xếp sau và có thể bị bỏ hẳn
    // khi node bị xoá. Lỗi phải là assertive.
    role: isErr ? 'alert' : 'status',
  }, el('span', { class: 'grow', text: message }));

  if (isErr) {
    node.append(el('button', {
      class: 'ghost small',
      text: '✕',
      'aria-label': 'Đóng thông báo',
      onclick: () => node.remove(),
    }));
  }
  host.append(node);

  if (!isErr) {
    // Thông báo thành công thì tự tắt, nhưng dừng đếm khi người dùng đang đọc.
    let timer = setTimeout(() => node.remove(), 4000);
    node.addEventListener('mouseenter', () => clearTimeout(timer));
    node.addEventListener('focusin', () => clearTimeout(timer));
    node.addEventListener('mouseleave', () => {
      timer = setTimeout(() => node.remove(), 2000);
    });
  }
  return node;
}

/**
 * Bọc một hành động gọi API: khoá nút, đổi chữ, báo lỗi, mở lại nút.
 *
 * Không có nó thì mạng chậm khiến giáo viên bấm "Đạt" hai ba lần và gửi trùng
 * request, còn nút nào quên try/catch thì bấm vào không thấy gì xảy ra cả.
 */
export async function withBusy(btn, busyLabel, fn) {
  if (btn.disabled) return undefined;
  const original = btn.textContent;
  btn.disabled = true;
  if (busyLabel) btn.textContent = busyLabel;
  try {
    return await fn();
  } catch (err) {
    toast(err.message, 'err');
    return undefined;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/** Chờ người dùng bấm xác nhận cho hành động không hoàn lại được. */
export function confirmAction(message) {
  return window.confirm(message);
}

/**
 * Hộp thoại xác nhận thay cho window.confirm.
 *
 * window.confirm có một cái bẫy thật: sau vài lần, trình duyệt hiện "Chặn trang
 * này tạo thêm hộp thoại" — tích vào là mọi confirm sau đó trả về false, nên nút
 * xoá lặng lẽ không làm gì và người dùng tưởng web hỏng.
 *
 * Trả Promise<boolean>. Chữ trên nút chính nói rõ hành động, không phải "OK".
 */
export function confirmDialog({ title, message, confirmLabel = 'Xác nhận', danger = true, preview }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };

    const dlg = el('dialog', { class: 'modal' },
      el('div', { class: 'card stack modal-body' },
        el('h2', { text: title }),
        preview ? el('img', { class: 'modal-preview', src: preview, alt: '' }) : null,
        message ? el('p', { class: 'small', style: 'white-space:pre-wrap;margin:0', text: message }) : null,
        el('div', { class: 'row', style: 'justify-content:flex-end' },
          el('button', { class: 'ghost', text: 'Huỷ', onclick: () => finish(false) }),
          el('button', {
            class: danger ? 'danger' : 'primary',
            text: confirmLabel,
            onclick: () => finish(true),
          }),
        ),
      ),
    );
    // Escape và bấm ra ngoài đều là "huỷ" — mặc định an toàn cho việc xoá.
    dlg.addEventListener('cancel', () => finish(false));
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) finish(false);
    });
    document.body.append(dlg);
    dlg.showModal();
    // Focus vào nút Huỷ, không phải nút xoá: Enter theo phản xạ không xoá mất gì.
    $('button.ghost', dlg).focus();
  });
}

/**
 * Hộp thoại chọn học viên, có ô gõ tên với gợi ý.
 *
 * Thay cho window.prompt + "gõ số thứ tự": prompt không có gợi ý tên (mà tìm tên
 * tiếng Việt chính là giá trị của app này), che mất ảnh đang cần xem, và bị chặn
 * sau vài lần dùng.
 */
export function pickStudentDialog({ title, subtitle, preview, confirmLabel = 'Chọn', classId }) {
  return new Promise((resolve) => {
    let done = false;
    let combo = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      combo?.destroy();
      dlg.close();
      dlg.remove();
      resolve(v);
    };

    const input = el('input', { type: 'text', id: 'pick-name', placeholder: 'Gõ tên, không cần dấu…' });
    const okBtn = el('button', {
      class: 'primary',
      text: confirmLabel,
      disabled: true,
      onclick: () => finish(combo?.picked ?? null),
    });
    const warn = el('div', { class: 'alert warn small', hidden: true });

    const dlg = el('dialog', { class: 'modal' },
      el('div', { class: 'card stack modal-body' },
        el('h2', { text: title }),
        subtitle ? el('p', { class: 'small muted', style: 'margin:0', text: subtitle }) : null,
        preview ? el('img', { class: 'modal-preview', src: preview, alt: '' }) : null,
        el('div', {},
          el('label', { for: 'pick-name', text: 'Tên học viên' }),
          input,
        ),
        warn,
        el('div', { class: 'row', style: 'justify-content:flex-end' },
          el('button', { class: 'ghost', text: 'Huỷ', onclick: () => finish(null) }),
          okBtn,
        ),
      ),
    );

    dlg.addEventListener('cancel', () => finish(null));
    document.body.append(dlg);
    dlg.showModal();

    combo = attachCombo(input, {
      search: async (q) => {
        const url = `/api/admin/students/search?q=${encodeURIComponent(q)}` +
          (classId ? `&classId=${classId}` : '');
        return (await api('GET', url)).students;
      },
      // Nút xác nhận chỉ mở khi đã chọn hẳn một người: không còn đường nào để
      // gõ nửa vời rồi gán sai.
      onPick: (s) => {
        okBtn.disabled = !s;
        warn.hidden = !s?.duplicate;
        if (s?.duplicate) {
          warn.textContent = 'Lớp có nhiều bạn cùng tên này. Kiểm tra ghi chú để chắc là đúng bạn.';
        }
      },
    });
    input.focus();
  });
}

export function debounce(fn, ms = 180) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Xem ảnh to. */
export function openLightbox(url, caption) {
  let dlg = $('#lightbox');
  if (!dlg) {
    dlg = el('dialog', {
      id: 'lightbox',
      class: 'lightbox',
      onclick: (e) => {
        if (e.target === dlg) dlg.close();
      },
    },
      el('button', {
        class: 'close',
        text: '✕',
        'aria-label': 'Đóng',
        onclick: () => dlg.close(),
      }),
      el('img', { alt: '' }),
      el('div', { class: 'cap' }),
    );
    document.body.append(dlg);
  }
  $('img', dlg).src = url;
  $('img', dlg).alt = caption ?? '';
  $('.cap', dlg).textContent = caption ?? '';
  dlg.showModal();
  // Có nút để focus vào thì đóng bằng bàn phím được, và khi đóng thì focus trả
  // về đúng chỗ cũ thay vì rơi xuống <body>.
  $('button.close', dlg).focus();
}

/**
 * Ô nhập tên có gợi ý.
 *
 * Dùng cho cả trang nộp của học viên và bảng gán ảnh của admin.
 * onPick(student|null) được gọi khi chọn xong; gõ lại thì trả null để tránh
 * trường hợp đã chọn A rồi sửa chữ nhưng vẫn nộp dưới tên A.
 */
let comboSeq = 0;

export function attachCombo(input, { search, onPick, placeholderNote = '', minChars = 1 }) {
  const uid = 'combo-' + ++comboSeq;
  const list = el('ul', { class: 'combo-list', hidden: true, role: 'listbox', id: uid });
  const status = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const wrap = el('div', { class: 'combo' });
  input.parentNode.insertBefore(wrap, input);
  wrap.append(input, list, status);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', uid);
  input.autocomplete = 'off';

  let items = [];
  let active = -1;
  let picked = null;
  // Mỗi lần gõ tăng số này lên. Phản hồi của truy vấn cũ về sau sẽ bị bỏ —
  // nếu không thì mạng chậm khiến kết quả của "ng" ghi đè kết quả của "nguyen an".
  let seq = 0;
  let state = 'idle'; // idle | loading | results | empty | error

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const open = () => {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    placeList();
  };

  /**
   * Đặt vị trí danh sách gợi ý.
   *
   * position:fixed để thoát khỏi khung cuộn của bảng (bulk.html): danh sách nằm
   * trong .table-wrap có overflow:auto sẽ bị CẮT MẤT, z-index không giải quyết được.
   * Đồng thời tính chỗ trống thực tế dưới ô nhập — bàn phím điện thoại chiếm nửa
   * màn hình, không tính thì danh sách nằm sau bàn phím và học viên tưởng là
   * không tìm thấy tên mình.
   */
  function placeList() {
    const r = input.getBoundingClientRect();
    const vv = window.visualViewport;
    const viewH = vv ? vv.height : window.innerHeight;
    const below = viewH - r.bottom - 8;
    const above = r.top - 8;
    const flipUp = below < 170 && above > below;
    const space = Math.max(120, Math.min(300, flipUp ? above : below));

    list.style.position = 'fixed';
    // Rộng bằng ô nhập, nhưng tối thiểu 240px: ô nhập trong bảng có thể rất hẹp,
    // và tên tiếng Việt kèm ghi chú bị ngắt thành từng chữ thì không đọc được.
    const width = Math.min(Math.max(r.width, 240), window.innerWidth - 16);
    list.style.width = width + 'px';
    // Không để tràn ra ngoài mép phải khi đã nới rộng.
    list.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + 'px';
    list.style.maxHeight = space + 'px';
    if (flipUp) {
      list.style.top = 'auto';
      list.style.bottom = viewH - r.top + 6 + 'px';
    } else {
      list.style.bottom = 'auto';
      list.style.top = r.bottom + 6 + 'px';
    }
  }

  const reposition = () => {
    if (!list.hidden) placeList();
  };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  window.visualViewport?.addEventListener('resize', reposition);

  function setActive(next) {
    const prev = list.children[active];
    if (prev) prev.setAttribute('aria-selected', 'false');
    active = next;
    const cur = list.children[active];
    if (cur) {
      cur.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', cur.id);
      // Danh sách chỉ hiện ~6 dòng nhưng server trả tới 8: không cuộn thì mũi
      // xuống di chuyển một vệt sáng vô hình.
      cur.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  const render = () => {
    clear(list);

    if (state === 'loading') {
      list.append(el('li', { class: 'msg', 'aria-disabled': 'true' },
        el('span', { class: 'spinner' }), el('span', { text: 'Đang tìm…' })));
      open();
      return;
    }
    if (state === 'error') {
      // Phân biệt rõ với "không tìm thấy": lỗi mạng mà báo là không có tên thì
      // học viên tưởng mình không có trong danh sách lớp.
      list.append(el('li', { class: 'msg err', 'aria-disabled': 'true',
        text: 'Không tải được danh sách. Kiểm tra Wi-Fi rồi gõ lại.' }));
      status.textContent = 'Không tải được danh sách';
      open();
      return;
    }
    if (state === 'empty') {
      list.append(el('li', { class: 'msg', 'aria-disabled': 'true' },
        el('div', { text: `Không tìm thấy "${input.value.trim()}".` }),
        el('div', { class: 'small muted', text: 'Thử gõ tên riêng (ví dụ "Vy" thay vì "Trần Tường Vy"), hoặc gõ không dấu.' }),
      ));
      status.textContent = 'Không có kết quả';
      open();
      return;
    }
    if (!items.length) {
      close();
      return;
    }

    items.forEach((s, i) => {
      list.append(el('li', {
        role: 'option',
        id: `${uid}-opt-${i}`,
        'aria-selected': 'false',
        dataset: { id: String(s.id) },
        onmousedown: (e) => {
          e.preventDefault();
          // Chọn theo id đọc từ chính element, không theo index: nếu danh sách
          // vừa được vẽ lại giữa lúc ngón tay chạm thì index đã trỏ sang người khác.
          chooseById(e.currentTarget.dataset.id);
        },
      },
        el('span', { text: s.name }),
        s.note
          ? el('span', { class: 'note', text: s.note })
          : (s.duplicate ? el('span', { class: 'note', text: 'trùng tên' }) : null),
      ));
    });
    status.textContent = `${items.length} kết quả`;
    open();
    // KHÔNG tự sáng dòng nào, kể cả khi chỉ có 1 kết quả: Enter khi đang gõ dở sẽ
    // nộp dưới tên người mà học viên chưa từng nhìn thấy.
    setActive(-1);
  };

  function chooseById(id) {
    const s = items.find((x) => String(x.id) === String(id));
    if (!s) return;
    picked = s;
    input.value = s.name + (s.note ? ` (${s.note})` : '');
    items = [];
    state = 'idle';
    close();
    onPick?.(s);
  }

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < minChars) {
      items = [];
      state = 'idle';
      render();
      return;
    }
    const my = ++seq;
    state = 'loading';
    render();
    try {
      const found = await search(q);
      if (my !== seq) return; // đã có truy vấn mới hơn
      items = found;
      state = found.length ? 'results' : 'empty';
    } catch {
      if (my !== seq) return;
      items = [];
      state = 'error';
    }
    render();
  });

  input.addEventListener('input', () => {
    if (picked) {
      picked = null;
      onPick?.(null);
    }
    // Xoá kết quả cũ NGAY, trước khi debounce chạy: Enter trong 180ms chờ đó sẽ
    // không chọn được gì thay vì chọn kết quả của chữ đã gõ trước.
    items = [];
    seq++;
    close();
    run();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden || !items.length) return run();
      if (e.key === 'ArrowDown') setActive(active + 1 >= items.length ? 0 : active + 1);
      else setActive(active <= 0 ? items.length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      if (!list.hidden && active >= 0 && items[active]) {
        e.preventDefault();
        chooseById(items[active].id);
      }
    } else if (e.key === 'Escape') {
      close();
    }
  });

  input.addEventListener('blur', () => setTimeout(close, 150));
  if (placeholderNote) input.placeholder = placeholderNote;

  return {
    get picked() {
      return picked;
    },
    reset() {
      picked = null;
      input.value = '';
      items = [];
      state = 'idle';
      close();
    },
    setPicked(s) {
      picked = s;
      input.value = s ? s.name + (s.note ? ` (${s.note})` : '') : '';
      close();
    },
    destroy() {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('resize', reposition);
      list.remove();
    },
  };
}

/** Thanh điều hướng dùng chung cho các trang admin. */
export function renderTopbar(current) {
  const links = [
    ['/admin.html', 'Bài tập'],
    ['/students.html', 'Danh sách lớp'],
  ];
  const bar = el(
    'header',
    { class: 'topbar' },
    // Chữ dài chỉ hiện trên màn hình rộng: ở 375px cả brand + nav + đăng xuất
    // không đủ chỗ và thanh bị gãy thành 3 hàng.
    el('a', { class: 'brand', href: '/admin.html' },
      el('span', { text: 'Bài tập' }),
      el('span', { class: 'hide-sm', text: ' ảnh chứng minh' }),
    ),
    el(
      'nav',
      {},
      links.map(([href, label]) =>
        el('a', { href, text: label, 'aria-current': href === current ? 'page' : null }),
      ),
    ),
    el('button', {
      class: 'ghost small',
      text: 'Đăng xuất',
      onclick: (e) =>
        withBusy(e.currentTarget, 'Đang thoát…', async () => {
          await api('POST', '/api/admin/logout');
          location.href = '/login.html';
        }),
    }),
  );

  // Chèn vào chỗ đã chừa sẵn nếu trang có, để nội dung không bị nhảy xuống sau
  // khi JS chạy.
  const slot = $('#topbar-slot');
  if (slot) slot.replaceWith(bar);
  else document.body.prepend(bar);
}

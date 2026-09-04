/**
 * Hộp thoại "Tải ảnh về (ZIP)".
 *
 * Không dùng một link tải trực tiếp vì giáo viên thường chỉ cần một phần: ảnh đã
 * đạt để lưu, hoặc ảnh chờ duyệt để chấm offline. Hộp thoại cho chọn trước, và
 * hiện luôn số ảnh + dung lượng để không ai bấm tải rồi ngồi đợi 500MB.
 */
import { api, el, $, clear, formatBytes, toast } from '/js/app.js';

const STATUS_TEXT = {
  '': 'Tất cả bài đã nộp',
  pending: 'Chỉ bài chờ duyệt',
  approved: 'Chỉ bài đã đạt',
  rejected: 'Chỉ bài cần nộp lại',
};

export async function openZipDialog(assignmentId, assignmentTitle) {
  let info;
  try {
    info = await api('GET', `/api/admin/assignments/${assignmentId}/export-info`);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }

  if (!info.total) {
    toast('Bài tập này chưa có ảnh nào được nộp.', 'info');
    return;
  }

  let status = '';
  let latestOnly = false;

  const summary = el('p', { class: 'small muted', style: 'margin:0' });
  const dlBtn = el('a', { class: 'btn primary', href: '#', download: '' });

  /** Số ảnh và dung lượng ứng với lựa chọn hiện tại. */
  const update = () => {
    const s = status ? info.byStatus[status] : null;
    const count = status
      ? latestOnly
        ? (s?.latestCount ?? 0)
        : (s?.count ?? 0)
      : latestOnly
        ? info.latestTotal
        : info.total;
    // Dung lượng theo trạng thái chỉ có số tổng (không tách theo lần nộp), nên
    // khi lọc thì ước lượng theo tỉ lệ số ảnh — đủ để biết là 2MB hay 500MB.
    const bytes = status
      ? Math.round((s?.bytes ?? 0) * (s?.count ? count / s.count : 0))
      : latestOnly
        ? info.latestBytes
        : info.totalBytes;

    summary.textContent = count
      ? `Sẽ tải ${count} ảnh, khoảng ${formatBytes(bytes)}.`
      : 'Không có ảnh nào khớp lựa chọn này.';

    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (latestOnly) params.set('latest', '1');
    const qs = params.toString();
    dlBtn.href = `/api/admin/assignments/${assignmentId}/export.zip${qs ? '?' + qs : ''}`;
    dlBtn.textContent = count ? `Tải ${count} ảnh` : 'Không có ảnh';
    dlBtn.classList.toggle('disabled', count === 0);
  };

  const radios = el('div', { class: 'stack', style: 'gap:6px' });
  for (const value of ['', 'pending', 'approved', 'rejected']) {
    const n = value ? (info.byStatus[value]?.count ?? 0) : info.total;
    if (value && !n) continue; // không có bài ở trạng thái này thì đừng bày ra
    const radio = el('input', {
      type: 'radio',
      name: 'zip-status',
      value,
      checked: value === '',
      style: 'width:auto;margin:0',
      onchange: () => {
        status = value;
        update();
      },
    });
    radios.append(el('label', { class: 'row tight', style: 'font-weight:500;margin:0' },
      radio,
      el('span', {}, STATUS_TEXT[value], el('span', { class: 'muted small', text: ` (${n} ảnh)` })),
    ));
  }

  const latestBox = el('input', {
    type: 'checkbox',
    style: 'width:auto;margin:0',
    onchange: (e) => {
      latestOnly = e.currentTarget.checked;
      update();
    },
  });

  const hasOldAttempts = info.total > info.latestTotal;

  const dlg = el('dialog', { class: 'modal' },
    el('div', { class: 'card stack modal-body' },
      el('h2', { text: 'Tải ảnh về' }),
      el('p', { class: 'small muted', style: 'margin:0' },
        `Tên file trong ZIP là tên học viên, nên mở ra là biết ngay ảnh của ai.`),
      radios,
      hasOldAttempts
        ? el('label', { class: 'row tight', style: 'font-weight:500;margin:0' },
            latestBox,
            el('span', {}, 'Chỉ lấy ảnh của lần nộp mới nhất',
              el('span', { class: 'muted small', text: ` (bỏ ${info.total - info.latestTotal} ảnh của các lần nộp trước)` })),
          )
        : null,
      summary,
      el('div', { class: 'row', style: 'justify-content:flex-end' },
        el('button', { class: 'ghost', text: 'Đóng', onclick: () => close() }),
        dlBtn,
      ),
    ),
  );

  const close = () => {
    dlg.close();
    dlg.remove();
  };

  dlBtn.addEventListener('click', (e) => {
    if (dlBtn.classList.contains('disabled')) {
      e.preventDefault();
      return;
    }
    // Trình duyệt tải file qua thẻ <a download>; đóng hộp thoại sau một nhịp để
    // không hủy request đang bắt đầu.
    setTimeout(close, 400);
  });

  dlg.addEventListener('cancel', close);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });

  update();
  document.body.append(dlg);
  dlg.showModal();
  void assignmentTitle;
}

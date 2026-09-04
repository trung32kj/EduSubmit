import { api, $, setAlert, safeNextUrl } from '/js/app.js';

// PHẢI lọc: gán location.href = "javascript:..." từ script cùng nguồn sẽ THỰC THI
// mã đó với quyền admin. Chỉ nhận đường dẫn nội bộ dạng "/abc".
const nextUrl = safeNextUrl(new URLSearchParams(location.search).get('next'));

// Đã đăng nhập rồi thì vào thẳng.
api('GET', '/api/admin/me').then(() => { location.href = nextUrl; }).catch(() => {});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#submit');
  setAlert($('#alert'), '');
  btn.disabled = true;
  btn.textContent = 'Đang kiểm tra…';
  try {
    await api('POST', '/api/admin/login', {
      username: $('#username').value,
      password: $('#password').value,
    });
    location.href = nextUrl;
  } catch (err) {
    setAlert($('#alert'), err.message);
    $('#password').value = '';
    $('#password').focus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Đăng nhập';
  }
});

/**
 * Các lớp bảo vệ ở tầng HTTP: security headers và chống CSRF.
 */

/**
 * Header bảo mật.
 *
 * CSP không dùng nonce được vì HTML do express.static/sendFile phục vụ, không
 * qua bước render nào để chèn nonce. Vì vậy toàn bộ script đã được tách ra file
 * riêng trong /js/ và CSP chỉ cho phép script-src 'self'.
 *
 * style-src còn 'unsafe-inline' vì nhiều chỗ còn dùng thuộc tính style="..." —
 * việc dọn nốt chỗ đó không đổi mức bảo mật thật (style không thực thi mã).
 */
export function securityHeaders(req, res, next) {
  // Đây là lớp chặn thứ hai cho lỗ hổng kiểu location.href = "javascript:...".
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // blob: cho ảnh xem trước trước khi upload.
      "img-src 'self' blob: data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      // Trang admin có nút xoá không hoàn lại -> không cho nhúng vào iframe.
      "frame-ancestors 'none'",
    ].join('; '),
  );
  // Ảnh do người dùng tải lên: không cho trình duyệt tự đoán lại kiểu file.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Link /s/<slug> chính là thứ để nộp bài -> không để nó lọt vào Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

/**
 * Chống CSRF bằng Sec-Fetch-Site / Origin.
 *
 * SameSite=Lax đã chặn được request từ site khác, NHƯNG "site" bỏ qua số cổng:
 * http://localhost:8080 là cùng site với http://localhost:3000. Một server khác
 * trên cùng máy (hoặc trên cùng IP) vẫn gửi được cookie kèm form POST.
 *
 * Sec-Fetch-Site có phân biệt cổng nên bịt đúng khe đó. Trình duyệt cũ không gửi
 * header này thì lùi về so Origin.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const site = req.get('sec-fetch-site');
  if (site) {
    // 'none' = người dùng tự gõ địa chỉ / mở bookmark, không có form POST nào như vậy.
    if (site === 'same-origin') return next();
    return res.status(403).json({ error: 'Yêu cầu bị chặn vì đến từ trang khác.' });
  }

  const origin = req.get('origin');
  if (origin) {
    // Sau tunnel/proxy, req.protocol và req.get('host') phải khớp với địa chỉ
    // người dùng thấy. Nếu có BASE_URL thì đó là nguồn đáng tin duy nhất — proxy
    // có thể chuyển tiếp bằng http nội bộ dù ngoài là https.
    const allowed = new Set([`${req.protocol}://${req.get('host')}`]);
    if (process.env.BASE_URL) allowed.add(process.env.BASE_URL.replace(/\/+$/, ''));
    if (allowed.has(origin)) return next();
    return res.status(403).json({ error: 'Yêu cầu bị chặn vì đến từ trang khác.' });
  }

  // Không có cả hai header: trình duyệt rất cũ, hoặc curl. Cho qua vì chặn ở đây
  // sẽ làm hỏng việc dùng thật, và mọi request kiểu đó cũng không mang cookie
  // của trang khác.
  next();
}

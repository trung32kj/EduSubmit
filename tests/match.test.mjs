import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameFromFilename, matchFilenames, findAmbiguousNames, AUTO_SCORE } from '../src/match.js';
import { normalize, squash } from '../src/norm.js';

const mk = (id, name, note = '') => ({
  id,
  name,
  note,
  name_normalized: normalize(name),
  name_squashed: squash(name),
});

const roster = [
  mk(1, 'Nguyễn Văn A'),
  mk(2, 'Đỗ Đình Đạt'),
  mk(3, 'Trần Tường Vy'),
  mk(4, 'Lê Thị Bình'),
  mk(5, 'Phạm Hoàng Nam'),
];

const rosterWithDup = [...roster, mk(6, 'Nguyễn Văn A', 'STT 2')];

const matchOne = (filename, students = roster) => matchFilenames([filename], students)[0];
const pick = (r, students = roster) =>
  r.studentId ? students.find((s) => s.id === r.studentId).name : null;

test('bỏ dấu TRƯỚC khi cắt tiền tố, không thì mất chữ Đ', () => {
  // \W = [^A-Za-z0-9_] nên nó ăn luôn chữ Việt: cắt trước sẽ ra "nh dat"
  // và mọi bạn tên Đặng/Đỗ/Đinh/Đoàn đều đoán sai.
  assert.equal(nameFromFilename('Đỗ Đình Đạt.HEIC'), 'do dinh dat');
  assert.equal(nameFromFilename('Đặng Đức Đông.jpg'), 'dang duc dong');
  assert.equal(nameFromFilename('8 Nguyễn Văn A.jpg'), 'nguyen van a');
});

test('bỏ rác mà điện thoại và app chat tự thêm', () => {
  assert.equal(nameFromFilename('01. Le Thi Binh.png'), 'le thi binh');
  assert.equal(nameFromFilename('pham-hoang-nam.webp'), 'pham hoang nam');
  assert.equal(nameFromFilename('zalo_2026-08-31_bai tap 3 - Tuong Vy.jpg'), 'tuong vy');
  assert.equal(nameFromFilename('do dinh dat (1).jpg'), 'do dinh dat');
  assert.equal(nameFromFilename('[copy] Le Thi Binh.png'), 'le thi binh');
});

test('ảnh máy chụp không có tên người thì không đoán ra gì', () => {
  assert.equal(nameFromFilename('IMG_20260831_120301.jpg'), '');
  assert.equal(nameFromFilename('Screenshot 2026-08-31 at 12.03.01.png'), '');
  assert.equal(nameFromFilename('DSC00123.JPG'), '');
});

test('khớp chính xác thì tự chọn', () => {
  const r = matchOne('Đỗ Đình Đạt.HEIC');
  assert.equal(pick(r), 'Đỗ Đình Đạt');
  assert.equal(r.confidence, 1);
});

test('tên liền không dấu vẫn khớp qua squash', () => {
  const r = matchOne('nguyenvana.jpg');
  assert.equal(pick(r), 'Nguyễn Văn A');
  assert.ok(r.confidence >= AUTO_SCORE);
});

test('tên file có rác quanh tên người vẫn khớp', () => {
  assert.equal(pick(matchOne('zalo_2026-08-31_bai tap 3 - Tuong Vy.jpg')), 'Trần Tường Vy');
  assert.equal(pick(matchOne('01. Le Thi Binh.png')), 'Lê Thị Bình');
  assert.equal(pick(matchOne('pham-hoang-nam.webp')), 'Phạm Hoàng Nam');
});

test('ảnh không có tên người thì để TRỐNG, không đoán bừa', () => {
  for (const f of ['IMG_20260831_120301.jpg', 'Screenshot 2026-08-31 at 12.03.01.png', 'DSC00123.JPG']) {
    const r = matchOne(f);
    assert.equal(r.studentId, null, f);
    assert.equal(r.confidence, 0, f);
  }
});

test('một token trùng (chỉ tên riêng) không đủ để tự chọn', () => {
  const r = matchOne('Nam.jpg');
  assert.equal(r.studentId, null);
  assert.ok(r.candidates.length > 0, 'vẫn phải gợi ý để admin chọn nhanh');
  assert.equal(r.candidates[0].name, 'Phạm Hoàng Nam');
});

test('họ phổ biến trùng nhau không kéo điểm lên', () => {
  // Cả lớp họ Nguyễn nên riêng "nguyen" gần như vô nghĩa.
  const r = matchOne('nguyen.jpg');
  assert.equal(r.studentId, null);
});

test('2 bạn trùng tên: KHÔNG tự chọn dù điểm 1.0', () => {
  const r = matchOne('Nguyễn Văn A.jpg', rosterWithDup);
  assert.equal(r.confidence, 1);
  assert.equal(r.studentId, null, 'phải để admin tự chọn');
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2, 'trả cả hai để admin phân biệt bằng ghi chú');
});

test('findAmbiguousNames tìm ra tên bị trùng', () => {
  assert.deepEqual([...findAmbiguousNames(roster)], []);
  assert.deepEqual([...findAmbiguousNames(rosterWithDup)], ['nguyen van a']);
});

test('trả tối đa 3 gợi ý, xếp theo điểm giảm dần', () => {
  const many = [mk(1, 'Nguyễn Văn An'), mk(2, 'Nguyễn Văn Anh'), mk(3, 'Nguyễn Văn Ánh'), mk(4, 'Nguyễn Văn Ân')];
  const r = matchFilenames(['nguyen van anh.jpg'], many)[0];
  assert.ok(r.candidates.length <= 3);
  for (let i = 1; i < r.candidates.length; i++) {
    assert.ok(r.candidates[i - 1].score >= r.candidates[i].score);
  }
});

test('danh sách rỗng hoặc tên file lạ không làm vỡ', () => {
  assert.deepEqual(matchFilenames(['a.jpg'], []), [
    { filename: 'a.jpg', guess: 'a', candidates: [], studentId: null, confidence: 0, ambiguous: false },
  ]);
  assert.equal(matchFilenames([''], roster)[0].studentId, null);
  assert.equal(matchFilenames(['.jpg'], roster)[0].studentId, null);
  // Một chữ cái trùng tên riêng của "Nguyễn Văn A" cũng không đủ để tự chọn.
  assert.equal(matchOne('a.jpg').studentId, null);
});

test('nhiều ảnh của cùng 1 bạn đều khớp về bạn đó', () => {
  const rs = matchFilenames(['Đỗ Đình Đạt.jpg', 'do dinh dat (1).jpg', 'dodinhdat2.png'], roster);
  for (const r of rs) assert.equal(pick(r), 'Đỗ Đình Đạt', r.filename);
});

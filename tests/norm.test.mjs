import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, squash, displayName, lastToken, parseRoster, escapeLike, safeFileName } from '../src/norm.js';

test('bỏ dấu tiếng Việt', () => {
  assert.equal(normalize('Nguyễn Văn A'), 'nguyen van a');
  assert.equal(normalize('Trần Tường Vy'), 'tran tuong vy');
  assert.equal(normalize('Lê Thị Bích Ngọc'), 'le thi bich ngoc');
});

test('đ/Đ không phân rã dưới NFD nên phải replace tay', () => {
  // Nếu chỉ NFD + bỏ dấu tổ hợp thì ra "đo đinh đat" và học viên gõ
  // "do dinh dat" sẽ không tìm thấy chính mình.
  assert.equal(normalize('Đỗ Đình Đạt'), 'do dinh dat');
  assert.equal(normalize('Đường Thị Hương'), 'duong thi huong');
  assert.equal(normalize('Đặng Đức Đông'), 'dang duc dong');
  assert.ok(!normalize('Đỗ Đình Đạt').includes('đ'));
});

test('ký tự vô hình từ Zalo/Excel bị loại', () => {
  // U+200B không khớp \s nên phải strip riêng; ﻿ là BOM của file CSV.
  assert.equal(normalize('﻿Nguyễn​ Văn A'), 'nguyen van a');
  assert.equal(normalize('Lê Văn Bình'), 'le van binh'); // NBSP
  assert.equal(normalize('A‍⁠B'), 'ab');
});

test('gộp khoảng trắng và cắt hai đầu', () => {
  assert.equal(normalize('  Trần   Tường  Vy '), 'tran tuong vy');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(123), '');
});

test('squash bỏ hết khoảng trắng', () => {
  assert.equal(squash('Nguyễn Văn A'), 'nguyenvana');
  assert.equal(squash('Đỗ Đình Đạt'), 'dodinhdat');
});

test('displayName đưa về NFC để không có 2 dòng trông giống nhau', () => {
  const composed = 'Nguyễn'.normalize('NFC');
  const decomposed = 'Nguyễn'.normalize('NFD');
  assert.notEqual(composed, decomposed);
  assert.equal(displayName(decomposed), composed);
  assert.equal(displayName('  Lê   Thị  B '), 'Lê Thị B');
});

test('lastToken lấy tên riêng', () => {
  assert.equal(lastToken('Trần Tường Vy'), 'vy');
  assert.equal(lastToken('Đỗ Đình Đạt'), 'dat');
  assert.equal(lastToken(''), '');
});

test('escapeLike chặn wildcard', () => {
  // Không escape thì học viên gõ '%' sẽ lấy được cả danh sách lớp.
  assert.equal(escapeLike('50%_a'), '50\\%\\_a');
  assert.equal(escapeLike('a\\b'), 'a\\\\b');
});

test('safeFileName bỏ ký tự cấm và tên cấm của Windows', () => {
  assert.equal(safeFileName('Đỗ Đình Đạt'), 'Đỗ Đình Đạt');
  assert.equal(safeFileName('a/b:c*d?e'), 'abcde');
  assert.equal(safeFileName('CON'), 'CON_');
  assert.equal(safeFileName('com1'), 'com1_');
  assert.equal(safeFileName('ten.'), 'ten');
  assert.equal(safeFileName('   '), 'khong-ten');
});

test('parseRoster: BOM, CRLF, dòng trống, tiêu đề', () => {
  const rows = parseRoster('﻿Họ và tên,Ghi chú\r\nNguyễn Văn A,STT 1\r\nĐỗ Đình Đạt\r\n\r\n');
  assert.deepEqual(rows, [
    { name: 'Nguyễn Văn A', note: 'STT 1' },
    { name: 'Đỗ Đình Đạt', note: '' },
  ]);
});

test('parseRoster: cho phép 2 bạn trùng tên, phân biệt bằng ghi chú', () => {
  const rows = parseRoster('Nguyễn Văn A,STT 1\nNguyễn Văn A,STT 2');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, 'STT 1');
  assert.equal(rows[1].note, 'STT 2');
});

test('parseRoster: dán từ Excel (tab) và CSV có dấu ngoặc kép', () => {
  assert.deepEqual(parseRoster('Lê Thị B\tlop 9A'), [{ name: 'Lê Thị B', note: 'lop 9A' }]);
  assert.deepEqual(parseRoster('"Nguyễn, Văn D","ghi ""chu"""'), [
    { name: 'Nguyễn, Văn D', note: 'ghi "chu"' },
  ]);
});

test('parseRoster: chỉ tên, mỗi dòng một tên', () => {
  const rows = parseRoster('Nguyễn Văn A\nĐỗ Đình Đạt\nTrần Tường Vy');
  assert.deepEqual(rows.map((r) => r.name), ['Nguyễn Văn A', 'Đỗ Đình Đạt', 'Trần Tường Vy']);
  assert.deepEqual(parseRoster(''), []);
  assert.deepEqual(parseRoster(null), []);
});

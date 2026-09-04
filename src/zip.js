/**
 * Ghi file ZIP kiểu "store" (không nén) bằng tay.
 *
 * Node không có sẵn thư viện ZIP, nhưng JPEG/PNG vốn đã nén rồi nên nén thêm
 * không lợi gì -> viết store-only để không phải thêm dependency.
 * Giới hạn: định dạng ZIP cổ điển, tổng dung lượng < 4GB (thừa sức cho một lớp).
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PassThrough } from 'node:stream';

const textEncoder = new TextEncoder();

/** Đổi thời gian sang định dạng DOS mà ZIP dùng. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Stream một ZIP store-only chứa các entry cho trước.
 *
 * entries: [{ name, path }] — name là tên trong ZIP, path là file trên đĩa.
 * File không đọc được sẽ bị bỏ qua (ảnh có thể đã bị xoá tay).
 */
export function createZipStream(entries) {
  const out = new PassThrough();

  (async () => {
    const central = [];
    let offset = 0;
    const write = (buf) =>
      new Promise((resolve, reject) => {
        if (out.write(buf)) return resolve();
        out.once('drain', resolve);
        out.once('error', reject);
      });

    try {
      const used = new Set();

      for (const entry of entries) {
        let stat;
        try {
          stat = fs.statSync(entry.path);
        } catch {
          continue; // file đã bị xoá tay, bỏ qua
        }

        // Tên trùng trong ZIP làm một số phần mềm giải nén báo lỗi.
        let name = entry.name;
        if (used.has(name)) {
          const dot = name.lastIndexOf('.');
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : '';
          let i = 2;
          while (used.has(`${stem} (${i})${ext}`)) i++;
          name = `${stem} (${i})${ext}`;
        }
        used.add(name);

        const nameBytes = textEncoder.encode(name);
        const data = fs.readFileSync(entry.path);
        const crc = zlib.crc32(data);
        const { time, date } = dosDateTime(stat.mtime);
        // bit 3 = 0 (biết trước kích thước), bit 11 = 1 (tên file là UTF-8,
        // cần thiết vì tên học viên có dấu tiếng Việt).
        const flags = 0x0800;

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(0, 8); // method 0 = store
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28); // extra length

        await write(local);
        await write(nameBytes);
        await write(data);

        central.push({ name: nameBytes, crc, size: data.length, time, date, offset, flags });
        offset += 30 + nameBytes.length + data.length;
      }

      const centralStart = offset;
      let centralSize = 0;
      for (const e of central) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4); // version made by
        header.writeUInt16LE(20, 6); // version needed
        header.writeUInt16LE(e.flags, 8);
        header.writeUInt16LE(0, 10); // store
        header.writeUInt16LE(e.time, 12);
        header.writeUInt16LE(e.date, 14);
        header.writeUInt32LE(e.crc, 16);
        header.writeUInt32LE(e.size, 20);
        header.writeUInt32LE(e.size, 24);
        header.writeUInt16LE(e.name.length, 28);
        header.writeUInt16LE(0, 30); // extra
        header.writeUInt16LE(0, 32); // comment
        header.writeUInt16LE(0, 34); // disk number
        header.writeUInt16LE(0, 36); // internal attrs
        header.writeUInt32LE(0, 38); // external attrs
        header.writeUInt32LE(e.offset, 42);
        await write(header);
        await write(e.name);
        centralSize += 46 + e.name.length;
      }

      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(0, 4);
      end.writeUInt16LE(0, 6);
      end.writeUInt16LE(central.length, 8);
      end.writeUInt16LE(central.length, 10);
      end.writeUInt32LE(centralSize, 12);
      end.writeUInt32LE(centralStart, 16);
      end.writeUInt16LE(0, 20);
      await write(end);

      out.end();
    } catch (err) {
      out.destroy(err);
    }
  })();

  return out;
}

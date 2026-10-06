/**
 * Файлы, которые менеджер отправляет клиенту из CRM: гарантия, договор,
 * памятка о переезде. Чтобы не искать один и тот же PDF каждый раз,
 * постоянные файлы лежат в библиотеке и отправляются одним нажатием.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.js';
import { mediaPath } from './media.js';

db.exec(`CREATE TABLE IF NOT EXISTS docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  file       TEXT NOT NULL,
  mime       TEXT,
  size       INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

export const MAX_MB = 60;      // WhatsApp принимает документы до 100 МБ, но сервер у нас маленький

/** Тип для WhatsApp: фото и видео уходят как медиа, остальное — документом с именем. */
export const kindOf = (mime) => (/^image\//.test(mime) ? 'image' : /^video\//.test(mime) ? 'video' : 'document');

export function saveUpload(buf, mime, name) {
  if (!buf?.length) throw new Error('Пустой файл');
  if (buf.length > MAX_MB * 1048576) throw new Error(`Файл больше ${MAX_MB} МБ`);
  const clean = path.basename(String(name || 'файл')).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').trim().slice(0, 120) || 'файл';
  const ext = (path.extname(clean).slice(1) || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const type = String(mime || 'application/octet-stream').split(';')[0].trim();
  const file = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(mediaPath(file), buf);
  return { file, mime: type, kind: kindOf(type), name: clean, size: buf.length };
}

export const listDocs = () => db.prepare('SELECT * FROM docs ORDER BY name').all();

export function addDoc(item) {
  const r = db.prepare('INSERT INTO docs(name, file, mime, size) VALUES(?,?,?,?)').run(item.name, item.file, item.mime, item.size);
  return db.prepare('SELECT * FROM docs WHERE id=?').get(Number(r.lastInsertRowid));
}

export function deleteDoc(id) {
  const d = db.prepare('SELECT * FROM docs WHERE id=?').get(id);
  if (!d) return;
  db.prepare('DELETE FROM docs WHERE id=?').run(id);
  // файл не трогаем, если его уже отправляли клиентам: он нужен для истории переписки
  const used = db.prepare("SELECT 1 FROM messages WHERE media LIKE ? LIMIT 1").get(`%${d.file}%`);
  if (!used) fs.rm(mediaPath(d.file), { force: true }, () => {});
}

/** Файл из библиотеки — как вложение для отправки. */
export function docItem(id) {
  const d = db.prepare('SELECT * FROM docs WHERE id=?').get(id);
  if (!d) throw new Error('Файла нет в библиотеке');
  return { file: d.file, mime: d.mime, kind: kindOf(d.mime), name: d.name, size: d.size };
}

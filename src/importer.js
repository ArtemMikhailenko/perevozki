/**
 * Импорт старых клиентов из WhatsApp (выгрузка в Excel → файл импорта).
 * Клиенты ложатся сразу в архив: «Переехали с нами» или «Отказ», с датой,
 * когда бот вернётся к ним (последнее сообщение + N месяцев). Кто уже есть в
 * CRM — не трогаем: живая заявка важнее старой выгрузки.
 */
import { db, getSetting, setSetting, addMessage } from './db.js';

const BUCKETS = { done: 'Переехали с нами', refused: 'Отказ' };
const digits = (v) => String(v || '').replace(/\D/g, '');
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function addMonths(day, n) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

export function importContacts(payload, { apply = false } = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const staff = Array.isArray(payload?.staff) ? payload.staff.map(digits).filter((p) => p.length >= 9) : [];
  const months = Math.max(1, Number(getSetting('revive_months')) || 10);
  const today = new Date().toISOString().slice(0, 10);
  const exists = new Set(db.prepare('SELECT phone FROM conversations').all().map((r) => digits(r.phone)));
  const report = { done: 0, refused: 0, skipped_existing: 0, skipped_bad: 0, due_now: 0, staff_added: 0, first_due: null, last_due: null };
  const seen = new Set();

  const ins = db.prepare(`INSERT INTO conversations(channel, phone, name, chat_id, status, ai_enabled, lead, summary,
      created_at, last_at, archive, followup_at, followup_who, followup_note, lang, imported)
    VALUES(?,?,?,?,'closed',1,'{}',?,?,?,?,?,'revive',?,?,?)`);
  const run = () => {
    for (const it of items) {
      const phone = digits(it.phone);
      const bucket = BUCKETS[it.bucket] ? it.bucket : null;
      if (phone.length < 9 || !bucket || seen.has(phone)) { report.skipped_bad++; continue; }
      seen.add(phone);
      if (exists.has(phone)) { report.skipped_existing++; continue; }
      const last = isDay(it.last) ? it.last : today;
      const first = isDay(it.first) ? it.first : last;
      let due = addMonths(last, months);
      if (due <= today) { due = today; report.due_now++; }
      report[bucket]++;
      report.first_due = !report.first_due || due < report.first_due ? due : report.first_due;
      report.last_due = !report.last_due || due > report.last_due ? due : report.last_due;
      if (!apply) continue;
      const note = bucket === 'done' ? 'переезжали с нами — спросить, не нужен ли новый переезд'
        : 'обращались, но не переехали — спросить, актуален ли переезд';
      const r = ins.run('baileys', phone, it.name || null, `${phone}@s.whatsapp.net`, it.summary || null,
        first + ' 09:00:00', last + ' 09:00:00', bucket, due, note, ['he', 'ru', 'en', 'uk'].includes(it.lang) ? it.lang : null,
        String(it.source || 'импорт WhatsApp').slice(0, 120));
      addMessage(Number(r.lastInsertRowid), { direction: 'out', author: 'system',
        body: `Импорт из WhatsApp: ${it.source || ''}${it.summary ? ' · ' + String(it.summary).slice(0, 200) : ''}. Бот напишет ${due}` });
      // служебная пометка не должна делать старого клиента «свежим» в списке
      db.prepare('UPDATE conversations SET last_at=? WHERE id=?').run(last + ' 09:00:00', Number(r.lastInsertRowid));
    }
    // работники и поставщики — в «Сотрудники»: бот им не отвечает
    const cur = String(getSetting('staff_numbers') || '');
    const have = new Set(cur.split(/[,;\n]+/).map(digits).filter(Boolean));
    const add = staff.filter((p) => !have.has(p));
    report.staff_added = add.length;
    if (apply && add.length) setSetting('staff_numbers', [cur.trim(), ...add.map((p) => '+' + p)].filter(Boolean).join('\n'));
  };
  if (apply) {
    db.exec('BEGIN');
    try { run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  } else run();
  report.daily_max = Math.max(1, Number(getSetting('revive_daily_max')) || 15);
  return report;
}

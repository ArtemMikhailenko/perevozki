import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.join(process.cwd(), 'data');
fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(path.join(dir, 'app.db'));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS conversations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  channel        TEXT NOT NULL DEFAULT 'mock',
  phone          TEXT NOT NULL,
  name           TEXT,
  status         TEXT NOT NULL DEFAULT 'new',      -- new | ai | human | closed
  ai_enabled     INTEGER NOT NULL DEFAULT 1,
  needs_human    INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT,
  unread         INTEGER NOT NULL DEFAULT 0,
  lead           TEXT NOT NULL DEFAULT '{}',       -- JSON: карточка заявки
  summary        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel, phone)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL,                        -- in | out
  author     TEXT NOT NULL,                        -- customer | ai | human | system
  body       TEXT NOT NULL,
  wa_id      TEXT,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_waid ON messages(wa_id);

-- Уборки, заведённые руками: клиент позвонил, пришёл по сарафану, постоянный
-- заказчик. Без этого в расписание попадает только то, что прошло через бота.
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,                     -- ГГГГ-ММ-ДД
  time       TEXT,
  name       TEXT,
  phone      TEXT,
  service    TEXT,
  area       TEXT,
  district   TEXT,
  price      TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(date);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Миграции для баз, созданных более ранней версией схемы.
const cols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
if (!cols.includes('chat_id')) db.exec('ALTER TABLE conversations ADD COLUMN chat_id TEXT');

const mcols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
if (!mcols.includes('media')) db.exec('ALTER TABLE messages ADD COLUMN media TEXT');   // JSON: [{file, mime, kind}]
// чем было сообщение: обычный ответ, напоминание, подтверждение заказа — нужно для отчёта
if (!mcols.includes('kind')) db.exec('ALTER TABLE messages ADD COLUMN kind TEXT');
// статус доставки из WhatsApp: sent | delivered | read
if (!mcols.includes('status')) db.exec('ALTER TABLE messages ADD COLUMN status TEXT');
if (!cols.includes('note')) db.exec('ALTER TABLE conversations ADD COLUMN note TEXT');  // заметка менеджера
// когда менеджеру ушло уведомление о передаче — чтобы не слать его повторно
if (!cols.includes('notified_at')) db.exec('ALTER TABLE conversations ADD COLUMN notified_at TEXT');
// напоминания: когда написать («клиент просил после ремонта») и сколько дожимов уже ушло
if (!cols.includes('followup_at')) db.exec('ALTER TABLE conversations ADD COLUMN followup_at TEXT');
if (!cols.includes('followup_note')) db.exec('ALTER TABLE conversations ADD COLUMN followup_note TEXT');
// «перезвонить 15.10» — это задача человеку, а не повод боту написать клиенту
if (!cols.includes('followup_who')) db.exec('ALTER TABLE conversations ADD COLUMN followup_who TEXT');
if (!cols.includes('nudges')) db.exec('ALTER TABLE conversations ADD COLUMN nudges INTEGER NOT NULL DEFAULT 0');
// клиент попросил не писать — больше никаких напоминаний по своей инициативе
if (!cols.includes('nudge_stop')) db.exec('ALTER TABLE conversations ADD COLUMN nudge_stop INTEGER NOT NULL DEFAULT 0');
if (!cols.includes('last_nudge_at')) db.exec('ALTER TABLE conversations ADD COLUMN last_nudge_at TEXT');
if (!cols.includes('confirm_sent')) db.exec('ALTER TABLE conversations ADD COLUMN confirm_sent TEXT');   // eve | morning
if (!cols.includes('mgr_ping_at')) db.exec('ALTER TABLE conversations ADD COLUMN mgr_ping_at TEXT');
// Дата переезда. Пожелание клиента живёт в карточке (lead.date_iso), а здесь —
// запись, которую подтвердил человек: только она попадает в расписание.
if (!cols.includes('job_date')) db.exec('ALTER TABLE conversations ADD COLUMN job_date TEXT');
if (!cols.includes('job_time')) db.exec('ALTER TABLE conversations ADD COLUMN job_time TEXT');
// Откуда пришёл клиент: клик по рекламе приносит название объявления и ссылку
if (!cols.includes('source')) db.exec('ALTER TABLE conversations ADD COLUMN source TEXT');
if (!cols.includes('source_title')) db.exec('ALTER TABLE conversations ADD COLUMN source_title TEXT');
if (!cols.includes('source_url')) db.exec('ALTER TABLE conversations ADD COLUMN source_url TEXT');
if (!cols.includes('source_ref')) db.exec('ALTER TABLE conversations ADD COLUMN source_ref TEXT');
// весь ответ рекламной площадки целиком: по нему видно, что вообще прислала Meta
if (!cols.includes('source_raw')) db.exec('ALTER TABLE conversations ADD COLUMN source_raw TEXT');
// Архив делится на корзины: свои сотрудники, «не сейчас, но лид живой» и отказ.
// Одной кучей «закрыто» пользоваться нельзя — там вперемешку и коллеги, и клиенты.
if (!cols.includes('archive')) {
  db.exec('ALTER TABLE conversations ADD COLUMN archive TEXT');
  // что уже закрыто, кладём в «отказ»: разобрать по корзинам можно перетаскиванием
  db.exec("UPDATE conversations SET archive='refused' WHERE status='closed'");
}
// Деньги в трёх состояниях. Названная в переписке цена живёт в карточке
// (lead.price_quote) и точной не является; согласованную сумму и оплату проставляет человек —
// иначе в отчёте «средний чек» считается по цифрам, которые никто не подтверждал.
if (!cols.includes('deal_sum')) db.exec('ALTER TABLE conversations ADD COLUMN deal_sum INTEGER');
if (!cols.includes('paid_sum')) db.exec('ALTER TABLE conversations ADD COLUMN paid_sum INTEGER');
if (!cols.includes('paid_at')) db.exec('ALTER TABLE conversations ADD COLUMN paid_at TEXT');

const DEFAULT_PROMPT = `Ты — Майя, помощница компании по переездам. Переписываешься с клиентами в WhatsApp.
Клиенты приходят с рекламы, первое сообщение часто шаблонное: «Здравствуйте, нужен переезд».
Компания перевозит квартиры, дома и офисы: машина, грузчики, разборка и сборка мебели,
упаковка вещей — отдельной услугой, если её заказывают.

ТВОЯ ЗАДАЧА — собрать заявку целиком и передать менеджеру, который назовёт цену и день.
Ты не давишь и не торопишь. Переписка должна ощущаться как разговор с внимательным менеджером.

КАК ПИСАТЬ — это важнее всего остального:
- Коротко. Одно сообщение — одна мысль, обычно до 15 слов.
- Один вопрос за раз. Никогда не спрашивай два пункта в одном сообщении.
- 1–2 сообщения подряд, не больше.
- Живым языком, как человек в мессенджере. Без markdown, списков и нумерации. Смайлик — редко.
- Подстраивайся под клиента: пишет коротко — отвечай коротко, пишет на «ты» — можно на «ты».
- Не пересказывай слова клиента, не благодари за каждое сообщение,
  не начинай каждый ответ с «Отлично!» или «Поняла!».
- Не здоровайся второй раз и не представляйся: приветствие уже ушло автоматически.
- Никогда не спрашивай то, что уже известно. В одном сообщении клиент мог назвать
  сразу несколько фактов — учти их все и спрашивай только недостающее.

Запрещённые обороты (звучат как робот): «чтобы я могла точнее сориентировать», «объём работ»,
«в ближайшее время», «уточните, пожалуйста, следующее», «благодарим за обращение»,
«с радостью помогу», «я здесь, чтобы помочь».

Так НЕ надо:
«Отлично! Чтобы точнее оценить объём работ, пришлите, пожалуйста, список вещей. Есть ли лифт?»
Так надо:
«Пришлите список вещей, которые перевозим, или фото — так посчитаем точнее».

СЦЕНАРИЙ. Веди клиента по шагам — мягко, по одному вопросу, между делом:
1. Что перевозим. Попроси список вещей, которые едут, или фото:
   «Пришлите, пожалуйста, список вещей, которые перевозим, или фото — так посчитаем точнее».
   Не пиши «короткий список», «вкратце», «в двух словах»: менеджеру нужен полный список
   мебели и техники поштучно.
   ВЕЩИ — ТОЧНО, БЕЗ «ПРИМЕРНО». Спрашивая о вещах, не пиши «примерно», «приблизительно»,
   «בערך», «approximately»: на такой вопрос клиент и отвечает приблизительно, а менеджеру
   нужен точный список. Так НЕ надо: «מה בערך צריך להעביר?» Так надо: «מה צריך להעביר?»
   «Примерно» можно только про число коробок — шаг 2.
   Клиент сам заговорил о коробках («не знаю, сколько коробок») — ответь про коробки сразу,
   с ориентиром из шага 2, а про мебель спроси следующим сообщением. Не откладывай его
   вопрос фразами «к этому вернёмся», «сначала скажите». Не может сейчас — не настаивай, предложи прислать позже,
   а сама иди дальше по сценарию.
   МЕБЕЛЬ И ТЕХНИКА ОБЯЗАТЕЛЬНЫ. Число коробок и комнат («2,5 комнаты, 20 коробок») —
   это ещё не список: по нему не понять, нужна одна машина или две. Пока не знаешь,
   какая едет мебель и техника, спроси прямо, одним вопросом: «А из мебели и техники что
   перевозим? Кровати, диваны, шкафы, столы, холодильник, стиральная машина?» Клиент
   ответил — запиши в items поштучно и больше не переспрашивай. Спрашивай мягко, как
   продолжение разговора: без «но», «мне нужно знать», «а всё-таки» — и на иврите без
   «אבל», «אני צריכה לדעת», «בדיוק». Клиент ответил про другое — прими это и спроси про
   мебель ещё раз одной короткой фразой, не повторяя слово в слово.
   Так НЕ надо: «2.5 חדרים זה טוב לדעת, אבל אני צריכה לדעת אילו רהיטים בדיוק עוברים».
   Так надо: «ומה מהרהיטים עובר? מיטות, ספות, ארונות, מקרר, מכונת כביסה?»
2. Коробки: будут ли они и примерно сколько. Клиент не знает — подскажи ориентир,
   от которого легко оттолкнуться: «Обычно на квартиру уходит 20-30 коробок —
   у вас больше или меньше?» Расплывчатое «пара коробок или побольше» не помогает.
3. Упаковка: клиент пакует сам или нужна наша упаковка — это отдельная услуга.
   Просит посчитать оба варианта — так и запиши в packing «нужны обе цены», не выбирай за него.
   КОРОБОК НЕ БУДЕТ — про упаковку не спрашивай вообще, этот шаг пропусти:
   упаковывать нечего, и лишний вопрос только затягивает разговор.
4. Откуда и куда: достаточно городов. Улицу, дом, район и подъезд не спрашивай —
   адрес уточнит менеджер перед выездом, клиента это только задерживает. Сказал
   «в Нетании» — этого хватит, переходи к следующему вопросу.
   ПЕРЕЕЗД ВНУТРИ ГОРОДА: клиент говорит «внутри города», «בתוך העיר», «בתוך רחובות»,
   «в том же городе», «тут рядом» — значит откуда и куда это один и тот же город. Запиши
   его в оба поля (from_city и to_city) и больше не спрашивай «а куда». Это готовый
   пункт, а не недостающий. НЕ ПЕРЕСПРАШИВАЙ и не подтверждай вопросом: «то есть из
   Реховота в Реховот, верно?» — это тот же вопрос второй раз, у клиента кончается
   терпение. Так НЕ надо: «אז יוצא מרחובות ועובר לרחובות, נכון?» Так надо: принять
   ответ и сразу задать следующий вопрос по сценарию, например про лифты.
5. Лифты — на обоих адресах.
   ЕСТЬ лифт — про этаж не спрашивай вообще, этого вопроса больше нет.
   НЕТ лифта — спроси этаж. Клиент назвал одно число («второй») — это только один адрес,
   спроси про второй: «А на втором адресе какой этаж?»
   ПОДВАЛ («подвал», «מרתף», «basement») — про лифт на этом адресе не спрашивай:
   в подвал лифт не идёт, это минус первый этаж. Запиши этаж «подвал», лифт «нет»
   и переходи к следующему адресу или вопросу.
6. Когда планируется переезд — желаемый день.
7. Как обращаться к клиенту, если имя ещё неизвестно. Спроси естественно, ближе к концу.
Порядок гибкий: клиент сам заговорил о дате или сразу прислал фото — подстройся.
stage: «уточняем», пока собираешь; «ждём список» — когда попросила фото или список и их ещё нет;
«заявка готова» — когда передаёшь; «отказ» — если клиент передумал.

КОГДА ПРИСЛАЛИ ФОТО ИЛИ ВИДЕО ВЕЩЕЙ:
- одной короткой фразой покажи, что посмотрела: «Посмотрела — диван, шкаф и холодильник»;
- запиши в rooms, что видно: мебель, техника, крупногабаритное, коробки;
- не выдумывай того, чего нет; не разобрать — попроси переснять;
- переходи к следующему недостающему пункту.

НЕПОНЯТНОЕ СООБЩЕНИЕ. Клиент написал что-то странное или не по теме — не изображай
замешательство и не извиняйся. Ответь ОДНИМ коротким сообщением с одним уточняющим
вопросом, привязанным к переезду, — используй то, что из сообщения всё-таки понятно.
Не пиши «не поняла сообщение», «можете переформулировать», «я запуталась», «это про
переезд?» и не начинай разговор «с начала». Несколько таких фраз подряд звучат как сбой.
Так НЕ надо: «סליחה, לא הבנתי» + «אפשר לנסח שוב?» + «אני קצת מתבלבלת» + «זה קשור להובלה?»
Так надо (клиент: «יש לי טלפונים באילת… אני גר בלוד»): «הבנתי, אתם גרים בלוד. ההובלה מלוד — לאן עוברים?»
Если это точно не про переезд — одной фразой скажи, чем занимается компания, и спроси,
нужна ли перевозка.

ВОПРОСЫ КЛИЕНТА. Сначала коротко ответь по «условиям» ниже, потом мягко вернись
к сценарию следующим вопросом. Не знаешь ответа — не выдумывай: скажи, что уточнишь у коллеги,
и передай менеджеру.

ЦЕНА. Стоимость переезда считает менеджер: она зависит от вещей, этажей, лифтов и упаковки.
Сумму сама не называй и не оценивай даже «примерно», скидок не обещай. Спрашивают цену раньше —
объясни честно: «Цену посчитает менеджер, для этого и собираю детали. Осталось пара вопросов».

ДАТУ ТЫ НЕ ПОДТВЕРЖДАЕШЬ. Свободные машины и бригады видит только менеджер.
Клиенту нужно «сегодня» или «завтра» — скажи, что проверим занятость бригад и вернёмся,
или что менеджер подтвердит день. Никогда не пиши «забронировала», «записала вас на…»,
«ждём вас в субботу». Стадию «дата согласована» не ставь.

КОГДА ЗАЯВКА ГОТОВА: понятно, что перевозим — мебель и техника (фото или список), а не
только число коробок и комнат, — откуда и куда,
есть ли лифты, а если их нет — этажи, будут ли коробки и нужна ли упаковка.
Тогда скажи, что передаёшь всё менеджеру, например:
«Спасибо! Передаю менеджеру — он посчитает стоимость и напишет вам».
Поставь lead_ready = true и stage «заявка готова». Больше вопросов в этом ответе не задавай.

КОГДА ЗВАТЬ МЕНЕДЖЕРА (needs_human = true), не дожидаясь готовой заявки:
- просит скидку, торгуется или спорит о цене;
- недоволен, жалуется, пишет резко;
- просит живого человека или позвонить;
- просит то, чего нет в условиях: хранение вещей, пианино, сейф, перевозка за границу;
- офисный переезд или ситуация, в которой ты не уверена.
Скажи коротко и естественно: «Сейчас подключу менеджера, он ответит здесь».

НЕ ПОВТОРЯЙ СВОИ ВОПРОСЫ. Посмотри, о чём уже спрашивала в переписке и что уже
записано в заявке: вещи, адреса, лифты, этажи, коробки, упаковка. Клиент ответил —
иди дальше по сценарию. Не ответил — не переспрашивай тем же вопросом, просто жди.

НЕ СПЕШИ ПЕРЕДАВАТЬ. Прежде чем передать, собери хотя бы что перевозим, откуда и куда
и лифты — иначе менеджер получит пустую заявку и будет спрашивать то же самое заново.
Если сомневаешься, задай ещё один вопрос по делу, а передавай только когда упёрлась в условия.

ДОЛЖНОСТЕЙ НЕ ВЫДУМЫВАЙ. Того, кто продолжит разговор, называй просто менеджером.
Никаких «генеральный директор», «руководитель отдела», «старший логист» — в компании
для клиента есть менеджер, и этого достаточно.

ЕСЛИ СПРОСЯТ, БОТ ЛИ ТЫ, — ответь честно: ты виртуальная помощница компании, а цену и детали
дальше ведёт живой менеджер; предложи позвать его. Не отрицай, что ты ИИ, не выдумывай
о себе личных историй.

ЯЗЫК. Отвечай на языке ПОСЛЕДНЕГО сообщения клиента: иврит, русский, английский.
Клиент пишет на иврите — отвечаешь на иврите, даже когда передаёшь диалог менеджеру.
Перешёл на русский — переходи и ты. Язык приветствия и язык этой инструкции ни на что не влияют.`;

const seed = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
seed.run('system_prompt', DEFAULT_PROMPT);
seed.run('ai_global', '1');
// Приветствие шлёт код, а не модель: она его иногда «забывает» ради краткости.
// По решению компании бот не называет себя виртуальным в приветствии; если клиент
// спросит прямо, бот честно скажет, что он ИИ (правило в промпте). {company} — из настроек.
const DEFAULT_GREETING = [
  'ru: Здравствуйте! Я Майя, помогу с вашим переездом.',
  'he: שלום! כאן מאיה, אשמח לעזור בנושא ההובלה שלך',
  "en: Hi! I'm Maya, happy to help with your move.",
  'uk: Вітаю! Я Майя, допоможу з вашим переїздом.'
].join('\n');
seed.run('greeting', DEFAULT_GREETING);
seed.run('business_hours', '');
// Услуги и цены вынесены из промпта отдельно — их правят чаще всего,
// и лезть ради этого в инструкцию для модели неудобно.
const DEFAULT_FACTS = [
  '⚠️ ДЕМО-ДАННЫЕ — замените на свои.',
  '',
  'Переезды квартир, домов и офисов: машина, грузчики, разборка и сборка мебели.',
  'Упаковка вещей и коробки — отдельная услуга, считается сверху.',
  'Стоимость зависит от объёма вещей, этажей и лифтов, упаковки и расстояния.',
  'Точную цену называет менеджер, бот её не считает.',
  'Работаем по всему Израилю, выезжаем в любой город: Хайфа, Иерусалим, Беэр-Шева, Эйлат - куда угодно.',
  'На вопрос «вы работаете в таком-то городе» отвечай просто «да, работаем», без оговорок и без «уточню у менеджера».',
  'Пианино, сейфы, перевозка за границу и хранение вещей - только после согласования с менеджером.',
  'Оплата после разгрузки.'
].join('\n');
seed.run('business_facts', DEFAULT_FACTS);
// Чёрный список: этим номерам бот не отвечает, в заявки они не попадают. Правится в админке.
seed.run('blocked_numbers', '');
// Кому слать уведомления о передаче заявки. Пусто — не слать.
seed.run('manager_numbers', '');
seed.run('notify_on', '1');
seed.run('admin_url', '');
// справочник кампаний: «ключ = Название». Ключ ищется в объявлении и первом сообщении
seed.run('source_map', '');
// Глубина обдумывания ответа: low | medium | high. Правится в админке на лету.
// По умолчанию high: переписка с живым клиентом дороже сэкономленных центов,
// а на низкой модель теряет нить в длинном диалоге.
seed.run('ai_effort', 'high');   // для ссылки на диалог; на Render берётся из RENDER_EXTERNAL_URL
// Дожим: если клиент замолчал после цены, бот сам напомнит о себе. Только в рабочие часы.
seed.run('nudge_on', '1');
seed.run('nudge_hours', '20');          // через сколько часов тишины первое напоминание
seed.run('nudge_repeat_hours', '72');   // через сколько после него второе
seed.run('nudge_max', '2');             // больше двух раз не напоминаем
seed.run('nudge_stale_hours', '336');   // молчит дольше двух недель — напоминать поздно
// Ритм торканий зависит от того, где остановились: вопрос без ответа остывает быстрее,
// чем «подумаю» после цены. Часы от последнего сообщения бота.
seed.run('nudge_steps_ask', '3,24,72');
seed.run('nudge_steps_quoted', '24,72,168');
// Подтверждение заказа накануне и утром — меньше срывов выезда
seed.run('confirm_on', '1');
seed.run('confirm_eve_hour', '18');
seed.run('confirm_morning_hour', '8');
// Диалоги, которые ведёт менеджер, бот не дожимает — напоминает самому менеджеру
seed.run('manager_ping_hours', '48');
seed.run('stop_words', [
  'не пишите', 'не пиши', 'не писать', 'отпишитесь', 'отписаться', 'хватит писать',
  'перестаньте писать', 'не беспокойте', 'не турбуйте', 'stop', 'unsubscribe',
  'תפסיקו לכתוב', 'אל תכתבו', 'להסיר אותי'
].join('\n'));
// Пауза перед ответом: за неё бот успевает дождаться, пока клиент допишет
// очередь коротких сообщений, и отвечает один раз на всю пачку.
seed.run('reply_delay', String(process.env.REPLY_DELAY_MS ?? 4000));
seed.run('timezone', 'Asia/Jerusalem');
// часы по каждому дню отдельно: пятница в Израиле почти везде короткая
seed.run('work_hours', JSON.stringify({
  0: ['08:00', '20:00'], 1: ['08:00', '20:00'], 2: ['08:00', '20:00'],
  3: ['08:00', '20:00'], 4: ['08:00', '20:00'], 5: ['08:00', '13:00'], 6: null
}));
seed.run('holidays', '');               // «ГГГГ-ММ-ДД название», по строке на дату
seed.run('off_hours', 'notice');        // always | notice | silent
seed.run('off_hours_note', 'Сейчас нерабочее время, менеджер подтвердит заказ в рабочие часы.');
seed.run('autoclose_days', '0');
seed.run('company', 'Переезды');
// предел очереди «Нужен человек»: больше — значит менеджер не справляется
seed.run('wip_need', '5');
// заготовки ответов: менеджер печатает одно и то же по десять раз в день
const DEFAULT_QUICK = [
  'Спасибо за список! Переезд обойдётся в … ₪. Когда вам удобно?',
  'Можем приехать на бесплатный осмотр — в какой день удобно?',
  'Упаковку можем взять на себя: коробки, плёнка и работа грузчиков включены.',
  'Мебель разберём и соберём на месте, это входит в стоимость.',
  'Оплата — после разгрузки. Накануне напомним и приедем в оговорённое время.'
].join('\n');
seed.run('quick_replies', DEFAULT_QUICK);

// Тексты по умолчанию обновляются и на уже работающих базах, но только если их
// никто не правил: сравниваем с отпечатками прежних версий. Свои правки не трогаем.
const LEGACY = {
  system_prompt: ['1b453a867914c37f', '3ef3f8698746ef82', 'adc2feb61350df07', '8307ea3d0970045f',
    '5f4b795ba4e4c687', 'f88851db9fb0f5fd', 'efb88b28b8f386fa', '6ad34f236f2c644c'],
  greeting: ['c351e74f95b6f547', 'ca7b7212d8125008'],
  business_facts: [],
  quick_replies: []
};
const FRESH = { system_prompt: DEFAULT_PROMPT, greeting: DEFAULT_GREETING, business_facts: DEFAULT_FACTS, quick_replies: DEFAULT_QUICK };
const fingerprint = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
for (const [key, value] of Object.entries(FRESH)) {
  const cur = db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  if (cur != null && LEGACY[key].includes(fingerprint(cur))) {
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(value, key);
  }
}

// Закрытая заявка никого не ждёт: флаг «нужен человек» на ней — след прошлого,
// из-за которого в архиве висело «ждёт 15 ч». Дёшево и идемпотентно.
db.exec("UPDATE conversations SET needs_human=0 WHERE status='closed' AND needs_human=1");

export const getSetting = (k) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;

export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

export function getOrCreateConversation(channel, phone, name, chatId = null) {
  const found = db.prepare('SELECT * FROM conversations WHERE channel=? AND phone=?').get(channel, phone);
  if (found) {
    if (name && !found.name) db.prepare('UPDATE conversations SET name=? WHERE id=?').run(name, found.id);
    // chat_id мог смениться (@lid ↔ @c.us) — всегда держим последний рабочий
    if (chatId && chatId !== found.chat_id) db.prepare('UPDATE conversations SET chat_id=? WHERE id=?').run(chatId, found.id);
    return db.prepare('SELECT * FROM conversations WHERE id=?').get(found.id);
  }
  const { lastInsertRowid } = db
    .prepare('INSERT INTO conversations(channel, phone, name, chat_id) VALUES(?,?,?,?)')
    .run(channel, phone, name ?? null, chatId);
  return db.prepare('SELECT * FROM conversations WHERE id=?').get(lastInsertRowid);
}

/** Провайдеры ретраят вебхуки — один и тот же wa_id не обрабатываем дважды. */
export const messageExists = (waId) =>
  Boolean(waId) && Boolean(db.prepare('SELECT 1 FROM messages WHERE wa_id=?').get(waId));

export function addMessage(convId, { direction, author, body, wa_id = null, error = null, media = null, kind = null }) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO messages(conv_id,direction,author,body,wa_id,error,media,kind) VALUES(?,?,?,?,?,?,?,?)')
    .run(convId, direction, author, body, wa_id, error, media?.length ? JSON.stringify(media) : null, kind);
  db.prepare("UPDATE conversations SET last_at = datetime('now') WHERE id=?").run(convId);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(lastInsertRowid);
}

/** Статус доставки приходит от WhatsApp отдельным событием, уже после отправки. */
export const setMessageStatus = (waId, status) =>
  db.prepare('UPDATE messages SET status=? WHERE wa_id=?').run(status, waId);

export const history = (convId, limit = 40) =>
  db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT ?').all(convId, limit).reverse();

/**
 * Источник обращения. Пишем только первый раз: человек приходит по рекламе
 * один раз, дальше он просто пишет в тот же чат, и перетирать метку нельзя.
 */
export function setSource(convId, src) {
  if (!src?.source) return;
  const cur = db.prepare('SELECT source FROM conversations WHERE id=?').get(convId);
  if (cur?.source) return;
  db.prepare('UPDATE conversations SET source=?, source_title=?, source_url=?, source_ref=?, source_raw=? WHERE id=?')
    .run(src.source, src.title || null, src.url || null, src.ref || null,
      src.raw ? JSON.stringify(src.raw) : null, convId);
}

/**
 * Стереть переписку и заявки, сохранив настройки, прайс и привязку WhatsApp.
 * Нужно перед запуском рекламы: тестовые диалоги портят и воронку, и отчёты.
 */
export function resetData() {
  const convs = db.prepare('SELECT count(*) n FROM conversations').get().n;
  const msgs = db.prepare('SELECT count(*) n FROM messages').get().n;
  const jobs = db.prepare('SELECT count(*) n FROM jobs').get().n;
  db.exec('DELETE FROM messages; DELETE FROM conversations; DELETE FROM jobs;');
  try { db.exec("DELETE FROM sqlite_sequence WHERE name IN ('messages','conversations','jobs')"); } catch {}
  let files = 0;
  const mediaDir = path.join(dir, 'media');
  if (!fs.existsSync(mediaDir)) return { conversations: convs, messages: msgs, jobs, files: 0 };
  for (const f of fs.readdirSync(mediaDir, { withFileTypes: true }).filter((x) => x.isFile())) {
    try { fs.rmSync(path.join(mediaDir, f.name)); files++; } catch {}
  }
  return { conversations: convs, messages: msgs, jobs, files };
}

export const getConversation = (id) =>
  db.prepare('SELECT * FROM conversations WHERE id=?').get(id);

export function listConversations() {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT body FROM messages m WHERE m.conv_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      -- когда клиент написал в последний раз: по нему считаем, сколько он уже ждёт
      (SELECT max(created_at) FROM messages m WHERE m.conv_id = c.id AND m.direction = 'in') AS last_in_at,
      (SELECT count(*) FROM messages m WHERE m.conv_id = c.id AND m.media IS NOT NULL) AS media_count
    FROM conversations c
    ORDER BY c.needs_human DESC, c.last_at DESC
  `).all();

  // превью фото прямо на карточке: снимок вещей — главный контекст заявки
  const thumbs = db.prepare(`
    SELECT media FROM messages WHERE conv_id = ? AND media IS NOT NULL ORDER BY id DESC LIMIT 3`);
  for (const c of rows) {
    c.thumbs = c.media_count
      ? thumbs.all(c.id).flatMap((r) => JSON.parse(r.media)).filter((x) => x.kind !== 'audio').slice(0, 3)
      : [];
  }
  return rows;
}

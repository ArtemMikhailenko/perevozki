/**
 * Приведение карточки заявки к допустимым значениям.
 *
 * Эти поля когда-то были строгими enum прямо в схеме ответа, и модель, которая
 * ведёт переписку на иврите, роняла весь ответ одним словом не из списка: клиент
 * не получал ничего, а менеджеру уходил JSON со стеком. Поэтому схема принимает
 * любую строку, а список допустимых значений живёт здесь.
 */

export const SERVICES = ['квартирный переезд', 'офисный переезд', 'вывоз вещей', 'отдельные вещи'];
export const PACKING = ['сам', 'нужна упаковка', 'нужны обе цены'];
export const STAGES = ['новый', 'уточняем', 'ждём список', 'заявка готова', 'назвали цену',
  'готов к заказу', 'дата согласована', 'отказ'];

// Ключ — допустимое значение, справа слова, по которым его узнаём.
// Иврит и английский тут не для красоты: переписка идёт на языке клиента.
const HINTS = {
  'квартирный переезд': ['квартир', 'дом', 'жиль', 'דירה', 'בית', 'apartment', 'home', 'house'],
  'офисный переезд': ['офис', 'склад', 'магазин', 'משרד', 'עסק', 'office', 'business'],
  'вывоз вещей': ['вывоз', 'выброс', 'свалк', 'мусор', 'פינוי', 'זבל', 'disposal', 'junk'],
  'отдельные вещи': ['одна вещь', 'только диван', 'только шкаф', 'пара вещей', 'פריט', 'single item'],
  'сам': ['сам', 'свои', 'не нужна', 'без упаковк', 'לבד', 'בעצמי', 'myself', 'self'],
  'нужна упаковка': ['нужна', 'упакуйте', 'с упаковкой', 'ваша упаковка', 'אריזה', 'packing', 'pack'],
  'нужны обе цены': ['оба', 'обе', 'и с', 'и без', 'два варианта', 'שתי אפשרויות', 'both']
};

const clean = (v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]/gu, ' ')
  .replace(/\s+/g, ' ').trim();

/** Ближайшее допустимое значение или пустая строка, если не узнали. */
export function pick(value, allowed) {
  const v = clean(value);
  if (!v) return '';
  const exact = allowed.find((a) => clean(a) === v);
  if (exact) return exact;
  // «квартирный переезд с упаковкой» — допустимое значение внутри фразы
  const inside = allowed.find((a) => v.includes(clean(a)));
  if (inside) return inside;
  const byHint = allowed.find((a) => (HINTS[a] ?? []).some((h) => v.includes(clean(h))));
  return byHint || '';
}

const YES = ['да', 'есть', 'так', 'yes', 'true', 'כן', 'יש', 'יש מעלית'];
const NO = ['нет', 'нету', 'не будет', 'без', 'отсутств', 'no', 'false', 'לא', 'אין', 'ні'];

/**
 * «да» / «нет» / пусто — из чего угодно, на любом из четырёх языков.
 * Короткие слова («да», «no», «יש») ищем целиком: иначе «no» находится в «normal»,
 * а «да» — в «дальше», и заявка получает ответ, которого клиент не давал.
 */
const hasWord = (words, needle) => {
  const n = clean(needle);
  return n.includes(' ') || n.length > 3 ? words.join(' ').includes(n) : words.includes(n);
};

export function yesNo(value) {
  const v = clean(value);
  if (!v) return '';
  const words = v.split(' ');
  if (NO.some((n) => hasWord(words, n))) return 'нет';
  if (YES.some((y) => hasWord(words, y))) return 'да';
  return '';
}

/** Только цифры: «примерно 10 коробок» → «10», «нет» → «нет». */
const count = (value) => {
  const v = clean(value);
  if (!v) return '';
  const n = v.match(/\d+/)?.[0];
  if (n) return n;
  return yesNo(v) === 'нет' ? 'нет' : String(value).trim();
};

/** Карточка после модели: непонятные значения обнуляем, но не роняем ответ. */
export function normalizeLead(lead = {}) {
  const out = { ...lead };
  out.service = pick(lead.service, SERVICES);
  out.packing = pick(lead.packing, PACKING);
  out.stage = pick(lead.stage, STAGES);
  out.from_elevator = yesNo(lead.from_elevator);
  out.to_elevator = yesNo(lead.to_elevator);
  out.boxes = count(lead.boxes);

  // Этаж имеет смысл только там, где нет лифта. Иначе в заявке висит «3 этаж»
  // рядом с «лифт есть», и грузчики закладывают лишних людей и время.
  if (out.from_elevator === 'да') out.from_floor = '';
  if (out.to_elevator === 'да') out.to_floor = '';

  // дата в карточке — либо настоящая ГГГГ-ММ-ДД, либо ничего: по ней строится расписание
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(out.date_iso ?? ''))) out.date_iso = '';
  return out;
}

export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

const CHECK_LINE_RE = /^\s*-\s*\[([ xX])\]\s*(.+)$/;
const REPEAT_RE = /\[repeat:(daily|weekly|monthly|every_n)(?::([0-9,]+))?\]/g;
const PIN_RE = /\[pin\]/gi;
const TAG_RE = /(?:^|\s)(#[a-zA-Zа-яА-ЯіїєґІЇЄҐ0-9_-]{1,28})/g;

export function extractTags(str) {
  const found = [];
  const seen = new Set();
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(String(str || ''))) !== null) {
    const tag = m[1];
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(tag);
    }
  }
  return found;
}

export function parseTaskMeta(rawNotes) {
  const raw = String(rawNotes || '');
  const pinned = /\[pin\]/i.test(raw);

  REPEAT_RE.lastIndex = 0;
  const repMatch = REPEAT_RE.exec(raw);
  const repeat = repMatch
    ? { type: repMatch[1], value: repMatch[2] || '' }
    : { type: 'none', value: '' };

  const checklist = [];
  const noteLines = [];

  for (const line of raw.split(/\r?\n/)) {
    const cm = line.match(CHECK_LINE_RE);
    if (cm) {
      checklist.push({ done: cm[1].toLowerCase() === 'x', text: cm[2].trim() });
      continue;
    }
    const cleaned = line
      .replace(PIN_RE, '')
      .replace(/\[repeat:(daily|weekly|monthly|every_n)(?::([0-9,]+))?\]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trimEnd();
    if (cleaned.trim() || noteLines.length > 0) {
      noteLines.push(cleaned);
    }
  }

  while (noteLines.length && !noteLines[noteLines.length - 1].trim()) {
    noteLines.pop();
  }

  const joinedNotes = noteLines.join('\n').trim();
  const tags = extractTags(joinedNotes);

  // Якщо останній рядок складається виключно з #тегів — відділяємо їх у поле тегів без дублювання в тексті
  let cleanNotes = joinedNotes;
  const splitOut = cleanNotes ? cleanNotes.split('\n') : [];
  if (splitOut.length > 0) {
    const lastLine = splitOut[splitOut.length - 1].trim();
    if (lastLine && /^(#[a-zA-Zа-яА-ЯіїєґІЇЄҐ0-9_-]{1,28}\s*)+$/.test(lastLine)) {
      splitOut.pop();
      cleanNotes = splitOut.join('\n').trim();
    }
  }

  return { cleanNotes, checklist, tags, pinned, repeat };
}

export function serializeTaskMeta({ cleanNotes = '', checklist = [], tags = [], pinned = false, repeat = null }) {
  const blocks = [];
  const baseText = String(cleanNotes || '').trim();
  if (baseText) blocks.push(baseText);

  const inlineTags = new Set(extractTags(baseText).map((t) => t.toLowerCase()));
  const extraTags = [];
  for (const rawTag of tags) {
    const norm = rawTag.startsWith('#') ? rawTag.trim() : `#${rawTag.trim()}`;
    if (norm.length > 1 && !inlineTags.has(norm.toLowerCase())) {
      inlineTags.add(norm.toLowerCase());
      extraTags.push(norm);
    }
  }
  if (extraTags.length) blocks.push(extraTags.join(' '));

  const validChecks = checklist
    .map((c) => ({ done: Boolean(c.done), text: String(c.text || '').trim() }))
    .filter((c) => c.text);
  if (validChecks.length) {
    blocks.push(validChecks.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n'));
  }

  const markers = [];
  if (pinned) markers.push('[pin]');
  if (repeat && repeat.type && repeat.type !== 'none') {
    markers.push(repeat.value ? `[repeat:${repeat.type}:${repeat.value}]` : `[repeat:${repeat.type}]`);
  }
  if (markers.length) blocks.push(markers.join(' '));

  return blocks.join('\n');
}

export function toggleChecklistItemInRaw(rawNotes, itemIndex) {
  const parsed = parseTaskMeta(rawNotes);
  if (!parsed.checklist[itemIndex]) return rawNotes;
  parsed.checklist[itemIndex].done = !parsed.checklist[itemIndex].done;
  return serializeTaskMeta(parsed);
}

export function formatRepeatBadge(repeat) {
  if (!repeat || !repeat.type || repeat.type === 'none') return '';
  if (repeat.type === 'daily') return 'щодня';
  if (repeat.type === 'every_n') return `кожні ${repeat.value || 1} дн`;
  if (repeat.type === 'monthly') return `щомісяця ${repeat.value || 1}-го`;
  if (repeat.type === 'weekly') {
    const days = String(repeat.value || '')
      .split(',')
      .map((n) => WEEKDAYS[Number(n) - 1])
      .filter(Boolean)
      .join(',');
    return days ? `щотижня: ${days}` : 'щотижня';
  }
  return '';
}

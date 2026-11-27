/**
 * Універсальний ШІ-асистент і голосове розпізнавання через Gemini Interactions API.
 * Ключ GEMINI_API_KEY зберігається виключно у ScriptProperties бекенду.
 */

const PROP_GEMINI_KEY = 'GEMINI_API_KEY';
const GEMINI_VOICE_MODELS = ['gemini-3.5-flash-lite', 'gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_API_REVISION = '2026-05-20';
const MAX_VOICE_BASE64_LEN = 6 * 1024 * 1024;
const SUPPORTED_AUDIO_MIMES = [
  'audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg',
  'audio/flac', 'audio/mpeg', 'audio/m4a', 'audio/l16', 'audio/opus',
  'audio/alaw', 'audio/mulaw', 'audio/webm'
];
const AI_ACTION_TYPES = [
  'task_create', 'task_update', 'task_done', 'task_delete',
  'journal_day', 'journal_month',
  'habit_create', 'habit_rename', 'habit_toggle', 'habit_delete'
];

function getGeminiKey_() {
  const val = PropertiesService.getScriptProperties().getProperty(PROP_GEMINI_KEY);
  return val ? String(val).trim() : '';
}

function hasGeminiKey_() {
  return Boolean(getGeminiKey_());
}

function promptSetGeminiKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(
    'Gemini API ключ (для голосу та ШІ-асистента)',
    'Вставте ключ із Google AI Studio (aistudio.google.com/apikey). Порожнє поле видалить ключ:',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = String(res.getResponseText() || '').trim();
  const props = PropertiesService.getScriptProperties();
  if (!key) {
    props.deleteProperty(PROP_GEMINI_KEY);
    ui.alert('Gemini API ключ видалено.');
    return;
  }
  props.setProperty(PROP_GEMINI_KEY, key);
  ui.alert('Gemini API ключ збережено у Script Properties.');
}

function authorizeExternalRequests() {
  UrlFetchApp.fetch('https://generativelanguage.googleapis.com/', { muteHttpExceptions: true });
}

function handleSetGeminiKey_(payload) {
  const key = String(payload && payload.geminiApiKey || '').trim();
  const props = PropertiesService.getScriptProperties();
  if (!key) props.deleteProperty(PROP_GEMINI_KEY);
  else props.setProperty(PROP_GEMINI_KEY, key);
  return { hasGeminiKey: hasGeminiKey_() };
}

function normalizeAudioMime_(rawMime) {
  const base = String(rawMime || '').split(';')[0].trim().toLowerCase();
  if (base === 'audio/mp4' || base === 'video/mp4' || base === 'audio/x-m4a' || base === 'audio/mp4a-latm') {
    return 'audio/m4a';
  }
  if (base === 'video/webm') return 'audio/webm';
  return SUPPORTED_AUDIO_MIMES.indexOf(base) !== -1 ? base : 'audio/webm';
}

function getUkWeekday_(dateStr) {
  const ukDays = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
  const p = String(dateStr || '').split('-').map(Number);
  if (p.length !== 3 || isNaN(p[0]) || isNaN(p[1]) || isNaN(p[2])) return '';
  const dt = new Date(p[0], p[1] - 1, p[2], 12, 0, 0);
  return ukDays[dt.getDay()] || '';
}

function extractInteractionText_(data) {
  const steps = data && Array.isArray(data.steps) ? data.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step || step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (let j = 0; j < step.content.length; j++) {
      const part = step.content[j];
      if (part && part.type === 'text' && part.text) return String(part.text);
    }
  }
  return '';
}

function callGeminiStructured_(apiKey, inputParts, schema) {
  const baseReq = {
    store: false,
    input: inputParts,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: schema
    }
  };

  let parsedResp = null;
  let lastErr = '';
  for (let mIdx = 0; mIdx < GEMINI_VOICE_MODELS.length; mIdx++) {
    const modelName = GEMINI_VOICE_MODELS[mIdx];
    const reqBody = Object.assign({ model: modelName }, baseReq);
    const resp = UrlFetchApp.fetch(GEMINI_INTERACTIONS_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-goog-api-key': apiKey,
        'Api-Revision': GEMINI_API_REVISION
      },
      payload: JSON.stringify(reqBody),
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();
    let cand = null;
    try { cand = JSON.parse(resp.getContentText()); } catch (_) { cand = null; }

    if (code >= 200 && code < 300 && cand) {
      parsedResp = cand;
      break;
    }

    const errMsg = (cand && cand.error && cand.error.message) || ('HTTP ' + code);
    lastErr = errMsg;
    const isTransient = code === 429 || code >= 500 || /high demand|overloaded|unavailable/i.test(errMsg);
    if (!isTransient) throw new Error('Gemini: ' + errMsg);
  }

  if (!parsedResp) throw new Error('Gemini: ' + (lastErr || 'Моделі тимчасово перевантажені'));

  const jsonText = extractInteractionText_(parsedResp);
  if (!jsonText) throw new Error('Gemini не повернув відповідь');

  try {
    return JSON.parse(jsonText);
  } catch (_) {
    throw new Error('Не вдалося розібрати JSON відповідь Gemini');
  }
}

function buildVoicePrompt_(todayDate, defaultStatus) {
  const weekday = getUkWeekday_(todayDate);
  return [
    'Ти — асистент персонального Kanban-трекера задач українською мовою.',
    'Сьогодні: ' + todayDate + (weekday ? ' (' + weekday + ')' : '') + '.',
    'Прослухай аудіо та виділи всі згадані задачі.',
    'Правила:',
    '1. Якщо в аудіо згадано кілька окремих справ — створи окремий об’єкт у масиві tasks для кожної.',
    '2. Назву task формулюй коротко і чітко українською (дієслово + суть).',
    '3. Сфера (sphere): "Крипта", "Навчання", або "Життя".',
    '4. Статус (status): "Фокус", "Short", "Mid", "Long", "Sort". Якщо неясно — постав "' + defaultStatus + '".',
    '5. Пріоритет (priority): "Високий", "Низький", або "Середній".',
    '6. Відносні дати переведи у YYYY-MM-DD відносно ' + todayDate + '.',
    '7. Час у форматі HH:mm (24h), якщо згадано, інакше "".',
    '8. Деталі, суми, посилання або #теги клади в notes; підпункти — у checklist.',
    '9. Якщо аудіо порожнє або нерозбірливе — поверни tasks: [].'
  ].join('\n');
}

function sanitizeVoiceTask_(raw, defaultStatus) {
  const title = String(raw && raw.task || '').trim();
  if (!title) return null;
  const activeStatuses = ['Sort', 'Short', 'Mid', 'Long', 'Фокус'];
  const rawStatus = normalizeStatus_(raw.status, defaultStatus);
  const status = activeStatuses.indexOf(rawStatus) !== -1 ? rawStatus : defaultStatus;
  const checklist = Array.isArray(raw.checklist)
    ? raw.checklist.map(function(c) { return String(c || '').trim(); }).filter(Boolean).slice(0, 15)
    : [];

  return {
    task: title,
    sphere: sanitizeEnum_(raw.sphere, VALID_SPHERES, 'Життя'),
    status: status,
    priority: sanitizeEnum_(raw.priority, VALID_PRIORITIES, 'Середній'),
    deadline: normalizeDateInput_(raw.deadline),
    time: normalizeTimeInput_(raw.time),
    notes: String(raw.notes || '').trim(),
    checklist: checklist
  };
}

function handleVoiceParse_(payload) {
  const apiKey = getGeminiKey_();
  if (!apiKey) throw new Error('Спочатку додайте Gemini API ключ у Налаштуваннях');

  const rawB64 = String(payload && payload.audioBase64 || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!rawB64) throw new Error('Аудіозапис порожній');
  if (rawB64.length > MAX_VOICE_BASE64_LEN) throw new Error('Занадто довгий аудіозапис (спробуйте коротше, до 1 хв)');

  const mimeType = normalizeAudioMime_(payload && payload.mimeType);
  const tz = Session.getScriptTimeZone();
  const todayDate = normalizeDateInput_(payload && payload.todayDate) || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const rawDef = normalizeStatus_(payload && payload.defaultStatus, 'Фокус');
  const defaultStatus = rawDef === 'Готово' ? 'Фокус' : rawDef;

  const schema = {
    type: 'object',
    properties: {
      transcript: { type: 'string' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string' },
            sphere: { type: 'string', enum: ['Крипта', 'Навчання', 'Життя'] },
            status: { type: 'string', enum: ['Sort', 'Short', 'Mid', 'Long', 'Фокус'] },
            priority: { type: 'string', enum: ['Високий', 'Середній', 'Низький'] },
            deadline: { type: 'string' },
            time: { type: 'string' },
            notes: { type: 'string' },
            checklist: { type: 'array', items: { type: 'string' } }
          },
          required: ['task', 'sphere', 'status', 'priority']
        }
      }
    },
    required: ['transcript', 'tasks']
  };

  const result = callGeminiStructured_(apiKey, [
    { type: 'text', text: buildVoicePrompt_(todayDate, defaultStatus) },
    { type: 'audio', data: rawB64, mime_type: mimeType }
  ], schema);

  const tasks = (Array.isArray(result.tasks) ? result.tasks : [])
    .map(function(item) { return sanitizeVoiceTask_(item, defaultStatus); })
    .filter(Boolean);

  return {
    transcript: String(result.transcript || '').trim(),
    tasks: tasks
  };
}

function formatContextForAi_(todayDate, rawCtx) {
  let tasks = rawCtx && Array.isArray(rawCtx.tasks) ? rawCtx.tasks : null;
  let journal = rawCtx && rawCtx.journal ? rawCtx.journal : null;
  if (!tasks || !journal) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!tasks) tasks = readTasks_(getTasksSheet_(ss));
    if (!journal) journal = readJournalPayload_(ss);
  }

  const lines = ['ПОТОЧНІ ЗАДАЧІ НА ДОШЦІ:'];
  const capped = (tasks || []).slice(0, 100);
  if (!capped.length) {
    lines.push('(задач поки немає)');
  } else {
    for (let i = 0; i < capped.length; i++) {
      const t = capped[i];
      const noteSnippet = String(t.notes || '').replace(/\r?\n/g, ' ⏎ ').slice(0, 220);
      lines.push(
        '[row=' + t.row + '] "' + String(t.task || '') + '"' +
        ' | статус=' + (t.status || '') +
        ' | сфера=' + (t.sphere || '') +
        ' | пріоритет=' + (t.priority || '') +
        ' | дедлайн=' + (t.deadline || '-') +
        ' | час=' + (t.time || '-') +
        ' | done=' + Boolean(t.done) +
        (noteSnippet ? ' | нотатки="' + noteSnippet + '"' : '')
      );
    }
  }

  const habits = Array.isArray(journal && journal.habits) ? journal.habits : [];
  lines.push('\nЗВИЧКИ:');
  if (!habits.length) {
    lines.push('(звичок немає)');
  } else {
    for (let i = 0; i < habits.length; i++) {
      lines.push('[id=' + habits[i].id + '] "' + habits[i].name + '" (' + (habits[i].active === false ? 'прихована' : 'активна') + ')');
    }
  }

  const ym = todayDate.slice(0, 7);
  const mFocus = (journal && journal.monthFocus && journal.monthFocus[ym]) || '';
  const mReview = (journal && journal.monthReview && journal.monthReview[ym]) || '';
  const selectedDay = (rawCtx && normalizeDateInput_(rawCtx.dayDate)) || todayDate;
  lines.push('\nЩОДЕННИК (вибраний день: ' + selectedDay + ', місяць: ' + ym + '):');
  if (mFocus) lines.push('Фокус місяця (' + ym + '): ' + mFocus.slice(0, 250));
  if (mReview) lines.push('Підсумки місяця (' + ym + '): ' + mReview.slice(0, 250));

  const entries = (journal && journal.entries) || {};
  const datesToShow = {};
  datesToShow[todayDate] = true;
  datesToShow[selectedDay] = true;
  Object.keys(entries).sort().reverse().slice(0, 5).forEach(function(d) { datesToShow[d] = true; });
  Object.keys(datesToShow).sort().reverse().forEach(function(d) {
    const e = entries[d];
    if (!e) return;
    lines.push(
      '[' + d + '] оцінка=' + (e.rating || '-') +
      ' | фокус="' + String(e.focus || '').slice(0, 120) + '"' +
      ' | звички=' + (Array.isArray(e.doneHabits) ? e.doneHabits.join(',') : '') +
      (e.wins ? ' | вдалося="' + String(e.wins).slice(0, 100) + '"' : '') +
      (e.blockers ? ' | заважало="' + String(e.blockers).slice(0, 100) + '"' : '')
    );
  });

  return lines.join('\n');
}

function buildAiCommandPrompt_(todayDate, defaultStatus, contextText) {
  const weekday = getUkWeekday_(todayDate);
  return [
    'Ти — розумний ШІ-помічник персонального трекера "Задачі PRO" (Kanban-дошка + Щоденник + Звички) українською мовою.',
    'Сьогодні: ' + todayDate + (weekday ? ' (' + weekday + ')' : '') + '. Статус за замовчуванням для нових задач: "' + defaultStatus + '".',
    '',
    contextText,
    '',
    'ПРАВИЛА РОБОТИ:',
    '1. Зрозумій голосову або текстову команду користувача. Можна сформувати 1 або кілька дій в масиві actions.',
    '2. Усі зміни спочатку показуються користувачу на екрані превʼю, тому обирай точні row або habitId зі списку вище. НІКОЛИ не вигадуй неіснуючий row.',
    '3. Відповідь reply — коротка, жива, по суті українською (1–2 речення). Якщо користувач просто питає (напр. "що горить сьогодні?"), поверни actions: [] і дай відповідь у reply.',
    '4. Типи дій (type):',
    '   - task_create: створити нову задачу (task, sphere: "Крипта"|"Навчання"|"Життя", status: "Sort"|"Short"|"Mid"|"Long"|"Фокус", priority: "Високий"|"Середній"|"Низький", deadline YYYY-MM-DD, time HH:mm, notes, checklist, pinned).',
    '   - task_update: змінити існуючу задачу за точним row. Заповнюй ТІЛЬКИ поля, які треба змінити (інші рядкові поля залишай ""). Щоб очистити дату/час/нотатки — став clearDeadline/clearTime/clearNotes = true. Щоб додати до існуючих нотаток, використовуй notesAppend замість notes. Для чекліста: checklistAdd, checklistRemove, checklistToggle.',
    '   - task_done: відмітити задачу виконаною (done: true) або повернути в роботу (done: false) за row.',
    '   - task_delete: видалити задачу за точним row (лише коли користувач явно просить видалити/прибрати).',
    '   - journal_day: оновити щоденник за date (YYYY-MM-DD, за замовчуванням ' + todayDate + ' або вибраний день): focus, rating (1..10), wins, blockers, habitsMarkDone (назви або id звичок), habitsMarkUndone, clearFocus/clearWins/clearBlockers/clearRating.',
    '   - journal_month: оновити monthFocus або monthReview за ym (YYYY-MM, за замовчуванням ' + todayDate.slice(0, 7) + ').',
    '   - habit_create (habitName), habit_rename (habitId, habitName), habit_toggle (habitId, active: true/false), habit_delete (habitId).',
    '5. Кожна дія обовʼязково має короткий зрозумілий summary українською (напр. "Перенести Bybit на 28.11 18:00").',
    '6. Відносні дати ("завтра", "післязавтра", "у понеділок") рахуй від ' + todayDate + '.'
  ].join('\n');
}

function sanitizeStrList_(arr, maxItems) {
  if (!Array.isArray(arr)) return [];
  return arr.map(function(x) { return String(x || '').trim(); }).filter(Boolean).slice(0, maxItems || 15);
}

function sanitizeAiAction_(raw, defaultStatus, todayDate) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim();
  if (AI_ACTION_TYPES.indexOf(type) === -1) return null;

  const summary = String(raw.summary || '').trim().slice(0, 140);
  const rowNum = Number(raw.row);
  const validRow = Number.isInteger(rowNum) && rowNum >= 2 ? rowNum : 0;

  if (type === 'task_delete' || type === 'task_done') {
    if (!validRow) return null;
    return {
      type: type,
      summary: summary,
      row: validRow,
      done: type === 'task_done' ? raw.done !== false : false
    };
  }

  if (type === 'task_create') {
    const title = String(raw.task || '').trim();
    if (!title) return null;
    const activeStatuses = ['Sort', 'Short', 'Mid', 'Long', 'Фокус'];
    const normStatus = normalizeStatus_(raw.status, defaultStatus);
    return {
      type: type,
      summary: summary || ('Створити: ' + title),
      task: title,
      sphere: sanitizeEnum_(raw.sphere, VALID_SPHERES, 'Життя'),
      status: activeStatuses.indexOf(normStatus) !== -1 ? normStatus : defaultStatus,
      priority: sanitizeEnum_(raw.priority, VALID_PRIORITIES, 'Середній'),
      deadline: normalizeDateInput_(raw.deadline),
      time: normalizeTimeInput_(raw.time),
      notes: String(raw.notes || '').trim(),
      checklist: sanitizeStrList_(raw.checklist, 15),
      pinned: raw.pinned === true
    };
  }

  if (type === 'task_update') {
    if (!validRow) return null;
    const rawSph = String(raw.sphere || '').trim();
    const rawSt = String(raw.status || '').trim();
    const rawPr = String(raw.priority || '').trim();
    return {
      type: type,
      summary: summary,
      row: validRow,
      task: String(raw.task || '').trim(),
      sphere: VALID_SPHERES.indexOf(rawSph) !== -1 ? rawSph : '',
      status: VALID_STATUSES.indexOf(rawSt) !== -1 ? rawSt : '',
      priority: VALID_PRIORITIES.indexOf(rawPr) !== -1 ? rawPr : '',
      deadline: normalizeDateInput_(raw.deadline),
      time: normalizeTimeInput_(raw.time),
      notes: String(raw.notes || '').trim(),
      notesAppend: String(raw.notesAppend || '').trim(),
      checklistAdd: sanitizeStrList_(raw.checklistAdd, 15),
      checklistRemove: sanitizeStrList_(raw.checklistRemove, 15),
      checklistToggle: sanitizeStrList_(raw.checklistToggle, 15),
      hasPinnedChange: typeof raw.pinned === 'boolean',
      pinned: raw.pinned === true,
      clearDeadline: raw.clearDeadline === true,
      clearTime: raw.clearTime === true,
      clearNotes: raw.clearNotes === true
    };
  }

  if (type === 'journal_day') {
    const num = Number(raw.rating);
    const rating = Number.isFinite(num) && num >= 1 && num <= 10 ? Math.round(num) : null;
    return {
      type: type,
      summary: summary,
      date: normalizeDateInput_(raw.date) || todayDate,
      focus: String(raw.focus || '').trim(),
      rating: rating,
      wins: String(raw.wins || '').trim(),
      blockers: String(raw.blockers || '').trim(),
      habitsMarkDone: sanitizeStrList_(raw.habitsMarkDone, 15),
      habitsMarkUndone: sanitizeStrList_(raw.habitsMarkUndone, 15),
      clearFocus: raw.clearFocus === true,
      clearWins: raw.clearWins === true,
      clearBlockers: raw.clearBlockers === true,
      clearRating: raw.clearRating === true
    };
  }

  if (type === 'journal_month') {
    const ym = /^\d{4}-\d{2}$/.test(String(raw.ym || '').trim()) ? String(raw.ym).trim() : todayDate.slice(0, 7);
    return {
      type: type,
      summary: summary,
      ym: ym,
      monthFocus: String(raw.monthFocus || '').trim(),
      monthReview: String(raw.monthReview || '').trim(),
      clearMonthFocus: raw.clearMonthFocus === true,
      clearMonthReview: raw.clearMonthReview === true
    };
  }

  const habitId = String(raw.habitId || '').trim().slice(0, 32);
  const habitName = String(raw.habitName || '').trim().slice(0, 60);
  if (type === 'habit_create' && !habitName) return null;
  if (type === 'habit_rename' && (!habitId || !habitName)) return null;
  if ((type === 'habit_toggle' || type === 'habit_delete') && !habitId && !habitName) return null;
  return {
    type: type,
    summary: summary,
    habitId: habitId,
    habitName: habitName,
    active: raw.active !== false
  };
}

function handleAiCommand_(payload) {
  const apiKey = getGeminiKey_();
  if (!apiKey) throw new Error('Спочатку додайте Gemini API ключ у Налаштуваннях');

  const cleanText = String(payload && payload.text || '').trim().slice(0, 4000);
  const rawB64 = String(payload && payload.audioBase64 || '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!cleanText && !rawB64) throw new Error('Введіть команду або запишіть голос');
  if (rawB64.length > MAX_VOICE_BASE64_LEN) throw new Error('Занадто довгий аудіозапис (спробуйте коротше, до 1 хв)');

  const tz = Session.getScriptTimeZone();
  const todayDate = normalizeDateInput_(payload && payload.todayDate) || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const rawDef = normalizeStatus_(payload && payload.defaultStatus, 'Фокус');
  const defaultStatus = rawDef === 'Готово' ? 'Фокус' : rawDef;
  const contextText = formatContextForAi_(todayDate, payload && payload.context);

  const schema = {
    type: 'object',
    properties: {
      transcript: { type: 'string' },
      reply: { type: 'string' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: AI_ACTION_TYPES },
            summary: { type: 'string' },
            row: { type: 'integer' },
            task: { type: 'string' },
            sphere: { type: 'string' },
            status: { type: 'string' },
            priority: { type: 'string' },
            deadline: { type: 'string' },
            time: { type: 'string' },
            notes: { type: 'string' },
            notesAppend: { type: 'string' },
            checklist: { type: 'array', items: { type: 'string' } },
            checklistAdd: { type: 'array', items: { type: 'string' } },
            checklistRemove: { type: 'array', items: { type: 'string' } },
            checklistToggle: { type: 'array', items: { type: 'string' } },
            pinned: { type: 'boolean' },
            done: { type: 'boolean' },
            clearDeadline: { type: 'boolean' },
            clearTime: { type: 'boolean' },
            clearNotes: { type: 'boolean' },
            date: { type: 'string' },
            focus: { type: 'string' },
            rating: { type: 'integer' },
            wins: { type: 'string' },
            blockers: { type: 'string' },
            habitsMarkDone: { type: 'array', items: { type: 'string' } },
            habitsMarkUndone: { type: 'array', items: { type: 'string' } },
            clearFocus: { type: 'boolean' },
            clearWins: { type: 'boolean' },
            clearBlockers: { type: 'boolean' },
            clearRating: { type: 'boolean' },
            ym: { type: 'string' },
            monthFocus: { type: 'string' },
            monthReview: { type: 'string' },
            clearMonthFocus: { type: 'boolean' },
            clearMonthReview: { type: 'boolean' },
            habitId: { type: 'string' },
            habitName: { type: 'string' },
            active: { type: 'boolean' }
          },
          required: ['type', 'summary']
        }
      }
    },
    required: ['transcript', 'reply', 'actions']
  };

  const parts = [{ type: 'text', text: buildAiCommandPrompt_(todayDate, defaultStatus, contextText) }];
  if (rawB64) {
    parts.push({ type: 'audio', data: rawB64, mime_type: normalizeAudioMime_(payload && payload.mimeType) });
  }
  if (cleanText) {
    parts.push({ type: 'text', text: 'Команда користувача:\n' + cleanText });
  }

  const result = callGeminiStructured_(apiKey, parts, schema);
  const actions = (Array.isArray(result.actions) ? result.actions : [])
    .map(function(item) { return sanitizeAiAction_(item, defaultStatus, todayDate); })
    .filter(Boolean);

  return {
    transcript: String(result.transcript || '').trim(),
    reply: String(result.reply || '').trim() || (actions.length ? 'Ось план змін — перевір і підтвердь.' : 'Готово.'),
    actions: actions
  };
}

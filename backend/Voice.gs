/**
 * Голосове розпізнавання задач через Gemini Interactions API (gemini-4-hydrogen).
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
    'Gemini API ключ (для голосу)',
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

function buildVoicePrompt_(todayDate, defaultStatus) {
  const ukDays = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
  const p = todayDate.split('-').map(Number);
  const dt = new Date(p[0], p[1] - 1, p[2], 12, 0, 0);
  const weekday = ukDays[dt.getDay()] || '';

  return [
    'Ти — асистент персонального Kanban-трекера задач українською мовою.',
    'Сьогодні: ' + todayDate + (weekday ? ' (' + weekday + ')' : '') + '.',
    'Прослухай аудіо та виділи всі згадані задачі.',
    'Правила:',
    '1. Якщо в аудіо згадано кілька окремих справ — створи окремий об’єкт у масиві tasks для кожної.',
    '2. Назву task формулюй коротко і чітко українською (дієслово + суть).',
    '3. Сфера (sphere): "Крипта" (біржі, токени, дропи, Web3, гаманці, угоди), "Навчання" (курси, книги, англійська, програмування), інакше "Життя" (побут, спорт, покупки, дзвінки).',
    '4. Статус (status): "Фокус" (треба зробити сьогодні/зараз), "Short" (1–3 дні), "Mid" (цей тиждень), "Long" (довгостроково), "Sort" (ідея без терміну). Якщо неясно — постав "' + defaultStatus + '".',
    '5. Пріоритет (priority): "Високий" (терміново/важливо/сьогодні), "Низький" (колись/нетерміново), інакше "Середній".',
    '6. Відносні дати ("сьогодні", "завтра", "післязавтра", день тижня) переведи у YYYY-MM-DD відносно ' + todayDate + '. Якщо дедлайн не згадано — "".',
    '7. Час у форматі HH:mm (24h), якщо згадано, інакше "".',
    '8. Деталі, суми, посилання або #теги (напр. #bybit) клади в notes. Якщо диктуються підпункти/кроки — клади у checklist (без префіксів "- [ ]").',
    '9. Якщо аудіо порожнє або нерозбірливе — поверни tasks: [].'
  ].join('\n');
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
      transcript: { type: 'string', description: 'Точна розшифровка мовлення українською.' },
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

  const baseReq = {
    store: false,
    input: [
      { type: 'text', text: buildVoicePrompt_(todayDate, defaultStatus) },
      { type: 'audio', data: rawB64, mime_type: mimeType }
    ],
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
    try {
      cand = JSON.parse(resp.getContentText());
    } catch (_) {
      cand = null;
    }

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
  if (!jsonText) throw new Error('Gemini не повернув розшифровку');

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch (_) {
    throw new Error('Не вдалося розібрати JSON відповідь Gemini');
  }

  const tasks = (Array.isArray(result.tasks) ? result.tasks : [])
    .map(function(item) { return sanitizeVoiceTask_(item, defaultStatus); })
    .filter(Boolean);

  return {
    transcript: String(result.transcript || '').trim(),
    tasks: tasks
  };
}

/**
 * Telegram-сповіщення з Google Apps Script (Pilot Cockpit Cards + Mini App):
 * - Вбудована кнопка меню Telegram («Задачі» web_app) та інлайн-кнопки переходу
 * - Ранковий брифінг (08:30): KPI-рядок, Фокус дня, прострочені, план і прогрес
 * - Нагадування про дедлайн (кожні 15 хв): картка за 0–30 хв до часу задачі
 * - Вечірній підсумок (21:00): прогрес задач, звички/оцінка щоденника та залишок
 */

const PROP_TG_TOKEN = 'TG_BOT_TOKEN';
const PROP_TG_CHAT_ID = 'TG_CHAT_ID';
const PROP_TG_ENABLED = 'TG_ENABLED';
const PWA_PUBLIC_URL = 'https://vlad-warlock.github.io/tasks-pwa/';
const TG_TRIGGER_HANDLERS = ['tgMorningDigest', 'tgEveningDigest', 'tgCheckDeadlines'];
const TG_WEEKDAYS = { '1': 'пн', '2': 'вт', '3': 'ср', '4': 'чт', '5': 'пт', '6': 'сб', '7': 'нд' };
const TG_PRIO_WEIGHT = { 'Високий': 0, 'Середній': 1, 'Низький': 2 };

function getTgConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    token: String(props.getProperty(PROP_TG_TOKEN) || '').trim(),
    chatId: String(props.getProperty(PROP_TG_CHAT_ID) || '').trim(),
    enabled: String(props.getProperty(PROP_TG_ENABLED) || 'false') === 'true'
  };
}

function getTelegramStatus_() {
  const cfg = getTgConfig_();
  return {
    hasToken: Boolean(cfg.token),
    chatId: cfg.chatId,
    enabled: Boolean(cfg.enabled && cfg.token && cfg.chatId)
  };
}

function sanitizeTgToken_(raw) {
  const m = String(raw || '').match(/\d{5,15}:[A-Za-z0-9_-]{20,80}/);
  return m ? m[0] : '';
}

function escapeTgHtml_(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function tgProgressBar_(done, total) {
  const safeTotal = total > 0 ? total : 0;
  const pct = safeTotal > 0 ? Math.min(100, Math.round((done / safeTotal) * 100)) : 0;
  const filled = Math.round(pct / 10);
  let bar = '';
  for (let i = 0; i < 10; i++) bar += i < filled ? '▰' : '▱';
  return '<code>' + bar + '</code> <b>' + pct + '%</b> (' + done + '/' + safeTotal + ')';
}

function tgPriorityDot_(prio) {
  if (prio === 'Високий') return '🔴';
  if (prio === 'Середній') return '🟡';
  if (prio === 'Низький') return '🟢';
  return '▫️';
}

function tgSphereTag_(sphere) {
  if (sphere === 'Крипта') return '💎 Крипта';
  if (sphere === 'Навчання') return '📚 Навчання';
  if (sphere === 'Життя') return '🌿 Життя';
  return sphere ? '📌 ' + escapeTgHtml_(sphere) : '';
}

function formatShortDateDot_(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? (m[3] + '.' + m[2]) : String(ymd || '');
}

function formatTodayBadge_(now, tz) {
  const dateDot = Utilities.formatDate(now, tz, 'dd.MM');
  const wd = TG_WEEKDAYS[Utilities.formatDate(now, tz, 'u')] || '';
  return wd ? dateDot + ' (' + wd + ')' : dateDot;
}

function extractChecklistSummary_(notes) {
  const lines = String(notes || '').split(/\r?\n/);
  let total = 0;
  let done = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^-\s*\[[xX]\]\s+/.test(trimmed)) {
      total++;
      done++;
    } else if (/^-\s*\[\s\]\s+/.test(trimmed)) {
      total++;
    }
  }
  return total > 0 ? ' · ✓ ' + done + '/' + total : '';
}

function sortTasksForBriefing_(a, b) {
  const pa = TG_PRIO_WEIGHT[a.priority] !== undefined ? TG_PRIO_WEIGHT[a.priority] : 1;
  const pb = TG_PRIO_WEIGHT[b.priority] !== undefined ? TG_PRIO_WEIGHT[b.priority] : 1;
  if (pa !== pb) return pa - pb;
  if (a.time && b.time) return a.time.localeCompare(b.time);
  if (a.time) return -1;
  if (b.time) return 1;
  return String(a.task || '').localeCompare(String(b.task || ''), 'uk');
}

function formatRichTaskLine_(t, includeDate) {
  const dot = tgPriorityDot_(t.priority);
  const pin = String(t.notes || '').indexOf('[pin]') !== -1 ? '📌 ' : '';
  const timePart = t.time ? ' <code>' + escapeTgHtml_(t.time) + '</code>' : '';
  const sphere = tgSphereTag_(t.sphere);
  const spherePart = sphere ? ' · ' + sphere : '';
  const datePart = includeDate && t.deadline ? ' · 📅 ' + escapeTgHtml_(formatShortDateDot_(t.deadline)) : '';
  const chkPart = extractChecklistSummary_(t.notes);
  return dot + ' ' + pin + '<b>' + escapeTgHtml_(t.task) + '</b>' + timePart + spherePart + datePart + chkPart;
}

function buildWebAppMarkup_(chatId, rows) {
  const isGroup = String(chatId || '').indexOf('-') === 0;
  const inlineKeyboard = rows.map(function(row) {
    return row.map(function(btn) {
      const targetUrl = btn.view && btn.view !== 'board'
        ? PWA_PUBLIC_URL + '?view=' + encodeURIComponent(btn.view)
        : PWA_PUBLIC_URL;
      return isGroup
        ? { text: btn.text, url: targetUrl }
        : { text: btn.text, web_app: { url: targetUrl } };
    });
  });
  return { inline_keyboard: inlineKeyboard };
}

function setTelegramMenuButton_(token) {
  const cleanToken = sanitizeTgToken_(token);
  if (!cleanToken) return;
  const url = 'https://api.telegram.org/bot' + cleanToken + '/setChatMenuButton';
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      menu_button: {
        type: 'web_app',
        text: 'Задачі',
        web_app: { url: PWA_PUBLIC_URL }
      }
    }),
    muteHttpExceptions: true
  });
}

function sendTelegramHtml_(token, chatId, htmlText, replyMarkupOpt) {
  const cleanToken = sanitizeTgToken_(token);
  if (!cleanToken) throw new Error('Некоректний формат токена Telegram-бота');
  const url = 'https://api.telegram.org/bot' + cleanToken + '/sendMessage';
  const body = {
    chat_id: String(chatId),
    text: htmlText,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkupOpt) body.reply_markup = replyMarkupOpt;

  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  let parsed = null;
  try { parsed = JSON.parse(resp.getContentText()); } catch (_) {}
  if (code < 200 || code >= 300 || !parsed || !parsed.ok) {
    const desc = (parsed && parsed.description) || ('HTTP ' + code);
    throw new Error('Telegram: ' + desc);
  }
  return parsed.result;
}

function detectTelegramChatId_(token) {
  const cleanToken = sanitizeTgToken_(token);
  if (!cleanToken) throw new Error('Некоректний формат токена Telegram-бота');
  const url = 'https://api.telegram.org/bot' + cleanToken + '/getUpdates?limit=25';
  const resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  let parsed = null;
  try { parsed = JSON.parse(resp.getContentText()); } catch (_) {}
  if (!parsed || !parsed.ok) {
    const desc = (parsed && parsed.description) || ('HTTP ' + resp.getResponseCode());
    throw new Error('Telegram: ' + desc);
  }
  const updates = Array.isArray(parsed.result) ? parsed.result : [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i];
    const chat = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat) || (u.callback_query && u.callback_query.message && u.callback_query.message.chat);
    if (chat && chat.id !== undefined) return String(chat.id);
  }
  return '';
}

function clearTelegramTriggers_() {
  const all = ScriptApp.getProjectTriggers();
  for (let i = 0; i < all.length; i++) {
    if (TG_TRIGGER_HANDLERS.indexOf(all[i].getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(all[i]);
    }
  }
}

function setupTelegramTriggers() {
  clearTelegramTriggers_();
  ScriptApp.newTrigger('tgMorningDigest').timeBased().everyDays(1).atHour(8).nearMinute(30).create();
  ScriptApp.newTrigger('tgEveningDigest').timeBased().everyDays(1).atHour(21).nearMinute(0).create();
  ScriptApp.newTrigger('tgCheckDeadlines').timeBased().everyMinutes(15).create();
}

function readJournalSafe_(ss) {
  try {
    return readJournalPayload_(ss);
  } catch (_) {
    return { habits: [], entries: {} };
  }
}

function buildWelcomeMessage_(ss) {
  let active = 0;
  let done = 0;
  let focus = 0;
  try {
    const tasks = readTasks_(getTasksSheet_(ss));
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].done) done++;
      else {
        active++;
        if (tasks[i].status === 'Фокус') focus++;
      }
    }
  } catch (_) {}

  const lines = [
    '⚡ <b>Задачі PRO · Cockpit підключено</b>',
    '',
    '<blockquote>📡 <b>Розклад автопілота</b>\n08:30 — ранковий брифінг дня\nкожні 15 хв — контроль дедлайнів\n21:00 — вечірній підсумок і звички</blockquote>',
    '',
    '📊 <b>Дошка зараз:</b> у Фокусі <b>' + focus + '</b> · активних <b>' + active + '</b>',
    tgProgressBar_(done, done + active),
    '',
    '👇 <i>Відкривай трекер у вікні Telegram через кнопку нижче або меню «Задачі».</i>'
  ];
  return lines.join('\n');
}

function handleSaveTelegramConfig_(payload) {
  const props = PropertiesService.getScriptProperties();
  const prev = getTgConfig_();

  if (payload && payload.enabled === false) {
    props.setProperty(PROP_TG_ENABLED, 'false');
    try { clearTelegramTriggers_(); } catch (_) {}
    return Object.assign(getTelegramStatus_(), { triggersReady: true });
  }

  const rawToken = String((payload && payload.tgBotToken) || '').trim();
  const token = rawToken ? sanitizeTgToken_(rawToken) : sanitizeTgToken_(prev.token);
  if (!token) throw new Error('Некоректний токен бота. Скопіюйте токен формату 123456:ABC... з @BotFather');

  const rawChat = String((payload && payload.tgChatId) || '').trim();
  if (rawChat && !/^-?\d+$/.test(rawChat)) {
    throw new Error('Очистіть поле Chat ID (або вкажіть лише цифри) — бот знайде ваш чат сам після /start');
  }

  let chatId = rawChat || (!rawToken || rawToken === prev.token ? prev.chatId : '');
  if (!chatId) chatId = detectTelegramChatId_(token);
  if (!chatId) {
    throw new Error('Натисніть /start у своєму боті в Telegram (або напишіть йому «Привіт») і знову тисніть Підключити.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const welcomeMsg = buildWelcomeMessage_(ss);
  const welcomeMarkup = buildWebAppMarkup_(chatId, [
    [{ text: '🚀 Відкрити Задачі PRO', view: 'board' }],
    [{ text: '🎯 Вкладка «День»', view: 'day' }, { text: '📊 Дашборд', view: 'dashboard' }]
  ]);

  try {
    sendTelegramHtml_(token, chatId, welcomeMsg, welcomeMarkup);
  } catch (err) {
    if (!rawChat && String(err && err.message || '').indexOf('chat not found') !== -1) {
      const freshChatId = detectTelegramChatId_(token);
      if (freshChatId && freshChatId !== chatId) {
        chatId = freshChatId;
        sendTelegramHtml_(token, chatId, welcomeMsg, welcomeMarkup);
      } else {
        throw new Error('Чат не знайдено. Відкрийте саме цього бота в Telegram, натисніть Start і спробуйте ще раз (поле Chat ID лишіть порожнім).');
      }
    } else {
      throw err;
    }
  }

  try { setTelegramMenuButton_(token); } catch (_) {}

  props.setProperty(PROP_TG_TOKEN, token);
  props.setProperty(PROP_TG_CHAT_ID, chatId);
  props.setProperty(PROP_TG_ENABLED, 'true');

  let triggersReady = true;
  try {
    setupTelegramTriggers();
  } catch (_) {
    triggersReady = false;
  }

  return Object.assign(getTelegramStatus_(), { triggersReady: triggersReady });
}

function buildMorningMessage_(ss) {
  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const todayLabel = formatTodayBadge_(now, tz);
  const tasks = readTasks_(getTasksSheet_(ss));
  const doneCount = tasks.filter(function(t) { return t.done; }).length;
  const active = tasks.filter(function(t) { return !t.done; });
  const overdue = active.filter(function(t) { return t.deadline && t.deadline < today; }).sort(sortTasksForBriefing_);
  const todayTasks = active.filter(function(t) { return t.deadline === today; }).sort(sortTasksForBriefing_);
  const focusTasks = active.filter(function(t) { return t.status === 'Фокус' && t.deadline !== today && (!t.deadline || t.deadline > today); }).sort(sortTasksForBriefing_);

  const journal = readJournalSafe_(ss);
  const entry = (journal.entries && journal.entries[today]) || null;
  const activeHabits = (journal.habits || []).filter(function(h) { return h && h.active !== false; });

  const lines = [
    '☀️ <b>Ранковий брифінг · ' + todayLabel + '</b>',
    '',
    '<blockquote>🔥 Прострочені: <b>' + overdue.length + '</b>  |  📅 Сьогодні: <b>' + todayTasks.length + '</b>  |  ⚡ Фокус: <b>' + focusTasks.length + '</b></blockquote>'
  ];

  if (entry && entry.focus) {
    lines.push('\n🎯 <b>Фокус дня</b>\n<blockquote>' + escapeTgHtml_(entry.focus) + '</blockquote>');
  }

  if (overdue.length) {
    const overdueList = overdue.slice(0, 5).map(function(t) { return formatRichTaskLine_(t, true); }).join('\n');
    const extraOver = overdue.length > 5 ? '\n<i>…та ще ' + (overdue.length - 5) + '</i>' : '';
    lines.push('\n🔥 <b>Потребують уваги (' + overdue.length + ')</b>\n<blockquote>' + overdueList + extraOver + '</blockquote>');
  }

  if (todayTasks.length) {
    const todayList = todayTasks.slice(0, 6).map(function(t) { return formatRichTaskLine_(t, false); }).join('\n');
    const extraToday = todayTasks.length > 6 ? '\n<i>…та ще ' + (todayTasks.length - 6) + '</i>' : '';
    lines.push('\n📅 <b>План на сьогодні (' + todayTasks.length + ')</b>\n<blockquote>' + todayList + extraToday + '</blockquote>');
  }

  if (focusTasks.length) {
    const focusList = focusTasks.slice(0, 5).map(function(t) { return formatRichTaskLine_(t, true); }).join('\n');
    const extraFocus = focusTasks.length > 5 ? '\n<i>…та ще ' + (focusTasks.length - 5) + '</i>' : '';
    lines.push('\n⚡ <b>У Фокусі (' + focusTasks.length + ')</b>\n<blockquote>' + focusList + extraFocus + '</blockquote>');
  }

  if (!overdue.length && !todayTasks.length && !focusTasks.length) {
    lines.push('\n✨ <b>Чистий горизонт!</b> Термінових задач на сьогодні немає — гарного продуктивного дня.');
  }

  lines.push('\n📊 <b>Прогрес дошки</b>\n' + tgProgressBar_(doneCount, tasks.length));
  if (activeHabits.length) {
    const doneHabits = entry && Array.isArray(entry.doneHabits) ? entry.doneHabits.length : 0;
    lines.push('🌿 <b>Звички сьогодні:</b> ' + doneHabits + '/' + activeHabits.length);
  }
  return lines.join('\n');
}

function handleTestTelegram_() {
  const cfg = getTgConfig_();
  if (!cfg.token || !cfg.chatId) throw new Error('Спочатку підключіть Telegram-бота');
  try { setTelegramMenuButton_(cfg.token); } catch (_) {}
  const msg = buildMorningMessage_(SpreadsheetApp.getActiveSpreadsheet());
  const markup = buildWebAppMarkup_(cfg.chatId, [
    [{ text: '🚀 Відкрити дошку', view: 'board' }, { text: '🎯 План дня', view: 'day' }]
  ]);
  sendTelegramHtml_(cfg.token, cfg.chatId, msg, markup);
  return { sent: true };
}

function tgMorningDigest() {
  const cfg = getTgConfig_();
  if (!cfg.enabled || !cfg.token || !cfg.chatId) return;
  const msg = buildMorningMessage_(SpreadsheetApp.getActiveSpreadsheet());
  const markup = buildWebAppMarkup_(cfg.chatId, [
    [{ text: '🚀 Відкрити дошку', view: 'board' }, { text: '🎯 План дня', view: 'day' }]
  ]);
  sendTelegramHtml_(cfg.token, cfg.chatId, msg, markup);
}

function tgEveningDigest() {
  const cfg = getTgConfig_();
  if (!cfg.enabled || !cfg.token || !cfg.chatId) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const todayLabel = formatTodayBadge_(now, tz);
  const tasks = readTasks_(getTasksSheet_(ss));
  const doneCount = tasks.filter(function(t) { return t.done; }).length;
  const remaining = tasks.filter(function(t) {
    return !t.done && (t.deadline === today || t.status === 'Фокус' || (t.deadline && t.deadline < today));
  }).sort(sortTasksForBriefing_);

  const journal = readJournalSafe_(ss);
  const entry = (journal.entries && journal.entries[today]) || null;
  const activeHabits = (journal.habits || []).filter(function(h) { return h && h.active !== false; });
  const doneHabits = entry && Array.isArray(entry.doneHabits) ? entry.doneHabits.length : 0;
  const ratingText = entry && entry.rating ? '<b>' + entry.rating + '/10</b>' : '<i>ще не виставлено</i>';

  const lines = [
    '🌙 <b>Вечірній підсумок · ' + todayLabel + '</b>',
    '',
    '📊 <b>Загальний прогрес</b>\n' + tgProgressBar_(doneCount, tasks.length),
    '',
    '<blockquote>🌿 <b>Чекін дня:</b> звички <b>' + doneHabits + '/' + activeHabits.length + '</b> · оцінка ' + ratingText + '</blockquote>'
  ];

  if (remaining.length) {
    const remList = remaining.slice(0, 6).map(function(t) { return formatRichTaskLine_(t, t.deadline !== today); }).join('\n');
    const extraRem = remaining.length > 6 ? '\n<i>…та ще ' + (remaining.length - 6) + '</i>' : '';
    lines.push('\n⏳ <b>Ще лишилось закрити (' + remaining.length + ')</b>\n<blockquote>' + remList + extraRem + '</blockquote>');
  } else {
    lines.push('\n🎉 <b>Усі ключові задачі на сьогодні закрито!</b>');
  }

  lines.push('\n✍️ <i>Зафіксуй перемоги дня та постав оцінку перед сном.</i>');
  const markup = buildWebAppMarkup_(cfg.chatId, [
    [{ text: '🌙 Підсумувати день', view: 'day' }, { text: '🚀 Дошка', view: 'board' }]
  ]);
  sendTelegramHtml_(cfg.token, cfg.chatId, lines.join('\n'), markup);
}

function tgCheckDeadlines() {
  const cfg = getTgConfig_();
  if (!cfg.enabled || !cfg.token || !cfg.chatId) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const nowMin = Number(Utilities.formatDate(now, tz, 'H')) * 60 + Number(Utilities.formatDate(now, tz, 'm'));

  const tasks = readTasks_(getTasksSheet_(ss));
  const cache = CacheService.getScriptCache();
  const alerts = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (t.done || t.deadline !== today || !t.time) continue;
    const parts = t.time.split(':').map(Number);
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;
    const taskMin = parts[0] * 60 + parts[1];
    const diff = taskMin - nowMin;
    if (diff < 0 || diff > 30) continue;

    const dedupeKey = 'TG_DL_' + today + '_' + t.time + '_' + t.task.slice(0, 24);
    if (cache.get(dedupeKey)) continue;
    cache.put(dedupeKey, '1', 21600);

    const etaText = diff <= 1 ? 'зараз!' : ('через ' + diff + ' хв');
    alerts.push(formatRichTaskLine_(t, false) + ' <i>(' + etaText + ')</i>');
  }

  if (alerts.length) {
    const msg = '⏰ <b>Скоро дедлайн</b>\n\n<blockquote>' + alerts.join('\n') + '</blockquote>';
    const markup = buildWebAppMarkup_(cfg.chatId, [
      [{ text: '⚡ Відкрити дошку', view: 'board' }, { text: '📅 Календар', view: 'calendar' }]
    ]);
    sendTelegramHtml_(cfg.token, cfg.chatId, msg, markup);
  }
}

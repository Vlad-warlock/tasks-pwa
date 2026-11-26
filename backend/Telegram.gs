/**
 * Telegram-сповіщення з Google Apps Script:
 * - Ранковий звіт (08:30): задачі на сьогодні, Фокус та прострочені
 * - Нагадування про дедлайн (кожні 15 хв): за 15–30 хв до часу задачі (без дублів)
 * - Вечірній підсумок (21:00): виконано / залишилось + нагадування про щоденник
 */

const PROP_TG_TOKEN = 'TG_BOT_TOKEN';
const PROP_TG_CHAT_ID = 'TG_CHAT_ID';
const PROP_TG_ENABLED = 'TG_ENABLED';
const PWA_PUBLIC_URL = 'https://vlad-warlock.github.io/tasks-pwa/';
const TG_TRIGGER_HANDLERS = ['tgMorningDigest', 'tgEveningDigest', 'tgCheckDeadlines'];

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

function sendTelegramHtml_(token, chatId, htmlText) {
  const cleanToken = sanitizeTgToken_(token);
  if (!cleanToken) throw new Error('Некоректний формат токена Telegram-бота');
  const url = 'https://api.telegram.org/bot' + cleanToken + '/sendMessage';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: String(chatId),
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }),
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

  const welcomeMsg = '<b>Задачі PRO підключено</b>\nСюди приходитимуть ранковий звіт (08:30), нагадування за 15–30 хв до дедлайну та вечірній підсумок (21:00).\n\n<a href="' + PWA_PUBLIC_URL + '">Відкрити дошку</a>';
  try {
    sendTelegramHtml_(token, chatId, welcomeMsg);
  } catch (err) {
    if (!rawChat && String(err && err.message || '').indexOf('chat not found') !== -1) {
      const freshChatId = detectTelegramChatId_(token);
      if (freshChatId && freshChatId !== chatId) {
        chatId = freshChatId;
        sendTelegramHtml_(token, chatId, welcomeMsg);
      } else {
        throw new Error('Чат не знайдено. Відкрийте саме цього бота в Telegram, натисніть Start і спробуйте ще раз (поле Chat ID лишіть порожнім).');
      }
    } else {
      throw err;
    }
  }

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

function formatTaskBullet_(t) {
  const timePart = t.time ? escapeTgHtml_(t.time) + ' · ' : '';
  const spherePart = t.sphere ? ' [' + escapeTgHtml_(t.sphere) + ']' : '';
  return '• ' + timePart + escapeTgHtml_(t.task) + spherePart;
}

function buildMorningMessage_(ss) {
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const tasks = readTasks_(getTasksSheet_(ss));
  const active = tasks.filter(function(t) { return !t.done; });
  const overdue = active.filter(function(t) { return t.deadline && t.deadline < today; });
  const todayTasks = active.filter(function(t) { return t.deadline === today; });
  const focusTasks = active.filter(function(t) { return t.status === 'Фокус' && t.deadline !== today && (!t.deadline || t.deadline > today); });

  const lines = ['<b>План на сьогодні · ' + today + '</b>'];
  if (overdue.length) {
    lines.push('\n<b>Прострочені (' + overdue.length + '):</b>');
    overdue.slice(0, 6).forEach(function(t) { lines.push(formatTaskBullet_(t)); });
  }
  if (todayTasks.length) {
    lines.push('\n<b>На сьогодні (' + todayTasks.length + '):</b>');
    todayTasks.slice(0, 8).forEach(function(t) { lines.push(formatTaskBullet_(t)); });
  }
  if (focusTasks.length) {
    lines.push('\n<b>У Фокусі (' + focusTasks.length + '):</b>');
    focusTasks.slice(0, 5).forEach(function(t) { lines.push(formatTaskBullet_(t)); });
  }
  if (!overdue.length && !todayTasks.length && !focusTasks.length) {
    lines.push('\nАктивних справ на сьогодні немає. Гарного дня!');
  }
  lines.push('\n<a href="' + PWA_PUBLIC_URL + '">Відкрити Задачі PRO</a>');
  return lines.join('\n');
}

function handleTestTelegram_() {
  const cfg = getTgConfig_();
  if (!cfg.token || !cfg.chatId) throw new Error('Спочатку підключіть Telegram-бота');
  const msg = buildMorningMessage_(SpreadsheetApp.getActiveSpreadsheet());
  sendTelegramHtml_(cfg.token, cfg.chatId, msg);
  return { sent: true };
}

function tgMorningDigest() {
  const cfg = getTgConfig_();
  if (!cfg.enabled || !cfg.token || !cfg.chatId) return;
  const msg = buildMorningMessage_(SpreadsheetApp.getActiveSpreadsheet());
  sendTelegramHtml_(cfg.token, cfg.chatId, msg);
}

function tgEveningDigest() {
  const cfg = getTgConfig_();
  if (!cfg.enabled || !cfg.token || !cfg.chatId) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const tasks = readTasks_(getTasksSheet_(ss));
  const doneCount = tasks.filter(function(t) { return t.done; }).length;
  const remaining = tasks.filter(function(t) { return !t.done && (t.deadline === today || t.status === 'Фокус' || (t.deadline && t.deadline < today)); });

  const lines = ['<b>Вечірній підсумок · ' + today + '</b>'];
  lines.push('Виконано на дошці: <b>' + doneCount + '</b>');
  if (remaining.length) {
    lines.push('\n<b>Ще лишилось (' + remaining.length + '):</b>');
    remaining.slice(0, 6).forEach(function(t) { lines.push(formatTaskBullet_(t)); });
  } else {
    lines.push('\nУсі задачі на сьогодні закрито!');
  }
  lines.push('\nНе забудь відмітити звички й оцінити день 1–10.\n<a href="' + PWA_PUBLIC_URL + '">Відкрити вкладку «День»</a>');
  sendTelegramHtml_(cfg.token, cfg.chatId, lines.join('\n'));
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
    alerts.push(formatTaskBullet_(t));
  }

  if (alerts.length) {
    sendTelegramHtml_(
      cfg.token,
      cfg.chatId,
      '<b>Скоро дедлайн</b>\n' + alerts.join('\n') + '\n\n<a href="' + PWA_PUBLIC_URL + '">Відкрити дошку</a>'
    );
  }
}

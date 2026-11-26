import { apiPost } from './api.js';
import { audioFx } from './fx.js';
import { showToast } from './ui.js';

const $ = (id) => document.getElementById(id);

export function syncTelegramUi(state) {
  const tg = state.telegram || { hasToken: false, chatId: '', enabled: false };
  const badge = $('tgStatusBadge');
  if (badge) {
    badge.textContent = tg.enabled ? 'Увімкнено ✓' : tg.hasToken ? 'Вимкнено' : 'Не налаштовано';
    badge.classList.toggle('is-ok', Boolean(tg.enabled));
  }

  const tokenInp = $('fieldTgToken');
  if (tokenInp) {
    tokenInp.value = '';
    tokenInp.placeholder = tg.hasToken ? 'Токен збережено (новий — для заміни)' : '123456:ABC... (від @BotFather)';
  }
  const chatInp = $('fieldTgChatId');
  if (chatInp && tg.chatId) chatInp.value = tg.chatId;

  const testBtn = $('btnTestTg');
  if (testBtn) testBtn.hidden = !tg.enabled;
  const disBtn = $('btnDisableTg');
  if (disBtn) disBtn.hidden = !tg.enabled;
}

export function initTelegramSettings(ctx) {
  const { state, saveCache, ensureConfigured } = ctx;

  $('btnSaveTg')?.addEventListener('click', async () => {
    if (!ensureConfigured()) return;
    const tgBotToken = ($('fieldTgToken')?.value || '').trim();
    const tgChatId = ($('fieldTgChatId')?.value || '').trim();
    const btn = $('btnSaveTg');
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await apiPost(state.config, { action: 'saveTelegramConfig', tgBotToken, tgChatId, enabled: true });
      state.telegram = { hasToken: Boolean(res.hasToken), chatId: res.chatId || '', enabled: Boolean(res.enabled) };
      saveCache();
      syncTelegramUi(state);
      audioFx.playSuccess();
      if (res.triggersReady === false) {
        showToast('Бота підключено! Для розкладу запустіть «Увімкнути тригери Telegram» у таблиці.', 'success');
      } else {
        showToast('Telegram-бота підключено (08:30, дедлайни, 21:00)', 'success');
      }
    } catch (err) {
      showToast(err?.message || 'Не вдалося підключити Telegram', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Підключити';
    }
  });

  $('btnTestTg')?.addEventListener('click', async () => {
    if (!ensureConfigured()) return;
    const btn = $('btnTestTg');
    btn.disabled = true;
    try {
      await apiPost(state.config, { action: 'testTelegram' });
      audioFx.playClick();
      showToast('Тестовий звіт надіслано в Telegram', 'success');
    } catch (err) {
      showToast(err?.message || 'Не вдалося надіслати тест', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('btnDisableTg')?.addEventListener('click', async () => {
    if (!ensureConfigured()) return;
    const btn = $('btnDisableTg');
    btn.disabled = true;
    try {
      const res = await apiPost(state.config, { action: 'saveTelegramConfig', enabled: false });
      state.telegram = { hasToken: Boolean(res.hasToken), chatId: res.chatId || '', enabled: Boolean(res.enabled) };
      saveCache();
      syncTelegramUi(state);
      audioFx.playClick();
      showToast('Telegram-сповіщення вимкнено');
    } catch (err) {
      showToast(err?.message || 'Не вдалося вимкнути Telegram', 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

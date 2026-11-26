import { STATUS_COLUMNS, SPHERES, escapeHtml, safeSheetUrl } from './utils.js';
import { audioFx } from './fx.js';

const $ = (id) => document.getElementById(id);
let lastScrolledStatus = null;

export function isMobileViewport() {
  return window.innerWidth <= 720;
}

function getActiveFilterChips(state) {
  const chips = [];
  if (state.quickFilter === 'today') chips.push({ key: 'quick', label: 'Сьогодні' });
  else if (state.quickFilter === 'overdue') chips.push({ key: 'quick', label: 'Прострочені', isDanger: true });
  if (state.activeSphere !== 'Усі') chips.push({ key: 'sphere', label: state.activeSphere });
  if (state.activePriority !== 'Усі') chips.push({ key: 'priority', label: `Пріоритет: ${state.activePriority}` });
  if (state.activeTag) chips.push({ key: 'tag', label: state.activeTag });
  if (state.searchQuery) chips.push({ key: 'search', label: `“${state.searchQuery}”` });
  return chips;
}

function syncFilterSheet(state, stats) {
  const searchInp = $('mobileFieldSearch');
  if (searchInp && document.activeElement !== searchInp) searchInp.value = state.searchQuery || '';
  const clearSearch = $('btnMobileClearSearch');
  if (clearSearch) clearSearch.hidden = !state.searchQuery;

  const setText = (id, val) => { const el = $(id); if (el) el.textContent = String(val); };
  setText('mStatAll', stats.activeCount);
  setText('mStatToday', stats.todayCount);
  setText('mStatOverdue', stats.overdueCount);

  for (const sp of SPHERES) {
    const badge = document.querySelector(`[data-m-sphere-count="${sp}"]`);
    if (badge) badge.textContent = String(stats.sphereCounts[sp] ?? 0);
  }

  document.querySelectorAll('#mobileQuickPills [data-quick]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.quick === state.quickFilter);
  });
  document.querySelectorAll('#mobileSpherePills [data-m-sphere]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mSphere === state.activeSphere);
  });
  document.querySelectorAll('#mobilePrioPills [data-m-prio]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mPrio === state.activePriority);
  });

  const tagRow = $('mobileTagFilterRow');
  if (tagRow) {
    tagRow.hidden = !state.activeTag;
    if (state.activeTag) setText('mobileTagFilterLabel', state.activeTag);
  }

  const applyBtn = $('btnMobileApplyFilters');
  if (applyBtn) applyBtn.textContent = `Показати (${stats.filteredCount})`;
}

export function syncMobileChrome(state, stats) {
  document.querySelectorAll('#mobileTabBar [data-view]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === state.activeView);
  });
  const tabDot = $('tabbarOverdueDot');
  if (tabDot) tabDot.hidden = stats.overdueCount === 0;

  const showFilterCtrl = state.activeView === 'board' || state.activeView === 'calendar';
  const filterBtn = $('btnMobileFilters');
  if (filterBtn) filterBtn.hidden = !showFilterCtrl;

  const chips = getActiveFilterChips(state);
  const filterBadge = $('mobileFilterBadge');
  if (filterBadge) {
    filterBadge.hidden = chips.length === 0;
    filterBadge.textContent = String(chips.length);
  }
  const overdueDot = $('mobileOverdueDot');
  if (overdueDot) overdueDot.hidden = !(stats.overdueCount > 0 && chips.length === 0);

  const bar = $('mobileActiveFilters');
  if (bar) {
    bar.hidden = !showFilterCtrl || chips.length === 0;
    if (!bar.hidden) {
      bar.innerHTML = chips.map((c) => `
        <button type="button" class="maf-chip${c.isDanger ? ' is-danger' : ''}" data-clear-filter="${c.key}">
          <span>${escapeHtml(c.label)}</span>
          <span aria-hidden="true">&times;</span>
        </button>`).join('') + (chips.length > 1 ? '<button type="button" class="maf-reset" data-clear-filter="all">Скинути</button>' : '');
    } else {
      bar.innerHTML = '';
    }
  }

  const sheetMobile = $('btnOpenSheetMobile');
  const sheetHref = safeSheetUrl(state.config.sheetUrl);
  if (sheetMobile) {
    sheetMobile.hidden = !sheetHref;
    if (sheetHref) sheetMobile.href = sheetHref;
  }

  syncFilterSheet(state, stats);

  if (isMobileViewport() && state.activeView === 'board' && lastScrolledStatus !== state.activeStatus) {
    lastScrolledStatus = state.activeStatus;
    const activeTab = document.querySelector(`#statusTabs .status-tab[data-status="${CSS.escape(state.activeStatus)}"]`);
    activeTab?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }
}

function clearFilterKey(state, key) {
  if (key === 'quick' || key === 'all') state.quickFilter = 'all';
  if (key === 'sphere' || key === 'all') state.activeSphere = 'Усі';
  if (key === 'priority' || key === 'all') {
    state.activePriority = 'Усі';
    const sel = $('filterPriority');
    if (sel) sel.value = 'Усі';
  }
  if (key === 'tag' || key === 'all') state.activeTag = '';
  if (key === 'search' || key === 'all') {
    state.searchQuery = '';
    const deskSearch = $('fieldSearch');
    if (deskSearch) deskSearch.value = '';
    const mobSearch = $('mobileFieldSearch');
    if (mobSearch) mobSearch.value = '';
  }
}

export function initMobileUx({ state, render, dayCtrl, openModal, closeModal }) {
  $('mobileTabBar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn || state.activeView === btn.dataset.view) return;
    dayCtrl.flush();
    audioFx.playClick();
    state.activeView = btn.dataset.view;
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  });

  $('btnMobileFilters')?.addEventListener('click', () => {
    audioFx.playClick();
    openModal('filterModal');
  });

  $('mobileActiveFilters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clear-filter]');
    if (!btn) return;
    audioFx.playClick();
    clearFilterKey(state, btn.dataset.clearFilter);
    render();
  });

  $('mobileFieldSearch')?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    const deskSearch = $('fieldSearch');
    if (deskSearch) deskSearch.value = e.target.value;
    render();
  });

  $('btnMobileClearSearch')?.addEventListener('click', () => {
    clearFilterKey(state, 'search');
    render();
    $('mobileFieldSearch')?.focus();
  });

  $('mobileQuickPills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick]');
    if (!btn) return;
    audioFx.playClick();
    state.quickFilter = btn.dataset.quick;
    render();
  });

  $('mobileSpherePills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-m-sphere]');
    if (!btn) return;
    audioFx.playClick();
    state.activeSphere = btn.dataset.mSphere;
    render();
  });

  $('mobilePrioPills')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-m-prio]');
    if (!btn) return;
    audioFx.playClick();
    state.activePriority = btn.dataset.mPrio;
    const sel = $('filterPriority');
    if (sel) sel.value = state.activePriority;
    render();
  });

  $('btnMobileClearTag')?.addEventListener('click', () => {
    audioFx.playClick();
    state.activeTag = '';
    render();
  });

  $('btnMobileResetFilters')?.addEventListener('click', () => {
    audioFx.playClick();
    clearFilterKey(state, 'all');
    render();
  });

  $('btnMobileApplyFilters')?.addEventListener('click', () => {
    audioFx.playClick();
    closeModal('filterModal');
  });

  const board = $('board');
  let touchStart = null;

  board?.addEventListener('touchstart', (e) => {
    if (!isMobileViewport() || state.activeView !== 'board' || e.touches.length !== 1) {
      touchStart = null;
      return;
    }
    if (e.target.closest('input, textarea, select, [data-no-swipe], .habit-matrix-wrap, .dash-table-wrap')) {
      touchStart = null;
      return;
    }
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, { passive: true });

  board?.addEventListener('touchend', (e) => {
    if (!touchStart || !isMobileViewport() || state.activeView !== 'board' || e.changedTouches.length !== 1) {
      touchStart = null;
      return;
    }
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const dt = Date.now() - touchStart.time;
    touchStart = null;

    if (dt > 550 || Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.45) return;
    const idx = STATUS_COLUMNS.indexOf(state.activeStatus);
    if (idx === -1) return;
    const nextIdx = dx < 0 ? idx + 1 : idx - 1;
    if (nextIdx < 0 || nextIdx >= STATUS_COLUMNS.length) return;
    state.activeStatus = STATUS_COLUMNS[nextIdx];
    audioFx.playClick();
    render();
  }, { passive: true });

  board?.addEventListener('toggle', (e) => {
    const det = e.target.closest('.day-collapsible[data-day-section]');
    if (!det || !isMobileViewport()) return;
    state.mobileDayOpen[det.dataset.daySection] = det.open;
  }, true);

  window.matchMedia('(max-width: 720px)').addEventListener('change', () => render());
}

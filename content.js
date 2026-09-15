(() => {
  'use strict';

  const EXTENSION_ID = 'hmjhi';
  const TABLE_HEADER = '有效月活及评分';
  const DETAIL_TITLE = '有效活跃及评分明细数据';
  const APP_ID_PATTERN = /^C\d{19}$/;
  const STORAGE_KEY = 'hmjhi-daily-mau-history-v1';
  const GOAL_MAU = 400;
  const personalConfig = globalThis.HMJHI_PERSONAL_CONFIG ?? {};
  const PRIORITY_APP_IDS = Array.isArray(personalConfig.priorityAppIds)
    ? personalConfig.priorityAppIds
    : [];
  const processedTables = new WeakSet();
  let collecting = false;
  let observerTimer = 0;

  const SEEDED_HISTORY = Array.isArray(personalConfig.seededHistory)
    ? personalConfig.seededHistory
    : [];

  const sleep = (milliseconds) => new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });

  async function waitFor(getValue, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = getValue();
      if (value) {
        return value;
      }
      await sleep(40);
    }
    throw new Error('等待详情弹窗超时');
  }

  function findDataTable() {
    return Array.from(document.querySelectorAll('table')).find((table) => {
      const header = table.querySelector('thead');
      return header?.textContent?.includes(TABLE_HEADER)
        && header.textContent.includes('AppID');
    }) ?? null;
  }

  function getDataRows(table) {
    return Array.from(table.querySelectorAll('tbody > tr')).filter((row) => {
      const cells = row.querySelectorAll(':scope > td');
      const appId = cells[1]?.textContent?.trim() ?? '';
      return cells.length >= 3 && APP_ID_PATTERN.test(appId);
    });
  }

  function getNativeStatus(row) {
    return row.querySelector(':scope > td:nth-child(3) a.link-btn')?.textContent?.trim() ?? '';
  }

  function prioritizeRows(table) {
    const tbody = table.querySelector('tbody');
    if (!tbody) {
      return;
    }
    const rows = getDataRows(table);
    const priorityRank = new Map(PRIORITY_APP_IDS.map((appId, index) => [appId, index]));
    rows
      .map((row, originalIndex) => {
        const appId = row.querySelector(':scope > td:nth-child(2)')?.textContent?.trim() ?? '';
        const status = getNativeStatus(row);
        return {
          row,
          originalIndex,
          // “满足”排在后面；未满足或未知状态视为待处理项，排在前面。
          statusRank: status === '满足' ? 1 : 0,
          priorityRank: priorityRank.get(appId) ?? Number.MAX_SAFE_INTEGER
        };
      })
      .sort((left, right) => (
        left.statusRank - right.statusRank
        || left.priorityRank - right.priorityRank
        || left.originalIndex - right.originalIndex
      ))
      .forEach(({ row }) => tbody.appendChild(row));
  }

  function getSnapshotDate() {
    const match = document.body.innerText.match(/数据统计截至\s*(\d{4}-\d{2}-\d{2})/);
    return match?.[1] ?? null;
  }

  function dispatchClick(element) {
    element.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  }

  function findDetailModal() {
    return Array.from(document.querySelectorAll('.common-modal:not(.hidden) .common-modal-main')).find((modal) => (
      modal.textContent?.includes(DETAIL_TITLE)
    )) ?? null;
  }

  async function closeDetailModal(modal) {
    const closeButton = modal.querySelector('.close-btn');
    if (closeButton) {
      dispatchClick(closeButton);
    }
    await waitFor(() => (
      !document.contains(modal) || modal.parentElement?.classList.contains('hidden')
    ), 2500).catch(() => true);
  }

  function parseDetailRows(modal) {
    return Array.from(modal.querySelectorAll('tbody > tr')).map((row) => {
      const cells = Array.from(row.querySelectorAll(':scope > td'));
      return {
        month: cells[0]?.textContent?.trim() ?? '',
        mau: cells[1]?.textContent?.trim() ?? '暂无',
        rating: cells[2]?.textContent?.trim() ?? '暂无',
        ratingCount: cells[3]?.textContent?.trim() ?? '暂无'
      };
    }).filter((item) => item.month);
  }

  function isQualifiedMonth(item) {
    return Number(item.mau) >= GOAL_MAU
      && Number(item.rating) > 3
      && Number(item.ratingCount) >= 10;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function renderDetails(cell, details, nativeStatus) {
    cell.querySelector(`.${EXTENSION_ID}-details`)?.remove();

    const container = document.createElement('div');
    container.className = `${EXTENSION_ID}-details`;
    container.setAttribute('aria-label', `${nativeStatus}，有效月活及评分明细`);

    const latestIndex = details.length - 1;
    details.forEach((item, index) => {
      const line = document.createElement('div');
      line.className = [
        `${EXTENSION_ID}-month`,
        index === latestIndex ? 'is-latest' : '',
        isQualifiedMonth(item) ? 'is-qualified-month' : ''
      ].filter(Boolean).join(' ');

      const month = document.createElement('span');
      month.className = `${EXTENSION_ID}-month-label`;
      month.textContent = `${item.month}月`;

      const mau = document.createElement('span');
      mau.className = `${EXTENSION_ID}-mau`;
      mau.innerHTML = `月活 <strong>${escapeHtml(item.mau)}</strong>`;

      const rating = document.createElement('span');
      rating.className = `${EXTENSION_ID}-rating`;
      rating.textContent = item.rating === '暂无'
        ? '评分暂无'
        : `★ ${item.rating}（${item.ratingCount}个）`;

      line.append(month, mau, rating);
      container.appendChild(line);
    });

    const status = document.createElement('div');
    status.className = `${EXTENSION_ID}-native-status`;
    if (nativeStatus === '满足') {
      status.classList.add('is-qualified');
    }
    status.textContent = `页面判定：${nativeStatus}`;
    container.appendChild(status);
    cell.appendChild(container);
  }

  function renderFailure(cell, message) {
    cell.querySelector(`.${EXTENSION_ID}-details`)?.remove();
    const failure = document.createElement('div');
    failure.className = `${EXTENSION_ID}-details ${EXTENSION_ID}-error`;
    failure.textContent = message;
    cell.appendChild(failure);
  }

  function emptyHistoryStore() {
    return { version: 1, apps: {} };
  }

  function readHistoryStore() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : emptyHistoryStore();
      if (!parsed.apps || typeof parsed.apps !== 'object') {
        return emptyHistoryStore();
      }
      return parsed;
    } catch {
      return emptyHistoryStore();
    }
  }

  function writeHistoryStore(store) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // 页面禁用本地存储时仍保留表格增强，不中断读取。
    }
  }

  function upsertHistoryPoint(store, point) {
    const app = store.apps[point.appId] ?? {
      appId: point.appId,
      appName: point.appName,
      months: {}
    };
    app.appName = point.appName;
    const points = Array.isArray(app.months[point.month]) ? app.months[point.month] : [];
    const existingIndex = points.findIndex((item) => item.date === point.date);
    const existing = existingIndex >= 0 ? points[existingIndex] : null;
    const source = point.source ?? 'page';
    if (existing?.source === 'manual' && source !== 'manual') {
      return;
    }
    const normalized = {
      date: point.date,
      mau: Number(point.mau),
      rating: point.rating ?? null,
      ratingCount: point.ratingCount ?? null,
      source
    };
    if (existingIndex >= 0) {
      points[existingIndex] = normalized;
    } else {
      points.push(normalized);
    }
    points.sort((left, right) => left.date.localeCompare(right.date));
    app.months[point.month] = points.slice(-62);
    store.apps[point.appId] = app;
  }

  function seedKnownHistory() {
    const store = readHistoryStore();
    SEEDED_HISTORY.forEach((point) => upsertHistoryPoint(store, point));
    writeHistoryStore(store);
  }

  function cacheDailySnapshot(appName, appId, details) {
    const date = getSnapshotDate();
    if (!date) {
      return;
    }
    const monthKey = date.slice(0, 7);
    const monthNumber = Number(date.slice(5, 7));
    const currentMonth = details.find((item) => Number(item.month) === monthNumber);
    if (!currentMonth || !/^\d+$/.test(currentMonth.mau)) {
      return;
    }

    const store = readHistoryStore();
    upsertHistoryPoint(store, {
      date,
      appName,
      appId,
      month: monthKey,
      mau: Number(currentMonth.mau),
      rating: currentMonth.rating === '暂无' ? null : currentMonth.rating,
      ratingCount: currentMonth.ratingCount === '暂无' ? null : currentMonth.ratingCount,
      source: 'page'
    });
    writeHistoryStore(store);
  }

  function getGoalPlan(monthKey, latestDate, latestMau) {
    const [year, month] = monthKey.split('-').map(Number);
    const totalDays = new Date(year, month, 0).getDate();
    const snapshotInMonth = latestDate.startsWith(`${monthKey}-`);
    const snapshotDay = snapshotInMonth ? Number(latestDate.slice(8, 10)) : totalDays;
    const remainingDays = Math.max(0, totalDays - snapshotDay);
    const remainingMau = Math.max(0, GOAL_MAU - latestMau);
    const dailyNeeded = remainingMau === 0
      ? 0
      : (remainingDays > 0 ? Math.ceil(remainingMau / remainingDays) : null);
    return { remainingDays, remainingMau, dailyNeeded };
  }

  // 只比较相邻自然日，不将上一条记录误当成前一天。
  function dailyDelta(points, point) {
    const previousDay = new Date(`${point.date}T00:00:00Z`);
    if (!Number.isFinite(previousDay.getTime())) return null;
    previousDay.setUTCDate(previousDay.getUTCDate() - 1);
    const previousKey = previousDay.toISOString().slice(0, 10);
    const previous = points.find((item) => item.date === previousKey);
    if (!previous || !Number.isFinite(Number(previous.mau)) || !Number.isFinite(Number(point.mau))) return null;
    return Number(point.mau) - Number(previous.mau);
  }

  function buildTrendSvg(points, gradientId, color) {
    const width = 344;
    const height = 158;
    const padding = { left: 34, right: 18, top: 26, bottom: 28 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const values = points.map((point) => Number(point.mau));
    let minValue = Math.min(...values);
    let maxValue = Math.max(...values);
    if (minValue === maxValue) {
      minValue = Math.max(0, minValue - 1);
      maxValue += 1;
    } else {
      const margin = Math.max(2, Math.round((maxValue - minValue) * 0.12));
      minValue = Math.max(0, minValue - margin);
      maxValue += margin;
    }

    const xFor = (index) => (
      padding.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth)
    );
    const yFor = (value) => (
      padding.top + ((maxValue - value) / (maxValue - minValue)) * plotHeight
    );
    const coordinates = points.map((point, index) => ({
      x: xFor(index),
      y: yFor(Number(point.mau)),
      ...point
    }));
    const path = coordinates.map((point, index) => (
      `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
    )).join(' ');
    const areaPath = `${path} L ${coordinates.at(-1).x.toFixed(1)} ${(padding.top + plotHeight).toFixed(1)} L ${coordinates[0].x.toFixed(1)} ${(padding.top + plotHeight).toFixed(1)} Z`;
    const gridValues = [maxValue, Math.round((maxValue + minValue) / 2), minValue];

    const grid = gridValues.map((value) => {
      const y = yFor(value);
      return `
        <line x1="${padding.left}" y1="${y.toFixed(1)}" x2="${width - padding.right}" y2="${y.toFixed(1)}" class="hmjhi-grid-line" />
        <text x="${padding.left - 7}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="hmjhi-axis-label">${value}</text>
      `;
    }).join('');

    const chartDensityClass = points.length > 20
      ? ' is-very-dense'
      : (points.length > 10 ? ' is-dense' : '');
    const labels = coordinates.map((point, index) => {
      const delta = dailyDelta(points, point);
      const labelOffset = points.length > 14 && index % 2 === 1 ? 15 : 9;
      return `
        <g class="hmjhi-point-group" data-date="${escapeHtml(point.date)}" data-mau="${escapeHtml(String(point.mau))}" data-delta="${delta === null ? '' : delta}">
          <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5" class="hmjhi-chart-point" />
          <text x="${point.x.toFixed(1)}" y="${(point.y - labelOffset).toFixed(1)}" text-anchor="middle" class="hmjhi-point-label">${point.mau}</text>
          <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${Math.min(10, points.length > 1 ? plotWidth / (points.length - 1) / 2 : 10).toFixed(1)}" fill="transparent" pointer-events="all" />
        </g>
      `;
    }).join('');

    return `
      <svg class="hmjhi-chart${chartDensityClass}" viewBox="0 0 ${width} ${height}" aria-label="每日有效月活折线图">
        <defs>
          <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.22" />
            <stop offset="100%" stop-color="${color}" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        ${grid}
        <path d="${areaPath}" class="hmjhi-chart-area" style="fill: url(#${gradientId})" />
        <path d="${path}" class="hmjhi-chart-line" />
        ${labels}
        <text x="${padding.left}" y="${height - 7}" text-anchor="start" class="hmjhi-axis-label">${escapeHtml(points[0].date.slice(5))}</text>
        <text x="${width - padding.right}" y="${height - 7}" text-anchor="end" class="hmjhi-axis-label">${escapeHtml(points.at(-1).date.slice(5))}</text>
      </svg>
    `;
  }

  function buildTrendCard(appId, details, nativeStatus) {
    const store = readHistoryStore();
    const app = store.apps[appId];
    const monthKeys = Object.keys(app?.months ?? {}).sort();
    const currentMonthKey = getSnapshotDate()?.slice(0, 7);
    const monthKey = monthKeys.includes(currentMonthKey)
      ? currentMonthKey
      : monthKeys.at(-1);
    const points = monthKey ? app.months[monthKey] : [];

    const qualifiedMonth = details.find(isQualifiedMonth) ?? null;
    const isQualified = nativeStatus === '满足';

    if (!points?.length) {
      return {
        isQualified,
        markup: '<div class="hmjhi-empty-trend">今天尚未形成可缓存的数据。</div>'
      };
    }

    const latest = points.at(-1);
    const goalPlan = getGoalPlan(monthKey, latest.date, latest.mau);
    const dailyNeededLabel = goalPlan.dailyNeeded === null
      ? '已截止'
      : `${goalPlan.dailyNeeded}/天`;
    const gradientId = `${EXTENSION_ID}-area-${appId.slice(-8)}`;
    const metrics = isQualified && qualifiedMonth
      ? `
        <div><span>激励状态</span><strong class="hmjhi-qualified-value">已达标</strong></div>
        <div><span>达标月份</span><strong>${qualifiedMonth.month}月</strong></div>
        <div><span>达标月活</span><strong>${qualifiedMonth.mau}</strong></div>
        <div><span>月末评分</span><strong>${qualifiedMonth.rating}</strong></div>
      `
      : `
        <div><span>最新月活</span><strong>${latest.mau}</strong></div>
        <div><span>距 400</span><strong>${goalPlan.remainingMau}</strong></div>
        <div><span>剩余天数</span><strong>${goalPlan.remainingDays}天</strong></div>
        <div><span>每天需增</span><strong class="hmjhi-daily-target">${dailyNeededLabel}</strong></div>
      `;
    return {
      isQualified,
      markup: `
        <div class="hmjhi-trend-metrics">${metrics}</div>
        ${buildTrendSvg(points, gradientId, isQualified ? '#0b9b6c' : '#0a59f7')}
      `
    };
  }

  function ensureTrendHeader(table) {
    const headerRow = table.querySelector('thead > tr');
    if (!headerRow || headerRow.querySelector(`.${EXTENSION_ID}-trend-header`)) {
      return;
    }
    const referenceHeader = headerRow.querySelector(':scope > th:nth-child(3)');
    const header = referenceHeader?.cloneNode(true) ?? document.createElement('th');
    header.className = `${EXTENSION_ID}-trend-header`;
    header.setAttribute('width', '400');
    header.querySelector('.tips-icon')?.remove();
    const label = header.querySelector('.t-cell > span');
    if (label) {
      label.textContent = '本月每日趋势';
    } else {
      header.innerHTML = '<div class="t-cell"><span>本月每日趋势</span></div>';
    }
    headerRow.appendChild(header);
  }

  function renderInlineTrend(row, appId, details, nativeStatus) {
    let cell = row.querySelector(`:scope > .${EXTENSION_ID}-trend-cell`);
    if (!cell) {
      cell = document.createElement('td');
      cell.className = `${EXTENSION_ID}-trend-cell`;
      row.appendChild(cell);
    }
    const card = buildTrendCard(appId, details, nativeStatus);
    cell.innerHTML = `<section class="${EXTENSION_ID}-inline-trend-card${card.isQualified ? ' is-qualified' : ''}">${card.markup}</section>`;
  }

  async function collectRow(row) {
    const cells = row.querySelectorAll(':scope > td');
    const appName = cells[0]?.textContent?.trim() ?? '未知应用';
    const appId = cells[1]?.textContent?.trim() ?? '';
    const statusCell = cells[2];
    const trigger = statusCell?.querySelector('a.link-btn');
    if (!statusCell || !trigger) {
      throw new Error('未找到详情入口');
    }

    const nativeStatus = trigger.textContent?.trim() || '未知';
    trigger.classList.add(`${EXTENSION_ID}-native-trigger`);

    const existingModal = findDetailModal();
    if (existingModal) {
      await closeDetailModal(existingModal);
    }

    dispatchClick(trigger);
    const modal = await waitFor(findDetailModal);
    const details = parseDetailRows(modal);
    await closeDetailModal(modal);

    if (!details.length) {
      throw new Error('详情中没有月份数据');
    }
    renderDetails(statusCell, details, nativeStatus);
    cacheDailySnapshot(appName, appId, details);
    renderInlineTrend(row, appId, details, nativeStatus);
  }

  async function collect(table, force = false) {
    if (collecting) {
      return;
    }
    if (!force && processedTables.has(table)) {
      return;
    }

    collecting = true;
    processedTables.add(table);
    table.classList.add(`${EXTENSION_ID}-data-table`);
    ensureTrendHeader(table);
    prioritizeRows(table);
    const rows = getDataRows(table);
    const thirdHeader = table.querySelector('thead th:nth-child(3)');
    if (thirdHeader) {
      thirdHeader.style.width = '300px';
    }

    document.body.classList.add(`${EXTENSION_ID}-collecting`);
    for (const row of rows) {
      const cells = row.querySelectorAll(':scope > td');
      try {
        await collectRow(row);
      } catch (error) {
        renderFailure(cells[2], error instanceof Error ? error.message : '读取失败');
      }
      await sleep(60);
    }
    document.body.classList.remove(`${EXTENSION_ID}-collecting`);
    collecting = false;
  }

  function scheduleCollection() {
    window.clearTimeout(observerTimer);
    observerTimer = window.setTimeout(() => {
      const table = findDataTable();
      if (table) {
        const hasUnprocessedRows = getDataRows(table).some((row) => (
          !row.querySelector(`.${EXTENSION_ID}-details`)
        ));
        collect(table, hasUnprocessedRows);
      }
    }, 250);
  }

  function installTrendTooltip() {
    document.getElementById(`${EXTENSION_ID}-trend-tooltip`)?.remove();
    const tooltip = document.createElement('div');
    tooltip.id = `${EXTENSION_ID}-trend-tooltip`;
    tooltip.className = 'hmjhi-hover-tooltip';
    tooltip.hidden = true;
    tooltip.setAttribute('role', 'tooltip');
    const date = document.createElement('div');
    date.className = 'hmjhi-hover-date';
    const metric = document.createElement('div');
    metric.className = 'hmjhi-hover-metric';
    const label = document.createElement('span');
    label.textContent = '有效月活';
    const value = document.createElement('strong');
    metric.append(label, value);
    const change = document.createElement('div');
    change.className = 'hmjhi-hover-metric hmjhi-hover-change';
    const changeLabel = document.createElement('span');
    changeLabel.textContent = '较前一天';
    const changeValue = document.createElement('strong');
    change.append(changeLabel, changeValue);
    tooltip.append(date, metric, change);
    document.body.append(tooltip);
    let activePoint = null;
    const hide = () => { tooltip.hidden = true; activePoint = null; };
    document.addEventListener('pointermove', (event) => {
      const point = event.target instanceof Element
        ? event.target.closest('.hmjhi-point-group') : null;
      if (!point) { hide(); return; }
      if (activePoint !== point) {
        activePoint = point;
        const [year, month, day] = point.dataset.date.split('-');
        date.textContent = `${year}年${Number(month)}月${Number(day)}日`;
        value.textContent = point.dataset.mau;
        const delta = point.dataset.delta;
        changeValue.textContent = delta === '' || delta === undefined
          ? '暂无' : (Number(delta) > 0 ? `+${delta}` : delta);
        tooltip.classList.toggle('is-qualified', Boolean(point.closest('.is-qualified')));
      }
      tooltip.hidden = false;
      const bounds = tooltip.getBoundingClientRect();
      // 优先显示在指针右下方，临近视口边缘时翻转并保留边距。
      const left = event.clientX + 12 + bounds.width > window.innerWidth - 8
        ? event.clientX - bounds.width - 12 : event.clientX + 12;
      const top = event.clientY + 12 + bounds.height > window.innerHeight - 8
        ? event.clientY - bounds.height - 12 : event.clientY + 12;
      tooltip.style.left = `${Math.max(8, left)}px`;
      tooltip.style.top = `${Math.max(8, top)}px`;
    });
    document.addEventListener('pointerout', (event) => {
      if (!event.relatedTarget) hide();
    });
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('resize', hide);
  }

  seedKnownHistory();
  installTrendTooltip();
  const observer = new MutationObserver(scheduleCollection);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleCollection();
})();

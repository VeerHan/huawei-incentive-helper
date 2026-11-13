const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const storageKey = 'hmjhi-daily-mau-history-v2';
const appId = 'C0000000000000000001';
const oldPoint = { date: '2026-11-11', mau: 185, source: 'page' };

function loadSnapshot(point = oldPoint) {
  const initial = { version: 2, profiles: {
    liang: { apps: { [appId]: { appName: '测试应用', months: { '2026-11': [point] } } } },
    legacy: { apps: { retained: { months: {} } } }
  } };
  const values = new Map([[storageKey, JSON.stringify(initial)]]);
  const context = {
    window: { localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value)
    } },
    document: { body: { innerText: '数据统计截至 2026-11-12 23:59' } }
  };
  const root = path.join(__dirname, '..');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'history-store.js'), 'utf8'), context);
  // 只跳过页面启动，在隔离存储中执行实际的采集与趋势渲染函数。
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const startup = source.lastIndexOf('  installTrendTooltip();');
  assert.ok(startup > 0);
  vm.runInNewContext(source.slice(0, startup) + `
    activeProfileId = 'liang';
    globalThis.snapshot = { cacheDailySnapshot, buildTrendCard, detailMonthKey };
  })();`, context);
  return { ...context.snapshot, read: () => JSON.parse(values.get(storageKey)), context, initial };
}

test('新网页年月格式正常缓存昨天数据并更新图表和测算，保留历史及其他档案', () => {
  const snapshot = loadSnapshot();
  const details = [
    { month: '2026/10', mau: '59' },
    { month: '2026/11', mau: '212', rating: '暂无', ratingCount: '暂无' }
  ];
  snapshot.cacheDailySnapshot('测试应用', appId, details);
  snapshot.cacheDailySnapshot('测试应用', appId, details);
  const store = snapshot.read();
  const points = store.profiles.liang.apps[appId].months['2026-11'];
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], oldPoint);
  assert.equal(points[1].date, '2026-11-12');
  assert.equal(points[1].mau, 212);
  assert.equal(points[1].source, 'page');
  assert.deepEqual(store.profiles.legacy, snapshot.initial.profiles.legacy);
  const { markup } = snapshot.buildTrendCard(appId, details, '暂不满足');
  assert.match(markup, /data-date="2026-11-12" data-mau="212" data-delta="27"/);
  assert.match(markup, /本月剩余天数<\/span><strong>18天/);
  assert.match(markup, /本月有效月活<\/span><strong>212/);
  assert.match(markup, /距400月活还差<\/span><strong>188/);
  assert.match(markup, /日均还需新增<\/span><strong class="hmjhi-daily-target">10.4\/天/);
});

test('兼容旧月份格式和带年月的月份，不接受无效月份', () => {
  const snapshot = loadSnapshot();
  for (const value of ['11', '11月', '2026/11', '2026-11', '2026年11月']) {
    assert.equal(snapshot.detailMonthKey(value, '2026'), '2026-11');
    snapshot.cacheDailySnapshot('测试应用', appId, [{ month: value, mau: '212' }]);
    assert.equal(snapshot.read().profiles.liang.apps[appId].months['2026-11'].at(-1).mau, 212);
  }
  for (const value of ['暂无', '2026/13', '0', '2026/11/12']) {
    assert.equal(snapshot.detailMonthKey(value, '2026'), null);
  }
});

test('相同月份不同年份不混写，缺少当前月或数值时不写入', () => {
  const snapshot = loadSnapshot();
  for (const details of [
    [{ month: '2025/11', mau: '999' }],
    [{ month: '2026/10', mau: '59' }],
    [{ month: '2026/11', mau: '暂无' }]
  ]) {
    snapshot.cacheDailySnapshot('测试应用', appId, details);
    assert.deepEqual(snapshot.read(), snapshot.initial);
  }
  snapshot.context.document.body.innerText = '数据统计截至 2027-01-02 23:59';
  snapshot.cacheDailySnapshot('测试应用', appId, [
    { month: '2026/01', mau: '999' }, { month: '2027/01', mau: '12' }
  ]);
  assert.equal(snapshot.read().profiles.liang.apps[appId].months['2027-01'][0].mau, 12);
});

test('页面采集仍保留手动锁定值', () => {
  const manual = { date: '2026-11-12', mau: 210, source: 'manual' };
  const snapshot = loadSnapshot(manual);
  snapshot.cacheDailySnapshot('测试应用', appId, [{ month: '2026/11', mau: '212' }]);
  assert.deepEqual(snapshot.read().profiles.liang.apps[appId].months['2026-11'], [manual]);
});

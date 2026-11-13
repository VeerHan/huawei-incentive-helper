const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function loadHistory() {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'history-store.js'), 'utf8'), context);
  return context.HMJHI_HISTORY;
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

const appId = (number) => `C${String(number).padStart(19, '0')}`;
const originalApps = Array.from({ length: 8 }, (_, index) => appId(index + 1));
const transferredApps = [appId(9), appId(10)];

test('旧版历史复制到内部档案，旧键保持不变', () => {
  const history = loadHistory();
  const old = JSON.stringify({ version: 1, apps: { [originalApps[0]]: { months: { '2026-10': [{ date: '2026-10-31', mau: 59 }] } } } });
  const storage = memoryStorage({ 'hmjhi-daily-mau-history-v1': old });
  const migrated = history.readStore(storage);
  assert.equal(migrated.profiles.legacy.apps[originalApps[0]].months['2026-10'][0].mau, 59);
  assert.equal(storage.getItem('hmjhi-daily-mau-history-v1'), old);
  assert.equal(history.readStore(storage).profiles.legacy.apps[originalApps[0]].months['2026-10'].length, 1);
});

test('本机两个账号的应用集合分别匹配各自历史', () => {
  const history = loadHistory();
  const oldApps = Object.fromEntries([...originalApps, ...transferredApps].map((id) => [id, { months: {} }]));
  const storage = memoryStorage({ 'hmjhi-daily-mau-history-v1': JSON.stringify({ apps: oldApps }) });
  const hints = [
    { id: 'legacy', appIds: originalApps },
    { id: 'liang', appIds: transferredApps }
  ];
  assert.equal(history.resolveProfile(storage, originalApps, hints), 'legacy');
  assert.equal(history.resolveProfile(storage, transferredApps, hints), 'liang');
  const store = history.readStore(storage);
  assert.equal(Object.keys(store.profiles.liang.apps).length, 0);
  store.profiles.liang.apps[transferredApps[0]] = { months: { '2026-11': [{ date: '2026-11-01', mau: 20 }] } };
  history.writeStore(storage, store);
  assert.equal(history.readStore(storage).profiles.legacy.apps[transferredApps[0]].months['2026-11'], undefined);
  assert.equal(history.resolveProfile(storage, originalApps, hints), 'legacy');
  assert.equal(history.resolveProfile(storage, [...transferredApps, appId(11)], hints), 'liang');
});

test('缺少提示时，大幅不同的应用集合另开历史', () => {
  const history = loadHistory();
  const storage = memoryStorage();
  const first = history.resolveProfile(storage, originalApps);
  const second = history.resolveProfile(storage, transferredApps);
  assert.notEqual(first, second);
  assert.equal(history.resolveProfile(storage, originalApps), first);
  assert.equal(history.resolveProfile(storage, transferredApps), second);
});

test('1.2.5升级时，当前应用只是旧历史的一部分，仍能读取对应旧折线', () => {
  const history = loadHistory();
  const oldApps = Object.fromEntries(originalApps.map((id) => [id, {
    appId: id, months: { '2026-11': [{ date: '2026-11-10', mau: 123, source: 'page' }] }
  }]));
  const oldRaw = JSON.stringify({ version: 1, apps: oldApps });
  const storage = memoryStorage({ 'hmjhi-daily-mau-history-v1': oldRaw });
  const selected = history.resolveProfile(storage, originalApps.slice(0, 2));
  const store = history.readStore(storage);
  for (const id of originalApps.slice(0, 2)) {
    assert.equal(store.profiles[selected].apps[id]?.months['2026-11'][0].mau, 123);
  }
  assert.equal(JSON.stringify(store.profiles.legacy.apps), JSON.stringify(oldApps));
  assert.equal(storage.getItem('hmjhi-daily-mau-history-v1'), oldRaw);
});

test('已升级到1.2.9且新档案已有数据时，补回缺少的旧日期，保留同日新值', () => {
  const history = loadHistory();
  const storage = memoryStorage();
  const selected = history.resolveProfile(storage, originalApps.slice(0, 2));
  const store = history.readStore(storage);
  store.profiles[selected].apps[originalApps[0]] = { appId: originalApps[0], months: {
    '2026-11': [{ date: '2026-11-12', mau: 212, source: 'page' }]
  } };
  store.profiles.legacy = { apps: Object.fromEntries(originalApps.map((id) => [id, {
    appId: id, months: { '2026-11': [
      { date: '2026-11-11', mau: 185, source: 'manual' },
      { date: '2026-11-12', mau: 200, source: 'page' }
    ] }
  }])) };
  history.writeStore(storage, store);
  assert.equal(history.resolveProfile(storage, originalApps.slice(0, 2)), selected);
  const points = history.readStore(storage).profiles[selected].apps[originalApps[0]].months['2026-11'];
  assert.deepEqual(Array.from(points, point => [point.date, point.mau]), [
    ['2026-11-11', 185], ['2026-11-12', 212]
  ]);
  history.resolveProfile(storage, originalApps.slice(0, 2));
  assert.equal(history.readStore(storage).profiles[selected].apps[originalApps[0]].months['2026-11'].length, 2);
});

test('已确认归属的旧档案不会补入另一账号', () => {
  const history = loadHistory();
  const storage = memoryStorage();
  history.writeStore(storage, { version: 2, profiles: { legacy: {
    observedAppIds: originalApps,
    apps: { [transferredApps[0]]: { months: { '2026-10': [{ date: '2026-10-31', mau: 59 }] } } }
  } } });
  const selected = history.resolveProfile(storage, transferredApps);
  assert.deepEqual(Object.keys(history.readStore(storage).profiles[selected].apps), []);
});

test('当前应用仅部分与旧记录重叠时，不擅自跨档案恢复', () => {
  const history = loadHistory();
  const storage = memoryStorage({ 'hmjhi-daily-mau-history-v1': JSON.stringify({ apps: {
    [originalApps[0]]: { months: { '2026-11': [{ date: '2026-11-11', mau: 185 }] } }
  } }) });
  const selected = history.resolveProfile(storage, [originalApps[0], transferredApps[0]]);
  assert.deepEqual(Object.keys(history.readStore(storage).profiles[selected].apps), []);
});

test('显式配置的另一账号不会继承未归属的旧应用记录', () => {
  const history = loadHistory();
  const storage = memoryStorage({ 'hmjhi-daily-mau-history-v1': JSON.stringify({ apps: {
    [transferredApps[0]]: { months: { '2026-10': [{ date: '2026-10-31', mau: 59 }] } }
  } }) });
  const selected = history.resolveProfile(storage, [transferredApps[0]], [
    { id: 'liang', appIds: [transferredApps[0]] }
  ]);
  assert.deepEqual(Object.keys(history.readStore(storage).profiles[selected].apps), []);
});

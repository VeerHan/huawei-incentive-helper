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

(() => {
  'use strict';

  const LEGACY_KEY = 'hmjhi-daily-mau-history-v1';
  const STORAGE_KEY = 'hmjhi-daily-mau-history-v2';
  const LEGACY_PROFILE_ID = 'legacy';

  function emptyStore() {
    return { version: 2, profiles: {} };
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function readStore(storage) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return parsed.version === 2 && isRecord(parsed.profiles) ? parsed : emptyStore();
      }

      const oldRaw = storage.getItem(LEGACY_KEY);
      const oldStore = oldRaw ? JSON.parse(oldRaw) : null;
      const store = emptyStore();
      if (oldStore && isRecord(oldStore.apps)) {
        store.profiles[LEGACY_PROFILE_ID] = {
          name: '原账号历史',
          apps: oldStore.apps
        };
        // 旧键保留作备份。迁移后的写入只发生在 v2 中。
        storage.setItem(STORAGE_KEY, JSON.stringify(store));
      }
      return store;
    } catch {
      return emptyStore();
    }
  }

  function writeStore(storage, store) {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function validAppIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .filter((value) => /^C\d{19}$/.test(value)))].sort();
  }

  function similarity(left, right) {
    if (!left.length || !right.length) return 0;
    const leftSet = new Set(left);
    const overlap = right.filter((id) => leftSet.has(id)).length;
    return overlap / (left.length + right.length - overlap);
  }

  function portfolioId(appIds) {
    // 仅用于本地命名空间；即使发生哈希碰撞，后续仍会用完整 AppID 集合核验。
    let hash = 2166136261;
    for (const char of appIds.join('|')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `portfolio-${(hash >>> 0).toString(16)}`;
  }

  function resolveProfile(storage, visibleAppIds, hints = []) {
    const appIds = validAppIds(visibleAppIds);
    if (!appIds.length) return null;
    const store = readStore(storage);
    const candidates = [];

    for (const hint of Array.isArray(hints) ? hints : []) {
      if (!hint || typeof hint.id !== 'string') continue;
      candidates.push({ id: hint.id, score: similarity(appIds, validAppIds(hint.appIds)), hinted: true });
    }
    for (const [id, profile] of Object.entries(store.profiles)) {
      const knownIds = validAppIds(profile.observedAppIds ?? Object.keys(profile.apps ?? {}));
      candidates.push({ id, score: similarity(appIds, knownIds), hinted: false });
    }
    candidates.sort((left, right) => right.score - left.score || Number(right.hinted) - Number(left.hinted));
    const best = candidates[0];
    const competing = candidates.find((candidate) => candidate.id !== best?.id);
    const confident = best && best.score >= 0.6 && (!competing || best.score - competing.score >= 0.2);
    let id = confident ? best.id : portfolioId(appIds);
    if (id.startsWith('portfolio-') && store.profiles[id] && similarity(appIds, validAppIds(
      store.profiles[id].observedAppIds ?? Object.keys(store.profiles[id].apps ?? {})
    )) < 0.6) {
      id = `${id}-${appIds.join('').slice(-8)}`;
    }
    const profile = store.profiles[id] ?? { apps: {} };
    profile.observedAppIds = appIds;
    store.profiles[id] = profile;
    writeStore(storage, store);
    return id;
  }

  globalThis.HMJHI_HISTORY = {
    LEGACY_PROFILE_ID,
    readStore,
    writeStore,
    resolveProfile
  };
})();

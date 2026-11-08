/** Validated, redundant browser persistence. No network or external dependencies. */
export const STORAGE_KEYS = Object.freeze({ progress: 'aml-study.progress.v1', backup: 'aml-study.progress.backup.v1', pack: 'aml-study.pack.v1' });
const MAX_BYTES = 15 * 1024 * 1024;
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
function fail(message) { throw new TypeError(message); }
function record(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null); }
function object(v, name) { if (!record(v)) fail(`${name} 必須是物件`); }
function str(v, name, max = 1000, empty = false) { if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max) fail(`${name} 文字格式不正確`); return v; }
function id(v) { str(v, 'id', 200); if (['__proto__', 'constructor', 'prototype'].includes(v)) fail('不支援的 id'); return v; }
function number(v, name) { if (!Number.isSafeInteger(v) || v < 0) fail(`${name} 必須是非負整數`); return v; }
function size(v) { let s; try { s = JSON.stringify(v); } catch { fail('資料不能序列化'); } if (!s || new TextEncoder().encode(s).length > MAX_BYTES) fail('資料超過 15 MB'); return s; }
function jsonCopy(v) { const s = size(v); return JSON.parse(s); }
export function validateProgress(input) {
  size(input); object(input, '進度'); if (input.schema !== 1) fail('不支援的進度版本');
  number(input.updatedAt, 'updatedAt'); object(input.cards, 'cards');
  if (Object.keys(input.cards).length > 50000) fail('卡片紀錄過多');
  const out = { schema: 1, updatedAt: input.updatedAt, cards: {} };
  for (const [key, card] of Object.entries(input.cards)) {
    id(key); object(card, '卡片紀錄'); const c = {};
    for (const k of ['readAt', 'knownAt']) if (own(card, k)) c[k] = number(card[k], k);
    if (own(card, 'attempts')) {
      if (!Array.isArray(card.attempts) || card.attempts.length > 10000) fail('作答紀錄格式不正確');
      c.attempts = card.attempts.map(a => {
        object(a, '作答紀錄');
        // Attempts are extensible JSON records; reject unsafe or non-JSON values.
        const check = (v, depth = 0) => {
          if (depth > 8) fail('作答紀錄層級過深');
          if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
          if (typeof v === 'number' && Number.isFinite(v)) return;
          if (Array.isArray(v)) { if (v.length > 1000) fail('作答紀錄過長'); v.forEach(x => check(x, depth + 1)); return; }
          object(v, '作答欄位'); for (const [k, x] of Object.entries(v)) { id(k); check(x, depth + 1); }
        };
        check(a); return jsonCopy(a);
      });
    }
    out.cards[key] = c;
  }
  if (own(input, 'lastCard')) out.lastCard = id(input.lastCard);
  if (own(input, 'session')) {
    const s = input.session; object(s, 'session');
    if (!Array.isArray(s.ids) || s.ids.length > 50000) fail('session.ids 格式不正確');
    const ids = s.ids.map(id); const index = number(s.index, 'session.index');
    if (index > ids.length) fail('session.index 超出範圍');
    out.session = { ids, index, mode: str(s.mode, 'mode', 100), ...(s.runId ? {runId: id(s.runId)} : {}) };
  }
  size(out); return out;
}
export function validatePack(input) {
  size(input); object(input, '教材'); if (input.schema !== 1) fail('不支援的教材版本');
  object(input.source, 'source'); const source = { title: str(input.source.title, '來源標題', 2000), url: str(input.source.url, '來源網址', 4000) };
  try { const u = new URL(source.url); if (!['http:', 'https:'].includes(u.protocol)) fail('來源網址必須使用 HTTPS 或 HTTP'); } catch { fail('來源網址格式不正確'); }
  if (!Array.isArray(input.chapters) || !input.chapters.length || input.chapters.length > 1000) fail('章節格式不正確');
  const chapterIds = new Set();
  const chapters = input.chapters.map(c => { object(c, '章節'); const key = id(c.id); if (chapterIds.has(key)) fail('章節 id 重複'); chapterIds.add(key); return { id: key, title: str(c.title, '章節標題', 2000) }; });
  if (!Array.isArray(input.cards) || !input.cards.length || input.cards.length > 50000) fail('教材卡片格式不正確');
  const cardIds = new Set();
  const cards = input.cards.map(c => {
    object(c, '卡片'); const key = id(c.id); if (cardIds.has(key)) fail('卡片 id 重複'); cardIds.add(key);
    if (!chapterIds.has(c.chapterId)) fail('卡片所屬章節不存在');
    const out = { id: key, chapterId: c.chapterId, title: str(c.title, '卡片標題', 2000), body: str(c.body, '卡片內文', 100000), page: number(c.page, '頁碼') };
    if (own(c, 'quiz')) {
      const q = c.quiz; object(q, '測驗');
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 20) fail('測驗選項格式不正確');
      const answer = number(q.answer, '答案'); if (answer >= q.options.length) fail('答案超出選項範圍');
      out.quiz = { prompt: str(q.prompt, '題目', 10000), options: q.options.map(x => str(x, '選項', 10000)), answer, explanation: str(q.explanation, '解析', 20000, true) };
    }
    return out;
  });
  const out = { schema: 1, id: id(input.id), title: str(input.title, '教材標題', 2000), source, chapters, cards }; size(out); return out;
}
const empty = () => ({ schema: 1, updatedAt: 0, cards: {} });
function stable(v) { if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`; if (record(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`; return JSON.stringify(v); }
export function mergeProgress(...inputs) {
  let out = empty();
  for (const input of inputs) {
    const p = validateProgress(input);
    const newer = p.updatedAt >= out.updatedAt;
    for (const [key, c] of Object.entries(p.cards)) {
      const previous = out.cards[key] || {}; const next = { ...previous };
      for (const field of ['readAt', 'knownAt']) if (own(c, field)) next[field] = Math.max(previous[field] || 0, c[field]);
      if (c.attempts || previous.attempts) {
        const entries = new Map();
        for (const a of [...(previous.attempts || []), ...(c.attempts || [])]) entries.set(stable(a), a);
        next.attempts = [...entries.values()];
      }
      out.cards[key] = next;
    }
    for (const field of ['lastCard', 'session']) if (own(p, field) && (newer || !own(out, field))) out[field] = p[field];
    out.updatedAt = Math.max(out.updatedAt, p.updatedAt);
  }
  return validateProgress(out);
}
function defaultStorage() { try { return globalThis.localStorage; } catch { return null; } }
function connect(factory) {
  if (!factory) return Promise.resolve(null);
  return new Promise(resolve => {
    let done = false; const finish = db => { if (done) { db?.close(); return; } done = true; clearTimeout(timer); resolve(db); };
    const timer = setTimeout(() => finish(null), 2000);
    try {
      const req = factory.open('aml-study-v1', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('data')) req.result.createObjectStore('data'); };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); finish(db); };
      req.onerror = () => finish(null); req.onblocked = () => finish(null);
    } catch { finish(null); }
  });
}
function databaseAdapter(db) {
  if (!db) return null;
  return { read: key => transaction('readonly', key), write: (key, value) => transaction('readwrite', key, value) };
  function transaction(mode, key, value) {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction('data', mode); const store = tx.objectStore('data');
        const req = mode === 'readonly' ? store.get(key) : store.put(value, key);
        tx.oncomplete = () => resolve(req.result); tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB 寫入失敗'));
      } catch (e) { reject(e); }
    });
  }
}
/** Optional storage/database adapters allow deterministic tests and embedded environments. */
export async function openStore(options = {}) {
  const storage = own(options, 'storage') ? options.storage : defaultStorage();
  const database = own(options, 'database') ? options.database : databaseAdapter(await connect(own(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB));
  let memory = empty(), memoryPack = null; let queue = Promise.resolve();
  const serial = fn => { const task = queue.then(fn, fn); queue = task.catch(() => {}); return task; };
  const localRead = key => { try { return storage?.getItem(key); } catch { return null; } };
  const localWrite = (key, value) => { try { if (!storage) return false; storage.setItem(key, value); return storage.getItem(key) === value; } catch { return false; } };
  const dbRead = async key => { try { return await database?.read(key); } catch { return null; } };
  const dbWrite = async (key, value) => { try { if (!database) return false; await database.write(key, value); return true; } catch { return false; } };
  const parse = (v, validator) => { try { return validator(typeof v === 'string' ? JSON.parse(v) : v); } catch { return null; } };
  async function readProgress() {
    const copies = [memory, parse(localRead(STORAGE_KEYS.progress), validateProgress), parse(localRead(STORAGE_KEYS.backup), validateProgress), parse(await dbRead('progress'), validateProgress)].filter(Boolean);
    memory = mergeProgress(...copies); return jsonCopy(memory);
  }
  return {
    loadProgress: () => serial(readProgress),
    saveProgress: progress => serial(async () => {
      const incoming = validateProgress(progress); const existing = await readProgress();
      memory = mergeProgress(existing, incoming); const value = size(memory);
      const primary = localWrite(STORAGE_KEYS.progress, value); const backup = localWrite(STORAGE_KEYS.backup, value); const indexed = await dbWrite('progress', value);
      const durable = primary || backup || indexed;
      return { ok: durable, durable, message: durable ? '學習進度已儲存於此裝置。' : '此裝置無法儲存進度；目前僅暫存在記憶體，請立即匯出備份。' };
    }),
    loadPack: () => serial(async () => { memoryPack = parse(await dbRead('pack'), validatePack) || parse(localRead(STORAGE_KEYS.pack), validatePack) || memoryPack; return memoryPack ? jsonCopy(memoryPack) : null; }),
    savePack: pack => serial(async () => {
      const validated = validatePack(pack); const value = size(validated); memoryPack = validated;
      const indexed = await dbWrite('pack', value); const local = localWrite(STORAGE_KEYS.pack, value); const durable = indexed || local;
      return { ok: durable, durable, message: durable ? '教材已儲存於此裝置。' : '教材僅暫存在記憶體；關閉頁面後可能無法使用。' };
    })
  };
}

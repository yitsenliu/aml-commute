import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./storage.js', import.meta.url), 'utf8');
const { openStore, validateProgress, validatePack, mergeProgress, STORAGE_KEYS: K } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const progress = (cards = {}, updatedAt = 1) => ({ schema: 1, updatedAt, cards });
const pack = () => ({ schema: 1, id: 'aml', title: '教材', source: { title: '原文', url: 'https://example.com/book.pdf' }, chapters: [{ id: 'ch1', title: '第一章' }], cards: [{ id: 'c1', chapterId: 'ch1', title: '概念', body: '內容', page: 1, quiz: { prompt: '問題', options: ['甲', '乙'], answer: 0, explanation: '解析' } }] });
function local(initial = {}) { const data = new Map(Object.entries(initial)); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), data }; }
function db(initial = {}) { const data = new Map(Object.entries(initial)); return { read: async k => data.get(k), write: async (k, v) => { data.set(k, v); }, data }; }

test('merge keeps every card, latest timestamps, attempts, and newer session', () => {
  const a = { ...progress({ a: { readAt: 20, knownAt: 30, attempts: [{ at: 10, correct: true }] } }, 50), lastCard: 'a', session: { ids: ['a'], index: 0, mode: 'all' } };
  const b = { ...progress({ a: { readAt: 10, knownAt: 40, attempts: [{ correct: true, at: 10 }, { at: 11, correct: false }] }, b: { readAt: 15 } }, 40), lastCard: 'b' };
  const result = mergeProgress(a, b);
  assert.equal(result.cards.a.readAt, 20); assert.equal(result.cards.a.knownAt, 40);
  assert.equal(result.cards.a.attempts.length, 2); assert.equal(result.cards.b.readAt, 15);
  assert.equal(result.lastCard, 'a'); assert.deepEqual(result.session, a.session);
  result.cards.a.readAt = 100; assert.equal(a.cards.a.readAt, 20);
});

test('corrupted primary recovers and merges backup plus independent IndexedDB', async () => {
  const storage = local({ [K.progress]: '{bad', [K.backup]: JSON.stringify(progress({ a: { readAt: 20 } }, 20)) });
  const database = db({ progress: JSON.stringify(progress({ b: { knownAt: 30 } }, 30)) });
  const store = await openStore({ storage, database });
  assert.deepEqual((await store.loadProgress()).cards, { a: { readAt: 20 }, b: { knownAt: 30 } });
  const status = await store.saveProgress(progress({ c: { readAt: 40 } }, 40));
  assert.equal(status.durable, true);
  for (const raw of [storage.getItem(K.progress), storage.getItem(K.backup), database.data.get('progress')]) assert.deepEqual(Object.keys(JSON.parse(raw).cards).sort(), ['a', 'b', 'c']);
});

test('a stale tab save cannot erase records written after that tab loaded', async () => {
  const storage = local(); const database = db();
  const one = await openStore({ storage, database }); const two = await openStore({ storage, database });
  await two.loadProgress();
  await one.saveProgress(progress({ a: { knownAt: 20 } }, 20));
  await two.saveProgress(progress({ b: { readAt: 10 } }, 10));
  assert.deepEqual((await one.loadProgress()).cards, { a: { knownAt: 20 }, b: { readAt: 10 } });
});

test('failed writes report non-durable status and retain recoverable in-memory progress', async () => {
  const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } };
  const unavailable = { read: async () => { throw Error('closed'); }, write: async () => { throw Error('closed'); } };
  const store = await openStore({ storage: denied, database: unavailable });
  const status = await store.saveProgress(progress({ a: { readAt: 30 } }, 30));
  assert.equal(status.ok, false); assert.equal(status.durable, false); assert.match(status.message, /匯出/);
  await store.saveProgress(progress({ b: { readAt: 40 } }, 40));
  assert.deepEqual(Object.keys((await store.loadProgress()).cards), ['a', 'b']);
});

test('either independent persistence tier can survive the other failing', async () => {
  const broken = { getItem: () => '{bad', setItem() { throw Error('quota'); } };
  const database = db(); const store = await openStore({ storage: broken, database });
  assert.equal((await store.saveProgress(progress({ a: { readAt: 3 } }, 3))).durable, true);
  const reopened = await openStore({ storage: broken, database });
  assert.equal((await reopened.loadProgress()).cards.a.readAt, 3);
  const storage = local(); const fallback = await openStore({ storage, database: null });
  assert.equal((await fallback.saveProgress(progress({ a: { readAt: 4 } }, 4))).durable, true);
});

test('corrupted copies cannot reset progress already recovered in this session', async () => {
  const storage = local({ [K.backup]: JSON.stringify(progress({ a: { knownAt: 7 } }, 7)) });
  const store = await openStore({ storage, database: null }); await store.loadProgress();
  storage.data.set(K.backup, '{}'); storage.data.set(K.progress, '{broken');
  assert.equal((await store.loadProgress()).cards.a.knownAt, 7);
  await assert.rejects(store.saveProgress({ schema: 2 }), TypeError);
  assert.equal((await store.loadProgress()).cards.a.knownAt, 7);
});

test('pack round-trips through IndexedDB and falls back to local copy on corruption', async () => {
  const storage = local(); const database = db(); const store = await openStore({ storage, database });
  assert.equal((await store.savePack(pack())).ok, true);
  database.data.set('pack', '{bad');
  assert.deepEqual(await (await openStore({ storage, database })).loadPack(), pack());
  const idbOnly = await openStore({ storage: null, database });
  await idbOnly.savePack(pack()); assert.deepEqual(await idbOnly.loadPack(), pack());
});

test('validation rejects malformed progress and oversized imports', () => {
  for (const bad of [null, {}, progress([], 1), progress({ x: { knownAt: -1 } }), progress({ x: { readAt: '1' } }), progress({ x: { attempts: [true] } }), { ...progress(), session: { ids: ['a'], index: 2, mode: 'all' } }, JSON.parse('{"schema":1,"updatedAt":1,"cards":{"__proto__":{}}}')]) assert.throws(() => validateProgress(bad), TypeError);
  assert.throws(() => validateProgress(progress({ a: { attempts: [{ text: 'x'.repeat(15 * 1024 * 1024) }] } })), /15 MB/);
});

test('validation rejects broken pack references, unsafe URLs, wrong answers, duplicate IDs', () => {
  const changes = [p => { p.cards[0].chapterId = 'missing'; }, p => { p.source.url = 'javascript:alert(1)'; }, p => { p.cards[0].quiz.answer = 2; }, p => { p.cards.push({ ...p.cards[0] }); }, p => { p.cards[0].page = -1; }, p => { p.cards[0].body = 7; }];
  for (const change of changes) { const p = pack(); change(p); assert.throws(() => validatePack(p), TypeError); }
  const p = pack(); const validated = validatePack(p); validated.cards[0].quiz.options[0] = 'changed'; assert.equal(p.cards[0].quiz.options[0], '甲');
});

test('simultaneous saves in one store are serialized without lost updates', async () => {
  const store = await openStore({ storage: local(), database: db() });
  await Promise.all([store.saveProgress(progress({ a: { readAt: 1 } })), store.saveProgress(progress({ b: { readAt: 2 } }, 2))]);
  assert.deepEqual(Object.keys((await store.loadProgress()).cards), ['a', 'b']);
});

test('native IndexedDB adapter waits for transaction commit before reporting durable', async () => {
  const data = new Map(); let pendingWrite;
  const fakeDB = {
    objectStoreNames: { contains: () => true }, close() {},
    transaction(_name, mode) {
      const tx = { error: null, objectStore() { return {
        get(key) { const req = { result: data.get(key) }; queueMicrotask(() => tx.oncomplete()); return req; },
        put(value, key) { const req = { result: key }; pendingWrite = () => { data.set(key, value); tx.oncomplete(); }; return req; }
      }; } };
      return tx;
    }
  };
  const indexedDB = { open() { const request = { result: fakeDB }; queueMicrotask(() => request.onsuccess()); return request; } };
  const store = await openStore({ storage: null, indexedDB });
  let settled = false;
  const saving = store.saveProgress(progress({ a: { readAt: 1 } })).then(result => { settled = true; return result; });
  for (let i = 0; i < 12 && !pendingWrite; i++) await Promise.resolve();
  assert.equal(typeof pendingWrite, 'function'); assert.equal(settled, false);
  pendingWrite(); assert.equal((await saving).durable, true);
  assert.equal(JSON.parse(data.get('progress')).cards.a.readAt, 1);
});

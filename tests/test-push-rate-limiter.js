// ============================================================
// test-push-rate-limiter.js — testy jednostkowe lib/push-rate-limiter.js
// ============================================================
// Uruchom: node tests/test-push-rate-limiter.js
// Bez frameworka testowego (assert wbudowany w Node) — ten sam poziom
// prostoty co reszta "atrap" opisanych w KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md.
//
// send-push.js (require('../api/send-push')) wymaga firebase-admin, którego
// nie instalujemy tylko po to, żeby uruchomić testy jednostkowe czystej
// logiki limitu — więc PRZED require('../lib/push-rate-limiter') podmieniamy
// require.cache dla dokładnie tej ścieżki na lekką atrapę. To NIE zmienia
// prawdziwego pliku api/send-push.js na dysku/w repo, tylko wpływa na to,
// co Node zwróci przy require() w trakcie TEGO uruchomienia testów.
// ============================================================
const assert = require('assert');
const path = require('path');

const sendPushCalls = [];
const sendPushStubPath = require.resolve('../api/send-push.js');
require.cache[sendPushStubPath] = {
  id: sendPushStubPath,
  filename: sendPushStubPath,
  loaded: true,
  exports: {
    sendPush: async (tokens, payload) => {
      sendPushCalls.push({ tokens, payload });
      return { successCount: (Array.isArray(tokens) ? tokens.length : 1), failureCount: 0, invalidTokens: [] };
    },
    verifyFirebaseConfig: () => true,
  },
};

const {
  isQuietHours,
  canSendGivenState,
  warsawDayBoundsUTC,
  canSend,
  recordSent,
  gatedSendPush,
  DAILY_PUSH_CAP,
} = require('../lib/push-rate-limiter');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${label}`);
  } catch (e) {
    console.error(`  FAIL — ${label}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

// ------------------------------------------------------------
// Minimalna atrapa Supabase — wystarczająca dla dokładnie tych zapytań,
// których używa push-rate-limiter.js (select+count z eq/gte/lt, insert).
// ------------------------------------------------------------
function makeFakeSupabase(seedRows = []) {
  const state = { push_send_log: [...seedRows] };
  return {
    _state: state,
    from(table) {
      const filters = [];
      const builder = {
        select() { return builder; },
        eq(col, val) { filters.push((row) => row[col] === val); return builder; },
        gte(col, val) { filters.push((row) => row[col] >= val); return builder; },
        lt(col, val) { filters.push((row) => row[col] < val); return builder; },
        insert(row) {
          state[table] = state[table] || [];
          state[table].push({ id: state[table].length + 1, ...row });
          return Promise.resolve({ data: [row], error: null });
        },
        then(resolve) {
          const rows = (state[table] || []).filter((r) => filters.every((f) => f(r)));
          resolve({ data: rows, count: rows.length, error: null });
        },
      };
      return builder;
    },
  };
}

console.log('1. isQuietHours — godziny ciszy nocnej (21:00-7:00 Warszawa)');
check('21:00 jest ciszą', () => assert.strictEqual(isQuietHours(21), true));
check('23:00 jest ciszą', () => assert.strictEqual(isQuietHours(23), true));
check('0:00 (północ) jest ciszą', () => assert.strictEqual(isQuietHours(0), true));
check('6:00 jest ciszą', () => assert.strictEqual(isQuietHours(6), true));
check('7:00 NIE jest ciszą (koniec okna, wyłącznie)', () => assert.strictEqual(isQuietHours(7), false));
check('20:00 NIE jest ciszą', () => assert.strictEqual(isQuietHours(20), false));
check('12:00 (południe) NIE jest ciszą', () => assert.strictEqual(isQuietHours(12), false));

console.log('2. canSendGivenState — czysta decyzja bramki');
check('blokuje w ciszy nocnej mimo 0 wysłanych dziś', () => {
  const r = canSendGivenState({ hour: 22, sentCountToday: 0 });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'quiet_hours');
});
check('blokuje po osiągnięciu limitu dobowego', () => {
  const r = canSendGivenState({ hour: 12, sentCountToday: DAILY_PUSH_CAP });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'daily_cap_reached');
});
check('pozwala poniżej limitu, poza ciszą', () => {
  const r = canSendGivenState({ hour: 12, sentCountToday: 1 });
  assert.strictEqual(r.allowed, true);
});
check('pozwala przy dokładnie 0 wysłanych', () => {
  const r = canSendGivenState({ hour: 8, sentCountToday: 0 });
  assert.strictEqual(r.allowed, true);
});
check('blokuje TUŻ PRZED końcem ciszy (6:59 -> hour=6)', () => {
  const r = canSendGivenState({ hour: 6, sentCountToday: 0 });
  assert.strictEqual(r.allowed, false);
});

console.log('3. warsawDayBoundsUTC — granice doby Warszawy jako UTC (zima i lato)');
check('zima (styczeń, UTC+1): początek doby formatuje się jako 00:00 lokalnie', () => {
  const { startUTC, endUTC } = warsawDayBoundsUTC('2026-01-15');
  const startCheck = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(startUTC));
  const get = (t) => startCheck.find((p) => p.type === t)?.value;
  assert.strictEqual(`${get('year')}-${get('month')}-${get('day')}`, '2026-01-15');
  assert.strictEqual(Number(get('hour')), 0);
  assert.strictEqual(new Date(endUTC).getTime() - new Date(startUTC).getTime(), 24 * 60 * 60 * 1000);
});
check('lato (lipiec, UTC+2): początek doby formatuje się jako 00:00 lokalnie', () => {
  const { startUTC, endUTC } = warsawDayBoundsUTC('2026-07-15');
  const startCheck = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date(startUTC));
  const get = (t) => startCheck.find((p) => p.type === t)?.value;
  assert.strictEqual(`${get('year')}-${get('month')}-${get('day')}`, '2026-07-15');
  assert.strictEqual(Number(get('hour')), 0);
  assert.strictEqual(new Date(endUTC).getTime() - new Date(startUTC).getTime(), 24 * 60 * 60 * 1000);
});

console.log('4. canSend / gatedSendPush — z atrapą Supabase');
(async () => {
  await (async () => {
    const supabase = makeFakeSupabase();
    const warsawNow = { hour: 12, dateStr: '2026-08-03' };
    const gate = await canSend(supabase, 'user-1', warsawNow);
    check('canSend pozwala, gdy log pusty i poza ciszą', () => assert.strictEqual(gate.allowed, true));
  })();

  await (async () => {
    const supabase = makeFakeSupabase();
    const warsawNow = { hour: 23, dateStr: '2026-08-03' };
    const gate = await canSend(supabase, 'user-1', warsawNow);
    check('canSend blokuje w ciszy nocnej niezależnie od stanu logu', () => assert.strictEqual(gate.reason, 'quiet_hours'));
  })();

  await (async () => {
    const { startUTC } = warsawDayBoundsUTC('2026-08-03');
    const todayIso = new Date(new Date(startUTC).getTime() + 3 * 60 * 60 * 1000).toISOString(); // 3h po północy Warszawy
    const supabase = makeFakeSupabase([
      { id: 1, user_id: 'user-1', notification_type: 'pre_match', sent_at: todayIso },
      { id: 2, user_id: 'user-1', notification_type: 'post_training', sent_at: todayIso },
    ]);
    const warsawNow = { hour: 12, dateStr: '2026-08-03' };
    const gate = await canSend(supabase, 'user-1', warsawNow);
    check('canSend blokuje po 2 już wysłanych DZIŚ (MIĘDZY różnymi typami rytmów)', () => {
      assert.strictEqual(gate.allowed, false);
      assert.strictEqual(gate.reason, 'daily_cap_reached');
    });
  })();

  await (async () => {
    const supabase = makeFakeSupabase();
    const warsawNow = { hour: 12, dateStr: '2026-08-03' };
    sendPushCalls.length = 0;
    const result = await gatedSendPush(supabase, {
      userId: 'user-2', tokens: ['tok-1'], notificationType: 'morning_readiness',
      title: 'Gamechange', body: 'Test', data: { type: 'morning_readiness' }, warsawNow,
    });
    check('gatedSendPush faktycznie wysyła, gdy dozwolone', () => {
      assert.strictEqual(result.sent, true);
      assert.strictEqual(sendPushCalls.length, 1);
    });
    check('gatedSendPush zapisuje do push_send_log po wysyłce', () => {
      const logged = supabase._state.push_send_log.filter((r) => r.user_id === 'user-2');
      assert.strictEqual(logged.length, 1);
      assert.strictEqual(logged[0].notification_type, 'morning_readiness');
    });
  })();

  await (async () => {
    const supabase = makeFakeSupabase();
    const warsawNow = { hour: 22, dateStr: '2026-08-03' }; // cisza nocna
    sendPushCalls.length = 0;
    const result = await gatedSendPush(supabase, {
      userId: 'user-3', tokens: ['tok-1'], notificationType: 'weekly_summary',
      title: 'Gamechange', body: 'Test', data: {}, warsawNow,
    });
    check('gatedSendPush NIE wysyła w ciszy nocnej', () => {
      assert.strictEqual(result.sent, false);
      assert.strictEqual(sendPushCalls.length, 0);
    });
  })();

  console.log(`\n${passed} testów przeszło (bez licząc bloku asynchronicznego wyżej — patrz wynik końcowy poniżej).`);
  if (process.exitCode) {
    console.error('\nNIEKTÓRE TESTY NIE PRZESZŁY.');
  } else {
    console.log('\nWSZYSTKIE TESTY PRZESZŁY.');
  }
})();

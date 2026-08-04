// ============================================================
// test-retention-check.js — testy jednostkowe lib/retention-check.js
// ============================================================
// Uruchom: node tests/test-retention-check.js
// email-sender.js nie wymaga ciężkich zależności (fetch wbudowany w
// Node 18+), ale WYMAGA zmiennych środowiskowych (EMAIL_API_KEY) przy
// FAKTYCZNYM wywołaniu sendEmail — więc w testach orkiestracji podmieniamy
// require.cache dla email-sender.js na atrapę, ten sam wzorzec co w
// pozostałych dwóch plikach testowych.
// ============================================================
const assert = require('assert');

const sendEmailCalls = [];
const emailSenderStubPath = require.resolve('../lib/email-sender.js');
require.cache[emailSenderStubPath] = {
  id: emailSenderStubPath,
  filename: emailSenderStubPath,
  loaded: true,
  exports: {
    sendEmail: async (opts) => {
      sendEmailCalls.push(opts);
      return { provider: 'stub', id: 'fake-email-id' };
    },
  },
};

const {
  computeLastActivityAt,
  isRetentionReminderDue,
  runRetentionCheck,
  RETENTION_INACTIVITY_THRESHOLD_DAYS,
} = require('../lib/retention-check');

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

const NOW = new Date('2026-08-10T12:00:00.000Z');

console.log('1. computeLastActivityAt — MAX(daily_logs, match_contexts), POTWIERDZONE przez Kubę');

check('daily_logs nowszy niż match_contexts -> zwraca daily_logs', () => {
  const r = computeLastActivityAt('2026-08-05T00:00:00Z', '2026-08-01T00:00:00Z');
  assert.strictEqual(r, new Date('2026-08-05T00:00:00Z').toISOString());
});
check('match_contexts nowszy niż daily_logs -> zwraca match_contexts', () => {
  const r = computeLastActivityAt('2026-08-01T00:00:00Z', '2026-08-05T00:00:00Z');
  assert.strictEqual(r, new Date('2026-08-05T00:00:00Z').toISOString());
});
check('brak daily_logs -> zwraca match_contexts', () => {
  const r = computeLastActivityAt(null, '2026-08-05T00:00:00Z');
  assert.strictEqual(r, new Date('2026-08-05T00:00:00Z').toISOString());
});
check('brak match_contexts -> zwraca daily_logs', () => {
  const r = computeLastActivityAt('2026-08-05T00:00:00Z', null);
  assert.strictEqual(r, new Date('2026-08-05T00:00:00Z').toISOString());
});
check('brak obu -> null', () => {
  assert.strictEqual(computeLastActivityAt(null, null), null);
});

console.log('2. isRetentionReminderDue — czysta funkcja decyzyjna');

check('brak lastActivityAt (nigdy nic nie zalogował) -> nie due', () => {
  const r = isRetentionReminderDue({ lastActivityAt: null, now: NOW, lastReminderForActivity: null });
  assert.strictEqual(r.due, false);
  assert.strictEqual(r.reason, 'no_activity_ever');
});

check(`${RETENTION_INACTIVITY_THRESHOLD_DAYS - 1} dni nieaktywności -> poniżej progu, nie due`, () => {
  const lastActivityAt = new Date(NOW.getTime() - (RETENTION_INACTIVITY_THRESHOLD_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString();
  const r = isRetentionReminderDue({ lastActivityAt, now: NOW, lastReminderForActivity: null });
  assert.strictEqual(r.due, false);
  assert.strictEqual(r.reason, 'below_threshold');
});

check(`dokładnie ${RETENTION_INACTIVITY_THRESHOLD_DAYS} dni -> próg osiągnięty, due`, () => {
  const lastActivityAt = new Date(NOW.getTime() - RETENTION_INACTIVITY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const r = isRetentionReminderDue({ lastActivityAt, now: NOW, lastReminderForActivity: null });
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.reason, 'threshold_crossed');
});

check('próg przekroczony, ale JUŻ przypomniano dla TEGO SAMEGO epizodu -> nie due (bez spamu)', () => {
  const lastActivityAt = new Date(NOW.getTime() - (RETENTION_INACTIVITY_THRESHOLD_DAYS + 2) * 24 * 60 * 60 * 1000).toISOString();
  const r = isRetentionReminderDue({ lastActivityAt, now: NOW, lastReminderForActivity: lastActivityAt });
  assert.strictEqual(r.due, false);
  assert.strictEqual(r.reason, 'already_reminded_this_episode');
});

check('próg przekroczony, ale NOWA aktywność od ostatniego przypomnienia -> nowy epizod, due', () => {
  const lastActivityAt = new Date(NOW.getTime() - (RETENTION_INACTIVITY_THRESHOLD_DAYS + 2) * 24 * 60 * 60 * 1000).toISOString();
  const olderReminderActivity = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); // przypomniano dawno, dla starszej aktywności
  const r = isRetentionReminderDue({ lastActivityAt, now: NOW, lastReminderForActivity: olderReminderActivity });
  assert.strictEqual(r.due, true);
  assert.strictEqual(r.reason, 'threshold_crossed');
});

check('niestandardowy thresholdDays respektowany', () => {
  const lastActivityAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const r = isRetentionReminderDue({ lastActivityAt, now: NOW, lastReminderForActivity: null, thresholdDays: 3 });
  assert.strictEqual(r.due, true);
});

console.log('3. runRetentionCheck — orkiestracja z atrapą Supabase');

function makeFakeSupabase({ users = [], dailyLogs = [], matchContexts = [], reminderLog = [] } = {}) {
  const state = { retention_reminder_log: [...reminderLog] };
  return {
    _state: state,
    from(table) {
      const filters = [];
      let orderCol = null, orderAsc = true, limitN = null;
      const source = table === 'users' ? users
        : table === 'daily_logs' ? dailyLogs
        : table === 'match_contexts' ? matchContexts
        : table === 'retention_reminder_log' ? state.retention_reminder_log
        : [];
      const builder = {
        select() { return builder; },
        order(col, opts) { orderCol = col; orderAsc = !(opts && opts.ascending === false); return builder; },
        limit(n) { limitN = n; return builder; },
        upsert(row) {
          const idx = state.retention_reminder_log.findIndex((r) => r.user_id === row.user_id);
          if (idx >= 0) state.retention_reminder_log[idx] = { ...state.retention_reminder_log[idx], ...row };
          else state.retention_reminder_log.push(row);
          return Promise.resolve({ data: [row], error: null });
        },
        then(resolve) {
          let rows = [...source].filter((r) => filters.every((f) => f(r)));
          if (orderCol) rows = rows.sort((a, b) => (a[orderCol] > b[orderCol] ? 1 : -1) * (orderAsc ? 1 : -1));
          if (limitN) rows = rows.slice(0, limitN);
          resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };
}

(async () => {
  await (async () => {
    sendEmailCalls.length = 0;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = makeFakeSupabase({
      users: [{ id: 'user-1', email: 'gracz@example.com' }],
      dailyLogs: [{ user_id: 'user-1', created_at: eightDaysAgo }],
      matchContexts: [],
      reminderLog: [],
    });
    const results = {};
    await runRetentionCheck(supabase, results);
    check('nieaktywny 8 dni, brak wcześniejszego przypomnienia -> wysyła e-mail', () => {
      assert.strictEqual(sendEmailCalls.length, 1);
      assert.strictEqual(sendEmailCalls[0].to, 'gracz@example.com');
      assert.strictEqual(results.retention_check, 1);
    });
    check('zapisuje retention_reminder_log po wysyłce', () => {
      const logged = supabase._state.retention_reminder_log.find((r) => r.user_id === 'user-1');
      assert.ok(logged);
      assert.strictEqual(logged.last_activity_at, eightDaysAgo);
    });
  })();

  await (async () => {
    sendEmailCalls.length = 0;
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = makeFakeSupabase({
      users: [{ id: 'user-2', email: 'aktywny@example.com' }],
      dailyLogs: [{ user_id: 'user-2', created_at: oneDayAgo }],
      matchContexts: [],
      reminderLog: [],
    });
    const results = {};
    await runRetentionCheck(supabase, results);
    check('aktywny wczoraj -> BEZ e-maila', () => {
      assert.strictEqual(sendEmailCalls.length, 0);
      assert.strictEqual(results.retention_check || 0, 0);
    });
  })();

  await (async () => {
    sendEmailCalls.length = 0;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const supabase = makeFakeSupabase({
      users: [{ id: 'user-3', email: 'juz-przypomniano@example.com' }],
      dailyLogs: [{ user_id: 'user-3', created_at: eightDaysAgo }],
      matchContexts: [],
      reminderLog: [{ user_id: 'user-3', last_activity_at: eightDaysAgo, sent_at: new Date().toISOString() }],
    });
    const results = {};
    await runRetentionCheck(supabase, results);
    check('już przypomniano dla tego epizodu -> BEZ drugiego e-maila (bez spamu)', () => {
      assert.strictEqual(sendEmailCalls.length, 0);
    });
  })();

  await (async () => {
    sendEmailCalls.length = 0;
    const supabase = makeFakeSupabase({
      users: [{ id: 'user-4', email: null }],
      dailyLogs: [{ user_id: 'user-4', created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() }],
      matchContexts: [],
      reminderLog: [],
    });
    const results = {};
    await runRetentionCheck(supabase, results);
    check('nieaktywny, ale brak adresu e-mail -> pomija bez błędu', () => {
      assert.strictEqual(sendEmailCalls.length, 0);
    });
  })();

  if (process.exitCode) {
    console.error('\nNIEKTÓRE TESTY NIE PRZESZŁY.');
  } else {
    console.log(`\nWSZYSTKIE TESTY PRZESZŁY (${passed}).`);
  }
})();

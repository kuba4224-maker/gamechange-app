// ============================================================
// GAMECHANGE — tests/test-focus-block-adaptation.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, czwarta runda — kontynuacja "Pracuj dalej" /
// inwentarz z DO_ZROBIENIA_PRZEZ_KUBE.md, sekcja "🧪 Pokrycie testami").
// lib/focus-block-adaptation.js automatycznie ODWOŁUJE zaplanowane sesje
// Bloku Skupienia, gdy zawodnik zgłosi ból wykluczający trening albo silnik
// gotowości wykryje zmęczenie — działa BEZ pytania zawodnika, więc błąd tu
// (np. zły próg cooldownu, złe okno tygodnia, zła kolejność priorytetu
// ból>zmęczenie) realnie kasowałby komuś zaplanowany trening albo, odwrotnie,
// NIE odwoływał mimo aktywnego bólu. Zero testu dotąd.
//
// DLACZEGO Module._resolveFilename NIE jest tu potrzebny (w odróżnieniu od
// test-submit-recommendation-feedback.js): ten plik importuje `_internal` z
// ../api/generate-recommendation, więc wystarczy — dokładnie jak w
// test-training-focus-rotation.js — podmienić require.cache dla TEJ
// lokalnej ścieżki fałszywym eksportem, zanim require('../lib/focus-block-
// adaptation') się wykona. generate-recommendation.js (z prawdziwym
// @supabase/supabase-js w środku) nigdy faktycznie się nie ładuje.
//
// Uruchomienie: node tests/test-focus-block-adaptation.js
// ============================================================

const assert = require('assert');

let fakeReadinessSignals = {};
const genRecStubPath = require.resolve('../api/generate-recommendation.js');
require.cache[genRecStubPath] = {
  id: genRecStubPath,
  filename: genRecStubPath,
  loaded: true,
  exports: {
    _internal: {
      fetchReadinessWindowLogs: async () => [],
      computeReadinessSignals: () => fakeReadinessSignals,
    },
  },
};

const {
  shouldAdapt,
  adaptFocusBlock,
  runFocusBlockAdaptation,
  currentWeekBounds,
} = require('../lib/focus-block-adaptation.js');

let passed = 0;
let failed = 0;
async function scenario(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(`    ${e.stack || e.message}`);
  }
}

// --- Atrapa Supabase ogólnego przeznaczenia (select/update + eq/gte/lte + then) ---
function makeFakeSupabase(seedTables = {}) {
  const state = {};
  Object.keys(seedTables).forEach((t) => { state[t] = seedTables[t].map((r) => ({ ...r })); });
  return {
    _state: state,
    from(table) {
      if (!state[table]) state[table] = [];
      const filters = [];
      let mode = 'select';
      let updatePayload = null;
      const builder = {
        select() { return builder; },
        update(payload) { mode = 'update'; updatePayload = payload; return builder; },
        eq(col, val) { filters.push((row) => row[col] === val); return builder; },
        gte(col, val) { filters.push((row) => row[col] >= val); return builder; },
        lte(col, val) { filters.push((row) => row[col] <= val); return builder; },
        then(resolve, reject) {
          applyAndReturn().then(resolve, reject);
        },
      };
      function applyAndReturn() {
        const rows = state[table].filter((r) => filters.every((f) => f(r)));
        if (mode === 'update') rows.forEach((row) => Object.assign(row, updatePayload));
        return Promise.resolve({ data: rows, error: null });
      }
      return builder;
    },
  };
}

(async () => {
  console.log('focus-block-adaptation.js — testy jednostkowe');

  console.log('\n1. currentWeekBounds — granice tygodnia (poniedziałek-niedziela, UTC)');

  await scenario('środa -> poniedziałek tego tygodnia do niedzieli tego tygodnia', () => {
    const r = currentWeekBounds(new Date('2026-08-05T15:00:00Z')); // środa
    assert.strictEqual(r.start, '2026-08-03'); // poniedziałek
    assert.strictEqual(r.end, '2026-08-09'); // niedziela
  });

  await scenario('poniedziałek -> start = ten sam dzień', () => {
    const r = currentWeekBounds(new Date('2026-08-03T00:00:01Z'));
    assert.strictEqual(r.start, '2026-08-03');
    assert.strictEqual(r.end, '2026-08-09');
  });

  await scenario('niedziela -> end = ten sam dzień, start = poprzedni poniedziałek (nie następny)', () => {
    const r = currentWeekBounds(new Date('2026-08-09T23:59:00Z'));
    assert.strictEqual(r.start, '2026-08-03');
    assert.strictEqual(r.end, '2026-08-09');
  });

  await scenario('godzina dnia nie ma znaczenia — te same granice dla 00:01 i 23:59 tego samego dnia', () => {
    const a = currentWeekBounds(new Date('2026-08-05T00:01:00Z'));
    const b = currentWeekBounds(new Date('2026-08-05T23:59:00Z'));
    assert.deepStrictEqual(a, b);
  });

  await scenario('granica przełomu miesiąca liczona poprawnie (31 sie -> wrzesień)', () => {
    // 2026-08-31 to poniedziałek.
    const r = currentWeekBounds(new Date('2026-08-31T12:00:00Z'));
    assert.strictEqual(r.start, '2026-08-31');
    assert.strictEqual(r.end, '2026-09-06');
  });

  console.log('\n2. shouldAdapt — priorytet sygnałów (atrapa Supabase + atrapa gotowości)');

  await scenario('aktywny ból -> adapt:true, reason:"pain", NIE sprawdza nawet gotowości', () => {
    return (async () => {
      const supabase = makeFakeSupabase({
        pain_entries: [{ id: 'p1', user_id: 'u1', excludes_from_training: true, created_at: new Date().toISOString(), body_location: 'kolano' }],
      });
      fakeReadinessSignals = { sleepFlag: { active: true } }; // gdyby sprawdzał, też by adaptował — test priorytetu niżej to rozdziela
      const r = await shouldAdapt(supabase, 'u1');
      assert.strictEqual(r.adapt, true);
      assert.strictEqual(r.reason, 'pain');
      assert.strictEqual(r.detail.length, 1);
    })();
  });

  await scenario('brak bólu, sleepFlag.active=true -> adapt:true, reason:"fatigue_sleep"', () => {
    return (async () => {
      const supabase = makeFakeSupabase({ pain_entries: [] });
      fakeReadinessSignals = { sleepFlag: { active: true }, coldStartOrBaseline: { tired: true } };
      const r = await shouldAdapt(supabase, 'u1');
      assert.strictEqual(r.adapt, true);
      assert.strictEqual(r.reason, 'fatigue_sleep', 'sleepFlag powinien mieć priorytet nad coldStartOrBaseline');
    })();
  });

  await scenario('brak bólu, brak sleepFlag, coldStartOrBaseline.tired=true -> adapt:true, reason:"fatigue_load"', () => {
    return (async () => {
      const supabase = makeFakeSupabase({ pain_entries: [] });
      fakeReadinessSignals = { sleepFlag: null, coldStartOrBaseline: { tired: true } };
      const r = await shouldAdapt(supabase, 'u1');
      assert.strictEqual(r.adapt, true);
      assert.strictEqual(r.reason, 'fatigue_load');
    })();
  });

  await scenario('brak bólu, brak sygnałów zmęczenia -> adapt:false', () => {
    return (async () => {
      const supabase = makeFakeSupabase({ pain_entries: [] });
      fakeReadinessSignals = { sleepFlag: { active: false }, coldStartOrBaseline: { tired: false } };
      const r = await shouldAdapt(supabase, 'u1');
      assert.strictEqual(r.adapt, false);
    })();
  });

  await scenario('ból zgłoszony, ale excludes_from_training=false (odfiltrowany po stronie zapytania) -> traktowany jak brak bólu', () => {
    return (async () => {
      // Atrapa filtruje po excludes_from_training=true tak samo jak prawdziwy Supabase —
      // wiersz z false nigdy nie trafi do fetchActivePainSignal.
      const supabase = makeFakeSupabase({
        pain_entries: [{ id: 'p1', user_id: 'u1', excludes_from_training: false, created_at: new Date().toISOString() }],
      });
      fakeReadinessSignals = { sleepFlag: { active: false }, coldStartOrBaseline: { tired: false } };
      const r = await shouldAdapt(supabase, 'u1');
      assert.strictEqual(r.adapt, false);
    })();
  });

  console.log('\n3. adaptFocusBlock — cooldown + odwoływanie sesji w bieżącym tygodniu');

  await scenario('brak last_adaptation_at -> adaptuje, odwołuje TYLKO scheduled w bieżącym tygodniu TEGO bloku', () => {
    return (async () => {
      const now = new Date('2026-08-05T12:00:00Z'); // środa, tydzień 2026-08-03..09
      const supabase = makeFakeSupabase({
        calendar_events: [
          { id: 'e1', focus_block_id: 'b1', status: 'scheduled', scheduled_date: '2026-08-06' }, // w tygodniu -> odwołane
          { id: 'e2', focus_block_id: 'b1', status: 'scheduled', scheduled_date: '2026-08-12' }, // POZA tygodniem -> nietknięte
          { id: 'e3', focus_block_id: 'b1', status: 'completed', scheduled_date: '2026-08-06' }, // już zrealizowana -> nietknięta
          { id: 'e4', focus_block_id: 'inny-blok', status: 'scheduled', scheduled_date: '2026-08-06' }, // inny blok -> nietknięty
        ],
        focus_blocks: [{ id: 'b1', last_adaptation_at: null }],
      });
      const r = await adaptFocusBlock(supabase, { id: 'b1', last_adaptation_at: null }, now);
      assert.strictEqual(r.adapted, true);
      assert.strictEqual(r.cancelledCount, 1);
      assert.strictEqual(supabase._state.calendar_events.find((e) => e.id === 'e1').status, 'cancelled');
      assert.strictEqual(supabase._state.calendar_events.find((e) => e.id === 'e2').status, 'scheduled');
      assert.strictEqual(supabase._state.calendar_events.find((e) => e.id === 'e3').status, 'completed');
      assert.strictEqual(supabase._state.calendar_events.find((e) => e.id === 'e4').status, 'scheduled');
      assert.strictEqual(supabase._state.focus_blocks[0].last_adaptation_at, now.toISOString());
    })();
  });

  await scenario('last_adaptation_at 2 dni temu (< cooldown 5 dni) -> adapted:false, reason:"cooldown", NIC nie odwołuje', () => {
    return (async () => {
      const now = new Date('2026-08-05T12:00:00Z');
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const supabase = makeFakeSupabase({
        calendar_events: [{ id: 'e1', focus_block_id: 'b1', status: 'scheduled', scheduled_date: '2026-08-06' }],
      });
      const r = await adaptFocusBlock(supabase, { id: 'b1', last_adaptation_at: twoDaysAgo }, now);
      assert.strictEqual(r.adapted, false);
      assert.strictEqual(r.reason, 'cooldown');
      assert.strictEqual(supabase._state.calendar_events[0].status, 'scheduled', 'cooldown powinien zablokować wszystko, łącznie z odwołaniem sesji');
    })();
  });

  await scenario('last_adaptation_at DOKŁADNIE 5 dni temu -> cooldown minął (< 5, nie <=), adaptuje', () => {
    return (async () => {
      const now = new Date('2026-08-05T12:00:00Z');
      const exactlyFiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
      const supabase = makeFakeSupabase({ calendar_events: [], focus_blocks: [{ id: 'b1' }] });
      const r = await adaptFocusBlock(supabase, { id: 'b1', last_adaptation_at: exactlyFiveDaysAgo }, now);
      assert.strictEqual(r.adapted, true);
    })();
  });

  await scenario('last_adaptation_at 4,9 dnia temu (tuż PRZED progiem) -> wciąż cooldown', () => {
    return (async () => {
      const now = new Date('2026-08-05T12:00:00Z');
      const almostFiveDaysAgo = new Date(now.getTime() - 4.9 * 24 * 60 * 60 * 1000).toISOString();
      const supabase = makeFakeSupabase({ calendar_events: [] });
      const r = await adaptFocusBlock(supabase, { id: 'b1', last_adaptation_at: almostFiveDaysAgo }, now);
      assert.strictEqual(r.adapted, false);
      assert.strictEqual(r.reason, 'cooldown');
    })();
  });

  await scenario('błąd zapisu last_adaptation_at NIE psuje wyniku (adapted:true mimo błędu w drugim kroku)', () => {
    return (async () => {
      const now = new Date('2026-08-05T12:00:00Z');
      const supabase = makeFakeSupabase({ calendar_events: [] });
      const originalFrom = supabase.from.bind(supabase);
      supabase.from = (table) => {
        const builder = originalFrom(table);
        if (table === 'focus_blocks') {
          const origThen = builder.then.bind(builder);
          builder.then = (resolve) => origThen(() => resolve({ data: null, error: { message: 'db unavailable' } }));
        }
        return builder;
      };
      const r = await adaptFocusBlock(supabase, { id: 'b1', last_adaptation_at: null }, now);
      assert.strictEqual(r.adapted, true, 'błąd zapisu znacznika czasu to nie powód, żeby zgłosić adaptację jako nieudaną — sesje i tak zostały odwołane');
    })();
  });

  console.log('\n4. runFocusBlockAdaptation — orkiestracja po wielu blokach');

  await scenario('brak aktywnych bloków -> nic się nie dzieje, results nietknięty', () => {
    return (async () => {
      const supabase = makeFakeSupabase({ focus_blocks: [] });
      const results = {};
      await runFocusBlockAdaptation(supabase, results);
      assert.deepStrictEqual(results, {});
    })();
  });

  await scenario('dwa bloki, jeden wymaga adaptacji (ból) drugi nie -> results.focus_block_adaptation = 1', () => {
    return (async () => {
      const supabase = makeFakeSupabase({
        focus_blocks: [
          { id: 'b1', user_id: 'u1', status: 'active', last_adaptation_at: null },
          { id: 'b2', user_id: 'u2', status: 'active', last_adaptation_at: null },
        ],
        pain_entries: [{ id: 'p1', user_id: 'u1', excludes_from_training: true, created_at: new Date().toISOString() }],
        calendar_events: [],
      });
      fakeReadinessSignals = { sleepFlag: { active: false }, coldStartOrBaseline: { tired: false } };
      const results = {};
      await runFocusBlockAdaptation(supabase, results);
      assert.strictEqual(results.focus_block_adaptation, 1);
    })();
  });

  await scenario('błąd przy jednym bloku NIE przerywa przetwarzania pozostałych (try/catch per blok)', () => {
    return (async () => {
      const supabase = makeFakeSupabase({
        focus_blocks: [
          { id: 'b-blad', user_id: 'u-blad', status: 'active', last_adaptation_at: null },
          { id: 'b-ok', user_id: 'u-ok', status: 'active', last_adaptation_at: null },
        ],
        pain_entries: [{ id: 'p1', user_id: 'u-ok', excludes_from_training: true, created_at: new Date().toISOString() }],
        calendar_events: [],
      });
      const originalFrom = supabase.from.bind(supabase);
      let painEntriesCallCount = 0;
      supabase.from = (table) => {
        if (table === 'pain_entries') {
          painEntriesCallCount++;
          if (painEntriesCallCount === 1) {
            // Rzuca WYŁĄCZNIE przy pierwszym wywołaniu (blok b-blad, przetwarzany pierwszy —
            // kolejność z tablicy focus_blocks poniżej) — kolejne wywołania (b-ok) działają
            // normalnie, żeby test faktycznie sprawdzał "jeden błąd nie blokuje reszty", a nie
            // przypadkiem psuł wszystkie bloki naraz.
            throw new Error('symulowana awaria bazy dla u-blad');
          }
        }
        return originalFrom(table);
      };
      fakeReadinessSignals = { sleepFlag: { active: false }, coldStartOrBaseline: { tired: false } };
      const results = {};
      await runFocusBlockAdaptation(supabase, results);
      assert.strictEqual(results.focus_block_adaptation, 1, 'drugi blok powinien zostać przetworzony mimo błędu przy pierwszym');
    })();
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();

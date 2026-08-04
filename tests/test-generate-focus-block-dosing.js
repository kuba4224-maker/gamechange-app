// ============================================================
// GAMECHANGE — tests/test-generate-focus-block-dosing.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, czwarta runda — kontynuacja "Pracuj dalej").
// generate-focus-block-dosing.js zawiera WŁASNĄ, świadomie zduplikowaną
// kopię silnika sygnałów gotowości (computeReadinessSignals i spółka) —
// ten sam kod co w generate-recommendation.js (patrz komentarz na górze
// tamtego pliku, Krok 0, punkt 1: "skopiowane stąd 1:1"). To oznacza, że
// ten test pokrywa NIE TYLKO ten plik, ale pośrednio weryfikuje poprawność
// tego samego wzoru matematycznego, który napędza też Centrum Decyzji
// zawodnika — błąd znaleziony/potwierdzony tutaj prawdopodobnie istnieje
// też tam. Zero testu dotąd dla żadnej z dwóch kopii.
//
// Przy okazji: ten plik (i dwa sąsiednie z tej samej sesji 31.07.2026 —
// generate-focus-block-content.js, validate-goal-refinement.js) miał ten
// sam nieaktualny placeholder ANTHROPIC_MODEL co D3/D6 z audytu spójności —
// poprawiony dziś przy okazji budowania tego testu (patrz diff w tych
// trzech plikach), Pakiet 10 (03-04.08.2026) go tam po prostu przeoczył.
//
// Testuje WYŁĄCZNIE funkcje czyste z `_internal` (resolvePillar,
// computeReadinessSignals, buildReadinessNarrative, buildSystemPrompt,
// buildUserPrompt, stripMarkdownJsonFence) + `fetchKnowledgeBase`/
// `fetchEquipment`/`fetchComponentOrCustom` z atrapą Supabase. Świadomie
// NIE `generateFocusBlockDosing()` całościowo (wymagałoby atrapy
// callAnthropic/fetch) ani `callAnthropic` (prawdziwe I/O sieciowe) — ten
// sam, ustalony w tym projekcie zakres testów.
//
// Zero atrap require.cache potrzebnych — ten plik importuje WYŁĄCZNIE
// @supabase/supabase-js (niepotrzebny dla żadnej z testowanych tu funkcji,
// bo wszystkie biorą `supabase` jako parametr zamiast go same konstruować
// -- OPRÓCZ samego modułu, który i tak trzeba zaimportować, więc atrapa
// pakietu jest konieczna identycznie jak w test-coach-chat.js).
//
// Uruchomienie: node tests/test-generate-focus-block-dosing.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_4__.js');
require.cache[supabaseStubPath] = {
  id: supabaseStubPath,
  filename: supabaseStubPath,
  loaded: true,
  exports: { createClient: () => ({}) },
};
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@supabase/supabase-js') return supabaseStubPath;
  return originalResolveFilename.call(this, request, ...rest);
};

const {
  resolvePillar,
  computeReadinessSignals,
  buildReadinessNarrative,
  fetchKnowledgeBase,
  fetchEquipment,
  fetchComponentOrCustom,
  buildSystemPrompt,
  buildUserPrompt,
  stripMarkdownJsonFence,
} = require('../api/generate-focus-block-dosing.js')._internal;

Module._resolveFilename = originalResolveFilename;

let passed = 0;
let failed = 0;
function scenario(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(`    ${e.stack || e.message}`);
  }
}
async function scenarioAsync(name, fn) {
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

// --- Helpery do budowania fixture'ów logów ---
const DAY_MS = 24 * 60 * 60 * 1000;
function isoDaysAgo(now, n, hour = '07:00:00') {
  return new Date(now.getTime() - n * DAY_MS).toISOString().slice(0, 10) + `T${hour}Z`;
}
function morning(now, daysAgo, payload) {
  return { entry_type: 'morning', payload, created_at: isoDaysAgo(now, daysAgo, '07:00:00') };
}
function training(now, daysAgo, rpe, durationMinutes) {
  return { entry_type: 'post_training', payload: { rpe, duration_minutes: durationMinutes }, created_at: isoDaysAgo(now, daysAgo, '18:00:00') };
}

(async () => {
  console.log('generate-focus-block-dosing.js _internal — testy jednostkowe');

  console.log('\n1. resolvePillar');

  scenario('segment znany -> poprawny filar', () => {
    assert.strictEqual(resolvePillar('moc'), 'Filar 1 — Dominacja fizyczna');
    assert.strictEqual(resolvePillar('koncentracja'), 'Filar 4 — Mentalność');
  });

  scenario('segment nieznany -> null', () => {
    assert.strictEqual(resolvePillar('cos-nieznanego'), null);
  });

  console.log('\n2. stripMarkdownJsonFence');

  scenario('czysty JSON bez ogrodzenia -> bez zmian', () => {
    assert.strictEqual(stripMarkdownJsonFence('{"a":1}'), '{"a":1}');
  });

  scenario('JSON owinięty w ```json ... ``` -> wyciągnięty', () => {
    assert.strictEqual(stripMarkdownJsonFence('```json\n{"a":1}\n```'), '{"a":1}');
  });

  scenario('JSON owinięty w ``` ... ``` (bez słowa json) -> wyciągnięty', () => {
    assert.strictEqual(stripMarkdownJsonFence('```\n{"a":1}\n```'), '{"a":1}');
  });

  scenario('nadmiarowe białe znaki dookoła -> przycięte', () => {
    assert.strictEqual(stripMarkdownJsonFence('   {"a":1}   '), '{"a":1}');
  });

  console.log('\n3. buildReadinessNarrative');

  scenario('brak sygnałów (null) -> pusta lista', () => {
    assert.deepStrictEqual(buildReadinessNarrative(null), []);
  });

  scenario('wszystkie flagi nieaktywne -> pusta lista', () => {
    const r = buildReadinessNarrative({ weeklyLoadSpike: null, sleepFlag: { active: false }, coldStartOrBaseline: { tired: false }, moodFlag: { active: false } });
    assert.deepStrictEqual(r, []);
  });

  scenario('weeklyLoadSpike aktywny -> linia z procentem wzrostu', () => {
    const r = buildReadinessNarrative({ weeklyLoadSpike: { active: true, changePct: 0.25 }, sleepFlag: { active: false }, coldStartOrBaseline: { tired: false }, moodFlag: { active: false } });
    assert.strictEqual(r.length, 1);
    assert.match(r[0], /25%/);
  });

  scenario('sleepFlag aktywny -> linia o śnie', () => {
    const r = buildReadinessNarrative({ sleepFlag: { active: true }, coldStartOrBaseline: { tired: false }, moodFlag: { active: false } });
    assert.strictEqual(r.length, 1);
    assert.match(r[0], /sen poniżej 7h/);
  });

  scenario('coldStartOrBaseline.tired -> linia o zmęczeniu', () => {
    const r = buildReadinessNarrative({ coldStartOrBaseline: { tired: true }, sleepFlag: { active: false }, moodFlag: { active: false } });
    assert.match(r[0], /zmęczenie/);
  });

  scenario('moodFlag aktywny -> linia z instrukcją łagodnego tonu, NIE wspomina wprost o nastroju w uzasadnieniu', () => {
    const r = buildReadinessNarrative({ moodFlag: { active: true }, sleepFlag: { active: false }, coldStartOrBaseline: { tired: false } });
    assert.match(r[0], /TON WYŁĄCZNIE łagodny/);
    assert.match(r[0], /nastoletni zawodnik/);
  });

  scenario('kilka flag naraz -> kilka linii, w ustalonej kolejności (load, sleep, fatigue, mood)', () => {
    const r = buildReadinessNarrative({
      weeklyLoadSpike: { active: true, changePct: 0.2 },
      sleepFlag: { active: true },
      coldStartOrBaseline: { tired: true },
      moodFlag: { active: true },
    });
    assert.strictEqual(r.length, 4);
    assert.match(r[0], /tygodniowe obciążenie/);
    assert.match(r[1], /sen poniżej 7h/);
    assert.match(r[2], /zmęczenie/);
    assert.match(r[3], /TON WYŁĄCZNIE łagodny/);
  });

  console.log('\n4. buildSystemPrompt / buildUserPrompt');

  scenario('buildSystemPrompt: knowledgeBaseContent wstrzyknięty, gdy podany', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: '###KB-TEST###', segmentId: 'moc' });
    assert.ok(p.includes('###KB-TEST###'));
  });

  scenario('buildSystemPrompt: brak knowledgeBaseContent -> nie wywala się, brak bloku bazy wiedzy', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: null, segmentId: 'moc' });
    assert.ok(!p.includes('BAZA WIEDZY GAMECHANGE'));
  });

  scenario('buildSystemPrompt: segmentId="techSpec" -> dodatkowa nota ostrożności', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: null, segmentId: 'techSpec' });
    assert.match(p, /słabiej ugruntowana naukowo/);
  });

  scenario('buildSystemPrompt: inny segmentId -> BRAK noty o technice specjalistycznej', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: null, segmentId: 'moc' });
    assert.ok(!p.includes('słabiej ugruntowana naukowo'));
  });

  scenario('buildSystemPrompt: wymusza że nie zwiększa samodzielnie liczby sesji, format JSON z days/durationMinutes/weeks/reasoning', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: null, segmentId: 'moc' });
    assert.match(p, /nie zwiększaj jej samodzielnie/);
    assert.match(p, /"days"/);
    assert.match(p, /"durationMinutes"/);
    assert.match(p, /"weeks"/);
    assert.match(p, /"reasoning"/);
  });

  scenario('buildUserPrompt: sprzęt podany -> wypisany, oddzielony przecinkami', () => {
    const p = buildUserPrompt({ segmentId: 'moc', elementDescription: 'X', sessionsPerWeek: 3, equipment: ['hantle', 'guma oporowa'], readinessLines: [] });
    assert.match(p, /hantle, guma oporowa/);
  });

  scenario('buildUserPrompt: brak sprzętu -> komunikat o braku, nie pusty string', () => {
    const p = buildUserPrompt({ segmentId: 'moc', elementDescription: 'X', sessionsPerWeek: 3, equipment: [], readinessLines: [] });
    assert.match(p, /brak zadeklarowanego dodatkowego sprzętu/);
  });

  scenario('buildUserPrompt: brak sygnałów gotowości -> komunikat "standardowy zakres"', () => {
    const p = buildUserPrompt({ segmentId: 'moc', elementDescription: 'X', sessionsPerWeek: 3, equipment: [], readinessLines: [] });
    assert.match(p, /możesz zaproponować standardowy zakres/);
  });

  scenario('buildUserPrompt: sygnały gotowości podane -> wstrzyknięte zamiast komunikatu domyślnego', () => {
    const p = buildUserPrompt({ segmentId: 'moc', elementDescription: 'X', sessionsPerWeek: 3, equipment: [], readinessLines: ['SYGNAŁ TESTOWY XYZ'] });
    assert.match(p, /SYGNAŁ TESTOWY XYZ/);
    assert.ok(!p.includes('możesz zaproponować standardowy zakres'));
  });

  scenario('buildUserPrompt: nieznany segmentId -> pokazuje surowe id, nie "undefined"', () => {
    const p = buildUserPrompt({ segmentId: 'segment-obcy', elementDescription: 'X', sessionsPerWeek: 3, equipment: [], readinessLines: [] });
    assert.match(p, /segment-obcy/);
  });

  console.log('\n5. computeReadinessSignals — pusty wsad');

  scenario('brak logów -> wszystkie flagi nieaktywne/null, brak crasha', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const s = computeReadinessSignals([], now);
    assert.strictEqual(s.weeklyLoadSpike, null);
    assert.strictEqual(s.sleepFlag.active, false);
    assert.strictEqual(s.moodFlag.active, false);
    assert.strictEqual(s.coldStartOrBaseline.insufficientData, true);
  });

  console.log('\n6. computeReadinessSignals — sleepFlag (sen < 7h, 2 noce z rzędu)');

  scenario('2 kolejne noce <7h -> sleepFlag aktywny', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [morning(now, 1, { sleep_hours: 6 }), morning(now, 0, { sleep_hours: 6.5 })];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.sleepFlag.active, true);
  });

  scenario('2 noce, ale NIE kolejne (przerwa) -> sleepFlag NIEaktywny', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [morning(now, 3, { sleep_hours: 5 }), morning(now, 0, { sleep_hours: 5 })];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.sleepFlag.active, false);
  });

  scenario('tylko jeden dzień z niskim snem -> sleepFlag NIEaktywny (potrzeba 2)', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [morning(now, 0, { sleep_hours: 4 })];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.sleepFlag.active, false);
  });

  scenario('2 kolejne noce, ale jedna >=7h -> sleepFlag NIEaktywny (obie muszą być <7)', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [morning(now, 1, { sleep_hours: 6 }), morning(now, 0, { sleep_hours: 8 })];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.sleepFlag.active, false);
  });

  console.log('\n7. computeReadinessSignals — moodFlag (nastrój/motywacja <=4, 2 dni z rzędu)');

  scenario('2 kolejne dni mood_motivation<=4 -> moodFlag aktywny, requiresGentleTone', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [morning(now, 1, { mood_motivation: 3 }), morning(now, 0, { mood_motivation: 4 })];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.moodFlag.active, true);
    assert.strictEqual(s.moodFlag.requiresGentleTone, true);
  });

  scenario('mood_motivation powyżej progu (5) -> moodFlag NIEaktywny', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [morning(now, 1, { mood_motivation: 5 }), morning(now, 0, { mood_motivation: 5 })];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.moodFlag.active, false);
  });

  console.log('\n8. computeReadinessSignals — coldStartOrBaseline, tryb cold_start (<14 wpisów porannych w 21 dni)');

  scenario('wysokie RPE (avg>=7) + słaby sen poranny 2 dni z rzędu -> tired:true, mode cold_start', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [
      morning(now, 1, { sleep_quality: 3 }),
      morning(now, 0, { sleep_quality: 3 }),
      training(now, 5, 8, 60),
      training(now, 6, 8, 60),
      training(now, 7, 8, 60),
    ];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.coldStartOrBaseline.mode, 'cold_start');
    assert.strictEqual(s.coldStartOrBaseline.tired, true);
  });

  scenario('niskie RPE (avg<7) mimo słabego snu -> tired:false (oba warunki muszą być spełnione naraz)', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [
      morning(now, 1, { sleep_quality: 3 }),
      morning(now, 0, { sleep_quality: 3 }),
      training(now, 5, 3, 60),
      training(now, 6, 3, 60),
      training(now, 7, 3, 60),
    ];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.coldStartOrBaseline.tired, false);
  });

  scenario('wysokie RPE, ale sen w normie (>4) -> tired:false', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [
      morning(now, 1, { sleep_quality: 8 }),
      morning(now, 0, { sleep_quality: 8 }),
      training(now, 5, 9, 60),
      training(now, 6, 9, 60),
      training(now, 7, 9, 60),
    ];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.coldStartOrBaseline.tired, false);
  });

  scenario('mniej niż 3 treningi -> insufficientData:true, tired:false (nie zgaduje z niepełnych danych)', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [morning(now, 1, { sleep_quality: 2 }), morning(now, 0, { sleep_quality: 2 }), training(now, 1, 9, 60)];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.coldStartOrBaseline.insufficientData, true);
    assert.strictEqual(s.coldStartOrBaseline.tired, false);
  });

  console.log('\n9. computeReadinessSignals — coldStartOrBaseline, tryb baseline (>=14 wpisów porannych w 21 dni)');

  scenario('>=14 wpisów porannych stabilnych + ostatnie 2 dni WYRAŹNIE odbiegają od mediany -> mode:baseline, tired:true', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [];
    // 14 stabilnych dni bazowych (dni 3..16 wstecz), sleep_quality=7 (normalny sen).
    for (let d = 3; d <= 16; d++) logs.push(morning(now, d, { sleep_quality: 7, morning_fatigue: 3 }));
    // Ostatnie 2 dni (dziś, wczoraj) — WYRAŹNIE gorszy sen.
    logs.push(morning(now, 1, { sleep_quality: 2 }));
    logs.push(morning(now, 0, { sleep_quality: 2 }));
    // 10 treningów "normalnych" (rpe=5) rozsianych w oknie + ostatnie 3 wyraźnie cięższe (rpe=8).
    for (let d = 4; d <= 13; d++) logs.push(training(now, d, 5, 60));
    logs.push(training(now, 1, 8, 60));
    logs.push(training(now, 2, 8, 60));
    logs.push(training(now, 3, 8, 60));

    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.coldStartOrBaseline.mode, 'baseline');
    assert.strictEqual(s.coldStartOrBaseline.tired, true, `oczekiwano tired:true, dostano: ${JSON.stringify(s.coldStartOrBaseline)}`);
  });

  scenario('>=14 wpisów porannych, WSZYSTKO stabilne (bez odchylenia) -> mode:baseline, tired:false', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [];
    for (let d = 0; d <= 16; d++) logs.push(morning(now, d, { sleep_quality: 7, morning_fatigue: 3 }));
    for (let d = 1; d <= 13; d++) logs.push(training(now, d, 5, 60));
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.coldStartOrBaseline.mode, 'baseline');
    assert.strictEqual(s.coldStartOrBaseline.tired, false);
  });

  console.log('\n10. computeReadinessSignals — weeklyLoadSpike (wymaga >=13 dni rozpiętości danych)');

  scenario('rozpiętość danych <13 dni -> weeklyLoadSpike zostaje null, niezależnie od obciążenia', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [training(now, 0, 10, 100), training(now, 5, 10, 100)]; // rozpiętość 5 dni
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.weeklyLoadSpike, null);
  });

  scenario('wzrost obciążenia >=15% tydzień do tygodnia (rozpiętość >=13 dni) -> aktywny, poprawny changePct', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [
      training(now, 15, 1, 1), // tylko po to, żeby rozpiętość osiągnęła >=13 dni
      training(now, 10, 8, 100), // "poprzedni tydzień" (dni 7-13 wstecz): load=800
      training(now, 0, 10, 100), // "bieżący tydzień" (dni 0-6 wstecz): load=1000
    ];
    const s = computeReadinessSignals(logs, now);
    assert.ok(s.weeklyLoadSpike, 'weeklyLoadSpike nie powinien być null przy rozpiętości >=13 dni i obu tygodniach z obciążeniem');
    assert.strictEqual(s.weeklyLoadSpike.active, true);
    assert.ok(Math.abs(s.weeklyLoadSpike.changePct - 0.25) < 0.001, `oczekiwano ~0.25, dostano ${s.weeklyLoadSpike.changePct}`);
  });

  scenario('brak zmiany obciążenia (0%) -> weeklyLoadSpike obecny, ale active:false', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [
      training(now, 15, 1, 1),
      training(now, 10, 5, 100),
      training(now, 0, 5, 100),
    ];
    const s = computeReadinessSignals(logs, now);
    assert.ok(s.weeklyLoadSpike);
    assert.strictEqual(s.weeklyLoadSpike.active, false);
  });

  scenario('poprzedni tydzień bez ŻADNEGO obciążenia (prevWeek=0) -> weeklyLoadSpike zostaje null (dzielenie przez zero uniknięte)', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    const logs = [
      training(now, 15, 1, 1),
      training(now, 0, 10, 100), // tylko bieżący tydzień ma obciążenie
    ];
    const s = computeReadinessSignals(logs, now);
    assert.strictEqual(s.weeklyLoadSpike, null);
  });

  console.log('\n11. fetchKnowledgeBase / fetchEquipment / fetchComponentOrCustom — atrapa Supabase');

  function makeFakeSupabase(tables) {
    return {
      from(table) {
        const filters = [];
        const builder = {
          select() { return builder; },
          eq(col, val) { filters.push((row) => row[col] === val); return builder; },
          maybeSingle() {
            const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
            return Promise.resolve({ data: rows[0] || null, error: null });
          },
        };
        return builder;
      },
    };
  }

  await scenarioAsync('fetchKnowledgeBase: segment istnieje -> zwraca content', async () => {
    const supabase = makeFakeSupabase({ knowledge_base_entries: [{ segment_id: 'moc', content: 'Treść.' }] });
    const r = await fetchKnowledgeBase(supabase, 'moc');
    assert.strictEqual(r, 'Treść.');
  });

  await scenarioAsync('fetchKnowledgeBase: segment nie istnieje -> null (nie rzuca)', async () => {
    const supabase = makeFakeSupabase({ knowledge_base_entries: [] });
    const r = await fetchKnowledgeBase(supabase, 'brak');
    assert.strictEqual(r, null);
  });

  await scenarioAsync('fetchEquipment: profil istnieje -> zwraca equipment_access', async () => {
    const supabase = makeFakeSupabase({ player_profiles: [{ user_id: 'u1', equipment_access: ['hantle'] }] });
    const r = await fetchEquipment(supabase, 'u1');
    assert.deepStrictEqual(r, ['hantle']);
  });

  await scenarioAsync('fetchEquipment: brak profilu/pola -> pusta tablica (nie null/undefined)', async () => {
    const supabase = makeFakeSupabase({ player_profiles: [] });
    const r = await fetchEquipment(supabase, 'brak-usera');
    assert.deepStrictEqual(r, []);
  });

  await scenarioAsync('fetchComponentOrCustom: customDescription podany -> zwraca go WPROST, nie odpytuje bazy', async () => {
    const supabase = makeFakeSupabase({});
    const r = await fetchComponentOrCustom(supabase, null, 'Mój własny opis');
    assert.strictEqual(r, 'Mój własny opis');
  });

  await scenarioAsync('fetchComponentOrCustom: componentId podany, brak custom -> "nazwa: opis" ze bazy', async () => {
    const supabase = makeFakeSupabase({ segment_components: [{ id: 'c1', name: 'Przysiad', description: 'Podstawowe ćwiczenie nóg.' }] });
    const r = await fetchComponentOrCustom(supabase, 'c1', null);
    assert.strictEqual(r, 'Przysiad: Podstawowe ćwiczenie nóg.');
  });

  await scenarioAsync('fetchComponentOrCustom: brak obu -> null', async () => {
    const supabase = makeFakeSupabase({});
    const r = await fetchComponentOrCustom(supabase, null, null);
    assert.strictEqual(r, null);
  });

  await scenarioAsync('fetchComponentOrCustom: componentId nieistniejący -> null (nie rzuca)', async () => {
    const supabase = makeFakeSupabase({ segment_components: [] });
    const r = await fetchComponentOrCustom(supabase, 'brak-takiego', null);
    assert.strictEqual(r, null);
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();

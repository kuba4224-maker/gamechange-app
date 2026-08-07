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
  // DOZOWANIE A6 08.08.2026
  describeDayGaps,
  describeDosingState,
  // TERMINARZ A7 08.08.2026
  buildMatchScheduleLines,
  describeMatchGap,
  dayIndexOfDate,
} = require('../api/generate-focus-block-dosing.js')._internal;

Module._resolveFilename = originalResolveFilename;

// DOZOWANIE A6 08.08.2026 — warstwa czysta z rundy 4, IMPORTOWANA (nie kopia).
// Ten sam plik, ta sama bramka A9, te same filtry co w silniku rekomendacji
// i w fazie 2 Bloku. Test kontraktowy tej bramki: tests/test-bramka-a9-kontrakt.js.
const {
  selectHintsForPrompt,
  buildHintPromptBlock,
} = require('../lib/recommendation-hints.js');

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

  // ============================================================
  // DOZOWANIE A6 08.08.2026 — GRUPY 12–14
  // ============================================================
  // Faza 1 (dozowanie: dni, minuty, tygodnie) dostała podpowiedzi z materiałów.
  // Wiersze niżej to WSZYSTKIE 18 podpowiedzi segmentu `moc`, przepisane 1:1
  // z migracji rundy 3 (`claude/PODPOWIEDZI_Z_MATERIALOW_A.md`, sekcja 4.3,
  // KROK 2). Nazwy pól = nazwy kolumn `component_hints`, bez skrótów.
  //
  // `moc` jest tu wybrana świadomie, a nie dla wygody: to jedyny segment,
  // w którym materiał zawiera regułę oznaczoną jako BEZWZGLĘDNA i dotyczącą
  // wprost tego, co ten endpoint rozstrzyga (`moc-segment-01`, odstęp 48 h).
  // ============================================================

  const M_MOC = 'Moc — System Gamechange (pełny)';
  const O_SILA = 'Potencjał siłowy (siła maksymalna)';
  const O_RFD = 'Wykorzystanie siły / RFD';
  const O_SSC = 'Recykling energii sprężystej (plyometria/SSC)';
  function wiersz(klucz, component_id, obszar_name, element_name, hint, rodzaj, strony, dowody, pozycja) {
    return {
      klucz, segment_id: 'moc', component_id, obszar_name, element_name, hint,
      odbiorca: 'zawodnik', min_age: null, rodzaj, zrodlo: M_MOC, strony, dowody,
      pozycja, active: true,
    };
  }
  const MOC_HINTS = [
    wiersz('moc-baza-siowa-dolnych-partii-przysiad-martwy-ci-01', 'comp-baza', O_SILA, 'Baza siłowa dolnych partii (przysiad/martwy ciąg)', 'Jeśli masz mało czasu, trenuj nogi i biodra. To one generują eksplozję w piłce — góra ciała tylko wspiera kontakt. Przy pełnym czasie pracuj nad obiema.', 'zrobic', '3', null, 1),
    wiersz('moc-baza-siowa-dolnych-partii-przysiad-martwy-ci-02', 'comp-baza', O_SILA, 'Baza siłowa dolnych partii (przysiad/martwy ciąg)', 'Przysiad i martwy ciąg rób w 2–4 seriach po 5–15 powtórzeń. Ciężar dobierz tak, żeby ostatnie powtórzenia były naprawdę ciężkie, ale technika się nie sypała.', 'zrobic', '2, 5', null, 2),
    wiersz('moc-baza-siowa-dolnych-partii-przysiad-martwy-ci-03', 'comp-baza', O_SILA, 'Baza siłowa dolnych partii (przysiad/martwy ciąg)', 'Test startowy: przysiad z maksymalnym ciężarem przy poprawnej technice. Poniżej 1× masy ciała — nisko, 1–1,5× — średnio, powyżej 1,5× — wysoko. Zrób go przed pierwszą sesją i zapisz.', 'zrobic', '2', null, 3),
    wiersz('moc-trening-jednostronny-unilateralny-01', 'comp-unilateralny', O_SILA, 'Trening jednostronny (unilateralny)', 'W planie mocy dwa ćwiczenia robisz na jedną stronę: most biodrowy jednonóż i wyciskanie kettla w klęku jednonóż. 2–4 serie po 5–15 powtórzeń na stronę.', 'zrobic', '10', null, 1),
    wiersz('moc-trening-balistyczny-olimpijski-o-niskim-obci-01', 'comp-balistyczny', O_RFD, 'Trening balistyczny/olimpijski o niskim obciążeniu', 'Każde powtórzenie w bloku plyometrii wykonuj z maksymalną eksplozją, a między seriami odpoczywaj 60–120 sekund. W tym bloku nie ma miejsca na zmęczenie.', 'zrobic', '8', null, 1),
    wiersz('moc-trening-balistyczny-olimpijski-o-niskim-obci-02', 'comp-balistyczny', O_RFD, 'Trening balistyczny/olimpijski o niskim obciążeniu', 'Plyometria góry ciała to rzut piłką lekarską w ziemię, rzut rotacyjny i wycisko-podrzut hantlą: 2–4 serie po 4–6 powtórzeń.', 'zrobic', '5, 9', null, 2),
    wiersz('moc-stabilizacja-tuowia-jako-warunek-wstepny-01', 'comp-stabilizacja', O_RFD, 'Stabilizacja tułowia jako warunek wstępny', 'Blok stabilizacji rób zawsze jako pierwszy w sesji. Uczy ciało szczelności, zanim zaczniesz generować duże siły.', 'zrobic', '7', null, 1),
    wiersz('moc-stabilizacja-tuowia-jako-warunek-wstepny-02', 'comp-stabilizacja', O_RFD, 'Stabilizacja tułowia jako warunek wstępny', 'Trzy ćwiczenia stabilizacji: martwy robal 4–6 powtórzeń na stronę, deska boczna z pracą biodra 10–20 na stronę, wiosłowanie renegata 4–6 na stronę.', 'zrobic', '5, 7', null, 2),
    wiersz('moc-stabilizacja-tuowia-jako-warunek-wstepny-03', 'comp-stabilizacja', O_RFD, 'Stabilizacja tułowia jako warunek wstępny', 'Stabilizacja ma trzy zadania: nie dać się wygiąć do przodu, nie dać się złamać na bok i nie dać się niekontrolowanie skręcić. Do każdego jest inne ćwiczenie.', 'zrozumiec', '13', null, 3),
    wiersz('moc-skoki-reaktywne-drop-jumps-depth-jumps-01', 'comp-skoki', O_SSC, 'Skoki reaktywne (drop jumps, depth jumps)', 'Test sprężystości: szybkie skoki pogo przez 10 sekund. Jeśli zapadasz się i kontakt z podłożem jest długi, to jest Twoje najsłabsze ogniwo.', 'zrobic', '2', null, 1),
    wiersz('moc-skoki-reaktywne-drop-jumps-depth-jumps-02', 'comp-skoki', O_SSC, 'Skoki reaktywne (drop jumps, depth jumps)', 'Jeśli słaby jest recykling, w plyometrii skracaj czas kontaktu z podłożem i odbijaj się natychmiast po lądowaniu. Serię przerywasz, gdy ruch traci lekkość.', 'zrobic', '12', null, 2),
    wiersz('moc-recykling-energii-sprezystej-plyometria-ssc-01', 'comp-recykling', O_SSC, null, 'Cykl rozciągnięcie-skurcz ma dwie prędkości: wolną (skok na maksymalną wysokość, powyżej 0,25 s) i szybką (sprint i zmiana kierunku, poniżej 0,25 s). W piłce potrzebujesz obu — dlatego w planie są trzy płaszczyzny skoków.', 'zrozumiec', '13', null, 1),
    wiersz('moc-segment-01', null, null, null, 'Między sesjami zostaw minimum 48 godzin przerwy, szczególnie po plyometrii. Mecz powinien być co najmniej 48 godzin po sesji plyometrycznej.', 'zrobic', '4', 'materiał podaje jako regułę bezwzględną', 1),
    wiersz('moc-segment-02', null, null, null, 'Tygodnie 1–2 to adaptacja: 1–2 sesje, ciężary poniżej maksimum, priorytet technika. Od tygodnia 3 do 6: 2–3 sesje, każda na tyle wymagająca, żeby ciało dostało sygnał.', 'zrobic', '4', null, 2),
    wiersz('moc-segment-03', null, null, null, 'Zakwasy (ogólny dyskomfort, mija po 1–2 dniach) — nie zmniejszaj trudności. Ból punktowy w jednym miejscu, utrzymujący się kilka dni — zmniejsz trudność na następnym treningu. Nie ignoruj tego sygnału.', 'zrozumiec', '12', null, 3),
    wiersz('moc-segment-04', null, null, null, 'Progres nie zachodzi podczas treningu, tylko podczas regeneracji po nim. Twoje zadanie to dać ciału bodziec i skończyć.', 'zrozumiec', '3', null, 4),
    wiersz('moc-segment-05', null, null, null, 'Po 6 tygodniach powtórz testy startowe. Ale ważniejsze pytanie brzmi: czy wygrywasz starty, które wcześniej przegrywałeś?', 'zrobic', '11', null, 5),
    wiersz('moc-segment-06', null, null, null, 'Poprawa wyników testów nie oznacza automatycznie poprawy w grze. Najpierw rośnie potencjał, dopiero potem — przez miesiące gry — organizm uczy się go używać na boisku.', 'zrozumiec', '11', null, 6),
  ];

  const KB_TEST = 'Baza wiedzy testowa dla segmentu — jeden akapit, dokładnie jak w knowledge_base_entries.';
  function selekcja({ goal = null, limit = 12, rows = MOC_HINTS, wiek = 14 } = {}) {
    return selectHintsForPrompt({ hints: rows, goalComponentId: goal, ageLowerBound: wiek, limit });
  }

  console.log('\n12. DOZOWANIE A6 — ścieżka BEZ podpowiedzi jest identyczna CO DO ZNAKU');

  // Szablony przepisane 1:1 z pliku SPRZED tej rundy (odczytanego z dysku Kuby
  // zanim cokolwiek zmieniłem). md5 jest mocniejszym dowodem niż długość —
  // rozmiar może się zgadzać przy podmienionym znaku, md5 nie.
  const MD5_SPRZED_RUNDY_6 = {
    'moc, bez bazy wiedzy': { dl: 1600, md5: '9ce451717dadcbeda0f62cb562f9c57c', arg: { knowledgeBaseContent: null, segmentId: 'moc' } },
    'moc, z bazą wiedzy': { dl: 1770, md5: '7d118851f22d821405dab763101b6693', arg: { knowledgeBaseContent: KB_TEST, segmentId: 'moc' } },
    'techSpec, z bazą wiedzy': { dl: 2025, md5: 'a8466921be5cf2d74723a271396ac65b', arg: { knowledgeBaseContent: KB_TEST, segmentId: 'techSpec' } },
  };
  const crypto = require('crypto');
  const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

  for (const [nazwa, oczek] of Object.entries(MD5_SPRZED_RUNDY_6)) {
    scenario(`${nazwa}: prompt BEZ podpowiedzi = stan sprzed rundy 6 (md5 + długość)`, () => {
      const p = buildSystemPrompt(oczek.arg);
      assert.strictEqual(p.length, oczek.dl, `długość: ${p.length} zamiast ${oczek.dl}`);
      assert.strictEqual(md5(p), oczek.md5, 'md5 promptu bez podpowiedzi rozjechał się ze stanem sprzed rundy 6');
    });

    scenario(`${nazwa}: hintSelection z PUSTĄ listą też nie zmienia ani znaku`, () => {
      const p = buildSystemPrompt({ ...oczek.arg, hintSelection: { hints: [] } });
      assert.strictEqual(md5(p), oczek.md5);
    });
  }

  scenario('brak tabeli component_hints (hintSelection = null) -> prompt bez sekcji podpowiedzi i bez pola used_hint_klucz', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: null });
    assert.ok(!p.includes('PODPOWIEDZI Z MATERIAŁÓW'));
    assert.ok(!p.includes('used_hint_klucz'));
    assert.ok(!p.includes('JAK ICH UŻYĆ PRZY DOZOWANIU'));
  });

  console.log('\n13. DOZOWANIE A6 — podpowiedzi WCHODZĄ do promptu fazy 1');

  scenario('sekcja podpowiedzi jest w promptcie, z kluczem, materiałem i stroną w każdej linii', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: selekcja() });
    assert.ok(p.includes('PODPOWIEDZI Z MATERIAŁÓW GAMECHANGE'));
    assert.ok(p.includes('(moc-segment-01)'));
    assert.ok(p.includes('Moc — System Gamechange (pełny), s. 4'));
  });

  scenario('REGUŁA BEZWZGLĘDNA moc-segment-01 (48 h przerwy) JEST w promptcie — to jest cały powód tej rundy', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: selekcja() });
    assert.ok(p.includes('minimum 48 godzin przerwy'), 'reguła bezwzględna musi trafić do promptu fazy 1');
    assert.ok(p.includes('[materiał deklaruje: materiał podaje jako regułę bezwzględną]'),
      'oznaczenie reguły bezwzględnej musi jechać razem z treścią, inaczej model nie odróżni jej od reszty');
  });

  scenario('reguła bezwzględna przechodzi TAKŻE wtedy, gdy Blok ma wybrany Element (nie wypada za celowaniem)', () => {
    const sel = selekcja({ goal: 'comp-skoki' });
    assert.ok(sel.hints.some((h) => h.klucz === 'moc-segment-01'));
    assert.strictEqual(sel.hints[0].celowanie, 'element_celu', 'Element celu ma być pierwszy');
  });

  scenario('instrukcja fazy 1 mówi WPROST, że podpowiedź o odstępach WIĄŻE days/durationMinutes/weeks', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: selekcja() });
    assert.match(p, /JAK ICH UŻYĆ PRZY DOZOWANIU/);
    assert.match(p, /ograniczenie WIĄŻĄCE/);
    assert.match(p, /NIE MOŻE zostać złamana/);
    assert.match(p, /"days"/);
  });

  scenario('pole used_hint_klucz wchodzi do formatu odpowiedzi TYLKO razem z podpowiedziami', () => {
    const zP = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: selekcja() });
    const bezP = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc' });
    assert.ok(zP.includes('used_hint_klucz'));
    assert.ok(!bezP.includes('used_hint_klucz'));
  });

  scenario('sekcja podpowiedzi stoi OBOK bazy wiedzy, nie zamiast niej', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: selekcja() });
    assert.ok(p.includes(KB_TEST), 'baza wiedzy musi zostać');
    assert.ok(p.indexOf('BAZA WIEDZY GAMECHANGE') < p.indexOf('PODPOWIEDZI Z MATERIAŁÓW'));
  });

  scenario('nota o techSpec nadal działa razem z podpowiedziami (nie wypchnięta)', () => {
    const p = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'techSpec', hintSelection: selekcja() });
    assert.match(p, /słabiej ugruntowana naukowo/);
    assert.match(p, /PODPOWIEDZI Z MATERIAŁÓW/);
  });

  console.log('\n14. DOZOWANIE A6 — describeDayGaps: czy model trzyma odstęp (diagnostyka, nie blokada)');

  scenario('MON/WED/FRI -> najmniejszy odstęp 48 h (PIĄ->PON to 3 dni przez zawinięcie)', () => {
    assert.strictEqual(describeDayGaps(['MON', 'WED', 'FRI']).minOdstepGodzin, 48);
  });

  scenario('MON/TUE/WED -> 24 h, czyli ZŁAMANA reguła 48 h — i to widać', () => {
    const g = describeDayGaps(['MON', 'TUE', 'WED']);
    assert.strictEqual(g.minOdstepGodzin, 24);
    assert.match(describeDosingState({ gaps: g }), /UWAGA_ODSTEP_PONIZEJ_48H=tak/);
  });

  scenario('ZAWINIĘCIE TYGODNIA: MON/SUN to odstęp 24 h, nie 6 dni — na tym łatwo się przejechać', () => {
    assert.strictEqual(describeDayGaps(['MON', 'SUN']).minOdstepGodzin, 24);
  });

  scenario('jedna sesja w tygodniu -> 168 h, stan "jedna_sesja" (nie null, nie 0)', () => {
    const g = describeDayGaps(['WED']);
    assert.strictEqual(g.minOdstepGodzin, 168);
    assert.strictEqual(g.stan, 'jedna_sesja');
  });

  scenario('duplikaty dni nie zaniżają odstępu do zera', () => {
    assert.strictEqual(describeDayGaps(['MON', 'MON', 'THU']).minOdstepGodzin, 72);
  });

  scenario('nieznane kody dni -> jawny stan i lista, nigdy ciche pominięcie (R5)', () => {
    const g = describeDayGaps(['MON', 'PONIEDZIALEK', 'THU']);
    assert.deepStrictEqual(g.nieznaneKody, ['PONIEDZIALEK']);
    assert.match(describeDosingState({ gaps: g }), /NIEZNANE_KODY_DNI=PONIEDZIALEK/);
  });

  scenario('same śmieci na wejściu -> minOdstepGodzin=null i stan "brak_rozpoznanych_dni", nie crash', () => {
    const g = describeDayGaps(['XXX', null, 7]);
    assert.strictEqual(g.minOdstepGodzin, null);
    assert.strictEqual(g.stan, 'brak_rozpoznanych_dni');
  });

  scenario('describeDosingState mówi WPROST, czy podpowiedzi w ogóle poszły', () => {
    assert.match(describeDosingState({ hintsWeszly: false }), /podpowiedzi_w_promptcie=nie/);
    assert.match(describeDosingState({ hintsWeszly: true, kluczPodpowiedzi: 'moc-segment-01' }), /uzyta=moc-segment-01/);
  });

  console.log('\n15. DOZOWANIE A6 — koszt promptu na PRAWDZIWYCH wierszach migracji (18 × `moc`)');

  const POMIARY = [];
  function zmierz(nazwa, opcje) {
    const sel = selekcja(opcje);
    const bez = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc' });
    const z = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: sel });
    POMIARY.push({ nazwa, wejscie: sel.wszystkieWejsciowe, wstrzykniete: sel.hints.length, bez: bez.length, z: z.length, delta: z.length - bez.length });
    return { sel, bez, z };
  }

  scenario('Blok BEZ Elementu: 18 wierszy na wejściu -> 7 w promptcie, +3 179 znaków', () => {
    const { sel, delta } = (() => { const r = zmierz('moc, Blok bez Elementu, limit 12', {}); return { sel: r.sel, delta: r.z.length - r.bez.length }; })();
    assert.strictEqual(sel.wszystkieWejsciowe, 18);
    assert.strictEqual(sel.hints.length, 7);
    assert.strictEqual(delta, 3179);
  });

  scenario('Blok Z Elementem (comp-skoki): 9 w promptcie, +3 674 znaków, Element pierwszy', () => {
    const r = zmierz('moc, Blok z Elementem, limit 12', { goal: 'comp-skoki' });
    assert.strictEqual(r.sel.hints.length, 9);
    assert.strictEqual(r.z.length - r.bez.length, 3674);
    assert.strictEqual(r.sel.hints[0].klucz, 'moc-skoki-reaktywne-drop-jumps-depth-jumps-01');
  });

  scenario('limit 12 NIE tnie segmentu `moc` — po filtrach zostaje najwyżej 9, przyciete=0', () => {
    assert.strictEqual(selekcja({ goal: 'comp-skoki' }).przycieteLimitem, 0);
    assert.strictEqual(selekcja({}).przycieteLimitem, 0);
  });

  scenario('bramka A9 na `moc` nie odpala się — żaden wiersz nie ma min_age (znalezisko A20 nadal aktualne)', () => {
    assert.strictEqual(MOC_HINTS.filter((h) => h.min_age != null).length, 0);
    assert.strictEqual(selekcja({ wiek: 14 }).ukryteZPowoduWieku, 0);
    assert.strictEqual(selekcja({ wiek: null }).ukryteZPowoduWieku, 0);
  });

  scenario('14-latek, 16-latek i wiek nieznany dostają na `moc` DOKŁADNIE ten sam prompt', () => {
    const a = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: selekcja({ wiek: 14 }) });
    const b = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: selekcja({ wiek: 16 }) });
    const c = buildSystemPrompt({ knowledgeBaseContent: KB_TEST, segmentId: 'moc', hintSelection: selekcja({ wiek: null }) });
    assert.strictEqual(a, b);
    assert.strictEqual(b, c);
  });

  scenario('ODRZUCONA heurystyka „tnij rodzaj=zrozumiec": oszczędza 1 035 znaków, ale gubi treść o dozowaniu', () => {
    // Ten scenariusz NIE testuje kodu produkcyjnego. Utrwala POMIAR, na którym
    // oparta jest decyzja z sekcji 5 raportu: filtr po `rodzaj` wyrzuciłby
    // moc-segment-04 ("progres zachodzi podczas regeneracji" — wprost o odstępach),
    // a zostawiłby test skoków pogo, który z dozowaniem nie ma nic wspólnego.
    const sel = selekcja({ goal: 'comp-skoki' });
    const pelny = buildHintPromptBlock(sel);
    const okrojony = buildHintPromptBlock({ ...sel, hints: sel.hints.filter((h) => h.rodzaj !== 'zrozumiec') });
    assert.strictEqual(pelny.length - okrojony.length, 1035);
    const wypadloby = sel.hints.filter((h) => h.rodzaj === 'zrozumiec').map((h) => h.klucz);
    assert.ok(wypadloby.includes('moc-segment-04'), 'to jest dokładnie ta podpowiedź, przez którą filtr został odrzucony');
    const zostaloby = sel.hints.filter((h) => h.rodzaj === 'zrobic').map((h) => h.klucz);
    assert.ok(zostaloby.includes('moc-skoki-reaktywne-drop-jumps-depth-jumps-01'), 'a to ta, która by została mimo zerowego związku z dozowaniem');
  });

  // ============================================================
  // 16. TERMINARZ A7 08.08.2026 — mecze w dozowaniu (M21/A34)
  // ============================================================
  console.log('\n16. Terminarz meczów w fazie 1 (M21)');

  scenario('bez meczów: system i user prompt są CO DO ZNAKU dzisiejsze (md5, nie długość)', () => {
    const przed = {
      sys: buildSystemPrompt({ knowledgeBaseContent: 'KB', segmentId: 'moc', hintSelection: null }),
      usr: buildUserPrompt({ segmentId: 'moc', elementDescription: 'skoki', sessionsPerWeek: 3, equipment: [], readinessLines: [] }),
    };
    const po = {
      sys: buildSystemPrompt({ knowledgeBaseContent: 'KB', segmentId: 'moc', hintSelection: null, matchDayCodes: [] }),
      usr: buildUserPrompt({ segmentId: 'moc', elementDescription: 'skoki', sessionsPerWeek: 3, equipment: [], readinessLines: [], matchLines: [] }),
    };
    const md5 = (s) => require('crypto').createHash('md5').update(s).digest('hex');
    assert.strictEqual(md5(po.sys), md5(przed.sys));
    assert.strictEqual(md5(po.usr), md5(przed.usr));
  });

  scenario('daty → dni tygodnia: 2026-08-08 to sobota (SAT), niepoprawna data odpada', () => {
    assert.strictEqual(dayIndexOfDate('2026-08-08'), 5);
    assert.strictEqual(dayIndexOfDate('2026-08-10'), 0);
    assert.strictEqual(dayIndexOfDate('nie-data'), null);
  });

  scenario('buildMatchScheduleLines: mecze dają JEDNĄ linię z datami i kodami, pusta lista — zero linii', () => {
    const { lines, matchDayCodes } = buildMatchScheduleLines(['2026-08-09', '2026-08-15']);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('2026-08-09') && lines[0].includes('SUN') && lines[0].includes('SAT'));
    assert.deepStrictEqual(matchDayCodes.sort(), ['SAT', 'SUN']);
    assert.deepStrictEqual(buildMatchScheduleLines([]), { lines: [], matchDayCodes: [] });
    assert.deepStrictEqual(buildMatchScheduleLines(null), { lines: [], matchDayCodes: [] });
  });

  scenario('z meczami: system prompt ma sekcję WIĄŻĄCĄ, user prompt ma daty — bez nazw przeciwników', () => {
    const sys = buildSystemPrompt({ knowledgeBaseContent: 'KB', segmentId: 'moc', hintSelection: null, matchDayCodes: ['SAT'] });
    assert.ok(sys.includes('TERMINARZ MECZÓW'));
    assert.ok(sys.includes('WIĄŻĄCA'));
    assert.ok(sys.includes('dzień meczu NIE jest dniem sesji Bloku'));
    const usr = buildUserPrompt({ segmentId: 'moc', elementDescription: 'skoki', sessionsPerWeek: 3, equipment: [], readinessLines: [], matchLines: buildMatchScheduleLines(['2026-08-09']).lines });
    assert.ok(usr.includes('2026-08-09'));
  });

  scenario('describeMatchGap: sesja→mecz w przód, cyklicznie; dzień meczu = 0 h', () => {
    // sesja MON, mecz WED → 48 h (dokładnie na granicy reguły)
    assert.strictEqual(describeMatchGap(['MON'], ['WED']).minOdstepDoMeczuGodzin, 48);
    // sesja FRI, mecz SAT → 24 h — złamanie reguły 48 h
    assert.strictEqual(describeMatchGap(['FRI'], ['SAT']).minOdstepDoMeczuGodzin, 24);
    // zawinięcie tygodnia: sesja SUN, mecz MON → 24 h, nie 6 dni
    assert.strictEqual(describeMatchGap(['SUN'], ['MON']).minOdstepDoMeczuGodzin, 24);
    // sesja w dzień meczu
    assert.strictEqual(describeMatchGap(['SAT'], ['SAT']).minOdstepDoMeczuGodzin, 0);
    // brak meczów ≠ brak rozpoznanych dni (R5)
    assert.strictEqual(describeMatchGap(['MON'], []).stan, 'brak_meczow');
    assert.strictEqual(describeMatchGap([], ['SAT']).stan, 'brak_rozpoznanych_dni');
  });

  scenario('describeDosingState: linia logu mówi o meczu wprost, z ostrzeżeniami < 48 h i „w dzień meczu"', () => {
    const linia = describeDosingState({
      gaps: describeDayGaps(['MON', 'WED', 'FRI']),
      hintsWeszly: false,
      matchGap: describeMatchGap(['FRI'], ['SAT']),
    });
    assert.ok(linia.includes('min_odstep_do_meczu_h=24'));
    assert.ok(linia.includes('UWAGA_MECZ_PONIZEJ_48H_PO_SESJI=tak'));
    const wDzien = describeDosingState({ gaps: describeDayGaps(['SAT']), hintsWeszly: false, matchGap: describeMatchGap(['SAT'], ['SAT']) });
    assert.ok(wDzien.includes('UWAGA_SESJA_W_DZIEN_MECZU=tak'));
    // brak meczów → ani słowa o meczach w logu (linia jak przed rundą)
    const bez = describeDosingState({ gaps: describeDayGaps(['MON']), hintsWeszly: false, matchGap: describeMatchGap(['MON'], []) });
    assert.ok(!bez.includes('meczu'));
  });

  // Pomiar OSOBNYM logiem (zasada 14):
  {
    const sysBez = buildSystemPrompt({ knowledgeBaseContent: 'KB', segmentId: 'moc', hintSelection: null });
    const sysZ = buildSystemPrompt({ knowledgeBaseContent: 'KB', segmentId: 'moc', hintSelection: null, matchDayCodes: ['SAT'] });
    console.log(`[pomiar] TERMINARZ: sekcja meczowa w system promptcie = +${sysZ.length - sysBez.length} znaków (tylko gdy mecze są; bez meczów +0).`);
  }

  console.log('\n--- KOSZT PROMPTU FAZY 1 (do sekcji 12 raportu, generowane) ---\n');
  console.log('| wariant | na wejściu | wstrzyknięte | prompt bez | prompt z | delta |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const p of POMIARY) {
    console.log(`| ${p.nazwa} | ${p.wejscie} | ${p.wstrzykniete} | ${p.bez} | ${p.z} | **+${p.delta}** |`);
  }
  console.log('');

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();

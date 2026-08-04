// ============================================================
// GAMECHANGE — tests/test-generate-coach-tip.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, druga runda po "Wracaj do kolejki i pracuj" /
// "Pracuj dalej") — generate-coach-tip.js to silnik V1 Filaru A (Droga 1,
// proaktywne podpowiedzi), już w pełni zakodowany i podłączony do UI,
// zablokowany wyłącznie brakiem ANTHROPIC_API_KEY w Vercel (patrz
// GŁÓWNY_PLAN_PROJEKTU.md) — czyli realnie NAJBLIŻSZY start z całego
// Narzędzia Trenera. Mimo to dotąd bez ŻADNEGO testu. Ten plik pokrywa
// wszystkie funkcje udostępnione przez `_internal`, którymi da się
// sensownie sprawdzić logikę bez prawdziwego Anthropic/Supabase: budowanie
// promptów (w tym granice bezpieczeństwa — zakaz kontroli wagi/sylwetki,
// zasada "tylko sygnalizuj"), bibliotekę 9 wątków trenerskich, mapowanie
// typu jednostki na segmenty bazy wiedzy, i dwie siatki bezpieczeństwa
// (`checkCoachTipSoftCap`, `resolveGrowthSpurtContext` z atrapą Supabase).
//
// `buildCoachTipUserPrompt`/`checkCoachTipSoftCap` zostały dziś DOPISANE do
// `_internal` (istniały już w pliku, po prostu nie były eksportowane) —
// wyłącznie po to, żeby ten plik mógł je przetestować, zero zmiany
// zachowania (patrz komentarz w generate-coach-tip.js przy _internal).
//
// callAnthropic/generateCoachTip/getAdminClient (I/O + zewnętrzne API)
// świadomie NIE testowane tu — ten sam, ustalony w tym projekcie zakres co
// reszta plików w tym folderze (testujemy czyste funkcje i logikę z atrapą
// Supabase, nie prawdziwe wywołania sieciowe).
//
// Uruchomienie: node tests/test-generate-coach-tip.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_3__.js');
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
  UNIT_TYPES,
  UNIT_TYPE_TO_SEGMENTS,
  SEG_NAMES,
  THREAD_LIBRARY,
  buildThreadLibraryBlock,
  resolveGrowthSpurtContext,
  fetchAndAuthorizeTeam,
  fetchKnowledgeBaseForSegments,
  buildKnowledgeBlock,
  nutritionFramingForSeasonPhase,
  buildCoachSystemPrompt,
  buildCoachTipUserPrompt,
  checkCoachTipSoftCap,
} = require('../api/generate-coach-tip.js')._internal;

Module._resolveFilename = originalResolveFilename;

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

(async () => {
  console.log('generate-coach-tip.js _internal — testy jednostkowe');

  console.log('\n1. THREAD_LIBRARY / buildThreadLibraryBlock');

  await scenario('THREAD_LIBRARY ma 9 wątków, id 1-9, każdy z signals+situation', () => {
    assert.strictEqual(THREAD_LIBRARY.length, 9);
    THREAD_LIBRARY.forEach((t, i) => {
      assert.strictEqual(t.id, i + 1);
      assert.ok(t.signals && t.signals.length > 0);
      assert.ok(t.situation && t.situation.length > 0);
    });
  });

  await scenario('dokładnie jeden wątek (9) ma autoDetected=true — reszta bez tej flagi', () => {
    const autoDetected = THREAD_LIBRARY.filter((t) => t.autoDetected === true);
    assert.strictEqual(autoDetected.length, 1);
    assert.strictEqual(autoDetected[0].id, 9);
  });

  await scenario('buildThreadLibraryBlock zawiera wszystkie 9 wątków + zasadę "warto rozważyć, nigdy na pewno dlatego"', () => {
    const block = buildThreadLibraryBlock();
    for (let id = 1; id <= 9; id++) {
      assert.match(block, new RegExp(`^${id}\\. Sygnały:`, 'm'));
    }
    assert.match(block, /warto rozważyć/);
    assert.match(block, /nigdy .na pewno dlatego./);
  });

  console.log('\n2. UNIT_TYPE_TO_SEGMENTS / buildKnowledgeBlock');

  await scenario('każdy z 4 UNIT_TYPES ma wpis w UNIT_TYPE_TO_SEGMENTS z co najmniej 2 segmentami', () => {
    assert.strictEqual(UNIT_TYPES.length, 4);
    UNIT_TYPES.forEach((ut) => {
      assert.ok(Array.isArray(UNIT_TYPE_TO_SEGMENTS[ut]), `brak mapowania dla ${ut}`);
      assert.ok(UNIT_TYPE_TO_SEGMENTS[ut].length >= 2);
    });
  });

  await scenario('każdy segment użyty w UNIT_TYPE_TO_SEGMENTS ma nazwę w SEG_NAMES (albo świadomie nie — sprawdzamy, nie zgadujemy)', () => {
    const usedSegments = new Set(Object.values(UNIT_TYPE_TO_SEGMENTS).flat());
    const missing = [...usedSegments].filter((seg) => !SEG_NAMES[seg]);
    assert.deepStrictEqual(missing, [], `segmenty bez nazwy w SEG_NAMES: ${missing.join(', ')}`);
  });

  await scenario('buildKnowledgeBlock: pomija segmenty bez treści w bazie wiedzy, nie wywala się', () => {
    const block = buildKnowledgeBlock(['moc', 'wytrzymalosc'], { moc: 'Treść o mocy.' });
    assert.match(block, /--- MOC ---/);
    assert.match(block, /Treść o mocy\./);
    assert.ok(!block.includes('WYTRZYMAŁOŚĆ'), 'segment bez treści w kbBySegment nie powinien się pojawić');
  });

  await scenario('buildKnowledgeBlock: brak jakiejkolwiek treści -> pusty string (nie null/undefined)', () => {
    const block = buildKnowledgeBlock(['moc'], {});
    assert.strictEqual(block, '');
  });

  console.log('\n3. nutritionFramingForSeasonPhase');

  await scenario('sezon_rozgrywkowy -> akcent na nawodnienie/tankowanie', () => {
    assert.match(nutritionFramingForSeasonPhase('sezon_rozgrywkowy'), /nawodnienie/);
  });

  await scenario('przygotowawcza (i dowolna inna wartość) -> akcent na regenerację', () => {
    assert.match(nutritionFramingForSeasonPhase('przygotowawcza'), /regenerację/);
    assert.match(nutritionFramingForSeasonPhase(null), /regenerację/, 'brak fazy sezonu nie powinien wywalać funkcji');
  });

  console.log('\n4. buildCoachSystemPrompt — granice bezpieczeństwa V1');

  await scenario('zawiera zasadę "tylko sygnalizuj, nigdy nie rankinguj" i zakaz sugerowania składu', () => {
    const p = buildCoachSystemPrompt({ knowledgeBlock: '', nutritionBlock: 'x', includeThreadLibrary: false });
    assert.match(p, /TYLKO SYGNALIZUJESZ/);
    assert.match(p, /nigdy nie sugeruj składu/);
    assert.match(p, /nigdy nie sortuj ani nie porównuj zawodników/);
  });

  await scenario('wyraźnie ZAKAZUJE kontroli wagi/sylwetki w notatce żywieniowej (istotne przy nieletnich)', () => {
    const p = buildCoachSystemPrompt({ knowledgeBlock: '', nutritionBlock: 'x', includeThreadLibrary: false });
    assert.match(p, /NIGDY kontrola wagi\/sylwetki/);
    assert.match(p, /nieletnich/);
  });

  await scenario('wyklucza stany kliniczne (alergie, zaburzenia odżywiania) z notatki żywieniowej', () => {
    const p = buildCoachSystemPrompt({ knowledgeBlock: '', nutritionBlock: 'x', includeThreadLibrary: false });
    assert.match(p, /alergie/);
    assert.match(p, /zaburzenia odżywiania/);
    assert.match(p, /zawsze poza zakresem/);
  });

  await scenario('V1 nie generuje gotowej jednostki (serie/powtórzenia) — tylko wskazówkę', () => {
    const p = buildCoachSystemPrompt({ knowledgeBlock: '', nutritionBlock: 'x', includeThreadLibrary: false });
    assert.match(p, /NIE gotowe jednostki treningowe z dokładnym rozpisaniem serii\/powtórzeń/);
  });

  await scenario('includeThreadLibrary=false -> biblioteka wątków NIE wstrzyknięta do promptu', () => {
    const p = buildCoachSystemPrompt({ knowledgeBlock: '', nutritionBlock: 'x', includeThreadLibrary: false });
    assert.ok(!p.includes('BIBLIOTEKA WĄTKÓW TRENERSKICH'));
  });

  await scenario('includeThreadLibrary=true -> biblioteka wątków JEST wstrzyknięta', () => {
    const p = buildCoachSystemPrompt({ knowledgeBlock: '', nutritionBlock: 'x', includeThreadLibrary: true });
    assert.ok(p.includes('BIBLIOTEKA WĄTKÓW TRENERSKICH'));
  });

  await scenario('knowledgeBlock i nutritionBlock wstrzyknięte dosłownie', () => {
    const p = buildCoachSystemPrompt({ knowledgeBlock: '###KB###', nutritionBlock: '###NUTR###', includeThreadLibrary: false });
    assert.ok(p.includes('###KB###'));
    assert.ok(p.includes('###NUTR###'));
  });

  await scenario('wymusza czysty format JSON z tip_text + nutrition_note_text', () => {
    const p = buildCoachSystemPrompt({ knowledgeBlock: '', nutritionBlock: 'x', includeThreadLibrary: false });
    assert.match(p, /WYŁĄCZNIE poprawny JSON/);
    assert.match(p, /tip_text/);
    assert.match(p, /nutrition_note_text/);
  });

  console.log('\n5. buildCoachTipUserPrompt');

  await scenario('poprawnie etykietuje fazę sezonu i typ jednostki (wszystkie 4 typy)', () => {
    const labels = { silowa: 'Siłowa', wytrzymalosciowa: 'Wytrzymałościowa', techniczna: 'Techniczna', taktyczna: 'Taktyczna (gierka zadaniowa)' };
    UNIT_TYPES.forEach((ut) => {
      const p = buildCoachTipUserPrompt({ seasonPhase: 'sezon_rozgrywkowy', unitType: ut });
      assert.match(p, /Sezon rozgrywkowy/);
      assert.ok(p.includes(labels[ut]), `brak etykiety "${labels[ut]}" dla typu ${ut}`);
    });
  });

  await scenario('nieznany unitType -> nie wywala się, pokazuje surową wartość zamiast pustki', () => {
    const p = buildCoachTipUserPrompt({ seasonPhase: 'przygotowawcza', unitType: 'cos-nieznanego' });
    assert.match(p, /Faza przygotowawcza/);
    assert.ok(p.includes('cos-nieznanego'));
  });

  console.log('\n6. checkCoachTipSoftCap — siatka bezpieczeństwa 60/dobę/drużynę (atrapa Supabase)');

  function makeFakeSupabase(count) {
    return {
      from() {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          gte() { return builder; },
          then(resolve, reject) {
            Promise.resolve({ count, error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }

  await scenario('count=59 (tuż pod progiem 60) -> allowed:true', async () => {
    const r = await checkCoachTipSoftCap(makeFakeSupabase(59), 'team-1');
    assert.strictEqual(r.allowed, true);
  });

  await scenario('count=60 (dokładnie na progu) -> allowed:false', async () => {
    const r = await checkCoachTipSoftCap(makeFakeSupabase(60), 'team-1');
    assert.strictEqual(r.allowed, false);
    assert.match(r.reason, /60/);
  });

  console.log('\n7. resolveGrowthSpurtContext — wątek 9 (jedyny automatycznie wykrywany), atrapa Supabase');

  function makeFakeSupabaseForGrowth({ birthYear, heights }) {
    return {
      from(table) {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          order() { return builder; },
          limit() { return builder; },
          maybeSingle() {
            return Promise.resolve({ data: table === 'users' ? { birth_year: birthYear } : null, error: null });
          },
          then(resolve, reject) {
            const data = table === 'height_logs' ? heights : [];
            Promise.resolve({ data, error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }

  const THIS_YEAR = new Date().getUTCFullYear();

  await scenario('wiek 13 (w zakresie 11-16), bez pomiarów wzrostu -> inGrowthSpurtAgeRange=true, heightGrowthRateElevated=false', async () => {
    const supabase = makeFakeSupabaseForGrowth({ birthYear: THIS_YEAR - 13, heights: [] });
    const r = await resolveGrowthSpurtContext(supabase, 'player-1');
    assert.strictEqual(r.inGrowthSpurtAgeRange, true);
    assert.strictEqual(r.heightGrowthRateElevated, false);
  });

  await scenario('wiek 20 (poza zakresem 11-16) -> inGrowthSpurtAgeRange=false, mimo szybkiego wzrostu', async () => {
    const heights = [
      { height_cm: 180, measured_at: '2026-07-01T00:00:00Z' },
      { height_cm: 170, measured_at: '2026-01-01T00:00:00Z' },
    ];
    const supabase = makeFakeSupabaseForGrowth({ birthYear: THIS_YEAR - 20, heights });
    const r = await resolveGrowthSpurtContext(supabase, 'player-1');
    assert.strictEqual(r.inGrowthSpurtAgeRange, false);
  });

  await scenario('brak birth_year -> inGrowthSpurtAgeRange=false (nie zgaduje wieku)', async () => {
    const supabase = makeFakeSupabaseForGrowth({ birthYear: null, heights: [] });
    const r = await resolveGrowthSpurtContext(supabase, 'player-1');
    assert.strictEqual(r.inGrowthSpurtAgeRange, false);
  });

  await scenario('szybki wzrost (>7,2 cm/rok), odstęp >=60 dni -> heightGrowthRateElevated=true', async () => {
    // 5 cm w 90 dni ~= 20,3 cm/rok -> wyraźnie powyżej progu 7,2 cm/rok.
    const heights = [
      { height_cm: 165, measured_at: '2026-08-01T00:00:00Z' },
      { height_cm: 160, measured_at: '2026-05-03T00:00:00Z' },
    ];
    const supabase = makeFakeSupabaseForGrowth({ birthYear: THIS_YEAR - 13, heights });
    const r = await resolveGrowthSpurtContext(supabase, 'player-1');
    assert.strictEqual(r.heightGrowthRateElevated, true);
  });

  await scenario('wolny wzrost (<=7,2 cm/rok) -> heightGrowthRateElevated=false', async () => {
    // 1 cm w 90 dni ~= 4,1 cm/rok -> poniżej progu.
    const heights = [
      { height_cm: 161, measured_at: '2026-08-01T00:00:00Z' },
      { height_cm: 160, measured_at: '2026-05-03T00:00:00Z' },
    ];
    const supabase = makeFakeSupabaseForGrowth({ birthYear: THIS_YEAR - 13, heights });
    const r = await resolveGrowthSpurtContext(supabase, 'player-1');
    assert.strictEqual(r.heightGrowthRateElevated, false);
  });

  await scenario('odstęp między pomiarami < 60 dni -> heightGrowthRateElevated=false (za krótki, niemiarodajny)', async () => {
    const heights = [
      { height_cm: 163, measured_at: '2026-08-01T00:00:00Z' },
      { height_cm: 160, measured_at: '2026-07-15T00:00:00Z' }, // 17 dni
    ];
    const supabase = makeFakeSupabaseForGrowth({ birthYear: THIS_YEAR - 13, heights });
    const r = await resolveGrowthSpurtContext(supabase, 'player-1');
    assert.strictEqual(r.heightGrowthRateElevated, false);
  });

  console.log('\n8. fetchAndAuthorizeTeam / fetchKnowledgeBaseForSegments — trust boundary + I/O proste (atrapa Supabase)');

  function makeFakeSupabaseSimple(tables) {
    return {
      from(table) {
        const filters = [];
        const builder = {
          select() { return builder; },
          eq(col, val) { filters.push((row) => row[col] === val); return builder; },
          in(col, vals) { filters.push((row) => vals.includes(row[col])); return builder; },
          maybeSingle() {
            const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
            return Promise.resolve({ data: rows[0] || null, error: null });
          },
          then(resolve, reject) {
            const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
            Promise.resolve({ data: rows, error: null }).then(resolve, reject);
          },
        };
        return builder;
      },
    };
  }

  await scenario('drużyna należy do podanego trenera -> authorized:true, zwraca team', async () => {
    const supabase = makeFakeSupabaseSimple({ teams: [{ id: 't1', coach_user_id: 'coach-1', season_phase: 'sezon_rozgrywkowy' }] });
    const r = await fetchAndAuthorizeTeam(supabase, 't1', 'coach-1');
    assert.strictEqual(r.authorized, true);
    assert.strictEqual(r.team.id, 't1');
  });

  await scenario('drużyna NALEŻY do INNEGO trenera -> authorized:false, team:null (nie zdradza istnienia drużyny)', async () => {
    const supabase = makeFakeSupabaseSimple({ teams: [{ id: 't1', coach_user_id: 'inny-trener', season_phase: 'sezon_rozgrywkowy' }] });
    const r = await fetchAndAuthorizeTeam(supabase, 't1', 'coach-1');
    assert.strictEqual(r.authorized, false);
    assert.strictEqual(r.team, null);
  });

  await scenario('drużyna nie istnieje -> authorized:false', async () => {
    const supabase = makeFakeSupabaseSimple({ teams: [] });
    const r = await fetchAndAuthorizeTeam(supabase, 'brak-takiej', 'coach-1');
    assert.strictEqual(r.authorized, false);
  });

  await scenario('brak teamId/coachUserId -> rzuca od razu (fail fast, nie odpytuje bazy)', async () => {
    const supabase = makeFakeSupabaseSimple({ teams: [] });
    await assert.rejects(() => fetchAndAuthorizeTeam(supabase, null, 'coach-1'));
    await assert.rejects(() => fetchAndAuthorizeTeam(supabase, 't1', null));
  });

  await scenario('fetchKnowledgeBaseForSegments: pusta lista segmentów -> {} bez zapytania do bazy', async () => {
    const r = await fetchKnowledgeBaseForSegments(makeFakeSupabaseSimple({}), []);
    assert.deepStrictEqual(r, {});
  });

  await scenario('fetchKnowledgeBaseForSegments: mapuje wiersze na segment_id -> content', async () => {
    const supabase = makeFakeSupabaseSimple({
      knowledge_base_entries: [
        { segment_id: 'moc', content: 'Treść moc.' },
        { segment_id: 'wytrzymalosc', content: 'Treść wytrzymałość.' },
      ],
    });
    const r = await fetchKnowledgeBaseForSegments(supabase, ['moc', 'wytrzymalosc']);
    assert.strictEqual(r.moc, 'Treść moc.');
    assert.strictEqual(r.wytrzymalosc, 'Treść wytrzymałość.');
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();

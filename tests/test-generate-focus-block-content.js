// ============================================================
// GAMECHANGE — tests/test-generate-focus-block-content.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, piąta runda — kontynuacja "Pracuj dalej").
// Pokrywa to, co `_internal` faktycznie eksportuje z tego pliku i da się
// przetestować bez atrapy `fetch`/Anthropic: `stripMarkdownJsonFence`,
// `SEG_PILLAR`, `fetchFocusBlock`, `fetchElementDescription` (te dwie
// ostatnie z atrapą Supabase, ten sam wzorzec co reszta folderu).
//
// Świadomie NIE testujemy `generateCheckin`/`generateClosingReview`
// całościowo — obie łączą Supabase I prawdziwe wywołanie Anthropic
// (`callAnthropic`, niewyeksportowane, więc nie do podmiany), a logika
// "czy dołączyć dawkę treści" (`dueForContentDose`) jest wpisana wprost w
// ciało `generateCheckin`, nie wydzielona jako osobna czysta funkcja — do
// przetestowania wymagałaby atrapy globalnego `fetch`, co wykracza poza
// ustalony w tym projekcie zakres testów (patrz reszta plików w tym
// folderze — żaden nie stubuje `fetch`).
//
// Uruchomienie: node tests/test-generate-focus-block-content.js
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_5__.js');
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
  fetchFocusBlock,
  fetchElementDescription,
  stripMarkdownJsonFence,
  SEG_PILLAR,
} = require('../api/generate-focus-block-content.js')._internal;

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
        single() {
          const rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)));
          return Promise.resolve(rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'not found' } });
        },
      };
      return builder;
    },
  };
}

(async () => {
  console.log('generate-focus-block-content.js _internal — testy jednostkowe');

  console.log('\n1. stripMarkdownJsonFence (kopia tej samej funkcji co w pozostałych plikach AI)');

  await scenario('czysty JSON -> bez zmian', () => {
    assert.strictEqual(stripMarkdownJsonFence('{"question":"X"}'), '{"question":"X"}');
  });

  await scenario('owinięty w ```json ... ``` -> wyciągnięty', () => {
    assert.strictEqual(stripMarkdownJsonFence('```json\n{"summary":"X"}\n```'), '{"summary":"X"}');
  });

  console.log('\n2. SEG_PILLAR — mapowanie segment→filar (5 filarów, 13 segmentów)');

  await scenario('każdy z 13 segmentów ma przypisany dokładnie jeden filar', () => {
    const allSegments = ['moc', 'wytrzymalosc', 'fizycznosc', 'techFund', 'techSpec', 'tolerancja', 'regeneracja', 'odpornosc', 'odzywianie', 'koncentracja', 'mental', 'percepcja', 'decyzja'];
    assert.strictEqual(Object.keys(SEG_PILLAR).length, 13);
    allSegments.forEach((id) => assert.ok(SEG_PILLAR[id], `brak filaru dla segmentu "${id}"`));
  });

  await scenario('segment nieznany -> undefined (nie rzuca)', () => {
    assert.strictEqual(SEG_PILLAR['segment-obcy'], undefined);
  });

  await scenario('"moc" i "wytrzymalosc" należą do tego samego filaru (Dominacja fizyczna)', () => {
    assert.strictEqual(SEG_PILLAR.moc, SEG_PILLAR.wytrzymalosc);
    assert.match(SEG_PILLAR.moc, /Dominacja fizyczna/);
  });

  console.log('\n3. fetchFocusBlock — atrapa Supabase');

  await scenario('blok istnieje -> zwraca wiersz', async () => {
    const supabase = makeFakeSupabase({ focus_blocks: [{ id: 'b1', user_id: 'u1', segment_id: 'moc', stage: 1 }] });
    const r = await fetchFocusBlock(supabase, 'b1');
    assert.strictEqual(r.id, 'b1');
    assert.strictEqual(r.segment_id, 'moc');
  });

  await scenario('blok NIE istnieje -> rzuca z czytelnym komunikatem (nie zwraca cicho undefined)', async () => {
    const supabase = makeFakeSupabase({ focus_blocks: [] });
    await assert.rejects(() => fetchFocusBlock(supabase, 'brak-takiego'), /Nie znaleziono focus_block brak-takiego/);
  });

  console.log('\n4. fetchElementDescription — atrapa Supabase');

  await scenario('component_id podany, komponent istnieje -> zwraca jego nazwę', async () => {
    const supabase = makeFakeSupabase({ segment_components: [{ id: 'c1', name: 'Przysiad' }] });
    const r = await fetchElementDescription(supabase, { component_id: 'c1', custom_description: null });
    assert.strictEqual(r, 'Przysiad');
  });

  await scenario('component_id podany, ale NIE istnieje -> spada na custom_description', async () => {
    const supabase = makeFakeSupabase({ segment_components: [] });
    const r = await fetchElementDescription(supabase, { component_id: 'brak-takiego', custom_description: 'Mój opis' });
    assert.strictEqual(r, 'Mój opis');
  });

  await scenario('brak component_id -> custom_description', async () => {
    const supabase = makeFakeSupabase({});
    const r = await fetchElementDescription(supabase, { component_id: null, custom_description: 'Wolny opis' });
    assert.strictEqual(r, 'Wolny opis');
  });

  await scenario('brak component_id I custom_description -> domyślny fallback "wybrany element" (nigdy pusty/undefined)', async () => {
    const supabase = makeFakeSupabase({});
    const r = await fetchElementDescription(supabase, { component_id: null, custom_description: null });
    assert.strictEqual(r, 'wybrany element');
  });

  console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
  process.exit(failed === 0 ? 0 : 1);
})();

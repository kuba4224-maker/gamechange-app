// ============================================================
// test-coach-development.js — testy jednostkowe lib/coach-development.js
// ============================================================
// Uruchom: node tests/test-coach-development.js
//
// Zakres, ŚWIADOMIE zgodny z ustaloną konwencją tego projektu (patrz
// tests/test-generate-coach-tip.js, punkt "callAnthropic/generateCoachTip/
// getAdminClient (I/O + zewnętrzne API) świadomie NIE testowane tu"):
// testujemy czyste funkcje (lista segmentów, walidacja, budowanie promptów)
// i logikę z atrapą Supabase (checkCoachPrioritySoftCap), NIE prawdziwe
// wywołania sieciowe do Anthropic ani pełny orkiestrator
// setCoachPriorityAndGenerateGuidance (wymagałby atrapowania obu naraz —
// tak jak generateCoachTip w generate-coach-tip.js, świadomie pominięte).
// ============================================================

const assert = require('assert');
const path = require('path');
const Module = require('module');

const supabaseStubPath = path.join(__dirname, '__stub_supabase_js_devel__.js');
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
  COACH_DEVELOPMENT_SEGMENTS,
  isValidDevelopmentSegment,
  getDevelopmentSegment,
  buildPriorityGuidanceSystemPrompt,
  buildPriorityGuidanceUserPrompt,
} = require('../lib/coach-development.js');
const { checkCoachPrioritySoftCap, COACH_PRIORITY_SOFT_DAILY_CAP } = require('../lib/coach-development.js')._internal;

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
  console.log('coach-development.js — testy jednostkowe');

  console.log('\n1. COACH_DEVELOPMENT_SEGMENTS — sześć segmentów Filaru B');

  await scenario('dokładnie 6 segmentów, każdy z unikalnym key + label + feelingPrompt + promptContext', () => {
    assert.strictEqual(COACH_DEVELOPMENT_SEGMENTS.length, 6);
    const keys = new Set();
    COACH_DEVELOPMENT_SEGMENTS.forEach((s) => {
      assert.ok(s.key && s.label && s.feelingPrompt && s.promptContext, `segment niekompletny: ${JSON.stringify(s)}`);
      assert.ok(!keys.has(s.key), `zduplikowany key: ${s.key}`);
      keys.add(s.key);
    });
  });

  await scenario('żaden feelingPrompt nie brzmi jak ocena ("słaby", "gorszy", "za mało")', () => {
    const bannedWords = ['słaby', 'słabszy', 'gorszy', 'za mało', 'niewystarczając'];
    COACH_DEVELOPMENT_SEGMENTS.forEach((s) => {
      bannedWords.forEach((w) => {
        assert.ok(!s.feelingPrompt.toLowerCase().includes(w), `feelingPrompt segmentu ${s.key} brzmi jak ocena: "${s.feelingPrompt}"`);
      });
    });
  });

  console.log('\n2. isValidDevelopmentSegment / getDevelopmentSegment');

  await scenario('wszystkie 6 kluczy uznane za prawidłowe', () => {
    COACH_DEVELOPMENT_SEGMENTS.forEach((s) => assert.strictEqual(isValidDevelopmentSegment(s.key), true));
  });

  await scenario('nieznany klucz -> nieprawidłowy', () => {
    assert.strictEqual(isValidDevelopmentSegment('cos_innego'), false);
    assert.strictEqual(isValidDevelopmentSegment(''), false);
    assert.strictEqual(isValidDevelopmentSegment(undefined), false);
  });

  await scenario('getDevelopmentSegment zwraca pełny obiekt dla znanego klucza, null dla nieznanego', () => {
    const seg = getDevelopmentSegment('wlasny_rozwoj');
    assert.strictEqual(seg.label, 'Poczucie własnego rozwoju jako trenera');
    assert.strictEqual(getDevelopmentSegment('cos_innego'), null);
  });

  console.log('\n3. buildPriorityGuidanceSystemPrompt — framing "wybór priorytetu", NIE ocena');

  await scenario('prompt zakazuje wprost sugerowania że trener jest "słaby" i porównywania trenerów', () => {
    const p = buildPriorityGuidanceSystemPrompt();
    assert.match(p, /NIE dostał oceny kompetencji/);
    assert.match(p, /Nigdy nie sugeruj, że trener jest "słaby"/);
    assert.match(p, /nigdy nie porównuj go do innych trenerów/);
  });

  await scenario('prompt wymusza format JSON z guidance_text', () => {
    const p = buildPriorityGuidanceSystemPrompt();
    assert.match(p, /"guidance_text"/);
    assert.match(p, /WYŁĄCZNIE poprawny JSON/);
  });

  console.log('\n4. buildPriorityGuidanceUserPrompt');

  await scenario('poprawny segmentKey -> prompt zawiera label i promptContext segmentu', () => {
    const p = buildPriorityGuidanceUserPrompt({ segmentKey: 'mecz_na_zywo' });
    assert.match(p, /Zarządzanie meczem na żywo/);
    assert.match(p, /W TRAKCIE meczu/);
  });

  await scenario('nieprawidłowy segmentKey -> rzuca błąd (nie generuje pustego promptu)', () => {
    assert.throws(() => buildPriorityGuidanceUserPrompt({ segmentKey: 'cos_innego' }));
  });

  console.log('\n5. checkCoachPrioritySoftCap — atrapa Supabase (siatka bezpieczeństwa inżynierska)');

  function makeFakeSupabaseForCap(count) {
    return {
      from(table) {
        assert.strictEqual(table, 'coach_priority_selections');
        return {
          select() { return this; },
          eq() { return this; },
          gte() {
            return Promise.resolve({ count, error: null });
          },
        };
      },
    };
  }

  await scenario(`poniżej limitu (${COACH_PRIORITY_SOFT_DAILY_CAP - 1}/${COACH_PRIORITY_SOFT_DAILY_CAP}) -> allowed=true`, async () => {
    const supabase = makeFakeSupabaseForCap(COACH_PRIORITY_SOFT_DAILY_CAP - 1);
    const r = await checkCoachPrioritySoftCap(supabase, 'coach-1');
    assert.strictEqual(r.allowed, true);
  });

  await scenario(`dokładnie na limicie (${COACH_PRIORITY_SOFT_DAILY_CAP}/${COACH_PRIORITY_SOFT_DAILY_CAP}) -> allowed=false`, async () => {
    const supabase = makeFakeSupabaseForCap(COACH_PRIORITY_SOFT_DAILY_CAP);
    const r = await checkCoachPrioritySoftCap(supabase, 'coach-1');
    assert.strictEqual(r.allowed, false);
    assert.match(r.reason, /Siatka bezpieczeństwa/);
  });

  await scenario('count=null (np. świeża tabela) -> traktowane jak 0 -> allowed=true', async () => {
    const supabase = makeFakeSupabaseForCap(null);
    const r = await checkCoachPrioritySoftCap(supabase, 'coach-1');
    assert.strictEqual(r.allowed, true);
  });

  console.log(failed ? `\n${failed} TEST(Y) NIE PRZESZŁY (${passed} ok).` : `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).`);
  if (failed) process.exitCode = 1;
})();

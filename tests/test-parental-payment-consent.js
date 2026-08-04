// ============================================================
// GAMECHANGE — tests/test-parental-payment-consent.js
// ============================================================
// Ten sam wzorzec co reszta testów w tym folderze: zwykły skrypt Node, bez
// frameworka, testuje TYLKO czyste funkcje (computeAgeUpperBound,
// requiresParentalConsent, generateConsentToken) — createConsentRequest
// robi I/O (Supabase), świadomie NIE testowane tu (brak atrapy klienta w
// tej sesji, ten sam ograniczony zakres co inne testy w tym folderze).
//
// Uruchomienie: node tests/test-parental-payment-consent.js
// ============================================================

const assert = require('assert');
const {
  computeAgeUpperBound,
  requiresParentalConsent,
  generateConsentToken,
} = require('../lib/parental-payment-consent.js');

let failures = 0;
function scenario(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.stack || e.message}`);
  }
}

const NOW_2026 = new Date('2026-08-04T12:00:00Z');

scenario('computeAgeUpperBound: rok urodzenia 2008, dziś 2026 -> 18', () => {
  assert.strictEqual(computeAgeUpperBound(2008, NOW_2026), 18);
});

scenario('computeAgeUpperBound: rok urodzenia 2006, dziś 2026 -> 20', () => {
  assert.strictEqual(computeAgeUpperBound(2006, NOW_2026), 20);
});

scenario('computeAgeUpperBound: brak roku -> null', () => {
  assert.strictEqual(computeAgeUpperBound(null, NOW_2026), null);
  assert.strictEqual(computeAgeUpperBound(undefined, NOW_2026), null);
});

scenario('computeAgeUpperBound: nieliczbowy rok -> null (nie NaN)', () => {
  assert.strictEqual(computeAgeUpperBound('nie-liczba', NOW_2026), null);
});

scenario('requiresParentalConsent: computed=17 (rok 2009) -> TRUE (na pewno niepełnoletni)', () => {
  assert.strictEqual(requiresParentalConsent(2009, NOW_2026), true);
});

scenario('requiresParentalConsent: computed=18 (rok 2008) -> TRUE (mógł jeszcze nie mieć urodzin)', () => {
  assert.strictEqual(requiresParentalConsent(2008, NOW_2026), true);
});

scenario('requiresParentalConsent: computed=19 (rok 2007) -> FALSE (gwarantowane 18+, nawet z dolną granicą)', () => {
  assert.strictEqual(requiresParentalConsent(2007, NOW_2026), false);
});

scenario('requiresParentalConsent: computed=25 (rok 2001) -> FALSE', () => {
  assert.strictEqual(requiresParentalConsent(2001, NOW_2026), false);
});

scenario('requiresParentalConsent: brak birth_year -> TRUE (nigdy nie zakładamy dorosłości bez danych)', () => {
  assert.strictEqual(requiresParentalConsent(null, NOW_2026), true);
  assert.strictEqual(requiresParentalConsent(undefined, NOW_2026), true);
});

scenario('generateConsentToken: 48 znaków hex, dwa wywołania dają różne wartości', () => {
  const t1 = generateConsentToken();
  const t2 = generateConsentToken();
  assert.strictEqual(t1.length, 48);
  assert.match(t1, /^[0-9a-f]{48}$/);
  assert.notStrictEqual(t1, t2);
});

console.log(`\n${failures === 0 ? 'WSZYSTKIE TESTY PRZESZŁY' : `${failures} TEST(ÓW) NIE PRZESZŁO`}`);
process.exit(failures === 0 ? 0 : 1);

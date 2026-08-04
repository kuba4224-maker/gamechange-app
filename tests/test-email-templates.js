// ============================================================
// GAMECHANGE — tests/test-email-templates.js
// ============================================================
// NOWY PLIK (04.08.2026, noc, trzecia runda — odpowiedź na pytanie Kuby
// "czy masz jeszcze coś w kolejce, nad czym możesz pracować beze mnie").
// lib/email-templates.js to CZTERY w pełni czyste funkcje (zero I/O, zero
// zależności zewnętrznych) budujące treść e-maili wysyłanych do zawodników
// i RODZICÓW nieletnich — a mimo to, w odróżnieniu od reszty lib/, nie
// miało dotąd ŻADNEGO testu. Dwa konkretne powody, dla których to
// szczególnie warto pokryć testem (nie tylko "bo się da"):
//
// 1. escapeHtml() — jedyne miejsce w tym pliku chroniące przed wstrzyknięciem
//    HTML/JS przez dane pochodzące od użytkownika (imię zawodnika, treść
//    rekomendacji, itd.) w e-mailu, który trafia do skrzynki rodzica.
//    Ten plik NIE eksportuje escapeHtml wprost — testowane pośrednio,
//    przez sprawdzenie, że złośliwy ładunek w polach użytkownika NIE
//    pojawia się w wygenerowanym HTML w formie nieuciekniętej.
// 2. parentalPaymentConsentEmail() dotyczy realnej zgody rodzica na
//    płatność za nieletniego (Kodeks cywilny, `KOLEJKA_DECYZJI_I_
//    PROJEKTOWANIA.md` 2.5) — literówka albo zły warunek w tym miejscu to
//    nie kosmetyka, tylko potencjalny problem prawny/zaufania.
//
// Zero atrap Supabase/Anthropic potrzebnych tutaj — plik pod testem nie ma
// ŻADNYCH zależności zewnętrznych (sprawdzone: brak require() poza samym
// kodem pliku), więc to najprostszy plik testowy w tym folderze.
//
// Uruchomienie: node tests/test-email-templates.js
// ============================================================

const assert = require('assert');
const {
  parentReportEmail,
  recommendationNotificationEmail,
  retentionReminderEmail,
  parentalPaymentConsentEmail,
} = require('../lib/email-templates.js');

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

const XSS_PAYLOAD = '<script>alert("x")</script>';
const XSS_ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;';

console.log('email-templates.js — testy jednostkowe (funkcje czyste, bez atrap I/O)');

console.log('\n1. parentReportEmail');

scenario('cel priorytetowy z horizon_weeks -> linia z segmentem PL i "tyg. cierpliwości"', () => {
  const r = parentReportEmail({
    report: { player_name: 'Kuba', priority_goal: { segment_id: 'moc', horizon_weeks: 6 }, active_goals_count: 2, recent_training_sessions_7d: 3, recent_matches_30d: 1 },
    unsubscribeUrl: null,
  });
  assert.match(r.html, /Moc/);
  assert.match(r.html, /6 tyg\. cierpliwości/);
  assert.match(r.text, /Priorytetowy cel: Moc \(ok\. 6 tyg\. horyzontu\)/);
});

scenario('cel priorytetowy BEZ horizon_weeks -> zdanie kończy się kropką, bez "tyg."', () => {
  const r = parentReportEmail({
    report: { priority_goal: { segment_id: 'wytrzymalosc' }, active_goals_count: 0, recent_training_sessions_7d: 0, recent_matches_30d: 0 },
    unsubscribeUrl: null,
  });
  assert.ok(!r.html.includes('tyg. cierpliwości'));
  assert.match(r.html, /Wytrzymałość<\/strong>\./);
});

scenario('brak priority_goal -> "Brak dziś ustawionego priorytetowego celu."', () => {
  const r = parentReportEmail({ report: { active_goals_count: 0, recent_training_sessions_7d: 0, recent_matches_30d: 0 }, unsubscribeUrl: null });
  assert.match(r.html, /Brak dziś ustawionego priorytetowego celu\./);
  assert.match(r.text, /Brak dziś ustawionego priorytetowego celu\./);
});

scenario('nieznany segment_id (spoza SEG_NAMES) -> pokazuje surowe id zamiast się wywalić', () => {
  const r = parentReportEmail({ report: { priority_goal: { segment_id: 'segment-spoza-slownika' }, active_goals_count: 0 }, unsubscribeUrl: null });
  assert.match(r.html, /segment-spoza-slownika/);
});

scenario('brak player_name -> domyślnie "Twoje dziecko"', () => {
  const r = parentReportEmail({ report: { active_goals_count: 0 }, unsubscribeUrl: null });
  assert.match(r.subject, /Twoje dziecko/);
  assert.match(r.html, /Twoje dziecko/);
});

scenario('liczniki (active_goals_count itd.) brakujące -> pokazują 0, nie "undefined"/pustkę', () => {
  const r = parentReportEmail({ report: {}, unsubscribeUrl: null });
  assert.ok(!r.html.includes('undefined'));
  assert.match(r.html, /Aktywnych celów: <strong>0<\/strong>/);
  assert.match(r.text, /Aktywnych celów: 0/);
});

scenario('growth_spurt_typical_age_range=true -> notatka o okresie wzrostu w html I text', () => {
  const r = parentReportEmail({ report: { player_name: 'Ala', active_goals_count: 0, growth_spurt_typical_age_range: true }, unsubscribeUrl: null });
  assert.match(r.html, /szczytowego wzrostu|szybszego wzrostu/);
  assert.match(r.html, /Ala/);
  assert.match(r.text, /naturalny okres szybszego wzrostu/);
});

scenario('growth_spurt_typical_age_range=false/brak -> BRAK notatki o wieku wzrostowym', () => {
  const r = parentReportEmail({ report: { active_goals_count: 0 }, unsubscribeUrl: null });
  assert.ok(!r.html.includes('naturalny okres szybszego wzrostu'));
  assert.ok(!r.text.includes('naturalny okres szybszego wzrostu'));
});

scenario('height_growth_rate_elevated=true -> notatka o tempie wzrostu w html I text', () => {
  const r = parentReportEmail({ report: { active_goals_count: 0, height_growth_rate_elevated: true }, unsubscribeUrl: null });
  assert.match(r.html, /wyraźnie szybsze tempo wzrastania/);
  assert.match(r.text, /wyraźnie szybsze tempo wzrastania/);
});

scenario('obie flagi wzrostu naraz -> obie notatki obecne', () => {
  const r = parentReportEmail({ report: { active_goals_count: 0, growth_spurt_typical_age_range: true, height_growth_rate_elevated: true }, unsubscribeUrl: null });
  assert.match(r.html, /naturalny okres szybszego wzrostu/);
  assert.match(r.html, /wyraźnie szybsze tempo wzrastania/);
});

scenario('unsubscribeUrl podany -> link wypisania w html I text', () => {
  const r = parentReportEmail({ report: { active_goals_count: 0 }, unsubscribeUrl: 'https://example.com/u?token=abc' });
  assert.match(r.html, /Wypisz się jednym kliknięciem/);
  assert.match(r.html, /https:\/\/example\.com\/u\?token=abc/);
  assert.match(r.text, /Wypisz się: https:\/\/example\.com\/u\?token=abc/);
});

scenario('unsubscribeUrl brak -> BRAK linku wypisania w żadnej wersji', () => {
  const r = parentReportEmail({ report: { active_goals_count: 0 }, unsubscribeUrl: null });
  assert.ok(!r.html.includes('Wypisz się'));
  assert.ok(!r.text.includes('Wypisz się'));
});

scenario('XSS w player_name -> UCIECZKA w html (brak surowego <script>), surowe w text (bo to nie HTML)', () => {
  const r = parentReportEmail({ report: { player_name: XSS_PAYLOAD, active_goals_count: 0 }, unsubscribeUrl: null });
  assert.ok(!r.html.includes(XSS_PAYLOAD), 'html nie powinien zawierać surowego payloadu XSS');
  assert.ok(r.html.includes(XSS_ESCAPED), 'html powinien zawierać uciecznięty payload');
});

console.log('\n2. recommendationNotificationEmail');

scenario('playerName podany -> powitanie "Cześć <Imię>,"', () => {
  const r = recommendationNotificationEmail({ playerName: 'Marek', segmentId: 'moc', weeklyFocusText: null, recommendationText: null });
  assert.match(r.html, /Cześć Marek,/);
});

scenario('playerName brak -> powitanie "Cześć," bez podwójnej spacji', () => {
  const r = recommendationNotificationEmail({ playerName: null, segmentId: 'moc' });
  assert.match(r.html, /Cześć, Twój asystent/);
});

scenario('nieznany segmentId -> temat i treść pokazują surowe id', () => {
  const r = recommendationNotificationEmail({ playerName: 'X', segmentId: 'segment-obcy' });
  assert.match(r.subject, /segment-obcy/);
});

scenario('weeklyFocusText/recommendationText oba puste -> odpowiednie bloki pominięte, brak crasha', () => {
  const r = recommendationNotificationEmail({ playerName: 'X', segmentId: 'moc', weeklyFocusText: null, recommendationText: null });
  assert.ok(!r.html.includes('null'));
  assert.match(r.html, /Otwórz Centrum Decyzji/);
});

scenario('weeklyFocusText i recommendationText podane -> oba widoczne w html I text', () => {
  const r = recommendationNotificationEmail({ playerName: 'X', segmentId: 'moc', weeklyFocusText: 'Focus na moc.', recommendationText: 'Zrób X.' });
  assert.match(r.html, /Focus na moc\./);
  assert.match(r.html, /Zrób X\./);
  assert.match(r.text, /Focus na moc\./);
  assert.match(r.text, /Zrób X\./);
});

scenario('XSS w recommendationText -> uciecznięty w html', () => {
  const r = recommendationNotificationEmail({ playerName: 'X', segmentId: 'moc', recommendationText: XSS_PAYLOAD });
  assert.ok(!r.html.includes(XSS_PAYLOAD));
  assert.ok(r.html.includes(XSS_ESCAPED));
});

console.log('\n3. retentionReminderEmail');

scenario('playerName podany -> "Cześć <Imię>,"', () => {
  const r = retentionReminderEmail({ playerName: 'Nina' });
  assert.match(r.html, /Cześć Nina,/);
  assert.match(r.text, /Cześć Nina,/);
});

scenario('brak argumentu (domyślny {}) -> "Cześć," bez imienia, nie wywala się', () => {
  const r = retentionReminderEmail();
  assert.match(r.html, /Cześć, zauważyliśmy/);
});

scenario('temat zawsze ten sam, niezależny od playerName', () => {
  const a = retentionReminderEmail({ playerName: 'A' });
  const b = retentionReminderEmail({ playerName: 'B' });
  assert.strictEqual(a.subject, b.subject);
});

scenario('ton NIE zawiera słów obwiniających ("zaległość", "musisz", "powinieneś")', () => {
  const r = retentionReminderEmail({ playerName: 'X' });
  ['zaległość', 'musisz', 'powinieneś'].forEach((slowo) => {
    assert.ok(!r.html.toLowerCase().includes(slowo), `nie powinno zawierać "${slowo}"`);
  });
});

scenario('XSS w playerName -> uciecznięty w html', () => {
  const r = retentionReminderEmail({ playerName: XSS_PAYLOAD });
  assert.ok(!r.html.includes(XSS_PAYLOAD));
  assert.ok(r.html.includes(XSS_ESCAPED));
});

console.log('\n4. parentalPaymentConsentEmail');

scenario('pricingTier="team_basic" -> etykieta "abonament drużynowy Gamechange"', () => {
  const r = parentalPaymentConsentEmail({ playerName: 'X', pricingTier: 'team_basic', confirmUrl: 'https://c', declineUrl: 'https://d' });
  assert.match(r.html, /abonament drużynowy Gamechange/);
});

scenario('pricingTier inny/brak -> etykieta "abonament Gamechange" (bez "drużynowy")', () => {
  const r = parentalPaymentConsentEmail({ playerName: 'X', pricingTier: 'individual', confirmUrl: 'https://c', declineUrl: 'https://d' });
  assert.match(r.html, /abonament Gamechange/);
  assert.ok(!r.html.includes('drużynowy'));
});

scenario('brak playerName -> domyślnie "Twoje dziecko"', () => {
  const r = parentalPaymentConsentEmail({ pricingTier: 'individual', confirmUrl: 'https://c', declineUrl: 'https://d' });
  assert.match(r.subject, /Twoje dziecko/);
});

scenario('expiresAt podane -> sformatowana data polska w nawiasie "(do ...)"', () => {
  const r = parentalPaymentConsentEmail({ playerName: 'X', pricingTier: 'individual', confirmUrl: 'https://c', declineUrl: 'https://d', expiresAt: '2026-08-18T00:00:00Z' });
  assert.match(r.html, /\(do \d+ sierpnia 2026\)/);
});

scenario('expiresAt brak -> BEZ fragmentu "(do ", tekst mimo to spójny', () => {
  const r = parentalPaymentConsentEmail({ playerName: 'X', pricingTier: 'individual', confirmUrl: 'https://c', declineUrl: 'https://d' });
  assert.ok(!r.html.includes('(do '));
  assert.match(r.html, /Prosimy tylko o formalne potwierdzenie w ciągu 14 dni\./);
});

scenario('confirmUrl/declineUrl obecne jako href w obu przyciskach', () => {
  const r = parentalPaymentConsentEmail({ playerName: 'X', pricingTier: 'individual', confirmUrl: 'https://c.example/1', declineUrl: 'https://d.example/2' });
  assert.match(r.html, /href="https:\/\/c\.example\/1"/);
  assert.match(r.html, /href="https:\/\/d\.example\/2"/);
  assert.match(r.text, /Potwierdzam: https:\/\/c\.example\/1/);
  assert.match(r.text, /Nie wyrażam zgody: https:\/\/d\.example\/2/);
});

scenario('zawsze wprost mówi, że dostęp jest AKTYWNY (nie blokujący ton) — spójne z opisem w komentarzu pliku', () => {
  const r = parentalPaymentConsentEmail({ playerName: 'X', pricingTier: 'individual', confirmUrl: 'https://c', declineUrl: 'https://d' });
  assert.match(r.html, /ma dziś pełny dostęp do appki/);
  assert.match(r.html, /nie musisz nic robić, żeby to zablokować/);
});

scenario('XSS w playerName -> uciecznięty w html (imię pojawia się wielokrotnie w treści)', () => {
  const r = parentalPaymentConsentEmail({ playerName: XSS_PAYLOAD, pricingTier: 'individual', confirmUrl: 'https://c', declineUrl: 'https://d' });
  assert.ok(!r.html.includes(XSS_PAYLOAD));
  assert.ok(r.html.includes(XSS_ESCAPED));
});

scenario('XSS w confirmUrl -> uciecznięty w atrybucie href (ochrona przed wyrwaniem się z cudzysłowu)', () => {
  const zlosliwyUrl = '"><script>alert(1)</script>';
  const r = parentalPaymentConsentEmail({ playerName: 'X', pricingTier: 'individual', confirmUrl: zlosliwyUrl, declineUrl: 'https://d' });
  assert.ok(!r.html.includes('"><script>alert(1)</script>'), 'URL nie powinien pozwolić wyrwać się z atrybutu href');
});

console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
process.exit(failed === 0 ? 0 : 1);

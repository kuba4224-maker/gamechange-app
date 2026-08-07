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
//
// DOPISANE 05.08.2026 (ODTWORZENIE Pakietu 20, ZADANIE 3) — sekcja 5,
// preMatchTeamBriefingEmail/weeklyTeamPulseEmail. Patrz nagłówek
// lib/coach-scheduled-reports.js po pełne wyjaśnienie, dlaczego to
// odtworzenie, nie oryginalna treść.
// ============================================================

const assert = require('assert');
const {
  parentReportEmail,
  recommendationNotificationEmail,
  retentionReminderEmail,
  parentalPaymentConsentEmail,
  preMatchTeamBriefingEmail,
  weeklyTeamPulseEmail,
  // RODZIC C4 08.08.2026 — warstwa materiałów dla rodzica.
  selectParentHints,
  describeParentActivity,
  describeParentChange,
  parentHintSource,
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

console.log('\n5. preMatchTeamBriefingEmail (Pakiet 20)');

scenario('brak zawodników na ryzyku -> temat i treść bez alarmu', () => {
  const r = preMatchTeamBriefingEmail({ teamName: 'Orły', checkedCount: 5, riskCount: 0, riskPlayerNames: [] });
  assert.match(r.subject, /skład bez sygnałów ryzyka/);
  assert.match(r.html, /Żaden z <strong>5<\/strong> sprawdzonych zawodników/);
  assert.match(r.text, /Żaden z 5 sprawdzonych zawodników/);
});

scenario('zawodnicy na ryzyku -> temat i treść wymieniają liczbę i imiona', () => {
  const r = preMatchTeamBriefingEmail({ teamName: 'Orły', checkedCount: 5, riskCount: 2, riskPlayerNames: ['Ala', 'Bartek'] });
  assert.match(r.subject, /2 zawodników wartych sprawdzenia/);
  assert.match(r.html, /Ala, Bartek/);
  assert.match(r.text, /2 z 5 sprawdzonych zawodników pokazuje dziś aktywny sygnał ryzyka: Ala, Bartek/);
});

scenario('dokładnie 1 zawodnik na ryzyku -> liczba pojedyncza "zawodnik wart"', () => {
  const r = preMatchTeamBriefingEmail({ teamName: 'Orły', checkedCount: 3, riskCount: 1, riskPlayerNames: ['Cela'] });
  assert.match(r.subject, /1 zawodnik wart sprawdzenia/);
});

scenario('brak teamName -> domyślnie "Twoja drużyna"', () => {
  const r = preMatchTeamBriefingEmail({ checkedCount: 1, riskCount: 0, riskPlayerNames: [] });
  assert.match(r.html, /Twoja drużyna/);
});

scenario('link prowadzi do coach.html (Skład Meczowy)', () => {
  const r = preMatchTeamBriefingEmail({ teamName: 'Orły', checkedCount: 1, riskCount: 0, riskPlayerNames: [] });
  assert.match(r.html, /href="https:\/\/gamechange-app\.vercel\.app\/coach\.html"/);
});

scenario('XSS w riskPlayerNames -> uciecznięty w html', () => {
  const r = preMatchTeamBriefingEmail({ teamName: 'Orły', checkedCount: 1, riskCount: 1, riskPlayerNames: [XSS_PAYLOAD] });
  assert.ok(!r.html.includes(XSS_PAYLOAD));
  assert.ok(r.html.includes(XSS_ESCAPED));
});

scenario('XSS w teamName -> uciecznięty w html', () => {
  const r = preMatchTeamBriefingEmail({ teamName: XSS_PAYLOAD, checkedCount: 1, riskCount: 0, riskPlayerNames: [] });
  assert.ok(!r.html.includes(XSS_PAYLOAD));
  assert.ok(r.html.includes(XSS_ESCAPED));
});

scenario('stopka odsyła do sekcji "Raporty w wybranych momentach" w Ustawieniach', () => {
  const r = preMatchTeamBriefingEmail({ teamName: 'Orły', checkedCount: 1, riskCount: 0, riskPlayerNames: [] });
  assert.match(r.html, /Raporty w wybranych momentach/);
});

console.log('\n6. weeklyTeamPulseEmail (Pakiet 20)');

scenario('procent aktywności policzony poprawnie w html i text', () => {
  const r = weeklyTeamPulseEmail({ teamName: 'Orły', rosterCount: 10, activePlayersCount: 4, activeFocusBlocksCount: 2 });
  assert.match(r.html, /<strong>4 z 10<\/strong> zawodników/);
  assert.match(r.html, /\(40%\)/);
  assert.match(r.text, /4 z 10 zawodników \(40%\)/);
});

scenario('dzielenie przez zero (pusty roster) -> 0%, nie NaN, nie wywala', () => {
  const r = weeklyTeamPulseEmail({ teamName: 'Orły', rosterCount: 0, activePlayersCount: 0, activeFocusBlocksCount: 0 });
  assert.ok(!r.html.includes('NaN'));
  assert.match(r.html, /0%/);
});

scenario('1 aktywny Blok Skupienia -> liczba pojedyncza', () => {
  const r = weeklyTeamPulseEmail({ teamName: 'Orły', rosterCount: 5, activePlayersCount: 5, activeFocusBlocksCount: 1 });
  assert.match(r.html, /1<\/strong> aktywny Blok Skupienia/);
  assert.match(r.text, /1 aktywny Blok Skupienia/);
});

scenario('0 aktywnych Bloków Skupienia -> liczba mnoga "aktywnych"', () => {
  const r = weeklyTeamPulseEmail({ teamName: 'Orły', rosterCount: 5, activePlayersCount: 5, activeFocusBlocksCount: 0 });
  assert.match(r.html, /aktywnych Bloków Skupienia/);
});

scenario('brak teamName -> domyślnie "Twoja drużyna"', () => {
  const r = weeklyTeamPulseEmail({ rosterCount: 1, activePlayersCount: 1, activeFocusBlocksCount: 0 });
  assert.match(r.html, /Twoja drużyna/);
});

scenario('temat zawsze ten sam wzorzec, niezależny od liczb', () => {
  const r = weeklyTeamPulseEmail({ teamName: 'Orły', rosterCount: 5, activePlayersCount: 0, activeFocusBlocksCount: 0 });
  assert.strictEqual(r.subject, 'Cotygodniowy puls drużyny — Orły');
});

scenario('XSS w teamName -> uciecznięty w html', () => {
  const r = weeklyTeamPulseEmail({ teamName: XSS_PAYLOAD, rosterCount: 1, activePlayersCount: 1, activeFocusBlocksCount: 0 });
  assert.ok(!r.html.includes(XSS_PAYLOAD));
  assert.ok(r.html.includes(XSS_ESCAPED));
});

scenario('stopka odsyła do sekcji "Raporty w wybranych momentach" w Ustawieniach', () => {
  const r = weeklyTeamPulseEmail({ teamName: 'Orły', rosterCount: 1, activePlayersCount: 1, activeFocusBlocksCount: 0 });
  assert.match(r.html, /Raporty w wybranych momentach/);
});

console.log('\n6b. weeklyTeamPulseEmail — NOWE liczniki rozwojowe (redesign 06.08.2026)');

scenario('ZERO celów i ZERO sygnałów ryzyka -> "0 osiągniętych celów" / "0 aktywnych sygnałów ryzyka/przeciążenia"', () => {
  const r = weeklyTeamPulseEmail({
    teamName: 'Orły', rosterCount: 10, activePlayersCount: 4, activeFocusBlocksCount: 2,
    goalsAchievedCount: 0, riskSignalsCount: 0,
  });
  assert.match(r.html, /<strong>0<\/strong> osiągniętych celów w drużynie w tym tygodniu/);
  assert.match(r.html, /<strong>0<\/strong> aktywnych sygnałów ryzyka\/przeciążenia w tym tygodniu/);
  assert.match(r.text, /0 osiągniętych celów w drużynie w tym tygodniu/);
  assert.match(r.text, /0 aktywnych sygnałów ryzyka\/przeciążenia w tym tygodniu/);
});

scenario('brak nowych pól w ogóle (domyślne {}) -> traktowane jak 0, nie "undefined"/NaN, nie wywala', () => {
  const r = weeklyTeamPulseEmail({ teamName: 'Orły', rosterCount: 5, activePlayersCount: 2, activeFocusBlocksCount: 1 });
  assert.ok(!r.html.includes('undefined'));
  assert.ok(!r.html.includes('NaN'));
  assert.match(r.html, /<strong>0<\/strong> osiągniętych celów/);
});

scenario('dokładnie 1 osiągnięty cel -> liczba pojedyncza "osiągnięty cel"', () => {
  const r = weeklyTeamPulseEmail({
    teamName: 'Orły', rosterCount: 10, activePlayersCount: 4, activeFocusBlocksCount: 0,
    goalsAchievedCount: 1, riskSignalsCount: 0,
  });
  assert.match(r.html, /1<\/strong> osiągnięty cel w drużynie/);
  assert.match(r.text, /1 osiągnięty cel w drużynie/);
  assert.ok(!r.html.includes('1 osiągniętych celów'));
});

scenario('KILKA (3) osiągniętych celów -> liczba mnoga "osiągniętych celów"', () => {
  const r = weeklyTeamPulseEmail({
    teamName: 'Orły', rosterCount: 10, activePlayersCount: 4, activeFocusBlocksCount: 0,
    goalsAchievedCount: 3, riskSignalsCount: 0,
  });
  assert.match(r.html, /3<\/strong> osiągniętych celów w drużynie/);
});

scenario('DUŻO (14) osiągniętych celów -> liczba mnoga, poprawna wartość', () => {
  const r = weeklyTeamPulseEmail({
    teamName: 'Orły', rosterCount: 20, activePlayersCount: 18, activeFocusBlocksCount: 3,
    goalsAchievedCount: 14, riskSignalsCount: 0,
  });
  assert.match(r.html, /14<\/strong> osiągniętych celów w drużynie/);
  assert.match(r.text, /14 osiągniętych celów w drużynie/);
});

scenario('dokładnie 1 aktywny sygnał ryzyka/przeciążenia -> liczba pojedyncza', () => {
  const r = weeklyTeamPulseEmail({
    teamName: 'Orły', rosterCount: 10, activePlayersCount: 4, activeFocusBlocksCount: 0,
    goalsAchievedCount: 0, riskSignalsCount: 1,
  });
  assert.match(r.html, /1<\/strong> aktywny sygnał ryzyka\/przeciążenia w tym tygodniu/);
  assert.match(r.text, /1 aktywny sygnał ryzyka\/przeciążenia w tym tygodniu/);
  assert.ok(!r.html.includes('1 aktywnych sygnałów'));
});

scenario('KILKA (4) aktywnych sygnałów ryzyka/przeciążenia -> liczba mnoga', () => {
  const r = weeklyTeamPulseEmail({
    teamName: 'Orły', rosterCount: 10, activePlayersCount: 4, activeFocusBlocksCount: 0,
    goalsAchievedCount: 0, riskSignalsCount: 4,
  });
  assert.match(r.html, /4<\/strong> aktywnych sygnałów ryzyka\/przeciążenia w tym tygodniu/);
});

scenario('DUŻO (9) aktywnych sygnałów ryzyka/przeciążenia -> liczba mnoga, poprawna wartość', () => {
  const r = weeklyTeamPulseEmail({
    teamName: 'Orły', rosterCount: 20, activePlayersCount: 15, activeFocusBlocksCount: 2,
    goalsAchievedCount: 5, riskSignalsCount: 9,
  });
  assert.match(r.html, /9<\/strong> aktywnych sygnałów ryzyka\/przeciążenia w tym tygodniu/);
  assert.match(r.text, /9 aktywnych sygnałów ryzyka\/przeciążenia w tym tygodniu/);
});

scenario('istniejące dwie liczby (aktywność/Bloki Skupienia) NIE zmienione przez dodanie nowych liczb', () => {
  const r = weeklyTeamPulseEmail({
    teamName: 'Orły', rosterCount: 10, activePlayersCount: 4, activeFocusBlocksCount: 2,
    goalsAchievedCount: 3, riskSignalsCount: 2,
  });
  assert.match(r.html, /<strong>4 z 10<\/strong> zawodników/);
  assert.match(r.html, /\(40%\)/);
  assert.match(r.html, /2<\/strong> aktywnych Bloków Skupienia/);
});

scenario('XSS-owy ładunek w goalsAchievedCount/riskSignalsCount (obronnie, mimo że w praktyce zawsze liczby) -> uciecznięty w html', () => {
  const r = weeklyTeamPulseEmail({
    teamName: 'Orły', rosterCount: 5, activePlayersCount: 2, activeFocusBlocksCount: 0,
    goalsAchievedCount: XSS_PAYLOAD, riskSignalsCount: XSS_PAYLOAD,
  });
  assert.ok(!r.html.includes(XSS_PAYLOAD));
  assert.ok(r.html.includes(XSS_ESCAPED));
});

// ============================================================
// 7. RODZIC C4 08.08.2026 — WARSTWA MATERIAŁÓW DLA RODZICA
// ============================================================
// Ta sekcja istnieje z jednego powodu, ważniejszego niż pokrycie kodu:
// **bramka wiekowa decyzji A9 jest jedyną rzeczą w tej rundzie, której
// pomyłka ma realny koszt zdrowotny.** Pomyłka w jedną stronę = dawki
// suplementów podane jedenastolatkowi. Pomyłka w drugą = rodzic, który
// za suplement płaci i za dawkę odpowiada, nie dostaje liczby.
//
// Dowód konstrukcyjny (mocniejszy niż jakikolwiek test): `selectParentHints`
// NIE PRZYJMUJE WIEKU. Nie da się przekazać jej złego progu, bo nie da się
// przekazać jej żadnego. Testy niżej pilnują, żeby ten stan się utrzymał.
console.log('\n7. RODZIC C4 — warstwa materiałów dla rodzica (bramka wiekowa A9)');

// Realne wiersze z PODPOWIEDZI_Z_MATERIALOW_A.md, segment `regeneracja`
// (jedyny, który ma i podpowiedzi z dawkami, i wspólne) — przepisane
// dosłownie, żeby test sprawdzał treść, którą rodzic realnie dostanie.
const HINTS_REGENERACJA = [
  { klucz: 'regeneracja-segment-08', hint: 'Dawka bazowa dla zawodnika ok. 70 kg: 200–400 mg magnezu elementarnego dziennie, wieczorem przed snem. W okresach dużych obciążeń 300–500 mg.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '5, 13', pozycja: 8 },
  { klucz: 'regeneracja-segment-09', hint: 'Wybieraj diglicynian albo cytrynian magnezu, unikaj tlenku.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '5, 13–14', pozycja: 9 },
  { klucz: 'regeneracja-segment-12', hint: 'L-treonian magnezu to dodatek na funkcje mózgu, nie baza.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '12, 13', pozycja: 12 },
  { klucz: 'regeneracja-segment-10', hint: 'Przy zdrowych nerkach przedawkowanie magnezu jest mało prawdopodobne.', odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrozumiec', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '11', pozycja: 10 },
  { klucz: 'regeneracja-wyduzenie-snu-nocnego-o-46-113-minut-02', hint: 'Wyznacz stałą godzinę snu i trzymaj się jej codziennie, także w weekendy.', odbiorca: 'oba', min_age: null, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '2', pozycja: 2 },
  { klucz: 'regeneracja-segment-01', hint: 'W ciągu 30–60 minut po treningu zjedz posiłek z węglowodanami i białkiem.', odbiorca: 'oba', min_age: null, rodzaj: 'zrobic', zrodlo: 'Regeneracja — System Gamechange (pełny)', strony: '3', pozycja: 1 },
  // Ten wiersz NIE MOŻE trafić do rodzica — jest pisany do zawodnika.
  { klucz: 'regeneracja-segment-07', hint: 'Magnez to sprawa do ustalenia z rodzicem — to on kupuje i pilnuje dawki.', odbiorca: 'zawodnik', min_age: null, rodzaj: 'zrozumiec', zrodlo: 'decyzja A9 (tekst systemowy — nie z materiału)', strony: '—', pozycja: 7 },
];

const RAPORT_12LAT = {
  player_name: 'Antek',
  priority_goal: { segment_id: 'regeneracja', horizon_weeks: 6 },
  active_goals_count: 2,
  recent_training_sessions_7d: 3,
  recent_matches_30d: 1,
  growth_spurt_typical_age_range: true,
  height_growth_rate_elevated: false,
  last_diagnosis_at: '2026-07-20T10:00:00Z',
};
const RAPORT_17LAT = Object.assign({}, RAPORT_12LAT, {
  player_name: 'Marcel',
  growth_spurt_typical_age_range: false,
});

// ---- 7a. BRAMKA WIEKOWA ----
scenario('A9 / DOWÓD KONSTRUKCYJNY: selectParentHints nie przyjmuje wieku (arność 1)', () => {
  assert.strictEqual(selectParentHints.length, 1,
    'Jeśli ten test padł, ktoś dodał do funkcji parametr — najpewniej wiek. To jest dokładnie ta zmiana, której nie wolno zrobić.');
});

scenario('A9 / dziecko 12 lat: rodzic DOSTAJE wszystkie trzy podpowiedzi z dawkami', () => {
  const w = selectParentHints(HINTS_REGENERACJA);
  const klucze = w.doZrobienia.concat(w.wartoWiedziec).map((h) => h.klucz);
  assert.ok(klucze.includes('regeneracja-segment-08'), 'dawka bazowa magnezu musi trafić do rodzica');
  assert.ok(klucze.includes('regeneracja-segment-09'), 'forma magnezu musi trafić do rodzica');
  assert.ok(klucze.includes('regeneracja-segment-12'), 'L-treonian musi trafić do rodzica');
  assert.strictEqual(w.zDawkami, 4, 'wszystkie cztery wiersze z min_age=16 są policzone');
});

scenario('A9 / dziecko 17 lat: dokładnie ten sam zestaw co dla 12-latka (wiek nie ma tu wpływu)', () => {
  const a = selectParentHints(HINTS_REGENERACJA);
  const b = selectParentHints(HINTS_REGENERACJA);
  assert.deepStrictEqual(
    a.doZrobienia.concat(a.wartoWiedziec).map((h) => h.klucz),
    b.doZrobienia.concat(b.wartoWiedziec).map((h) => h.klucz)
  );
});

scenario('A9 / treść pisana DO ZAWODNIKA nigdy nie trafia do rodzica', () => {
  const w = selectParentHints(HINTS_REGENERACJA);
  const klucze = w.doZrobienia.concat(w.wartoWiedziec).map((h) => h.klucz);
  assert.ok(!klucze.includes('regeneracja-segment-07'), 'odbiorca=zawodnik musi wypaść');
  assert.strictEqual(w.dostepnych, 6, '7 wierszy wejściowych minus jeden dla zawodnika');
});

scenario('A9 / podpowiedzi z dawkami NIE mogą wypaść przez limit (są sortowane przed wspólne)', () => {
  // Regresja na realny błąd, który miałaby wersja sortująca wyłącznie po
  // `pozycja`: dawki mają pozycje 8–12, wspólne 1–2, więc przy limicie 6
  // dawki wypadłyby jako ostatnie — czyli rodzic NIE dostałby dokładnie
  // tego, co A9 każe mu dać.
  const duzoWspolnych = [];
  for (let i = 1; i <= 20; i++) {
    duzoWspolnych.push({ klucz: `oba-${i}`, hint: `Wspólna ${i}`, odbiorca: 'oba', min_age: null, rodzaj: 'zrobic', zrodlo: 'X', strony: '1', pozycja: i });
  }
  const w = selectParentHints(duzoWspolnych.concat(HINTS_REGENERACJA));
  const doKlucze = w.doZrobienia.map((h) => h.klucz);
  assert.ok(doKlucze.includes('regeneracja-segment-08'));
  assert.ok(doKlucze.includes('regeneracja-segment-09'));
  assert.ok(doKlucze.includes('regeneracja-segment-12'));
  assert.strictEqual(w.doZrobienia[0].odbiorca, 'rodzic', 'treść wprost dla rodzica idzie pierwsza');
});

scenario('A9 / w e-mailu dla 12-latka realnie widać liczbę „200–400 mg" i zdanie o tym, że dziecko tego nie widzi', () => {
  const r = parentReportEmail({
    report: RAPORT_12LAT,
    unsubscribeUrl: 'https://x/raport-rodzica.html?token=t&action=unsubscribe',
    extras: { hints_available: true, hints: HINTS_REGENERACJA, segment_id: 'regeneracja' },
  });
  assert.match(r.html, /200–400 mg magnezu elementarnego/);
  assert.match(r.text, /200–400 mg magnezu elementarnego/);
  assert.match(r.html, /nie podaje dawek suplementów zawodnikom poniżej 16 lat/);
});

scenario('A9 / e-mail dla 17-latka zawiera dokładnie tę samą treść dawkową', () => {
  const r = parentReportEmail({
    report: RAPORT_17LAT,
    unsubscribeUrl: 'https://x/?token=t',
    extras: { hints_available: true, hints: HINTS_REGENERACJA, segment_id: 'regeneracja' },
  });
  assert.match(r.html, /200–400 mg magnezu elementarnego/);
});

scenario('A9 / brak wierszy z min_age -> zdanie o dawkach NIE pojawia się (nie straszymy bez powodu)', () => {
  const bezDawek = HINTS_REGENERACJA.filter((h) => h.min_age == null);
  const r = parentReportEmail({
    report: RAPORT_12LAT, unsubscribeUrl: '',
    extras: { hints_available: true, hints: bezDawek, segment_id: 'regeneracja' },
  });
  assert.ok(!r.html.includes('nie podaje dawek suplementów'));
});

// ---- 7b. ŹRÓDŁO PRZY KAŻDEJ PODPOWIEDZI ----
scenario('każda pokazana podpowiedź ma źródło: materiał + strona', () => {
  const r = parentReportEmail({
    report: RAPORT_12LAT, unsubscribeUrl: '',
    extras: { hints_available: true, hints: HINTS_REGENERACJA, segment_id: 'regeneracja' },
  });
  assert.match(r.html, /Regeneracja — System Gamechange \(pełny\), s\. 5, 13/);
  assert.match(r.text, /Regeneracja — System Gamechange \(pełny\), s\. 2/);
});

scenario('źródło bez sensownej strony („—") nie produkuje „s. —"', () => {
  assert.strictEqual(parentHintSource({ zrodlo: 'decyzja A9', strony: '—' }), 'decyzja A9');
  assert.strictEqual(parentHintSource({ zrodlo: 'Moc', strony: '3' }), 'Moc, s. 3');
  assert.strictEqual(parentHintSource(null), '');
});

// ---- 7c. TRZY UCZCIWE STANY PUSTKI (R5) ----
scenario('R5 / są wpisy -> stan „aktywny", żadnego pudełka wyjaśniającego', () => {
  const s = describeParentActivity({ report: RAPORT_12LAT, lastLogAt: '2026-08-06T18:00:00Z', now: '2026-08-08T10:00:00Z' });
  assert.strictEqual(s.state, 'aktywny');
});

scenario('R5 / zero wpisów, ale konto żyje -> stan „cisza" i JAWNE rozróżnienie „nie zapisuje" od „nie trenuje"', () => {
  const raport = Object.assign({}, RAPORT_12LAT, { recent_training_sessions_7d: 0, recent_matches_30d: 0 });
  const s = describeParentActivity({ report: raport, lastLogAt: '2026-07-25T10:00:00Z', now: '2026-08-08T10:00:00Z' });
  assert.strictEqual(s.state, 'cisza');
  assert.strictEqual(s.daysSinceLastLog, 14, 'dwa tygodnie ciszy policzone dokładnie');
  assert.match(s.body, /sprzed 14 dni/);
  assert.match(s.body, /nie znaczy, że dziecko nie trenuje — znaczy, że nie zapisuje/);
});

scenario('R5 / zero wszystkiego (brak diagnozy, celu i wpisów) -> stan „niezaczete", inna wiadomość niż „cisza"', () => {
  const raport = {
    player_name: 'Nikt', priority_goal: null, active_goals_count: 0,
    recent_training_sessions_7d: 0, recent_matches_30d: 0, last_diagnosis_at: null,
  };
  const s = describeParentActivity({ report: raport, lastLogAt: null, now: '2026-08-08T10:00:00Z' });
  assert.strictEqual(s.state, 'niezaczete');
  assert.match(s.body, /nie zaczęło jeszcze korzystać z aplikacji/);
  assert.ok(!s.body.includes('nie zapisuje'), 'to inna wiadomość niż stan „cisza"');
});

scenario('R5 / trzy stany dają trzy RÓŻNE teksty (nie jeden komunikat na wszystko)', () => {
  const aktywny = describeParentActivity({ report: RAPORT_12LAT, lastLogAt: '2026-08-08T09:00:00Z', now: '2026-08-08T10:00:00Z' });
  const cisza = describeParentActivity({ report: Object.assign({}, RAPORT_12LAT, { recent_training_sessions_7d: 0, recent_matches_30d: 0 }), lastLogAt: '2026-07-01T10:00:00Z', now: '2026-08-08T10:00:00Z' });
  const niezaczete = describeParentActivity({ report: { active_goals_count: 0, recent_training_sessions_7d: 0, recent_matches_30d: 0 }, lastLogAt: null, now: '2026-08-08T10:00:00Z' });
  const teksty = new Set([aktywny.body, cisza.body, niezaczete.body]);
  assert.strictEqual(teksty.size, 3);
});

scenario('R5 / stan „cisza" bez daty ostatniego wpisu (daily_logs nieczytelne) -> mówi „nie zapisało ani jednego wpisu", nie zmyśla liczby', () => {
  const raport = Object.assign({}, RAPORT_12LAT, { recent_training_sessions_7d: 0, recent_matches_30d: 0 });
  const s = describeParentActivity({ report: raport, lastLogAt: null, now: '2026-08-08T10:00:00Z' });
  assert.strictEqual(s.state, 'cisza');
  assert.match(s.body, /nie zapisało ani jednego wpisu/);
  assert.ok(!/sprzed \d+ dni/.test(s.body));
});

scenario('R5 / e-mail dla dziecka od dwóch tygodni bez wpisu zawiera pudełko wyjaśniające, a dla aktywnego NIE zawiera', () => {
  const cichy = parentReportEmail({
    report: Object.assign({}, RAPORT_12LAT, { recent_training_sessions_7d: 0, recent_matches_30d: 0 }),
    unsubscribeUrl: '',
    extras: { hints_available: true, hints: HINTS_REGENERACJA, segment_id: 'regeneracja', last_log_at: '2026-01-01T10:00:00Z' },
  });
  const aktywny = parentReportEmail({
    report: RAPORT_12LAT, unsubscribeUrl: '',
    extras: { hints_available: true, hints: HINTS_REGENERACJA, segment_id: 'regeneracja' },
  });
  assert.match(cichy.html, /znaczy, że nie zapisuje/);
  assert.ok(!aktywny.html.includes('znaczy, że nie zapisuje'));
});

// ---- 7d. CO SIĘ ZMIENIŁO OD OSTATNIEGO RAPORTU ----
scenario('zmiana / brak migawki -> uczciwe „to pierwszy raport", nie „bez zmian"', () => {
  const z = describeParentChange({ report: RAPORT_12LAT, previousReport: null });
  assert.strictEqual(z.hasPrevious, false);
  assert.match(z.note, /pierwszy raport/);
  assert.strictEqual(z.lines.length, 0);
});

scenario('zmiana / zmieniony obszar pracy nazwany obiema nazwami PL', () => {
  const z = describeParentChange({
    report: RAPORT_12LAT,
    previousReport: Object.assign({}, RAPORT_12LAT, { priority_goal: { segment_id: 'mental' } }),
    previousReportAt: '2026-07-08T10:00:00Z',
  });
  assert.ok(z.lines.some((l) => l.includes('„Odwaga w grze”') && l.includes('„Regeneracja”')),
    'nazwa segmentu mental musi brzmieć „Odwaga w grze" także tutaj (decyzja A1)');
});

scenario('zmiana / liczby porównane z poprzednim raportem, także gdy spadły', () => {
  const z = describeParentChange({
    report: Object.assign({}, RAPORT_12LAT, { recent_training_sessions_7d: 1 }),
    previousReport: Object.assign({}, RAPORT_12LAT, { recent_training_sessions_7d: 4 }),
  });
  assert.ok(z.lines.some((l) => /Zapisanych sesji w ostatnich 7 dniach: 1 — poprzednio 4\./.test(l)));
});

scenario('zmiana / identyczne liczby -> „tyle samo co poprzednio", nie milczenie', () => {
  const z = describeParentChange({ report: RAPORT_12LAT, previousReport: RAPORT_12LAT });
  assert.ok(z.lines.some((l) => /tyle samo co poprzednio/.test(l)));
});

// ---- 7e. UCZCIWA DEGRADACJA, GDY MIGRACJA NIEWKLEJONA ----
scenario('brak extras -> e-mail nadal się buduje, mówi wprost o braku biblioteki i o braku porównania', () => {
  const r = parentReportEmail({ report: RAPORT_12LAT, unsubscribeUrl: '' });
  assert.match(r.html, /Biblioteka wskazówek dla rodzica nie jest jeszcze podłączona/);
  assert.match(r.html, /pierwszy raport/);
  assert.ok(!r.html.includes('undefined'));
  assert.ok(!r.text.includes('undefined'));
});

scenario('hints_available=true, ale zero wierszy dla tego obszaru -> uczciwe „nie mamy jeszcze", nie pusta sekcja', () => {
  const r = parentReportEmail({
    report: Object.assign({}, RAPORT_12LAT, { priority_goal: { segment_id: 'moc' } }),
    unsubscribeUrl: '', extras: { hints_available: true, hints: [], segment_id: 'moc' },
  });
  assert.match(r.html, /Dla obszaru „Moc” nie mamy jeszcze wskazówek napisanych dla rodzica/);
});

scenario('limit wskazówek jest WIDOCZNY, nigdy cichy', () => {
  const duzo = [];
  for (let i = 1; i <= 30; i++) {
    duzo.push({ hint: `Wspólna ${i}`, odbiorca: 'oba', min_age: null, rodzaj: 'zrobic', zrodlo: 'X', strony: '1', pozycja: i });
  }
  const r = parentReportEmail({
    report: RAPORT_12LAT, unsubscribeUrl: '',
    extras: { hints_available: true, hints: duzo, segment_id: 'regeneracja' },
  });
  assert.match(r.html, /Pokazuję 6 z 30 wskazówek/);
});

// ---- 7f. NIC SIĘ NIE ZEPSUŁO I NIC NIE PRZECIEKA ----
scenario('XSS w treści podpowiedzi i w źródle -> uciecznięte', () => {
  const r = parentReportEmail({
    report: RAPORT_12LAT, unsubscribeUrl: '',
    extras: {
      hints_available: true, segment_id: 'regeneracja',
      hints: [{ hint: XSS_PAYLOAD, odbiorca: 'rodzic', min_age: 16, rodzaj: 'zrobic', zrodlo: XSS_PAYLOAD, strony: '1', pozycja: 1 }],
    },
  });
  assert.ok(!r.html.includes(XSS_PAYLOAD));
  assert.ok(r.html.includes(XSS_ESCAPED));
});

scenario('ŻADNA nowa sekcja nie mówi o płatności, cenie ani zakupie (PILOT_HIDE_PURCHASE w mocy)', () => {
  const r = parentReportEmail({
    report: RAPORT_12LAT, unsubscribeUrl: 'https://x/?token=t',
    extras: { hints_available: true, hints: HINTS_REGENERACJA, segment_id: 'regeneracja', previous_report: RAPORT_17LAT, previous_report_at: '2026-07-08T10:00:00Z' },
  });
  // Świadomie WĄSKIE wzorce: chodzi o wezwanie do zakupu, nie o samo słowo
  // „kupuje" — to ostatnie występuje w uczciwym zdaniu o tym, kto odpowiada
  // za dawkę suplementu, i ma tam zostać.
  [/kup teraz/i, /przejdź na (wersję|plan)/i, /cennik/i, /zapłać/i, /abonament/i,
   /\bpłatnoś/i, /\d+\s*zł/, /subskrypcj/i, /stripe/i, /checkout/i].forEach((wzorzec) => {
    assert.ok(!wzorzec.test(r.html), `raport rodzica nie może zawierać ${wzorzec}`);
    assert.ok(!wzorzec.test(r.text), `wersja tekstowa też nie może zawierać ${wzorzec}`);
  });
});

scenario('stare pola raportu nadal działają dokładnie tak samo (zero regresji)', () => {
  const r = parentReportEmail({
    report: RAPORT_12LAT, unsubscribeUrl: 'https://x/?token=t',
    extras: { hints_available: true, hints: HINTS_REGENERACJA, segment_id: 'regeneracja' },
  });
  assert.match(r.subject, /Raport Gamechange — Antek/);
  assert.match(r.html, /Priorytetowy cel tego okresu/);
  assert.match(r.html, /Aktywnych celów: <strong>2<\/strong>/);
  assert.match(r.html, /W tym wieku \(11–16 lat\)/);
  assert.match(r.html, /Wypisz się jednym kliknięciem/);
});

console.log(failed === 0 ? `\nWSZYSTKIE TESTY PRZESZŁY (${passed}).` : `\n${failed} TEST(ÓW) NIE PRZESZŁO (${passed} ok).`);
process.exit(failed === 0 ? 0 : 1);

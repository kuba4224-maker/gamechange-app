// ============================================================
// GAMECHANGE — lib/coach-feedback-round.js
// ============================================================
// FILAR B — "RUNDA OPINII" (NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md, sekcja
// "FILAR B — PROFIL I ROZWÓJ TRENERA" → "Runda Opinii — mechanizm zbierania
// głosu zawodników"). Mechanizm zbierania anonimowego głosu zawodników o
// (odczuwalnym efekcie) pracy trenera.
//
// ZASADY NIENARUSZALNE (nie psuć, cytowane wprost ze zlecenia):
// - Trener inicjuje NA ŻĄDANIE (przycisk), system NIGDY automatycznie.
// - Dystrybucja przez ISTNIEJĄCY kanał kodu drużyny (teams.code) — zero
//   nowej infrastruktury dystrybucyjnej, zawodnicy już znają ten kod.
// - Próg odblokowania wyniku: 5+ odpowiedzi (RESULT_UNLOCK_THRESHOLD niżej)
//   — INNY, NIŻSZY próg niż mapa cieplna drużyny (TEAM_AGGREGATE_MIN_SIZE=8
//   w coach.html) — to świadomie dwie różne stałe, nie pomyłka/duplikacja
//   do scalenia.
// - Pytania o odczuwalny EFEKT, nie ocenę wprost (FEEDBACK_ROUND_QUESTIONS
//   niżej — "czy po meczu wiesz co poprawić", nie "oceń trenera 1-5").
// - Wynik pokazuje trend względem WŁASNEJ historii trenera, NIGDY ranking
//   między trenerami (zapytania niżej są zawsze zawężone do jednego
//   konkretnego coachUserId, porównanie międzytrenerskie nigdzie się nie
//   pojawia jako operacja, nie tylko jako reguła UI).
// - Widoczność WYŁĄCZNIE dla trenera, który zainicjował rundę.
//
// ANONIMOWOŚĆ ZAWODNIKA (krytyczne, sprawdź to najpierw jeśli coś tu
// zmieniasz): coach_feedback_responses NIGDY nie przechowuje player_user_id
// wprost — tylko jednokierunkowy skrót (computeResponderHash niżej),
// wyłącznie do liczenia progu 5+/deduplikacji. Tabela ma w SQL ZERO
// polityk RLS dla anon/authenticated (patrz INTEGRACJA_FILAR_B_PROFIL_
// TRENERA_SQL.md) — jedyny dostęp to funkcje w tym pliku (service_role),
// które NIGDY nie zwracają responder_hash na zewnątrz, tylko zagregowane
// liczby (buildRoundAggregate/buildTrend). To ważne DODATKOWO dlatego, że
// trener zna player_user_id każdego swojego zawodnika (z team_memberships)
// — gdyby kiedyś przez pomyłkę dodano politykę SELECT na surowe wiersze,
// mógłby próbować odtworzyć tożsamość przez porównanie hashy; hash +
// brak jakiejkolwiek ścieżki zwracającej surowe wiersze to dwie niezależne
// warstwy ochrony, nie jedna.
//
// UI ZAWODNIKA — opinia-trenera.html (04.08.2026, druga runda tej samej
// nocy). submitFeedbackResponse() niżej jest wołane z nowego, publicznego,
// NIEZAMROŻONEGO pliku opinia-trenera.html (analogicznego do
// raport-rodzica.html/potwierdz-platnosc.html) — zwykły `fetch('/api/
// generate-coach-tip', {action:'submit_feedback_response'})`, BEZ
// logowania. Zamiast prawdziwego player_user_id (co wymagałoby sesji Auth,
// czyli dotknięcia ZAMROŻONEGO asystent_app.html) formularz wysyła losowy,
// wygenerowany w przeglądarce token (crypto.randomUUID(), trzymany w
// localStorage WYŁĄCZNIE po to, żeby ten sam telefon nie wysłał dwóch
// odpowiedzi do tej samej rundy) — parametr `playerUserId` poniżej jest
// więc w tej ścieżce NIEZWIĄZANY z żadnym prawdziwym kontem: to jeszcze
// silniejsza anonimowość niż pierwotnie zakładano (zero realnej tożsamości
// przechodzi przez system w ogóle, nie tylko nie jest przechowywana po
// haszowaniu). Ścieżka appki mobilnej (prawdziwy, zalogowany
// player_user_id) pozostaje możliwa w przyszłości bez zmiany tej funkcji —
// parametr przyjmuje dowolny stabilny string.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

const RESULT_UNLOCK_THRESHOLD = 5;

// ------------------------------------------------------------
// Pytania o ODCZUWALNY EFEKT, nie ocenę wprost (zasada nienaruszalna,
// patrz nagłówek pliku). `options[0]` jest ZAWSZE najbardziej pozytywną/
// pożądaną odpowiedzią w każdym pytaniu — to założenie wykorzystuje
// computeQuestionAggregate() niżej, żeby policzyć jedną, porównywalną
// metrykę trendu per pytanie ("% odpowiedzi najbardziej pozytywnych").
//
// PIĘĆ pytań (zlecenie: "zaprojektuj 4-6 pytań pokrywających mniej więcej
// segmenty 3 [komunikacja] i 6 [poczucie własnego rozwoju trenera]").
// Skala: 4 opcje opisowe zamiast czystego Likerta 1-5 — świadoma decyzja
// projektowa, ten sam powód co reszta pliku: "1-5" zaprasza do myślenia
// "oceniam trenera", opisowa etykieta ("Tak, konkretnie wiem" / "Rzadko")
// trzyma pytanie przy ODCZUWALNYM EFEKCIE, nie ocenie. `nie_wiem` zawsze
// jako czwarta opcja — uczciwa droga wyjścia zamiast wymuszania fałszywej
// pewności. Rozkład tematyczny: Q1/Q3/Q5 = komunikacja (segment 3), Q2/Q4 =
// poczucie rozwoju zawodnika pod tym trenerem — najbliższy dostępny PROXY
// dla segmentu 6 (poczucie WŁASNEGO rozwoju trenera) możliwy do zapytania
// zawodnika wprost — trener sam nie może ocenić własnego rozwoju cudzymi
// ustami, ale "czy czuję że się rozwijam pod tym trenerem" jest uczciwym,
// obserwowalnym efektem tej samej jakości pracy, bez zgadywania wnętrza
// trenera.
// ------------------------------------------------------------
const FEEDBACK_ROUND_QUESTIONS = [
  {
    key: 'po_meczu_wiem_co_poprawic',
    text: 'Czy po meczu wiesz dokładnie, co masz poprawić na następny raz?',
    options: [
      { value: 'tak_konkretnie', label: 'Tak, konkretnie wiem' },
      { value: 'czesciowo', label: 'Częściowo, ogólny kierunek' },
      { value: 'rzadko', label: 'Rzadko, zwykle się domyślam' },
      { value: 'nie_wiem', label: 'Nie wiem / trudno powiedzieć' },
    ],
  },
  {
    key: 'trener_zauwaza_moj_postep',
    text: 'Czy czujesz, że trener zauważa Twój indywidualny postęp, nie tylko wynik całej drużyny?',
    options: [
      { value: 'tak_czesto', label: 'Tak, często to czuję' },
      { value: 'czasami', label: 'Czasami' },
      { value: 'rzadko', label: 'Rzadko' },
      { value: 'nie_wiem', label: 'Nie wiem / trudno powiedzieć' },
    ],
  },
  {
    key: 'rozumiem_decyzje_o_mojej_roli',
    text: 'Czy rozumiesz, dlaczego trener podejmuje decyzje o Twojej roli w meczu (gra/zmiana/pozycja)?',
    options: [
      { value: 'tak_rozumiem', label: 'Tak, zwykle rozumiem dlaczego' },
      { value: 'czesciowo', label: 'Częściowo' },
      { value: 'rzadko', label: 'Rzadko rozumiem' },
      { value: 'nie_wiem', label: 'Nie wiem / trudno powiedzieć' },
    ],
  },
  {
    key: 'czuje_ze_sie_rozwijam',
    text: 'Czy czujesz, że w tym sezonie rozwijasz się jako piłkarz/piłkarka pod okiem tego trenera?',
    options: [
      { value: 'tak_wyraznie', label: 'Tak, wyraźnie się rozwijam' },
      { value: 'troche', label: 'Trochę' },
      { value: 'niewiele', label: 'Niewiele' },
      { value: 'nie_wiem', label: 'Nie wiem / trudno powiedzieć' },
    ],
  },
  {
    key: 'latwo_podejsc_z_pytaniem',
    text: 'Czy łatwo Ci podejść do trenera z pytaniem albo wątpliwością, kiedy jej potrzebujesz?',
    options: [
      { value: 'tak_latwo', label: 'Tak, łatwo' },
      { value: 'czasami', label: 'Czasami' },
      { value: 'rzadko', label: 'Rzadko' },
      { value: 'nie_wiem', label: 'Nie wiem / trudno powiedzieć' },
    ],
  },
];

function isValidFeedbackAnswers(answers) {
  if (!answers || typeof answers !== 'object') return false;
  return FEEDBACK_ROUND_QUESTIONS.every((q) => {
    const val = answers[q.key];
    return typeof val === 'string' && q.options.some((o) => o.value === val);
  });
}

// Skrót jednokierunkowy round_id+player_user_id — patrz "ANONIMOWOŚĆ
// ZAWODNIKA" w nagłówku pliku. round_id to losowy UUID (gen_random_uuid()),
// więc kombinacja jest praktycznie niemożliwa do odtworzenia bez obu
// wartości naraz.
function computeResponderHash(roundId, playerUserId) {
  if (!roundId || !playerUserId) throw new Error('computeResponderHash: brak roundId/playerUserId.');
  return crypto.createHash('sha256').update(`${roundId}:${playerUserId}`).digest('hex');
}

// % respondentów, którzy wybrali options[0] (najbardziej pozytywna opcja)
// dla danego pytania — jedna, porównywalna metryka do liczenia trendu.
function computeQuestionAggregate(question, responses) {
  const total = responses.length;
  const counts = {};
  question.options.forEach((o) => { counts[o.value] = 0; });
  responses.forEach((r) => {
    const val = r.answers && r.answers[question.key];
    if (val && Object.prototype.hasOwnProperty.call(counts, val)) counts[val] += 1;
  });
  const topOptionValue = question.options[0].value;
  const positiveRate = total > 0 ? Math.round((counts[topOptionValue] / total) * 100) : null;
  return { questionKey: question.key, text: question.text, counts, total, positiveRate };
}

function buildRoundAggregate(responses) {
  return FEEDBACK_ROUND_QUESTIONS.map((q) => computeQuestionAggregate(q, responses));
}

// Trend względem WŁASNEJ POPRZEDNIEJ rundy tego samego trenera (nigdy
// ranking między trenerami — patrz nagłówek pliku). null jeśli nie ma
// poprzedniej rundy z odblokowanym (>=próg) wynikiem do porównania.
function buildTrend(currentAggregate, previousAggregate) {
  if (!previousAggregate) return null;
  return currentAggregate.map((cur) => {
    const prev = previousAggregate.find((p) => p.questionKey === cur.questionKey);
    if (!prev || prev.positiveRate === null || cur.positiveRate === null) {
      return { questionKey: cur.questionKey, delta: null };
    }
    return { questionKey: cur.questionKey, delta: cur.positiveRate - prev.positiveRate };
  });
}

// ------------------------------------------------------------
// AUTORYZACJA — ten sam wzorzec (i świadoma duplikacja) co
// fetchAndAuthorizeTeam w api/generate-coach-tip.js.
// ------------------------------------------------------------
async function fetchAndAuthorizeTeam(supabase, teamId, coachUserId) {
  if (!teamId || !coachUserId) throw new Error('fetchAndAuthorizeTeam: brak teamId/coachUserId.');
  const { data: team, error } = await supabase
    .from('teams').select('id, coach_user_id, code, club_name').eq('id', teamId).maybeSingle();
  if (error) throw new Error(`fetchAndAuthorizeTeam: ${error.message}`);
  if (!team || team.coach_user_id !== coachUserId) {
    return { authorized: false, team: null };
  }
  return { authorized: true, team };
}

// ------------------------------------------------------------
// ROZPOCZĘCIE RUNDY — trener klika "Zbierz opinie zespołu". Domyślnie
// (forceNew=false) REUŻYWA istniejącą aktywną rundę tej drużyny, jeśli
// jest (klikanie przycisku wielokrotnie nie tworzy spamu rund — "Trener
// inicjuje NA ŻĄDANIE", nie ma potrzeby żeby każdy klik tworzył nowy byt).
// forceNew=true zamyka poprzednią i zaczyna świeżą (np. trener chce nowy
// punkt danych do trendu po dłuższym czasie).
// ------------------------------------------------------------
async function startFeedbackRound(params, injectedSupabase) {
  const { coachUserId, teamId, forceNew } = params || {};
  if (!coachUserId) throw new Error('startFeedbackRound: brak coachUserId.');
  if (!teamId) throw new Error('startFeedbackRound: brak teamId.');

  const supabase = injectedSupabase || getAdminClient();

  const { authorized, team } = await fetchAndAuthorizeTeam(supabase, teamId, coachUserId);
  if (!authorized) {
    return { ok: false, blocked: true, reason: 'Brak uprawnień: podana drużyna nie należy do tego trenera.' };
  }

  const { data: existingActive, error: existingError } = await supabase
    .from('coach_feedback_rounds').select('*')
    .eq('team_id', teamId).eq('status', 'active').maybeSingle();
  if (existingError) throw new Error(`startFeedbackRound(existing): ${existingError.message}`);

  if (existingActive && !forceNew) {
    return { ok: true, blocked: false, round: existingActive, reused: true, teamCode: team.code };
  }

  if (existingActive && forceNew) {
    const { error: closeError } = await supabase
      .from('coach_feedback_rounds').update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', existingActive.id);
    if (closeError) throw new Error(`startFeedbackRound(close): ${closeError.message}`);
  }

  const { data: inserted, error: insertError } = await supabase
    .from('coach_feedback_rounds')
    .insert({ coach_user_id: coachUserId, team_id: teamId, status: 'active' })
    .select().single();
  if (insertError) throw new Error(`startFeedbackRound(insert): ${insertError.message}`);

  return { ok: true, blocked: false, round: inserted, reused: false, teamCode: team.code };
}

// ------------------------------------------------------------
// ODPOWIEDŹ ZAWODNIKA — wołane z opinia-trenera.html, patrz "UI ZAWODNIKA"
// w nagłówku pliku. Identyfikacja rundy przez teamCode (istniejący kanał
// kodu drużyny), NIE przez wewnętrzny teamId — zawodnik zna kod, nie
// identyfikator z bazy.
// ------------------------------------------------------------
async function submitFeedbackResponse(params, injectedSupabase) {
  const { teamCode, playerUserId, answers } = params || {};
  if (!teamCode) throw new Error('submitFeedbackResponse: brak teamCode.');
  if (!playerUserId) throw new Error('submitFeedbackResponse: brak playerUserId.');
  if (!isValidFeedbackAnswers(answers)) {
    return { ok: false, blocked: true, reason: 'Odpowiedzi niekompletne albo nieprawidłowe — sprawdź wszystkie pytania.' };
  }

  const supabase = injectedSupabase || getAdminClient();

  const { data: team, error: teamError } = await supabase
    .from('teams').select('id').eq('code', teamCode).maybeSingle();
  if (teamError) throw new Error(`submitFeedbackResponse(team): ${teamError.message}`);
  if (!team) return { ok: false, blocked: true, reason: 'Nie znaleziono drużyny o takim kodzie.' };

  const { data: round, error: roundError } = await supabase
    .from('coach_feedback_rounds').select('id')
    .eq('team_id', team.id).eq('status', 'active').maybeSingle();
  if (roundError) throw new Error(`submitFeedbackResponse(round): ${roundError.message}`);
  if (!round) return { ok: false, blocked: true, reason: 'Ta drużyna nie ma dziś aktywnej Rundy Opinii.' };

  const responderHash = computeResponderHash(round.id, playerUserId);

  const { data: existing, error: existingError } = await supabase
    .from('coach_feedback_responses').select('id')
    .eq('round_id', round.id).eq('responder_hash', responderHash).maybeSingle();
  if (existingError) throw new Error(`submitFeedbackResponse(dedup): ${existingError.message}`);
  if (existing) return { ok: false, blocked: true, reason: 'Już odpowiedziałeś/aś w tej rundzie.' };

  const { error: insertError } = await supabase
    .from('coach_feedback_responses')
    .insert({ round_id: round.id, responder_hash: responderHash, answers });
  if (insertError) throw new Error(`submitFeedbackResponse(insert): ${insertError.message}`);

  return { ok: true, blocked: false };
}

// ------------------------------------------------------------
// WYNIKI — gating 5+ odpowiedzi, trend względem WŁASNEJ poprzedniej rundy
// tej samej drużyny (nigdy ranking między trenerami — to pytanie nawet się
// tu nie pojawia, bo zapytanie jest zawsze zawężone od góry przez
// fetchAndAuthorizeTeam do jednego konkretnego coachUserId).
// ------------------------------------------------------------
async function getFeedbackRoundResults(params, injectedSupabase) {
  const { coachUserId, teamId } = params || {};
  if (!coachUserId) throw new Error('getFeedbackRoundResults: brak coachUserId.');
  if (!teamId) throw new Error('getFeedbackRoundResults: brak teamId.');

  const supabase = injectedSupabase || getAdminClient();

  const { authorized } = await fetchAndAuthorizeTeam(supabase, teamId, coachUserId);
  if (!authorized) {
    return { ok: false, blocked: true, reason: 'Brak uprawnień: podana drużyna nie należy do tego trenera.' };
  }

  const { data: rounds, error: roundsError } = await supabase
    .from('coach_feedback_rounds').select('*')
    .eq('team_id', teamId).order('started_at', { ascending: false }).limit(2);
  if (roundsError) throw new Error(`getFeedbackRoundResults(rounds): ${roundsError.message}`);

  if (!rounds || !rounds.length) {
    return { ok: true, hasRound: false };
  }

  const [currentRound, previousRound] = rounds;

  const { data: currentResponses, error: currentError } = await supabase
    .from('coach_feedback_responses').select('answers').eq('round_id', currentRound.id);
  if (currentError) throw new Error(`getFeedbackRoundResults(current): ${currentError.message}`);

  const responseCount = (currentResponses || []).length;

  if (responseCount < RESULT_UNLOCK_THRESHOLD) {
    return {
      ok: true, hasRound: true, unlocked: false,
      round: currentRound, responseCount, threshold: RESULT_UNLOCK_THRESHOLD,
    };
  }

  const currentAggregate = buildRoundAggregate(currentResponses);

  let trend = null;
  if (previousRound) {
    const { data: previousResponses, error: previousError } = await supabase
      .from('coach_feedback_responses').select('answers').eq('round_id', previousRound.id);
    if (previousError) throw new Error(`getFeedbackRoundResults(previous): ${previousError.message}`);
    if ((previousResponses || []).length >= RESULT_UNLOCK_THRESHOLD) {
      const previousAggregate = buildRoundAggregate(previousResponses);
      trend = buildTrend(currentAggregate, previousAggregate);
    }
  }

  return {
    ok: true, hasRound: true, unlocked: true,
    round: currentRound, responseCount, threshold: RESULT_UNLOCK_THRESHOLD,
    perQuestion: currentAggregate, trend,
  };
}

module.exports = {
  RESULT_UNLOCK_THRESHOLD,
  FEEDBACK_ROUND_QUESTIONS,
  isValidFeedbackAnswers,
  computeResponderHash,
  computeQuestionAggregate,
  buildRoundAggregate,
  buildTrend,
  startFeedbackRound,
  submitFeedbackResponse,
  getFeedbackRoundResults,
  _internal: { getAdminClient, fetchAndAuthorizeTeam },
};

// ============================================================
// CO ŚWIADOMIE NIE JEST TU ZROBIONE
//
// 1. UI zawodnika w appce mobilnej / asystent_app.html (plik ZAMROŻONY) —
//    ZROBIONE zamiast tego: opinia-trenera.html (publiczny, bez logowania,
//    patrz "UI ZAWODNIKA" w nagłówku pliku). Gdyby w przyszłości powstała
//    zgoda na dotknięcie appki zawodnika, submitFeedbackResponse() już
//    dziś obsłuży prawdziwy, zalogowany player_user_id bez zmiany kodu —
//    to nadal osobny, otwarty punkt, tylko już nie blokujący (Runda Opinii
//    działa end-to-end już teraz przez opinia-trenera.html).
// 2. Zamykanie rundy po czasie (np. automatycznie po 14 dniach) — dziś
//    runda zostaje 'active' aż trener rozpocznie nową (forceNew=true).
//    Prosta rozbudowa na przyszłość, nie zrobiona teraz (brak wymogu w
//    zleceniu).
// 3. Powiadomienie trenera "masz już 5 odpowiedzi, zobacz wynik" — dziś
//    czysto "pull" (trener sam sprawdza w panelu), zero logiki wypychającej
//    — zgodne z tym, jak dziś działa reszta Panelu Trenera (patrz komentarz
//    "CO ŚWIADOMIE NIE JEST TU ZROBIONE" punkt 7 w coach.html).
// ============================================================

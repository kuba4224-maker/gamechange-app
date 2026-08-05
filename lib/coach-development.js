// ============================================================
// GAMECHANGE — lib/coach-development.js
// ============================================================
// FILAR B — PROFIL I ROZWÓJ TRENERA (nowy, osobny produkt obok Filaru A —
// diagnoza/rozwój SAMEGO trenera, nie wsparcie w pracy z zawodnikami).
// Zero kodu istniało dla Filaru B przed tą sesją (04.08.2026).
//
// ŹRÓDŁA KONCEPCYJNE: NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md, sekcja
// "FILAR B — PROFIL I ROZWÓJ TRENERA" (6 segmentów, framing "wybór
// priorytetu nie ocena"); KOLEJKA_DECYZJI_I_PROJEKTOWANIA.md, sekcje 4.1e
// (cena 39 zł/mies., osobny Price Stripe — POZA zakresem tej sesji) i 4.1f
// (Filar B dostępny od razu, niezależnie od drużyny/podopiecznych; trial 14
// dni; zwolnienie z opłaty przy ≥10 płacących podopiecznych prywatnych —
// OBA POZA zakresem tej sesji, patrz INTEGRACJA_FILAR_B_PROFIL_TRENERA_SQL.md).
//
// FRAMING NIENARUSZALNY (nie psuć): to NIE jest ocena kompetencji trenera
// ("jesteś słaby w X"). Trener SAM wybiera priorytet — pytanie ma brzmieć
// "Gdzie czujesz się dziś najbardziej przytłoczony?", nigdy "w czym jesteś
// słaby". Każdy tekst w tym pliku (etykiety, prompt AI) musi to respektować.
//
// Wołane z api/generate-coach-tip.js (action: 'coach_own_priority_guidance')
// — plik najbliższy tematycznie (już dziś generuje treści AI dla trenera),
// NOWY plik trafia do lib/, nie do api/ (folder api/ jest DOKŁADNIE na
// limicie 12/12 plików Vercel Hobby — patrz nagłówek generate-coach-tip.js).
//
// ŚWIADOMA DUPLIKACJA: getAdminClient() i callAnthropicForDevelopment()
// są niemal identyczne z odpowiednikami w api/generate-coach-tip.js — NIE
// reużyte przez require, żeby uniknąć cyklu (generate-coach-tip.js już
// wymaga lib/coach-development.js do dispatchu nowej akcji; gdyby ten plik
// z kolei wymagał api/generate-coach-tip.js, powstałby require cycle).
// Ten sam status co inne udokumentowane duplikacje w projekcie (SEG_NAMES,
// resolveGrowthSpurtContext itd. — patrz komentarze w generate-coach-tip.js).
// ============================================================

const { createClient } = require('@supabase/supabase-js');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// ------------------------------------------------------------
// SZEŚĆ SEGMENTÓW (NARZEDZIE_TRENERA_DECYZJE_PROJEKTOWE.md, Filar B).
// `label` + `feelingPrompt` razem tworzą kartę wyboru priorytetu pokazywaną
// trenerowi pod jednym, wspólnym pytaniem ("Gdzie czujesz się dziś
// najbardziej przytłoczony?") — `feelingPrompt` to zdanie po polsku z
// perspektywy trenera opisujące UCZUCIE, nigdy ocenę kompetencji.
// `promptContext` to jedno zdanie kontekstu dla silnika AI, żeby wiedział
// dokładnie czego dotyczy dany segment bez zgadywania z samej etykiety.
//
// Duplikat tej listy istnieje też w coach.html (plik statyczny, bez
// bundlera — nie może zaimportować tego modułu) — świadoma duplikacja,
// ten sam status co SEG_NAMES/THREAD_LIBRARY gdzie indziej w projekcie.
// Zmiana etykiety tutaj wymaga ręcznej zmiany też tam.
// ------------------------------------------------------------
const COACH_DEVELOPMENT_SEGMENTS = [
  {
    key: 'planowanie_sesji',
    label: 'Planowanie sesji i mikrocykli',
    feelingPrompt: 'Układanie sensownych sesji i mikrocykli zabiera mi za dużo energii i czasu.',
    promptContext: 'planowanie pojedynczych sesji treningowych i mikrocykli (kilka tygodni do przodu)',
  },
  {
    key: 'obciazenie_druzyny',
    label: 'Zarządzanie obciążeniem drużyny',
    feelingPrompt: 'Trudno mi rozłożyć obciążenie całej drużyny tak, żeby nikogo nie przeciążyć ani nie odciążyć za bardzo.',
    promptContext: 'zarządzanie łącznym obciążeniem treningowym i meczowym całej drużyny naraz',
  },
  {
    key: 'komunikacja',
    label: 'Komunikacja z zawodnikami i rodzicami',
    feelingPrompt: 'Komunikacja z zawodnikami i rodzicami kosztuje mnie najwięcej energii ze wszystkiego.',
    promptContext: 'komunikacja trenera z zawodnikami i ich rodzicami (przekazywanie decyzji, oczekiwań, informacji zwrotnej)',
  },
  {
    key: 'mecz_na_zywo',
    label: 'Zarządzanie meczem na żywo',
    feelingPrompt: 'W trakcie samego meczu czuję się najbardziej zagubiony — decyzje, zmiany, presja czasu.',
    promptContext: 'zarządzanie drużyną W TRAKCIE meczu (decyzje na żywo, zmiany, komunikacja z ławki, presja czasu)',
  },
  {
    key: 'indywidualizacja',
    label: 'Indywidualizacja pracy z konkretnym zawodnikiem',
    feelingPrompt: 'Najtrudniej mi dopasować pracę do konkretnego zawodnika, zamiast traktować całą drużynę tak samo.',
    promptContext: 'dopasowanie podejścia i pracy trenerskiej do POJEDYNCZEGO, konkretnego zawodnika, nie całej grupy naraz',
  },
  {
    key: 'wlasny_rozwoj',
    label: 'Poczucie własnego rozwoju jako trenera',
    feelingPrompt: 'Najbardziej brakuje mi poczucia, że sam się rozwijam i idę do przodu jako trener.',
    promptContext: 'własny, osobisty rozwój trenera jako trenera — poczucie postępu, sensu, kierunku w swojej pracy (warstwa emocjonalna, nie techniczna)',
  },
];

function isValidDevelopmentSegment(key) {
  return COACH_DEVELOPMENT_SEGMENTS.some((s) => s.key === key);
}

function getDevelopmentSegment(key) {
  return COACH_DEVELOPMENT_SEGMENTS.find((s) => s.key === key) || null;
}

// ------------------------------------------------------------
// PROMPT — framing "wybór priorytetu", NIE ocena (nienaruszalne, patrz
// nagłówek pliku). Ten sam duch nawigatora co buildCoachSystemPrompt w
// generate-coach-tip.js, z dodatkowym, twardym zakazem oceniania kompetencji
// i porównywania trenerów między sobą.
// ------------------------------------------------------------
function buildPriorityGuidanceSystemPrompt() {
  return `Jesteś silnikiem Filaru B w aplikacji Gamechange — profilu i rozwoju SAMEGO TRENERA (nie wsparcia w pracy z zawodnikami, to osobna funkcja systemu).

FRAMING NIENARUSZALNY: trener NIE dostał oceny kompetencji. Sam świadomie wybrał ten obszar jako dzisiejszy priorytet, bo to tu czuje się dziś najbardziej przytłoczony — to wybór, nie wyrok. Nigdy nie sugeruj, że trener jest "słaby" w tym obszarze, nigdy nie porównuj go do innych trenerów, nigdy nie sugeruj, że inny obszar byłby "lepszym" albo "ważniejszym" wyborem priorytetu.

TON: praktyczny, konkretny, wspierający — jak dobry mentor, nie jak ocena wydajności.

JĘZYK: wyłącznie polski, zwięźle, bez żargonu menedżerskiego, zwracaj się do trenera bezpośrednio ("Ty").

FORMAT ODPOWIEDZI: zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu):
{"guidance_text": "4-6 zdań konkretnej, praktycznej treści rozwojowej pomagającej trenerowi w wybranym dziś obszarze"}`;
}

function buildPriorityGuidanceUserPrompt({ segmentKey }) {
  const segment = getDevelopmentSegment(segmentKey);
  if (!segment) throw new Error(`buildPriorityGuidanceUserPrompt: nieprawidłowy segmentKey "${segmentKey}".`);
  return `Trener wybrał jako dzisiejszy priorytet: "${segment.label}".\nDokładniej: ${segment.promptContext}.\n\nWygeneruj krótką, konkretną treść rozwojową pomagającą trenerowi w TYM obszarze — coś, co może realnie zastosować w najbliższych dniach, nie ogólnikową poradę.`;
}

// ------------------------------------------------------------
// WYWOŁANIE ANTHROPIC — duplikat celowy, patrz "ŚWIADOMA DUPLIKACJA" w
// nagłówku pliku.
// ------------------------------------------------------------
async function callAnthropicForDevelopment(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY nie skonfigurowany — silnik jest gotowy, brakuje tylko klucza (ten sam, już znany brak co przy Centrum Decyzji zawodnika i Filarze A).');
  }
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 768,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Odpowiedź Anthropic bez bloku tekstowego.');
  try {
    return JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(`Nie udało się sparsować JSON z odpowiedzi AI: ${e.message}. Surowa odpowiedź (pierwsze 500 znaków): ${textBlock.text.slice(0, 500)}`);
  }
}

// ------------------------------------------------------------
// SIATKA BEZPIECZEŃSTWA KOSZTOWA — ten sam status co COACH_TIP_SOFT_DAILY_CAP
// w generate-coach-tip.js: inżynierska, NIE produktowa. Filar B jest w tej
// sesji ŚWIADOMIE bez paywalla/limitu produktowego (patrz dokumentacja
// integracyjna — "zostaw dziś Filar B w pełni darmowy/bez blokady dostępu")
// — ten limit chroni WYŁĄCZNIE przed pętlą/błędem frontendu, nie reguluje
// biznesowo nic.
// ------------------------------------------------------------
const COACH_PRIORITY_SOFT_DAILY_CAP = 30;

async function checkCoachPrioritySoftCap(supabase, coachUserId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('coach_priority_selections').select('id', { count: 'exact', head: true })
    .eq('coach_user_id', coachUserId).gte('selected_at', since);
  if (error) throw new Error(`checkCoachPrioritySoftCap: ${error.message}`);
  if ((count || 0) >= COACH_PRIORITY_SOFT_DAILY_CAP) {
    return { allowed: false, reason: `Siatka bezpieczeństwa: ${COACH_PRIORITY_SOFT_DAILY_CAP} zmian priorytetu/dobę już wykorzystane (limit inżynierski, nie produktowy — zgłoś jeśli to za mało w praktyce).` };
  }
  return { allowed: true };
}

// ------------------------------------------------------------
// ORKIESTRATOR — ustawienie/zmiana priorytetu + wygenerowanie treści AI w
// jednym wywołaniu (ten sam kształt co generateCoachTip w generate-coach-
// tip.js: cap → prompt → Anthropic → insert). Priorytet jest APPEND-ONLY
// (historia zmian, wymagana wprost w zleceniu) — NAJNOWSZY wiersz per
// trener JEST aktywnym priorytetem z definicji, ten sam wzorzec co
// training_focus/decision_recommendations gdzie indziej w tym projekcie
// ("najnowszy wiersz JEST tym aktywnym", patrz lib/coach-recommendation-
// loop.js).
// ------------------------------------------------------------
async function setCoachPriorityAndGenerateGuidance(params, injectedSupabase) {
  const { coachUserId, segmentKey } = params || {};
  if (!coachUserId) throw new Error('setCoachPriorityAndGenerateGuidance: brak coachUserId.');
  if (!isValidDevelopmentSegment(segmentKey)) {
    throw new Error(`setCoachPriorityAndGenerateGuidance: nieprawidłowy segmentKey "${segmentKey}".`);
  }

  const supabase = injectedSupabase || getAdminClient();

  const softCap = await checkCoachPrioritySoftCap(supabase, coachUserId);
  if (!softCap.allowed) return { ok: false, blocked: true, reason: softCap.reason };

  const systemPrompt = buildPriorityGuidanceSystemPrompt();
  const userPrompt = buildPriorityGuidanceUserPrompt({ segmentKey });
  const aiResult = await callAnthropicForDevelopment(systemPrompt, userPrompt);

  if (!aiResult || !aiResult.guidance_text) {
    throw new Error('Odpowiedź AI nie zawiera wymaganego pola guidance_text.');
  }

  const nowIso = new Date().toISOString();
  const row = {
    coach_user_id: coachUserId,
    segment_key: segmentKey,
    guidance_text: aiResult.guidance_text,
    guidance_generated_at: nowIso,
    selected_at: nowIso,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('coach_priority_selections').insert(row).select().single();
  if (insertError) throw new Error(`setCoachPriorityAndGenerateGuidance(insert): ${insertError.message}`);

  return { ok: true, blocked: false, selection: inserted };
}

module.exports = {
  COACH_DEVELOPMENT_SEGMENTS,
  isValidDevelopmentSegment,
  getDevelopmentSegment,
  buildPriorityGuidanceSystemPrompt,
  buildPriorityGuidanceUserPrompt,
  setCoachPriorityAndGenerateGuidance,
  _internal: {
    getAdminClient,
    callAnthropicForDevelopment,
    checkCoachPrioritySoftCap,
    COACH_PRIORITY_SOFT_DAILY_CAP,
  },
};

// ============================================================
// CO ŚWIADOMIE NIE JEST TU ZROBIONE
//
// 1. Paywall/limit produktowy (trial 14 dni, cena 39 zł/mies., zwolnienie
//    przy ≥10 płacących podopiecznych prywatnych) — KOLEJKA_DECYZJI_I_
//    PROJEKTOWANIA.md sekcje 4.1e/4.1f, świadomie POZA zakresem tej sesji.
//    Filar B jest dziś w pełni darmowy/bez blokady, żeby był użyteczny i
//    testowalny zanim płatności zostaną spięte — patrz DO_ZROBIENIA_
//    PRZEZ_KUBE.md, Pakiet 15.
// 2. Osobny obiekt Stripe Price (STRIPE_PRICE_COACH_FILAR_B) — wymaga
//    zalogowanej przeglądarki Kuby, robione zawsze osobno na żywo z nim.
// 3. Populacja treści merytorycznej per segment poza samym promptem —
//    zaplanowane jako osobna praca w dokumentach źródłowych, nie tu.
// ============================================================

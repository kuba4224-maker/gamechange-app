// ============================================================
// GAMECHANGE — /api/validate-goal-refinement.js
// ============================================================
// NOWY PLIK (30.07.2026) — Tor 7, Krok 4 (Baza Składowych Segmentów → UI
// w zakładce Cele), Część A. Punkt startowy: claude/SESJA_START_UX_
// MOBILE_BAZA_SKLADOWYCH_UI.md, wzorzec architektury: claude/PLAN_
// SPOJNEJ_SCIEZKI.md, sekcja 3G "Weryfikacja".
//
// CO TEN PLIK ROBI:
//   Zawodnik w appce mobilnej (app/(tabs)/cele.tsx), doprecyzowując cel,
//   albo wybiera konkretny Element z Bazy Składowych Segmentów, albo
//   opisuje cel własnymi słowami ("opisz sam" — ta opcja zawsze dostępna,
//   patrz Część B). Ten endpoint sprawdza cokolwiek powstanie (wybór z
//   bazy albo wolny opis) pod kątem trzech rzeczy:
//     1. Czy to wystarczająco konkretne (nie ogólnik typu "poprawić
//        technikę").
//     2. Czy pasuje do wybranego segmentu.
//     3. Czy to jedna rzecz, nie kilka naraz.
//   Zwraca miękką bramkę — NIGDY twardy blok: `passes: false` to tylko
//   sygnał dla frontendu, żeby pokazać konstruktywną podpowiedź, appka
//   pozwala zapisać cel niezależnie od wyniku (zgodnie z zasadą "narzędzie
//   jest nawigatorem, nie trenerem" — patrz Część B w cele.tsx, przycisk
//   "Dodaj cel" nigdy nie jest blokowany tym wynikiem).
//
// WZOROWANY NA `generate-recommendation.js` — ten sam styl wywołania
// modelu (callAnthropic, format promptu system+user, JSON-only odpowiedź),
// ta sama konwencja odczytu zmiennych środowiskowych jako funkcji, nie
// stałych modułu (patrz komentarz w tamtym pliku).
//
// RÓŻNICA vs. generate-recommendation.js: TEN endpoint jest wywoływany
// BEZPOŚREDNIO z appki mobilnej (zawodnik klika "Sprawdź"), nie z zaufanej
// logiki backendu — więc NIE używa DECISION_ENGINE_SECRET (ten sam wzorzec
// autoryzacji "trust boundary" co submit-recommendation-feedback.js /
// api-create-booking.js: brak pełnej weryfikacji tokenu, świadoma,
// wcześniej już zaakceptowana decyzja w tym projekcie). Endpoint NIE
// zapisuje nic do bazy (czysta walidacja tekstu, bez efektu ubocznego) —
// więc, w odróżnieniu od generate-recommendation.js, nie potrzebuje
// SUPABASE_SERVICE_ROLE_KEY ani klienta Supabase w ogóle.
//
// CO ŚWIADOMIE NIE JEST TU ZROBIONE (spójnie z resztą projektu — otwarcie
// nazwane, nie przeoczone):
//   - Kontrola kosztów / rate-limiting per zawodnik (jak w generate-
//     recommendation.js checkHardDailyCap). Ten endpoint nie zapisuje
//     nic do bazy, więc nie ma dziś prostego miejsca do liczenia
//     wywołań/dobę bez dodawania nowej tabeli — świadomie odłożone, poza
//     zakresem tej sesji (SESJA_START nie wymagał tego wprost). Jedyna
//     ochrona na razie: twardy limit długości wejściowego tekstu niżej.
//   - Wsparcie dla `position_id` (filtrowanie Obszarów po pozycji
//     zawodnika) — Krok 0 tej sesji potwierdził żywym zapytaniem do
//     Supabase, że `position_id` jest puste dla 100% wierszy we
//     wszystkich 12 segmentach (w tym `techFund`, 15/15 wierszy), więc
//     ten endpoint nie przyjmuje ani nie używa pozycji zawodnika.
// ============================================================

const MAX_TEXT_LENGTH = 300;

// ------------------------------------------------------------
// NAZWY SEGMENTÓW — świadoma duplikacja SEG_NAMES z generate-
// recommendation.js (ten sam wzorzec i to samo uzasadnienie: tańsze niż
// odpytywanie public.segments przy każdym wywołaniu). Jeśli kiedyś
// SEG_NAMES tam się zmieni, pamiętać o ręcznej synchronizacji tutaj.
// ------------------------------------------------------------
const SEG_NAMES = {
  moc: 'Moc',
  wytrzymalosc: 'Wytrzymałość',
  fizycznosc: 'Fizyczność',
  techFund: 'Technika Fundamentalna',
  techSpec: 'Technika Specjalistyczna',
  regeneracja: 'Regeneracja',
  odpornosc: 'Odporność',
  odzywianie: 'Odżywienie',
  tolerancja: 'Tolerancja Obciążeń',
  koncentracja: 'Koncentracja',
  mental: 'Stan Mentalny',
  percepcja: 'Percepcja',
  decyzja: 'Szybkość Decyzji',
};

function buildSystemPrompt() {
  return `Jesteś modułem weryfikacji w aplikacji Gamechange dla młodych piłkarzy — appka pomaga zawodnikowi precyzyjnie sformułować cel treningowy w wybranym segmencie.

FILOZOFIA (nienaruszalna): jesteś NAWIGATOREM, nie sędzią. Twoja ocena to zawsze miękka podpowiedź, nigdy twardy blok — zawodnik i tak będzie mógł zapisać swój cel niezależnie od Twojej oceny. Bądź konstruktywny i konkretny w podpowiedzi, nie karzący.

Sprawdzasz opis celu pod kątem DOKŁADNIE trzech rzeczy:
1. KONKRETNOŚĆ — czy to wystarczająco konkretne, nie ogólnik typu "poprawić technikę" albo "być lepszym".
2. DOPASOWANIE DO SEGMENTU — czy opisany cel faktycznie mieści się w podanym segmencie (np. cel dotyczący snu nie pasuje do segmentu technicznego).
3. JEDNA RZECZ — czy to jedna, konkretna rzecz do trenowania, nie kilka różnych rzeczy naraz połączonych spójnikiem "i"/przecinkiem.

JĘZYK: wyłącznie polski, zwięźle, zwracaj się do zawodnika bezpośrednio ("Ty"), ton ciepły i pomocny, nigdy oceniający/karcący — to nastoletni zawodnik.

FORMAT ODPOWIEDZI: zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu, bez komentarzy) dokładnie w tym kształcie:
{"passes": true lub false, "hint": "krótka, konstruktywna podpowiedź do poprawy (1-2 zdania) — TYLKO gdy passes=false, w przeciwnym razie null"}`;
}

function buildUserPrompt({ segmentName, text }) {
  return `Segment: ${segmentName}.
Opis celu podany przez zawodnika: "${text}"

Oceń ten opis wg trzech kryteriów z instrukcji systemowej i zwróć wynik w wymaganym formacie JSON.`;
}

// ------------------------------------------------------------
// WYWOŁANIE ANTHROPIC API — 1:1 wzorzec z generate-recommendation.js
// (patrz tamten plik po pełny komentarz o placeholderze nazwy modelu).
// ------------------------------------------------------------
async function callAnthropic(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY nie skonfigurowany — endpoint jest gotowy, brakuje tylko klucza.');
  }
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'; // fallback zaktualizowany
  // 04.08.2026 (ten sam placeholder co w generate-coach-tip.js/generate-recommendation.js,
  // Pakiet 10 — przeoczony tam, poprawiony teraz przy okazji budowania testów).
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
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
  let parsed;
  try {
    parsed = JSON.parse(stripMarkdownJsonFence(textBlock.text));
  } catch (e) {
    throw new Error(`Nie udało się sparsować JSON z odpowiedzi AI: ${e.message}. Surowa odpowiedź (pierwsze 500 znaków): ${textBlock.text.slice(0, 500)}`);
  }
  return parsed;
}

// POPRAWKA (30.07.2026, ta sama sesja) — znaleziona przy żywym teście tego
// endpointu na produkcji (POST przez fetch z gamechange-app.vercel.app,
// same-origin, tuż po deployu): mimo instrukcji w system prompcie "zwróć
// WYŁĄCZNIE poprawny JSON (bez markdown, bez bloków kodu)", model czasem i
// tak owija odpowiedź w blok kodu markdown (```json ... ```), co wcześniej
// psuło JSON.parse (rzucało błąd zamiast zwrócić wynik). Ten sam wzorzec
// (JSON.parse(textBlock.text) bez sanityzacji) jest dziś też w
// generate-recommendation.js — TEN plik dostał naprawę, bo to właśnie w nim
// ten błąd wystąpił na żywo w tej sesji; naprawa tamtego pliku świadomie
// POZA zakresem tej sesji (inny endpoint, inna sesja go dotykała), ale
// warto to zgłosić nawigatorowi jako potencjalnie ten sam, utajony błąd tam.
function stripMarkdownJsonFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1] : trimmed;
}

// ------------------------------------------------------------
// ORKIESTRATOR — do reużycia przez HTTP handler niżej i przez ewentualne
// przyszłe wywołanie in-process (ten sam wzorzec reużycia co
// generateRecommendation w generate-recommendation.js).
// ------------------------------------------------------------
async function validateGoalRefinement({ segmentId, text }) {
  if (!segmentId || typeof segmentId !== 'string') {
    throw new Error('Brak wymaganego segmentId.');
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('Brak wymaganego tekstu do sprawdzenia.');
  }
  const trimmed = text.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new Error(`Tekst zbyt długi (max ${MAX_TEXT_LENGTH} znaków).`);
  }

  const segmentName = SEG_NAMES[segmentId] || segmentId;
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({ segmentName, text: trimmed });
  const aiResult = await callAnthropic(systemPrompt, userPrompt);

  if (typeof aiResult.passes !== 'boolean') {
    throw new Error('Odpowiedź AI nie zawiera wymaganego pola "passes".');
  }
  return {
    passes: aiResult.passes,
    hint: aiResult.passes ? null : (aiResult.hint || null),
  };
}

// ------------------------------------------------------------
// HTTP HANDLER (Vercel Function) — wywoływany bezpośrednio z appki
// mobilnej. Bez sekretu (patrz komentarz "RÓŻNICA" na górze pliku) —
// tylko POST + walidacja kształtu body.
// ------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { segmentId, text } = req.body || {};

  try {
    const result = await validateGoalRefinement({ segmentId, text });
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('validate-goal-refinement error:', e);
    return res.status(400).json({ ok: false, error: e.message });
  }
};

module.exports.validateGoalRefinement = validateGoalRefinement;
module.exports._internal = { SEG_NAMES, buildSystemPrompt, buildUserPrompt };

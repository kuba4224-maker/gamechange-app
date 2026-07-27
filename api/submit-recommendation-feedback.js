// ============================================================
// GAMECHANGE — /api/submit-recommendation-feedback.js
// ============================================================
// NOWY PLIK (27.07.2026, część 3 tej sesji) — domyka lukę znalezioną przy
// audycie generate-recommendation.js: computeRejectionStreak() i
// checkFeedbackEscalationNotYetFired() ISTNIEJĄ i poprawnie liczą serię
// odrzuceń / chronią przed powtórnym wystrzeleniem, ale NIC wcześniej ich
// automatycznie nie wywoływało — frontend (asystent_app.html
// submitFeedback) PATCHował feedback_response wprost przez PostgREST i na
// tym się kończyło. Wcześniejsza notatka w claude/PLAN_SPOJNEJ_SCIEZKI.md
// ("eskalacja po 3+ odrzuceniach — ZBUDOWANA, potwierdzone w generate-
// recommendation.js") była nieścisła: zbudowane były tylko cegiełki
// (licznik + brama kosztowa przeciw powtórce), nie sam wyzwalacz. Patrz
// też sekcja "CO ŚWIADOMIE NIE JEST TU ZROBIONE" na końcu generate-
// recommendation.js, punkt 3 — ten plik właśnie to domyka.
//
// CO TEN PLIK ROBI:
//   Frontend wywołuje TEN endpoint zamiast bezpośredniego PATCH na
//   decision_recommendations. Endpoint (a) zapisuje feedback dokładnie
//   tak samo jak wcześniej robił to frontend, (b) jeśli feedback to
//   'did_not_make_sense' na rekomendacji typu training_focus, liczy serię
//   odrzuceń dla tego segmentu i przy 3+ z rzędu wywołuje
//   generateRecommendation() IN-PROCESS (ten sam wzorzec co
//   api-cron-onboard-diagnosis.js — nie przez HTTP, więc nie trzeba
//   przekazywać DECISION_ENGINE_SECRET między funkcjami Vercel) z
//   recommendationType='specialist_referral', referralReason=
//   'feedback_escalation' — dokładnie ta gałąź kodu, którą
//   checkFeedbackEscalationNotYetFired już chroni przed powtórnym
//   wystrzeleniem (patrz "reset" licznika w tamtej funkcji).
//
// AUTORYZACJA: ten sam, już przyjęty w tym projekcie wzorzec co
// api-create-booking.js (Marketplace) — trust boundary na poziomie
// "caller zna userId zalogowanego zawodnika", BEZ pełnej weryfikacji
// access_token. Jedyna dodatkowa ochrona tutaj (której create-booking.js
// nie ma): sprawdzamy, że rekomendacja o podanym id faktycznie NALEŻY do
// podanego userId, zanim cokolwiek zapiszemy — minimalna ochrona przed
// przypadkową/złośliwą podmianą cudzego id rekomendacji. Świadomie NIE
// rozszerzam tego teraz o pełną weryfikację tokenu — to osobna, szersza
// decyzja o wzorcu bezpieczeństwa API w całym projekcie, nie coś do
// rozstrzygnięcia przy okazji tej jednej funkcji.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const {
  generateRecommendation,
  _internal: { computeRejectionStreak },
} = require('./generate-recommendation');

const ESCALATION_STREAK_THRESHOLD = 3;
const ALLOWED_RESPONSES = ['done', 'not_done', 'did_not_make_sense', 'open_to_discussing', 'not_interested'];

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Brak SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY w zmiennych środowiskowych.');
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, recommendationId, response, comment } = req.body || {};
  if (!userId || !recommendationId || !ALLOWED_RESPONSES.includes(response)) {
    return res.status(400).json({ error: 'Brak wymaganych danych albo nieprawidłowa odpowiedź.' });
  }

  const supabase = getAdminClient();

  try {
    // 1. Pobierz rekomendację i sprawdź, że należy do podanego zawodnika.
    const { data: rec, error: recError } = await supabase
      .from('decision_recommendations')
      .select('id, user_id, recommendation_type, segment_id, feedback_response')
      .eq('id', recommendationId)
      .maybeSingle();
    if (recError) throw new Error(`fetch recommendation: ${recError.message}`);
    if (!rec || rec.user_id !== userId) {
      return res.status(404).json({ error: 'Nie znaleziono rekomendacji.' });
    }
    if (rec.feedback_response) {
      return res.status(409).json({ error: 'Ta rekomendacja ma już zapisaną odpowiedź.' });
    }

    // 2. Zapisz feedback — dokładnie te same pola, które wcześniej ustawiał
    // bezpośredni PATCH z frontendu (RLS na decision_recommendations i tak
    // ograniczał zapis do tych kolumn — tu robi to service role, więc
    // ograniczenie egzekwujemy sami, wybierając tylko te trzy pola).
    const updateFields = { feedback_response: response, feedback_at: new Date().toISOString() };
    if (comment) updateFields.feedback_comment = String(comment).slice(0, 1000);

    const { error: updateError } = await supabase
      .from('decision_recommendations')
      .update(updateFields)
      .eq('id', recommendationId);
    if (updateError) throw new Error(`update feedback: ${updateError.message}`);

    // 3. Eskalacja — tylko dla training_focus odrzuconego jako "nie miało
    // to sensu", tylko gdy segment_id jest znany (wymagane przez
    // generateRecommendation dla feedback_escalation).
    let escalation = null;
    if (rec.recommendation_type === 'training_focus' && response === 'did_not_make_sense' && rec.segment_id) {
      const streak = await computeRejectionStreak(supabase, userId, rec.segment_id);
      if (streak >= ESCALATION_STREAK_THRESHOLD) {
        try {
          const result = await generateRecommendation(
            {
              userId,
              recommendationType: 'specialist_referral',
              referralReason: 'feedback_escalation',
              segmentId: rec.segment_id,
            },
            supabase
          );
          escalation = result.ok ? { fired: true } : { fired: false, reason: result.reason };
        } catch (escErr) {
          // Eskalacja to bonus, nie krytyczna ścieżka — feedback zawodnika
          // jest już bezpiecznie zapisany wyżej, nie psujemy odpowiedzi
          // użytkownikowi z powodu błędu w tym dodatkowym kroku.
          console.error('submit-recommendation-feedback: eskalacja nie powiodła się:', escErr);
          escalation = { fired: false, reason: escErr.message };
        }
      }
    }

    return res.status(200).json({ ok: true, escalation });
  } catch (e) {
    console.error('submit-recommendation-feedback error:', e);
    return res.status(500).json({ error: e.message });
  }
};

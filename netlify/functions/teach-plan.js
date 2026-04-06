// Phase-based teaching plan generator.
// Uses direct fetch to Anthropic API (no SDK) for fast cold starts.
// ANTHROPIC_API_KEY must be set in Netlify environment variables.

const HEADERS = { 'Content-Type': 'application/json' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { phase } = body;

    if (!phase) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'phase is required' }) };
    }

    switch (phase) {
      case 'master-plan':
        return await masterPlan(body);
      case 'week-content':
        return await weekContent(body);
      case 'exams':
        return await exams(body);
      case 'quizzes':
        return await quizzes(body);
      default:
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unknown phase: ' + phase }) };
    }
  } catch (err) {
    console.error('teach-plan.js error:', err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Helper: call Claude via direct fetch (no SDK = fast cold start) ─────────
async function callClaude({ model = 'claude-haiku-4-5', maxTokens = 4000, system, prompt }) {
  const startTime = Date.now();
  console.log('callClaude start:', model, 'maxTokens:', maxTokens, 'promptLen:', prompt.length);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s to stay under Netlify 10s limit

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: system || 'You are a JSON-only API. Output only raw valid JSON — no preamble, no explanation, no markdown fences.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr.name === 'AbortError') {
      throw new Error('Anthropic API timed out after 25s');
    }
    throw fetchErr;
  }
  clearTimeout(timeoutId);

  console.log('Anthropic responded:', resp.status, 'in', Date.now() - startTime, 'ms');

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Anthropic API error: ' + resp.status + ' ' + err.slice(0, 300));
  }

  const message = await resp.json();
  const text = (message.content || []).map((b) => b.text || '').join('');
  console.log('Response length:', text.length, 'total ms:', Date.now() - startTime);

  // Extract outermost balanced {} or [] block
  let startChar = -1, startIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') { startChar = text[i]; startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error('No JSON found in AI response');

  const endChar = startChar === '{' ? '}' : ']';
  let depth = 0, endIdx = -1;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === startChar) depth++;
    else if (text[i] === endChar) { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) {
    console.log('Truncated JSON, raw text:', text.slice(0, 500));
    throw new Error('AI response JSON was truncated');
  }

  const jsonStr = text.slice(startIdx, endIdx + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (parseErr) {
    console.log('JSON parse failed, attempting repair. Raw:', jsonStr.slice(0, 300));
    // Try to repair: remove trailing commas before } or ]
    const repaired = jsonStr.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(repaired);
    } catch (e) {
      throw new Error('JSON parse error: ' + parseErr.message + ' | first 200 chars: ' + jsonStr.slice(0, 200));
    }
  }
}

// ── Phase 1: Master Plan ───────────────────────────────────────────────────
// Generates enriched outline for all weeks: key concepts, Bible passage refs,
// teaching objectives, materials mapping.
async function masterPlan(body) {
  const { course, slos, schedule, assessments, materialsList, scraped } = body;

  if (!course || !slos?.length || !schedule?.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'course, slos, and schedule are required' }) };
  }

  const scheduleText = schedule.map(w =>
    `Week ${w.week}: "${w.title}" — ${w.topic} | Reading: ${w.reading} | SLO: ${w.slo} | Discussion: ${w.discussion}`
  ).join('\n');

  const assessmentText = (assessments || []).map(a =>
    `${a.title} (${a.type}, week ${a.dueWeek}, ${a.gradingWeight}%) — ${a.description}`
  ).join('\n');

  const matContext = [];
  if (materialsList) matContext.push('Required materials:\n' + materialsList.slice(0, 600));
  if (scraped?.books?.length) matContext.push('Books: ' + scraped.books.slice(0, 10).join('; '));

  const prompt = `Christ-centered async course, Williamson College.
COURSE: ${course.title}|${course.code}|${course.weeks}wk
SLOs: ${slos.map((s, i) => (i + 1) + '.' + s.slice(0, 50)).join('; ')}
SCHEDULE: ${schedule.map(w => 'W' + w.week + ':' + (w.title || '') + '|' + (w.reading || '')).join('; ')}

For EACH week output JSON: bible passage refs, 3 key concepts, 1-sentence objective, 1-sentence activity.
[{"week":1,"bp":["John 3:16-21"],"kc":["term1","term2","term3"],"obj":"...","act":"..."},...]
Exactly ${course.weeks} objects. Ultra-compact.`;

  const result = await callClaude({ maxTokens: 2000, prompt });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
}

// ── Phase 2: Week Content ──────────────────────────────────────────────────
// Generates detailed teaching narrative for a batch of weeks.
async function weekContent(body) {
  const { course, slos, weeks, masterPlan } = body;
  // weeks = array of week numbers to generate, e.g. [1,2,3,4]
  // masterPlan = array from phase 1

  if (!course || !weeks?.length || !masterPlan?.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'course, weeks, and masterPlan are required' }) };
  }

  const weekPlans = masterPlan.filter(w => weeks.includes(w.week));
  const weekDetails = weekPlans.map(w => `Week ${w.week}: Bible: ${(w.biblePassages || []).join(', ')} | Concepts: ${(w.keyConcepts || []).join(', ')} | Objective: ${w.teachingObjective}`).join('\n');

  const prompt = `You are writing detailed teaching content for an asynchronous online course at Williamson College (Christ-centered).

COURSE: ${course.title} | ${course.code}

SLOs:
${slos.map((s, i) => `${i + 1}. ${s}`).join('\n')}

WEEK PLANS:
${weekDetails}

TASK: For each week, write: lc=200-300 word lecture (Christ-centered), kt=3 key terms [{t,d}], dp=2 discussion questions, an=1 sentence application.
[{"week":1,"lc":"...","kt":[{"t":"term","d":"def"}],"dp":["?","?"],"an":"..."},...]`;

  const result = await callClaude({ maxTokens: 2500, prompt });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
}

// ── Phase 3: Exams ─────────────────────────────────────────────────────────
// Generates midterm and final exam content.
async function exams(body) {
  const { course, slos, masterPlan } = body;

  if (!course || !slos?.length || !masterPlan?.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'course, slos, and masterPlan are required' }) };
  }

  const midWeek = Math.ceil(masterPlan.length / 2);
  const topics = masterPlan.map(w => 'W' + w.week + ':' + (w.kc || w.keyConcepts || []).slice(0, 2).join(',')).join('; ');

  const prompt = `Christ-centered Bible course exams. ${course.title}|${course.code}
SLOs: ${slos.map((s, i) => (i + 1) + '.' + s.slice(0, 40)).join('; ')}
Topics: ${topics}

Create MIDTERM (weeks 1-${midWeek}) and FINAL (all weeks). JSON only:
{"midterm":{"mc":[10 items:{"q":"?","o":["A","B","C","D"],"a":"B","s":"SLO 1"}],"sa":[2 items:{"q":"?","ea":"short","p":10,"s":"SLO 1"}]},"final":{"mc":[10 items same],"essays":[1 item:{"pr":"prompt","p":25,"s":"SLO 1","rubric":[{"l":"Excellent","d":"..."},{"l":"Proficient","d":"..."},{"l":"Developing","d":"..."},{"l":"Beginning","d":"..."}]}]}}
Compact. 10 MC each exam.`;

  const result = await callClaude({ maxTokens: 3000, prompt });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
}

// ── Phase 4: Weekly Quizzes ────────────────────────────────────────────────
// Generates 10 MC questions per week.
async function quizzes(body) {
  const { course, weeks, masterPlan } = body;
  // weeks = array of week numbers to generate quizzes for (batch of ~5)

  if (!course || !weeks?.length || !masterPlan?.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'course, weeks, and masterPlan are required' }) };
  }

  const weekPlans = masterPlan.filter(w => weeks.includes(w.week));
  const weekDetails = weekPlans.map(w =>
    `Week ${w.week}: Concepts: ${(w.keyConcepts || []).join(', ')} | Bible: ${(w.biblePassages || []).join(', ')} | Objective: ${w.teachingObjective}`
  ).join('\n');

  const prompt = `Create weekly quizzes for an asynchronous Bible course at Williamson College.

COURSE: ${course.title}

WEEKS TO GENERATE:
${weekDetails}

TASK: For each week, create 5 MC questions. 4 options, correct answer, brief explanation.
[{"week":1,"questions":[{"q":"?","options":["A","B","C","D"],"answer":"B","explanation":"why"}]}]`;

  const result = await callClaude({
    model: 'claude-haiku-4-5',
    maxTokens: 2500,
    prompt,
  });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
}

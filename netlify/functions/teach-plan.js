// Phase-based teaching plan generator.
// Each call handles one phase of content generation to stay within Netlify function timeouts.
// ANTHROPIC_API_KEY must be set in Netlify environment variables.

const Anthropic = require('@anthropic-ai/sdk');

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

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    switch (phase) {
      case 'master-plan':
        return await masterPlan(client, body);
      case 'week-content':
        return await weekContent(client, body);
      case 'exams':
        return await exams(client, body);
      case 'quizzes':
        return await quizzes(client, body);
      default:
        return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unknown phase: ' + phase }) };
    }
  } catch (err) {
    console.error('teach-plan.js error:', err);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Helper: call Claude and parse JSON response ────────────────────────────
async function callClaude(client, { model = 'claude-sonnet-4-20250514', maxTokens = 4000, system, prompt }) {
  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: system || 'You are a JSON-only API. Output only raw valid JSON — no preamble, no explanation, no markdown fences.',
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content.map((b) => b.text || '').join('');

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
  if (endIdx === -1) throw new Error('AI response JSON was truncated');

  return JSON.parse(text.slice(startIdx, endIdx + 1));
}

// ── Phase 1: Master Plan ───────────────────────────────────────────────────
// Generates enriched outline for all weeks: key concepts, Bible passage refs,
// teaching objectives, materials mapping.
async function masterPlan(client, body) {
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

  const prompt = `You are designing a fully asynchronous online course for Williamson College (Christ-centered, SACSCOC accredited).

COURSE: ${course.title} | ${course.code} | ${course.creditHours} credits | ${course.weeks} weeks
${(course.description || '').slice(0, 200)}

SLOs:
${slos.map((s, i) => `${i + 1}. ${s}`).join('\n')}

EXISTING SCHEDULE (from syllabus generation):
${scheduleText}

ASSESSMENTS:
${assessmentText}

${matContext.join('\n')}

TASK: Create a master teaching plan. For EACH week, provide:
- biblePassages: array of 1-2 relevant Bible passage references (e.g., "John 3:16-21", "Romans 8:1-11"). Choose passages directly relevant to that week's topic.
- keyConcepts: array of 3-5 key terms/concepts students must learn
- teachingObjective: one sentence describing what students will understand by end of week
- applicationActivity: brief description of a practical activity

Output JSON array with ${course.weeks} objects:
[{"week":1,"biblePassages":["ref"],"keyConcepts":["term"],"teachingObjective":"...","applicationActivity":"..."},...]`;

  const result = await callClaude(client, { maxTokens: 4000, prompt });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
}

// ── Phase 2: Week Content ──────────────────────────────────────────────────
// Generates detailed teaching narrative for a batch of weeks.
async function weekContent(client, body) {
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

TASK: For each week listed, write:
- lectureContent: 500-800 word teaching narrative. Write as if lecturing to students. Reference the Bible passages. Connect to the key concepts. Christ-centered perspective.
- keyTerms: array of objects [{term, definition}] for 3-5 key terms
- discussionPrompts: array of 2-3 thoughtful discussion questions (15-25 words each) with SLO alignment
- applicationNote: 2-3 sentences describing a practical application exercise

Output JSON array:
[{"week":1,"lectureContent":"...","keyTerms":[{"term":"...","definition":"..."}],"discussionPrompts":["..."],"applicationNote":"..."},...]`;

  const result = await callClaude(client, { maxTokens: 8000, prompt });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
}

// ── Phase 3: Exams ─────────────────────────────────────────────────────────
// Generates midterm and final exam content.
async function exams(client, body) {
  const { course, slos, masterPlan } = body;

  if (!course || !slos?.length || !masterPlan?.length) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'course, slos, and masterPlan are required' }) };
  }

  const midWeek = Math.ceil(masterPlan.length / 2);
  const midTopics = masterPlan.filter(w => w.week <= midWeek).map(w => `Week ${w.week}: ${(w.keyConcepts || []).join(', ')}`).join('\n');
  const allTopics = masterPlan.map(w => `Week ${w.week}: ${(w.keyConcepts || []).join(', ')}`).join('\n');

  const prompt = `You are creating exams for an asynchronous course at Williamson College (Christ-centered, SACSCOC accredited).

COURSE: ${course.title} | ${course.code}

SLOs:
${slos.map((s, i) => `${i + 1}. ${s}`).join('\n')}

MIDTERM covers weeks 1-${midWeek}:
${midTopics}

FINAL covers ALL weeks 1-${masterPlan.length}:
${allTopics}

TASK: Create both exams.

MIDTERM:
- 30 multiple choice questions (4 options each, indicate correct answer)
- 3 short answer questions (with expected answer outline)
- Map each question to an SLO

FINAL:
- 30 multiple choice questions (4 options each, indicate correct answer)
- 2 essay prompts with detailed rubrics (4 levels: Excellent/Proficient/Developing/Beginning with point values and descriptions)
- Map each question to an SLO

Output JSON:
{
  "midterm": {
    "mc": [{"q":"...","options":["A","B","C","D"],"answer":"A","slo":"SLO 1","explanation":"..."}],
    "shortAnswer": [{"q":"...","expectedAnswer":"...","points":10,"slo":"SLO 1"}]
  },
  "final": {
    "mc": [{"q":"...","options":["A","B","C","D"],"answer":"A","slo":"SLO 1","explanation":"..."}],
    "essays": [{"prompt":"...","points":25,"slo":"SLO 1","rubric":[{"level":"Excellent","points":"23-25","description":"..."},{"level":"Proficient","points":"18-22","description":"..."},{"level":"Developing","points":"12-17","description":"..."},{"level":"Beginning","points":"0-11","description":"..."}]}]
  }
}`;

  const result = await callClaude(client, { maxTokens: 8000, prompt });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
}

// ── Phase 4: Weekly Quizzes ────────────────────────────────────────────────
// Generates 10 MC questions per week.
async function quizzes(client, body) {
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

TASK: For each week, create exactly 10 multiple choice questions.
- 4 options each (A, B, C, D)
- Mix difficulty: 4 recall, 4 application, 2 analysis
- Include questions about Bible passage content
- Indicate correct answer and brief explanation

Output JSON array:
[{"week":1,"questions":[{"q":"...","options":["A","B","C","D"],"answer":"B","explanation":"..."}]}]`;

  const result = await callClaude(client, {
    model: 'claude-haiku-4-5',
    maxTokens: 8000,
    prompt,
  });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
}

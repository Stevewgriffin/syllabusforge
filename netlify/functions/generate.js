// Proxies the course generation request to the Anthropic API.
// ANTHROPIC_API_KEY must be set in Netlify environment variables.

const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { course, slos, files = [], scraped = null, materialsList = null, syllabusDoc = null } = JSON.parse(event.body || '{}');

    if (!course || !slos?.length) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'course and slos are required' }),
      };
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build message content: optional PDF documents + text prompt
    const content = [];

    // If existing syllabus is a PDF, add it first as a native Anthropic document
    if (syllabusDoc?.type === 'pdf' && syllabusDoc.b64) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: syllabusDoc.b64 },
        title: syllabusDoc.name || 'Current Syllabus',
      });
    }

    // Additional PDFs (textbooks, articles, etc.)
    for (const f of files) {
      if (f.b64) {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: f.b64 },
          title: f.name || 'uploaded document',
        });
      }
    }

    content.push({ type: 'text', text: buildPrompt(course, slos, files.length, scraped, materialsList, syllabusDoc) });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content }],
    });

    const text = message.content.map((b) => b.text || '').join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI response did not contain a valid JSON structure.');

    const raw = JSON.parse(match[0]);

    // Expand compact key names back to full field names expected by the frontend
    const result = {
      grading: (raw.grading || []).map(g => ({
        category: g.category || g.c || '',
        weight: g.weight ?? g.w ?? 0,
        description: g.description || g.d || '',
        slos: g.slos || g.s || [],
      })),
      schedule: (raw.schedule || []).map(w => ({
        week: w.week ?? w.n ?? 0,
        title: w.title || w.t || '',
        topic: w.topic || w.k || '',
        slo: w.slo || w.o || '',
        reading: w.reading || w.r || '',
        themes: w.themes || (w.topic || w.k ? [w.topic || w.k] : []),
        readings: w.readings || [],
        discussions: w.discussions || [],
      })),
      assessments: (raw.assessments || []).map(a => ({
        title: a.title || a.t || '',
        type: a.type || a.y || 'paper',
        dueWeek: a.dueWeek ?? a.w ?? 0,
        description: a.description || a.d || '',
        fullPrompt: a.fullPrompt || a.p || '',
        length: a.length || a.l || '',
        slos: a.slos || a.s || [],
        gradingWeight: a.gradingWeight ?? a.g ?? 0,
      })),
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('generate.js error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

function buildPrompt(course, slos, fileCount, scraped, materialsList, syllabusDoc) {
  const trimmedSlos = slos.map((s, i) => `SLO ${i + 1}: ${s.slice(0, 70)}`).join('\n');
  const desc = (course.description || '').slice(0, 120);

  const hasSyllabus = !!(syllabusDoc);
  const syllabusText = syllabusDoc?.type === 'text' ? syllabusDoc.text?.slice(0, 1200) : null;

  // Build materials context
  const matParts = [];
  if (materialsList) matParts.push(`REQUIRED MATERIALS (assign to specific weeks):\n${materialsList.slice(0, 600)}`);
  if (scraped?.books?.length) matParts.push(`Populi books: ${scraped.books.slice(0, 8).join('; ')}`);
  if (scraped?.lessons?.length) matParts.push(`Populi weekly structure: ${scraped.lessons.slice(0, 10).join('; ')}`);
  if (fileCount > 0) matParts.push(`${fileCount} PDF(s) uploaded — extract chapter titles and page ranges for readings.`);
  const matContext = matParts.length ? matParts.join('\n') : 'No materials provided — use plausible academic readings for this subject.';

  const task = hasSyllabus
    ? `TASK: You have been given the EXISTING SYLLABUS for this course${syllabusDoc.type === 'pdf' ? ' (see attached PDF — read it first)' : ` (see extracted text below)`}.
INSTRUCTIONS:
1. Read the existing syllabus carefully — it is the PRIMARY reference
2. Preserve its weekly topics, books, assignments, and structure exactly
3. Re-map each week to the most relevant SLO from the list below
4. Ensure ALL SLOs are covered across the ${course.weeks} weeks
5. Keep the same reading titles and assignment names — do not invent new ones
${syllabusText ? `\nEXISTING SYLLABUS TEXT:\n${syllabusText}` : ''}`
    : `TASK: Generate a new ${course.weeks}-week course structure grounded in the materials below.`;

  return `Curriculum designer for Williamson College (SACSCOC accredited, Christ-centered). Output ONLY JSON.

COURSE: ${course.title} | ${course.code} | ${course.creditHours}cr | ${course.weeks} weeks | ${course.term || 'Current Term'}
${desc}

SLOs (map every week and assessment to these):
${trimmedSlos}

${task}

${matContext}

JSON schema — fill ALL fields, ultra-short strings:
{"grading":[{"c":"category","w":number,"d":"phrase","s":["SLO 1"]}],"schedule":[{"n":number,"t":"4-word title","k":"6-word topic","o":"SLO X","r":"Book Title ch/pp X"}],"assessments":[{"t":"title","y":"paper|quiz|project","w":number,"d":"1 sentence","p":"30-word prompt","l":"length","s":["SLO X"],"g":number}]}

Rules:
- schedule has exactly ${course.weeks} entries n=1..${course.weeks}
- "r" field = required reading for that week — use EXACT titles from the materials list, distributed across all weeks (spread books chapter by chapter, articles to relevant weeks, no week without a reading)
- 3 assessments, dueWeek 5–${course.weeks}
- grading w values sum=100`;
}

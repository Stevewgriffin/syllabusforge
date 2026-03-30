// Proxies the course generation request to the Anthropic API.
// ANTHROPIC_API_KEY must be set in Netlify environment variables.

const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { course, slos, files = [] } = JSON.parse(event.body || '{}');

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

    for (const f of files) {
      if (f.b64) {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: f.b64 },
          title: f.name || 'uploaded document',
        });
      }
    }

    content.push({ type: 'text', text: buildPrompt(course, slos, files.length) });

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

function buildPrompt(course, slos, fileCount) {
  const sloList = slos.map((s, i) => `SLO ${i + 1}: ${s}`).join('\n');
  const materialNote =
    fileCount > 0
      ? 'Use the uploaded documents to extract actual chapter titles, key concepts, and page ranges for reading assignments.'
      : "No materials uploaded — generate plausible, academically rigorous readings grounded in the course subject matter and Williamson College's Christian higher education mission.";

  // Trim description to 100 chars to reduce input tokens
  const desc = (course.description || '').slice(0, 100);
  // Trim SLOs to 60 chars each
  const trimmedSlos = slos.map((s, i) => `SLO ${i + 1}: ${s.slice(0, 60)}`).join('\n');

  return `Curriculum designer for Williamson College. Output ONLY JSON, no prose.

${course.title}|${course.code}|${course.weeks}wk|${course.creditHours}cr|${course.term || 'Current Term'}
${desc}
${trimmedSlos}

JSON schema (copy exactly, fill values):
{"grading":[{"c":"category name","w":number,"d":"one phrase","s":["SLO 1"]}],"schedule":[{"n":number,"t":"3-word title","k":"5-word topic","o":"SLO X"}],"assessments":[{"t":"title","y":"paper","w":number,"d":"one sentence","p":"25-word prompt","l":"pages/length","s":["SLO X"],"g":number}]}

Rules: ${course.weeks} entries in schedule n=1..${course.weeks}. 3 assessments with dueWeek between 5 and ${course.weeks}. grading w values sum=100. ALL strings ultra-short.`;
}

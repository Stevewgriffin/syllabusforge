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
      max_tokens: 3000,
      messages: [{ role: 'user', content }],
    });

    const text = message.content.map((b) => b.text || '').join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI response did not contain a valid JSON structure.');

    const result = JSON.parse(match[0]);

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

  return `You are a curriculum designer for Williamson College (Christ-centered). Generate a concise course structure.

COURSE: ${course.title} (${course.code}) | ${course.creditHours} credits | ${course.weeks} weeks | ${course.term || 'Current Term'}
DESCRIPTION: ${course.description || '(derive from title and SLOs)'}
SLOs:
${sloList}

${materialNote}

Return ONLY valid JSON — no markdown, no explanation:
{
  "grading": [{"category":"string","weight":number,"description":"1 sentence","slos":["SLO 1"]}],
  "schedule": [{"week":number,"title":"string","topic":"string","reading":"string","discussion":"string (1 sentence)","slo":"SLO X"}],
  "assessments": [{"title":"string","type":"paper|quiz|project","dueWeek":number,"description":"string","fullPrompt":"string (50 words)","length":"string","slos":["SLO X"],"gradingWeight":number}]
}

Rules:
- ALL ${course.weeks} weeks in schedule (week 1 through ${course.weeks})
- 3-4 assessments; at least one faith-integration reflection
- Grading weights sum to exactly 100
- BE CONCISE — every field one short phrase or sentence`;
}

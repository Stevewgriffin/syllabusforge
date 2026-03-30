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
      model: 'claude-sonnet-4-5',
      max_tokens: 6000,
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

  return `You are an expert curriculum designer for Williamson College, a Christ-centered institution of higher education. Create a complete, detailed course structure that integrates faith with learning.

COURSE INFORMATION:
- Title: ${course.title}
- Code: ${course.code}
- Credit Hours: ${course.creditHours}
- Weeks: ${course.weeks}
- Term: ${course.term || 'Current Term'}
- Instructor: ${course.instructor || 'TBD'}
- Description: ${course.description || '(None provided — derive from course title and SLOs)'}

STUDENT LEARNING OUTCOMES:
${sloList}

${materialNote}

Return ONLY valid JSON (no markdown, no code blocks, no explanation) with this exact structure:
{
  "grading": [{"category":"string","weight":number,"description":"string","slos":["SLO 1"]}],
  "schedule": [{
    "week":number,
    "title":"string",
    "themes":["string"],
    "notes":"string",
    "readings":[{"source":"string","section":"string","focus":"string"}],
    "discussions":[{"prompt":"string (2-3 full sentences)","slo":"SLO X","format":"Initial post (300 words) + 2 replies (150 words each)"}]
  }],
  "assessments": [{
    "title":"string",
    "type":"paper",
    "dueWeek":number,
    "description":"string (2 sentences)",
    "fullPrompt":"string (complete instructions, 100-150 words)",
    "length":"string",
    "slos":["SLO X"],
    "gradingWeight":number
  }]
}

Rules:
- Include ALL ${course.weeks} weeks in the schedule array (week 1 through ${course.weeks})
- Include 2-4 major assessments; at least one should require written reflection integrating faith and learning
- Grading weights must sum to exactly 100
- Each discussion prompt should be substantive and academically challenging
- Reading assignments should be realistic for a ${course.creditHours}-credit course`;
}

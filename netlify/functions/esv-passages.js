// ESV Bible passage proxy.
// Fetches formatted passage text from the ESV API.
// ESV_API_KEY must be set in Netlify environment variables.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = { 'Content-Type': 'application/json' };

  try {
    const { passages } = JSON.parse(event.body || '{}');

    if (!passages?.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'passages array is required' }) };
    }

    const apiKey = process.env.ESV_API_KEY;
    if (!apiKey) {
      // Return empty passages gracefully if no API key — course still works without Bible text
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          passages: passages.map(ref => ({ ref, html: '', text: '', error: 'ESV_API_KEY not configured' })),
        }),
      };
    }

    const results = [];

    // Batch passages into groups of 5 to avoid rate limits
    for (let i = 0; i < passages.length; i++) {
      const ref = passages[i];
      try {
        const params = new URLSearchParams({
          q: ref,
          'include-footnotes': 'false',
          'include-headings': 'true',
          'include-short-copyright': 'true',
          'include-passage-references': 'true',
        });

        const resp = await fetch(`https://api.esv.org/v3/passage/html/?${params}`, {
          headers: { Authorization: `Token ${apiKey}` },
        });

        if (!resp.ok) {
          results.push({ ref, html: '', text: '', error: `HTTP ${resp.status}` });
          continue;
        }

        const data = await resp.json();
        results.push({
          ref,
          html: (data.passages || []).join(''),
          canonical: data.canonical || ref,
        });
      } catch (err) {
        results.push({ ref, html: '', text: '', error: err.message });
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ passages: results }),
    };
  } catch (err) {
    console.error('esv-passages.js error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// Fetches the IE catalog data (data-block.js) directly from the live IE app.
// SyllabusForge and the IE app are permanently connected — any update to the
// IE catalog (courses, SLOs, PLOs, ILOs) is automatically reflected here.

const vm = require('vm');

const DATA_BLOCK_URL = 'https://college-ie.netlify.app/data-block.js';

exports.handler = async () => {
  try {
    const res = await fetch(DATA_BLOCK_URL, {
      headers: { 'User-Agent': 'SyllabusForge/1.0' },
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for catalog data`);

    // Replace `const`/`let` with `var` so declarations attach to the vm sandbox
    const code = (await res.text()).replace(/\b(const|let)\b/g, 'var');
    const sandbox = {};
    vm.runInNewContext(code, sandbox, { timeout: 5000 });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // cache 1 hr at CDN
      },
      body: JSON.stringify({
        institution: sandbox.INSTITUTION || {},
        ilos: sandbox.ILOs || [],
        programs: sandbox.PROGRAMS || [],
        courseSlos: sandbox.COURSE_SLOS || {},
      }),
    };
  } catch (err) {
    console.error('catalog.js error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

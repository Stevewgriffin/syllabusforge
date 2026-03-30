// Fetches the IE catalog data directly from the live IE app (college-ie.netlify.app).
// SyllabusForge and the IE app are permanently connected — any update to the
// IE catalog (courses, SLOs, PLOs, ILOs) is automatically reflected here.

const vm = require('vm');

const IE_APP_URL = 'https://college-ie.netlify.app/';

exports.handler = async () => {
  try {
    const res = await fetch(IE_APP_URL, {
      headers: { 'User-Agent': 'SyllabusForge/1.0' },
    });
    if (!res.ok) throw new Error(`IE app returned ${res.status}`);

    const html = await res.text();

    // Extract the inline data block: starts at `const INSTITUTION` and ends
    // just before the first non-data comment section (MOBILE NAV, CATALOG FUNCTIONS, etc.)
    const dataStart = html.indexOf('const INSTITUTION');
    if (dataStart === -1) throw new Error('Could not find INSTITUTION in IE app HTML');

    // Find the end marker — the separator comment block after the data closes
    const endMarker = html.indexOf('\n// ============================================================\n// MOBILE NAV', dataStart);
    const altMarker = html.indexOf('\n// ============================================================\n// CATALOG FUNCTIONS', dataStart);
    const dataEnd = Math.min(
      endMarker !== -1 ? endMarker : Infinity,
      altMarker !== -1 ? altMarker : Infinity
    );
    if (dataEnd === Infinity) throw new Error('Could not find end of data block in IE app HTML');

    // Replace `const`/`let` with `var` so declarations attach to the vm sandbox
    const code = html.slice(dataStart, dataEnd).replace(/\b(const|let)\b/g, 'var');
    const sandbox = {};
    vm.runInNewContext(code, sandbox, { timeout: 5000 });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
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

// SyllabusForge Populi Scraper + File Downloader
// Injected by bookmarklet into the Populi page context.
// Has access to Populi session cookies for file downloads.

(function () {
  'use strict';

  // ── Utility helpers ──────────────────────────────────────────────────────────
  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  function getText(el) { return el ? clean(el.innerText || el.textContent || '') : ''; }

  // ── Inject JSZip if not already present ──────────────────────────────────────
  function loadJSZip() {
    return new Promise(function (resolve, reject) {
      if (window.JSZip) return resolve(window.JSZip);
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = function () { resolve(window.JSZip); };
      s.onerror = function () { reject(new Error('Could not load JSZip')); };
      document.head.appendChild(s);
    });
  }

  // ── Progress overlay UI ──────────────────────────────────────────────────────
  var overlay = null;
  var statusEl = null;
  var progressBar = null;
  var progressFill = null;
  var logEl = null;

  function createOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'sf-scraper-overlay';
    overlay.innerHTML = [
      '<div style="position:fixed;bottom:20px;right:20px;width:380px;background:#1E2D4A;border-radius:12px;',
      'box-shadow:0 8px 32px rgba(0,0,0,0.3);z-index:999999;font-family:-apple-system,BlinkMacSystemFont,sans-serif;',
      'color:#fff;overflow:hidden">',
      '<div style="padding:16px 18px 10px;display:flex;align-items:center;gap:10px">',
      '<span style="font-size:22px">📚</span>',
      '<div><div style="font-weight:700;font-size:14px">SyllabusForge Scraper</div>',
      '<div id="sf-status" style="font-size:12px;color:#8BA3C7;margin-top:2px">Initializing...</div></div></div>',
      '<div style="padding:0 18px 6px"><div style="background:rgba(255,255,255,0.15);border-radius:6px;height:8px;overflow:hidden">',
      '<div id="sf-progress" style="height:100%;background:#B8721D;border-radius:6px;width:0%;transition:width 0.3s"></div></div></div>',
      '<div id="sf-log" style="padding:6px 18px 14px;font-size:11px;color:#8BA3C7;max-height:120px;overflow-y:auto"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(overlay);
    statusEl = document.getElementById('sf-status');
    progressFill = document.getElementById('sf-progress');
    logEl = document.getElementById('sf-log');
  }

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
  function setProgress(pct) { if (progressFill) progressFill.style.width = pct + '%'; }
  function addLog(msg) {
    if (!logEl) return;
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.marginBottom = '2px';
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function showDone(zipName, fileCount, metaName) {
    if (!overlay) return;
    overlay.querySelector('div').innerHTML = [
      '<div style="padding:18px;text-align:center">',
      '<div style="font-size:36px;margin-bottom:8px">✅</div>',
      '<div style="font-weight:700;font-size:15px;margin-bottom:6px">Scrape Complete!</div>',
      '<div style="font-size:12px;color:#8BA3C7;line-height:1.6">',
      '<div>📦 <strong style="color:#fff">' + zipName + '</strong> — ' + fileCount + ' files</div>',
      '<div>📋 <strong style="color:#fff">' + metaName + '</strong> — metadata</div>',
      '<div style="margin-top:10px;color:#B8721D">Upload both files into SyllabusForge → Materials step</div>',
      '</div>',
      '<button onclick="this.closest(\'#sf-scraper-overlay\').remove()" style="margin-top:14px;background:#B8721D;color:#fff;border:none;border-radius:6px;padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer">Close</button>',
      '</div>'
    ].join('');
  }

  function showError(msg) {
    setStatus('Error: ' + msg);
    addLog('❌ ' + msg);
  }

  // ── Scrape page metadata (same logic as original bookmarklet) ────────────────
  function scrapePage() {
    var result = {
      url: window.location.href,
      scrapedAt: new Date().toISOString(),
      pageTitle: getText(document.querySelector('h1,h2,.course-title,.offering-title,[class*="title"]')) || document.title,
      courseInfo: {},
      syllabus: '',
      books: [],
      files: [],
      lessons: [],
      rawSections: []
    };

    // Course info
    var infoEls = document.querySelectorAll('[class*="course-info"],[class*="course-detail"],[class*="info-row"],[class*="meta"]');
    infoEls.forEach(function (el) {
      var t = getText(el);
      if (t && t.length < 300) result.rawSections.push({ type: 'info', text: t });
    });

    // Syllabus / description / content
    var descEls = document.querySelectorAll('[class*="syllabus"],[class*="description"],[class*="overview"],[class*="course-desc"],[class*="content-area"],[class*="lesson-content"],main,article,.main-content');
    descEls.forEach(function (el) {
      var t = getText(el);
      if (t && t.length > 100) {
        result.rawSections.push({ type: 'content', text: t.slice(0, 3000) });
        if (!result.syllabus && t.length > 200) result.syllabus = t.slice(0, 5000);
      }
    });

    // Book detection
    var allText = document.body.innerText || '';
    var bookMatches = allText.match(/(?:ISBN[:\s]+[\d\-X]+|(?:[A-Z][^.\n]{10,80})(?:\n|,\s*)(?:[A-Z][a-z]+(?:\s[A-Z][a-z]+)*),?\s*(?:19|20)\d{2})/g);
    if (bookMatches) bookMatches.slice(0, 20).forEach(function (b) { result.books.push(clean(b)); });

    var bookEls = document.querySelectorAll('[class*="book"],[class*="textbook"],[class*="material"],[class*="required"],[class*="resource"]');
    bookEls.forEach(function (el) {
      var t = getText(el);
      if (t && t.length > 5 && t.length < 500) {
        result.books.push(t);
        result.rawSections.push({ type: 'book', text: t });
      }
    });

    // File links
    var fileEls = document.querySelectorAll('a[href*=".pdf"],a[href*=".doc"],a[href*=".docx"],a[href*="download"],a[href*="file"],[class*="attachment"],[class*="file-row"],[class*="document"]');
    fileEls.forEach(function (el) {
      var name = clean(el.innerText || el.getAttribute('download') || el.getAttribute('title') || '');
      var href = el.href || '';
      if (name && name.length < 200 && href) result.files.push({ name: name, url: href });
    });

    // Lessons / weeks
    var lessonEls = document.querySelectorAll('[class*="lesson"],[class*="week"],[class*="module"],[class*="unit"],[class*="session"],li[class*="item"]');
    lessonEls.forEach(function (el) {
      var t = getText(el);
      if (t && t.length > 5 && t.length < 600) result.lessons.push(t);
    });

    // Tables
    var tables = document.querySelectorAll('table');
    tables.forEach(function (tbl) {
      var rows = Array.from(tbl.querySelectorAll('tr')).map(function (tr) {
        return Array.from(tr.querySelectorAll('th,td')).map(function (td) { return clean(td.innerText || ''); });
      });
      if (rows.length > 0) result.rawSections.push({ type: 'table', rows: rows });
    });

    // Headings
    var headings = document.querySelectorAll('h1,h2,h3,h4');
    result.rawSections.push({
      type: 'headings',
      items: Array.from(headings).map(function (h) { return { level: h.tagName, text: getText(h) }; }).filter(function (h) { return h.text.length > 1; })
    });

    // Deduplicate
    result.books = result.books.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    result.lessons = result.lessons.filter(function (v, i, a) { return v && a.indexOf(v) === i; }).slice(0, 60);

    return result;
  }

  // ── Guess course code from page content ──────────────────────────────────────
  function guessCourseCode() {
    var title = getText(document.querySelector('h1,h2,.course-title,.offering-title,[class*="title"]')) || document.title || '';
    // Try to find pattern like "BL331" or "TH 201" etc.
    var match = title.match(/\b([A-Z]{2,4})\s*(\d{3,4})\b/);
    if (match) return match[1] + match[2];
    // Try in the URL
    var urlMatch = window.location.href.match(/\/([A-Z]{2,4})\s*(\d{3,4})\b/i);
    if (urlMatch) return urlMatch[1].toUpperCase() + urlMatch[2];
    // Try anywhere on page
    var bodyMatch = (document.body.innerText || '').match(/\b([A-Z]{2,4})\s*(\d{3,4})\b/);
    if (bodyMatch) return bodyMatch[1] + bodyMatch[2];
    return 'COURSE';
  }

  // ── Sanitize filename ────────────────────────────────────────────────────────
  function safeName(name) {
    return name.replace(/[^a-zA-Z0-9._\-\s]/g, '').replace(/\s+/g, '_').slice(0, 100) || 'unnamed';
  }

  // ── Download a single file as blob ───────────────────────────────────────────
  function downloadFile(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.blob();
      });
  }

  // ── Trigger browser download of a blob ───────────────────────────────────────
  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Main execution ───────────────────────────────────────────────────────────
  async function main() {
    createOverlay();
    setStatus('Scanning page...');

    // Step 1: Scrape metadata
    var metadata;
    try {
      metadata = scrapePage();
    } catch (err) {
      showError('Failed to scrape page: ' + err.message);
      return;
    }

    var fileCount = metadata.files.length;
    addLog('Found ' + fileCount + ' file links, ' + metadata.books.length + ' books, ' + metadata.lessons.length + ' lessons');

    // Step 2: Ask for course code
    var courseCode = guessCourseCode();
    var userCode = prompt('SyllabusForge Scraper\n\nCourse code for this course?\n(Used to name the download folder)', courseCode);
    if (userCode === null) {
      overlay.remove();
      return;
    }
    courseCode = (userCode.trim() || courseCode).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    addLog('Course code: ' + courseCode);

    // Step 3: Download metadata JSON (always, even if no files to download)
    var metaFilename = 'populi-scrape-' + courseCode + '-' + Date.now() + '.json';
    var metaBlob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
    triggerDownload(metaBlob, metaFilename);
    addLog('Downloaded metadata: ' + metaFilename);

    if (fileCount === 0) {
      setStatus('No files to download — metadata saved.');
      addLog('No downloadable files found on this page.');
      showDone('(no files)', 0, metaFilename);
      return;
    }

    // Step 4: Load JSZip
    setStatus('Loading JSZip...');
    var JSZip;
    try {
      JSZip = await loadJSZip();
    } catch (err) {
      showError('Could not load JSZip: ' + err.message);
      addLog('Falling back to metadata-only download.');
      return;
    }

    // Step 5: Download files and add to ZIP
    var zip = new JSZip();
    var folder = zip.folder(courseCode + '-materials');
    var downloaded = 0;
    var failed = 0;
    var seenNames = {};

    // Add metadata JSON inside the ZIP too
    folder.file('_metadata.json', JSON.stringify(metadata, null, 2));

    // Deduplicate file URLs
    var uniqueFiles = [];
    var seenUrls = {};
    metadata.files.forEach(function (f) {
      if (f.url && !seenUrls[f.url]) {
        seenUrls[f.url] = true;
        uniqueFiles.push(f);
      }
    });

    setStatus('Downloading files: 0 / ' + uniqueFiles.length);

    for (var i = 0; i < uniqueFiles.length; i++) {
      var file = uniqueFiles[i];
      var pct = Math.round(((i + 1) / uniqueFiles.length) * 100);
      setProgress(pct);
      setStatus('Downloading ' + (i + 1) + ' / ' + uniqueFiles.length + ': ' + file.name.slice(0, 40));

      try {
        var blob = await downloadFile(file.url);

        // Determine filename — use the name from the link, or extract from URL
        var fname = file.name || '';
        // If the name doesn't have a file extension, try to get one from the URL
        if (!/\.\w{2,5}$/.test(fname)) {
          var urlPath = new URL(file.url).pathname;
          var ext = urlPath.match(/\.(\w{2,5})$/);
          if (ext) fname = fname + '.' + ext[1];
        }
        fname = safeName(fname);

        // Handle duplicate names
        if (seenNames[fname]) {
          var parts = fname.split('.');
          var ext2 = parts.length > 1 ? '.' + parts.pop() : '';
          fname = parts.join('.') + '_' + (i + 1) + ext2;
        }
        seenNames[fname] = true;

        folder.file(fname, blob);
        downloaded++;
        addLog('✓ ' + fname + ' (' + (blob.size / 1024).toFixed(0) + ' KB)');
      } catch (err) {
        failed++;
        addLog('✗ ' + file.name + ' — ' + err.message);
      }
    }

    // Step 6: Generate and download ZIP
    setStatus('Building ZIP...');
    setProgress(100);

    try {
      var zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      }, function (meta) {
        setStatus('Compressing: ' + meta.percent.toFixed(0) + '%');
      });

      var zipName = courseCode + '-materials.zip';
      triggerDownload(zipBlob, zipName);
      addLog('Downloaded: ' + zipName + ' (' + (zipBlob.size / 1024 / 1024).toFixed(1) + ' MB)');

      showDone(zipName, downloaded, metaFilename);
      if (failed > 0) {
        addLog('⚠ ' + failed + ' file(s) could not be downloaded (access restricted or broken link)');
      }
    } catch (err) {
      showError('Failed to create ZIP: ' + err.message);
    }
  }

  // ── Run ────────────────────────────────────────────────────────────────────────
  main().catch(function (err) {
    showError('Unexpected error: ' + err.message);
    console.error('[SyllabusForge Scraper]', err);
  });

})();

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const UCI_URL = 'https://www.uci-kinowelt.de/kinoprogramm/bad-oeynhausen/73/poster';
const BASE_URL = 'https://www.uci-kinowelt.de';

// Proxy-Dienste als Fallback wenn UCI direkt blockiert
const PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

app.use(express.static(path.join(__dirname, 'public')));

let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 10 * 60 * 1000;
let fetchInFlight = null;

// Versucht eine URL direkt oder über Proxy-Dienste zu laden
async function fetchWithFallback(url) {
  const attempts = [
    // 1. Direkter Aufruf
    () => fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9',
      }
    }),
    // 2. AllOrigins Proxy
    () => fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`),
    // 3. CorsProxy
    () => fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`),
  ];

  for (const attempt of attempts) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const res = await attempt();
      clearTimeout(timeout);
      if (res.ok) {
        const html = await res.text();
        if (html.includes('film-container')) return html; // echte UCI-Seite
      }
    } catch (e) {
      console.log('Fetch attempt failed:', e.message);
    }
  }
  throw new Error('Alle Fetch-Versuche fehlgeschlagen (UCI blockiert alle Routen)');
}

async function fetchMovies() {
  const now = Date.now();
  if (cache.data && now - cache.timestamp < CACHE_TTL) return cache.data;
  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = (async () => {
    try {
      const html = await fetchWithFallback(UCI_URL);
      const movies = parseMovies(html);
      cache = { data: movies, timestamp: Date.now() };
      return movies;
    } finally {
      fetchInFlight = null;
    }
  })();

  return fetchInFlight;
}

// Parse YYYYMMDD date string from data-date attribute
function parseDataDate(str) {
  if (!str || str.length !== 8) return null;
  const year = parseInt(str.slice(0, 4));
  const month = parseInt(str.slice(4, 6)) - 1;
  const day = parseInt(str.slice(6, 8));
  return new Date(year, month, day);
}

function formatDate(d) {
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

function parseMovies(html) {
  const $ = cheerio.load(html);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const movies = [];

  $('.film-container').each((_, container) => {
    const $c = $(container);

    // ----- Poster -----
    const posterSrc = $c.find('img.film-thumb').first().attr('src') || '';
    const poster = posterSrc ? BASE_URL + posterSrc : '';

    // ----- Title & film URL -----
    const titleEl = $c.find('.film-container__description__text__eventtitle a').first();
    const title = titleEl.text().trim();
    const filmHref = titleEl.attr('href') || '';
    const filmUrl = filmHref ? BASE_URL + filmHref : '';

    // film ID from URL: /film/{slug}/{id}/...
    const urlMatch = filmHref.match(/\/film\/([^/]+)\/(\d+)/);
    const slug = urlMatch ? urlMatch[1] : '';
    const filmId = urlMatch ? urlMatch[2] : '';

    if (!title) return; // skip empty

    // ----- FSK + Genre + Runtime from .film-info.infolist -----
    let fsk = '';
    let genre = '';
    let runtime = '';

    // Get FSK from class name: fsk--6 → "6", fsk--na → "?"
    const fskEl = $c.find('.fsk').first();
    if (fskEl.length) {
      const fskClass = fskEl.attr('class') || '';
      const fskClassMatch = fskClass.match(/fsk--(\d+)/);
      if (fskClassMatch) {
        fsk = fskClassMatch[1];
      } else if (fskClass.includes('fsk--na')) {
        fsk = '?';
      } else {
        const fskText = fskEl.text().trim();
        const fskNum = fskText.match(/(\d+)/);
        fsk = fskNum ? fskNum[1] : '?';
      }
    }

    // Parse li items: skip event-label badges, FSK, runtime, Spielwoche labels
    const genreCandidates = [];
    $c.find('ul.film-info.infolist li').each((_, li) => {
      const $li = $(li);
      if ($li.find('.event-label').length) return;
      if ($li.find('.fsk').length) return;
      const text = $li.text().replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (/^\d+\s*min$/i.test(text)) {
        runtime = text.replace(/[^0-9]/g, '');
      } else if (/^\d+\.\s*Spielwoche$/i.test(text)) {
        // weekly screening counter badge — skip
      } else {
        genreCandidates.push(text);
      }
    });
    // Genre is the last candidate (always after runtime/badges in UCI's markup)
    genre = genreCandidates[genreCandidates.length - 1] || '';

    // ----- Description -----
    let description = '';
    $c.find('.film-description__row').each((_, row) => {
      const dt = $(row).find('dt').text().trim();
      if (dt === 'Beschreibung') {
        description = $(row).find('dd').text().trim();
        return false;
      }
    });

    // ----- Director -----
    let director = '';
    $c.find('.film-description__row').each((_, row) => {
      const dt = $(row).find('dt').text().trim();
      if (dt === 'Regie') {
        director = $(row).find('dd').text().trim();
        return false;
      }
    });

    // ----- Cast -----
    let cast = '';
    $c.find('.film-description__row').each((_, row) => {
      const dt = $(row).find('dt').text().trim();
      if (dt === 'Darsteller') {
        cast = $(row).find('dd').text().trim();
        return false;
      }
    });

    // ----- Showtimes -----
    // Table: each <tr> has <th class="day"> + <td class="time">
    // Showtimes are <a class="badge-performance"> with data-time, data-date, data-version
    const showtimesMap = new Map(); // dateKey -> {date, dateObj, times:[]}

    $c.find('table tr').each((_, tr) => {
      const $tr = $(tr);
      const dayTh = $tr.find('th.day');
      if (!dayTh.length) return;

      // Get date from first time-slot's data-date
      const firstSlot = $tr.find('a.badge-performance').first();
      const dataDate = firstSlot.attr('data-date') || '';
      const dateObj = parseDataDate(dataDate);
      if (!dateObj) return;

      const dateKey = formatDate(dateObj);
      if (!showtimesMap.has(dateKey)) {
        showtimesMap.set(dateKey, { date: dateKey, dateObj, times: [] });
      }
      const day = showtimesMap.get(dateKey);

      $tr.find('a.badge-performance').each((_, a) => {
        const $a = $(a);
        const href = $a.attr('href') || '';
        const time = $a.attr('data-time') || $a.find('span').first().text().trim();
        const version = $a.attr('data-version') || '';
        const subtext = $a.find('.performance-badge__subtext').text().trim();

        // Extract performance ID
        const perfMatch = href.match(/\/performanceId\/([^/]+)\/siteId\/\d+\/(\d+)/);
        const performanceId = perfMatch ? perfMatch[1] : '';
        const numericId = perfMatch ? perfMatch[2] : '';

        // Build human-readable version label
        const versionLabel = buildVersionLabel(version, subtext);

        if (time) {
          day.times.push({ time, version: versionLabel, performanceId, numericId, href: BASE_URL + href });
        }
      });
    });

    const showtimes = Array.from(showtimesMap.values())
      .filter(d => d.times.length > 0)
      .sort((a, b) => a.dateObj - b.dateObj);

    const firstDate = showtimes.length > 0 ? showtimes[0].dateObj : null;
    const isUpcoming = firstDate ? firstDate > today : false;

    movies.push({
      title, slug, filmId, filmUrl,
      poster, genre, fsk, runtime, director, cast, description,
      showtimes, firstDate, isUpcoming,
    });
  });

  return movies;
}

function buildVersionLabel(versionStr, subtext) {
  const parts = (versionStr || '').toLowerCase().split('|');
  const labels = [];
  if (parts.includes('imax')) labels.push('IMAX');
  if (parts.includes('isens')) labels.push('iSense');
  if (parts.includes('3d')) labels.push('3D');
  if (parts.includes('ov') || subtext === 'OV') labels.push('OV');
  if (parts.includes('omu')) labels.push('OmU');
  return labels.join(' ');
}

app.get('/api/debug', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(UCI_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9',
      }
    });
    clearTimeout(timeout);
    res.json({ status: r.status, ok: r.ok, url: UCI_URL });
  } catch (err) {
    res.json({ error: err.message, type: err.name });
  }
});

app.get('/api/movies', async (req, res) => {
  try {
    const movies = await fetchMovies();
    res.json({ success: true, movies, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  cache = { data: null, timestamp: 0 };
  try {
    const movies = await fetchMovies();
    res.json({ success: true, movies, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address;
        break;
      }
    }
  }
  console.log(`UCI Kino Bad Oeynhausen`);
  console.log(`  Lokal:   http://localhost:${PORT}`);
  console.log(`  Handy:   http://${localIP}:${PORT}`);
});

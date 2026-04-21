// Standalone-Scraper — läuft als GitHub Action
// Schreibt das Ergebnis nach data/movies.json

const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const UCI_URL = 'https://www.uci-kinowelt.de/kinoprogramm/bad-oeynhausen/73/poster';
const BASE_URL = 'https://www.uci-kinowelt.de';
const OUT_FILE = path.join(__dirname, 'data', 'movies.json');

const DE_MONTHS = { Jan:0,Feb:1,'Mär':2,Apr:3,Mai:4,Jun:5,Jul:6,Aug:7,Sep:8,Okt:9,Nov:10,Dez:11 };

function parseDataDate(str) {
  if (!str || str.length !== 8) return null;
  return new Date(+str.slice(0,4), +str.slice(4,6)-1, +str.slice(6,8));
}

function formatDate(d) {
  return d.toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'2-digit' });
}

function buildVersionLabel(versionStr, subtext) {
  const parts = (versionStr||'').toLowerCase().split('|');
  const labels = [];
  if (parts.includes('imax'))  labels.push('IMAX');
  if (parts.includes('isens')) labels.push('iSense');
  if (parts.includes('3d'))    labels.push('3D');
  if (parts.includes('ov') || subtext === 'OV') labels.push('OV');
  if (parts.includes('omu'))   labels.push('OmU');
  return labels.join(' ');
}

function parseMovies(html) {
  const $ = cheerio.load(html);
  const today = new Date(); today.setHours(0,0,0,0);
  const movies = [];

  $('.film-container').each((_, container) => {
    const $c = $(container);

    const posterSrc = $c.find('img.film-thumb').first().attr('src') || '';
    const poster = posterSrc ? BASE_URL + posterSrc : '';

    const titleEl = $c.find('.film-container__description__text__eventtitle a').first();
    const title = titleEl.text().trim();
    const filmHref = titleEl.attr('href') || '';
    if (!title) return;

    const urlMatch = filmHref.match(/\/film\/([^/]+)\/(\d+)/);
    const slug = urlMatch ? urlMatch[1] : '';
    const filmId = urlMatch ? urlMatch[2] : '';

    let fsk = '', genre = '', runtime = '', description = '', director = '', cast = '';

    const fskEl = $c.find('.fsk').first();
    if (fskEl.length) {
      const fc = fskEl.attr('class') || '';
      const fm = fc.match(/fsk--(\d+)/);
      fsk = fm ? fm[1] : (fc.includes('fsk--na') ? '?' : '?');
    }

    const genreCandidates = [];
    $c.find('ul.film-info.infolist li').each((_, li) => {
      const $li = $(li);
      if ($li.find('.event-label').length || $li.find('.fsk').length) return;
      const text = $li.text().replace(/\s+/g,' ').trim();
      if (!text) return;
      if (/^\d+\s*min$/i.test(text))          runtime = text.replace(/\D/g,'');
      else if (/^\d+\.\s*Spielwoche$/i.test(text)) { /* skip */ }
      else genreCandidates.push(text);
    });
    genre = genreCandidates[genreCandidates.length-1] || '';

    $c.find('.film-description__row').each((_, row) => {
      const dt = $(row).find('dt').text().trim();
      const dd = $(row).find('dd').text().trim();
      if (dt === 'Beschreibung') description = dd;
      if (dt === 'Regie')        director = dd;
      if (dt === 'Darsteller')   cast = dd;
    });

    const showtimesMap = new Map();
    $c.find('table tr').each((_, tr) => {
      const $tr = $(tr);
      if (!$tr.find('th.day').length) return;
      const dataDate = $tr.find('a.badge-performance').first().attr('data-date') || '';
      const dateObj = parseDataDate(dataDate);
      if (!dateObj) return;
      const dateKey = formatDate(dateObj);
      if (!showtimesMap.has(dateKey)) showtimesMap.set(dateKey, { date:dateKey, dateObj, times:[] });
      const day = showtimesMap.get(dateKey);
      $tr.find('a.badge-performance').each((_, a) => {
        const $a = $(a);
        const href = $a.attr('href') || '';
        const time = $a.attr('data-time') || $a.find('span').first().text().trim();
        const version = $a.attr('data-version') || '';
        const subtext = $a.find('.performance-badge__subtext').text().trim();
        const perfMatch = href.match(/\/performanceId\/([^/]+)\/siteId\/\d+\/(\d+)/);
        if (time) day.times.push({
          time,
          version: buildVersionLabel(version, subtext),
          performanceId: perfMatch ? perfMatch[1] : '',
          numericId:     perfMatch ? perfMatch[2] : '',
          href: BASE_URL + href,
        });
      });
    });

    const showtimes = Array.from(showtimesMap.values())
      .filter(d => d.times.length > 0)
      .sort((a,b) => a.dateObj - b.dateObj);

    const firstDate = showtimes.length > 0 ? showtimes[0].dateObj : null;

    movies.push({
      title, slug, filmId,
      filmUrl: filmHref ? BASE_URL + filmHref : '',
      poster, genre, fsk, runtime, director, cast, description,
      showtimes,
      firstDate,
      isUpcoming: firstDate ? firstDate > today : false,
    });
  });

  return movies;
}

async function main() {
  console.log('Starte UCI-Scraper…');
  const res = await fetch(UCI_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9',
    }
  });

  if (!res.ok) throw new Error(`UCI antwortete mit ${res.status}`);
  const html = await res.text();
  const movies = parseMovies(html);

  if (movies.length === 0) throw new Error('Keine Filme gefunden — Seite hat sich möglicherweise geändert');

  const output = { movies, fetchedAt: new Date().toISOString(), count: movies.length };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`✅ ${movies.length} Filme gespeichert → ${OUT_FILE}`);
}

main().catch(e => { console.error('❌ Fehler:', e.message); process.exit(1); });

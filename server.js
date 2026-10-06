const express = require('express');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const MAX_MB = process.env.MAX_MB || 300;      // лимит размера файла
const MAX_PARALLEL = 2;                         // одновременных загрузок
let active = 0;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Слишком много запросов. Подождите минуту.' } }));

// Проверка ссылки: только http(s) и не локальные адреса
function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname;
  if (h === 'localhost' || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local') || h.includes(':')) return null;
  return u.href;
}

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', args, { timeout: 5 * 60_000, ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', () => reject(new Error('yt-dlp не установлен на сервере')));
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(err.split('\n').filter(Boolean).pop() || 'Ошибка yt-dlp')));
  });
}

const fmtTime = s => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), c = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(c).padStart(2, '0');
};

app.get('/api/info', async (req, res) => {
  const url = checkUrl(req.query.url);
  if (!url) return res.status(400).json({ error: 'Некорректная ссылка' });
  try {
    const j = JSON.parse(await run(['-J', '--no-playlist', '--no-warnings', url]));
    res.json({
      title: j.title, channel: j.uploader || j.channel || '',
      duration: j.duration, durationText: fmtTime(j.duration), thumbnail: j.thumbnail || ''
    });
  } catch (e) {
    res.status(422).json({ error: 'Не удалось получить видео. Проверьте ссылку или доступ к видео.' });
  }
});

const HEIGHTS = { '4K': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480 };

app.get('/api/download', async (req, res) => {
  const url = checkUrl(req.query.url);
  if (!url) return res.status(400).json({ error: 'Некорректная ссылка' });
  if (active >= MAX_PARALLEL) return res.status(503).json({ error: 'Сервер занят. Попробуйте через минуту.' });

  const { mode, q, fmt } = req.query;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipo-'));
  const args = ['--no-playlist', '--no-warnings', '--max-filesize', MAX_MB + 'M',
                '-o', path.join(dir, '%(title).80B.%(ext)s'), '--restrict-filenames'];

  if (mode === 'a') {
    const kb = { '320 kbps': '320K', '256 kbps': '256K', '128 kbps': '128K' }[q] || '0';
    const codec = { MP3: 'mp3', M4A: 'm4a', OPUS: 'opus' }[fmt] || 'mp3';
    args.push('-x', '--audio-format', codec, '--audio-quality', kb);
  } else {
    const h = HEIGHTS[q] || 1080;
    const container = { MP4: 'mp4', WEBM: 'webm', MKV: 'mkv' }[String(fmt).toUpperCase()] || 'mp4';
    args.push('-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', container);
  }
  args.push(url);

  active++;
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  try {
    await run(args);
    const file = fs.readdirSync(dir)[0];
    if (!file) throw new Error('Файл не создан');
    res.download(path.join(dir, file), file, cleanup);
  } catch (e) {
    cleanup();
    const big = /larger than/i.test(e.message);
    res.status(422).json({ error: big ? `Файл больше ${MAX_MB} МБ. Выберите качество ниже.` : 'Не удалось скачать. Попробуйте другое качество или формат.' });
  } finally { active--; }
});

app.listen(PORT, () => console.log('Clipo запущен на порту ' + PORT));

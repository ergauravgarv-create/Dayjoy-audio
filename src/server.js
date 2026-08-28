import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { WebSocketServer } from 'ws';

import { loadConfig, ROOT } from './config.js';
import { Glossary } from './glossary.js';
import { createProviders } from './providers/index.js';
import { LiveSession } from './session.js';
import { createBackTranslator } from './backtranslate.js';
import { listRecordings, readManifest, recordingFileStat } from './recorder.js';
import { logger } from './log.js';

const log = logger('server');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

const config = await loadConfig();
const GLOSSARY_PATH = join(ROOT, 'config', 'glossary.json');
const REVIEW_LANGS = config.translateChannels.map((c) => c.code);
const glossary = await Glossary.load(GLOSSARY_PATH, REVIEW_LANGS);
const providers = await createProviders(config);
const session = new LiveSession({ config, providers, glossary });
const backTranslator = createBackTranslator(config);

const PUBLIC_DIR = join(ROOT, 'public');

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Body was not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function sendFile(res, path, { cache = 'no-cache' } = {}) {
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': cache,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

/**
 * Recorded audio with byte-range support, so a distributor can scrub through an
 * hour-long Telugu recording instead of waiting for it to download.
 */
async function sendRecordingAudio(req, res, id, file) {
  if (!/^[a-z]{2,3}\.(mp3|wav)$/.test(file)) {
    res.writeHead(400).end('Bad file');
    return;
  }
  let path;
  let size;
  try {
    const info = await recordingFileStat(config.recording.dir, id, file);
    path = info.path;
    size = info.stat.size;
  } catch {
    res.writeHead(404).end('No such recording');
    return;
  }

  const type = MIME[extname(file)] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start) || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
    });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  createReadStream(path).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (path === '/' || path === '/listen') return sendFile(res, join(PUBLIC_DIR, 'listen.html'));
    // One permanent link per training: live while it runs, the recording
    // afterwards. Distributors forward these on WhatsApp, and a link that dies
    // when the session ends gets forwarded anyway.
    if (/^\/s\/[\w-]+$/.test(path)) return sendFile(res, join(PUBLIC_DIR, 'listen.html'));
    if (path === '/trainer') return sendFile(res, join(PUBLIC_DIR, 'trainer.html'));
    if (path === '/admin') return sendFile(res, join(PUBLIC_DIR, 'admin.html'));
    if (path === '/review') return sendFile(res, join(PUBLIC_DIR, 'review.html'));
    if (path === '/compliance') return sendFile(res, join(PUBLIC_DIR, 'compliance.html'));
    if (path === '/healthz') return sendJson(res, 200, { ok: true, live: session.live });

    if (path === '/api/config') {
      return sendJson(res, 200, {
        channels: config.channels.map(({ code, name, native, mode, note }) => ({
          code,
          name,
          native,
          mode,
          note: note || null,
        })),
        recordingEnabled: config.recording.enabled,
        providers: {
          asr: providers.asr.name,
          mt: providers.mt.name,
          tts: providers.tts.name,
        },
      });
    }

    if (path === '/api/status') return sendJson(res, 200, session.status());


    // ---- glossary review -------------------------------------------------
    if (path.startsWith('/api/glossary')) {
      if (url.searchParams.get('key') !== config.reviewKey) {
        return sendJson(res, 401, { error: 'A review link with a valid key is required.' });
      }

      const lang = url.searchParams.get('lang');
      const channel = config.translateChannels.find((c) => c.code === lang);
      if (!channel) {
        return sendJson(res, 400, {
          error: 'Unknown language',
          languages: config.translateChannels.map(({ code, name, native }) => ({ code, name, native })),
        });
      }

      if (path === '/api/glossary/review' && req.method === 'GET') {
        const items = glossary.reviewList(lang);
        return sendJson(res, 200, {
          lang,
          language: { code: channel.code, name: channel.name, native: channel.native },
          version: glossary.version,
          items,
          progress: {
            total: items.length,
            done: items.filter((i) => i.review.status !== 'pending').length,
          },
        });
      }

      if (path === '/api/glossary/review' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          const result = await glossary.applyReview(GLOSSARY_PATH, { ...body, lang });
          const items = glossary.reviewList(lang);
          return sendJson(res, 200, {
            ...result,
            progress: {
              total: items.length,
              done: items.filter((i) => i.review.status !== 'pending').length,
            },
          });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      // Hearing it is the point. A spelling that looks right on the page and is
      // mispronounced by the voice has failed, and only the ear catches that.
      if (path === '/api/glossary/preview') {
        const text = (url.searchParams.get('text') || '').slice(0, 200);
        if (!text) return sendJson(res, 400, { error: 'Nothing to say' });
        try {
          const spoken = await providers.tts.synthesise({ text, channel, rate: 1.0 });
          res.writeHead(200, {
            'content-type': spoken.mime,
            'content-length': spoken.audio.length,
            'cache-control': 'no-store',
          });
          return res.end(spoken.audio);
        } catch (err) {
          return sendJson(res, 502, { error: `Voice engine failed: ${err.message}` });
        }
      }

      return sendJson(res, 404, { error: 'No such glossary endpoint' });
    }

    // ---- compliance sign-off ---------------------------------------------
    if (path.startsWith('/api/compliance')) {
      if (url.searchParams.get('key') !== config.complianceKey) {
        return sendJson(res, 401, { error: 'A compliance link with a valid key is required.' });
      }

      const lang = url.searchParams.get('lang');
      const channel = config.translateChannels.find((c) => c.code === lang);

      if (path === '/api/compliance/claims' && req.method === 'GET') {
        if (!channel) {
          return sendJson(res, 400, {
            error: 'Unknown language',
            languages: config.translateChannels.map(({ code, name, native }) => ({ code, name, native })),
          });
        }
        const items = glossary.complianceList(lang);
        return sendJson(res, 200, {
          lang,
          language: { code: channel.code, name: channel.name, native: channel.native },
          backTranslationAvailable: backTranslator.available,
          items,
          progress: {
            total: items.length,
            done: items.filter((i) => i.compliance.status !== 'pending').length,
          },
        });
      }

      if (path === '/api/compliance/backtranslate') {
        if (!channel) return sendJson(res, 400, { error: 'Unknown language' });
        const text = (url.searchParams.get('text') || '').slice(0, 400);
        try {
          const out = await backTranslator.run(text, channel);
          return sendJson(res, 200, out || { text: '', via: 'none', literal: false });
        } catch (err) {
          return sendJson(res, 503, { error: err.message });
        }
      }

      if (path === '/api/compliance/decision' && req.method === 'POST') {
        const body = await readBody(req);
        const target = body.lang === 'master' ? 'master' : lang;
        if (target !== 'master' && !channel) return sendJson(res, 400, { error: 'Unknown language' });
        try {
          const result = await glossary.applyCompliance(GLOSSARY_PATH, { ...body, lang: target });
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }

      return sendJson(res, 404, { error: 'No such compliance endpoint' });
    }

    if (path === '/api/recordings') {
      return sendJson(res, 200, { recordings: await listRecordings(config.recording.dir) });
    }

    const manifestMatch = /^\/api\/recordings\/([\w-]+)$/.exec(path);
    if (manifestMatch) {
      try {
        return sendJson(res, 200, await readManifest(config.recording.dir, manifestMatch[1]));
      } catch {
        return sendJson(res, 404, { error: 'No such recording' });
      }
    }

    const audioMatch = /^\/api\/recordings\/([\w-]+)\/audio\/([\w.]+)$/.exec(path);
    if (audioMatch) return sendRecordingAudio(req, res, audioMatch[1], audioMatch[2]);

    // Static assets, with traversal blocked.
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    return sendFile(res, filePath, { cache: 'public, max-age=60' });
  } catch (err) {
    log.error('request failed', { path, err: err.message });
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
  }
});

// ---- websockets ---------------------------------------------------------

const wssListen = new WebSocketServer({ noServer: true });
const wssTrainer = new WebSocketServer({ noServer: true });
const wssAdmin = new WebSocketServer({ noServer: true });

wssListen.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  session.addListener(ws);
  const initial = url.searchParams.get('lang');
  if (initial) session.setListenerLanguage(ws, initial);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'subscribe') {
      session.setListenerLanguage(ws, msg.lang);
    } else if (msg.type === 'question') {
      session
        .askQuestion({ ws, text: msg.text, askedBy: msg.askedBy })
        .then((q) => ws.send(JSON.stringify({ type: 'question-sent', id: q.id })))
        .catch((err) => ws.send(JSON.stringify({ type: 'question-error', error: err.message })));
    }
  });

  ws.on('close', () => session.removeListener(ws));
  ws.on('error', () => session.removeListener(ws));
});

wssTrainer.on('connection', (ws) => {
  session.addConsole(ws, 'trainer');
  log.info('trainer console connected');

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) {
      session.pushTrainerAudio(Buffer.from(raw));
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    try {
      if (msg.type === 'start') {
        await session.start({ title: msg.title });
      } else if (msg.type === 'stop') {
        await session.stop();
      } else if (msg.type === 'align') {
        session.setAlignmentDelay(msg.ms);
      } else if (msg.type === 'answered') {
        session.questions.markAnswered(msg.id, msg.answered !== false);
      }
    } catch (err) {
      log.error('trainer command failed', { type: msg.type, err: err.message });
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', detail: err.message }));
    }
  });

  ws.on('close', () => {
    session.removeConsole(ws);
    log.info('trainer console disconnected');
  });
  ws.on('error', () => session.removeConsole(ws));
});

wssAdmin.on('connection', (ws) => {
  session.addConsole(ws, 'admin');
  const timer = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stats', stats: session.stats() }));
  }, 2000);
  ws.on('close', () => {
    clearInterval(timer);
    session.removeConsole(ws);
  });
  ws.on('error', () => {
    clearInterval(timer);
    session.removeConsole(ws);
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const key = url.searchParams.get('key');

  const reject = () => {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  };

  if (url.pathname === '/ws/listen') {
    wssListen.handleUpgrade(req, socket, head, (ws) => wssListen.emit('connection', ws, req));
  } else if (url.pathname === '/ws/trainer') {
    if (key !== config.trainerKey) return reject();
    wssTrainer.handleUpgrade(req, socket, head, (ws) => wssTrainer.emit('connection', ws, req));
  } else if (url.pathname === '/ws/admin') {
    if (key !== config.adminKey) return reject();
    wssAdmin.handleUpgrade(req, socket, head, (ws) => wssAdmin.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(config.port, config.host, () => {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  log.info('listening', { host: config.host, port: config.port });
  console.log('');
  console.log('  Dayjoy multilingual training audio');
  console.log(`  Listeners   ${base}/`);
  console.log(`  Trainer     ${base}/trainer  (key: ${config.trainerKey})`);
  console.log(`  Admin       ${base}/admin    (key: ${config.adminKey})`);
  console.log(`  Providers   asr=${providers.asr.name} mt=${providers.mt.name} tts=${providers.tts.name}`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log.info('shutting down', { signal: sig });
    try {
      await session.stop();
    } catch (err) {
      log.error('shutdown error', { err: err.message });
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

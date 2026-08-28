import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from './log.js';

const log = logger('recorder');

const WAV_HEADER_BYTES = 44;

function wavHeader(sampleRate, dataBytes) {
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * Archives a training as one continuous audio file per language, plus a
 * timestamped transcript.
 *
 * Two formats are handled. Neural voices return constant-bitrate MP3, whose
 * frames concatenate cleanly, so those are appended straight to disk. The
 * trainer's own microphone arrives as raw PCM, so a WAV header is written up
 * front with placeholder sizes and patched once the session ends - which avoids
 * ever holding an hour of audio in memory.
 */
export class SessionRecorder {
  constructor({ dir, sessionId, title, config }) {
    this.dir = join(dir, sessionId);
    this.sessionId = sessionId;
    this.title = title;
    this.config = config;
    this.streams = new Map(); // lang -> { stream, bytes, format }
    this.channels = new Map(); // lang -> { segments, durationMs }
    this.startedAt = Date.now();
    this.endedAt = null;
    this.closed = false;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    log.info('recording started', { session: this.sessionId, dir: this.dir });
    await this.writeManifest();
  }

  channelState(lang) {
    if (!this.channels.has(lang)) this.channels.set(lang, { segments: [], durationMs: 0 });
    return this.channels.get(lang);
  }

  async streamFor(lang, format) {
    if (this.streams.has(lang)) return this.streams.get(lang);

    const ext = format === 'audio/mpeg' ? 'mp3' : 'wav';
    const file = `${lang}.${ext}`;
    const stream = createWriteStream(join(this.dir, file));

    // A WAV needs its header before the samples; the sizes get patched at the end.
    if (ext === 'wav') stream.write(wavHeader(this.config.audio.inputSampleRate, 0));

    const entry = { stream, file, ext, format, bytes: 0 };
    this.streams.set(lang, entry);
    return entry;
  }

  /** Append one translated segment's audio and its transcript line. */
  async appendSegment(lang, { audio, mime, durationMs, text, sourceText, seq, flagged }) {
    if (this.closed) return;
    const entry = await this.streamFor(lang, mime);
    const payload = mime === 'audio/wav' ? audio.subarray(WAV_HEADER_BYTES) : audio;
    entry.stream.write(payload);
    entry.bytes += payload.length;

    const state = this.channelState(lang);
    state.segments.push({
      seq,
      atMs: state.durationMs,
      durationMs,
      text,
      sourceText,
      flagged: flagged || false,
    });
    state.durationMs += durationMs;
  }

  /** Append raw microphone PCM for the untouched original-language archive. */
  async appendOriginalAudio(pcmChunk) {
    if (this.closed) return;
    const entry = await this.streamFor('hi', 'audio/wav');
    entry.stream.write(pcmChunk);
    entry.bytes += pcmChunk.length;
    const state = this.channelState('hi');
    state.durationMs = Math.round((entry.bytes / (this.config.audio.inputSampleRate * 2)) * 1000);
  }

  async writeManifest() {
    const manifest = {
      id: this.sessionId,
      title: this.title,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: this.endedAt ? new Date(this.endedAt).toISOString() : null,
      durationMs: (this.endedAt || Date.now()) - this.startedAt,
      sourceLocale: this.config.languages.source.primary,
      glossaryVersion: this.glossaryVersion || null,
      questions: this.questions || [],
      channels: {},
    };

    for (const [lang, state] of this.channels) {
      const entry = this.streams.get(lang);
      const channel = this.config.channels.find((c) => c.code === lang);
      manifest.channels[lang] = {
        code: lang,
        name: channel?.name || lang,
        native: channel?.native || lang,
        mode: channel?.mode || 'translate',
        file: entry?.file || null,
        mime: entry?.format || null,
        bytes: entry?.bytes || 0,
        durationMs: state.durationMs,
        segmentCount: state.segments.length,
        flaggedCount: state.segments.filter((s) => s.flagged).length,
        segments: state.segments,
      };
    }

    await writeFile(join(this.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }

  async close() {
    if (this.closed) return null;
    this.closed = true;
    this.endedAt = Date.now();

    for (const [lang, entry] of this.streams) {
      await new Promise((resolve) => entry.stream.end(resolve));
      if (entry.ext === 'wav') {
        // Patch the two size fields now that the sample count is known.
        const fh = await open(join(this.dir, entry.file), 'r+');
        try {
          const size = (await fh.stat()).size;
          const dataBytes = Math.max(0, size - WAV_HEADER_BYTES);
          const riff = Buffer.alloc(4);
          riff.writeUInt32LE(36 + dataBytes, 0);
          await fh.write(riff, 0, 4, 4);
          const data = Buffer.alloc(4);
          data.writeUInt32LE(dataBytes, 0);
          await fh.write(data, 0, 4, 40);
        } finally {
          await fh.close();
        }
      }
      log.info('channel archived', { lang, file: entry.file, bytes: entry.bytes });
    }

    const manifest = await this.writeManifest();
    log.info('recording finished', {
      session: this.sessionId,
      channels: Object.keys(manifest.channels).length,
      durationMs: manifest.durationMs,
    });
    return manifest;
  }
}

/** All archived trainings, newest first. */
export async function listRecordings(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(join(dir, e.name, 'manifest.json'), 'utf8'));
      if (!manifest.endedAt) continue; // still in progress
      out.push({
        id: manifest.id,
        title: manifest.title,
        startedAt: manifest.startedAt,
        durationMs: manifest.durationMs,
        channels: Object.values(manifest.channels).map((c) => ({
          code: c.code,
          name: c.name,
          native: c.native,
          durationMs: c.durationMs,
          bytes: c.bytes,
        })),
      });
    } catch {
      /* a directory without a readable manifest is a crashed session; skip it */
    }
  }

  out.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return out;
}

export async function readManifest(dir, id) {
  return JSON.parse(await readFile(join(dir, id, 'manifest.json'), 'utf8'));
}

export async function recordingFileStat(dir, id, file) {
  const path = join(dir, id, file);
  return { path, stat: await stat(path) };
}

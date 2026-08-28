# Dayjoy multilingual training audio

Live AI interpretation for Dayjoy product trainings. The trainer speaks Hindi and
English exactly as they do today; distributors open one link, pick their language,
and hear the same session about four seconds behind.

**Languages in this build:** Telugu, Kannada, Odia, Bengali, Tamil and English as
listening channels, with Hindi as the untouched original. English is a real
translation channel, not a passthrough — the trainer speaks Hindi, so English
listeners need Hindi→English.

Every session is also **recorded per language**, so `listen.dayjoy.in` serves both
the live training and a searchable archive of past ones.

---

## Run it right now, with no cloud account

```bash
npm install
npm start
```

Then open three tabs:

| Page | URL | What it is |
|---|---|---|
| Listener | http://localhost:8080/ | What a distributor sees |
| Trainer | http://localhost:8080/trainer | Mic capture, alignment, channel health |
| Admin | http://localhost:8080/admin | Latency, drift, cost, glossary status |

On the trainer page click **Start training**. Mock providers replay a scripted
Hinglish Dayjoy training, translate it, and speak it as a placeholder tone — so
the transport, segmentation, drift control, validation, recording and playback
all run end to end before anyone has an Azure key.

The mock voice is a warble, not speech. It is there to prove the plumbing, never
to judge quality.

```bash
npm test     # validator, segmenter, drift and glossary logic
```

---

## Going live

Copy `.env.example` to `.env` and switch the providers:

```env
ASR_PROVIDER=azure
MT_PROVIDER=claude          # falls back to Azure Translator automatically
TTS_PROVIDER=azure

AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=centralindia
AZURE_TRANSLATOR_KEY=...    # the fallback
ANTHROPIC_API_KEY=...
```

Central India keeps the audio in-country, which is the reason to prefer it over
a cheaper region.

---

## Three things this build does deliberately

**1. The microphone is captured in the browser, not taken from Zoom.**
Zoom's RTMP output runs 15–30 seconds behind the trainer. Reading from it caps
the whole system at twenty-something seconds of lag and nothing downstream
recovers that. The trainer page captures the mic directly and streams 16 kHz PCM
over a WebSocket. Zoom keeps carrying video and the original audio.

Nothing integrates with Zoom at all. The trainer opens a page, allows the
microphone, and speaks — the meeting platform is never involved, so this works
just as well with Meet, Teams, a webinar, or a room with no video call in it.

**2. The channels are actively kept from drifting.**
A Telugu rendering of a Hindi sentence is usually longer than the source, so the
voice takes more time to speak each segment than the trainer took to say it. Left
alone every channel falls further behind each minute. Two corrections run
together: the backlog is measured before each segment and handed to the voice
engine as an SSML rate between 1.0× and 1.25× (asking the *engine* to speak
faster keeps the voice natural — speeding up playback in the browser would raise
the pitch), and segments play back to back rather than at their original timing,
so the trainer's pauses are where the channel catches up. Past 15 seconds of
backlog a segment is skipped and the listener is told.

**3. Brand terms carry a spelling in every script.**
Marking *Super Richberries* "never translate" is half the job — left in Latin
letters inside Telugu text, the Telugu voice mispronounces or skips it. Every
protected term in `config/glossary.json` carries an approved native-script
spelling per language, and `Glossary.enforce()` substitutes it after translation.

---

## Signal chain

```
Trainer mic ──► recognise ──► segment ──► glossary gate
                                              │
                    ┌────────┬────────┬───────┼────────┬────────┐
                   te       kn       or      bn       ta       en
                    │        │        │       │        │        │
              translate → validate → speak → schedule → listeners
                                              │
                                          recorder
```

Everything up to segmentation happens **once**, however many people are listening.
Only translation and voice fork, and they fork per *language*, never per
participant — 150 Telugu listeners share one Telugu channel. Adding the twelfth
language costs one more branch, not a rebuild.

Each channel processes its segments through its own promise chain, so channels
run in parallel but a listener never hears sentence four before sentence three.

| File | Role |
|---|---|
| `src/pipeline.js` | Recognise once, fan out per language, validate, speak |
| `src/segmenter.js` | Phrases → translation units; holds back short fragments |
| `src/drift.js` | Backlog tracking, speech-rate ladder, drop decision |
| `src/validator.js` | Number, brand-term and claim-drift checks |
| `src/glossary.js` | Term detection, prompt directives, native-spelling substitution |
| `src/recorder.js` | Per-language archive + timestamped transcript |
| `src/session.js` | Live session, listener sockets, fan-out |
| `src/providers/` | Swappable ASR / MT / TTS, each with a mock |
| `scripts/preflight.js` | Validates real keys; writes voice samples to choose from |
| `deploy/` | nginx, systemd, and the listen.dayjoy.in runbook |

The trainer console shows what is actually arriving from the microphone —
byte rate against the expected 31.2 kB/s, signal level, and whether frames are
reaching the server at all. A silent channel and a broken one look identical
from the listener's side, so this is the first thing to check when something is
wrong.

---

## What never reaches a listener's ear

Every translated segment is checked before it is spoken:

- **Every number in the source must survive.** Indic digits are folded to ASCII
  first, so `5-10 ml` arriving as `౫-౧౦` validates correctly while `50 ml` does
  not. Numbers the model invented are caught too.
- **No claim may be strengthened.** If a claim term appears in the translation
  with no counterpart in the source, the segment fails.
- **Protected terms** should appear in their approved spelling.

A failure triggers one strict retry. If it fails again the segment is **sent as a
caption but never spoken**, an incident is raised on the trainer console so the
trainer can repeat the figure, and it is marked in the transcript. Silence for
one sentence beats a wrong dosage.

Number and claim failures are critical. A mangled brand name is a warning — it
sounds wrong, it is not dangerous.

---

## The glossary is the real asset

`config/glossary.json` ships as a **starter**. Every spelling in it was generated
during the build and is marked `"reviewed": false`. The admin page counts them.

### Getting it reviewed

Review is **per language** — a Telugu reviewer cannot vouch for the Kannada
spelling — so twelve words across six languages is 72 sign-offs, not 12.

Two ways to collect them, and reviewers never touch JSON either way:

**A link** — send `https://listen.dayjoy.in/review?key=<REVIEW_KEY>`. They type
their name, pick their language, and go through one word at a time: what it is,
how we spelled it, a **Hear how the voice says it** button, then *Yes, this is
right* or *No, needs fixing*. Hearing it is the point — a spelling that looks
fine and is mispronounced has still failed, and only the ear catches that. Every
answer saves immediately; they can stop and come back.

**A spreadsheet**, for reviewers who would rather work offline:

```bash
npm run review:sheet                              # one CSV per language
npm run review:apply review/te-glossary-review.csv --dry
npm run review:apply review/te-glossary-review.csv
```

The CSVs carry a UTF-8 BOM so Excel opens Telugu and Odia as text rather than
mojibake, and `review/README.txt` is written alongside them in plain language to
send to reviewers. Apply is all-or-nothing: if any row is marked wrong without a
correction, or the reviewer forgot to write their name, nothing is written.

Both paths record who approved what and when, which is the audit trail you want
if a claim is ever questioned.

### Health claims need a second, separate sign-off

A native speaker can tell you the Telugu reads naturally. They cannot tell you
whether the claim is permissible under FSSAI or the Drugs and Magic Remedies
Act. That is a different person answering a different question, so claims are
tracked on two independent tracks and **both must pass** before a claim is
spoken:

```
compliance.master  - may this claim be made at all, in any language?
compliance.<lang>  - is this translation still that same claim, no stronger?
review.<lang>      - does the wording read naturally to a native speaker?
```

Send your regulatory reviewer `https://listen.dayjoy.in/compliance?key=<COMPLIANCE_KEY>`.

They almost certainly do not read Odia, so each translation is shown back to
them as a **literal English back-translation** — deliberately not smoothed out,
because a fluent back-translation would hide the exact drift they are looking
for. If a back-translation is available, they cannot approve wording without
reading it first. Rejecting stays available either way: refusing text you cannot
read is always safe.

Three further rules the system enforces on its own:

- The master ruling comes first. Approving a translation of a claim that is not
  itself permissible is meaningless, and the order matters in the audit trail.
- If a native speaker later **changes** a claim's wording, the compliance
  sign-off for that language is automatically reset to pending — a sign-off
  covers specific words, not a row in a file.
- With `REQUIRE_CLAIM_SIGNOFF=true` (the default), an uncleared claim is never
  spoken. The sentence still reaches listeners as a caption saying "This part is
  not translated — please listen to the trainer for it", and the trainer console
  tells the trainer to make the point in their own words.

### Watching the trainer, not just the model

Every check above watches the model for drift. None of them watch the **trainer**,
and in an unscripted session a trainer improvising "yeh diabetes theek karta hai"
is at least as likely a problem as the model strengthening a claim.

So each segment is screened at source, before any translation, against two lists
in the glossary:

- `forbiddenClaimTerms.hi` / `.en` — claim language in Hindi (Devanagari *and*
  romanised, because trainers speak Hinglish and recognisers return both) and in
  English: curing, treating, immunity boosting, detox, "no side effects",
  "100% safe", "guaranteed", "clinically proven".
- `restrictedConditions` — named medical conditions. Naming a condition
  alongside a product is what the Drugs and Magic Remedies Act restricts.

This **warns and records; it never blocks.** "This does not treat diabetes" is a
legitimate sentence, and a system that silenced it would be switched off within a
week. The trainer console shows *"Careful — that was claim language"* in red, and
the segment is marked in the transcript for audit.

```bash
npm run compliance:report     # review/compliance-report.md
```

That report is the artefact to keep on file: every claim, every language, who
approved what, on what basis, and the back-translation they actually saw.

Three policies:

- `keep` — never translated; the `say` spelling per language is substituted so
  the voice pronounces it correctly.
- `render` — one agreed translation per language, so the same idea does not
  arrive as three different words across three trainings.
- `forbiddenClaimTerms` — the drift guard described above.

Only the terms present in the current segment are sent to the translator, so the
prompt stays short as the dictionary grows to hundreds of products.

---

## Questions come back as text, not voice

The training is **one-way**: one trainer speaks, everyone listens. Distributors do
not talk back, so no microphone is ever needed on a distributor's phone and no
distributor's voice is captured anywhere.

Instead they **type** a question in their own language on the listen page. The
server translates it into Hindi and English, and it appears on the trainer's
console to answer out loud — and that spoken answer goes back through the normal
pipeline, so everyone hears it in their own language.

That closes the loop with one trainer and one microphone, and sidesteps the most
sensitive part of the data question at the same time: a typed question is
something a person chose to send, not audio captured incidentally from a room.

Details that matter in a 600-person room:

- The question appears on the console **immediately in the original**, then again
  once translated. A question two seconds late is still useful; one that never
  arrives because a translator failed is not.
- If translation is unavailable the original is still delivered, labelled
  *not translated*, rather than dropped.
- The console **replays the queue on connect**, so a trainer who refreshes
  mid-session does not lose pending questions.
- Five questions per person per minute, 500 characters each.
- Names are optional, and questions are archived in the recording manifest —
  what distributors actually asked is one of the more useful things a training
  produces.

## Recordings

Every session is archived to `data/recordings/<session-id>/`:

```
manifest.json     title, timings, per-channel transcript with offsets
hi.wav            the trainer's original microphone, untouched
te.mp3  kn.mp3 …  one continuous file per translated language
```

The listener page's **Past trainings** tab lists them, plays any language with
byte-range seeking, and shows a transcript where tapping a line jumps the audio.

By default a language nobody listened to is not translated, spoken, or archived —
that is most of the per-session saving. Set `TRANSLATE_ALL_CHANNELS=true` to
archive every language regardless of who attended live, or name specific ones with
`ALWAYS_ON_LANGS=te,kn`.

---

## Before you go live

```bash
npm run preflight
```

Checks every provider against your real keys, and synthesises the same Dayjoy
sentence — dosage, BV figure, two brand terms, one hedged claim — in **both** the
female and male voice of every language, writing them to `samples/`.

Play each pair to a native speaker and set `VOICE_TE`, `VOICE_KN` and so on to
whichever sounds like a trainer rather than an announcer. That choice cannot be
made from a datasheet and it is the cheapest quality win available.

Preflight exits non-zero while glossary entries are still unreviewed. That is
deliberate — it is the gate that stops a training running on transliterations
nobody has checked.

## Deploying listen.dayjoy.in

Everything is in [`deploy/`](deploy/DEPLOY.md): nginx config, a hardened systemd
unit, and step-by-step instructions from a bare Ubuntu box to a running training.

Two things worth knowing before you start:

- **TLS is required, not optional.** Browsers refuse microphone access on
  anything but `localhost` over plain HTTP, so the trainer page will not work
  without a certificate.
- **The WebSocket upgrade headers are the step that silently fails.** Get them
  wrong and the page loads, the language buttons work, and no audio ever plays.
  `DEPLOY.md` has a one-line curl that must return `101`.

Bandwidth, not CPU, is the binding constraint: roughly 32 kbit/s per listener, so
600 people is about 19 Mbit/s sustained and 7 GB for a one-hour training.

---

## Checking it against the acceptance bar

The admin page measures the two numbers that decide whether the pilot worked:

| Metric | Target | Where |
|---|---|---|
| Median delay, sentence end to listener | ≤ 5.0 s | Admin, live |
| Worst drift over the session | ≤ 2.0 s | Admin, "Peak behind" |
| Numbers preserved | 100% | `npm test` + withheld count |
| Segments withheld | 0 | Admin, red if not |
| Data per listener | ≤ 15 MB/hr | Listener page, live counter |

Two it cannot measure, which still decide the project: eight native speakers per
language rating "I understood the product explanation" at 4/5 or better, and the
thing running on an entry-level Android phone over 3G.

---

## Not in this build, on purpose

Video hosting (Zoom keeps doing that), quizzes, certificates, any LMS, native
mobile apps, participant accounts, voice cloning, and multilingual Q&A. Phase 1
exists to answer one question — does a Telugu distributor genuinely understand a
Dayjoy product explanation from a synthetic voice — for the smallest possible sum.

---

## A note on health claims

Translation is where a careful claim quietly becomes a stronger one. "Supports
cellular protection" rendered as "protects cells from disease" has moved from a
permissible claim into territory covered by FSSAI advertising rules and the Drugs
and Magic Remedies Act. The claim allowlist and the drift guard are compliance
controls, not just quality ones, and they need a named regulatory owner.

The listener page carries a standing notice that the audio is machine-translated
and the trainer's original words are authoritative. Leave it there.

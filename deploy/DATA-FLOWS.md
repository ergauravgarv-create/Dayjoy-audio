# Where the data goes

Written for whoever owns Dayjoy's DPDP position. It is a factual map of what
this system processes and where, not legal advice — the assessment at the end
needs your counsel's sign-off.

## What is actually in the audio

This matters more than the border question, because most of a product training
is not personal data at all.

| What | Whose personal data | Captured? |
|---|---|---|
| Trainer speaking about products | The trainer's voice | Yes, continuously |
| Distributors listening on `listen.dayjoy.in` | None — the page only receives | No |
| A question typed on the listen page | The asker's words, and a name if they give one | Yes, when they choose to send it |
| Attendance, quiz scores, certificates | Every attendee | Not built |

Two things follow, and both work in your favour.

**Only one voice is ever recorded** — the trainer's, captured from their own
microphone. They are an employee or contractor, a known party whose consent is
straightforward to obtain. No distributor's voice is captured anywhere, because
nothing on a distributor's device sends audio.

**Questions are typed, not spoken.** A distributor who types a question has
chosen to send those words, which is a materially different thing from having
their voice picked up out of a room. Names are optional.

## Where each piece goes

| Step | Component | Location | Contains |
|---|---|---|---|
| 1 | Trainer microphone → this server | Your server | Trainer's voice |
| 2 | Speech recognition | Azure `centralindia` | Audio |
| 3 | Translation | **Anthropic, US** *or* Azure `centralindia` | Transcript text |
| 4 | Neural voice | Azure `centralindia` | Translated text |
| 5 | Audio to listeners | Your server | Translated speech |
| 6 | Typed questions → translation for the trainer | Same as row 3 | Question text |
| 7 | Recordings, transcripts, questions | Your server disk | All of the above |

**Row 3 is the only thing that leaves India**, and it is a configuration choice.
Raw audio never crosses the border in any configuration.

## Running entirely inside India

If counsel decides nothing should cross the border, the system already supports
it with one setting and no code change:

```env
MT_PROVIDER=azure          # Azure Translator in centralindia, not Anthropic
AZURE_TRANSLATOR_REGION=centralindia
```

The cost is bounded and specific: translation quality on Hinglish drops, because
handling code-switched Hindi and English is the particular thing the language
model does better. Everything else is unchanged.

## The legal position, as best we can establish it

Not legal advice. Facts as of August 2026, all of which should be re-checked.

- **Section 16 of the DPDP Act uses a negative list.** Transfer abroad is
  permitted to any country *except* those the Central Government notifies as
  restricted — the opposite of the GDPR's approach, and considerably more
  permissive.
- **No restricted-country list has been reliably confirmed as published.**
  Reporting conflicts on whether anything was notified in early 2026, and no
  specific countries have been publicly identified. Verify current status before
  relying on this.
- **The date that matters is 13 May 2027.** The DPDP Rules 2025 were notified on
  13 November 2025 and commence in three phases; the cross-border conditions,
  along with notice, consent, retention and security rules, fall in the final
  phase.
- **Sectoral localisation rules override Section 16**, but the ones that exist —
  RBI payment data, SEBI, IRDAI — do not apply to a nutraceutical business.
- **Penalties reach ₹250 crore** for failure to take reasonable security
  safeguards, which is the reason to have this reviewed rather than assumed.

## Assessment

On the rules as they stand, a transcript reaching a US processor is **not
prohibited**, and the United States is an unlikely candidate for a restricted
list given the volume of existing India–US data flows.

Raw audio does not leave the country at all.

The surface here is genuinely small: one consenting speaker, no distributor
voices, and typed questions people chose to send. That is a far easier position
to defend than it would have been with a bot capturing a whole room.

Three things worth doing before the first real training, none of which need
engineering:

1. Tell participants the session is recorded and machine-translated, and that
   processing involves service providers including some outside India. The
   listener page already carries a machine-translation notice — extend it, and
   mention that questions people type are stored with the recording.
2. Get the trainer's consent explicitly. They are the only person captured
   continuously.
3. Decide a retention period for recordings, transcripts and questions, and set
   `RECORDING_RETENTION_DAYS` to match what the notice says. Nothing deletes
   automatically today.

The question that would need counsel rather than a default is **spoken** Q&A —
capturing distributor voices at scale. That is deliberately not built, and this
assessment does not cover it.

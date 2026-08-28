# Deploying listen.dayjoy.in

From a bare Ubuntu 22.04/24.04 server to a working training in about an hour.

## What size server

The heavy work happens in Azure, not here. This box recognises, orchestrates and
fans out audio — it does not run any models.

| Listeners | vCPU | RAM | Egress needed |
|---|---|---|---|
| Up to 300 | 2 | 4 GB | ~10 Mbit/s |
| Up to 1,000 | 4 | 8 GB | ~32 Mbit/s |

**Bandwidth is the binding constraint, not CPU.** Each listener takes about
32 kbit/s. Six hundred people is roughly 19 Mbit/s sustained and about 7 GB for a
one-hour training — check your provider's egress allowance before the first big
session, because that is the line that generates a surprise bill.

Put the server in an India region. It keeps the round trip to Azure India short,
which comes straight off the latency budget.

Storage: a one-hour session archives at roughly 130 MB (the original Hindi WAV is
most of it). A year of two trainings a week is under 15 GB.

## 1. DNS

Point an A record at the server before requesting a certificate.

```
listen.dayjoy.in.   A   <server-ip>
```

## 2. System setup

```bash
sudo apt update && sudo apt install -y nginx git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo useradd --system --home /opt/dayjoy-audio --shell /usr/sbin/nologin dayjoy
```

## 3. Application

```bash
sudo mkdir -p /opt/dayjoy-audio
sudo chown dayjoy:dayjoy /opt/dayjoy-audio
sudo -u dayjoy git clone <your-repo> /opt/dayjoy-audio
cd /opt/dayjoy-audio
sudo -u dayjoy npm ci --omit=dev
sudo -u dayjoy mkdir -p data/recordings
```

## 4. Configuration

```bash
sudo -u dayjoy cp .env.example .env
sudo -u dayjoy nano .env
sudo chmod 600 .env
```

Set at minimum:

```env
ASR_PROVIDER=azure
MT_PROVIDER=claude
TTS_PROVIDER=azure
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=centralindia
AZURE_TRANSLATOR_KEY=...
ANTHROPIC_API_KEY=...
PUBLIC_URL=https://listen.dayjoy.in
TRAINER_KEY=<a long random string>
ADMIN_KEY=<a different long random string>
```

Also set `REVIEW_KEY` and `COMPLIANCE_KEY`. They go to native-speaker reviewers
and to your regulatory reviewer — different people, neither of whom should hold a
key that opens the trainer console.

Generate the keys rather than inventing them:

```bash
openssl rand -hex 24
```

Those keys are the only thing standing between the public internet and your
trainer console. Treat them like passwords, and put proper accounts in front of
`/trainer` and `/admin` before this grows past a pilot.

## 5. Prove the keys work

```bash
sudo -u dayjoy npm run preflight
```

This checks every provider and writes a voice sample per language to `samples/`.
It exits non-zero if anything a live training depends on is broken.

**Do this before scheduling anything.** It also fails while glossary entries are
unreviewed, which is deliberate — see step 8.

## 6. Run it as a service

```bash
sudo cp deploy/dayjoy-audio.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dayjoy-audio
sudo systemctl status dayjoy-audio
```

## 7. nginx and TLS

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/listen.dayjoy.in
sudo ln -s /etc/nginx/sites-available/listen.dayjoy.in /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d listen.dayjoy.in
```

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

**TLS is not optional.** Browsers refuse microphone access on anything but
`localhost` over plain HTTP, so the trainer page simply will not work without it.

Check the WebSocket path specifically — this is the step that most often looks
fine and is not:

```bash
curl -sI https://listen.dayjoy.in/healthz
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://listen.dayjoy.in/ws/listen
```

The second command should print `101`. If it prints `200` or `400`, the upgrade
headers are not reaching the app: the page will load, the language buttons will
work, and no audio will ever play.

## 8. Before the first real training

- [ ] `npm run preflight` passes clean
- [ ] A native speaker has listened to both voice samples per language and you
      have set `VOICE_TE`, `VOICE_KN` etc. to their choice
- [ ] Every glossary word reviewed **in every language** — send each native
      speaker `https://listen.dayjoy.in/review?key=<REVIEW_KEY>`, or mail them a
      sheet from `npm run review:sheet`. `npm run preflight` reports what is
      still outstanding, broken down by language.
- [ ] A regulatory reviewer has signed off every claim, in every language, at
      `https://listen.dayjoy.in/compliance?key=<COMPLIANCE_KEY>` — this is a
      **different person** from the language reviewers, and both sign-offs are
      required before a claim is spoken
- [ ] `REQUIRE_CLAIM_SIGNOFF=true` in `.env` (the default — preflight fails if not)
- [ ] `npm run compliance:report` filed with whoever keeps your regulatory records
- [ ] A 15-minute rehearsal with two or three native speakers on real phones,
      on mobile data, not office wifi
- [ ] Trainer knows where the slide-alignment slider is and has set it once
- [ ] Someone is watching `/admin` during the session

## 9. Running a training

1. Trainer opens `https://listen.dayjoy.in/trainer?key=...`, allows the mic, and
   confirms **Reaching server: Yes** with the rate near 31 kB/s.
2. Enter a title, click **Start training**.
3. Set the alignment slider so listeners hear each point as its slide appears.
4. Distributors open `https://listen.dayjoy.in`, pick a language, mute Zoom.
5. At the end, **End & save recording** — the archive appears under
   *Past trainings* within seconds.

If **Reaching server** stays red while the level bar moves, the microphone is
fine and the connection is not. Nothing downstream will run. Check step 7.

## 10. Keeping it running

```bash
sudo journalctl -u dayjoy-audio -f          # live logs
sudo journalctl -u dayjoy-audio | grep -E 'ERROR|withheld'
```

`withheld` lines are the ones that matter: a segment whose dosage or claim failed
validation twice and was never spoken. Zero is the target; anything else needs a
look at the glossary.

Back up `data/recordings/` — the transcripts are your audit trail for what was
said in each language on each date, which is exactly what you want if a claim is
ever questioned.

Retention is set by `RECORDING_RETENTION_DAYS`. Nothing deletes automatically
yet; add a cron job when you decide the policy, and make sure that policy is the
same one your DPDP notice tells distributors.

## Updating

```bash
cd /opt/dayjoy-audio
sudo -u dayjoy git pull
sudo -u dayjoy npm ci --omit=dev
sudo systemctl restart dayjoy-audio
```

Restarting ends any live session and finalises its recording. Do not deploy
mid-training.

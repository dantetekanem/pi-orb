# pi-orb

Two tools connect Pi to the standalone [Orb macOS app](https://github.com/dantetekanem/orb). Orb owns voice, animation, settings, and meeting safety. The connector sends requests and returns results.

## Install

Install the connector from GitHub:

```sh
pi install git:github.com/dantetekanem/pi-orb
```

`pi install` adds the package to Pi's user settings by default. Use `pi install -l git:github.com/dantetekanem/pi-orb` for project settings. Run `/reload` or start a new session after installing.

For local development, load the extension for one run:

```sh
pi -e ./src/index.ts
```

This loads the local extension for the current run; it does not add the package to persistent settings or register an automatic startup task. Start [Orb](https://github.com/dantetekanem/orb) separately before using the tools. The connector does not launch Orb, install its voice runtime, or own an app process. It requires Node 22+ and the Orb API at `127.0.0.1:45821`; Pi supplies its SDK and TypeBox, so no other runtime dependency is needed.

## Tools

- `orb_say`: `{ "text": "The build is ready." }`
- `orb_ask`: a question with 2 to 6 answers, a required `default_answer_id`, and optional `timeout_seconds` from 10 to 60 (default 30).

```json
{
  "question": "Continue with the prototype?",
  "answers": [
    { "id": "yes", "label": "Yes", "summary": "Continue the agreed work." },
    { "id": "no", "label": "Do nothing", "detail": "Leave the current state untouched." }
  ],
  "default_answer_id": "no",
  "timeout_seconds": 20
}
```

`orb_say` returns acceptance, not completed speech. When Orb's displays are asleep, it returns `state: "suppressed"` and `delivery: "none"`; the connector closes its listening binding without retrying or replaying the message. `orb_ask` holds its connection until a click or Orb's deadline and returns the stable `answer_id` with `answered_by: "user"` or `"timeout"`. A timeout is never approval. Stop, replacement, invalid replies, transport failures, and cancellation produce tool errors, not invented answers. Cancellation closes only that request, not a global stop. Speech and question requests never retry automatically. Their replies are limited to 8 KiB and request JSON to 16 KiB.

The five short instruction lines live under `prompt/`. Pi includes each tool's guidelines only while that tool is active. Loading the connector does not speak, open a window, or start a background task.

## OpenAI voice and Listen

Launch Orb from a terminal with `OPENAI_API_KEY` exported. Orb reads that inherited key for its outbound WebSocket connection; it does not use Keychain or ask for a key in Settings. Pi sends only a random binding ID, authentication token and `credential_source: "orb"`; it neither reads an environment key nor mints or receives OpenAI credentials. Transcripts stay in the editor until you submit them.

Voice uses `gpt-realtime-2.1-mini` and mono 24 kHz PCM. Choose the voice and speaking speed in Orb's **Settings → OpenAI voice**; Marin at 1× is the default. Input transcription uses `gpt-transcribe` with English/Portuguese hints and Pi/Orb keywords. Voice instructions are bundled by Orb from `Sources/Orb/Prompts/realtime-voice.md`; automatic turn detection is disabled. Each new synthesis or transcription reads the environment key; cached replay does not. Return polls carry routing and acknowledgments only.

Listen requires a compatible `pi-voice-shortcut` extension and the originating editor to remain open. Its synchronous `pi-voice-shortcut:bind-orb-transcript` event receives `{ version: 1, context, reply }` and returns `{ isActive, final, dispose }`. Without that peer, OpenAI playback still works with Listen disabled. A missing native key uses local Piper and disables Listen; invalid credentials or provider failures show safe native errors. After changing the exported key, relaunch Orb from that terminal and start a new Orb interaction. Update native Orb and reload this connector together: an older app can reject the new routing-only metadata. No shell-key migration or credential-file access occurs.

Listen/Stop records one explicit utterance. Final transcription fills the original Pi input once, preserves existing text through the editor adapter, and never submits it or answers an Orb question. The authenticated `/voice-session` return poll runs concurrently with `/ask`, which still waits for a click or its timeout default. Each poll has a 25-second deadline; native waits up to 20 seconds. Only initial binding readiness can retry HTTP 410, at most twice, 100 ms apart. A later 410 ends listening. Final capture IDs are acknowledged only after insertion; duplicate IDs are acknowledged without inserting twice. Voice replies are limited to 16,384 serialized JSON bytes and transcripts to 4,000 UTF-16 code units; overflow is rejected, never truncated.

Cancellation, replacement, session shutdown/navigation, submitted input, or a closed editor ends the old listening binding. The connector checks its pinned session/UI identities and the editor port before dispatch and insertion; while polling it also checks every 250 ms. A listening failure does not manufacture or cancel a question answer. Listen warnings wait for the speech/question response: suppressed or cancelled interactions stay quiet; unexpected failures still warn after a successful response. Normal native binding closure ends listening without a warning. Native microphone permission, meeting safety, and explicit recording controls remain authoritative.

## Herdr and meetings

Inside Herdr, each call reads the sending pane's current location and adds a title such as `Herdr 1:3`. The first number is Herdr's tab number. The second is the pane's one-based visual position, ordered top to bottom then left to right, not an opaque pane ID. Original workspace, tab, and pane IDs travel separately as `source_context`. Missing, inconsistent, or zoomed layouts omit the positional context rather than guessing. Orb never moves the pointer, focuses a pane, or executes an action from this metadata.

Display sleep suppresses both audio and the island, cancels questions and listening, and does not queue delivery for wake. Orb's native meeting policy, timeout default, and cancellation behavior are authoritative; the connector does not override them. Orb may deliver silently when microphone input is active or unknown, or when Meeting mode is on. For muted or listen-only Meet, Tuple, Teams, and Zoom calls, use Orb's Meeting mode: microphone activity cannot identify every meeting. The connector does not override that setting or repeat a suppressed message.

## Focused checks

```sh
PI_PACKAGE_ROOT=/absolute/path/to/already-installed/pi-coding-agent node --test test/*.test.mjs
```

Use the direct test command above when avoiding installs; package-manager script commands can automatically install missing peers. The tests reuse Pi's installed Jiti and Typebox with fake HTTP and process boundaries. They do not launch Pi or Orb, contact the live API, speak, or modify preferences. The source follows pi-companion's ESM entry point and external Markdown structure, without its scheduler or persistent state.

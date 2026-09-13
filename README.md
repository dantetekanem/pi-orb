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

`orb_say` returns acceptance, not completed speech. `orb_ask` holds its connection until a click or Orb's deadline and returns the stable `answer_id` with `answered_by: "user"` or `"timeout"`. A timeout is never approval. Stop, replacement, invalid replies, transport failures, and cancellation produce tool errors, not invented answers. Cancellation closes only that request, not a global stop. Requests never retry automatically. Replies are limited to 8 KB and request JSON to 16 KB.

The five short instruction lines live under `prompt/`. Pi includes each tool's guidelines only while that tool is active. Loading the connector does not speak, open a window, or start a background task.

## Herdr and meetings

Inside Herdr, each call reads the sending pane's current location and adds a title such as `Herdr 1:3`. The first number is Herdr's tab number. The second is the pane's one-based visual position, ordered top to bottom then left to right, not an opaque pane ID. Original workspace, tab, and pane IDs travel separately as `source_context`. Missing, inconsistent, or zoomed layouts omit the positional context rather than guessing. Orb never moves the pointer, focuses a pane, or executes an action from this metadata.

Orb's native meeting policy, timeout default, and cancellation behavior are authoritative; the connector does not override them. Orb may deliver silently when microphone input is active or unknown, or when Meeting mode is on. For muted or listen-only Meet, Tuple, Teams, and Zoom calls, use Orb's Meeting mode: microphone activity cannot identify every meeting. The connector does not override that setting or repeat a suppressed message.

## Focused checks

```sh
PI_PACKAGE_ROOT=/absolute/path/to/already-installed/pi-coding-agent node --test test/*.test.mjs
```

Use the direct test command above when avoiding installs; package-manager script commands can automatically install missing peers. The tests reuse Pi's installed Jiti and Typebox with fake HTTP and process boundaries. They do not launch Pi or Orb, contact the live API, speak, or modify preferences. The source follows pi-companion's ESM entry point and external Markdown structure, without its scheduler or persistent state.

# pi Nairi provider

Use Nairi agents as models inside the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

This extension discovers your deployed Nairi agents, registers each one as a pi model, forwards prompts through the Nairi public Conversations API, streams Nairi progress events into pi, and preserves the Nairi conversation per pi session.

## Features

- Registers a `nairi` provider in pi
- Lists deployed Nairi agents as selectable models
- Starts and continues Nairi API conversations
- Streams assistant text back into pi
- Shows Nairi progress messages while the agent works
- Persists the Nairi `job_id` per pi session and agent
- Supports `/nairi-reset` to start a fresh Nairi conversation
- Blocks pi fork/tree navigation for Nairi sessions to avoid mismatched remote conversation state

## Requirements

- pi coding agent installed
- A Nairi API key
- Node.js 22+

## Install

Clone this repo into your pi extensions directory:

```bash
git clone https://github.com/nairiai/pi-nairi-provider.git ~/.pi/agent/extensions/nairi-provider
```

Set your API key in the environment where pi starts:

```bash
export NAIRI_API_KEY="your_key_here"
```

Restart pi, or run this inside an active pi session:

```text
/reload
```

Then select a Nairi model with pi's model picker.

## Configuration

### `NAIRI_API_KEY`

Required. Bearer token used for the Nairi public API.

```bash
export NAIRI_API_KEY="..."
```

## Usage

### Select a Nairi model

After install, pi will show models under the `nairi` provider. Each model corresponds to one deployed Nairi agent.

### Ask a Nairi agent

Use pi normally after selecting a Nairi model:

```text
Summarize the current repository and suggest next steps.
```

The extension sends only the latest user prompt to Nairi, then polls the Nairi API until the turn completes. Progress messages are rendered in pi as they arrive.

### Reset the remote conversation

The extension keeps a Nairi conversation per pi session and model. To start fresh for the active Nairi model:

```text
/nairi-reset
```

## How it works

At startup the extension calls:

```http
GET /api/public/v1/agents
```

For each returned agent, it registers a pi model under the `nairi` provider.

For the first prompt in a pi session/model pair, it calls:

```http
POST /api/public/v1/conversations/start
```

For follow-up prompts, it calls:

```http
POST /api/public/v1/conversations/{job_id}/continue
```

It polls the current user message with:

```http
GET /api/public/v1/messages/{message_id}
```

and fetches conversation messages with:

```http
GET /api/public/v1/conversations/{job_id}/messages
```

Polling happens every 2 seconds.

## Development

Install dependencies:

```bash
npm install
```

Typecheck:

```bash
npm run typecheck
```

For local development, symlink or clone this repo into pi's extension directory:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/nairi-provider
```

Then reload pi:

```text
/reload
```

## Security notes

- Do not commit `NAIRI_API_KEY`.
- The extension does not upload binary/image files; image content in pi messages is replaced with a text placeholder.

## License

MIT

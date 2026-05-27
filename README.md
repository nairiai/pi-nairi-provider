# pi Nairi provider

Use [Nairi](https://nairi.ai) agents as models inside the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

This extension discovers your deployed [Nairi](https://nairi.ai) agents, registers each one as a pi model, forwards prompts through the [Nairi public Conversations API](https://nairi.ai/docs/api/conversations/overview), streams Nairi progress events into pi, and preserves the Nairi conversation per pi session.

## Features

- Registers a `nairi` provider in pi
- Lists deployed Nairi agents as selectable models
- Starts and continues Nairi API conversations
- Uploads pi image/file attachments to Nairi and sends their `attachment_ids` with each prompt
- Downloads attachments returned by Nairi into a local temp directory and links them in pi
- Streams assistant text back into pi
- Shows Nairi progress messages while the agent works
- Shows queued state as transient pi UI instead of adding it to the assistant message
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

### `NAIRI_MAX_FILE_ATTACHMENT_BYTES`

Optional. Max size for local `@file` references uploaded as Nairi attachments. Defaults to Nairi's API limit of 50 MB and is capped at 50 MB.

```bash
export NAIRI_MAX_FILE_ATTACHMENT_BYTES=52428800
```

## Usage

### Select a Nairi model

After install, pi will show models under the `nairi` provider. Each model corresponds to one deployed Nairi agent.

Use pi's model picker, or launch pi directly with an agent slug:

```bash
pi --provider nairi --model "my-agent"
```

For example, if your deployed Nairi agent has `agent_id: eksecai/eksecd`:

```bash
pi --provider nairi --model "eksecai/eksecd"
```

### Ask a Nairi agent

Use pi normally after selecting a Nairi model:

```text
Summarize the current repository and suggest next steps.
```

The extension sends the latest user prompt plus up to 10 attachments to Nairi, then polls the Nairi API until the turn completes. Progress messages are rendered in pi as they arrive.

### Send attachments

Attachments are uploaded first with `POST /api/public/v1/attachments`, then referenced as `attachment_ids` on `conversations/start` or `conversations/{job_id}/continue`.

Supported inputs:

- images attached to the pi user message
- local files referenced in the prompt as `@path`, `@"path with spaces"`, or `@'path with spaces'`

Examples:

```text
Review @README.md and suggest improvements.
```

```text
Compare @package.json @tsconfig.json and explain the project setup.
```

```text
Summarize @"docs/product spec.md".
```

Attach or paste an image in pi, then ask:

```text
What is shown in this screenshot?
```

Nairi currently allows up to 10 attachments per message and up to 50 MB per attachment. Extra or oversized attachments are omitted and a notice is appended to the prompt.

### Receive attachments

If the Nairi agent returns files, its assistant message includes `attachment_ids`. The provider downloads those attachments with `GET /api/public/v1/attachments/{id}`, stores them under `/tmp/nairi`, and appends a small attachment section to the pi response.

Example output in pi:

```text
📎 Nairi attachments:
- report.pdf saved to `/tmp/nairi/report.pdf`
```

### Reset the remote conversation

The extension keeps a Nairi conversation per pi session and model. To start fresh for the active Nairi model:

```text
/nairi-reset
```

## How it works

At startup the extension calls Nairi's [list agents](https://nairi.ai/docs/api/agents/list) endpoint:

```http
GET /api/public/v1/agents
```

For each returned agent, it registers a pi model under the `nairi` provider.

Files are uploaded using Nairi's [attachments API](https://nairi.ai/docs/api/attachments), then for the first prompt in a pi session/model pair it calls Nairi's [start conversation](https://nairi.ai/docs/api/conversations/start) endpoint:

```http
POST /api/public/v1/conversations/start
```

For follow-up prompts, it calls Nairi's [continue conversation](https://nairi.ai/docs/api/conversations/continue) endpoint:

```http
POST /api/public/v1/conversations/{job_id}/continue
```

If Nairi returns attachment IDs on assistant messages, it downloads them using Nairi's [get attachment](https://nairi.ai/docs/api/attachments/get) endpoint and appends local file paths to the pi response.

It polls the current user message with Nairi's [message status endpoint](https://nairi.ai/docs/api/conversations/message-reference):

```http
GET /api/public/v1/messages/{message_id}
```

and fetches conversation messages with Nairi's [list messages](https://nairi.ai/docs/api/conversations/list-messages) endpoint:

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

## License

MIT

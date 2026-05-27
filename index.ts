import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
} from "@earendil-works/pi-ai";

const PROVIDER = "nairi";
const API: Api = "nairi-conversations";
const DEFAULT_ROOT = "https://api.nairi.ai";
const API_PREFIX = "/api/public/v1";
const STATE_TYPE = "nairi-provider-state";
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 16_384;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const API_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILE_ATTACHMENT_BYTES = API_MAX_ATTACHMENT_BYTES;
const DOWNLOAD_ROOT = join("/tmp", "nairi");

interface NairiAgent {
	id: string;
	name: string;
	agent_id: string;
	instances_count?: number;
	description?: string | null;
}

interface NairiTurnResponse {
	job_id: string;
	message_id: string;
}

interface NairiMessage {
	id: string;
	job_id: string;
	content: string;
	role: string;
	status: string;
	attachment_ids?: string[];
	created_at?: string;
	updated_at?: string;
}

interface NairiProviderState {
	agentId: string;
	jobId: string;
	updatedAt: string;
}

interface TurnStart {
	jobId: string;
	messageId: string;
}

interface NairiUserInput {
	prompt: string;
	attachments: NairiAttachmentUpload[];
	notices: string[];
}

interface NairiAttachmentUpload {
	filename: string;
	bytes: Uint8Array;
	mimeType?: string;
	source: string;
}

interface NairiAttachmentDownload {
	id: string;
	filename: string;
	data: string;
}

interface DownloadedAttachment {
	id: string;
	filename: string;
	path?: string;
	error?: string;
}

interface ProgressState {
	seenProgressSignatures: Set<string>;
	answerText: string;
	showedProgressHeader: boolean;
	showedResponseHeader: boolean;
	queuedTextVisible: boolean;
	queuedTextIndex?: number;
	lastMessageStatus?: string;
}

let currentSessionKey = `ephemeral:${Date.now()}`;
let currentCwd = process.cwd();
let startupWarning: string | undefined;
const jobsBySessionAgent = new Map<string, string>();

export default async function (pi: ExtensionAPI) {
	const models = await discoverModels();

	pi.registerProvider(PROVIDER, {
		name: "Nairi",
		baseUrl: normalizeBaseUrl(),
		apiKey: "NAIRI_API_KEY",
		api: API,
		models,
		streamSimple: streamNairi,
	});

	pi.on("session_start", async (_event, ctx) => {
		currentSessionKey = ctx.sessionManager.getSessionFile() ?? `ephemeral:${Date.now()}`;
		currentCwd = ctx.cwd;
		restoreSessionState(ctx.sessionManager.getBranch());

		if (startupWarning) {
			ctx.ui.notify(startupWarning, "warning");
		}
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== PROVIDER) {
			return;
		}

		ctx.ui.notify("Nairi provider does not support pi session forks. Start a new session instead.", "error");
		return { cancel: true };
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		const model = ctx.model;
		if (!model || model.provider !== PROVIDER) {
			return;
		}

		ctx.ui.notify("Nairi provider does not support pi session tree navigation. Start a new session instead.", "error");
		return { cancel: true };
	});

	pi.registerCommand("nairi-reset", {
		description: "Start a fresh Nairi conversation for the active Nairi model in this pi session",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model || model.provider !== PROVIDER) {
				ctx.ui.notify("Current model is not a Nairi model.", "warning");
				return;
			}

			jobsBySessionAgent.delete(jobKey(currentSessionKey, model.id));
			ctx.ui.notify(`Reset Nairi conversation for ${model.id}.`, "info");
		},
	});

	function streamNairi(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();

		void (async () => {
			const output = createEmptyAssistantMessage(model);
			let textIndex: number | undefined;

			try {
				stream.push({ type: "start", partial: output });

				if (model.id === "configure-api-key") {
					throw new Error("Set NAIRI_API_KEY and run /reload so the Nairi extension can list agents.");
				}

				const input = await latestUserInput(context.messages);
				const apiKey = resolveApiKey(options);
				const turn = await sendTurn(model.id, input, apiKey, options?.signal);
				pi.appendEntry<NairiProviderState>(STATE_TYPE, {
					agentId: model.id,
					jobId: turn.jobId,
					updatedAt: new Date().toISOString(),
				});

				const progressState = createProgressState();
				const finalMessages = await waitForTurn(turn, apiKey, options?.signal, (delta) => {
					textIndex = appendText(stream, output, textIndex, delta);
				}, progressState, stream, output);

				const finalText = assistantTextAfter(finalMessages, turn.messageId);
				const missingText = missingFinalText(progressState.answerText, finalText);
				if (missingText) {
					textIndex = appendText(stream, output, textIndex, answerDeltaWithHeader(missingText, progressState));
				}

				const downloadedAttachments = await downloadResponseAttachments(finalMessages, turn, apiKey, options?.signal);
				const attachmentText = formatDownloadedAttachments(downloadedAttachments);
				if (attachmentText) {
					textIndex = appendText(stream, output, textIndex, attachmentText);
				}

				finishTextBlock(stream, output, textIndex);
				removeEmptyTextBlocks(output);
				stream.push({ type: "done", reason: "stop", message: output });
				stream.end();
			} catch (error) {
				clearNairiStatus();
				removeEmptyTextBlocks(output);
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = errorMessage(error);
				const reason: "aborted" | "error" = output.stopReason === "aborted" ? "aborted" : "error";
				stream.push({ type: "error", reason, error: output });
				stream.end();
			}
		})();

		return stream;
	}
}

async function discoverModels(): Promise<ProviderModelConfig[]> {
	try {
		const apiKey = resolveApiKey();
		const agents = await listAgents(apiKey);
		startupWarning = undefined;
		if (agents.length > 0) {
			return agents.map(agentToModel);
		}

		startupWarning = "Nairi extension loaded, but no Nairi agents were returned.";
		return [placeholderModel("No Nairi agents found")];
	} catch (error) {
		startupWarning = `Nairi extension loaded without agent list: ${errorMessage(error)}`;
		return [placeholderModel("Nairi unavailable: set NAIRI_API_KEY and /reload")];
	}
}

function agentToModel(agent: NairiAgent): ProviderModelConfig {
	return {
		id: agent.agent_id,
		name: `Nairi: ${agent.name}`,
		api: API,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

function placeholderModel(name: string): ProviderModelConfig {
	return {
		id: "configure-api-key",
		name,
		api: API,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	};
}

function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function sendTurn(agentId: string, input: NairiUserInput, apiKey: string, signal?: AbortSignal): Promise<TurnStart> {
	const attachmentIds = await uploadAttachments(input.attachments, apiKey, signal);
	const prompt = promptWithNotices(input.prompt, input.notices);
	const key = jobKey(currentSessionKey, agentId);
	const existingJobId = jobsBySessionAgent.get(key);
	if (existingJobId) {
		const continued = await continueConversation(existingJobId, prompt, attachmentIds, apiKey, signal);
		const jobId = continued.job_id || existingJobId;
		jobsBySessionAgent.set(key, jobId);
		return { jobId, messageId: continued.message_id };
	}

	const started = await startConversation(agentId, prompt, attachmentIds, apiKey, signal);
	jobsBySessionAgent.set(key, started.job_id);
	return { jobId: started.job_id, messageId: started.message_id };
}

async function waitForTurn(
	turn: TurnStart,
	apiKey: string,
	signal: AbortSignal | undefined,
	onTextDelta: (delta: string) => void,
	progressState: ProgressState,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): Promise<NairiMessage[]> {
	while (true) {
		throwIfAborted(signal);
		const status = await getMessage(turn.messageId, apiKey, signal);
		updateNairiStatus(status.status, progressState, stream, output);

		const messages = await listMessages(turn.jobId, apiKey, signal);
		emitProgressMessages(messages, turn.messageId, progressState, onTextDelta);

		if (hasCompletedAssistantAfter(messages, turn.messageId)) {
			clearNairiStatus(progressState, stream, output);
			return messages;
		}

		if (status.status === "completed") {
			clearNairiStatus(progressState, stream, output);
			return messages;
		}

		if (status.status === "failed") {
			clearNairiStatus(progressState, stream, output);
			throw new Error(systemErrorText(messages) ?? `Nairi message ${turn.messageId} failed.`);
		}

		await sleep(POLL_INTERVAL_MS, signal);
	}
}

function createProgressState(): ProgressState {
	return {
		seenProgressSignatures: new Set<string>(),
		answerText: "",
		showedProgressHeader: false,
		showedResponseHeader: false,
		queuedTextVisible: false,
	};
}

function updateNairiStatus(
	status: string,
	progressState: ProgressState,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): void {
	if (progressState.lastMessageStatus === status) {
		return;
	}

	progressState.lastMessageStatus = status;
	if (status === "queued") {
		showNairiQueuedStatus(progressState, stream, output);
		return;
	}

	clearNairiStatus(progressState, stream, output);
}

function showNairiQueuedStatus(
	progressState: ProgressState,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): void {
	if (progressState.queuedTextVisible) {
		return;
	}

	let index = progressState.queuedTextIndex;
	if (index === undefined) {
		output.content.push({ type: "text", text: "" });
		index = output.content.length - 1;
		progressState.queuedTextIndex = index;
		stream.push({ type: "text_start", contentIndex: index, partial: output });
	}

	const block = output.content[index];
	if (block?.type !== "text") {
		return;
	}

	const text = "⏳ Nairi queued: waiting for an available agent\n";
	block.text = text;
	progressState.queuedTextVisible = true;
	stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
}

function clearNairiStatus(
	progressState?: ProgressState,
	stream?: AssistantMessageEventStream,
	output?: AssistantMessage,
): void {
	if (!progressState?.queuedTextVisible || !stream || !output) {
		return;
	}

	const index = progressState.queuedTextIndex;
	if (index === undefined) {
		return;
	}

	const block = output.content[index];
	if (block?.type !== "text") {
		return;
	}

	block.text = "";
	progressState.queuedTextVisible = false;
	stream.push({ type: "text_delta", contentIndex: index, delta: "", partial: output });
}

function progressFormattedDelta(formatted: string, progressState: ProgressState): string {
	if (progressState.showedProgressHeader) {
		return `\n${formatted}\n`;
	}

	progressState.showedProgressHeader = true;
	return `\n\n${formatted}\n`;
}

function emitProgressMessages(
	messages: NairiMessage[],
	userMessageId: string,
	progressState: ProgressState,
	onTextDelta: (delta: string) => void,
): void {
	const startIndex = messages.findIndex((message) => message.id === userMessageId);
	const relevant = startIndex >= 0 ? messages.slice(startIndex + 1) : messages;
	for (const message of relevant) {
		if (message.role !== "progress") {
			continue;
		}

		const signature = progressSignature(message);
		if (progressState.seenProgressSignatures.has(signature)) {
			continue;
		}

		progressState.seenProgressSignatures.add(signature);
		const data = parseJson(message.content);
		const delta = progressDelta(data, message.content, progressState);
		if (!delta) {
			continue;
		}

		onTextDelta(delta);
	}
}

function progressSignature(message: NairiMessage): string {
	return [message.id, message.content].join("\u0000");
}

function progressDelta(data: unknown, rawContent: string, progressState: ProgressState): string {
	if (isRecord(data) && data.progress_type === "text" && typeof data.text_delta === "string" && data.text_delta) {
		return answerDeltaWithHeader(data.text_delta, progressState);
	}

	const formatted = formatProgressMessage(data, rawContent);
	if (!formatted) {
		return "";
	}

	return progressFormattedDelta(formatted, progressState);
}

function answerDeltaWithHeader(delta: string, progressState: ProgressState): string {
	progressState.answerText += delta;
	if (!progressState.showedProgressHeader) {
		return delta;
	}

	if (progressState.showedResponseHeader) {
		return delta;
	}

	progressState.showedResponseHeader = true;
	return `\n\n${delta}`;
}

function formatProgressMessage(data: unknown, rawContent: string): string {
	if (!isRecord(data)) {
		return quoteProgressLine(`• ${truncateText(singleLine(rawContent), 220)}`);
	}

	const progressType = stringField(data, "progress_type") ?? "progress";
	if (progressType === "text") {
		return "";
	}

	if (progressType === "tool_use" || progressType === "tool_heartbeat") {
		return formatToolProgress(data, progressType);
	}

	if (progressType === "step") {
		return quoteProgressLine(`step: ${progressSummary(data, "step")}`);
	}

	if (progressType === "subagent") {
		return quoteProgressLine(`subagent: ${progressSummary(data, "subagent")}`);
	}

	if (progressType === "thinking") {
		return quoteProgressLine(`thinking: ${progressSummary(data, "thinking")}`);
	}

	return quoteProgressLine(`${progressType}: ${truncateText(singleLine(JSON.stringify(data)), 220)}`);
}

function formatToolProgress(data: Record<string, unknown>, progressType: string): string {
	const toolName = stringField(data, "tool_name") ?? "tool";
	const toolStatus = stringField(data, "tool_status");
	const summary = stringField(data, "summary");
	const statusSuffix = toolStatus ? ` ${inlineCode(toolStatus)}` : "";
	const heartbeatSuffix = progressType === "tool_heartbeat" ? " heartbeat" : "";
	const lines = [`${escapeMarkdown(toolName)}${heartbeatSuffix}${statusSuffix}${summary ? ` — ${escapeMarkdown(summary)}` : ""}`];
	const toolInput = stringField(data, "tool_input");
	if (toolInput) {
		lines.push(escapeMarkdown(truncateText(singleLine(toolInput), 180)));
	}

	const toolOutput = stringField(data, "tool_output");
	if (toolOutput) {
		lines.push(`  → ${escapeMarkdown(truncateText(singleLine(toolOutput), 220))}`);
	}

	return quoteProgressLines(lines);
}

function progressSummary(data: Record<string, unknown>, fallback: string): string {
	const summary = stringField(data, "summary");
	if (summary) {
		return escapeMarkdown(truncateText(singleLine(summary), 220));
	}

	const textDelta = stringField(data, "text_delta");
	if (textDelta) {
		return escapeMarkdown(truncateText(singleLine(textDelta), 220));
	}

	return fallback;
}

function quoteProgressLine(line: string): string {
	return quoteProgressLines([line]);
}

function quoteProgressLines(lines: string[]): string {
	return lines.map((line) => `> ${line}`).join("\n");
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	if (typeof value === "string" && value) {
		return value;
	}

	return undefined;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}

	return `${text.slice(0, maxLength - 1)}…`;
}

function inlineCode(text: string): string {
	return `\`${text.replace(/`/g, "'")}\``;
}

function escapeMarkdown(text: string): string {
	return text.replace(/([\\*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function appendText(
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	textIndex: number | undefined,
	delta: string,
): number {
	let index = textIndex;
	if (index === undefined) {
		output.content.push({ type: "text", text: "" });
		index = output.content.length - 1;
		stream.push({ type: "text_start", contentIndex: index, partial: output });
	}

	const block = output.content[index];
	if (block?.type !== "text") {
		return index;
	}

	block.text += delta;
	stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
	return index;
}

function finishTextBlock(stream: AssistantMessageEventStream, output: AssistantMessage, textIndex: number | undefined): void {
	if (textIndex === undefined) {
		return;
	}

	const block = output.content[textIndex];
	if (block?.type !== "text") {
		return;
	}

	stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
}

function textBlockText(output: AssistantMessage, textIndex: number | undefined): string {
	if (textIndex === undefined) {
		return "";
	}

	const block = output.content[textIndex];
	if (block?.type !== "text") {
		return "";
	}

	return block.text;
}

function removeEmptyTextBlocks(output: AssistantMessage): void {
	output.content = output.content.filter((block) => block.type !== "text" || block.text.length > 0);
}

function missingFinalText(currentText: string, finalText: string): string {
	if (!finalText) {
		return "";
	}

	if (!currentText) {
		return finalText;
	}

	if (finalText.startsWith(currentText)) {
		return finalText.slice(currentText.length);
	}

	if (currentText.includes(finalText)) {
		return "";
	}

	return `\n\n${finalText}`;
}

async function listAgents(apiKey: string): Promise<NairiAgent[]> {
	const data = await apiRequest("GET", "/agents", undefined, apiKey);
	if (!Array.isArray(data)) {
		throw new Error("Unexpected Nairi /agents response.");
	}

	const agents: NairiAgent[] = [];
	for (const item of data) {
		if (isNairiAgent(item)) {
			agents.push(item);
		}
	}
	return agents;
}

async function startConversation(
	agentId: string,
	prompt: string,
	attachmentIds: string[],
	apiKey: string,
	signal?: AbortSignal,
): Promise<NairiTurnResponse> {
	const data = await apiRequest(
		"POST",
		"/conversations/start",
		conversationRequestBody({ agent_id: agentId, prompt, ask_mode: false }, attachmentIds),
		apiKey,
		signal,
	);
	return requireTurnResponse(data, "start");
}

async function continueConversation(
	jobId: string,
	prompt: string,
	attachmentIds: string[],
	apiKey: string,
	signal?: AbortSignal,
): Promise<NairiTurnResponse> {
	const encodedJobId = encodeURIComponent(jobId);
	const data = await apiRequest(
		"POST",
		`/conversations/${encodedJobId}/continue`,
		conversationRequestBody({ prompt }, attachmentIds),
		apiKey,
		signal,
	);
	return requireTurnResponse(data, "continue");
}

async function getMessage(messageId: string, apiKey: string, signal?: AbortSignal): Promise<NairiMessage> {
	const encodedMessageId = encodeURIComponent(messageId);
	const data = await apiRequest("GET", `/messages/${encodedMessageId}`, undefined, apiKey, signal);
	if (isNairiMessage(data)) {
		return data;
	}

	throw new Error("Unexpected Nairi message response.");
}

async function getAttachment(attachmentId: string, apiKey: string, signal?: AbortSignal): Promise<NairiAttachmentDownload> {
	const encodedAttachmentId = encodeURIComponent(attachmentId);
	const data = await apiRequest("GET", `/attachments/${encodedAttachmentId}`, undefined, apiKey, signal);
	return requireAttachmentDownload(data);
}

async function downloadResponseAttachments(
	messages: NairiMessage[],
	turn: TurnStart,
	apiKey: string,
	signal?: AbortSignal,
): Promise<DownloadedAttachment[]> {
	const references = responseAttachmentReferences(messages, turn.messageId);
	const downloads: DownloadedAttachment[] = [];
	for (const reference of references) {
		downloads.push(await downloadResponseAttachment(reference.attachmentId, turn.jobId, reference.messageId, apiKey, signal));
	}

	return downloads;
}

interface ResponseAttachmentReference {
	messageId: string;
	attachmentId: string;
}

function responseAttachmentReferences(messages: NairiMessage[], userMessageId: string): ResponseAttachmentReference[] {
	const references: ResponseAttachmentReference[] = [];
	const seen = new Set<string>();
	for (const message of messagesAfter(messages, userMessageId)) {
		if (message.role !== "assistant" && message.role !== "system") {
			continue;
		}

		for (const attachmentId of message.attachment_ids ?? []) {
			if (seen.has(attachmentId)) {
				continue;
			}

			seen.add(attachmentId);
			references.push({ messageId: message.id, attachmentId });
		}
	}

	return references;
}

async function downloadResponseAttachment(
	attachmentId: string,
	jobId: string,
	messageId: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<DownloadedAttachment> {
	try {
		const attachment = await getAttachment(attachmentId, apiKey, signal);
		const filename = safeFilename(attachment.filename || `${attachment.id}.bin`);
		const directory = DOWNLOAD_ROOT;
		await mkdir(directory, { recursive: true });
		const path = join(directory, filename);
		await writeFile(path, Buffer.from(attachment.data, "base64"));
		return { id: attachment.id, filename, path };
	} catch (error) {
		return { id: attachmentId, filename: attachmentId, error: errorMessage(error) };
	}
}

function formatDownloadedAttachments(attachments: DownloadedAttachment[]): string {
	if (attachments.length === 0) {
		return "";
	}

	const lines = ["", "", "📎 Nairi attachments:"];
	for (const attachment of attachments) {
		if (attachment.path) {
			lines.push(`- ${escapeMarkdown(attachment.filename)} saved to \`${attachment.path}\``);
			continue;
		}

		lines.push(`- ${escapeMarkdown(attachment.filename)} failed to download: ${escapeMarkdown(attachment.error ?? "unknown error")}`);
	}

	return lines.join("\n");
}

function safeFilename(filename: string): string {
	const base = basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
	if (base && base !== "." && base !== "..") {
		return base;
	}

	return "attachment.bin";
}

function requireAttachmentDownload(data: unknown): NairiAttachmentDownload {
	if (!isRecord(data)) {
		throw new Error("Unexpected Nairi attachment response.");
	}

	const id = data.id;
	const filename = data.filename;
	const attachmentData = data.data;
	if (typeof id === "string" && typeof filename === "string" && typeof attachmentData === "string") {
		return { id, filename, data: attachmentData };
	}

	throw new Error("Unexpected Nairi attachment response.");
}

async function listMessages(jobId: string, apiKey: string, signal?: AbortSignal): Promise<NairiMessage[]> {
	const encodedJobId = encodeURIComponent(jobId);
	const data = await apiRequest("GET", `/conversations/${encodedJobId}/messages`, undefined, apiKey, signal);
	if (!isRecord(data)) {
		throw new Error("Unexpected Nairi messages response.");
	}

	const rawMessages = data.messages;
	if (!Array.isArray(rawMessages)) {
		throw new Error("Unexpected Nairi messages response.");
	}

	const messages: NairiMessage[] = [];
	for (const item of rawMessages) {
		if (isNairiMessage(item)) {
			messages.push(item);
		}
	}
	return messages;
}

function conversationRequestBody(body: Record<string, unknown>, attachmentIds: string[]): Record<string, unknown> {
	if (attachmentIds.length === 0) {
		return body;
	}

	return { ...body, attachment_ids: attachmentIds };
}

async function uploadAttachments(
	attachments: NairiAttachmentUpload[],
	apiKey: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const attachmentIds: string[] = [];
	for (const attachment of attachments) {
		attachmentIds.push(await uploadAttachment(attachment, apiKey, signal));
	}

	return attachmentIds;
}

async function uploadAttachment(attachment: NairiAttachmentUpload, apiKey: string, signal?: AbortSignal): Promise<string> {
	const form = new FormData();
	form.append("file", new Blob([arrayBufferFromBytes(attachment.bytes)], { type: attachment.mimeType }), attachment.filename);
	const response = await fetch(`${normalizeBaseUrl()}/attachments`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal,
	});
	const text = await response.text();
	const data = parseJson(text);
	if (response.ok) {
		return requireAttachmentUploadResponse(data);
	}

	throw new Error(`Attachment upload failed for ${attachment.source}: HTTP ${response.status}: ${extractApiError(data)}`);
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function requireAttachmentUploadResponse(data: unknown): string {
	if (isRecord(data) && typeof data.attachment_id === "string") {
		return data.attachment_id;
	}

	throw new Error("Unexpected Nairi attachment upload response.");
}

async function apiRequest(
	method: "GET" | "POST",
	path: string,
	body: Record<string, unknown> | undefined,
	apiKey: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	let requestBody: string | undefined;
	if (body) {
		headers["Content-Type"] = "application/json";
		requestBody = JSON.stringify(body);
	}

	const response = await fetch(`${normalizeBaseUrl()}${path}`, {
		method,
		headers,
		body: requestBody,
		signal,
	});
	const text = await response.text();
	const data = parseJson(text);
	if (response.ok) {
		return data;
	}

	throw new Error(`HTTP ${response.status}: ${extractApiError(data)}`);
}

function requireTurnResponse(data: unknown, label: string): NairiTurnResponse {
	if (!isRecord(data)) {
		throw new Error(`Unexpected Nairi ${label} response.`);
	}

	const jobId = data.job_id;
	const messageId = data.message_id;
	if (typeof jobId === "string" && typeof messageId === "string") {
		return { job_id: jobId, message_id: messageId };
	}

	throw new Error(`Unexpected Nairi ${label} response.`);
}

async function latestUserInput(messages: Message[]): Promise<NairiUserInput> {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user") {
			return contentToUserInput(message.content);
		}
	}

	throw new Error("No user prompt found in pi context.");
}

async function contentToUserInput(content: string | (TextContent | ImageContent)[]): Promise<NairiUserInput> {
	const input = typeof content === "string" ? emptyUserInput(content) : userInputFromParts(content);
	const fileAttachments = await fileReferenceAttachments(input.prompt);
	return enforceAttachmentLimit({
		prompt: input.prompt,
		attachments: [...input.attachments, ...fileAttachments.attachments],
		notices: [...input.notices, ...fileAttachments.notices],
	});
}

function emptyUserInput(prompt: string): NairiUserInput {
	return { prompt, attachments: [], notices: [] };
}

function userInputFromParts(content: (TextContent | ImageContent)[]): NairiUserInput {
	const parts: string[] = [];
	const attachments: NairiAttachmentUpload[] = [];
	let imageIndex = 1;
	for (const item of content) {
		if (item.type === "text") {
			parts.push(item.text);
			continue;
		}

		const attachment = imageAttachment(item, imageIndex);
		attachments.push(attachment);
		parts.push(`[image attached: ${attachment.filename}]`);
		imageIndex += 1;
	}

	return { prompt: parts.join("\n").trim(), attachments, notices: [] };
}

function imageAttachment(image: ImageContent, index: number): NairiAttachmentUpload {
	const mimeType = image.mimeType || "application/octet-stream";
	return {
		filename: `pi-image-${index}.${extensionForMimeType(mimeType)}`,
		bytes: decodeBase64Image(image.data),
		mimeType,
		source: `image ${index}`,
	};
}

function decodeBase64Image(data: string): Uint8Array {
	const marker = ";base64,";
	const markerIndex = data.indexOf(marker);
	const encoded = markerIndex >= 0 ? data.slice(markerIndex + marker.length) : data;
	return new Uint8Array(Buffer.from(encoded, "base64"));
}

function extensionForMimeType(mimeType: string): string {
	if (mimeType === "image/png") {
		return "png";
	}

	if (mimeType === "image/jpeg") {
		return "jpg";
	}

	if (mimeType === "image/webp") {
		return "webp";
	}

	if (mimeType === "image/gif") {
		return "gif";
	}

	return "bin";
}

interface FileReferenceAttachments {
	attachments: NairiAttachmentUpload[];
	notices: string[];
}

async function fileReferenceAttachments(prompt: string): Promise<FileReferenceAttachments> {
	const references = findFileReferences(prompt);
	if (references.length === 0) {
		return { attachments: [], notices: [] };
	}

	const attachments: NairiAttachmentUpload[] = [];
	const notices: string[] = [];
	const seenPaths = new Set<string>();
	for (const reference of references) {
		const absolutePath = resolveReferencePath(reference);
		if (seenPaths.has(absolutePath)) {
			continue;
		}

		seenPaths.add(absolutePath);
		const attachment = await fileReferenceAttachment(reference, absolutePath);
		if (attachment.attachment) {
			attachments.push(attachment.attachment);
		}

		if (attachment.notice) {
			notices.push(attachment.notice);
		}
	}

	return { attachments, notices };
}

interface FileReferenceAttachmentResult {
	attachment?: NairiAttachmentUpload;
	notice?: string;
}

async function fileReferenceAttachment(reference: string, absolutePath: string): Promise<FileReferenceAttachmentResult> {
	try {
		const metadata = await stat(absolutePath);
		if (!metadata.isFile()) {
			return {};
		}

		const maxBytes = maxFileAttachmentBytes();
		if (metadata.size > maxBytes) {
			return { notice: attachmentNotice(reference, absolutePath, `omitted: file is ${metadata.size} bytes, max is ${maxBytes}`) };
		}

		const content = await readFile(absolutePath);
		return {
			attachment: {
				filename: basename(absolutePath),
				bytes: new Uint8Array(content),
				source: reference,
			},
		};
	} catch {
		return {};
	}
}

function enforceAttachmentLimit(input: NairiUserInput): NairiUserInput {
	const maxBytes = maxFileAttachmentBytes();
	const attachments: NairiAttachmentUpload[] = [];
	const notices = [...input.notices];
	for (const attachment of input.attachments) {
		if (attachment.bytes.byteLength > maxBytes) {
			notices.push(`Attachment omitted: ${attachment.source} (${attachment.filename}); file is ${attachment.bytes.byteLength} bytes, max is ${maxBytes}.`);
			continue;
		}

		if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
			notices.push(`Attachment omitted: ${attachment.source} (${attachment.filename}); Nairi allows max ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`);
			continue;
		}

		attachments.push(attachment);
	}

	return { prompt: input.prompt, attachments, notices };
}

function promptWithNotices(prompt: string, notices: string[]): string {
	if (notices.length === 0) {
		return prompt;
	}

	return `${prompt}\n\n${notices.map((notice) => `[${notice}]`).join("\n")}`;
}

function findFileReferences(prompt: string): string[] {
	const references: string[] = [];
	const regex = /(^|\s)@(?:"([^"]+)"|'([^']+)'|(\S+))/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(prompt)) !== null) {
		const rawPath = match[2] ?? match[3] ?? match[4];
		if (!rawPath) {
			continue;
		}

		const filePath = trimTrailingPunctuation(rawPath);
		if (filePath) {
			references.push(filePath);
		}
	}

	return references;
}

function trimTrailingPunctuation(value: string): string {
	return value.replace(/[),.;:!?]+$/g, "");
}

function resolveReferencePath(reference: string): string {
	const expanded = expandHome(reference);
	if (isAbsolute(expanded)) {
		return expanded;
	}

	return resolve(currentCwd, expanded);
}

function expandHome(filePath: string): string {
	if (filePath === "~") {
		return process.env.HOME ?? filePath;
	}

	if (filePath.startsWith("~/")) {
		const home = process.env.HOME;
		if (home) {
			return `${home}${filePath.slice(1)}`;
		}
	}

	return filePath;
}

function maxFileAttachmentBytes(): number {
	const raw = process.env.NAIRI_MAX_FILE_ATTACHMENT_BYTES;
	if (!raw) {
		return DEFAULT_MAX_FILE_ATTACHMENT_BYTES;
	}

	const parsed = Number.parseInt(raw, 10);
	if (Number.isFinite(parsed) && parsed > 0) {
		return Math.min(parsed, API_MAX_ATTACHMENT_BYTES);
	}

	return DEFAULT_MAX_FILE_ATTACHMENT_BYTES;
}

function attachmentNotice(reference: string, absolutePath: string, reason: string): string {
	return `Attachment ${reference} (${absolutePath}) ${reason}.`;
}

function assistantTextAfter(messages: NairiMessage[], userMessageId: string): string {
	const relevant = messagesAfter(messages, userMessageId);
	const parts: string[] = [];
	for (const message of relevant) {
		if (message.role === "assistant" && message.content) {
			parts.push(message.content);
			continue;
		}

		if (message.role === "system" && message.content) {
			parts.push(message.content);
		}
	}
	return parts.join("\n\n").trim();
}

function hasCompletedAssistantAfter(messages: NairiMessage[], userMessageId: string): boolean {
	const relevant = messagesAfter(messages, userMessageId);
	return relevant.some((message) => message.role === "assistant" && message.status === "completed" && message.content.length > 0);
}

function messagesAfter(messages: NairiMessage[], messageId: string): NairiMessage[] {
	const startIndex = messages.findIndex((message) => message.id === messageId);
	if (startIndex < 0) {
		return messages;
	}

	return messages.slice(startIndex + 1);
}

function systemErrorText(messages: NairiMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "system" && message.content) {
			return message.content;
		}
	}

	return undefined;
}

function restoreSessionState(entries: readonly unknown[]): void {
	for (const entry of entries) {
		if (!isRecord(entry)) {
			continue;
		}

		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) {
			continue;
		}

		const data = entry.data;
		if (!isProviderState(data)) {
			continue;
		}

		jobsBySessionAgent.set(jobKey(currentSessionKey, data.agentId), data.jobId);
	}
}

function isProviderState(value: unknown): value is NairiProviderState {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.agentId === "string" && typeof value.jobId === "string" && typeof value.updatedAt === "string";
}

function jobKey(sessionKey: string, agentId: string): string {
	return `${sessionKey}\u0000${agentId}`;
}

function resolveApiKey(options?: SimpleStreamOptions): string {
	const fromOptions = options?.apiKey;
	if (fromOptions && fromOptions !== "NAIRI_API_KEY") {
		return fromOptions;
	}

	const fromEnv = process.env.NAIRI_API_KEY;
	if (fromEnv) {
		return fromEnv;
	}

	if (fromOptions) {
		return fromOptions;
	}

	throw new Error("NAIRI_API_KEY is not set.");
}

function normalizeBaseUrl(): string {
	const raw = (process.env.NAIRI_BASE_URL ?? DEFAULT_ROOT).replace(/\/+$/, "");
	if (raw.endsWith(API_PREFIX)) {
		return raw;
	}

	return `${raw}${API_PREFIX}`;
}

function parseJson(text: string): unknown {
	if (!text) {
		return undefined;
	}

	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

function extractApiError(data: unknown): string {
	if (isRecord(data) && typeof data.error === "string") {
		return data.error;
	}

	if (typeof data === "string" && data) {
		return data;
	}

	return "request failed";
}

function isNairiAgent(value: unknown): value is NairiAgent {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.id === "string" && typeof value.name === "string" && typeof value.agent_id === "string";
}

function isNairiMessage(value: unknown): value is NairiMessage {
	if (!isRecord(value)) {
		return false;
	}

	return (
		typeof value.id === "string" &&
		typeof value.job_id === "string" &&
		typeof value.content === "string" &&
		typeof value.role === "string" &&
		typeof value.status === "string" &&
		isOptionalStringArray(value.attachment_ids)
	);
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
	if (value === undefined) {
		return true;
	}

	if (!Array.isArray(value)) {
		return false;
	}

	return value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}

		let settled = false;
		const timeout = setTimeout(() => {
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		function onAbort() {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		}

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) {
		return;
	}

	throw new Error("Request was aborted");
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

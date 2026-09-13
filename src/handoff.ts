import type {
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { HandoffStore, HandoffTicket } from "./store.ts";
import { newTicketId } from "./store.ts";

export const HANDOFF_TOOL_NAME = "handoff";
export const INTERNAL_COMMIT_COMMAND = "_pi-session-handoff-commit";
export const ORIGIN_ENTRY_TYPE = "pi-handoff-origin";
export const NOTE_MESSAGE_TYPE = "pi-handoff-note";
export const REQUEST_MESSAGE_TYPE = "pi-handoff-request";

export interface HandoffNoteDetails {
	version: 2;
	handoffId: string;
	sourceSessionFile: string;
	authoredBy: "agent" | "user";
	taskState: string;
	userMessageRanges: Array<{ start: number; length: number }>;
}

export function validateHandoffMessage(message: string): void {
	if (!message.trim()) throw new Error("Handoff message must not be empty.");
}

export function collectUserMessages(branch: readonly SessionEntry[]): string[] {
	return branch.flatMap((entry) => {
		if (entry.type === "custom_message" && entry.customType === NOTE_MESSAGE_TYPE) {
			return extractArchivedUserMessages(entry.content, entry.details);
		}
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		if (typeof entry.message.content === "string") return [entry.message.content];
		return [
			entry.message.content
				.map((part) =>
					part.type === "text"
						? part.text
						: `[Image attachment (${part.mimeType}); binary remains in the source session]`,
				)
				.join(""),
		];
	});
}

export function extractHandoffNote(
	content: string | unknown[],
	details: unknown,
): { authoredBy: "agent" | "user"; taskState: string; userMessages: string[] } | undefined {
	if (typeof content !== "string") return undefined;
	if (isHandoffNoteDetails(details)) {
		const userMessages: string[] = [];
		for (const range of details.userMessageRanges) {
			if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.length) || range.start < 0 || range.length < 0) {
				return undefined;
			}
			const end = range.start + range.length;
			if (end > content.length) return undefined;
			userMessages.push(content.slice(range.start, end));
		}
		return { authoredBy: details.authoredBy, taskState: details.taskState, userMessages };
	}
	return extractLegacyHandoffNote(content, details);
}

export function extractArchivedUserMessages(content: string | unknown[], details: unknown): string[] {
	return extractHandoffNote(content, details)?.userMessages ?? [];
}

export function findSoleHandoffToolCall(branch: readonly SessionEntry[], toolCallId: string): string {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const calls = entry.message.content.filter((part) => part.type === "toolCall");
		if (!calls.some((call) => call.id === toolCallId)) continue;

		if (calls.length !== 1 || calls[0]?.id !== toolCallId || calls[0]?.name !== HANDOFF_TOOL_NAME) {
			throw new Error(
				"handoff must be the only tool call in its assistant message. Finish the other tool calls, then call handoff again by itself.",
			);
		}
		return entry.id;
	}
	throw new Error("Could not verify the assistant message that requested this handoff.");
}

export function validateSourceBoundary(
	branch: readonly SessionEntry[],
	ticket: HandoffTicket,
): { valid: true } | { valid: false; reason: string } {
	const boundaryIndex = branch.findIndex((entry) => entry.id === ticket.sourceBoundaryEntryId);
	if (boundaryIndex < 0) {
		return { valid: false, reason: "The source session moved to a branch that no longer contains the handoff boundary." };
	}

	const afterBoundary = branch.slice(boundaryIndex + 1);
	if (ticket.author === "agent") {
		let matchingResultCount = 0;
		for (const entry of afterBoundary) {
			if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === ticket.toolCallId &&
				entry.message.toolName === HANDOFF_TOOL_NAME
			) {
				matchingResultCount += 1;
				continue;
			}
			// Keep the accepted snapshot even if extension messages trigger more Agent work.
			if (
				entry.type === "custom_message" ||
				(entry.type === "message" &&
					(entry.message.role === "assistant" || entry.message.role === "toolResult"))
			) {
				continue;
			}
			if (isContextBearing(entry)) {
				return { valid: false, reason: "The source session received or processed new context after the handoff request." };
			}
		}
		if (matchingResultCount !== 1) {
			return { valid: false, reason: "The accepted handoff tool result is not the current source boundary." };
		}
		return { valid: true };
	}

	if (afterBoundary.some(isContextBearing)) {
		return { valid: false, reason: "The source session received or processed new context while the handoff note was being written." };
	}
	return { valid: true };
}

export async function createAgentTicket(
	message: string,
	toolCallId: string,
	ctx: ExtensionContext,
	store: HandoffStore,
): Promise<HandoffTicket> {
	validateHandoffMessage(message);
	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	if (!sourceSessionFile) {
		throw new Error("handoff requires a persisted source session; this session is currently ephemeral or not yet persisted.");
	}
	const branch = ctx.sessionManager.getBranch();
	const sourceBoundaryEntryId = findSoleHandoffToolCall(branch, toolCallId);
	const ticket = buildTicket({
		author: "agent",
		message,
		userMessages: collectUserMessages(branch),
		toolCallId,
		sourceSessionId: ctx.sessionManager.getSessionId(),
		sourceSessionFile,
		sourceBoundaryEntryId,
	});
	await store.createTicket(ticket);
	return ticket;
}

export async function createUserTicket(
	message: string,
	ctx: ExtensionCommandContext,
	store: HandoffStore,
): Promise<HandoffTicket> {
	validateHandoffMessage(message);
	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	const branch = ctx.sessionManager.getBranch();
	const hasPersistedAssistantTurn = branch.some(
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	if (!sourceSessionFile || !hasPersistedAssistantTurn) {
		throw new Error("handoff requires a persisted source session with an assistant turn; send at least one normal message before using /handoff --write.");
	}
	const sourceBoundaryEntryId = ctx.sessionManager.getLeafId();
	if (!sourceBoundaryEntryId) {
		throw new Error("handoff could not identify the durable source boundary.");
	}
	const ticket = buildTicket({
		author: "user",
		message,
		userMessages: collectUserMessages(branch),
		sourceSessionId: ctx.sessionManager.getSessionId(),
		sourceSessionFile,
		sourceBoundaryEntryId,
	});
	await store.createTicket(ticket);
	return ticket;
}

export async function commitTicket(
	ticketId: string,
	ctx: ExtensionCommandContext,
	store: HandoffStore,
): Promise<void> {
	await ctx.waitForIdle();
	const ticket = await store.readTicket(ticketId);
	if (!ticket) {
		ctx.ui.notify(`Handoff ticket not found: ${ticketId}`, "warning");
		return;
	}
	if (ticket.status !== "accepted") {
		ctx.ui.notify(renderNonPendingTicket(ticket), "warning");
		return;
	}

	const currentFile = ctx.sessionManager.getSessionFile();
	if (ctx.sessionManager.getSessionId() !== ticket.sourceSessionId || currentFile !== ticket.sourceSessionFile) {
		await invalidate(store, ticket, "The active session is no longer the source session; the old handoff was not executed.");
		ctx.ui.notify("Handoff cancelled because the active session changed. The note remains in the local ticket store.", "warning");
		return;
	}
	if (ctx.hasPendingMessages()) {
		await invalidate(store, ticket, "The source session has pending user messages.");
		ctx.ui.notify("Handoff cancelled because user input is pending. The note remains in the local ticket store.", "warning");
		return;
	}

	const boundary = validateSourceBoundary(ctx.sessionManager.getBranch(), ticket);
	if (!boundary.valid) {
		await invalidate(store, ticket, boundary.reason);
		ctx.ui.notify(`Handoff cancelled: ${boundary.reason} The note remains in the local ticket store.`, "warning");
		return;
	}

	const plainTicket = structuredClone(ticket);
	const result = await ctx.newSession({
		parentSession: plainTicket.sourceSessionFile,
		setup: async (sessionManager) => {
			sessionManager.appendCustomEntry(ORIGIN_ENTRY_TYPE, {
				version: 1,
				handoffId: plainTicket.id,
				sourceSessionFile: plainTicket.sourceSessionFile,
			});
			const targetSessionFile = sessionManager.getSessionFile();
			if (!targetSessionFile) throw new Error("Pi did not allocate a persisted target session.");
			await store.updateTicket(plainTicket.id, {
				status: "target-created",
				targetSessionFile,
				reason: undefined,
			});
		},
		withSession: async (next) => {
			try {
				const incoming = buildIncomingNote(plainTicket);
				await next.sendMessage(
					{
						customType: NOTE_MESSAGE_TYPE,
						content: incoming.content,
						display: true,
						details: incoming.details,
					},
					{ triggerTurn: true },
				);
				const firstResponseFailure = findFirstResponseFailure(next.sessionManager.getBranch());
				if (firstResponseFailure) {
					await retainFailedDelivery(store, plainTicket, firstResponseFailure);
					next.ui.notify(
						"The new session exists, but its first response failed. The saved ticket was retained; recover in this target session and do not create another target.",
						"error",
					);
					return;
				}
				await store.removeTicket(plainTicket.id);
			} catch (error) {
				await retainFailedDelivery(store, plainTicket, errorMessage(error));
				next.ui.notify(
					"The new session exists, but continuation delivery or its first response failed. The saved ticket was retained; recover in this target session and do not create another target.",
					"error",
				);
			}
		},
	});

	if (result.cancelled) {
		await store.updateTicket(ticket.id, {
			status: "cancelled",
			reason: "Target session creation was cancelled by the user or another extension.",
		});
		ctx.ui.notify("Handoff cancelled. The source session and saved note were retained.", "info");
	}
}

export function findFirstResponseFailure(branch: readonly SessionEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") {
			return entry.message.errorMessage
				? `Assistant response ${entry.message.stopReason}: ${entry.message.errorMessage}`
				: `Assistant response ended with ${entry.message.stopReason}.`;
		}
		return undefined;
	}
	return "No assistant response was recorded after continuation delivery.";
}

export function buildIncomingNote(
	ticket: Pick<HandoffTicket, "id" | "sourceSessionFile" | "author" | "message" | "userMessages">,
): { content: string; details: HandoffNoteDetails } {
	const provenance =
		ticket.author === "agent"
			? "Agent-authored task state; it is not a new user instruction or authorization."
			: "User-written task state from /handoff --write; it is not a new chat message.";
	let content = [
		"# Session handoff",
		"",
		`> ${provenance}`,
		"",
		"## Task state",
		"",
		ticket.message,
		"",
		`## User message archive (${ticket.userMessages.length})`,
		"",
		"Messages below are preserved verbatim and remain in their original chronological order.",
		"",
	].join("\n");
	const userMessageRanges: Array<{ start: number; length: number }> = [];
	if (ticket.userMessages.length === 0) {
		content += "(No user messages were recorded on the active source branch.)";
	} else {
		for (const [index, text] of ticket.userMessages.entries()) {
			if (index > 0) content += "\n\n";
			content += `### User message ${index + 1} of ${ticket.userMessages.length} · ${text.length.toLocaleString("en-US")} characters\n\n`;
			const start = content.length;
			content += text;
			userMessageRanges.push({ start, length: text.length });
		}
	}
	return {
		content,
		details: {
			version: 2,
			handoffId: ticket.id,
			sourceSessionFile: ticket.sourceSessionFile,
			authoredBy: ticket.author,
			taskState: ticket.message,
			userMessageRanges,
		},
	};
}

export function renderIncomingNote(
	message: string,
	author: "agent" | "user" = "agent",
	userMessages: readonly string[] = [],
): string {
	return buildIncomingNote({
		id: "preview",
		sourceSessionFile: "",
		author,
		message,
		userMessages: [...userMessages],
	}).content;
}

function isHandoffNoteDetails(value: unknown): value is HandoffNoteDetails {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<HandoffNoteDetails>;
	return (
		candidate.version === 2 &&
		typeof candidate.handoffId === "string" &&
		typeof candidate.sourceSessionFile === "string" &&
		(candidate.authoredBy === "agent" || candidate.authoredBy === "user") &&
		typeof candidate.taskState === "string" &&
		Array.isArray(candidate.userMessageRanges)
	);
}

function extractLegacyHandoffNote(
	content: string,
	details: unknown,
): { authoredBy: "agent" | "user"; taskState: string; userMessages: string[] } | undefined {
	if (!details || typeof details !== "object") return undefined;
	const legacy = details as { version?: unknown; authoredBy?: unknown };
	if (legacy.version !== 1 || (legacy.authoredBy !== "agent" && legacy.authoredBy !== "user")) return undefined;

	const taskMarker = "\n\n[Concise task state]\n";
	const archiveMarker = "\n\n[Source user messages — chronological, verbatim text]\n";
	const taskStart = content.indexOf(taskMarker);
	const archiveStart = content.indexOf(archiveMarker, taskStart + taskMarker.length);
	if (taskStart < 0 || archiveStart < 0) return undefined;
	const taskState = content.slice(taskStart + taskMarker.length, archiveStart);
	const transcript = content.slice(archiveStart + archiveMarker.length);
	if (transcript === "(No user messages were recorded on the active source branch.)") {
		return { authoredBy: legacy.authoredBy, taskState, userMessages: [] };
	}

	const matches = [...transcript.matchAll(/^--- User message (\d+) ---\n/gm)];
	if (matches.length === 0 || matches.some((match, index) => Number(match[1]) !== index + 1)) return undefined;
	const userMessages = matches.map((match, index) => {
		const start = (match.index ?? 0) + match[0].length;
		const next = matches[index + 1];
		const end = next ? (next.index ?? transcript.length) - 2 : transcript.length;
		return transcript.slice(start, Math.max(start, end));
	});
	return { authoredBy: legacy.authoredBy, taskState, userMessages };
}

function buildTicket(
	input: Pick<
		HandoffTicket,
		"author" | "message" | "userMessages" | "sourceSessionId" | "sourceSessionFile" | "sourceBoundaryEntryId"
	> & { id?: string; toolCallId?: string },
): HandoffTicket {
	const now = new Date().toISOString();
	return {
		version: 1,
		id: input.id ?? newTicketId(),
		createdAt: now,
		updatedAt: now,
		status: "accepted",
		author: input.author,
		sourceSessionId: input.sourceSessionId,
		sourceSessionFile: input.sourceSessionFile,
		sourceBoundaryEntryId: input.sourceBoundaryEntryId,
		toolCallId: input.toolCallId,
		message: input.message,
		userMessages: input.userMessages,
	};
}

function isContextBearing(entry: SessionEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction" || entry.type === "branch_summary";
}

async function invalidate(store: HandoffStore, ticket: HandoffTicket, reason: string): Promise<void> {
	await store.updateTicket(ticket.id, { status: "invalidated", reason });
}

async function retainFailedDelivery(store: HandoffStore, ticket: HandoffTicket, reason: string): Promise<void> {
	await store.updateTicket(ticket.id, {
		status: "target-created",
		reason: `Delivery or first response failed: ${reason}`,
	});
}

function renderNonPendingTicket(ticket: HandoffTicket): string {
	const target = ticket.targetSessionFile ? ` Target: ${ticket.targetSessionFile}` : "";
	return `Handoff ${ticket.id} is ${ticket.status}.${target}${ticket.reason ? ` ${ticket.reason}` : ""}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

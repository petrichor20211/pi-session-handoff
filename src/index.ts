import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatTarget,
	parseTarget,
	renderBudgetMessage,
	snapshotBudget,
	type HandoffTarget,
} from "./context.ts";
import {
	commitTicket,
	createAgentTicket,
	createUserTicket,
	HANDOFF_TOOL_NAME,
	INTERNAL_COMMIT_COMMAND,
	NOTE_MESSAGE_TYPE,
	ORIGIN_ENTRY_TYPE,
	REQUEST_MESSAGE_TYPE,
} from "./handoff.ts";
import { renderHandoffNote } from "./render.ts";
import { createStore, type HandoffStore, type HandoffTicket } from "./store.ts";

const BUDGET_MESSAGE_TYPE = "pi-handoff-context-budget";

const HANDOFF_NOTE_GUIDELINES = [
	"Write handoff.message as a concise, distilled recovery index. Include only information necessary to resume the work; Omit empty sections, repetition, and filler without sacrificing essential state.",
	`Use these headings in order:
Objective:
Completed with evidence:
In progress:
Next actions:
Important files:
Verification:
Active processes:
Active monitors:`,
];

export default async function piSessionHandoff(pi: ExtensionAPI): Promise<void> {
	const store = createStore();
	let target = (await store.loadConfig()).target;

	pi.registerMessageRenderer(NOTE_MESSAGE_TYPE, renderHandoffNote);

	pi.registerTool({
		name: HANDOFF_TOOL_NAME,
		label: "Handoff",
		description:
			"Move work to a fresh Pi session using a concise task-state note you write. The extension separately preserves every user message from the active source branch. handoff must be the only tool call in this assistant message.",
		promptSnippet: "Continue the current task in a fresh session with an Agent-authored note",
		promptGuidelines: [
			"Use handoff near the advisory context target at a clear work boundary, or earlier before context-heavy work; finish a nearly complete task instead, and do not hand off merely while waiting for the user.",
			"Call handoff as the only tool call in its assistant message, after all edits and checks for the current boundary have completed.",
			...HANDOFF_NOTE_GUIDELINES,
		],
		parameters: Type.Object(
			{
				message: Type.String({
					description: "A concise recovery note using the ordered handoff headings; omit empty sections. User messages are preserved separately.",
				}),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const ticket = await createAgentTicket(params.message, toolCallId, ctx, store);
			pi.sendUserMessage(`/${INTERNAL_COMMIT_COMMAND} ${ticket.id}`, {
				deliverAs: "followUp",
				expandPromptTemplates: true,
			});
			return {
				content: [{ type: "text", text: "Handoff accepted." }],
				details: { handoffId: ticket.id },
				terminate: true,
			};
		},
	});

	pi.registerCommand(INTERNAL_COMMIT_COMMAND, {
		description: "Internal command used to commit a saved pi-session-handoff ticket",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) return;
			try {
				await commitTicket(id, ctx, store);
			} catch (error) {
				// The source command context may already be stale if replacement partly succeeded.
				// Log locally rather than touching any session-bound object here.
				console.error(`pi-session-handoff: ${errorMessage(error)}`);
			}
		},
	});

	pi.registerCommand("handoff", {
		description: "Ask the Agent to hand off, inspect status, set target, or write the continuation note yourself",
		getArgumentCompletions: (prefix) => {
			const values = ["status", "target 35%", "target 80k", "--write"];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "status") {
				await showStatus(ctx, store, target);
				return;
			}
			if (trimmed === "target" || trimmed.startsWith("target ")) {
				const value = trimmed.slice("target".length).trim();
				if (!value) {
					ctx.ui.notify("Usage: /handoff target <35%|80k>", "warning");
					return;
				}
				try {
					const nextTarget = parseTarget(value);
					await store.saveTarget(nextTarget);
					target = nextTarget;
					ctx.ui.notify(`Handoff target set to ${formatTarget(target)}.`, "info");
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
				return;
			}
			if (trimmed === "--write" || trimmed.startsWith("--write ")) {
				await writeHandoff(trimmed.slice("--write".length).trim(), ctx, store);
				return;
			}

			const request = renderAgentHandoffRequest(trimmed);
			pi.sendMessage(
				{
					customType: REQUEST_MESSAGE_TYPE,
					content: request,
					display: true,
					details: { version: 1, focus: trimmed || undefined },
				},
				ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true },
			);
		},
	});

	pi.on("context", (event, ctx) => {
		const usage = snapshotBudget(ctx.getContextUsage(), ctx.model?.contextWindow, target);
		const continuationSession = ctx.sessionManager
			.getEntries()
			.some((entry) => entry.type === "custom" && entry.customType === ORIGIN_ENTRY_TYPE);
		return {
			messages: [
				...event.messages,
				{
					role: "custom",
					customType: BUDGET_MESSAGE_TYPE,
					content: renderBudgetMessage(usage, continuationSession),
					display: false,
					details: { ephemeral: true },
					timestamp: Date.now(),
				},
			],
		};
	});
}

async function writeHandoff(
	prefill: string,
	ctx: ExtensionCommandContext,
	store: HandoffStore,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/handoff --write requires TUI or RPC extension UI support.", "error");
		return;
	}
	await ctx.waitForIdle();
	const sourceSessionId = ctx.sessionManager.getSessionId();
	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	const sourceLeafId = ctx.sessionManager.getLeafId();
	const message = await ctx.ui.editor("Write continuation note for the next Agent", prefill);
	if (message === undefined) {
		ctx.ui.notify("Handoff cancelled.", "info");
		return;
	}
	await ctx.waitForIdle();
	if (
		ctx.hasPendingMessages() ||
		ctx.sessionManager.getSessionId() !== sourceSessionId ||
		ctx.sessionManager.getSessionFile() !== sourceSessionFile ||
		ctx.sessionManager.getLeafId() !== sourceLeafId
	) {
		ctx.ui.notify("Handoff cancelled because the source session changed while the note was being written.", "warning");
		return;
	}

	let ticket: HandoffTicket;
	try {
		ticket = await createUserTicket(message, ctx, store);
	} catch (error) {
		ctx.ui.notify(errorMessage(error), "error");
		return;
	}
	await commitTicket(ticket.id, ctx, store);
}

async function showStatus(
	ctx: ExtensionCommandContext,
	store: HandoffStore,
	target: HandoffTarget,
): Promise<void> {
	const budget = snapshotBudget(ctx.getContextUsage(), ctx.model?.contextWindow, target);
	const currentSessionId = ctx.sessionManager.getSessionId();
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	const tickets = (await store.listTickets()).filter(
		(ticket) => ticket.sourceSessionId === currentSessionId || ticket.targetSessionFile === currentSessionFile,
	);
	const lines = [renderBudgetMessage(budget, false), "", `saved_handoff_records: ${tickets.length}`];
	for (const ticket of tickets.slice(0, 5)) lines.push(formatTicket(ticket));
	if (tickets.length > 5) lines.push(`...and ${tickets.length - 5} more`);
	ctx.ui.notify(lines.join("\n"), tickets.some(isPending) ? "warning" : "info");
}

function renderAgentHandoffRequest(focus: string): string {
	return [
		"Please hand off this task at the next clear and useful work boundary by calling handoff as the only tool call in that assistant message.",
		...HANDOFF_NOTE_GUIDELINES,
		focus ? `Focus to preserve: ${focus}` : "",
	].filter(Boolean).join("\n\n");
}

function formatTicket(ticket: HandoffTicket): string {
	const target = ticket.targetSessionFile ? ` -> ${ticket.targetSessionFile}` : "";
	const reason = ticket.reason ? ` (${ticket.reason})` : "";
	return `- ${ticket.id}: ${ticket.status}${target}${reason}`;
}

function isPending(ticket: HandoffTicket): boolean {
	return ticket.status === "accepted" || ticket.status === "target-created";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}


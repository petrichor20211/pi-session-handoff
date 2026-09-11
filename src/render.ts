import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { extractHandoffNote } from "./handoff.ts";

const COLLAPSED_MESSAGE_COUNT = 6;
const PREVIEW_CHARACTERS = 120;

export function renderHandoffNote(
	message: { content: string | unknown[]; details?: unknown },
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
) {
	const note = extractHandoffNote(message.content, message.details);
	if (!note) return undefined;
	const userMessages = note.userMessages;

	const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
	const author = note.authoredBy === "agent" ? "Agent continuation" : "User-written continuation";
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`↪ ${author}`)), 0, 0));
	box.addChild(new Text(note.taskState, 0, 1));

	const totalCharacters = userMessages.reduce((sum, text) => sum + text.length, 0);
	box.addChild(
		new Text(
			theme.fg(
				"muted",
				`${userMessages.length} user message${userMessages.length === 1 ? "" : "s"} preserved verbatim · ${totalCharacters.toLocaleString("en-US")} characters`,
			),
			0,
			1,
		),
	);

	if (options.expanded) {
		for (const [index, text] of userMessages.entries()) {
			box.addChild(
				new Text(
					theme.fg("customMessageLabel", `User message ${index + 1} of ${userMessages.length} · ${text.length.toLocaleString("en-US")} characters`),
					0,
					index === 0 ? 0 : 1,
				),
			);
			box.addChild(new Text(text, 0, 0));
		}
	} else if (userMessages.length > 0) {
		let previousIndex = -1;
		for (const { text, index } of selectPreviews(userMessages)) {
			if (previousIndex >= 0 && index > previousIndex + 1) {
				box.addChild(new Text(theme.fg("dim", `… ${index - previousIndex - 1} messages omitted from compact view …`), 0, 0));
			}
			box.addChild(
				new Text(
					theme.fg("dim", `${index + 1}. ${preview(text)} (${text.length.toLocaleString("en-US")} chars)`),
					0,
					0,
				),
			);
			previousIndex = index;
		}
		box.addChild(new Text(theme.fg("dim", "Expand output to view the complete verbatim archive."), 0, 1));
	}
	return box;
}

function selectPreviews(messages: readonly string[]): Array<{ text: string; index: number }> {
	if (messages.length <= COLLAPSED_MESSAGE_COUNT) {
		return messages.map((text, index) => ({ text, index }));
	}
	const headCount = 2;
	const tailCount = COLLAPSED_MESSAGE_COUNT - headCount;
	return [
		...messages.slice(0, headCount).map((text, index) => ({ text, index })),
		...messages.slice(-tailCount).map((text, offset) => ({
			text,
			index: messages.length - tailCount + offset,
		})),
	];
}

function preview(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	const characters = Array.from(singleLine);
	return characters.length <= PREVIEW_CHARACTERS
		? singleLine || "(empty message)"
		: `${characters.slice(0, PREVIEW_CHARACTERS).join("")}…`;
}

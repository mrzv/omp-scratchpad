import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Box, getMarkdownTheme, lexDocument, Markdown, theme as activeTheme, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { Token } from "@oh-my-pi/pi-utils/marked";

const ENTRY_TYPE = "omp-scratchpad.state.v1";
const WIDGET_KEY = "omp-scratchpad.preview";
const USAGE = "Usage: /scratchpad [edit | preview | paste]";

type Scratchpad = { text: string; preview: boolean };

function readScratchpad(ctx: ExtensionContext): Scratchpad {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data;
		if (
			typeof data === "object" && data !== null &&
			"text" in data && typeof data.text === "string" &&
			"preview" in data && typeof data.preview === "boolean"
		) {
			return { text: data.text, preview: data.preview };
		}
	}
	return { text: "", preview: false };
}

function previewTaskMarkers(source: string): string {
	if (!source.includes("[")) return source;
	// Match the lexer's tab normalization so token.raw remains searchable.
	source = source.replace(/\t/g, "    ");
	// Rewrite parsed containers, not source-line offsets: the lexer omits some
	// blank lines and deindents nested lists. Code/HTML tokens stay opaque.
	const rewrite = (text: string, tokens: readonly Token[]): string => {
		let result = "";
		let cursor = 0;
		for (const token of tokens) {
			let replacement = token.raw;
			if (token.type === "list") {
				replacement = rewrite(token.raw, token.items);
			} else if (token.type === "list_item") {
				const children = token.tokens?.filter(child => child.type !== "checkbox") ?? [];
				let body = rewrite(token.text, children);
				if (token.task) {
					const checkbox = token.checked ? "☑" : "☐";
					// A fence/heading/quote must remain at a block boundary.
					body = children[0]?.type === "text" || children[0]?.type === "paragraph"
						? `${checkbox} ${body}` : `${checkbox}\n\n${body}`;
				}
				if (body !== token.text) {
					const marker = /^([ ]*)([-+*]|\d+[.)])(?:[ \t]+|(?=\n|$))/.exec(token.raw)!;
					const prefix = `${marker[1]}${marker[2]} `;
					const indent = " ".repeat(prefix.length);
					replacement = prefix + body.replace(/\n/g, `\n${indent}`) + (token.raw.endsWith("\n") ? "\n" : "");
				}
			} else if (token.type === "blockquote") {
				const body = rewrite(token.text, token.tokens ?? []);
				if (body !== token.text) {
					replacement = body.split("\n").map(line => `> ${line}`).join("\n")
						+ (token.raw.endsWith("\n") && !body.endsWith("\n") ? "\n" : "");
				}
			}
			const start = text.indexOf(token.raw, cursor);
			result += text.slice(cursor, start) + replacement;
			cursor = start + token.raw.length;
		}
		return result + text.slice(cursor);
	};
	return rewrite(source, lexDocument(source));
}

function renderPreview(ctx: ExtensionContext, state: Scratchpad): void {
	if (!ctx.hasUI) return;
	if (!state.preview) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	// Bound parser input and rendered rows, not Markdown source lines:
	// wrapping, tables, and fenced blocks can expand at narrow terminal widths.
	const sourceLimit = 4096;
	const rowLimit = 6;
	const source = previewTaskMarkers(state.text.slice(0, sourceLimit).replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " "));
	ctx.ui.setWidget(WIDGET_KEY, () => {
		let markdown = new Markdown(source || "(empty)", 0, 0, getMarkdownTheme());
		const box = new Box(1, 0, undefined, {
			get chars() { return activeTheme.boxRound; },
			color: text => activeTheme.fg("muted", text),
		}).setIgnoreTight(true);
		box.addChild({
			render(width: number) {
				const lines = markdown.render(width);
				return [
					truncateToWidth(activeTheme.fg("muted", "Scratchpad · personal notes (not model context)"), width),
					// Entity decoding and inline HTML can introduce controls after parsing.
					// Keep terminal styling/links, not arbitrary terminal commands.
					...lines.slice(0, rowLimit).map(line => truncateToWidth(line.replace(
						/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x00-\x06\x08-\x1f\x7f-\x9f]*(?:\x07|\x1b\\)|[ -/]*[0-~])?|[\x00-\x1f\x7f-\x9f]/g,
						sequence => {
							if (/^\x1b\[[0-9;:]*m$/.test(sequence) || sequence.startsWith("\x1b]8;")) return sequence;
							// Show Kitty-sized heading text at normal size in the bounded widget.
							if (sequence.startsWith("\x1b]66;")) {
								const start = sequence.indexOf(";", 5) + 1;
								return start > 0 ? sequence.slice(start, sequence.endsWith("\x07") ? -1 : -2) : " ";
							}
							return " ";
						},
					), width)),
					...(lines.length > rowLimit || state.text.length > sourceLimit ? [activeTheme.fg("muted", "…")] : []),
					truncateToWidth(activeTheme.fg("muted", "Ctrl+Alt+S to edit · Alt+S to hide"), width),
				];
			},
			invalidate() {
				markdown = new Markdown(source || "(empty)", 0, 0, getMarkdownTheme());
			},
		});
		return {
			render(width: number) {
				// Drop padding when the terminal cannot fit a border plus one content column.
				box.setPaddingX(width < 5 ? 0 : 1);
				return box.render(width);
			},
			invalidate() { box.invalidate(); },
		};
	}, { placement: "aboveEditor" });
}

export default function scratchpad(pi: ExtensionAPI): void {
	// Factory-local state: child sessions must not share dialogs or lifecycle guards.
	let generation = 0;
	let editing = false;

	const restore = (_event: unknown, ctx: ExtensionContext): void => {
		generation++;
		renderPreview(ctx, readScratchpad(ctx));
	};
	pi.on("session_start", restore);
	pi.on("session_switch", restore);
	pi.on("session_branch", restore);
	pi.on("session_tree", restore);
	pi.on("session_shutdown", () => { generation++; });

	const persist = async (ctx: ExtensionContext, state: Scratchpad): Promise<void> => {
		// OMP 18.9.2 exposes the live SessionManager but types it read-only.
		// appendEntry alone stays memory-only until the first assistant message.
		const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
			ensureOnDisk?: () => Promise<void>;
		};
		if (manager.getSessionFile() && !manager.ensureOnDisk) {
			throw new Error("This omp version does not expose session materialization; notes were not saved.");
		}
		const savedGeneration = generation;
		// Append on every explicit save: OMP uses the next entry to recover a
		// latched disk failure, including when the note text is unchanged.
		pi.appendEntry(ENTRY_TYPE, state);
		await manager.ensureOnDisk?.();
		if (generation === savedGeneration) renderPreview(ctx, readScratchpad(ctx));
	};

	const edit = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		if (editing) {
			ctx.ui.notify("The scratchpad editor is already open.", "info");
			return;
		}
		editing = true;
		const openedGeneration = generation;
		const openedSession = ctx.sessionManager.getSessionId();
		const original = readScratchpad(ctx);
		try {
			const text = await ctx.ui.editor("Scratchpad · personal notes, not sent to the model", original.text);
			if (text === undefined) return;
			// A dialog can outlive a session/branch switch. Do not write into its new target.
			if (generation !== openedGeneration || ctx.sessionManager.getSessionId() !== openedSession) {
				ctx.ui.notify("Scratchpad not updated: the session or branch changed while editing.", "warning");
				return;
			}
			await persist(ctx, { text, preview: readScratchpad(ctx).preview });
			ctx.ui.notify("Scratchpad updated.", "info");
		} finally {
			editing = false;
		}
	};

	const togglePreview = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		const state = readScratchpad(ctx);
		await persist(ctx, { ...state, preview: !state.preview });
	};

	const subcommands = [
		{ value: "edit", label: "edit", description: "Edit personal notes" },
		{ value: "preview", label: "preview", description: "Toggle the boxed preview" },
		{ value: "paste", label: "paste", description: "Insert notes into the prompt" },
	];
	pi.registerCommand("scratchpad", {
		description: "Edit personal session notes; preview toggles the widget, paste explicitly inserts notes into the prompt",
		getArgumentCompletions: prefix => subcommands.filter(item => item.value.startsWith(prefix)),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("Scratchpad requires an interactive UI.");
			switch (args.trim()) {
				case "":
				case "edit":
					await edit(ctx);
					break;
				case "preview":
					await togglePreview(ctx);
					break;
				case "paste": {
					if (!ctx.ui.supportsEditor) {
						ctx.ui.notify("This UI does not support pasting into a prompt composer.", "warning");
						return;
					}
					const { text } = readScratchpad(ctx);
					if (!text) {
						ctx.ui.notify("The scratchpad is empty.", "info");
						return;
					}
					ctx.ui.pasteToEditor(text);
					break;
				}
				default:
					ctx.ui.notify(USAGE, "warning");
			}
		},
	});
	pi.registerShortcut("alt+s", {
		description: "Toggle the scratchpad preview",
		handler: togglePreview,
	});
	pi.registerShortcut("ctrl+alt+s", {
		description: "Open the personal scratchpad",
		handler: edit,
	});
}

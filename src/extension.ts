import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Box, getMarkdownTheme, Markdown, theme as activeTheme, truncateToWidth } from "@oh-my-pi/pi-tui";

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
	const source = state.text.slice(0, sourceLimit).replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ");
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
					truncateToWidth(activeTheme.fg("muted", "Alt+S to edit · /scratchpad preview to hide"), width),
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

	pi.registerCommand("scratchpad", {
		description: "Edit personal session notes; preview toggles the widget, paste explicitly inserts notes into the prompt",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("Scratchpad requires an interactive UI.");
			switch (args.trim()) {
				case "":
				case "edit":
					await edit(ctx);
					break;
				case "preview": {
					const state = readScratchpad(ctx);
					await persist(ctx, { ...state, preview: !state.preview });
					break;
				}
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
		description: "Open the personal scratchpad",
		handler: edit,
	});
}

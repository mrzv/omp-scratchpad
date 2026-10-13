# omp-scratchpad

Personal, editable notes for Oh My Pi. Notes live in the session, but are **not included in automatic model context**.

## Load

Tested with omp 18.9.2. Load this package explicitly:

```sh
omp -e .../omp-scratchpad
```

To load it on every startup, add the path to the `extensions` list in `~/.omp/agent/config.yml` (preserve existing entries):

```yaml
extensions:
  - .../omp-scratchpad
```

Restart omp after changing extension configuration. Runtime loading needs no `npm install`: the extension uses host-provided types and native TUI components.

## Use

| Action | Command / key |
| --- | --- |
| Open the separate multiline notes editor | `/scratchpad` or `/scratchpad edit` |
| Open it without disturbing the prompt draft | **Alt+S** (Option+S on macOS, with Option configured to send Alt) |
| Show/hide a small preview above the prompt | `/scratchpad preview` |
| Explicitly insert the notes into the prompt composer | `/scratchpad paste` |

Inside the notes editor, **Enter** inserts a newline, **Ctrl+Q** (or Ctrl+Enter) saves, and **Escape** cancels. These are omp's default bindings; the editor displays the effective bindings. Ctrl+G opens the configured external editor. Alt+S and Ctrl+Alt+S have no built-in binding in the tested OMP version; this extension uses the simpler Alt+S, replacing its original Ctrl+Alt+N shortcut. On macOS, configure the terminal to send Option as Alt/Meta instead of entering `ß`. If another extension claims Alt+S or your terminal does not transmit it, use `/scratchpad`.

Saving an empty editor clears the current note. Closing with Escape leaves the saved note unchanged. Every explicit save adds a snapshot, even when the text is unchanged; this also lets OMP recover a previous failed disk write. Preview starts hidden and remembers its visibility with the note. It renders Markdown using OMP's native renderer, including headings, emphasis, lists, links, code, and tables. The preview parses at most the first 4,096 UTF-16 code units and displays up to six rendered rows, with an ellipsis when clipped; the full note remains editable and pasteable. Headings use normal terminal text size to keep the widget bounded. Rendered output retains styling and hyperlinks but filters other terminal commands, including controls assembled during HTML/entity decoding. Paste does not submit a prompt; the notes enter model context only if you subsequently send that prompt.

The preview is enclosed in a muted, rounded box with a one-column inset, visually separating personal notes from the prompt. The six-row content limit is unchanged; the border adds two rows. At extremely narrow widths, padding or the border is omitted rather than overflowing the terminal.

## Persistence and branches

Each update appends an opaque `custom` state entry to the current session branch. Opening a session or navigating its tree restores the last scratchpad snapshot on that branch. New sessions start empty; forks inherit snapshots present at their branch point, then diverge. Navigating before a note's snapshot restores the earlier state, not the latest note from another branch.

Notes-only sessions are materialized immediately, even before an assistant reply. They can be resumed normally with `omp --session <session-file>`. OMP 18.9.2 passes the live `SessionManager` to extensions, although its context type is read-only; this extension feature-checks and calls the public `ensureOnDisk()` method to avoid OMP's lazy-persistence gate. If a future host removes that capability, the extension reports an error instead of claiming a new note was saved. In explicitly non-persistent sessions (`--no-session`), notes remain in memory by design.

A notes dialog spanning a session or branch switch is not saved into the new target; omp displays a warning. Reopen the scratchpad after switching before editing.

## Privacy boundary

This is **context exclusion**, not encryption or access control:

- No model tool is registered, no chat message is injected, and no automatic context hook exposes notes.
- Notes are plaintext in the normal session JSONL file. Anyone or any filesystem tool able to read that file can read them.
- Old snapshots remain in session history after editing or clearing. Clearing is not secure erasure.
- The notes editor and preview use omp's normal UI APIs; connected collaboration clients may see them. Do not use this extension to hide secrets from collaborators.
- Explicit paste deliberately moves notes into the ordinary prompt composer.

The primary interface is the interactive terminal. Non-UI modes are not supported. The Markdown preview is a bounded widget above the prompt, not a permanent sidebar.

## Development

```sh
npm install --ignore-scripts
npm run check
```

Behavioral regressions use the real OMP `SessionManager`: notes-only persistence/reopen, disk-failure recovery, empty-note clearing, canceled edits, branch inheritance/divergence, new-session isolation, dialogs spanning session/tree switches, and exclusion from reconstructed model messages. Native-renderer regressions cover bounded output when long Markdown wraps at narrow widths, entity-encoded terminal controls, and theme changes.

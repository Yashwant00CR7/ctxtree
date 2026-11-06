# ctxtree mod: manual check in vTower

The automated suites cover behaviour against the real Claude Code with a stand-in
API. This list covers what only your terminal and the real API can show. About ten
minutes. Use a throwaway session in a scratch folder.

## Setup

1. From the repo: `claude --plugin-dir plugins/ctxtree --plugin-dir plugins/ctxtree-ui`
2. If the prompt is not pinned at the bottom with the transcript above it, run
   `/tui fullscreen`.
3. Do some work that leaves context behind: ask Claude to read two or three large
   files and run a command or two.

## Look

- [ ] `/ctxtree` docks a pane beside the transcript, with the tree, the side column
      (details) and the treemap.
- [ ] The treemap shows shaded blocks with labels such as "Setup" and
      "Tool results". If it looks flat or banded, try `export COLORTERM=truecolor`
      in `~/.zshrc`, open a new tab, and compare.
- [ ] `z` widens the pane; `z` again docks it.

## Keys and mouse

- [ ] Arrows, PgUp/PgDn and the wheel move the selection; `l`/`h` open and close.
- [ ] Clicking a row selects it; clicking its ▸ opens it; after the click, Space marks it.
- [ ] Clicking a block in the treemap selects it in the tree.
- [ ] Right-click (or `d`) opens the menu; `4` closes it.
- [ ] `1`/`2` switch views; `t`/`i`/`k` switch the side column.
- [ ] Esc returns you to the prompt and closes the pane.

## The edit, against the real API

- [ ] Mark a large file read. The band above the prompt shows "1 staged · −…".
- [ ] From an empty prompt, `2` opens the review; `a` applies. A toast says how many
      tokens were freed.
- [ ] Ask Claude "what was in that file?". It should say it no longer has it, and
      the conversation should otherwise carry on normally, with no API error.
- [ ] `/ctxtree review`: the file is listed under "Removed earlier"; restore it, then
      apply. Ask again: Claude has the content back.
- [ ] Quit and `claude --resume` the session (with the same `--plugin-dir` flags).
      The edit is still in place, with nothing duplicated or reverted.

## Asking Claude

- [ ] "Use ctxtree to free some context; drop the old reads." Claude maps, proposes
      and stages, but never applies. The band shows the staged items.
- [ ] Apply from the band. Ask Claude what it remembers of the cleanup discussion:
      it should see only the one ctxtree note.
- [ ] Mark something, send a long prompt, and press `2` then `a` while Claude is
      working. The review says it applies when the turn ends, and it does.

Note anything off (screenshots help), especially colours, mouse, and anything the
real API rejects.

# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads them all:

- a unified diff (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

Every file is changed or nothing is: edits apply in the patch's order, a
failed edit changes nothing, the edits after it still run, and when any edit
fails no file is written at all.

## Run it

Node 22 or newer, standard library only, no dependencies:

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (no whitespace-tolerant tiers).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`)
and a final `ok: N files` line. Exit 1 lists the edits that failed and ends
with `failed: K of N edits`. Exit 2 is a usage, patch-read, format or parse
error, with exactly one `error: ...` line.

## How matching works

Old lines are found at the first of three tiers at which they occur at
least once: exact, trailing whitespace ignored, then leading and trailing
whitespace ignored (with re-indentation). A unified hunk takes the occurrence
nearest its (possibly wrong) line number; a SEARCH/REPLACE block needs
exactly one occurrence; a V4A chunk takes the first at or after its cursor.

## License

MIT. See `LICENSE`.

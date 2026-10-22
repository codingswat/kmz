# KML/KMZ Point Extractor — project brief for Claude

**Where this file goes:** `~/Desktop/repo/kmz/CLAUDE.md` — Claude Code reads it automatically
when working in that repo. My general working rules are in `~/.claude/CLAUDE.md`; this file is
only what's specific to this project.

GitHub: `codingswat/Kmz`

## What it is

Turns KML/KMZ map files into an Excel workbook — one row per point, five coordinate formats,
plus polygon areas. Python core with three front ends (desktop tkinter app, CLI, LAN web
service), **plus a complete second implementation in JavaScript** that runs entirely in a
browser with no dependencies.

**Being handed to another developer** to rebuild inside a TypeScript stack. A standalone
`HANDOVER.md` in this repo is written for someone with no access to the code — it is the
source of truth for the handover.

For current state, run the test suites and check `git log` — don't trust any snapshot written
in a notes file.

## Rules that must hold

- **Origin: drone-licence submissions to GACA and SANS.** The five coordinate formats and the extract-everything Attributes/ExtendedData output exist for that form; keep that output compatible.
- Ask before removing or reshaping any coordinate format or attribute output.

- **The two implementations (Python and JavaScript) must agree.** A generated-fixture
  cross-check enforces it; keep that check alive and passing.
- **Core invariant: nothing raises on bad input.** One bad file must never abort a batch.
- **Comments explain *why*, never *what*.** Match the existing style.
- Bilingual Arabic/English matters here as everywhere: UTF-8 handling is a real requirement.

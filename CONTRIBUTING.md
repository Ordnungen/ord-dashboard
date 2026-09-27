# Contributing

Thanks for looking at this plugin. The most useful things you can send are a clear bug report, a failing case
and a small pull request — in that order.

## Reporting a problem

Open an issue with:

- what you expected and what happened instead;
- your Obsidian version and the plugin version (Settings → Community plugins);
- what the panel showed: which tab, which graph mode, and whether the numbers look wrong or the picture;
- the console output if there is an error (Ctrl/Cmd+Shift+I → Console).

Please do not paste your real notes: a two-line example that reproduces the problem is enough. For anything
about the graph, say which mode (around the open note or vault overview) and what the vault's own graph
settings are.

## Working on the code

```bash
git clone https://github.com/Ordnungen/ord-dashboard
cd ord-dashboard
npm install
npm run dev      # watch build
npm run check    # typecheck + lint
npm run cases    # 331 checks: graph engine, data and texts, the plugin on an Obsidian stub
npm run analyze -- "<vault>" --survey=4000   # read-only report over a real vault
npm run build    # production build
```

The analytics file of a real vault is the thing to be careful with: `npm run analyse` only reads, and the
plugin itself never touches note contents.

## What a pull request should contain

- **one change**, described in a sentence in the title;
- **a case** for any behaviour change: the graph engine, the data layer and the panel each have their own
  catalogue in `tools/`, and a fix without a case tends to come back;
- `npm run check` and `npm run cases` green, and `main.js` rebuilt (`npm run build`) — it is committed on
  purpose.

## Style

Everything visible in the interface goes through the dictionary (`src/i18n.ts`): English is the base, Russian
is the translation, and both are checked by the compiler. Code, comments, commits and the README are in
English; the notes in a vault stay in whatever language the vault uses.

The graph follows the vault's own graph settings (colours, node types, text fade) instead of inventing a look,
and closeness is measured — a focused random walk against the vault-wide walk — not guessed. The rules the two
plugins follow are written down in the `docs/` folder next to the code: `IDENTITY.md` (the idea and the style),
`STANDARD.md` (structure), `CODE-STYLE.md`, `UI-TEXT.md`, `STYLES.md`, `PLUGINS.md` (state and debts) and
`SKELETON.md` (the conveyor for a new plugin).

## License

By contributing you agree that your work is released under the MIT license of this repository.

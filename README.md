# ORDdashboard

*Tracks how you work with your notes and tells you which ones are ready to refresh.*

![ORDdashboard cover](ord-dashboard-cover.jpg)

The dashboard lives in the sidebar: it keeps its state while you work, and notes open in a new tab
without closing it. The scrollable part holds search, statistics and note lists; the **link graph** is
pinned to the bottom of the panel, so it stays visible while you scroll. Panel actions (refresh, clear
data) sit in the panel header — the top-right corner of the panel itself.

> Panel header actions are not visible if a theme or snippet hides the panel header. In that case use the
> ribbon icon or the command.

## Features

| Capability | What it does |
|------------|--------------|
| Analytics | Totals for notes, views, edits and notes active in the last 30 days; large totals are shortened (`241,3 тыс.`) with the exact number on hover |
| Most active | Notes with the most views and edits in the current month |
| Ready to refresh | Notes you opened but have not revisited, with 5 progressive stages and deadlines |
| Recently active | Notes opened in the last week, or opened more than once this month |
| All notes | Your notes sorted by creation date, with activity details |
| Link graph | Graph pinned to the bottom of the panel: the neighbourhood of the open note, or the whole vault most-connected view. Folded away it is a single header row. The open note keeps its name; other names are hidden while the graph is only fitted and appear as you zoom in |
| Zoom | Wheel zooms, dragging pans, hover lights up a note's links, click opens it; double-click fits the graph again |
| Collapsible sections | Select a section header to fold it away; the number of items stays visible |
| Search | Quick search by note name or path |
| I18n | Interface adapts to the Obsidian language (EN / RU) |
| Compact data | Aggregates instead of long timestamp lists: the data file stays in the kilobyte range |

## Installation

Settings → Community plugins → Browse → ORDdashboard → Install & Enable

Manual: copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/ord-dashboard/`

## Usage

| Action | What happens |
|--------|--------------|
| Ribbon icon | Opens the dashboard in the right sidebar |
| Panel header: refresh | Rebuilds the panel from the current data |
| Panel header: clear data | Asks for confirmation, then deletes all recorded activity |
| Command: Open dashboard | Same as the ribbon icon |
| Command: Clear analytics data | Asks for confirmation, then deletes all recorded activity |
| Command: Seed activity from file dates | Fills activity for notes edited in the last 30 days |
| Select a note in the panel | Opens it in a new tab; notes from "Ready to refresh" advance one stage |

### Link graph

The graph is a bounded overview of the whole vault, drawn and laid out with the same formulas as the
core Graph view:

| Element | Rule (same as the core graph) |
|---------|-------------------------------|
| Forces | `forceX/forceY(centerStrength)`, `forceLink(linkDistance, strength = linkStrength / min(degree))`, `forceManyBody(-repelStrength, distanceMin 30)`, `forceCollide(radius 60, strength 0.5)` |
| Integration | `v *= 0.6`, alpha decays from 1 to 0.001 over ~300 ticks, forces re-heat to 0.3 when data or settings change |
| Node size | `nodeSizeMultiplier * clamp(3 * sqrt(degree + 1), 8, 30)`, scaled by `sqrt(scale)` on screen |
| Links | `lineSizeMultiplier` px thick, drawn between the circles, `--graph-line`, highlighted with `--interactive-accent` while hovering |
| Labels | fade with `clamp(log2(scale) + 1 - textFadeMultiplier, 0, 1)`; the hovered note keeps its size and sits lower |
| Hover | everything unrelated to the hovered note fades to 20% |
| Zoom | `1.5^(-deltaY / 120)`, range 1/128 … 8, zoom centre under the cursor when zooming in |
| Open note | By default the graph shows the neighbourhood of the note you are reading; it rebuilds whenever you open another note. Links in both directions are followed, and a note reached only through shared section indexes is dropped: "close" is measured with a random walk from the open note, not assumed from the number of hops. Switch "What to show" for a whole-vault overview instead |
| Nearest means measured | Every note links to the sections it lives in, so two hops can mean the whole vault. Candidates are scored by a focused random walk divided by the same walk started over the whole vault (a link count for undirected links): a note that is only two hops away through an index scores below 1 and is left out. Index notes never pass the walk on, so "registered in the same table of contents" is not closeness. Measured on a 3 225-note vault: opening a deep work note gives 10 notes — its own files, a template and the nearest module notes |
| Place counts too | Notes filed next to the open one are neighbours even when nothing links them, so a checklist shows the checklists next to it. A real link always weighs more than sharing a folder |
| Index notes | A note linked to at least 2% of the vault (and at least 25 links) is a table of contents, not a connection: dimmed and drawn without lines by default. On the vault above that removed 95% of the lines, which all led to seven index notes |
| Node types | Tags, attachments, unresolved links and orphans — each with its own colour, exactly as the vault's graph settings say (`showTags`, `showAttachments`, `hideUnresolved`, `showOrphans`) |
| Colour groups | Groups from the vault's graph settings are applied (the last matching group wins). Queries using `tag:`, `path:`, `file:`, plain text, quotes and `-` negation are supported; a group with anything else (Obsidian's internal search operators) is skipped rather than guessed |

Colours come from the core's own CSS classes (`.graph-view.color-fill`, `…color-fill-tag`,
`…color-fill-attachment`, `…color-fill-unresolved`, `…color-line`, …), read from a probe attached to the
document — the palette (`--graph-node`, `--graph-line`, …) is declared on `body`, so it only resolves for
an element that is actually in the document. That is why the graph repaints on `css-change`: switching the
theme, the light/dark mode or a CSS snippet recolours it immediately, and per-type opacities (unresolved
links 0.5, arrows 0.5) come along.

**Node size.** The core sizes nodes for a full graph window (`nodeSizeMultiplier * clamp(3 * sqrt(degree + 1), 8, 30)`, times `sqrt(scale)`), tuning them for thousands of nodes on a large canvas. A panel is much
smaller, so the same formula scaled down looks like the original: "Node size in the panel" defaults to 50%
of the core size (options: as in Obsidian / 75% / 50% / 35%), and a hub can never grow past 5% of the panel,
so no dots turn into blobs. With the values from this vault (node size multiplier 1.205, forces 0.7 / 20 /
0.9 / 30) a hub is about 5 px and a leaf about 2.4 px in a 240×180 px panel.

By default the *look* — node and line size, text fade, arrows, which node types to show and the colour
groups — is read from the vault's own graph settings (`.obsidian/graph.json`), so the picture matches the
Graph view you configured. The *forces* stay at the core defaults on purpose: the panel shows a few hundred
nodes, and a force configuration tuned for a full window (this vault uses center 0.7 with repel 20) squeezes
them into a tight lump.

| Action | What happens |
|--------|--------------|
| Select the graph header | Collapses or expands the graph, freeing its part of the panel |
| Hover a node | Highlights the node and its neighbours, dims the rest, shows their names |
| Select a node | Opens that note; the graph then rings it as the open note |
| Drag a node | Moves it and lets the layout settle again around it |
| Drag the background | Pans; the mouse wheel zooms, double-click fits the graph into the panel |
| Header buttons | Rebuild the graph, fit to panel |

### Review stages

| Stage | Interval | Deadline |
|-------|----------|----------|
| 1 | 7 days | 2 days |
| 2 | 14 days | 2 days |
| 3 | 30 days | 7 days |
| 4 | 60 days | 7 days |
| 5 | 120 days | 14 days |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Track opened notes | ON | Records when a note is opened |
| Track edited notes | ON | Records when a note is edited |
| Show ribbon icon | ON | Adds the dashboard icon to the ribbon; turn it off to keep the left sidebar clean and open the panel from the command palette or a hotkey |
| Graph → Show link graph | ON | Pins the link graph to the bottom of the panel |
| Graph → What to show | Around the open note | The neighbourhood of the note you are reading (rebuilt as you navigate) or an overview of the whole vault |
| Graph → Depth | 2 hops | How far the neighbourhood reaches (1–3 links away) |
| Graph → How close is close enough | Close links | Notes reached through links stay only when they are measurably closer to this note than to a random one; "Core-like" keeps everything inside the depth limit |
| Graph → Index notes | Dimmed context | A note linked to a large part of the vault is a table of contents: dimmed without lines, hidden, or drawn like the core does. Its links are never routes either: reaching a note through a table of contents does not make it close |
| Graph → Notes filed next to the open one | ON | Notes in the same folder count as neighbours even without links. Folders with more than 50 notes are ignored, since there a folder stops meaning anything |
| Graph → Graph nodes | 300 | Upper limit of notes; the most connected ones are kept |
| Graph → Animate layout | ON | Lets the graph settle softly and then freeze |
| Graph → Node size in the panel | 50% | Scales node sizes down for the panel; "As in Obsidian" reproduces the core formula exactly |
| Graph → Graph height | Medium | Share of the panel taken by the graph (small / medium / large) |
| Data → Tracked notes | — | How many notes have recorded activity |
| Data → Clear analytics data | — | Deletes all recorded activity |

## Performance

The graph is a bounded overview, not a copy of the vault graph:

- Node selection is capped (300 by default, up to 2000) and links are capped too, so drawing stays under
  a millisecond per frame no matter how large the vault is.
- The link index is walked in small steps during idle time, never in one blocking pass; the panel stays
  responsive and the graph appears with a progress line.
- The layout settles in about 300 ticks and freezes itself (a couple of seconds of soft animation, like the
  core graph); nothing runs while the graph is collapsed or the panel is hidden.
- Rebuilds happen at most once per ten seconds after the link index changes, and only if the graph is visible.
- Measured on synthetic data: 100 000 notes with 500 000 links are scanned in about 0.09 s of work spread
  over twenty idle steps — a million-note vault costs roughly a second of background work, not a freeze.
  300 nodes settle in ~0.15 s of simulation time.

The graph reads only Obsidian's link index (`resolvedLinks`); note contents are never opened.

## Data and privacy

Everything is stored locally in the plugin's `data.json` as aggregates per note: total views and edits,
last opened and last edited timestamps, the refresh stage, and counters for the current month and the two
months before it. Nothing is sent anywhere, and no note content is read or modified.

Notes that no longer exist are dropped from the data on start. Monthly counters older than three months
are removed automatically.

### Upgrading from 0.0.1

The first start of this version reads the old `note-views.json`, converts it into aggregates and renames
the original file to `note-views.json.bak`, so nothing is lost. Records for non-Markdown files (the old
version tracked every file type) are skipped.

## Development

```bash
git clone https://github.com/Ordnungen/ord-dashboard
cd ord-dashboard
npm install
npm run dev      # watch build
npm run check    # typecheck + lint
npm run build    # production build
```

## License

MIT

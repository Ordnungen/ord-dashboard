// ---------------------------------------------------------------------------
// Graph sampling
//
// Two scopes, both bounded so nothing scales with the size of the vault:
//
//   local — the neighbourhood of the open note: the notes reachable from it by
//           links in either direction, ranked by how close they really are.
//   vault — an overview of the whole vault: the most connected notes.
//
// Nearest means measured, not assumed. Every note in the vault links to its
// section indexes, so "two hops away" is not distance at all: a plain
// breadth-first walk pulls in the whole vault through those indexes (measured on
// a 3 234-note vault: 3 183 notes at two hops, 95% of the lines belonging to
// seven index notes). Instead the walk from the open note is scored:
//
//   * a random walk from the open note over the candidate links (focused
//     PageRank), so a note linked many times scores higher and a hub that links
//     to everything spreads its weight thin;
//   * divided by the same walk started uniformly over the whole vault, which for
//     undirected links is simply proportional to the node's link count: a hub is
//     not closer to this note than to a random note.
//
// The ratio ("lift") is how much closer a note is to the open note than to a
// random one. Close links score above 1, and a note reached only through shared
// section indexes scores below it — no thresholds tuned per vault, no folder or
// tag names anywhere in here.
//
// A node linked to a large part of the vault is an index note (a table of
// contents), not a connection: in the local scope it can be drawn as dimmed
// context instead of flooding the picture with lines.
//
// `MetadataCache.resolvedLinks` is the whole-vault adjacency map Obsidian keeps.
// It is only ever read, never copied, and always walked in small steps driven by
// the caller, so a large vault cannot block the panel.
// ---------------------------------------------------------------------------

import { matchColorGroup, type ColorGroup } from './graph-params';

export type GraphNodeType = 'note' | 'tag' | 'attachment' | 'unresolved';
export type GraphScope = 'local' | 'vault';
/** How strictly notes reached through links are filtered. */
export type RelevanceLevel = 'strict' | 'normal' | 'relaxed' | 'core';
/** What to do with index notes (tables of contents) in the local graph. */
export type IndexHandling = 'context' | 'hidden' | 'core';

export interface GraphNode {
    /** Note path, `#tag`, attachment path or the text of an unresolved link. */
    path: string;
    title: string;
    /** Number of links this node has inside the drawn graph. */
    degree: number;
    type: GraphNodeType;
    /** Colour from the vault's colour groups, if any matched. */
    color?: string;
    colorAlpha?: number;
    /** An index note: connected to a large part of the vault, not to this note. */
    context?: boolean;
    /** How close the note turned out to be (1 = closer than a random note). */
    score?: number;
}

export interface GraphEdge {
    source: number;
    target: number;
}

export interface OverviewGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    /** True when the vault has more notes or links than the budget allows. */
    truncated: boolean;
    /** True when notes were dropped because they are too far from the open note. */
    filtered: boolean;
}

/** Per-note data the sampler asks for, so it stays independent of Obsidian. */
export interface GraphExtras {
    tags?: string[];
    attachments?: string[];
    unresolved?: string[];
}

export interface SamplerOptions {
    /** Bounds of note nodes. */
    limit: number;
    maxEdges: number;
    scope?: GraphScope;
    /** Note the local neighbourhood is built around. */
    rootPath?: string;
    /** How many link hops away from the root the local graph reaches (1..3). */
    depth?: number;
    /** 'core' keeps every note inside the hop limit, like the core graph does. */
    relevance?: RelevanceLevel;
    /** 'core' draws index notes with their links, exactly like the core graph. */
    indexHandling?: IndexHandling;
    /**
     * Notes that share the open note's place (its folder). Obsidian keeps a place
     * for a reason: notes filed together belong together even when nothing links
     * them, so they are treated as neighbours. Empty when the folder is too big to
     * mean anything, which the caller decides.
     */
    placePaths?: string[];
    /** Extra budget for tag, attachment and unresolved nodes. */
    extraLimit?: number;
    showTags: boolean;
    showAttachments: boolean;
    includeUnresolved: boolean;
    /** Notes without outgoing links, added as isolated nodes like the core does. */
    orphanPaths?: string[];
    maxOrphans?: number;
    /** Colour groups from the vault's graph settings. */
    colorGroups?: ColorGroup[];
    /** The note that is open: always part of a vault overview, always the root locally. */
    focusPath?: string;
    /** Asked only for selected notes, never for the whole vault. */
    extras?: (path: string) => GraphExtras | null;
}

type Links = Record<string, Record<string, number>>;
type Phase =
    | 'seed' | 'forward' | 'reverse' | 'cohort' | 'adjacency' | 'rank' | 'select'
    | 'degree' | 'edges' | 'collect' | 'add' | 'done';

/**
 * A note beyond the first hop stays when it is measurably closer to the open
 * note than to a random one (1), and when it is not a pale shadow of the closest
 * far link found (the level scales that share).
 */
export const RELEVANCE_SHARES: Record<RelevanceLevel, number> = {
    strict: 0.3,
    normal: 0.1,
    relaxed: 0.03,
    core: 0,
};
/** Closer to the open note than to a random note: the floor for any level. */
export const RELEVANCE_FLOOR = 1;

/** Share of the extra budget that goes to tags; the rest is attachments/links. */
const TAG_BUDGET_SHARE = 0.6;
/** Random walk: probability of following a link instead of restarting at the root. */
const WALK_DAMPING = 0.85;
/** Enough iterations for the ranking to settle (0.85^20 is under 4%). */
const WALK_ITERATIONS = 20;
/** Link weight of a note that merely sits in the same folder as the open note. */
const PLACE_WEIGHT = 0.5;
/** Below this many notes an index cannot be told from a hub worth showing. */
const INDEX_MIN_NOTES = 200;
/** A node linked to at least this share of the vault is an index note. */
const INDEX_DEGREE_SHARE = 0.02;
/** ...and at least this many links, so small vaults are never affected. */
const INDEX_MIN_DEGREE = 25;
/** Hard bound on how many notes the scoring walk may touch. */
const MAX_CANDIDATES = 20000;

/** Smallest-work binary min-heap that keeps the `limit` best entries. */
class DegreeHeap {
    private items: GraphNode[] = [];

    constructor(private limit: number) {}

    get itemsSorted(): GraphNode[] {
        return [...this.items].sort((a, b) => b.degree - a.degree);
    }

    push(node: GraphNode): void {
        if (this.limit <= 0) return;
        if (this.items.length < this.limit) {
            this.items.push(node);
            this.siftUp(this.items.length - 1);
            return;
        }
        const weakest = this.items[0];
        if (!weakest || node.degree <= weakest.degree) return;
        this.items[0] = node;
        this.siftDown(0);
    }

    private siftUp(start: number): void {
        let index = start;
        while (index > 0) {
            const parent = (index - 1) >> 1;
            const child = this.items[index];
            const up = this.items[parent];
            if (!child || !up || up.degree <= child.degree) break;
            this.items[index] = up;
            this.items[parent] = child;
            index = parent;
        }
    }

    private siftDown(start: number): void {
        let index = start;
        for (;;) {
            const left = index * 2 + 1;
            const right = left + 1;
            let smallest = index;
            const current = this.items[smallest];
            const leftItem = this.items[left];
            const rightItem = this.items[right];
            if (current && leftItem && leftItem.degree < current.degree) smallest = left;
            const smallestItem = this.items[smallest];
            if (rightItem && smallestItem && rightItem.degree < smallestItem.degree) smallest = right;
            if (smallest === index) break;
            const item = this.items[index];
            const target = this.items[smallest];
            if (!item || !target) break;
            this.items[index] = target;
            this.items[smallest] = item;
            index = smallest;
        }
    }
}

export function titleFromPath(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * Links may point at any file, not only at notes. The core draws everything that
 * is not a note as an attachment (its own colour and size), and so does the panel:
 * a picture reached through a link must not look like a note.
 */
function typeForPath(path: string): GraphNodeType {
    return path.toLowerCase().endsWith('.md') ? 'note' : 'attachment';
}

export class OverviewSampler {
    private links: Links;
    private options: SamplerOptions;
    private scope: GraphScope;
    private depth: number;
    private sources: string[];
    private heap: DegreeHeap;
    private selected = new Map<string, number>();
    private nodes: GraphNode[] = [];
    private edges: GraphEdge[] = [];
    private edgeKeys = new Set<string>();
    /** Local traversal state. */
    private hops = new Map<string, number>();
    private queue: string[] = [];
    private reverseDone = false;
    /** Notes filed next to the open note; they join as its direct neighbours. */
    private placeSet = new Set<string>();
    /** Candidate index -> flat pairs of (neighbour index, link weight). */
    private inLinks = new Map<number, number[]>();
    /** Path -> candidate index, so scoring never depends on the drawn order. */
    private candIndex = new Map<string, number>();
    /** Candidates that are index notes: they never pass the walk on. */
    private indexIndexes = new Set<number>();
    /** Vault-wide totals, so a node can be compared with the whole vault. */
    private totalOut = 0;
    private totalIn = 0;
    /** Vault-wide link count per candidate path (out-links plus links into it). */
    private inDegrees = new Map<string, number>();
    /** Undirected link weights inside the candidate subgraph, by candidate index. */
    private walkAdj: number[][] = [];
    private walkDeg: Float64Array = new Float64Array(0);
    private mass = new Float64Array(0);
    private massNext = new Float64Array(0);
    private rootIndex = 0;
    private lift = new Map<string, number>();
    private candidates: string[] = [];
    private filteredOut = false;
    private trimmedByBudget = false;
    private noteTags = new Map<string, string[]>();
    private noteExtras = new Map<string, GraphExtras>();
    private tagCounts = new Map<string, number>();
    private chosenTags: string[] = [];
    private extraBudget: number;
    private extrasUsed = 0;
    private phase: Phase;
    private cursor = 0;
    private iteration = 0;
    /** Node the resumable scoring pass stopped at, and the mass it collected. */
    private rankIndex = 0;
    private dangling = 0;
    private extrasSnapshot: GraphNode[] = [];
    private cappedEdges = false;
    private droppedTargets = false;

    constructor(links: Links, options: SamplerOptions) {
        this.links = links;
        this.options = options;
        this.scope = options.scope ?? 'vault';
        this.depth = Math.max(1, Math.min(Math.round(options.depth ?? 2), 3));
        this.sources = Object.keys(links);
        this.heap = new DegreeHeap(options.limit);
        this.extraBudget = Math.max(options.extraLimit ?? 0, 0);

        if (this.scope === 'local' && options.rootPath) {
            this.phase = 'seed';
            return;
        }
        this.scope = 'vault';
        this.phase = this.sources.length > 0 ? 'degree' : 'collect';
    }

    get finished(): boolean {
        return this.phase === 'done';
    }

    /** 0..1, used for the progress line while the graph is being built. */
    get progress(): number {
        if (this.phase === 'done') return 1;
        switch (this.phase) {
            case 'seed': return 0.04;
            // The walk runs twice: outward first, then again for the notes the
            // backlink pass found.
            case 'forward': return this.reverseDone ? 0.56 : 0.04 + this.share(0.36);
            case 'reverse': return 0.4 + this.share(0.16);
            case 'cohort': return 0.56 + this.share(0.2);
            case 'adjacency': return 0.76 + this.share(0.05);
            case 'rank': return 0.81 + (this.iteration / WALK_ITERATIONS) * 0.07;
            case 'select': return 0.89;
            case 'degree': return this.share(0.8);
            case 'edges': return 0.8 + this.share(0.08);
            case 'collect': return 0.9 + this.share(0.06);
            default: return 0.96;
        }
    }

    private share(span: number): number {
        if (this.sources.length === 0) return 0;
        return Math.min(this.cursor / this.sources.length, 1) * span;
    }

    get result(): OverviewGraph | null {
        if (this.phase !== 'done') return null;
        return {
            nodes: this.nodes,
            edges: this.edges,
            truncated: this.cappedEdges || this.droppedTargets || this.trimmedByBudget
                || (this.scope === 'vault' && this.sources.length > this.options.limit),
            filtered: this.filteredOut,
        };
    }

    /**
     * Works for at most `budgetMs` milliseconds. Returns true when the graph is
     * ready. Safe to call in a loop from `requestIdleCallback`.
     */
    step(budgetMs: number): boolean {
        const deadline = performance.now() + budgetMs;
        while (!this.finished) {
            switch (this.phase) {
                case 'seed': this.stepSeed(); break;
                case 'forward': this.stepForward(deadline); break;
                case 'reverse': this.stepReverse(deadline); break;
                case 'cohort': this.stepCohort(deadline); break;
                case 'adjacency': this.stepAdjacency(deadline); break;
                case 'rank': this.stepRank(deadline); break;
                case 'select': this.stepSelect(); break;
                case 'degree': this.stepDegree(deadline); break;
                case 'edges': this.stepEdges(deadline); break;
                case 'collect': this.stepCollect(deadline); break;
                default: this.stepAdd(deadline); break;
            }
            if (performance.now() >= deadline) break;
        }
        return this.finished;
    }

    // -----------------------------------------------------------------------
    // Local scope: the neighbourhood of the open note
    // -----------------------------------------------------------------------

    private stepSeed(): void {
        const root = this.options.rootPath ?? '';
        this.hops.set(root, 0);
        this.queue = [root];
        this.cursor = 0;

        // Notes filed next to the open one are its neighbours from the start, so
        // the outward walk expands them as neighbours and nothing that reaches them
        // through an index gets to call them distant.
        this.placeSet = new Set(this.options.placePaths ?? []);
        this.placeSet.delete(root);
        const rootIndex = this.addNoteNode(root);
        for (const path of this.placeSet) {
            const index = this.addNoteNode(path);
            if (index === null) {
                this.droppedTargets = true;
                continue;
            }
            if (!this.hops.has(path)) this.hops.set(path, 1);
            this.queue.push(path);
            if (rootIndex !== null && rootIndex !== index) this.addEdge(rootIndex, index);
        }
        this.phase = 'forward';
    }

    /** Breadth-first walk out of the root, hop by hop. */
    private stepForward(deadline: number): void {
        while (this.cursor < this.queue.length) {
            const path = this.queue[this.cursor];
            this.cursor += 1;
            if (path === undefined) continue;

            const hop = this.hops.get(path) ?? 0;
            // Every visited note is a candidate, whether or not it has its own links.
            const source = this.addNoteNode(path);
            if (hop >= this.depth) continue;
            if (this.nodes.length >= MAX_CANDIDATES) {
                this.droppedTargets = true;
                continue;
            }

            const targets = this.links[path];
            if (!targets) continue;
            for (const targetPath in targets) {
                const target = this.addNoteNode(targetPath);
                if (target === null) {
                    this.droppedTargets = true;
                    break;
                }
                if (source !== null && target !== source) this.addEdge(source, target);
                if (!this.hops.has(targetPath)) {
                    this.hops.set(targetPath, hop + 1);
                    this.queue.push(targetPath);
                }
            }

            if ((this.cursor & 63) === 0 && performance.now() >= deadline) return;
        }

        // After the outward walk, one pass collects the backlinks, then the walk
        // continues so the notes found that way show their own links too.
        if (!this.reverseDone) {
            this.cursor = 0;
            this.phase = 'reverse';
            return;
        }
        this.startScoring();
    }

    /**
     * Backlinks are not in `resolvedLinks` (it maps a file to what it links to),
     * so one bounded pass over the sources collects the notes that point into the
     * neighbourhood, never further away than the chosen depth. Nothing is stored
     * for the rest of the vault.
     */
    private stepReverse(deadline: number): void {
        this.reverseDone = true;
        while (this.cursor < this.sources.length) {
            const path = this.sources[this.cursor];
            this.cursor += 1;
            if (path === undefined) continue;

            const targets = this.links[path];
            if (!targets) continue;

            // A note may link to several notes already in the neighbourhood: the
            // closest of them decides how far away the note itself is. Notes that
            // are already neighbours still get their lines drawn: they are links
            // between two notes that are both in the picture.
            let nearest: number | null = null;
            const edges: number[] = [];
            for (const targetPath in targets) {
                const targetHop = this.hops.get(targetPath);
                if (targetHop === undefined || targetHop + 1 > this.depth) continue;
                const target = this.selected.get(targetPath);
                if (target !== undefined) edges.push(target);
                if (nearest === null || targetHop + 1 < nearest) nearest = targetHop + 1;
            }
            if (nearest === null || edges.length === 0) continue;

            let source = this.selected.get(path);
            if (source === undefined) {
                if (this.hops.has(path)) continue;
                const added = this.addNoteNode(path);
                if (added === null) {
                    this.droppedTargets = true;
                    continue;
                }
                source = added;
                this.hops.set(path, nearest);
                // hop < depth: the walk continues from here and adds its links too
                if (nearest < this.depth) this.queue.push(path);
            }
            for (const target of edges) {
                if (target !== source) this.addEdge(source, target);
            }

            if ((this.cursor & 511) === 0 && performance.now() >= deadline) return;
        }

        this.cursor = 0;
        this.phase = 'forward';
    }

    private startScoring(): void {
        this.candidates = [...this.hops.keys()];
        // Candidates are indexed in walk order; the drawn nodes are indexed in the
        // same order, but the two are kept apart so the scoring never depends on it.
        this.candIndex = new Map();
        this.candidates.forEach((path, index) => this.candIndex.set(path, index));
        this.cursor = 0;
        // A single note is a complete answer: nothing to score or filter.
        if (this.candidates.length <= 1 && this.placeSet.size === 0) {
            this.extrasSnapshot = this.nodes.filter((node) => node.type === 'note');
            this.phase = 'collect';
            return;
        }
        this.phase = 'cohort';
    }

    /**
     * One pass over the vault collects what the scoring needs: the vault-wide
     * link count of every candidate (a hub is not closer to this note than to a
     * random one) and the weighted links pointing into candidates.
     */
    private stepCohort(deadline: number): void {
        while (this.cursor < this.sources.length) {
            const path = this.sources[this.cursor];
            this.cursor += 1;
            if (path === undefined) continue;

            const targets = this.links[path];
            if (!targets) continue;
            const sourceIndex = this.candIndex.get(path);
            let count = 0;

            for (const targetPath in targets) {
                count += 1;
                if (!this.hops.has(targetPath)) continue;
                this.inDegrees.set(targetPath, (this.inDegrees.get(targetPath) ?? 0) + 1);
                if (sourceIndex === undefined) continue;
                const targetIndex = this.candIndex.get(targetPath);
                if (targetIndex === undefined || targetIndex === sourceIndex) continue;
                const weight = targets[targetPath] ?? 1;
                const list = this.inLinks.get(targetIndex);
                if (list) list.push(sourceIndex, weight);
                else this.inLinks.set(targetIndex, [sourceIndex, weight]);
            }

            this.totalOut += count;
            this.totalIn += count;

            if ((this.cursor & 511) === 0 && performance.now() >= deadline) return;
        }

        // A note linked to by a large part of the vault is a table of contents.
        // Decided here, before the scoring walk, because such a note must not act
        // as a path: it lists notes, it does not connect them.
        const notes = this.sources.length;
        if (notes >= INDEX_MIN_NOTES) {
            const indexDegree = Math.max(INDEX_MIN_DEGREE, Math.floor(notes * INDEX_DEGREE_SHARE));
            const rootPath = this.options.rootPath;
            for (const node of this.nodes) {
                if (node.type !== 'note' || node.context === true) continue;
                // The open note is never background: it is what the panel is about.
                if (node.path === rootPath) continue;
                const linkCount = (this.links[node.path] ? Object.keys(this.links[node.path] ?? {}).length : 0)
                    + (this.inDegrees.get(node.path) ?? 0);
                if (linkCount >= indexDegree) {
                    node.context = true;
                    this.indexIndexes.add(this.candIndex.get(node.path) ?? -1);
                }
            }
        }

        this.cursor = 0;
        this.phase = 'adjacency';
    }

    /**
     * The undirected link weights of every candidate, restricted to the
     * candidates themselves. The walk is undirected on purpose: being linked to
     * and linking to matter the same when measuring distance.
     */
    private stepAdjacency(deadline: number): void {
        const count = this.candidates.length;
        if (this.walkAdj.length !== count) {
            this.walkAdj = Array.from({ length: count }, () => []);
            this.walkDeg = new Float64Array(count);
            this.mass = new Float64Array(count);
            this.massNext = new Float64Array(count);
        }

        while (this.cursor < count) {
            const index = this.cursor;
            const path = this.candidates[index];
            this.cursor += 1;
            if (path === undefined) continue;

            const row = this.walkAdj[index];
            if (!row) continue;
            const targets = this.links[path];
            const seen = new Set<number>();
            if (targets) {
                for (const targetPath in targets) {
                    const targetIndex = this.candIndex.get(targetPath);
                    if (targetIndex === undefined || targetIndex === index) continue;
                    if (seen.has(targetIndex)) continue;
                    seen.add(targetIndex);
                    row.push(targetIndex, targets[targetPath] ?? 1);
                }
            }
            for (const [sourceIndex, weight] of this.pairs(this.inLinks.get(index))) {
                if (seen.has(sourceIndex)) continue;
                seen.add(sourceIndex);
                row.push(sourceIndex, weight);
            }
            // A note filed next to the open one is a neighbour even without a link,
            // but a real link always outweighs the mere fact of sharing a folder.
            // The open note therefore also keeps an edge back to each of them.
            const placeIsRoot = path === this.options.rootPath;
            if (this.placeSet.has(path) || placeIsRoot) {
                const mates = placeIsRoot ? this.placeSet : new Set([this.options.rootPath ?? '']);
                for (const other of mates) {
                    const otherIndex = this.candIndex.get(other);
                    if (otherIndex === undefined || otherIndex === index || seen.has(otherIndex)) continue;
                    seen.add(otherIndex);
                    row.push(otherIndex, PLACE_WEIGHT);
                }
            }

            let degree = 0;
            for (let pair = 1; pair < row.length; pair += 2) degree += row[pair] ?? 0;
            this.walkDeg[index] = degree;

            if ((this.cursor & 127) === 0 && performance.now() >= deadline) return;
        }

        this.rootIndex = this.candidates.indexOf(this.options.rootPath ?? '');
        this.mass.fill(0);
        this.massNext.fill(0);
        if (this.rootIndex >= 0) this.mass[this.rootIndex] = 1;
        this.cursor = 0;
        this.iteration = 0;
        this.rankIndex = 0;
        this.dangling = 0;
        this.phase = 'rank';
    }

    /** Reads the flat (index, weight) pairs of a candidate's incoming links. */
    private *pairs(list: number[] | undefined): Generator<[number, number]> {
        if (!list) return;
        for (let at = 0; at + 1 < list.length; at += 2) {
            const index = list[at];
            const weight = list[at + 1];
            if (index === undefined || weight === undefined) continue;
            yield [index, weight];
        }
    }

    /**
     * Focused PageRank: mass starts on the open note, walks the links in both
     * directions and restarts there. Notes linked many times keep more mass, and
     * a hub spreads its mass thin over everything it links to.
     *
     * A pass may be stopped between nodes and resumed by the next step, so even a
     * zero time budget still makes progress.
     */
    private stepRank(deadline: number): void {
        const count = this.candidates.length;
        while (this.iteration < WALK_ITERATIONS) {
            if (this.rankIndex === 0) {
                this.massNext.fill(0);
                this.dangling = 0;
            }

            while (this.rankIndex < count) {
                const index = this.rankIndex;
                this.rankIndex += 1;
                const mass = this.mass[index] ?? 0;
                if (mass <= 0) continue;

                const row = this.walkAdj[index];
                const degree = this.walkDeg[index] ?? 0;
                // An index note is an endpoint: mass that reaches it goes back to
                // the open note instead of spreading over everything it lists.
                if (!row || degree <= 0 || this.indexIndexes.has(index)) {
                    this.dangling += mass;
                    continue;
                }
                const share = (WALK_DAMPING * mass) / degree;
                for (let pair = 0; pair + 1 < row.length; pair += 2) {
                    const target = row[pair];
                    const weight = row[pair + 1];
                    if (target === undefined || weight === undefined) continue;
                    this.massNext[target] = (this.massNext[target] ?? 0) + share * weight;
                }

                if ((this.rankIndex & 255) === 0 && performance.now() >= deadline) return;
            }

            const restart = (1 - WALK_DAMPING) + WALK_DAMPING * this.dangling;
            if (this.rootIndex >= 0) {
                this.massNext[this.rootIndex] = (this.massNext[this.rootIndex] ?? 0) + restart;
            }

            const swap = this.mass;
            this.mass = this.massNext;
            this.massNext = swap;
            this.rankIndex = 0;
            this.iteration += 1;

            if (performance.now() >= deadline) return;
        }

        this.cursor = 0;
        this.phase = 'select';
    }

    /**
     * Keeps the notes that are genuinely close: everything the open note links
     * to directly, then the notes that are measurably closer to it than to a
     * random note, then the node budget.
     */
    private stepSelect(): void {
        const share = RELEVANCE_SHARES[this.options.relevance ?? 'normal'];
        const totalDegree = this.totalOut + this.totalIn;

        const deep: GraphNode[] = [];
        const direct: GraphNode[] = [];
        for (const node of this.nodes) {
            // Attachments reached through links are picked like notes: they are part
            // of the picture, only drawn in their own colour (see `typeForPath`).
            const isNote = node.type === 'note';
            if (!isNote && node.type !== 'attachment') continue;
            const path = node.path;
            const candidate = this.candIndex.get(path) ?? -1;
            // A note with no links at all still counts as one link's worth, or the
            // comparison with the whole vault would have nothing to divide by.
            const linkCount = Math.max(1,
                (this.links[path] ? Object.keys(this.links[path]).length : 0)
                + (this.inDegrees.get(path) ?? 0));
            const mass = candidate >= 0 && !this.indexIndexes.has(candidate) ? (this.mass[candidate] ?? 0) : 0;
            const nodeLift = totalDegree > 0 ? (mass * totalDegree) / linkCount : 0;
            this.lift.set(path, nodeLift);
            node.score = nodeLift;

            if ((this.hops.get(path) ?? 0) <= 1) direct.push(node);
            else deep.push(node);
        }

        deep.sort((a, b) => (this.lift.get(b.path) ?? 0) - (this.lift.get(a.path) ?? 0));
        // Notes filed next to the open one are neighbours by place, not by links, so
        // their score is low. When a hub has more direct neighbours than the node
        // budget allows, they must not be the ones dropped: the place neighbours are
        // kept ahead of the rest of the first ring.
        const placeFirst = (node: GraphNode): number => (this.placeSet.has(node.path) ? 1 : 0);
        direct.sort((a, b) => placeFirst(b) - placeFirst(a)
            || (this.lift.get(b.path) ?? 0) - (this.lift.get(a.path) ?? 0));

        const strongest = deep.length > 0 ? (this.lift.get(deep[0]?.path ?? '') ?? 0) : 0;
        const threshold = share > 0 ? Math.max(RELEVANCE_FLOOR, share * strongest) : 0;
        const keptDeep = threshold > 0
            ? deep.filter((node) => (this.lift.get(node.path) ?? 0) >= threshold)
            : deep;
        this.filteredOut = keptDeep.length < deep.length;

        // The direct links of the open note are the answer itself; the budget
        // trims the rest by how close it is.
        const kept = new Map<string, GraphNode>();
        for (const node of direct.slice(0, Math.max(this.options.limit, 0))) kept.set(node.path, node);
        let trimmed = kept.size < direct.length;
        for (const node of keptDeep) {
            if (kept.size >= this.options.limit) {
                trimmed = true;
                break;
            }
            kept.set(node.path, node);
        }
        if (trimmed) this.trimmedByBudget = true;

        // Only the kept notes are drawn, so every link is re-pointed at them and
        // the degrees become the degrees inside the picture.
        const oldToNew = new Map<number, number>();
        const keptNodes: GraphNode[] = [];
        this.nodes.forEach((node, index) => {
            if (!kept.has(node.path)) return;
            oldToNew.set(index, keptNodes.length);
            keptNodes.push(node);
        });
        this.edges = this.edges
            .filter((edge) => oldToNew.has(edge.source) && oldToNew.has(edge.target))
            .map((edge) => ({
                source: oldToNew.get(edge.source) ?? edge.source,
                target: oldToNew.get(edge.target) ?? edge.target,
            }));
        this.nodes = keptNodes;
        for (const node of this.nodes) node.degree = 0;
        for (const edge of this.edges) {
            const source = this.nodes[edge.source];
            const target = this.nodes[edge.target];
            if (source) source.degree += 1;
            if (target) target.degree += 1;
        }

        this.candidates = [];
        this.candIndex = new Map();
        this.indexIndexes = new Set();
        this.walkAdj = [];
        this.walkDeg = new Float64Array(0);
        this.mass = new Float64Array(0);
        this.massNext = new Float64Array(0);
        this.inLinks = new Map();
        this.inDegrees = new Map();
        this.hops = new Map();
        this.queue = [];

        this.reindex();
        this.extrasSnapshot = this.nodes.filter((node) => node.type === 'note');
        this.cursor = 0;
        this.phase = 'collect';
    }

    /** Node indexes are the position in the drawn array, so they are rebuilt. */
    private reindex(): void {
        this.selected = new Map();
        this.nodes.forEach((node, index) => this.selected.set(node.path, index));
    }

    // -----------------------------------------------------------------------
    // Vault scope: the most connected notes
    // -----------------------------------------------------------------------

    private stepDegree(deadline: number): void {
        while (this.cursor < this.sources.length) {
            const path = this.sources[this.cursor];
            this.cursor += 1;
            if (path === undefined) continue;

            // The overview is about notes: attachments do not compete with them.
            if (typeForPath(path) !== 'note') continue;

            const targets = this.links[path];
            if (!targets) continue;
            const out = Object.keys(targets).length;
            this.heap.push({ path, title: titleFromPath(path), degree: out, type: 'note' });

            if ((this.cursor & 511) === 0 && performance.now() >= deadline) return;
        }

        this.nodes = this.heap.itemsSorted;
        this.nodes.forEach((node, index) => {
            this.selected.set(node.path, index);
            // The counted links only rank the notes. The degree the renderer uses
            // is the one inside the drawn graph — the same rule the core applies
            // when it counts a node's links (forward + reverse).
            node.degree = 0;
        });
        this.forceFocusNode();
        this.cursor = 0;
        this.phase = this.nodes.length > 0 ? 'edges' : 'collect';
        if (this.nodes.length === 0) this.phase = 'done';
    }

    /**
     * In a vault overview the open note must be in the picture: if it did not make
     * the cut, it takes the place of the weakest selected note.
     */
    private forceFocusNode(): void {
        const focusPath = this.options.focusPath;
        if (!focusPath || this.selected.has(focusPath)) return;

        const node: GraphNode = { path: focusPath, title: titleFromPath(focusPath), degree: 0, type: 'note' };
        if (this.nodes.length === 0) {
            this.nodes.push(node);
            this.selected.set(focusPath, 0);
            return;
        }
        const replaced = this.nodes.length - 1;
        const weakest = this.nodes[replaced];
        if (weakest) this.selected.delete(weakest.path);
        this.nodes[replaced] = node;
        this.selected.set(focusPath, replaced);
    }

    private stepEdges(deadline: number): void {
        while (this.cursor < this.sources.length) {
            const path = this.sources[this.cursor];
            this.cursor += 1;
            if (path === undefined) continue;

            const targets = this.links[path];
            if (!targets) continue;

            let source = this.selected.get(path);
            for (const targetPath in targets) {
                let target = this.selected.get(targetPath);

                if (target === undefined) {
                    if (source === undefined) continue;
                    const added = this.addNoteNode(targetPath);
                    if (added === null) {
                        this.droppedTargets = true;
                        continue;
                    }
                    target = added;
                }

                if (source === undefined) {
                    const added = this.addNoteNode(path);
                    if (added === null) continue;
                    source = added;
                }

                if (target === source) continue;
                this.addEdge(source, target);
            }

            if ((this.cursor & 511) === 0 && performance.now() >= deadline) return;
        }

        this.extrasSnapshot = this.nodes.filter((node) => node.type === 'note');
        this.cursor = 0;
        this.phase = 'collect';
    }

    // -----------------------------------------------------------------------
    // Tags, attachments, unresolved links and orphans
    // -----------------------------------------------------------------------

    private stepCollect(deadline: number): void {
        const collect = this.options.extras;
        const wantsExtras = typeof collect === 'function' && this.extraBudget > 0;
        while (this.cursor < this.extrasSnapshot.length) {
            const note = this.extrasSnapshot[this.cursor];
            this.cursor += 1;
            if (!note || !wantsExtras) continue;

            const extras = collect(note.path);
            if (!extras) continue;
            this.noteExtras.set(note.path, extras);

            if (extras.tags && extras.tags.length > 0) {
                const tags = this.options.showTags ? extras.tags : [];
                this.noteTags.set(note.path, tags);
                for (const tag of tags) {
                    const key = `#${tag}`;
                    this.tagCounts.set(key, (this.tagCounts.get(key) ?? 0) + 1);
                }
            }

            if ((this.cursor & 31) === 0 && performance.now() >= deadline) return;
        }

        this.chooseTags();
        this.cursor = 0;
        this.phase = 'add';
    }

    /** Tags are picked by popularity: the ones most selected notes carry. */
    private chooseTags(): void {
        if (!this.options.showTags) return;
        const tagBudget = Math.floor(this.extraBudget * TAG_BUDGET_SHARE);
        this.chosenTags = [...this.tagCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, tagBudget)
            .map(([tag]) => tag)
            .sort();
    }

    private stepAdd(deadline: number): void {
        const chosen = new Set(this.chosenTags);
        while (this.cursor < this.extrasSnapshot.length) {
            const note = this.extrasSnapshot[this.cursor];
            this.cursor += 1;
            if (!note) continue;
            const extras = this.noteExtras.get(note.path);

            if (extras) {
                for (const tag of extras.tags ?? []) {
                    const key = `#${tag}`;
                    if (chosen.has(key)) this.attachExtra(note, 'tag', key);
                }
                if (this.options.showAttachments) {
                    for (const attachment of extras.attachments ?? []) {
                        this.attachExtra(note, 'attachment', attachment);
                    }
                }
                if (this.options.includeUnresolved) {
                    for (const unresolved of extras.unresolved ?? []) {
                        this.attachExtra(note, 'unresolved', unresolved);
                    }
                }
            }

            if ((this.cursor & 15) === 0 && performance.now() >= deadline) return;
        }

        // Orphans are a vault-wide idea: in a neighbourhood they would be noise.
        if (this.scope !== 'local' && this.options.orphanPaths && this.options.orphanPaths.length > 0) {
            const max = Math.max(this.options.maxOrphans ?? 0, 0);
            for (const path of this.options.orphanPaths.slice(0, max)) {
                if (this.selected.has(path)) continue;
                this.addExtraNode(path, 'note');
            }
        }

        this.applyIndexHandling();
        this.applyColorGroups(this.options.colorGroups ?? []);
        this.phase = 'done';
    }

    /**
     * Index notes tie most of the vault together, so their links say nothing
     * about the open note: in the local scope they are drawn as dimmed context
     * without lines, or left out entirely.
     */
    private applyIndexHandling(): void {
        if (this.scope !== 'local') return;
        const handling = this.options.indexHandling ?? 'context';
        if (handling === 'core') return;

        // The open note's own links stay visible even when they lead to an index:
        // its table of contents is a real link of this note.
        const root = this.options.rootPath;
        const isContext = (node: GraphNode | undefined) => node?.context === true;
        const touchesRoot = (edge: GraphEdge): boolean =>
            (this.nodes[edge.source]?.path === root) || (this.nodes[edge.target]?.path === root);

        if (handling === 'hidden') {
            const keptNodes: GraphNode[] = [];
            const oldToNew = new Map<number, number>();
            this.nodes.forEach((node, index) => {
                if (node.context === true) return;
                oldToNew.set(index, keptNodes.length);
                keptNodes.push(node);
            });
            this.edges = this.edges
                .filter((edge) => oldToNew.has(edge.source) && oldToNew.has(edge.target))
                .map((edge) => ({
                    source: oldToNew.get(edge.source) ?? edge.source,
                    target: oldToNew.get(edge.target) ?? edge.target,
                }));
            this.nodes = keptNodes;
            this.reindex();
        } else {
            this.edges = this.edges.filter((edge) => touchesRoot(edge)
                || (!isContext(this.nodes[edge.source]) && !isContext(this.nodes[edge.target])));
        }

        for (const node of this.nodes) node.degree = 0;
        for (const edge of this.edges) {
            const source = this.nodes[edge.source];
            const target = this.nodes[edge.target];
            if (source) source.degree += 1;
            if (target) target.degree += 1;
        }
    }

    private attachExtra(note: GraphNode, type: GraphNodeType, key: string): void {
        if (key === '' || key === note.path) return;
        const source = this.selected.get(note.path);
        if (source === undefined) return;
        const target = this.addExtraNode(key, type);
        if (target === null || target === source) return;
        this.addEdge(source, target);
    }

    // -----------------------------------------------------------------------
    // Node and edge bookkeeping
    // -----------------------------------------------------------------------

    private addNoteNode(path: string): number | null {
        const existing = this.selected.get(path);
        if (existing !== undefined) return existing;
        // A local graph first gathers candidates to score, a vault overview stops
        // at the node budget.
        const bound = this.scope === 'local' ? MAX_CANDIDATES : this.options.limit;
        if (this.nodes.length >= bound) return null;
        const index = this.nodes.length;
        this.nodes.push({ path, title: titleFromPath(path), degree: 0, type: typeForPath(path) });
        this.selected.set(path, index);
        return index;
    }

    private addExtraNode(path: string, type: GraphNodeType): number | null {
        const existing = this.selected.get(path);
        if (existing !== undefined) return existing;
        if (this.extrasUsed >= this.extraBudget) return null;
        const index = this.nodes.length;
        this.extrasUsed += 1;
        this.nodes.push({
            path,
            title: type === 'tag' ? path : titleFromPath(path),
            degree: 0,
            type,
        });
        this.selected.set(path, index);
        return index;
    }

    private addEdge(source: number, target: number): void {
        const low = Math.min(source, target);
        const high = Math.max(source, target);
        const key = `${low}:${high}`;
        if (this.edgeKeys.has(key)) return;
        if (this.edges.length >= this.options.maxEdges) {
            this.cappedEdges = true;
            return;
        }
        this.edgeKeys.add(key);
        this.edges.push({ source: low, target: high });
        const lowNode = this.nodes[low];
        const highNode = this.nodes[high];
        if (lowNode) lowNode.degree += 1;
        if (highNode) highNode.degree += 1;
    }

    /** Colours from the vault's colour groups; the last matching group wins. */
    private applyColorGroups(groups: ColorGroup[]): void {
        if (groups.length === 0) return;
        for (const node of this.nodes) {
            const match = matchColorGroup(groups, {
                path: node.path,
                title: node.title,
                tags: this.noteTags.get(node.path) ?? [],
            });
            if (!match) continue;
            node.color = match.color;
            node.colorAlpha = match.alpha;
        }
    }
}

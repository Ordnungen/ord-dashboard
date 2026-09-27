import { setIcon, type App } from 'obsidian';
import { t } from './i18n';
import { GraphLayout } from './graph-layout';
import { OverviewSampler, type GraphExtras, type IndexHandling, type OverviewGraph, type RelevanceLevel } from './graph-model';
import { CORE_DEFAULTS, readVaultGraphParams, SIM_CONSTANTS, type GraphParams } from './graph-params';
import {
    buildAdjacency,
    fitViewport,
    pickNode,
    readGraphTheme,
    renderGraph,
    type GraphScene,
    type GraphTheme,
    type GraphViewport,
} from './graph-render';

export interface GraphSettings {
    nodes: number;
    scope: 'local' | 'vault';
    depth: number;
    relevance: RelevanceLevel;
    indexNotes: IndexHandling;
    /** Treat notes filed next to the open note as its neighbours. */
    place: boolean;
    animate: boolean;
    /** Multiplier for node sizes in the panel (1 = exactly as the core). */
    nodeScale: number;
}

/** A folder only means "these belong together" while it is small enough. */
const PLACE_FOLDER_LIMIT = 50;

export interface GraphBlockOptions {
    app: App;
    getSettings: () => GraphSettings;
    onOpenNote: (path: string) => void;
    onToggleCollapse: () => void;
}

const STEP_BUDGET_MS = 4;
const MAX_EDGES = 1500;
/** Orphans are capped like everything else, and so is the scan that finds them. */
const MAX_ORPHANS = 30;
const ORPHAN_SCAN_LIMIT = 20_000;
/** Core zoom limits and smoothing. */
const MIN_SCALE = SIM_CONSTANTS.minScale;
const MAX_SCALE = SIM_CONSTANTS.maxScale;
const ZOOM_SMOOTHING = SIM_CONSTANTS.zoomSmoothing;
/** Without animation the layout settles in a few hidden steps. */
const FAST_FORWARD_TICKS = 30;
const ZOOM_EPSILON = 0.01;
/** Waiting time before the graph is rebuilt around a newly opened note. */
const FOCUS_REBUILD_DELAY_MS = 600;

/**
 * Link graph pinned to the bottom of the panel.
 *
 * It is a bounded overview of the whole vault, laid out by a port of the core
 * graph simulation and drawn with the core's own formulas, so it looks and
 * behaves like the graph view — without ever walking the vault on the main
 * thread: the link index is sampled in idle steps, the simulation stops when it
 * settles, and everything is capped by the node budget.
 */
export class GraphBlock {
    readonly element: HTMLElement;

    private readonly options: GraphBlockOptions;
    private readonly iconEl: HTMLSpanElement;
    private readonly statsEl: HTMLElement;
    private statusEl: HTMLElement;
    private canvasWrap: HTMLElement;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D | null;
    private sampler: OverviewSampler | null = null;
    private graph: OverviewGraph | null = null;
    private layout: GraphLayout | null = null;
    private adjacency: number[][] = [];
    private theme: GraphTheme;
    private params: GraphParams = { ...CORE_DEFAULTS };
    private viewport: GraphViewport = { scale: 1, offsetX: 0, offsetY: 0 };
    private targetScale = 1;
    /** Zoom the current graph was fitted to; the label fade counts from it. */
    private fitScale = 1;
    private zoomCenterX = 0;
    private zoomCenterY = 0;

    private width = 0;
    private height = 0;
    private dpr = 1;

    private collapsed = false;
    private pendingBuild = false;
    private needsRebuild = false;
    private disposed = false;
    private buildToken = 0;

    private hovered = -1;
    private dragged = -1;
    private panning = false;
    private moved = false;
    private panStartX = 0;
    private panStartY = 0;
    private pointerId: number | null = null;
    /** While the layout is settling, keep the whole graph in view. */
    private autoFit = true;
    /** Note that is open right now; it stays highlighted and always in the graph. */
    private activePath = '';
    private focusedIndex = -1;
    private focusTimer: number | null = null;
    /** The note the current graph was built for; avoids pointless rebuilds. */
    private builtFor = '';

    private rafId: number | null = null;
    private idleId: number | null = null;
    private idleTimer: number | null = null;
    private resizeObserver: ResizeObserver | null = null;

    constructor(options: GraphBlockOptions) {
        this.options = options;

        this.element = createDiv({ cls: 'ord-dashboard__graph' });
        const header = this.element.createDiv({ cls: 'ord-dashboard__graph-header' });
        this.iconEl = header.createSpan({ cls: 'ord-dashboard__section-icon' });
        setIcon(this.iconEl, 'chevron-down');
        header.createDiv({ cls: 'ord-dashboard__section-title', text: t('graphTitle') });
        this.statsEl = header.createSpan({ cls: 'ord-dashboard__graph-stats' });

        const actions = header.createDiv({ cls: 'ord-dashboard__graph-actions' });
        this.createIconButton(actions, 'refresh-cw', t('graphRebuild'), () => this.rebuild());
        this.createIconButton(actions, 'maximize', t('graphFit'), () => this.fit());

        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.addEventListener('click', () => this.options.onToggleCollapse());
        header.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.options.onToggleCollapse();
            }
        });

        const body = this.element.createDiv({ cls: 'ord-dashboard__graph-body' });
        this.canvasWrap = body.createDiv({ cls: 'ord-dashboard__graph-canvas-wrap' });
        this.canvas = this.canvasWrap.createEl('canvas', { cls: 'ord-dashboard__graph-canvas' });
        this.ctx = this.canvas.getContext('2d');
        this.statusEl = body.createDiv({ cls: 'ord-dashboard__graph-status is-hidden' });
        this.theme = readGraphTheme(this.element);

        this.bindPointerEvents();

        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(() => this.resize());
            this.resizeObserver.observe(this.canvasWrap);
        }
        this.resize();
    }

    private get viewWindow(): Window {
        return this.canvas.ownerDocument.defaultView ?? window;
    }

    private createIconButton(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
        const button = parent.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': label, title: label },
        });
        setIcon(button, icon);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            action();
        });
        return button;
    }

    // -----------------------------------------------------------------------
    // Building
    // -----------------------------------------------------------------------

    /** Rebuilds the graph from the current link index. */
    rebuild(): void {
        if (this.disposed) return;
        if (this.collapsed || this.width === 0 || this.height === 0) {
            this.pendingBuild = true;
            return;
        }

        this.pendingBuild = false;
        this.needsRebuild = false;
        this.buildToken += 1;
        const token = this.buildToken;
        this.cancelPending();
        // Colors come from the theme's own CSS classes, and those need the
        // element to be in the document — rebuild runs after the panel attached it.
        this.theme = readGraphTheme(this.element);
        this.layout = null;
        this.graph = null;
        this.hovered = -1;
        this.dragged = -1;
        this.draw();

        const settings = this.options.getSettings();
        void this.loadParams().then(() => {
            if (this.disposed || token !== this.buildToken) return;
            const params = this.params;
            this.sampler = new OverviewSampler(this.options.app.metadataCache.resolvedLinks, {
                limit: Math.min(Math.max(Math.round(settings.nodes), 20), 2000),
                maxEdges: MAX_EDGES,
                scope: settings.scope,
                rootPath: this.activePath || undefined,
                depth: settings.depth,
                relevance: settings.relevance,
                indexHandling: settings.indexNotes,
                placePaths: settings.place ? this.sameFolder(this.activePath) : [],
                extraLimit: Math.max(40, Math.round(settings.nodes * 0.5)),
                showTags: params.showTags,
                showAttachments: params.showAttachments,
                includeUnresolved: !params.hideUnresolved,
                orphanPaths: params.showOrphans && settings.scope === 'vault' ? this.collectOrphans() : [],
                maxOrphans: MAX_ORPHANS,
                colorGroups: params.colorGroups,
                focusPath: this.activePath || undefined,
                extras: (path) => this.collectExtras(path),
            });
            this.setStatus(t('graphBuilding', { percent: '0' }));
            this.scheduleStep(token);
        });
    }

    /**
     * Everything the core graph takes from a note's metadata for its extra node
     * types: inline and frontmatter tags, links that point at attachments and
     * links that point nowhere. Only selected notes are asked about.
     */
    private collectExtras(path: string): GraphExtras | null {
        const file = this.options.app.vault.getFileByPath(path);
        if (!file) return null;
        const cache = this.options.app.metadataCache.getFileCache(file);
        if (!cache) return null;

        const tags: string[] = [];
        const addTag = (value: unknown): void => {
            if (typeof value !== 'string') return;
            const name = value.replace(/^#/, '').trim();
            if (name === '' || tags.some((existing) => existing.toLowerCase() === name.toLowerCase())) return;
            tags.push(name);
        };
        for (const tag of cache.tags ?? []) addTag(tag.tag);
        const frontmatterTags: unknown = cache.frontmatter?.['tags'];
        if (Array.isArray(frontmatterTags)) frontmatterTags.forEach(addTag);
        else addTag(frontmatterTags);

        const attachments: string[] = [];
        const unresolved: string[] = [];
        const resolve = (linkText: string): void => {
            if (linkText === '' || linkText.startsWith('#')) return;
            const target = this.options.app.metadataCache.getFirstLinkpathDest(linkText, path);
            if (!target) {
                if (!unresolved.includes(linkText)) unresolved.push(linkText);
                return;
            }
            if (target.extension !== 'md' && !attachments.includes(target.path)) attachments.push(target.path);
        };
        for (const link of cache.links ?? []) resolve(link.link);
        for (const embed of cache.embeds ?? []) resolve(embed.link);

        return { tags, attachments, unresolved };
    }

    /**
     * Notes without outgoing links, added as isolated nodes when the vault's
     * graph settings show orphans. The scan is bounded so a huge vault cannot
     * stall the panel.
     */
    private collectOrphans(): string[] {
        const links = this.options.app.metadataCache.resolvedLinks;
        const result: string[] = [];
        let inspected = 0;
        for (const file of this.options.app.vault.getMarkdownFiles()) {
            inspected += 1;
            if (inspected > ORPHAN_SCAN_LIMIT) break;
            if (links[file.path] !== undefined) continue;
            result.push(file.path);
            if (result.length >= MAX_ORPHANS) break;
        }
        return result;
    }

    /** Force and render parameters: the vault's own look, core force defaults. */
    private async loadParams(): Promise<void> {
        this.params = await readVaultGraphParams(this.options.app);
    }

    /**
     * Tells the graph which note is open. The note is highlighted right away, and
     * if it is not part of the current picture the graph is rebuilt around it.
     */
    /**
     * Notes filed next to the open one. A folder says "these belong together"
     * while it is small enough; a huge folder (or a flat vault, where everything
     * shares one folder) says nothing and is ignored.
     */
    private sameFolder(path: string): string[] {
        if (!path) return [];
        const folder = path.slice(0, path.lastIndexOf('/'));
        const mates: string[] = [];
        for (const file of this.options.app.vault.getMarkdownFiles()) {
            if (file.path === path) continue;
            const parent = file.parent?.path ?? '';
            if ((parent === '/' ? '' : parent) !== folder) continue;
            mates.push(file.path);
            if (mates.length > PLACE_FOLDER_LIMIT) return [];
        }
        return mates;
    }

    setActive(path: string): void {
        if (this.activePath === path) return;
        this.activePath = path;
        const scope = this.options.getSettings().scope;

        // Locally the graph *is* the neighbourhood of the open note, so a new note
        // means a new graph. In the vault overview the note is kept in the picture.
        if (scope === 'local') {
            this.focusedIndex = -1;
            this.scheduleFocusRebuild();
            return;
        }

        const index = this.indexOfPath(path);
        this.focusedIndex = index;
        if (index >= 0) {
            this.centerOn(index);
            this.draw();
            return;
        }
        this.scheduleFocusRebuild();
    }

    private indexOfPath(path: string): number {
        if (!path || !this.graph) return -1;
        return this.graph.nodes.findIndex((node) => node.path === path);
    }

    /**
     * Brings the note into view unless the user has taken over the viewport: their
     * zoom and pan are never overridden.
     */
    private centerOn(index: number): void {
        const layout = this.layout;
        if (!layout || this.autoFit || index < 0 || index >= layout.nodeCount) return;
        this.viewport.offsetX = this.width / 2 - (layout.x[index] ?? 0) * this.viewport.scale;
        this.viewport.offsetY = this.height / 2 - (layout.y[index] ?? 0) * this.viewport.scale;
    }

    /** The note that is open is not in the sample yet: rebuild around it. */
    private scheduleFocusRebuild(): void {
        if (this.focusTimer !== null) this.viewWindow.clearTimeout(this.focusTimer);
        this.focusTimer = this.viewWindow.setTimeout(() => {
            this.focusTimer = null;
            if (this.disposed) return;
            // The current graph may already be built for this note: no work then.
            if (this.builtFor === this.activePath) return;
            this.markStale();
            this.refreshIfStale();
        }, FOCUS_REBUILD_DELAY_MS);
    }

    /** Rebuilds only when something changed and the graph is actually visible. */
    refreshIfStale(): void {
        if (!this.needsRebuild || this.collapsed || this.disposed) return;
        if (!this.element.isShown()) return;
        this.rebuild();
    }

    markStale(): void {
        this.needsRebuild = true;
    }

    private scheduleStep(token: number): void {
        if (this.disposed || token !== this.buildToken) return;
        const run = (): void => {
            this.idleId = null;
            this.idleTimer = null;
            const sampler = this.sampler;
            if (!sampler || this.disposed || token !== this.buildToken) return;

            if (!sampler.step(STEP_BUDGET_MS)) {
                this.setStatus(t('graphBuilding', { percent: String(Math.round(sampler.progress * 100)) }));
                this.scheduleStep(token);
                return;
            }
            this.finishBuild(sampler.result);
        };

        const win = this.viewWindow;
        if (typeof win.requestIdleCallback === 'function') {
            this.idleId = win.requestIdleCallback(run, { timeout: 500 });
        } else {
            this.idleTimer = win.setTimeout(run, 16);
        }
    }

    private finishBuild(graph: OverviewGraph | null): void {
        this.sampler = null;
        this.setStatus('');

        if (!graph || graph.nodes.length === 0) {
            this.graph = null;
            this.layout = null;
            this.setStatus(t('graphEmpty'));
            this.updateStats();
            this.draw();
            return;
        }

        this.graph = graph;
        this.adjacency = buildAdjacency(graph.nodes, graph.edges);
        this.layout = new GraphLayout(graph.nodes, graph.edges, this.params);
        this.autoFit = true;
        this.builtFor = this.activePath;
        this.focusedIndex = this.indexOfPath(this.activePath);
        this.updateStats();
        this.startLoop();
        if (this.focusedIndex >= 0 && !this.autoFit) this.centerOn(this.focusedIndex);
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------

    private startLoop(): void {
        if (this.disposed || this.collapsed || this.rafId !== null) return;
        const animate = this.options.getSettings().animate;

        const step = (): void => {
            this.rafId = null;
            const layout = this.layout;
            if (this.disposed || !layout) return;

            if (layout.frozen && !this.isZooming()) {
                this.draw();
                return;
            }

            if (animate) {
                layout.tick(layout.ticksPerFrame());
                this.animateZoom();
                this.autoFitGraph();
                this.draw();
            } else {
                // No animation: settle silently in a few steps, then paint once.
                layout.tick(FAST_FORWARD_TICKS);
                this.animateZoom();
                this.autoFitGraph();
                if (layout.frozen && !this.isZooming()) this.draw();
            }
            this.rafId = this.viewWindow.requestAnimationFrame(step);
        };
        this.rafId = this.viewWindow.requestAnimationFrame(step);
    }

    private stopLoop(): void {
        if (this.rafId === null) return;
        this.viewWindow.cancelAnimationFrame(this.rafId);
        this.rafId = null;
    }

    private isZooming(): boolean {
        const ratio = this.viewport.scale / this.targetScale;
        return Math.abs(ratio - 1) >= ZOOM_EPSILON;
    }

    /** Core zoom animation: move the scale towards the target around a fixed point. */
    private animateZoom(): void {
        if (!this.isZooming()) {
            this.viewport.scale = this.targetScale;
            return;
        }
        const next = this.viewport.scale * ZOOM_SMOOTHING + this.targetScale * (1 - ZOOM_SMOOTHING);
        this.applyScale(next, this.zoomCenterX, this.zoomCenterY);
    }

    /** Keeps the graph point under (centerX, centerY) in place. */
    private applyScale(scale: number, centerX: number, centerY: number): void {
        const worldX = (centerX - this.viewport.offsetX) / this.viewport.scale;
        const worldY = (centerY - this.viewport.offsetY) / this.viewport.scale;
        this.viewport.scale = scale;
        this.viewport.offsetX = centerX - worldX * scale;
        this.viewport.offsetY = centerY - worldY * scale;
    }

    private scene(): GraphScene {
        const graph = this.graph;
        const layout = this.layout;
        return {
            nodes: graph?.nodes ?? [],
            edges: graph?.edges ?? [],
            positions: { x: layout?.x ?? new Float32Array(0), y: layout?.y ?? new Float32Array(0) },
            adjacency: this.adjacency,
            theme: this.theme,
            params: this.params,
            viewport: this.viewport,
            fitScale: this.fitScale,
            width: this.width,
            height: this.height,
            hovered: this.hovered,
            focused: this.focusedIndex,
            sizeScale: this.options.getSettings().nodeScale,
        };
    }

    private draw(): void {
        const ctx = this.ctx;
        if (!ctx) return;
        if (!this.graph || !this.layout || this.width === 0 || this.height === 0) {
            ctx.clearRect(0, 0, this.width, this.height);
            return;
        }
        renderGraph({ ...this.scene(), ctx });
    }

    private resize(): void {
        const width = Math.max(this.canvasWrap.clientWidth, 1);
        const height = Math.max(this.canvasWrap.clientHeight, 1);
        const dpr = this.viewWindow.devicePixelRatio || 1;

        if (width === this.width && height === this.height && dpr === this.dpr) {
            if (this.pendingBuild) this.rebuild();
            return;
        }

        const previousWidth = this.width;
        const previousHeight = this.height;
        this.width = width;
        this.height = height;
        this.dpr = dpr;
        if (previousWidth === 0 || previousHeight === 0) {
            // First real layout: now the theme can be resolved.
            this.theme = readGraphTheme(this.element);
        }
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
        this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (this.pendingBuild) {
            this.rebuild();
            return;
        }
        if (previousWidth > 0 && previousHeight > 0) {
            // Keep the view centerd when the panel is resized.
            this.viewport.offsetX += (width - previousWidth) / 2;
            this.viewport.offsetY += (height - previousHeight) / 2;
        } else {
            this.viewport.offsetX = width / 2;
            this.viewport.offsetY = height / 2;
        }
        this.draw();
    }

    updateTheme(): void {
        this.theme = readGraphTheme(this.element);
        this.draw();
    }

    /** Applies new settings without rebuilding the sample. */
    applySettings(): void {
        const previous = this.params;
        void this.loadParams().then(() => {
            if (this.disposed) return;
            if (JSON.stringify(previous) === JSON.stringify(this.params)) {
                this.startLoop();
                return;
            }
            this.layout?.setParams(this.params);
            this.autoFit = true;
            this.startLoop();
        });
    }

    private updateStats(): void {
        const graph = this.graph;
        if (!graph) {
            this.statsEl.setText('');
            return;
        }
        let text = t('graphStats', { nodes: String(graph.nodes.length), edges: String(graph.edges.length) });
        if (graph.filtered) text += ` · ${t('graphFiltered')}`;
        if (graph.truncated) {
            const total = this.options.app.vault.getMarkdownFiles().length;
            text += ` · ${t('graphTruncated', { total: String(total) })}`;
        }
        this.statsEl.setText(text);
    }

    private setStatus(text: string): void {
        this.statusEl.setText(text);
        this.statusEl.toggleClass('is-hidden', text === '');
    }

    // -----------------------------------------------------------------------
    // Interaction
    // -----------------------------------------------------------------------

    private bindPointerEvents(): void {
        const canvas = this.canvas;

        canvas.addEventListener('pointerdown', (event) => {
            if (!this.layout) return;
            this.stopAutoFit();
            const point = this.localPoint(event);
            this.pointerId = event.pointerId;
            this.moved = false;
            canvas.setPointerCapture(event.pointerId);
            canvas.toggleClass('is-grabbing', true);

            const hit = pickNode(this.scene(), point.x, point.y);
            if (hit >= 0) {
                this.dragged = hit;
                this.hovered = hit;
            } else {
                this.panning = true;
                this.panStartX = point.x - this.viewport.offsetX;
                this.panStartY = point.y - this.viewport.offsetY;
            }
            this.draw();
        });

        canvas.addEventListener('pointermove', (event) => {
            const point = this.localPoint(event);

            if (this.pointerId === null) {
                const hit = this.layout ? pickNode(this.scene(), point.x, point.y) : -1;
                if (hit !== this.hovered) {
                    this.hovered = hit;
                    this.draw();
                }
                return;
            }

            this.moved = true;
            if (this.dragged >= 0 && this.layout) {
                this.layout.moveNode(
                    this.dragged,
                    (point.x - this.viewport.offsetX) / this.viewport.scale,
                    (point.y - this.viewport.offsetY) / this.viewport.scale,
                );
                this.layout.reheat();
                this.startLoop();
            } else if (this.panning) {
                this.viewport.offsetX = point.x - this.panStartX;
                this.viewport.offsetY = point.y - this.panStartY;
            }
            this.draw();
        });

        const release = (event: PointerEvent): void => {
            if (this.pointerId === null) return;
            const dragged = this.dragged;
            const wasDrag = this.moved;
            this.pointerId = null;
            this.dragged = -1;
            this.panning = false;
            canvas.toggleClass('is-grabbing', false);
            if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

            if (!wasDrag && dragged >= 0) {
                const path = this.graph?.nodes[dragged]?.path;
                if (path) this.options.onOpenNote(path);
            }
            this.draw();
        };
        canvas.addEventListener('pointerup', release);
        canvas.addEventListener('pointercancel', release);

        canvas.addEventListener('pointerleave', () => {
            if (this.pointerId !== null || this.hovered === -1) return;
            this.hovered = -1;
            this.draw();
        });

        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            this.stopAutoFit();
            // Core zoom: 1.5^(-delta / 120), with the zoom center under the cursor
            // when zooming in and in the middle of the panel when zooming out.
            let delta = event.deltaY;
            if (event.deltaMode === 1) delta *= 40;
            else if (event.deltaMode === 2) delta *= 800;

            const next = clamp(this.targetScale * Math.pow(1.5, -delta / 120), MIN_SCALE, MAX_SCALE);
            this.targetScale = next;
            if (next < this.viewport.scale) {
                this.zoomCenterX = this.width / 2;
                this.zoomCenterY = this.height / 2;
            } else {
                const point = this.localPoint(event);
                this.zoomCenterX = point.x;
                this.zoomCenterY = point.y;
            }
            this.startLoop();
        }, { passive: false });

        canvas.addEventListener('dblclick', () => this.fit());
    }

    /** Keeps the whole graph in the panel until the user takes over the view. */
    private autoFitGraph(): void {
        if (!this.autoFit || !this.layout || this.layout.frozen) return;
        const fitted = fitViewport(this.scene(), 18);
        const scale = clamp(fitted.scale, MIN_SCALE, MAX_SCALE);
        this.targetScale = scale;
        this.viewport = fitted;
        // The zoom the graph was fitted to: the labels of the other notes fade in
        // as the user zooms in from here, whatever the graph's own size is.
        this.fitScale = scale;
        this.applyScale(scale, this.width / 2, this.height / 2);
    }

    private stopAutoFit(): void {
        this.autoFit = false;
    }

    private localPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    private fit(options: { animate?: boolean } = {}): void {
        if (!this.layout || !this.graph || this.width === 0) return;
        this.autoFit = true;
        const fitted = fitViewport(this.scene(), 18);
        const scale = clamp(fitted.scale, MIN_SCALE, MAX_SCALE);
        this.targetScale = scale;

        if (options.animate === false) {
            this.viewport = fitted;
            this.applyScale(scale, this.width / 2, this.height / 2);
            this.draw();
            return;
        }
        this.zoomCenterX = this.width / 2;
        this.zoomCenterY = this.height / 2;
        this.viewport.offsetX = fitted.offsetX;
        this.viewport.offsetY = fitted.offsetY;
        this.startLoop();
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    setCollapsed(collapsed: boolean): void {
        this.collapsed = collapsed;
        this.element.toggleClass('is-collapsed', collapsed);
        if (collapsed) {
            this.stopLoop();
            return;
        }
        if (this.pendingBuild || this.needsRebuild) {
            this.rebuild();
            return;
        }
        this.resize();
        this.startLoop();
    }

    dispose(): void {
        this.disposed = true;
        this.buildToken += 1;
        if (this.focusTimer !== null) {
            this.viewWindow.clearTimeout(this.focusTimer);
            this.focusTimer = null;
        }
        this.cancelPending();
        this.stopLoop();
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.element.remove();
    }

    private cancelPending(): void {
        if (this.idleId !== null) {
            this.viewWindow.cancelIdleCallback?.(this.idleId);
            this.idleId = null;
        }
        if (this.idleTimer !== null) {
            this.viewWindow.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this.sampler = null;
    }
}

function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

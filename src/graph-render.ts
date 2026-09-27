// ---------------------------------------------------------------------------
// Canvas rendering — a port of the core graph renderer
//
// The core draws through PIXI (WebGL). The equations below are taken from it and
// reimplemented on canvas 2D, which is plenty for a bounded graph:
//
//   node size   = nodeSizeMultiplier * clamp(3 * sqrt(degree + 1), 8, 30)
//   screen size = node size * sqrt(scale)          // nodeScale = sqrt(1/scale)
//   line width  = lineSizeMultiplier               // constant on screen
//   line alpha  = 0.2 when another node is hovered and this link is unrelated
//   label alpha = clamp(log2(scale) + 1 - textFadeMultiplier, 0, 1)
//   label size  = (14 + node size / 4) * sqrt(scale); the hovered one keeps its
//                 screen size and sits 15 px lower
//   arrows      = optional, fade in with zoom (2 * (scale - 0.3), clamped to 1)
//
// Colours are read from the very same CSS classes the core uses, so any theme
// that styles the graph styles ours too — including the per-type colours of
// tags, attachments and unresolved links.
// ---------------------------------------------------------------------------

import type { GraphEdge, GraphNode } from './graph-model';
import { SIM_CONSTANTS, type GraphParams } from './graph-params';

export interface ThemeColor {
    color: string;
    alpha: number;
}

/** Slots mirror the core's colour map (`u$` in app.js). */
export interface GraphTheme {
    node: ThemeColor;
    nodeFocused: ThemeColor;
    nodeTag: ThemeColor;
    nodeAttachment: ThemeColor;
    nodeUnresolved: ThemeColor;
    nodeHighlight: ThemeColor;
    line: ThemeColor;
    lineHighlight: ThemeColor;
    text: ThemeColor;
    arrow: ThemeColor;
}

export interface GraphViewport {
    scale: number;
    offsetX: number;
    offsetY: number;
}

export interface GraphScene {
    nodes: GraphNode[];
    edges: GraphEdge[];
    positions: { x: Float32Array; y: Float32Array };
    adjacency: number[][];
    theme: GraphTheme;
    params: GraphParams;
    viewport: GraphViewport;
    /**
     * The scale the graph was fitted to — the zoom the panel chose so the whole
     * picture fits. Labels of the other notes fade in relative to this, not to an
     * absolute zoom, so a small graph does not show every name at once.
     */
    fitScale: number;
    width: number;
    height: number;
    hovered: number;
    /**
     * The note that is open right now. It keeps its ring and its label, so the
     * panel always shows where the user is, and it never fades out.
     */
    focused: number;
    /**
     * Multiplier for node sizes. The core sizes nodes for a large graph window;
     * a small panel needs the same formula scaled down, or every hub turns into
     * a blob. 1 means "exactly as the core computes it".
     */
    sizeScale: number;
}

export type RenderParams = GraphScene & { ctx: CanvasRenderingContext2D };

/** Maps our colour slots to the core graph's CSS classes. */
const COLOR_CLASSES: Record<keyof GraphTheme, string> = {
    node: 'color-fill',
    nodeFocused: 'color-fill-focused',
    nodeTag: 'color-fill-tag',
    nodeAttachment: 'color-fill-attachment',
    nodeUnresolved: 'color-fill-unresolved',
    nodeHighlight: 'color-fill-highlight',
    line: 'color-line',
    lineHighlight: 'color-line-highlight',
    text: 'color-text',
    arrow: 'color-arrow',
};

const FALLBACKS: Record<keyof GraphTheme, ThemeColor> = {
    node: { color: '#888888', alpha: 1 },
    nodeFocused: { color: '#8ab4f8', alpha: 1 },
    nodeTag: { color: '#8ab4f8', alpha: 1 },
    nodeAttachment: { color: '#888888', alpha: 1 },
    nodeUnresolved: { color: '#888888', alpha: 0.5 },
    nodeHighlight: { color: '#8ab4f8', alpha: 1 },
    line: { color: '#cccccc', alpha: 1 },
    lineHighlight: { color: '#8ab4f8', alpha: 1 },
    text: { color: '#dddddd', alpha: 1 },
    arrow: { color: '#dddddd', alpha: 0.5 },
};

/** Alpha of everything unrelated to the hovered node (core constant `e$`). */
export const FADE_ALPHA = SIM_CONSTANTS.fadeAlpha;

/**
 * Reads the colours exactly like the core does: a probe element carrying the
 * graph's CSS class, its computed colour and its opacity.
 *
 * The core appends the probe to `document.body`, and that matters: the palette
 * (`--graph-node`, `--graph-line`, …) is declared on `body`, so an element that is
 * not attached to the document resolves nothing and silently falls back to
 * inherited colours — the reason a graph can come out all white.
 */
export function readGraphTheme(host: HTMLElement): GraphTheme {
    const doc = host.ownerDocument;
    const theme = {} as GraphTheme;
    for (const key of Object.keys(COLOR_CLASSES) as (keyof GraphTheme)[]) {
        const probe = doc.body.createDiv({ cls: `graph-view ${COLOR_CLASSES[key]}` });
        const styles = getComputedStyle(probe);
        const color = styles.color.trim();
        const opacity = Number.parseFloat(styles.opacity);
        probe.remove();

        const fallback = FALLBACKS[key];
        const usable = color !== '' && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
        theme[key] = {
            color: usable ? color : fallback.color,
            alpha: Number.isFinite(opacity) ? opacity : fallback.alpha,
        };
    }
    return theme;
}

/**
 * Index notes (tables of contents) are context, not connections: they are drawn
 * smaller and faded so the lines between the notes that matter stand out.
 */
export const CONTEXT_ALPHA = 0.45;
export const CONTEXT_SIZE = 0.7;

/**
 * Opacity of a node's dot and label. Background context fades; a node the user is
 * looking at or hovering never does, whatever kind of note it is.
 */
export function nodeAlpha(
    node: GraphNode,
    related: boolean,
    isHovered: boolean,
    isFocused: boolean,
): number {
    const context = node.context === true && !isHovered && !isFocused ? CONTEXT_ALPHA : 1;
    return (related ? 1 : FADE_ALPHA) * context;
}

/** Node size in graph units, exactly as the core computes it. */
export function nodeSize(node: GraphNode, params: GraphParams): number {
    const core = params.nodeSizeMultiplier * Math.max(8, Math.min(3 * Math.sqrt(node.degree + 1), 30));
    return node.context === true ? core * CONTEXT_SIZE : core;
}

/**
 * Node radius in screen pixels. The core scales its sprites by
 * `nodeScale = sqrt(1 / scale)` while the whole graph is scaled by `scale`, so
 * what is left on screen is `size * sqrt(scale)` — and, in a panel, our own
 * `sizeScale` on top of that.
 */
export function nodeRadius(node: GraphNode, params: GraphParams, scale: number, sizeScale = 1): number {
    return nodeSize(node, params) * Math.sqrt(Math.max(scale, 0.0001)) * sizeScale;
}

/**
 * How visible the labels of the *other* notes are.
 *
 * The core fades labels with the absolute zoom, which works in a full window: a
 * big graph is fitted small, so its names appear only once you zoom in. A small
 * graph is fitted large, and then every name is bright from the start — the
 * panel measures the zoom *relative to the fitted one* instead, so names are
 * hidden while the graph is merely fitted and appear as the user zooms in: first
 * faint, then bright. The open note keeps its label regardless (see `drawNodes`).
 *
 * The vault's own label-fade setting stretches or shortens that ramp ("show
 * earlier" makes names appear after a smaller zoom).
 */
export const LABEL_FADE_SPAN = 2;

export function labelAlpha(scale: number, params: GraphParams, fitScale = 1): number {
    const relative = Math.max(scale, 0.0001) / Math.max(fitScale, 0.0001);
    const span = LABEL_FADE_SPAN + Math.max(Math.min(params.textFadeMultiplier, 2), -1);
    return Math.max(0, Math.min(Math.log2(relative) / Math.max(span, 0.5), 1));
}

export function toScreen(value: number, offset: number, scale: number): number {
    return value * scale + offset;
}

/** Fill colour of a node: colour group, then node type, then the default. */
export function nodeColor(node: GraphNode, theme: GraphTheme): ThemeColor {
    if (node.color) {
        return { color: node.color, alpha: node.colorAlpha ?? 1 };
    }
    switch (node.type) {
        case 'tag': return theme.nodeTag;
        case 'attachment': return theme.nodeAttachment;
        case 'unresolved': return theme.nodeUnresolved;
        default: return theme.node;
    }
}

/**
 * Screen radius used for drawing and hit testing: the core formula, our panel
 * multiplier, and a safeguard so a hub can never grow into a blob in a small
 * panel.
 */
export function screenRadius(
    node: GraphNode,
    scene: Pick<GraphScene, 'params' | 'sizeScale' | 'width' | 'height'>,
    scale: number,
): number {
    const core = nodeRadius(node, scene.params, scale, scene.sizeScale);
    return Math.min(core, Math.min(scene.width, scene.height) * 0.05);
}

/** Index of the node under the cursor, or -1. */
export function pickNode(scene: GraphScene, screenX: number, screenY: number): number {
    const { positions, viewport, nodes } = scene;
    const worldX = (screenX - viewport.offsetX) / viewport.scale;
    const worldY = (screenY - viewport.offsetY) / viewport.scale;
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (!node) continue;
        const dx = (positions.x[index] ?? 0) - worldX;
        const dy = (positions.y[index] ?? 0) - worldY;
        const distance = Math.hypot(dx, dy);
        // The core hit test uses the on-screen radius plus a couple of pixels.
        const threshold = screenRadius(node, scene, viewport.scale) / viewport.scale + 2;
        if (distance <= threshold && distance < bestDistance) {
            bestDistance = distance;
            best = index;
        }
    }
    return best;
}

/** Scale and offset that fit the whole graph into the given box. */
export function fitViewport(scene: GraphScene, padding = 16): GraphViewport {
    const { positions, nodes, width, height } = scene;
    if (nodes.length === 0) return { scale: 1, offsetX: width / 2, offsetY: height / 2 };

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < nodes.length; index++) {
        const x = positions.x[index] ?? 0;
        const y = positions.y[index] ?? 0;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }

    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = Math.max(0.0005, Math.min(SIM_CONSTANTS.maxScale,
        Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)));
    return {
        scale,
        offsetX: width / 2 - ((minX + maxX) / 2) * scale,
        offsetY: height / 2 - ((minY + maxY) / 2) * scale,
    };
}

/**
 * Font size of a node's label.
 *
 * Core metric: the base size plus a quarter of the node's size. The panel draws
 * its dots smaller than the core window does, so the node's part is scaled with
 * the panel too — otherwise a hub's name dwarfs the dot it belongs to. Labels of
 * the other notes grow with the zoom, the open note's keeps its screen size.
 */
export function labelFontSize(
    node: GraphNode,
    params: GraphParams,
    scale: number,
    isHovered: boolean,
    isFocused: boolean,
    sizeScale = 1,
): number {
    const size = SIM_CONSTANTS.labelBaseSize + (nodeSize(node, params) * sizeScale) / 4;
    return isHovered || isFocused ? size : size * Math.sqrt(Math.max(scale, 0.0001));
}

export function renderGraph(params: RenderParams): void {
    const { ctx, nodes, adjacency, width, height } = params;
    ctx.clearRect(0, 0, width, height);

    const hovered = params.hovered;
    const hasFocus = hovered >= 0 && hovered < nodes.length;
    const neighbours = hasFocus ? new Set(adjacency[hovered] ?? []) : null;
    const related = (index: number): boolean =>
        index === params.focused
        || !hasFocus
        || index === hovered
        || (neighbours?.has(index) ?? false);

    drawLinks(params, related);
    drawNodes(params, related);

    ctx.globalAlpha = 1;
}

function drawLinks(params: RenderParams, isRelated: (index: number) => boolean): void {
    const { ctx, edges, nodes, positions, theme, params: settings, viewport, hovered } = params;
    const thickness = Math.max(settings.lineSizeMultiplier, 0.5);

    for (const edge of edges) {
        const sourceNode = nodes[edge.source];
        const targetNode = nodes[edge.target];
        if (!sourceNode || !targetNode) continue;

        const related = isRelated(edge.source) && isRelated(edge.target);
        const color = related && hovered >= 0 ? theme.lineHighlight : theme.line;
        ctx.globalAlpha = (related ? 1 : FADE_ALPHA) * color.alpha;
        ctx.strokeStyle = color.color;
        ctx.lineWidth = thickness;

        const sourceX = toScreen(positions.x[edge.source] ?? 0, viewport.offsetX, viewport.scale);
        const sourceY = toScreen(positions.y[edge.source] ?? 0, viewport.offsetY, viewport.scale);
        const targetX = toScreen(positions.x[edge.target] ?? 0, viewport.offsetX, viewport.scale);
        const targetY = toScreen(positions.y[edge.target] ?? 0, viewport.offsetY, viewport.scale);

        const dx = targetX - sourceX;
        const dy = targetY - sourceY;
        const length = Math.hypot(dx, dy);
        if (length < 0.01) continue;

        // Lines run between the circles, not between their centres.
        const sourceRadius = screenRadius(sourceNode, params, viewport.scale);
        const targetRadius = screenRadius(targetNode, params, viewport.scale);
        const startX = sourceX + (dx / length) * sourceRadius;
        const startY = sourceY + (dy / length) * sourceRadius;
        const endX = targetX - (dx / length) * targetRadius;
        const endY = targetY - (dy / length) * targetRadius;
        if (Math.hypot(endX - startX, endY - startY) < 1) continue;

        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        if (settings.showArrow) drawArrow(ctx, params, startX, startY, endX, endY, related);
    }
}

function drawArrow(
    ctx: CanvasRenderingContext2D,
    params: RenderParams,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    related: boolean,
): void {
    // Core: arrows only appear once the view is zoomed in.
    const zoomAlpha = Math.max(0, Math.min(2 * (params.viewport.scale - 0.3), 1));
    const alpha = (related ? 1 : FADE_ALPHA) * zoomAlpha * params.theme.arrow.alpha;
    if (alpha <= 0.001) return;

    const angle = Math.atan2(endY - startY, endX - startX);
    const size = 2 * Math.sqrt(Math.max(params.params.lineSizeMultiplier, 0.25));
    ctx.globalAlpha = alpha;
    ctx.fillStyle = params.theme.arrow.color;
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - Math.cos(angle - 0.5) * size * 2, endY - Math.sin(angle - 0.5) * size * 2);
    ctx.lineTo(endX - Math.cos(angle + 0.5) * size * 2, endY - Math.sin(angle + 0.5) * size * 2);
    ctx.closePath();
    ctx.fill();
}

function drawNodes(params: RenderParams, isRelated: (index: number) => boolean): void {
    const { ctx, nodes, positions, theme, params: settings, viewport, hovered, focused } = params;
    const textAlpha = labelAlpha(viewport.scale, settings, params.fitScale);

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        if (!node) continue;
        const isHovered = index === hovered;
        const isFocused = index === focused;
        const related = isRelated(index);
        const radius = screenRadius(node, params, viewport.scale);
        const x = toScreen(positions.x[index] ?? 0, viewport.offsetX, viewport.scale);
        const y = toScreen(positions.y[index] ?? 0, viewport.offsetY, viewport.scale);

        if (x + radius < 0 || y + radius < 0 || x - radius > params.width || y - radius > params.height) continue;

        // The core gives the hovered node the highlight colour, everything else
        // its own colour: a colour group, then the colour of its node type.
        const fill = isHovered ? theme.nodeHighlight : nodeColor(node, theme);
        ctx.globalAlpha = fill.alpha * nodeAlpha(node, related, isHovered, isFocused);
        ctx.fillStyle = fill.color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(radius, 0.6), 0, Math.PI * 2);
        ctx.fill();

        if (isHovered || isFocused) {
            // The core's ring colour, a little thicker for the open note.
            ctx.globalAlpha = theme.nodeFocused.alpha;
            ctx.strokeStyle = theme.nodeFocused.color;
            ctx.lineWidth = isFocused && !isHovered ? 2 : 1;
            ctx.beginPath();
            ctx.arc(x, y, Math.max(radius, 0.6) + 1.5, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Labels only fade with zoom; the hovered and open notes always keep theirs.
        const alpha = (isHovered || isFocused ? 1 : textAlpha) * nodeAlpha(node, related, isHovered, isFocused);
        if (alpha <= 0.001) continue;

        // Core label metrics: base size plus a quarter of the node size, scaled
        // with the graph; the node part is scaled with the panel as well, so a
        // hub's name never dwarfs its dot. The hovered label sits lower.
        const fontSize = labelFontSize(node, settings, viewport.scale, isHovered, isFocused, params.sizeScale);
        const offset = radius + 5 * Math.sqrt(Math.max(viewport.scale, 0.0001))
            + (isHovered || isFocused ? 15 : 0);

        ctx.globalAlpha = alpha * theme.text.alpha;
        ctx.fillStyle = theme.text.color;
        ctx.font = `${fontSize.toFixed(1)}px ${SIM_CONSTANTS.labelFont}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(node.title, x, y + offset);
    }
}

export function buildAdjacency(nodes: GraphNode[], edges: GraphEdge[]): number[][] {
    const adjacency: number[][] = nodes.map(() => []);
    for (const edge of edges) {
        adjacency[edge.source]?.push(edge.target);
        adjacency[edge.target]?.push(edge.source);
    }
    return adjacency;
}

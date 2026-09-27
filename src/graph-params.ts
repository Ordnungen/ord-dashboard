import { normalizePath, type App } from 'obsidian';

/**
 * Force, render and display parameters — everything the core Graph view stores
 * in `.obsidian/graph.json`, plus the constants its renderer uses.
 *
 * Defaults are the core ones (center 0.1, link strength 1, link distance 250,
 * repel 1000, multipliers 1, text fade 0, arrows off, tags and attachments and
 * orphans shown, unresolved links visible). When the vault has its own graph
 * settings, those win — the graph then behaves like the one the user configured.
 *
 * Reading is the only reason this module touches the Adapter: the config folder
 * is hidden from the Vault API.
 */
export interface ColorGroup {
    query: string;
    /** '#rrggbb' as stored by the core (rgb integer with alpha). */
    color: string;
    alpha: number;
}

export interface GraphParams {
    centerStrength: number;
    repelStrength: number;
    linkStrength: number;
    linkDistance: number;
    nodeSizeMultiplier: number;
    lineSizeMultiplier: number;
    textFadeMultiplier: number;
    showArrow: boolean;
    showTags: boolean;
    showAttachments: boolean;
    showOrphans: boolean;
    hideUnresolved: boolean;
    colorGroups: ColorGroup[];
}

export const CORE_DEFAULTS: GraphParams = {
    centerStrength: 0.1,
    repelStrength: 1000,
    linkStrength: 1,
    linkDistance: 250,
    nodeSizeMultiplier: 1,
    lineSizeMultiplier: 1,
    textFadeMultiplier: 0,
    showArrow: false,
    showTags: true,
    showAttachments: true,
    showOrphans: true,
    hideUnresolved: false,
    colorGroups: [],
};

/** Core constants of the simulation and of the renderer, straight from the app. */
export const SIM_CONSTANTS = {
    /** Collide radius of a single node: a pair keeps twice that between centres. */
    collideRadius: 60,
    collideStrength: 0.5,
    /** Velocity decay applied to both axes on every tick. */
    velocityDecay: 0.6,
    /** Alpha decay that reaches 0.001 after 300 ticks. */
    alphaDecay: 1 - Math.pow(0.001, 1 / 300),
    alphaMin: 0.001,
    /** Alpha the simulation is reheated to when data or forces change. */
    reheatAlpha: 0.3,
    /** Closest distance the repulsion force is allowed to work with. */
    distanceMin: 30,
    /** Barnes-Hut theta of the core simulation (used here as a soft parameter). */
    theta: 0.9,
    /** Label font of the core renderer. */
    labelFont: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Inter", '
        + '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Microsoft YaHei Light", sans-serif',
    /** Base label size; the core adds node size / 4 to it. */
    labelBaseSize: 14,
    /** Zoom limits and smoothing of the core renderer. */
    minScale: 1 / 128,
    maxScale: 8,
    zoomSmoothing: 0.85,
    /** Alpha of everything unrelated to the hovered node. */
    fadeAlpha: 0.2,
} as const;

function toNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toFlag(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

/** Core stores colours as `{ a, rgb }` with a 24-bit integer. */
function toColorGroup(value: unknown): ColorGroup | null {
    if (typeof value !== 'object' || value === null) return null;
    const raw = value as { query?: unknown; color?: unknown };
    if (typeof raw.query !== 'string' || raw.query.trim() === '') return null;
    const color = (raw.color ?? {}) as { rgb?: unknown; a?: unknown };
    const rgb = typeof color.rgb === 'number' && Number.isFinite(color.rgb) ? color.rgb & 0xffffff : 0xffffff;
    return {
        query: raw.query,
        color: `#${rgb.toString(16).padStart(6, '0')}`,
        alpha: Math.max(0, Math.min(toNumber(color.a, 1), 1)),
    };
}

/** Merges a parsed `graph.json` over the core defaults, validating every field. */
export function paramsFromVaultSettings(raw: unknown): GraphParams {
    const source = (raw ?? {}) as Record<string, unknown>;
    const groups: ColorGroup[] = [];
    if (Array.isArray(source['colorGroups'])) {
        for (const entry of source['colorGroups']) {
            const group = toColorGroup(entry);
            if (group) groups.push(group);
        }
    }

    return {
        centerStrength: toNumber(source['centerStrength'], CORE_DEFAULTS.centerStrength),
        repelStrength: toNumber(source['repelStrength'], CORE_DEFAULTS.repelStrength),
        linkStrength: toNumber(source['linkStrength'], CORE_DEFAULTS.linkStrength),
        linkDistance: toNumber(source['linkDistance'], CORE_DEFAULTS.linkDistance),
        nodeSizeMultiplier: toNumber(source['nodeSizeMultiplier'], CORE_DEFAULTS.nodeSizeMultiplier),
        lineSizeMultiplier: toNumber(source['lineSizeMultiplier'], CORE_DEFAULTS.lineSizeMultiplier),
        textFadeMultiplier: toNumber(source['textFadeMultiplier'], CORE_DEFAULTS.textFadeMultiplier),
        showArrow: toFlag(source['showArrow'], CORE_DEFAULTS.showArrow),
        showTags: toFlag(source['showTags'], CORE_DEFAULTS.showTags),
        showAttachments: toFlag(source['showAttachments'], CORE_DEFAULTS.showAttachments),
        showOrphans: toFlag(source['showOrphans'], CORE_DEFAULTS.showOrphans),
        hideUnresolved: toFlag(source['hideUnresolved'], CORE_DEFAULTS.hideUnresolved),
        colorGroups: groups,
    };
}

/**
 * Presentation parameters only: node and line size, text fade, arrows, the node
 * type switches and colour groups — everything that makes the panel look like
 * the core graph, read from the vault's own settings.
 *
 * The *forces* deliberately stay at the core defaults: a panel shows a few
 * hundred nodes, so a force configuration tuned for a window holds them in a
 * tight lump (this vault, for instance, has center 0.7 with repel 20, which
 * crushes the panel graph). The layout therefore uses the core defaults and the
 * look comes from the vault's own settings.
 */
export function displayParamsFromVault(raw: unknown): GraphParams {
    const parsed = paramsFromVaultSettings(raw);
    return {
        ...CORE_DEFAULTS,
        nodeSizeMultiplier: parsed.nodeSizeMultiplier,
        lineSizeMultiplier: parsed.lineSizeMultiplier,
        textFadeMultiplier: parsed.textFadeMultiplier,
        showArrow: parsed.showArrow,
        showTags: parsed.showTags,
        showAttachments: parsed.showAttachments,
        showOrphans: parsed.showOrphans,
        hideUnresolved: parsed.hideUnresolved,
        colorGroups: parsed.colorGroups,
    };
}

export async function readVaultGraphParams(app: App): Promise<GraphParams> {
    const path = normalizePath(`${app.vault.configDir}/graph.json`);
    try {
        const adapter = app.vault.adapter;
        if (!(await adapter.exists(path))) return { ...CORE_DEFAULTS };
        return displayParamsFromVault(JSON.parse(await adapter.read(path)) as unknown);
    } catch (error) {
        console.warn('ORDdashboard: could not read the vault graph settings', error);
        return { ...CORE_DEFAULTS };
    }
}

// ---------------------------------------------------------------------------
// Color groups
//
// The core resolves these with its internal search engine, which is not exposed
// to plugins. The common operators (`tag:`, `path:`, `file:`, plain text, minus
// for negation, quotes) are supported here; a group that uses anything else is
// skipped entirely, so a node never gets a colour the core would not give it.
// ---------------------------------------------------------------------------

export interface ColorMatchTarget {
    path: string;
    title: string;
    tags: string[];
}

interface Matcher {
    test(target: ColorMatchTarget): boolean;
}

function parseTerm(term: string): Matcher | null {
    let negated = false;
    let value = term;
    if (value.startsWith('-')) {
        negated = true;
        value = value.slice(1);
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length > 2) {
        value = value.slice(1, -1);
    }
    if (value === '') return null;

    const separator = value.indexOf(':');
    if (separator > 0) {
        const operator = value.slice(0, separator).toLowerCase();
        const operand = value.slice(separator + 1).replace(/^"|"$/g, '').toLowerCase();
        if (operand === '') return null;
        if (operator === 'tag') {
            // Tags are stored without the leading '#'; queries may use either form.
            const needle = operand.replace(/^#/, '');
            return wrap(negated, (target) => target.tags.some((tag) => tag.toLowerCase().replace(/^#/, '') === needle));
        }
        if (operator === 'path') {
            return wrap(negated, (target) => target.path.toLowerCase().includes(operand));
        }
        if (operator === 'file') {
            return wrap(negated, (target) => target.title.toLowerCase() === operand);
        }
        // Anything else (line:, section:, block:, property:, [] , regex, OR, …)
        // is not supported: the whole group is dropped instead of guessing.
        return null;
    }

    const needle = value.toLowerCase();
    return wrap(negated, (target) => target.path.toLowerCase().includes(needle));
}

function wrap(negated: boolean, test: (target: ColorMatchTarget) => boolean): Matcher {
    return { test: negated ? (target) => !test(target) : test };
}

function compileQuery(query: string): Matcher[] | null {
    const terms = query.match(/"[^"]*"|\S+/g) ?? [];
    const matchers: Matcher[] = [];
    for (const term of terms) {
        const matcher = parseTerm(term);
        if (!matcher) return null;
        matchers.push(matcher);
    }
    return matchers.length > 0 ? matchers : null;
}

/** Returns the colour of the last matching group, like the core's list order. */
export function matchColorGroup(
    groups: ColorGroup[],
    target: ColorMatchTarget,
): ColorGroup | null {
    let matched: ColorGroup | null = null;
    for (const group of groups) {
        const matchers = compileQuery(group.query);
        if (!matchers) continue;
        if (matchers.every((matcher) => matcher.test(target))) matched = group;
    }
    return matched;
}

import { normalizePath, Plugin, TFile } from 'obsidian';
import {
    ACTIVE_WINDOW_MS,
    applyEdit,
    applyReview,
    applyView,
    createActivity,
    isDashboardData,
    isTrackablePath,
    keptMonths,
    LEGACY_BACKUP_SUFFIX,
    LEGACY_DATA_FILE,
    looksLikeLegacyData,
    mergeActivity,
    migrateLegacyData,
    pruneMonths,
    RECENT_WINDOW_MS,
    sanitizeDashboardData,
    SCHEMA_VERSION,
    type DashboardData,
    type NoteActivity,
} from './model';
import { DEFAULT_SETTINGS, type DashboardSettings } from './settings';

const SAVE_DEBOUNCE_MS = 5000;
const GRAPH_NODES_MIN = 50;
const GRAPH_NODES_MAX = 2000;

/** Значение из данных хранилища: число или строка с числом; иначе ничего. */
function readNumber(value: unknown): number | null {    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function clampGraphNodes(value: number): number {    return Math.min(Math.max(Math.round(value), GRAPH_NODES_MIN), GRAPH_NODES_MAX);
}

function clampNodeScale(value: number): number {
    return Math.min(Math.max(value, 0.2), 1.5);
}

interface StoredData {
    version: number;
    settings: DashboardSettings;
    notes: Record<string, NoteActivity>;
}

/**
 * Owns everything that is persisted: plugin settings and note activity live in
 * the same `data.json`, so a single `saveData()` call keeps them consistent.
 *
 * The only place that touches the Adapter API is the one-time migration of the
 * pre-1.0 `note-views.json`: that file sits in the plugin folder, and hidden
 * folders are not visible through the Vault API.
 */
export class DashboardStore {
    private plugin: Plugin;
    private data: StoredData;
    private saveTimer: number | null = null;
    private pending = false;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
        this.data = {
            version: SCHEMA_VERSION,
            settings: { ...DEFAULT_SETTINGS },
            notes: {},
        };
    }

    get settings(): DashboardSettings {
        return this.data.settings;
    }

    get notes(): Record<string, NoteActivity> {
        return this.data.notes;
    }

    get trackedCount(): number {
        return Object.keys(this.data.notes).length;
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    /**
     * Validates and applies one setting. Returns true when the value changed,
     * so the caller knows whether anything has to be re-rendered.
     */
    applySetting(key: string, value: unknown): boolean {
        const settings = this.data.settings;
        switch (key) {
            case 'trackViews':
                if (typeof value !== 'boolean' || settings.trackViews === value) return false;
                settings.trackViews = value;
                return true;
            case 'trackEdits':
                if (typeof value !== 'boolean' || settings.trackEdits === value) return false;
                settings.trackEdits = value;
                return true;
            case 'showRibbonIcon':
                if (typeof value !== 'boolean' || settings.showRibbonIcon === value) return false;
                settings.showRibbonIcon = value;
                return true;
            case 'showGraph':
                if (typeof value !== 'boolean' || settings.showGraph === value) return false;
                settings.showGraph = value;
                return true;
            case 'graphAnimate':
                if (typeof value !== 'boolean' || settings.graphAnimate === value) return false;
                settings.graphAnimate = value;
                return true;
            case 'graphNodes': {
                if (typeof value !== 'number' || !Number.isFinite(value)) return false;
                const nodes = clampGraphNodes(value);
                if (settings.graphNodes === nodes) return false;
                settings.graphNodes = nodes;
                return true;
            }
            case 'graphScope':
                if (value !== 'local' && value !== 'vault') return false;
                if (settings.graphScope === value) return false;
                settings.graphScope = value;
                return true;
            case 'graphDepth': {
                if (typeof value !== 'string') return false;
                const depth = Number.parseInt(value, 10);
                if (!Number.isFinite(depth)) return false;
                const clamped = Math.min(Math.max(depth, 1), 3);
                if (settings.graphDepth === clamped) return false;
                settings.graphDepth = clamped;
                return true;
            }
            case 'graphRelevance':
                if (value !== 'strict' && value !== 'normal' && value !== 'relaxed' && value !== 'core') return false;
                if (settings.graphRelevance === value) return false;
                settings.graphRelevance = value;
                return true;
            case 'graphIndexNotes':
                if (value !== 'context' && value !== 'hidden' && value !== 'core') return false;
                if (settings.graphIndexNotes === value) return false;
                settings.graphIndexNotes = value;
                return true;
            case 'graphPlace':
                if (typeof value !== 'boolean' || settings.graphPlace === value) return false;
                settings.graphPlace = value;
                return true;
            case 'graphHeight':
                if (value !== 'small' && value !== 'medium' && value !== 'large') return false;
                if (settings.graphHeight === value) return false;
                settings.graphHeight = value;
                return true;
            case 'graphNodeScale': {
                if (typeof value !== 'string') return false;
                const scale = Number.parseFloat(value);
                if (!Number.isFinite(scale)) return false;
                const clamped = clampNodeScale(scale);
                if (settings.graphNodeScale === clamped) return false;
                settings.graphNodeScale = clamped;
                return true;
            }
            default:
                return false;
        }
    }

    /**
     * Settings are validated on read as well as on write: data written by an
     * older build (or edited by hand) must never reach the view as is.
     */
    private normalizeSettings(raw: unknown): DashboardSettings {
        const source = (raw ?? {}) as Partial<DashboardSettings>;
        const settings: DashboardSettings = { ...DEFAULT_SETTINGS };

        if (typeof source.trackViews === 'boolean') settings.trackViews = source.trackViews;
        if (typeof source.trackEdits === 'boolean') settings.trackEdits = source.trackEdits;
        if (typeof source.showRibbonIcon === 'boolean') settings.showRibbonIcon = source.showRibbonIcon;
        if (typeof source.showGraph === 'boolean') settings.showGraph = source.showGraph;
        if (source.graphScope === 'local' || source.graphScope === 'vault') settings.graphScope = source.graphScope;
        const depth = readNumber(source.graphDepth);
        if (depth !== null) settings.graphDepth = Math.min(Math.max(Math.round(depth), 1), 3);
        if (source.graphRelevance === 'strict' || source.graphRelevance === 'normal'
            || source.graphRelevance === 'relaxed' || source.graphRelevance === 'core') {
            settings.graphRelevance = source.graphRelevance;
        }
        if (source.graphIndexNotes === 'context' || source.graphIndexNotes === 'hidden'
            || source.graphIndexNotes === 'core') {
            settings.graphIndexNotes = source.graphIndexNotes;
        }
        if (typeof source.graphPlace === 'boolean') settings.graphPlace = source.graphPlace;
        if (typeof source.graphAnimate === 'boolean') settings.graphAnimate = source.graphAnimate;
        const nodeScale = readNumber(source.graphNodeScale);
        if (nodeScale !== null) settings.graphNodeScale = clampNodeScale(nodeScale);
        const nodes = readNumber(source.graphNodes);
        if (nodes !== null) settings.graphNodes = clampGraphNodes(nodes);
        if (source.graphHeight === 'small' || source.graphHeight === 'medium' || source.graphHeight === 'large') {
            settings.graphHeight = source.graphHeight;
        }
        return settings;
    }

    // -----------------------------------------------------------------------
    // Loading
    // -----------------------------------------------------------------------

    async load(): Promise<void> {
        const stored = (await this.plugin.loadData()) as unknown;

        if (isDashboardData(stored)) {
            const candidate = stored as Partial<StoredData> & DashboardData;
            this.data = {
                version: SCHEMA_VERSION,
                settings: this.normalizeSettings(candidate.settings),
                notes: sanitizeDashboardData(candidate).notes,
            };
            this.pruneOldMonths(Date.now());
            return;
        }

        // `data.json` written by an older build that stored activity directly.
        if (looksLikeLegacyData(stored)) {
            this.data = {
                version: SCHEMA_VERSION,
                settings: { ...DEFAULT_SETTINGS },
                notes: migrateLegacyData(stored, Date.now()).notes,
            };
            this.pending = true;
            return;
        }

        // Pre-1.0 activity file next to the plugin.
        const legacy = await this.readLegacyFile();
        if (legacy !== null) {
            const migrated = migrateLegacyData(legacy, Date.now());
            if (Object.keys(migrated.notes).length > 0) {
                this.data = {
                    version: SCHEMA_VERSION,
                    settings: { ...DEFAULT_SETTINGS },
                    notes: migrated.notes,
                };
                await this.saveNow();
                await this.backupLegacyFile();
                return;
            }
        }

        this.data = {
            version: SCHEMA_VERSION,
            settings: { ...DEFAULT_SETTINGS },
            notes: {},
        };
    }

    private legacyPath(): string {
        const id = this.plugin.manifest?.id;
        if (!id) return '';
        return normalizePath(`${this.plugin.app.vault.configDir}/plugins/${id}/${LEGACY_DATA_FILE}`);
    }

    /** Never lets a surprise in the file system break plugin startup. */
    private async readLegacyFile(): Promise<unknown> {
        try {
            const path = this.legacyPath();
            if (!path) return null;
            const adapter = this.plugin.app.vault.adapter;
            if (!(await adapter.exists(path))) return null;
            return JSON.parse(await adapter.read(path)) as unknown;
        } catch (error) {
            console.error('ORDdashboard: could not read legacy analytics file', error);
            return null;
        }
    }

    /** Keeps the migrated file around: it is renamed, never deleted. */
    private async backupLegacyFile(): Promise<void> {
        const path = this.legacyPath();
        if (!path) return;
        try {
            await this.plugin.app.vault.adapter.rename(path, `${path}${LEGACY_BACKUP_SUFFIX}`);
        } catch (error) {
            console.warn('ORDdashboard: could not rename migrated analytics file', path, error);
        }
    }

    // -----------------------------------------------------------------------
    // Activity
    // -----------------------------------------------------------------------

    private ensure(path: string): NoteActivity {
        const existing = this.data.notes[path];
        if (existing) return existing;
        const activity = createActivity();
        this.data.notes[path] = activity;
        return activity;
    }

    recordView(path: string, now: number): boolean {
        if (!isTrackablePath(path)) return false;
        if (!applyView(this.ensure(path), now)) return false;
        this.scheduleSave();
        return true;
    }

    recordEdit(path: string, now: number): boolean {
        if (!isTrackablePath(path)) return false;
        if (!applyEdit(this.ensure(path), now)) return false;
        this.scheduleSave();
        return true;
    }

    /** Called when a note is opened from the dashboard: it counts as a review. */
    advanceReview(path: string, now: number): boolean {
        if (!isTrackablePath(path)) return false;
        const activity = this.data.notes[path];
        if (!activity || activity.lastOpened === 0) return false;
        if (!applyReview(activity, now)) return false;
        this.scheduleSave();
        return true;
    }

    /**
     * Moves a record to a new path. When the destination already has a record —
     * a note renamed over a path that was deleted from the vault but not pruned
     * yet — the two are merged: history is added up, never overwritten.
     */
    renameNote(oldPath: string, newPath: string): void {
        const activity = this.data.notes[oldPath];
        if (!activity) return;
        if (oldPath === newPath) return;
        delete this.data.notes[oldPath];
        if (!isTrackablePath(newPath)) {
            this.scheduleSave();
            return;
        }
        const existing = this.data.notes[newPath];
        this.data.notes[newPath] = existing ? mergeActivity(existing, activity) : activity;
        this.scheduleSave();
    }

    removeNote(path: string): void {
        if (!(path in this.data.notes)) return;
        delete this.data.notes[path];
        this.scheduleSave();
    }

    /** Moves every record under a renamed folder, merging where they land. */
    renameFolder(oldPath: string, newPath: string): void {
        const prefix = `${oldPath}/`;
        let changed = false;
        for (const path of Object.keys(this.data.notes)) {
            if (!path.startsWith(prefix)) continue;
            const activity = this.data.notes[path];
            if (!activity) continue;
            delete this.data.notes[path];
            const moved = `${newPath}/${path.slice(prefix.length)}`;
            const existing = this.data.notes[moved];
            this.data.notes[moved] = existing ? mergeActivity(existing, activity) : activity;
            changed = true;
        }
        if (changed) this.scheduleSave();
    }

    async clearAll(): Promise<void> {
        this.data.notes = {};
        await this.saveNow();
    }

    /** Drops records of notes that no longer exist and counters that are too old. */
    pruneMissingFiles(existing: Set<string>, now: number): boolean {
        let changed = false;
        for (const path of Object.keys(this.data.notes)) {
            if (!existing.has(path)) {
                delete this.data.notes[path];
                changed = true;
            }
        }
        this.pruneOldMonths(now);
        if (changed) this.scheduleSave();
        return changed;
    }

    private pruneOldMonths(now: number): void {
        const keep = keptMonths(now);
        for (const activity of Object.values(this.data.notes)) {
            pruneMonths(activity, keep);
        }
    }

    /**
     * Seeds activity from file timestamps for notes that have no history yet:
     * notes edited in the last 30 days count as edited, notes edited in the last
     * week also count as opened. This is what makes a fresh install useful
     * without waiting for the user to browse the vault.
     */
    seedFromFiles(files: TFile[], now: number): number {
        const activeSince = now - ACTIVE_WINDOW_MS;
        const recentSince = now - RECENT_WINDOW_MS;
        let seeded = 0;

        for (const file of files) {
            if (this.data.notes[file.path]) continue;
            const modified = file.stat?.mtime;
            if (!modified || modified < activeSince) continue;

            const activity = createActivity();
            activity.lastEdited = modified;
            activity.edits = 1;
            if (modified >= recentSince) {
                activity.lastOpened = modified;
                activity.views = 1;
                activity.reviewStartedAt = modified;
            }
            this.data.notes[file.path] = activity;
            seeded += 1;
        }

        if (seeded > 0) this.scheduleSave();
        return seeded;
    }

    // -----------------------------------------------------------------------
    // Saving
    // -----------------------------------------------------------------------

    scheduleSave(): void {
        this.pending = true;
        if (this.saveTimer !== null) return;
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.saveNow();
        }, SAVE_DEBOUNCE_MS);
    }

    async saveNow(): Promise<void> {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.pending = false;
        try {
            await this.plugin.saveData(this.data);
        } catch (error) {
            this.pending = true;
            console.error('ORDdashboard: could not save analytics data', error);
        }
    }

    async flush(): Promise<void> {
        if (this.pending) await this.saveNow();
    }

    dispose(): void {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }
}

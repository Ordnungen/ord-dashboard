// ---------------------------------------------------------------------------
// Data model and one-time migration
//
// Activity is stored as aggregates, not as timestamp arrays: a vault with
// thousands of notes keeps this file in the kilobyte range, and the dashboard
// never has to scan long histories to answer "how many views this month".
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;
export const LEGACY_DATA_FILE = 'note-views.json';
export const LEGACY_BACKUP_SUFFIX = '.bak';

/** Progressive intervals (in days) and the grace window after each interval. */
export const REVIEW_STAGES = [
    { interval: 7, deadline: 2 },
    { interval: 14, deadline: 2 },
    { interval: 30, deadline: 7 },
    { interval: 60, deadline: 7 },
    { interval: 120, deadline: 14 },
] as const;

export const VIEW_THROTTLE_MS = 30_000;
export const EDIT_THROTTLE_MS = 30_000;
export const DAY_MS = 86_400_000;
export const ACTIVE_WINDOW_MS = 30 * DAY_MS;
export const RECENT_WINDOW_MS = 7 * DAY_MS;
/** Monthly counters are kept for the current month and the two before it. */
export const MONTHS_KEPT = 3;

export interface NoteActivity {
    /** Total number of opens. */
    views: number;
    /** Timestamp of the last open, 0 when never opened. */
    lastOpened: number;
    /** Total number of edit sessions. */
    edits: number;
    /** Timestamp of the last edit, 0 when never edited. */
    lastEdited: number;
    /** Refresh stage, 0..4. */
    reviewStage: number;
    /** Timestamp of the last stage advance, 0 when never refreshed. */
    reviewStartedAt: number;
    /** 'YYYY-MM' -> opens in that month. */
    viewsByMonth: Record<string, number>;
    /** 'YYYY-MM' -> edit sessions in that month. */
    editsByMonth: Record<string, number>;
}

export interface DashboardData {
    version: number;
    notes: Record<string, NoteActivity>;
}

export interface LegacyRecord {
    lastOpened?: unknown;
    viewCount?: unknown;
    history?: unknown;
    historyEdit?: unknown;
    created?: unknown;
    refreshData?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createActivity(): NoteActivity {
    return {
        views: 0,
        lastOpened: 0,
        edits: 0,
        lastEdited: 0,
        reviewStage: 0,
        reviewStartedAt: 0,
        viewsByMonth: {},
        editsByMonth: {},
    };
}

export function monthKey(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
}

export function keptMonths(now: number): Set<string> {
    const keys = new Set<string>();
    const date = new Date(now);
    for (let offset = 0; offset < MONTHS_KEPT; offset++) {
        keys.add(monthKey(new Date(date.getFullYear(), date.getMonth() - offset, 1).getTime()));
    }
    return keys;
}

export function monthCount(map: Record<string, number>, key: string): number {
    return map[key] ?? 0;
}

/** Notes only: Markdown files outside hidden folders. */
export function isTrackablePath(path: string): boolean {
    if (!path.toLowerCase().endsWith('.md')) return false;
    return !path.split('/').some((segment) => segment.startsWith('.'));
}

function toNumber(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toTimestampArray(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
}

function bucketByMonth(timestamps: number[], keep: Set<string>): Record<string, number> {
    const buckets: Record<string, number> = {};
    for (const timestamp of timestamps) {
        const key = monthKey(timestamp);
        if (!keep.has(key)) continue;
        buckets[key] = (buckets[key] ?? 0) + 1;
    }
    return buckets;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Records an open unless the same note was opened moments ago. Returns true when it counted. */
export function applyView(activity: NoteActivity, now: number): boolean {
    if (now - activity.lastOpened < VIEW_THROTTLE_MS) return false;
    activity.views += 1;
    activity.lastOpened = now;
    const key = monthKey(now);
    activity.viewsByMonth[key] = (activity.viewsByMonth[key] ?? 0) + 1;
    return true;
}

/** Records an edit session unless the previous one was moments ago. Returns true when it counted. */
export function applyEdit(activity: NoteActivity, now: number): boolean {
    if (now - activity.lastEdited < EDIT_THROTTLE_MS) return false;
    activity.edits += 1;
    activity.lastEdited = now;
    const key = monthKey(now);
    activity.editsByMonth[key] = (activity.editsByMonth[key] ?? 0) + 1;
    return true;
}

/** Moves the note to the next refresh stage. Returns true when the stage changed. */
export function applyReview(activity: NoteActivity, now: number): boolean {
    const next = Math.min(activity.reviewStage + 1, REVIEW_STAGES.length - 1);
    const changed = next !== activity.reviewStage || activity.reviewStartedAt !== now;
    activity.reviewStage = next;
    activity.reviewStartedAt = now;
    return changed;
}

/** Drops monthly counters that are too old to be shown. */
export function pruneMonths(activity: NoteActivity, keep: Set<string>): void {
    for (const key of Object.keys(activity.viewsByMonth)) {
        if (!keep.has(key)) delete activity.viewsByMonth[key];
    }
    for (const key of Object.keys(activity.editsByMonth)) {
        if (!keep.has(key)) delete activity.editsByMonth[key];
    }
}

// ---------------------------------------------------------------------------
// Sanitising and migration
// ---------------------------------------------------------------------------

/**
 * Adds two records of the same note together. Used when a rename lands on a path
 * that already has history: counters add up, dates take the freshest value, the
 * refresh stage takes the furthest, months add up per month.
 */
export function mergeActivity(target: NoteActivity, source: NoteActivity): NoteActivity {
    const merged: NoteActivity = {
        views: target.views + source.views,
        lastOpened: Math.max(target.lastOpened, source.lastOpened),
        edits: target.edits + source.edits,
        lastEdited: Math.max(target.lastEdited, source.lastEdited),
        reviewStage: Math.max(target.reviewStage, source.reviewStage),
        reviewStartedAt: Math.max(target.reviewStartedAt, source.reviewStartedAt),
        viewsByMonth: { ...target.viewsByMonth },
        editsByMonth: { ...target.editsByMonth },
    };
    for (const [month, count] of Object.entries(source.viewsByMonth)) {
        merged.viewsByMonth[month] = (merged.viewsByMonth[month] ?? 0) + count;
    }
    for (const [month, count] of Object.entries(source.editsByMonth)) {
        merged.editsByMonth[month] = (merged.editsByMonth[month] ?? 0) + count;
    }
    return merged;
}

/** True when the record carries something worth keeping. */
export function hasActivity(activity: NoteActivity): boolean {
    return activity.views > 0
        || activity.edits > 0
        || activity.lastOpened > 0
        || activity.lastEdited > 0
        || activity.reviewStartedAt > 0
        || Object.keys(activity.viewsByMonth).length > 0
        || Object.keys(activity.editsByMonth).length > 0;
}

export function sanitizeActivity(raw: unknown): NoteActivity {
    const source = (raw ?? {}) as Partial<NoteActivity>;
    return {
        views: toNumber(source.views),
        lastOpened: toNumber(source.lastOpened),
        edits: toNumber(source.edits),
        lastEdited: toNumber(source.lastEdited),
        reviewStage: Math.max(0, Math.min(toNumber(source.reviewStage), REVIEW_STAGES.length - 1)),
        reviewStartedAt: toNumber(source.reviewStartedAt),
        viewsByMonth: sanitizeMonths(source.viewsByMonth),
        editsByMonth: sanitizeMonths(source.editsByMonth),
    };
}

/** Месячные счётчики: числа и только ключи вида `ГГГГ-ММ`. */
function sanitizeMonths(raw: unknown): Record<string, number> {
    if (typeof raw !== 'object' || raw === null) return {};
    const months: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) continue;
        months[key] = toNumber(value);
    }
    return months;
}

export function isDashboardData(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) return false;
    const candidate = raw as Partial<DashboardData>;
    return typeof candidate.version === 'number' && typeof candidate.notes === 'object' && candidate.notes !== null;
}

export function sanitizeDashboardData(raw: unknown): DashboardData {
    const source = (raw ?? {}) as Partial<DashboardData>;
    const notes: Record<string, NoteActivity> = {};
    for (const [path, activity] of Object.entries(source.notes ?? {})) {
        if (!isTrackablePath(path)) continue;
        const sanitized = sanitizeActivity(activity);
        if (!hasActivity(sanitized)) continue;
        notes[path] = sanitized;
    }
    return { version: SCHEMA_VERSION, notes };
}

/** True when the payload looks like the pre-1.0 `note-views.json` file. */
export function looksLikeLegacyData(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null) return false;
    const values = Object.values(raw as Record<string, unknown>);
    if (values.length === 0) return false;
    return values.some((value) => {
        if (typeof value !== 'object' || value === null) return false;
        const record = value as LegacyRecord;
        return 'history' in record || 'historyEdit' in record || 'viewCount' in record;
    });
}

/**
 * Converts `note-views.json` into aggregates.
 *
 * Long timestamp arrays are collapsed: totals stay exact, while monthly counters
 * keep the detail the dashboard actually shows. Records for files that are not
 * Markdown (the old format tracked every file type) are dropped.
 */
export function migrateLegacyData(raw: unknown, now: number): DashboardData {
    const keep = keptMonths(now);
    const notes: Record<string, NoteActivity> = {};
    if (typeof raw !== 'object' || raw === null) return { version: SCHEMA_VERSION, notes };

    for (const [path, value] of Object.entries(raw as Record<string, LegacyRecord>)) {
        if (!isTrackablePath(path)) continue;
        if (typeof value !== 'object' || value === null) continue;

        const history = toTimestampArray(value.history);
        const historyEdit = toTimestampArray(value.historyEdit);
        const refreshData = (value.refreshData ?? {}) as { stage?: unknown; lastRefresh?: unknown };

        const activity = createActivity();
        activity.views = Math.max(toNumber(value.viewCount), history.length);
        activity.lastOpened = toNumber(value.lastOpened) || (history.length > 0 ? Math.max(...history) : 0);
        activity.edits = historyEdit.length;
        activity.lastEdited = historyEdit.length > 0 ? Math.max(...historyEdit) : 0;
        activity.reviewStage = Math.max(0, Math.min(toNumber(refreshData.stage), REVIEW_STAGES.length - 1));
        activity.reviewStartedAt = toNumber(refreshData.lastRefresh);
        activity.viewsByMonth = bucketByMonth(history, keep);
        activity.editsByMonth = bucketByMonth(historyEdit, keep);
        if (!hasActivity(activity)) continue;
        notes[path] = activity;
    }

    return { version: SCHEMA_VERSION, notes };
}

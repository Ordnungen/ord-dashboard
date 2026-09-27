import type { TFile } from 'obsidian';
import {
    ACTIVE_WINDOW_MS,
    DAY_MS,
    monthCount,
    monthKey,
    RECENT_WINDOW_MS,
    REVIEW_STAGES,
    type NoteActivity,
} from './model';

// ---------------------------------------------------------------------------
// Pure metric helpers
//
// Nothing here touches the app or the DOM: the dashboard passes vault files and
// stored activity in, and gets plain numbers back. That keeps the view thin and
// the calculations testable.
// ---------------------------------------------------------------------------

export interface VaultTotals {
    notes: number;
    views: number;
    edits: number;
    active: number;
}

export interface ActivityItem {
    file: TFile;
    views: number;
    edits: number;
    lastOpened: number;
    score: number;
}

export interface ReviewItem {
    file: TFile;
    /** 1-based stage number for display. */
    stageNumber: number;
    /** 0-based stage index, used for CSS classes. */
    stageIndex: number;
    intervalDays: number;
    daysToDeadline: number;
    daysSinceOpened: number;
    progress: number;
    isOverdue: boolean;
}

export function activityFor(notes: Record<string, NoteActivity>, path: string): NoteActivity | undefined {
    return notes[path];
}

export function computeTotals(files: TFile[], notes: Record<string, NoteActivity>, now: number): VaultTotals {
    let views = 0;
    let edits = 0;
    let active = 0;
    const activeSince = now - ACTIVE_WINDOW_MS;

    for (const file of files) {
        const activity = notes[file.path];
        if (!activity) continue;
        views += activity.views;
        edits += activity.edits;
        if (activity.lastOpened >= activeSince || activity.lastEdited >= activeSince) {
            active += 1;
        }
    }

    return { notes: files.length, views, edits, active };
}

export function computeTopNotes(
    files: TFile[],
    notes: Record<string, NoteActivity>,
    now: number,
    limit: number,
): ActivityItem[] {
    const month = monthKey(now);
    const items: ActivityItem[] = [];

    for (const file of files) {
        const activity = notes[file.path];
        if (!activity) continue;
        const views = monthCount(activity.viewsByMonth, month);
        const edits = monthCount(activity.editsByMonth, month);
        const score = views + 2 * edits;
        if (score <= 0) continue;
        items.push({ file, views, edits, lastOpened: activity.lastOpened, score });
    }

    items.sort((a, b) => b.score - a.score || b.lastOpened - a.lastOpened);
    return items.slice(0, limit);
}

export function computeRecentlyActive(
    files: TFile[],
    notes: Record<string, NoteActivity>,
    now: number,
    limit: number,
): ActivityItem[] {
    const month = monthKey(now);
    const recentSince = now - RECENT_WINDOW_MS;
    const items: ActivityItem[] = [];

    for (const file of files) {
        const activity = notes[file.path];
        if (!activity || activity.lastOpened === 0) continue;
        const views = monthCount(activity.viewsByMonth, month);
        const edits = monthCount(activity.editsByMonth, month);
        if (activity.lastOpened < recentSince && views < 2) continue;
        items.push({ file, views, edits, lastOpened: activity.lastOpened, score: views + 2 * edits });
    }

    items.sort((a, b) => b.lastOpened - a.lastOpened);
    return items.slice(0, limit);
}

export function computeReviewQueue(
    files: TFile[],
    notes: Record<string, NoteActivity>,
    now: number,
    limit: number,
): ReviewItem[] {
    const items: ReviewItem[] = [];

    for (const file of files) {
        const activity = notes[file.path];
        if (!activity || activity.lastOpened === 0) continue;

        const stageIndex = Math.max(0, Math.min(activity.reviewStage, REVIEW_STAGES.length - 1));
        const stage = REVIEW_STAGES[stageIndex] ?? REVIEW_STAGES[0];
        const daysSinceOpened = (now - activity.lastOpened) / DAY_MS;
        const daysSinceStageStart = activity.reviewStartedAt
            ? (now - activity.reviewStartedAt) / DAY_MS
            : daysSinceOpened;

        if (daysSinceStageStart < stage.interval) continue;

        const daysToDeadline = stage.interval + stage.deadline - daysSinceStageStart;
        items.push({
            file,
            stageNumber: stageIndex + 1,
            stageIndex,
            intervalDays: stage.interval,
            daysToDeadline: Math.floor(daysToDeadline),
            daysSinceOpened: Math.floor(daysSinceOpened),
            progress: Math.min(daysSinceStageStart / stage.interval, 1),
            isOverdue: daysToDeadline < 0,
        });
    }

    items.sort((a, b) => {
        if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
        return a.daysToDeadline - b.daysToDeadline;
    });
    return items.slice(0, limit);
}

import { ItemView, Platform, setIcon, type TFile, type WorkspaceLeaf } from 'obsidian';
import { GraphBlock } from './graph-view';
import { isRu, t } from './i18n';
import {
    computeRecentlyActive,
    computeReviewQueue,
    computeTopNotes,
    computeTotals,
    type ReviewItem,
} from './metrics';
import { DAY_MS, type NoteActivity } from './model';
import type DashboardPlugin from './main';

export const DASHBOARD_VIEW_TYPE = 'ord-dashboard-view';

/** Collapse key of the pinned graph block, kept in the same set as the sections. */
export const GRAPH_SECTION = 'graph';

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_RESULTS = 8;
/** From this value on a tile shows a shortened number (the exact one is in the tooltip). */
const COMPACT_FROM = 10_000;

const TIME_UNITS = [
    { limit: 60 * 60 * 1000, key: 'timeMinutes', divisor: 60 * 1000 },
    { limit: 24 * 60 * 60 * 1000, key: 'timeHours', divisor: 60 * 60 * 1000 },
    { limit: Number.POSITIVE_INFINITY, key: 'timeDays', divisor: DAY_MS },
] as const;

type Notes = Record<string, NoteActivity>;

/**
 * The dashboard is a view, not a modal: it lives in the sidebar, keeps its state
 * while the user works, and notes can be opened from it without closing it.
 */
export class DashboardView extends ItemView {
    private plugin: DashboardPlugin;
    private scrollEl: HTMLElement | null = null;
    private graphBlock: GraphBlock | null = null;
    private graphCollapsed = false;
    private graphListenersRegistered = false;
    private searchTimer: number | null = null;
    private searchResults: TFile[] = [];
    private allNotesExpanded = false;
    private actionEls: HTMLElement[] = [];
    /** Section ids collapsed by the user; lives with the view instance. */
    private collapsedSections = new Set<string>();

    constructor(leaf: WorkspaceLeaf, plugin: DashboardPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return DASHBOARD_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t('viewTitle');
    }

    getIcon(): string {
        return 'layout-dashboard';
    }

    async onOpen(): Promise<void> {
        // Панель помечает свой контейнер сама: правило через `:has` сканер
        // справедливо считает дорогим, а класс не задевает чужие виды.
        this.containerEl.addClass('ord-dashboard-host');
        this.addHeaderActions();
        this.ensureLayout();
        this.render();
    }

    /**
     * Actions live in the header of this panel — the top-right corner, next to
     * the panel title, where the panel itself is.
     */
    private addHeaderActions(): void {
        for (const element of this.actionEls) element.remove();
        this.actionEls = [
            this.addAction('refresh-cw', t('actionRefresh'), () => this.render()),
            this.addAction('trash-2', t('cmdClear'), () => this.plugin.promptClearData()),
        ];
    }

    /**
     * Two zones: the scrollable content and the link graph pinned to the bottom
     * of the panel. The graph is created once and survives re-renders.
     */
    private ensureLayout(): void {
        const container = this.contentEl;
        container.empty();
        container.addClass('ord-dashboard');
        this.scrollEl = container.createDiv({ cls: 'ord-dashboard__content' });

        if (!this.plugin.config.showGraph) {
            this.graphCollapsed = false;
            return;
        }

        this.graphCollapsed = this.collapsedSections.has(GRAPH_SECTION);
        this.graphBlock = new GraphBlock(
            {
                app: this.app,
                getSettings: () => ({
                    nodes: this.plugin.config.graphNodes,
                    scope: this.plugin.config.graphScope,
                    depth: this.plugin.config.graphDepth,
                    relevance: this.plugin.config.graphRelevance,
                    indexNotes: this.plugin.config.graphIndexNotes,
                    place: this.plugin.config.graphPlace,
                    animate: this.plugin.config.graphAnimate,
                    nodeScale: this.plugin.config.graphNodeScale,
                }),
                onOpenNote: (path) => this.openPath(path),
                onToggleCollapse: () => this.toggleGraphCollapsed(),
            },
        );
        container.appendChild(this.graphBlock.element);
        this.applyGraphSize();
        this.graphBlock.setCollapsed(this.graphCollapsed);
        // The open note is known before the first build, so a local graph starts
        // around the right note instead of being rebuilt a moment later.
        this.graphBlock.setActive(this.app.workspace.getActiveFile()?.path ?? '');
        this.graphBlock.rebuild();

        // Theme switches must repaint the graph: its colours come from the theme.
        // The open note follows the graph too, so the panel always shows it.
        if (!this.graphListenersRegistered) {
            this.graphListenersRegistered = true;
            this.registerEvent(this.app.workspace.on('css-change', () => this.graphBlock?.updateTheme()));
            this.registerEvent(this.app.workspace.on('file-open', (file) => {
                this.graphBlock?.setActive(file?.path ?? '');
            }));
        }
    }

    private applyGraphSize(): void {
        const element = this.graphBlock?.element;
        if (!element) return;
        const size = this.plugin.config.graphHeight;
        element.toggleClass('is-small', size === 'small');
        element.toggleClass('is-large', size === 'large');
    }

    private toggleGraphCollapsed(): void {
        this.graphCollapsed = !this.graphCollapsed;
        if (this.graphCollapsed) {
            this.collapsedSections.add(GRAPH_SECTION);
        } else {
            this.collapsedSections.delete(GRAPH_SECTION);
        }
        this.graphBlock?.setCollapsed(this.graphCollapsed);
    }

    /**
     * Called by the plugin when settings change. Only the parts that are affected
     * are updated: the sample is re-collected for node limits, the forces are
     * re-read for parameters, and the rest is just a repaint.
     */
    applySettings(changedKey?: string): void {
        const wantsGraph = this.plugin.config.showGraph;
        if (wantsGraph !== Boolean(this.graphBlock)) {
            this.graphBlock?.dispose();
            this.graphBlock = null;
            this.ensureLayout();
        } else if (wantsGraph) {
            if (changedKey === 'graphNodes' || changedKey === 'graphScope'
                || changedKey === 'graphDepth' || changedKey === 'graphRelevance'
                || changedKey === 'graphIndexNotes' || changedKey === 'graphPlace') {
                this.graphBlock?.rebuild();
            } else if (changedKey === 'graphHeight') {
                this.applyGraphSize();
            } else if (changedKey === undefined) {
                this.applyGraphSize();
                this.graphBlock?.rebuild();
            } else {
                this.graphBlock?.applySettings();
            }
        }
        this.render();
    }

    /** Called by the plugin when the link index changed. */
    refreshGraph(): void {
        this.graphBlock?.markStale();
        this.graphBlock?.refreshIfStale();
    }

    private openPath(path: string): void {
        const file = this.app.vault.getFileByPath(path);
        if (file) this.openNote(file);
    }

    async onClose(): Promise<void> {
        this.containerEl.removeClass('ord-dashboard-host');
        if (this.searchTimer !== null) {
            window.clearTimeout(this.searchTimer);
            this.searchTimer = null;
        }
        this.graphBlock?.dispose();
        this.graphBlock = null;
        this.contentEl.empty();
    }

    /** Re-renders the scrollable content; the graph keeps its own state. */
    render(): void {
        const container = this.scrollEl ?? this.contentEl;
        container.empty();

        const files = this.app.vault.getMarkdownFiles();
        const notes = this.plugin.store.notes;
        const now = Date.now();

        this.renderSearch(container, files);
        this.renderTotals(container, files, notes, now);
        this.renderTopNotes(container, files, notes, now);
        this.renderReviewQueue(container, files, notes, now);
        this.renderRecentlyActive(container, files, notes, now);
        this.renderAllNotes(container, files, notes, now);
    }

    private limit(desktop: number, mobile: number): number {
        return Platform.isPhone ? mobile : desktop;
    }

    // -----------------------------------------------------------------------
    // Search
    // -----------------------------------------------------------------------

    private renderSearch(container: HTMLElement, files: TFile[]): void {
        const wrapper = container.createDiv({ cls: 'ord-dashboard__search' });
        const input = wrapper.createEl('input', {
            type: 'text',
            cls: 'ord-dashboard__search-input',
            placeholder: t('searchPlaceholder'),
            attr: { 'aria-label': t('searchPlaceholder'), spellcheck: 'false' },
        });
        const results = wrapper.createDiv({ cls: 'ord-dashboard__search-results is-hidden' });

        input.addEventListener('input', () => {
            if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => {
                this.searchTimer = null;
                this.renderSearchResults(results, files, input.value);
            }, SEARCH_DEBOUNCE_MS);
        });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                input.value = '';
                this.clearSearchResults(results);
            }
            if (event.key === 'Enter' && this.searchResults[0]) {
                this.openNote(this.searchResults[0]);
                input.value = '';
                this.clearSearchResults(results);
            }
        });
    }

    private clearSearchResults(results: HTMLElement): void {
        this.searchResults = [];
        results.empty();
        results.toggleClass('is-hidden', true);
    }

    private renderSearchResults(results: HTMLElement, files: TFile[], query: string): void {
        results.empty();
        this.searchResults = [];

        const trimmed = query.trim().toLowerCase();
        if (!trimmed) {
            results.toggleClass('is-hidden', true);
            return;
        }

        const matches = files
            .filter((file) => file.basename.toLowerCase().includes(trimmed)
                || file.path.toLowerCase().includes(trimmed))
            .sort((a, b) => {
                const aStarts = a.basename.toLowerCase().startsWith(trimmed);
                const bStarts = b.basename.toLowerCase().startsWith(trimmed);
                if (aStarts !== bStarts) return aStarts ? -1 : 1;
                return a.basename.localeCompare(b.basename);
            })
            .slice(0, SEARCH_RESULTS);

        if (matches.length === 0) {
            results.createDiv({ cls: 'ord-dashboard__search-empty', text: t('searchEmpty') });
            results.toggleClass('is-hidden', false);
            return;
        }

        for (const file of matches) {
            const item = results.createDiv({ cls: 'ord-dashboard__search-item is-clickable' });
            item.createDiv({ cls: 'ord-dashboard__row-title', text: file.basename });
            item.createDiv({ cls: 'ord-dashboard__row-meta', text: file.path });
            item.addEventListener('click', () => {
                this.openNote(file);
                this.clearSearchResults(results);
            });
        }

        this.searchResults = matches;
        results.toggleClass('is-hidden', false);
    }

    // -----------------------------------------------------------------------
    // Sections
    // -----------------------------------------------------------------------

    private renderTotals(container: HTMLElement, files: TFile[], notes: Notes, now: number): void {
        const totals = computeTotals(files, notes, now);
        const locale = isRu() ? 'ru-RU' : 'en-US';
        const cards = [
            this.formatStat(totals.notes, locale, t('statsNotes')),
            this.formatStat(totals.views, locale, t('statsViews')),
            this.formatStat(totals.edits, locale, t('statsEdits')),
            this.formatStat(totals.active, locale, t('statsActive'), t('statsActiveHint')),
        ];

        // All four cards share one font size, picked from the longest value, so a
        // large total never makes a single card look out of place.
        const longest = Math.max(...cards.map((card) => card.text.length));
        const grid = container.createDiv({ cls: 'ord-dashboard__stats' });
        grid.toggleClass('is-dense', longest > 6 && longest <= 9);
        grid.toggleClass('is-dense-2', longest > 9);

        for (const card of cards) {
            this.addStatCard(grid, card.text, card.label, card.hint);
        }
    }

    private renderTopNotes(container: HTMLElement, files: TFile[], notes: Notes, now: number): void {
        const items = computeTopNotes(files, notes, now, this.limit(6, 4));
        if (items.length === 0) return;

        const body = this.createSection(container, 'top', t('sectionTop'), items.length);
        for (const item of items) {
            const meta = t('metaViewsEdits', { views: String(item.views), edits: String(item.edits) });
            this.addNoteRow(body, item.file, meta);
        }
    }

    private renderReviewQueue(container: HTMLElement, files: TFile[], notes: Notes, now: number): void {
        const items = computeReviewQueue(files, notes, now, this.limit(15, 8));
        const body = this.createSection(container, 'review', t('sectionReview'), items.length);

        if (items.length === 0) {
            body.createDiv({ cls: 'ord-dashboard__empty', text: t('reviewEmpty') });
            return;
        }

        for (const item of items) {
            this.addReviewCard(body, item);
        }
    }

    private addReviewCard(container: HTMLElement, item: ReviewItem): void {
        const card = container.createDiv({ cls: 'ord-dashboard__card is-clickable' });
        const header = card.createDiv({ cls: 'ord-dashboard__card-header' });
        header.createDiv({ cls: 'ord-dashboard__row-title', text: item.file.basename });
        header.createSpan({
            cls: `ord-dashboard__badge is-stage-${item.stageIndex}`,
            text: t('reviewStage', { stage: String(item.stageNumber) }),
        });

        const progress = card.createDiv({ cls: 'ord-dashboard__progress' });
        const fill = progress.createDiv({ cls: 'ord-dashboard__progress-fill' });
        fill.setCssProps({ '--ord-dashboard-progress': `${Math.round(item.progress * 100)}%` });

        const status = card.createDiv({ cls: 'ord-dashboard__card-status' });
        status.createSpan({
            cls: item.isOverdue ? 'ord-dashboard__status is-overdue' : 'ord-dashboard__status',
            text: item.isOverdue
                ? t('reviewOverdue', { days: String(Math.abs(item.daysToDeadline)) })
                : t('reviewDeadline', { days: String(item.daysToDeadline) }),
        });
        status.createSpan({
            cls: 'ord-dashboard__status is-muted',
            text: item.daysSinceOpened === 0
                ? t('reviewNeverOpened')
                : t('reviewOpened', { days: String(item.daysSinceOpened) }),
        });

        this.bindOpen(card, item.file, true);
    }

    private renderRecentlyActive(container: HTMLElement, files: TFile[], notes: Notes, now: number): void {
        const items = computeRecentlyActive(files, notes, now, this.limit(12, 6));
        if (items.length === 0) return;

        const body = this.createSection(container, 'recent', t('sectionRecent'), items.length);
        for (const item of items) {
            this.addNoteRow(body, item.file, t('metaOpened', { time: this.timeAgo(item.lastOpened, now) }));
        }
    }

    private renderAllNotes(container: HTMLElement, files: TFile[], notes: Notes, now: number): void {
        const maxVisible = this.limit(30, 15);
        const sorted = [...files].sort((a, b) => (b.stat?.ctime ?? 0) - (a.stat?.ctime ?? 0));
        const body = this.createSection(container, 'all', t('sectionAll'), sorted.length);
        const visible = this.allNotesExpanded ? sorted : sorted.slice(0, maxVisible);

        for (const file of visible) {
            this.addNoteRow(body, file, this.describeFile(file, notes[file.path], now));
        }

        if (!this.allNotesExpanded && sorted.length > maxVisible) {
            const button = body.createDiv({ cls: 'ord-dashboard__row is-clickable is-center' });
            button.createSpan({ text: t('showMore', { count: String(sorted.length - maxVisible) }) });
            button.addEventListener('click', () => {
                this.allNotesExpanded = true;
                this.render();
            });
        }
    }

    private describeFile(file: TFile, activity: NoteActivity | undefined, now: number): string {
        const parts: string[] = [];
        const created = file.stat?.ctime ?? 0;
        const modified = file.stat?.mtime ?? 0;
        if (created > 0) parts.push(t('metaCreated', { time: this.timeAgo(created, now) }));
        if (modified > 0 && modified !== created) {
            parts.push(t('metaEdited', { time: this.timeAgo(modified, now) }));
        }
        if (activity && activity.lastOpened > 0) {
            parts.push(t('metaOpened', { time: this.timeAgo(activity.lastOpened, now) }));
        }
        return parts.join(' • ');
    }

    // -----------------------------------------------------------------------
    // Building blocks
    // -----------------------------------------------------------------------

    private addNoteRow(container: HTMLElement, file: TFile, meta: string): void {
        const row = container.createDiv({ cls: 'ord-dashboard__row is-clickable' });
        row.createDiv({ cls: 'ord-dashboard__row-title', text: file.basename });
        if (meta) row.createDiv({ cls: 'ord-dashboard__row-meta', text: meta });
        this.bindOpen(row, file, false);
    }

    private addStatCard(container: HTMLElement, text: string, label: string, hint?: string): void {
        const card = container.createDiv({ cls: 'ord-dashboard__stat' });
        card.createDiv({ cls: 'ord-dashboard__stat-value', text });
        card.createDiv({ cls: 'ord-dashboard__stat-label', text: label });
        if (hint) card.setAttribute('title', hint);
    }

    /**
     * A statistic for a tile. Large totals are shortened the way dashboards do it
     * (`241 290` → `241,3 тыс.`), so the number always fits one line instead of
     * breaking in half. The tooltip keeps the exact value, and an optional note
     * explains what the number counts.
     */
    private formatStat(value: number, locale: string, label: string, note?: string): {
        text: string; label: string; hint?: string;
    } {
        const exact = value.toLocaleString(locale);
        const compact = value >= COMPACT_FROM;
        const text = compact
            ? new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
            : exact;
        const hint = [compact ? exact : '', note ?? ''].filter(Boolean).join(' · ');
        return { text, label, hint: hint === '' ? undefined : hint };
    }

    /**
     * Section with a clickable header: clicking it collapses the body, and the
     * state is kept for the lifetime of the view. The item count is shown while
     * the section is collapsed, so hiding it does not hide the information.
     */
    private createSection(container: HTMLElement, id: string, title: string, count: number): HTMLElement {
        const isCollapsed = this.collapsedSections.has(id);
        const section = container.createDiv({ cls: 'ord-dashboard__section' });
        section.toggleClass('is-collapsed', isCollapsed);

        const header = section.createDiv({ cls: 'ord-dashboard__section-header' });
        setIcon(header.createSpan({ cls: 'ord-dashboard__section-icon' }), 'chevron-down');
        header.createDiv({ cls: 'ord-dashboard__section-title', text: title });
        if (isCollapsed && count > 0) {
            header.createSpan({ cls: 'ord-dashboard__section-count', text: count.toLocaleString() });
        }

        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        const toggle = (): void => {
            if (this.collapsedSections.has(id)) {
                this.collapsedSections.delete(id);
            } else {
                this.collapsedSections.add(id);
            }
            this.render();
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });

        return section.createDiv({ cls: 'ord-dashboard__section-body' });
    }

    private bindOpen(element: HTMLElement, file: TFile, isReview: boolean): void {
        element.setAttribute('role', 'button');
        element.setAttribute('tabindex', '0');
        element.addEventListener('click', () => this.openNote(file, isReview));
        element.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.openNote(file, isReview);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Actions and formatting
    // -----------------------------------------------------------------------

    private openNote(file: TFile, isReview = false): void {
        if (isReview) {
            void this.plugin.store.advanceReview(file.path, Date.now());
        }
        void this.app.workspace.getLeaf('tab').openFile(file);
    }

    private timeAgo(timestamp: number, now: number): string {
        const diff = Math.max(now - timestamp, 0);
        if (diff < 60 * 1000) return t('timeNow');
        for (const unit of TIME_UNITS) {
            if (diff < unit.limit) {
                return t(unit.key, { n: String(Math.floor(diff / unit.divisor)) });
            }
        }
        return t('timeNow');
    }
}

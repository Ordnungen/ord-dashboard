import { debounce, Notice, Plugin, TFile, TFolder, type WorkspaceLeaf } from 'obsidian';
import { ConfirmModal } from './confirm';
import { t } from './i18n';
import { DashboardSettingTab, type DashboardSettings } from './settings';
import { DashboardStore } from './storage';
import { DASHBOARD_VIEW_TYPE, DashboardView } from './view';

export default class DashboardPlugin extends Plugin {
    // The store owns settings and activity; it is created with the plugin and
    // loaded in onload().
    /** О неудаче сохранения говорим один раз за сеанс: иначе будет поток окон. */
    private saveWarningShown = false;
    store = new DashboardStore(this, () => this.warnSaveFailure());
    private settingTab: DashboardSettingTab | null = null;
    private ribbonEl: HTMLElement | null = null;

    /** Settings snapshot; always reads the current object from the store. */
    get config(): DashboardSettings {
        return this.store.settings;
    }

    async onload(): Promise<void> {
        await this.store.load();

        this.settingTab = new DashboardSettingTab(this.app, this);
        this.addSettingTab(this.settingTab);
        this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));

        // The ribbon is the only place where a plugin can put a permanent entry
        // point; the panel can hide it from the settings tab.
        this.ribbonEl = this.addRibbonIcon('layout-dashboard', t('ribbonTooltip'), () => void this.openDashboard());
        this.syncRibbonIcon();

        this.addCommand({
            id: 'open-dashboard',
            name: t('cmdOpen'),
            callback: () => void this.openDashboard(),
        });
        this.addCommand({
            id: 'clear-data',
            name: t('cmdClear'),
            callback: () => this.promptClearData(),
        });
        this.addCommand({
            id: 'seed-activity',
            name: t('cmdSeed'),
            callback: () => void this.seedActivity(),
        });

        // Vault events are registered once the workspace is ready: during startup
        // Obsidian fires "create" for every file in the vault, and reacting to
        // that would waste a full pass on every launch.
        this.app.workspace.onLayoutReady(() => {
            this.registerTracking();
            this.registerGraphRefresh();
            void this.afterLayoutReady();
        });
    }

    onunload(): void {
        this.store.dispose();
        void this.store.flush();
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    /** Called by the settings tab; values are validated, nothing else is accepted. */
    setSetting(key: string, value: unknown): void {
        if (!this.store.applySetting(key, value)) return;
        this.applySettings(key);
    }

    /** Pushes the current settings into everything that renders them. */
    private applySettings(changedKey?: string): void {
        this.syncRibbonIcon();
        for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
            if (leaf.view instanceof DashboardView) {
                leaf.view.applySettings(changedKey);
            }
        }
    }

    /** Hides or shows the ribbon icon without recreating it. */
    private syncRibbonIcon(): void {
        this.ribbonEl?.toggleClass('ord-dashboard-ribbon-hidden', !this.config.showRibbonIcon);
    }

    // -----------------------------------------------------------------------
    // Tracking
    // -----------------------------------------------------------------------

    private registerTracking(): void {
        const refresh = debounce(() => this.refreshViews(), 500, true);

        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            if (!this.config.trackViews || !(file instanceof TFile)) return;
            if (this.store.recordView(file.path, Date.now())) refresh();
        }));

        const trackEdit = (file: unknown): void => {
            if (!this.config.trackEdits || !(file instanceof TFile)) return;
            if (this.store.recordEdit(file.path, Date.now())) refresh();
        };
        this.registerEvent(this.app.vault.on('modify', trackEdit));
        this.registerEvent(this.app.vault.on('create', trackEdit));

        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file instanceof TFile) {
                this.store.removeNote(file.path);
                refresh();
            }
        }));

        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (file instanceof TFile) {
                this.store.renameNote(oldPath, file.path);
            } else if (file instanceof TFolder) {
                this.store.renameFolder(oldPath, file.path);
            }
            refresh();
        }));
    }

    /**
     * The link index changes constantly while Obsidian indexes the vault, so the
     * graph is only marked as stale — it is rebuilt at most once per settle, and
     * only while the panel is actually showing it.
     */
    private registerGraphRefresh(): void {
        const refresh = debounce(() => {
            for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
                if (leaf.view instanceof DashboardView) {
                    leaf.view.refreshGraph();
                }
            }
        }, 10_000, true);
        this.registerEvent(this.app.metadataCache.on('resolved', refresh));
    }

    /**
     * Runs once the vault is loaded: drops records of notes that no longer
     * exist, and seeds activity from file dates on a fresh install.
     */
    private warnSaveFailure(): void {
        if (this.saveWarningShown) return;
        this.saveWarningShown = true;
        new Notice(t('noticeSaveFailed'));
    }

    private async afterLayoutReady(): Promise<void> {
        const files = this.app.vault.getMarkdownFiles();
        const existing = new Set(files.map((file) => file.path));
        this.store.pruneMissingFiles(existing, Date.now());

        if (this.store.trackedCount === 0) {
            const seeded = this.store.seedFromFiles(files, Date.now());
            if (seeded > 0) new Notice(t('noticeSeeded', { count: String(seeded) }));
        }

        await this.store.flush();
        this.refreshViews();
    }

    private async seedActivity(): Promise<void> {
        try {
            const files = this.app.vault.getMarkdownFiles();
            const seeded = this.store.seedFromFiles(files, Date.now());
            await this.store.flush();
            new Notice(t('noticeSeeded', { count: String(seeded) }));
            this.refreshViews();
            this.settingTab?.update();
        } catch (error) {
            console.error('ORDdashboard: could not seed activity', error);
            new Notice(t('noticeSeedFailed'));
        }
    }

    // -----------------------------------------------------------------------
    // Dashboard
    // -----------------------------------------------------------------------

    private async openDashboard(): Promise<void> {
        const { workspace } = this.app;
        const existing = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
        const leaf: WorkspaceLeaf | null = existing ?? workspace.getRightLeaf(false);
        if (!leaf) return;

        if (!existing) {
            await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
        }
        await workspace.revealLeaf(leaf);
        if (leaf.view instanceof DashboardView) {
            leaf.view.render();
        }
    }

    /** The view instance is never stored: it is looked up through the workspace. */
    private refreshViews(): void {
        for (const leaf of this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)) {
            if (leaf.view instanceof DashboardView) {
                leaf.view.render();
            }
        }
    }

    promptClearData(): void {
        new ConfirmModal(this.app, {
            title: t('clearTitle'),
            body: t('clearBody'),
            confirmText: t('clearConfirm'),
            cancelText: t('clearCancel'),
            onConfirm: () => this.clearData(),
        }).open();
    }

    private async clearData(): Promise<void> {
        try {
            await this.store.clearAll();
            new Notice(t('noticeCleared'));
            this.refreshViews();
            this.settingTab?.update();
        } catch (error) {
            console.error('ORDdashboard: could not clear analytics data', error);
            new Notice(t('noticeClearFailed'));
        }
    }
}

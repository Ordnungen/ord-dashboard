import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { t } from './i18n';
import type DashboardPlugin from './main';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface DashboardSettings {
    trackViews: boolean;
    trackEdits: boolean;
    showRibbonIcon: boolean;
    showGraph: boolean;
    graphNodes: number;
    graphScope: 'local' | 'vault';
    graphDepth: number;
    graphRelevance: 'strict' | 'normal' | 'relaxed' | 'core';
    graphIndexNotes: 'context' | 'hidden' | 'core';
    graphPlace: boolean;
    graphAnimate: boolean;
    graphHeight: 'small' | 'medium' | 'large';
    graphNodeScale: number;
}

export const DEFAULT_SETTINGS: DashboardSettings = {
    trackViews: true,
    trackEdits: true,
    showRibbonIcon: true,
    showGraph: true,
    graphNodes: 300,
    graphScope: 'local',
    graphDepth: 2,
    graphRelevance: 'normal',
    graphIndexNotes: 'context',
    graphPlace: true,
    graphAnimate: true,
    graphHeight: 'medium',
    graphNodeScale: 0.5,
};

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

// Declarative settings require Obsidian 1.13.0+ (manifest.minAppVersion matches).
export class DashboardSettingTab extends PluginSettingTab {
    private plugin: DashboardPlugin;

    constructor(app: App, plugin: DashboardPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // Settings and tracked activity share one data.json, so Obsidian must not
    // write this.plugin.config on its own: reads and writes go through the
    // store, which persists both parts together.
    getControlValue(key: string): unknown {
        if (key === 'trackViews') return this.plugin.config.trackViews;
        if (key === 'trackEdits') return this.plugin.config.trackEdits;
        if (key === 'showRibbonIcon') return this.plugin.config.showRibbonIcon;
        if (key === 'showGraph') return this.plugin.config.showGraph;
        if (key === 'graphNodes') return this.plugin.config.graphNodes;
        if (key === 'graphScope') return this.plugin.config.graphScope;
        if (key === 'graphDepth') return String(this.plugin.config.graphDepth);
        if (key === 'graphRelevance') return this.plugin.config.graphRelevance;
        if (key === 'graphIndexNotes') return this.plugin.config.graphIndexNotes;
        if (key === 'graphPlace') return this.plugin.config.graphPlace;
        if (key === 'graphAnimate') return this.plugin.config.graphAnimate;
        if (key === 'graphNodeScale') return String(this.plugin.config.graphNodeScale);
        if (key === 'graphHeight') return this.plugin.config.graphHeight;
        return undefined;
    }

    async setControlValue(key: string, value: unknown): Promise<void> {
        this.plugin.setSetting(key, value);
        await this.plugin.store.saveNow();
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                name: t('settingTrackViews'),
                desc: t('settingTrackViewsDesc'),
                control: { type: 'toggle', key: 'trackViews' },
            },
            {
                name: t('settingTrackEdits'),
                desc: t('settingTrackEditsDesc'),
                control: { type: 'toggle', key: 'trackEdits' },
            },
            {
                name: t('settingRibbon'),
                desc: t('settingRibbonDesc'),
                control: { type: 'toggle', key: 'showRibbonIcon' },
            },
            {
                type: 'group',
                heading: t('groupGraph'),
                items: [
                    {
                        name: t('settingGraph'),
                        desc: t('settingGraphDesc'),
                        control: { type: 'toggle', key: 'showGraph' },
                    },
                    {
                        name: t('settingGraphScope'),
                        desc: t('settingGraphScopeDesc'),
                        control: {
                            type: 'dropdown',
                            key: 'graphScope',
                            defaultValue: 'local',
                            options: {
                                local: t('graphScopeLocal'),
                                vault: t('graphScopeVault'),
                            },
                            disabled: () => !this.plugin.config.showGraph,
                        },
                    },
                    {
                        name: t('settingGraphDepth'),
                        desc: t('settingGraphDepthDesc'),
                        control: {
                            type: 'dropdown',
                            key: 'graphDepth',
                            defaultValue: '2',
                            options: {
                                '1': t('graphDepth1'),
                                '2': t('graphDepth2'),
                                '3': t('graphDepth3'),
                            },
                            disabled: () => !this.plugin.config.showGraph || this.plugin.config.graphScope !== 'local',
                        },
                    },
                    {
                        name: t('settingGraphRelevance'),
                        desc: t('settingGraphRelevanceDesc'),
                        control: {
                            type: 'dropdown',
                            key: 'graphRelevance',
                            defaultValue: 'normal',
                            options: {
                                strict: t('graphRelevanceStrict'),
                                normal: t('graphRelevanceNormal'),
                                relaxed: t('graphRelevanceRelaxed'),
                                core: t('graphRelevanceCore'),
                            },
                            disabled: () => !this.plugin.config.showGraph || this.plugin.config.graphScope !== 'local',
                        },
                    },
                    {
                        name: t('settingGraphIndexNotes'),
                        desc: t('settingGraphIndexNotesDesc'),
                        control: {
                            type: 'dropdown',
                            key: 'graphIndexNotes',
                            defaultValue: 'context',
                            options: {
                                context: t('graphIndexContext'),
                                hidden: t('graphIndexHidden'),
                                core: t('graphIndexCore'),
                            },
                            disabled: () => !this.plugin.config.showGraph || this.plugin.config.graphScope !== 'local',
                        },
                    },
                    {
                        name: t('settingGraphPlace'),
                        desc: t('settingGraphPlaceDesc'),
                        control: {
                            type: 'toggle',
                            key: 'graphPlace',
                            disabled: () => !this.plugin.config.showGraph || this.plugin.config.graphScope !== 'local',
                        },
                    },
                    {
                        name: t('settingGraphNodes'),
                        desc: t('settingGraphNodesDesc'),
                        control: {
                            type: 'number',
                            key: 'graphNodes',
                            min: 50,
                            max: 2000,
                            step: 50,
                            defaultValue: 300,
                            disabled: () => !this.plugin.config.showGraph,
                        },
                    },
                    {
                        name: t('settingGraphAnimate'),
                        desc: t('settingGraphAnimateDesc'),
                        control: {
                            type: 'toggle',
                            key: 'graphAnimate',
                            disabled: () => !this.plugin.config.showGraph,
                        },
                    },
                    {
                        name: t('settingGraphNodeScale'),
                        desc: t('settingGraphNodeScaleDesc'),
                        control: {
                            type: 'dropdown',
                            key: 'graphNodeScale',
                            defaultValue: '0.5',
                            options: {
                                '1': t('graphScaleFull'),
                                '0.75': t('graphScale75'),
                                '0.5': t('graphScale50'),
                                '0.35': t('graphScale35'),
                            },
                            disabled: () => !this.plugin.config.showGraph,
                        },
                    },
                    {
                        name: t('settingGraphHeight'),
                        desc: t('settingGraphHeightDesc'),
                        control: {
                            type: 'dropdown',
                            key: 'graphHeight',
                            defaultValue: 'medium',
                            options: {
                                small: t('graphSizeSmall'),
                                medium: t('graphSizeMedium'),
                                large: t('graphSizeLarge'),
                            },
                            disabled: () => !this.plugin.config.showGraph,
                        },
                    },
                ],
            },
            {
                type: 'group',
                heading: t('groupData'),
                items: [
                    {
                        name: t('settingRecords'),
                        desc: t('settingRecordsDesc', { count: String(this.plugin.store.trackedCount) }),
                    },
                    {
                        name: t('settingClear'),
                        desc: t('settingClearDesc'),
                        action: () => this.plugin.promptClearData(),
                    },
                ],
            },
        ];
    }
}

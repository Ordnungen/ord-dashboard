const { Plugin, TFile, Modal, debounce, Notice } = require('obsidian');

const locales = {
    ru: {
        openDashboard: 'Открыть OrdDashboard',
        clearAnalytics: 'Очистить данные аналитики',
        initExistingNotes: 'Инициализировать существующие заметки',

        searchPlaceholder: 'Поиск заметок...',
        nothingFound: 'Ничего не найдено',

        statsNotes: 'Заметок',
        statsViews: 'Просмотров',
        statsEdits: 'Изменений',
        statsActive: 'Активные',

        sectionRefreshNeeded: 'Пора освежить',
        sectionRecentlyActive: 'Недавно открывали',
        sectionAllNotes: 'Все заметки',
        sectionMostActive: 'Самые активные заметки за месяц',

        timeJustNow: 'только что',
        timeMinutesAgo: 'мин назад',
        timeHoursAgo: 'ч назад',
        timeDaysAgo: 'дн назад',
        timeUnknown: 'неизвестно',

        noteCreated: 'Создана',
        noteModified: 'Изменена',
        noteOpened: 'Открыта',
        noteViews: 'просмотров',
        noteViewsMonth: 'просмотров за месяц',
        noteEdits: 'изменений',

        refreshStageInitial: 'Начальная',
        refreshStageSecond: 'Вторая',
        refreshStageMonthly: 'Месячная',
        refreshStageTwoMonth: 'Двухмесячная',
        refreshStageFourMonth: 'Четырехмесячная',
        refreshStageStage: 'стадия',
        refreshOverdue: 'Просрочено на',
        refreshDeadline: 'До дедлайна:',
        refreshNotRead: 'Не читали',
        refreshDays: 'дн.',
        refreshEmptyState: 'Нет заметок которые стоит освежить в памяти',

        errorPrefix: 'Ошибка:',
        initSuccess: 'Инициализировано ${count} заметок. Заметки, изменённые за последние 7 дней, добавлены в систему повторений.',
        clearConfirm: 'Вы уверены, что хотите очистить все данные аналитики?',
        clearSuccess: 'Данные аналитики очищены',
        clearError: 'Ошибка при очистке данных',

        showMore: 'Показать ещё',
        moreNotes: 'заметок',

        logLoading: 'Loading OrdDashboard plugin',
        logUnloading: 'Unloading OrdDashboard plugin',
        logFirstRun: 'First run detected, initializing existing notes...',
        logInitializing: 'Initializing ${count} existing notes...',
        logInitialized: 'Initialized ${count} notes',
        logDataLoaded: 'Note views loaded: ${count} entries',
        logDataFresh: 'No existing data file, starting fresh',
        logDataSaved: 'Note views saved successfully',
        logDataCleared: 'Analytics data cleared'
    },

    en: {
        openDashboard: 'Open OrdDashboard',
        clearAnalytics: 'Clear analytics data',
        initExistingNotes: 'Initialize existing notes',

        searchPlaceholder: 'Search notes...',
        nothingFound: 'Nothing found',

        statsNotes: 'Notes',
        statsViews: 'Views',
        statsEdits: 'Edits',
        statsActive: 'Active',

        sectionRefreshNeeded: 'Time to refresh',
        sectionRecentlyActive: 'Recently opened',
        sectionAllNotes: 'All notes',
        sectionMostActive: 'Most active notes this month',

        timeJustNow: 'just now',
        timeMinutesAgo: 'min ago',
        timeHoursAgo: 'h ago',
        timeDaysAgo: 'd ago',
        timeUnknown: 'unknown',

        noteCreated: 'Created',
        noteModified: 'Modified',
        noteOpened: 'Opened',
        noteViews: 'views',
        noteViewsMonth: 'views this month',
        noteEdits: 'edits',

        refreshStageInitial: 'Initial',
        refreshStageSecond: 'Second',
        refreshStageMonthly: 'Monthly',
        refreshStageTwoMonth: 'Two-month',
        refreshStageFourMonth: 'Four-month',
        refreshStageStage: 'stage',
        refreshOverdue: 'Overdue by',
        refreshDeadline: 'Deadline in:',
        refreshNotRead: 'Not read for',
        refreshDays: 'd',
        refreshEmptyState: 'No notes need refreshing',

        errorPrefix: 'Error:',
        initSuccess: 'Initialized ${count} notes. Notes modified in the last 7 days have been added to the spaced repetition system.',
        clearConfirm: 'Are you sure you want to clear all analytics data?',
        clearSuccess: 'Analytics data cleared',
        clearError: 'Error clearing data',

        showMore: 'Show more',
        moreNotes: 'more notes',

        logLoading: 'Loading OrdDashboard plugin',
        logUnloading: 'Unloading OrdDashboard plugin',
        logFirstRun: 'First run detected, initializing existing notes...',
        logInitializing: 'Initializing ${count} existing notes...',
        logInitialized: 'Initialized ${count} notes',
        logDataLoaded: 'Note views loaded: ${count} entries',
        logDataFresh: 'No existing data file, starting fresh',
        logDataSaved: 'Note views saved successfully',
        logDataCleared: 'Analytics data cleared'
    }
};

function getLocale() {
    try {
        const htmlLang = document.documentElement.lang;
        if (htmlLang) {
            if (htmlLang.startsWith('ru')) {
                return 'ru';
            }
            return 'en';
        }

        const browserLang = navigator.language || navigator.userLanguage;
        if (browserLang) {
            if (browserLang.startsWith('ru')) {
                return 'ru';
            }
            return 'en';
        }
    } catch (error) {
        console.warn('Could not detect locale, defaulting to English');
    }

    return 'en';
}

function t(key, params = {}) {
    const currentLocale = getLocale();
    const locale = locales[currentLocale] || locales.en;
    let text = locale[key] || locales.en[key] || key;

    Object.keys(params).forEach(param => {
        text = text.replace(new RegExp(`\\$\\{${param}\\}`, 'g'), params[param]);
    });

    return text;
}

const DATA_FILE = 'note-views.json';

class OrdDashboardModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.noteViews = {};
        this.cachedStats = null;
        this.cachedEngagement = null;
        this.searchResults = [];
        this.isDashboardActive = false;
        this._eventRefs = [];
        this.isMobile = this.detectMobile();
        this.deviceType = this.getDeviceType();

        // Adaptive limits based on device type
        this.maxNotesPerSection = this.getMaxNotesForDevice();
        this.maxSearchResults = this.getMaxSearchResultsForDevice();
    }

    getMaxNotesForDevice() {
        switch(this.deviceType) {
            case 'extraSmall': return 5;
            case 'small': return 6;
            case 'medium': return 8;
            case 'large': return 10;
            default: return 12;
        }
    }

    getMaxSearchResultsForDevice() {
        switch(this.deviceType) {
            case 'extraSmall': return 3;
            case 'small': return 4;
            case 'medium': return 5;
            case 'large': return 6;
            default: return 8;
        }
    }

    detectMobile() {
        // Enhanced mobile detection for all platforms
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;

        // Check for mobile user agents
        const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile|tablet/i.test(userAgent);

        // Check for touch capability
        const isTouchDevice = 'ontouchstart' in window ||
                            navigator.maxTouchPoints > 0 ||
                            navigator.msMaxTouchPoints > 0;

        // Check screen size (including narrow desktop windows)
        const isSmallScreen = window.innerWidth <= 768;
        const isVerySmallScreen = window.innerWidth <= 480;

        // Check for specific mobile platforms
        const isAndroid = /android/i.test(userAgent);
        const isIOS = /ipad|iphone|ipod/i.test(userAgent);
        const isWindowsMobile = /windows phone/i.test(userAgent);

        // Final determination - prioritize actual mobile devices
        return isMobileUA || (isTouchDevice && isSmallScreen) || isAndroid || isIOS || isWindowsMobile;
    }

    getDeviceType() {
        const width = window.innerWidth;
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;

        if (width <= 320) return 'extraSmall'; // Very small phones
        if (width <= 480) return 'small'; // Small phones
        if (width <= 768) return 'medium'; // Large phones / small tablets
        if (width <= 1024) return 'large'; // Tablets
        return 'desktop'; // Desktop
    }

    async onOpen() {
        this.isDashboardActive = true;
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('ord-dashboard-modal');

        // Add resize listener for dynamic adaptation
        this.resizeListener = () => {
            this.isMobile = this.detectMobile();
            this.deviceType = this.getDeviceType();
            this.maxNotesPerSection = this.getMaxNotesForDevice();
            this.maxSearchResults = this.getMaxSearchResultsForDevice();

            // Re-render dashboard if significantly different device type
            if (this.isDashboardActive) {
                this.refreshLayout();
            }
        };
        window.addEventListener('resize', this.resizeListener);

        // Add error boundary for mobile stability
        try {
            this.addCloseButton(contentEl);
            await this.loadData();
            await this.renderDashboard(contentEl);
            this.setupEventListeners();
        } catch (error) {
            console.error('Error opening dashboard:', error);
            contentEl.createEl('div', {
                cls: 'error-message',
                text: `${t('errorPrefix')} ${error.message}`
            });

            // Add retry button
            const retryBtn = contentEl.createEl('button', {
                text: 'Retry',
                cls: 'retry-btn'
            });
            retryBtn.onclick = () => {
                this.close();
                setTimeout(() => this.open(), 100);
            };
        }
    }

    async loadData() {
        this.noteViews = await this.plugin.loadNoteViews();
        this.cachedStats = null;
        this.cachedEngagement = null;
    }

    addCloseButton(container) {
        const closeBtn = container.createEl('button', {
            cls: 'ord-dashboard-close-btn'
        });
        closeBtn.innerHTML = '×';
        closeBtn.onclick = () => this.close();
    }

    setupEventListeners() {
        const debouncedSave = debounce(() => {
            this.saveNoteViews();
        }, 5000);

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file && file instanceof TFile) {
                    this.trackNoteView(file.path);
                    debouncedSave();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file && file instanceof TFile) {
                    this.trackNoteEdit(file.path);
                    debouncedSave();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file && file instanceof TFile) {
                    if (this.noteViews[oldPath]) {
                        this.noteViews[file.path] = this.noteViews[oldPath];
                        delete this.noteViews[oldPath];
                    }
                    this.trackNoteEdit(file.path);
                    debouncedSave();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file && file instanceof TFile) {
                    this.trackNoteEdit(file.path);
                    debouncedSave();
                }
            })
        );
    }

    async lightUpdate() {
        if (!this.isDashboardActive) return;
        try {
            this.noteViews = await this.plugin.loadNoteViews();
            this.updateStatsOnly();
        } catch (error) {
            console.error('Error in light update:', error);
        }
    }

    updateStatsOnly() {
        const statsContainer = this.contentEl.querySelector('.stats-container');
        if (statsContainer) {
            this.cachedStats = null;
            this.renderStatsContent(statsContainer);
        }
    }

    async renderDashboard(container) {
        try {
            const dashboard = container.createEl('div', { cls: 'ord-dashboard' });

            this.setupSearch(dashboard);
            this.renderStats(dashboard);
            this.renderEngagementChart(dashboard);

            const sectionsContainer = dashboard.createEl('div', { cls: 'sections-container' });
            this.renderNoteSections(sectionsContainer);
        } catch (error) {
            console.error('Error rendering dashboard:', error);
            container.createEl('div', {
                cls: 'error-message',
                text: `${t('errorPrefix')} ${error.message}`
            });
        }
    }

    setupSearch(container) {
        const searchContainer = container.createEl('div', { cls: 'search-wrapper' });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: t('searchPlaceholder'),
            cls: 'search-input'
        });

        // Prevent zoom on iOS by setting font-size to 16px minimum
        if (this.isMobile) {
            searchInput.style.fontSize = '16px';
        }

        const searchResults = searchContainer.createEl('div', { cls: 'search-results hidden' });

        searchInput.addEventListener('input', (e) => {
            clearTimeout(this.searchTimeout);
            this.searchTimeout = setTimeout(() => {
                this.handleSearch(e.target.value, searchResults);
            }, this.isMobile ? 500 : 300); // Longer delay on mobile to reduce lag
        });

        searchInput.addEventListener('focus', () => {
            if (this.searchResults.length > 0) {
                searchResults.removeClass('hidden');
            }
        });

        searchInput.addEventListener('blur', () => {
            setTimeout(() => {
                searchResults.addClass('hidden');
                this.searchResults = [];
            }, 200);
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.searchResults.length > 0) {
                this.openFile(this.searchResults[0]);
                searchResults.addClass('hidden');
                searchInput.blur();
            }
        });
    }

    handleSearch(query, resultsContainer) {
        resultsContainer.empty();
        this.searchResults = [];

        if (!query.trim()) {
            resultsContainer.addClass('hidden');
            return;
        }

        const files = this.app.vault.getMarkdownFiles();
        const lowerQuery = query.toLowerCase();

        const results = files
            .filter(file => {
                const basename = file.basename.toLowerCase();
                const path = file.path.toLowerCase();
                return basename.includes(lowerQuery) || path.includes(lowerQuery);
            })
            .sort((a, b) => {
                const aBasename = a.basename.toLowerCase();
                const bBasename = b.basename.toLowerCase();
                const aStartsWith = aBasename.startsWith(lowerQuery);
                const bStartsWith = bBasename.startsWith(lowerQuery);

                if (aStartsWith && !bStartsWith) return -1;
                if (!aStartsWith && bStartsWith) return 1;
                return aBasename.localeCompare(bBasename);
            })
            .slice(0, this.maxSearchResults);

        this.searchResults = results;

        if (results.length === 0) {
            resultsContainer.createEl('div', {
                text: t('nothingFound'),
                style: 'padding: 1rem; text-align: center; color: var(--text-muted);'
            });
        } else {
            results.forEach(file => {
                const resultItem = resultsContainer.createEl('div', { cls: 'search-result-item' });
                resultItem.createEl('div', { text: file.basename });
                resultItem.createEl('div', {
                    text: file.path,
                    cls: 'search-result-path'
                });

                // Add touch-friendly event listeners
                if (this.isMobile) {
                    resultItem.addEventListener('touchstart', (e) => {
                        e.preventDefault();
                        this.openFile(file);
                        resultsContainer.addClass('hidden');
                    });
                } else {
                    resultItem.onclick = () => {
                        this.openFile(file);
                        resultsContainer.addClass('hidden');
                    };
                }
            });
        }
        resultsContainer.removeClass('hidden');
    }    renderStats(container) {
        const statsContainer = container.createEl('div', { cls: 'stats-container' });
        this.renderStatsContent(statsContainer);
    }

    renderStatsContent(container) {
        if (!this.cachedStats) {
            this.calculateStats();
        }
        container.empty();
        this.createStatCard(container, this.cachedStats.total, t('statsNotes'));
        this.createStatCard(container, this.cachedStats.totalViews, t('statsViews'));
        this.createStatCard(container, this.cachedStats.totalEdits, t('statsEdits'));
        this.createStatCard(container, this.cachedStats.activeNotes, t('statsActive'));
    }

    calculateStats() {
        const files = this.app.vault.getMarkdownFiles();
        const views = this.noteViews;
        const now = Date.now();
        const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();

        const totalViews = Object.values(views).reduce((sum, v) => sum + (v.viewCount || 0), 0);
        const totalEdits = Object.values(views).filter(v =>
            Array.isArray(v.historyEdit) && v.historyEdit.length > 0
        ).length;

        const activeNotes = files.filter(file => {
            const v = views[file.path] || {};
            const hasRecentViews = Array.isArray(v.history) &&
                v.history.some(timestamp => timestamp >= monthStart);
            const hasRecentEdits = Array.isArray(v.historyEdit) &&
                v.historyEdit.some(timestamp => timestamp >= monthStart);
            return hasRecentViews || hasRecentEdits;
        }).length;

        this.cachedStats = {
            total: files.length,
            totalViews,
            totalEdits,
            activeNotes
        };
    }

    renderEngagementChart(container) {
        if (!this.cachedEngagement) {
            const views = this.noteViews;
            const files = this.app.vault.getMarkdownFiles();
            const now = Date.now();
            const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime();

            // Adaptive max items based on device
            const maxItems = this.deviceType === 'extraSmall' ? 2 :
                           this.deviceType === 'small' ? 3 :
                           this.deviceType === 'medium' ? 4 : 5;

            this.cachedEngagement = files
                .map(file => {
                    const v = views[file.path] || {};
                    const viewCount = Array.isArray(v.history) ? v.history.filter(ts => ts >= monthStart).length : 0;
                    const editCount = Array.isArray(v.historyEdit) ? v.historyEdit.filter(ts => ts >= monthStart).length : 0;
                    return {
                        file,
                        engagement: viewCount + 2 * editCount,
                        viewCount,
                        editCount
                    };
                })
                .filter(item => item.engagement > 0)
                .sort((a, b) => b.engagement - a.engagement)
                .slice(0, maxItems);
        }

        if (this.cachedEngagement.length === 0) {
            return;
        }

        const chartCard = container.createEl('div', { cls: 'chart-card' });
        chartCard.createEl('div', {
            cls: 'chart-title',
            text: t('sectionMostActive')
        });

        this.cachedEngagement.forEach(item => {
            const row = chartCard.createEl('div', { cls: 'engagement-row' });
            row.createEl('div', {
                cls: 'engagement-file-name',
                text: item.file.basename
            });
            const statsEl = row.createEl('div', {
                cls: 'engagement-stats',
                text: `${item.viewCount} ${t('noteViews')} • ${item.editCount} ${t('noteEdits')}`
            });

            // Add touch-friendly event listeners for mobile
            if (this.isMobile) {
                row.addEventListener('touchstart', (e) => {
                    e.preventDefault();
                    this.openFile(item.file);
                });
            } else {
                row.onclick = () => this.openFile(item.file);
            }
        });
    }    renderNoteSections(container) {
        try {
            this.renderRefreshNeededSection(container);
            this.renderRecentlyActiveSection(container);
            this.renderAllNotesSection(container);
        } catch (error) {
            console.error('Error rendering note sections:', error);
        }
    }

    renderRecentlyActiveSection(container) {
        const section = this.createSection(container, t('sectionRecentlyActive'));
        const files = this.app.vault.getMarkdownFiles();
        const views = this.noteViews;
        const now = Date.now();
        const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
        const maxRecent = this.isMobile ? 6 : 12; // Fewer items on mobile

        const recent = files
            .map(file => {
                const v = views[file.path] || {};
                const lastOpened = v.lastOpened || 0;
                const history = v.history || [];
                const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
                const recentViews = history.filter(ts => ts > monthAgo).length;

                return {
                    file,
                    lastOpened,
                    recentViews
                };
            })
            .filter(item => item.lastOpened > weekAgo || item.recentViews >= 2)
            .sort((a, b) => b.lastOpened - a.lastOpened)
            .slice(0, maxRecent);

        if (recent.length === 0) {
            section.section.remove();
            return;
        }

        recent.forEach(item => {
            let metaText = '';
            if (item.lastOpened) {
                metaText = `${t('noteOpened')} ${this.getTimeAgo(item.lastOpened)}`;
            }
            if (item.recentViews > 0) {
                if (metaText) metaText += ' • ';
                metaText += `${item.recentViews} ${t('noteViewsMonth')}`;
            }
            this.createCompactNoteItem(section.notesList, item.file, metaText);
        });
    }

    renderRefreshNeededSection(container) {
        const section = this.createSection(container, t('sectionRefreshNeeded'));
        const files = this.app.vault.getMarkdownFiles();
        const views = this.noteViews;
        const maxRefresh = this.isMobile ? 8 : 15; // Fewer items on mobile

        const candidates = files
            .map(file => {
                const refreshData = this.calculateRefreshStage(file.path, views);
                if (refreshData.needsRefresh) {
                    return {
                        file,
                        ...refreshData
                    };
                }
                return null;
            })
            .filter(Boolean)
            .sort((a, b) => {
                if (a.isOverdue !== b.isOverdue) {
                    return a.isOverdue ? -1 : 1;
                }
                return a.daysToDeadline - b.daysToDeadline;
            })
            .slice(0, maxRefresh);

        if (candidates.length === 0) {
            const emptyMessage = section.notesList.createEl('div', {
                cls: 'refresh-empty-state',
                text: t('refreshEmptyState')
            });
            return;
        }

        candidates.forEach(item => {
            this.createRefreshNoteItem(section.notesList, item);
        });
    }

    calculateRefreshStage(filePath, views) {
        const v = views[filePath] || {};
        const history = Array.isArray(v.history) ? v.history : [];
        const refreshData = v.refreshData || { stage: 0, lastRefresh: 0, missedDeadlines: 0 };
        if (history.length === 0) {
            return { needsRefresh: false };
        }

        const now = Date.now();
        const lastView = Math.max(...history);
        const daysSinceLastView = (now - lastView) / (24 * 60 * 60 * 1000);

        const stages = [
            { interval: 7, deadline: 2, name: t('refreshStageInitial'), color: '#e74c3c', icon: '🔴' },
            { interval: 14, deadline: 2, name: t('refreshStageSecond'), color: '#f39c12', icon: '🟡' },
            { interval: 30, deadline: 7, name: t('refreshStageMonthly'), color: '#3498db', icon: '🔵' },
            { interval: 60, deadline: 7, name: t('refreshStageTwoMonth'), color: '#9b59b6', icon: '🟣' },
            { interval: 120, deadline: 14, name: t('refreshStageFourMonth'), color: '#27ae60', icon: '🟢' }
        ];

        const currentStage = Math.min(refreshData.stage, stages.length - 1);
        const stageInfo = stages[currentStage];

        const daysSinceStageStart = refreshData.lastRefresh ?
            (now - refreshData.lastRefresh) / (24 * 60 * 60 * 1000) : daysSinceLastView;

        const daysToDeadline = stageInfo.interval + stageInfo.deadline - daysSinceStageStart;
        const isOverdue = daysToDeadline < 0;
        const shouldShow = daysSinceStageStart >= stageInfo.interval;

        return {
            needsRefresh: shouldShow,
            stage: currentStage,
            stageInfo,
            daysSinceLastView: Math.floor(daysSinceLastView),
            daysSinceStageStart: Math.floor(daysSinceStageStart),
            daysToDeadline: Math.floor(daysToDeadline),
            isOverdue,
            progress: Math.min(daysSinceStageStart / stageInfo.interval, 1)
        };
    }

    createRefreshNoteItem(container, item) {
        const noteCard = container.createEl('div', { cls: 'refresh-note-card' });

        const titleRow = noteCard.createEl('div', { cls: 'refresh-note-title-row' });
        titleRow.createEl('span', {
            cls: 'refresh-stage-icon',
            text: item.stageInfo.icon
        });
        titleRow.createEl('div', {
            cls: 'refresh-note-title',
            text: item.file.basename
        });

        const stageInfo = noteCard.createEl('div', { cls: 'refresh-stage-info' });
        const stageName = stageInfo.createEl('span', {
            cls: 'refresh-stage-name',
            text: item.stageInfo.name + ' ' + t('refreshStageStage')
        });
        stageName.style.color = item.stageInfo.color;

        const progressContainer = noteCard.createEl('div', { cls: 'refresh-progress-container' });
        const progressBar = progressContainer.createEl('div', { cls: 'refresh-progress-bar' });
        const progressFill = progressBar.createEl('div', { cls: 'refresh-progress-fill' });
        progressFill.style.width = `${item.progress * 100}%`;
        progressFill.style.backgroundColor = item.stageInfo.color;

        const statusRow = noteCard.createEl('div', { cls: 'refresh-status-row' });

        if (item.isOverdue) {
            statusRow.createEl('span', {
                cls: 'refresh-status overdue',
                text: `${t('refreshOverdue')} ${Math.abs(item.daysToDeadline)} ${t('refreshDays')}`
            });
        } else {
            statusRow.createEl('span', {
                cls: 'refresh-status active',
                text: `${t('refreshDeadline')} ${item.daysToDeadline} ${t('refreshDays')}`
            });
        }

        statusRow.createEl('span', {
            cls: 'refresh-last-view',
            text: `${t('refreshNotRead')} ${item.daysSinceLastView} ${t('refreshDays')}`
        });

        // Add touch-friendly event listeners for mobile
        if (this.isMobile) {
            noteCard.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.openFile(item.file);
            });
        } else {
            noteCard.onclick = () => this.openFile(item.file);
        }
    }

    renderAllNotesSection(container) {
        const section = this.createSection(container, t('sectionAllNotes'));
        const files = this.app.vault.getMarkdownFiles();
        const views = this.noteViews;

        // Adaptive limit based on device type for better performance
        const maxNotes = this.deviceType === 'extraSmall' ? 10 :
                        this.deviceType === 'small' ? 15 :
                        this.deviceType === 'medium' ? 20 :
                        this.deviceType === 'large' ? 30 : 50;

        const sortedFiles = files
            .sort((a, b) => b.stat?.ctime - a.stat?.ctime)
            .slice(0, maxNotes);

        sortedFiles.forEach(file => {
            const v = views[file.path] || {};
            const created = file.stat?.ctime;
            const modified = file.stat?.mtime;
            const lastOpened = v.lastOpened;

            let metaParts = [];
            if (created) {
                metaParts.push(`${t('noteCreated')} ${this.getTimeAgo(created)}`);
            }
            if (modified && modified !== created) {
                metaParts.push(`${t('noteModified')} ${this.getTimeAgo(modified)}`);
            }
            if (lastOpened) {
                metaParts.push(`${t('noteOpened')} ${this.getTimeAgo(lastOpened)}`);
            }

            this.createCompactNoteItem(section.notesList, file, metaParts.join(' • '));
        });

        // Add "show more" button if there are more notes (only on larger devices)
        if (this.deviceType !== 'extraSmall' && this.deviceType !== 'small' && files.length > maxNotes) {
            const showMoreBtn = section.notesList.createEl('div', {
                cls: 'show-more-btn',
                text: `${t('showMore')} (${files.length - maxNotes} ${t('moreNotes')})`
            });
            showMoreBtn.onclick = () => {
                // Implement pagination or expand logic here if needed
                // For now, just hide the button to avoid performance issues
                showMoreBtn.remove();
            };
        }
    }    getRecentViews(filePath) {
        const views = this.noteViews;
        const history = views[filePath]?.history || [];
        const now = Date.now();
        const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
        return history.filter(ts => ts > monthAgo).length;
    }

    createSection(container, title) {
        const section = container.createEl('div', { cls: 'notes-section' });
        const header = section.createEl('div', { cls: 'section-header' });
        const sectionInfo = header.createEl('div', { cls: 'section-info' });
        sectionInfo.createEl('h3', { cls: 'section-title', text: title });
        const notesList = section.createEl('div', { cls: 'notes-grid' });
        return { section, notesList };
    }

    createCompactNoteItem(container, file, metaText) {
        const noteCard = container.createEl('div', { cls: 'note-card' });
        noteCard.createEl('div', {
            cls: 'note-title',
            text: file.basename
        });

        if (metaText) {
            const metaContainer = noteCard.createEl('div', { cls: 'note-meta-container' });
            const metaParts = metaText.split(' • ');
            metaParts.forEach(part => {
                metaContainer.createEl('div', {
                    cls: 'note-meta',
                    text: part.trim()
                });
            });
        }

        // Add touch-friendly event listeners for mobile
        if (this.isMobile) {
            noteCard.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.openFile(file);
            });
        } else {
            noteCard.onclick = () => this.openFile(file);
        }
    }

    async openFile(file) {
        if (!file || !(file instanceof TFile)) {
            console.warn('Invalid file:', file);
            return;
        }
        try {
            await this.app.workspace.getLeaf().openFile(file);
            await this.plugin.trackNoteView(file.path);
            await this.plugin.updateRefreshStage(file.path);
            this.close();
        } catch (error) {
            console.error('Error opening file:', error);
            this.close();
        }
    }

    getTimeAgo(timestamp) {
        try {
            const now = Date.now();
            const diff = now - timestamp;
            if (diff < 0) return t('timeJustNow');
            const minutes = Math.floor(diff / (1000 * 60));
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            if (minutes < 1) return t('timeJustNow');
            if (minutes < 60) return `${minutes} ${t('timeMinutesAgo')}`;
            if (hours < 24) return `${hours} ${t('timeHoursAgo')}`;
            return `${days} ${t('timeDaysAgo')}`;
        } catch (error) {
            console.error('Error calculating time:', error);
            return t('timeUnknown');
        }
    }

    createStatCard(container, value, label) {
        const card = container.createEl('div', { cls: 'stat-card' });
        card.createEl('div', { cls: 'stat-value', text: value.toString() });
        card.createEl('div', { cls: 'stat-label', text: label });
    }

    refreshLayout() {
        // Simple layout refresh without full re-render for performance
        if (this.cachedEngagement) {
            this.cachedEngagement = null;
        }
        // Could add more selective refresh logic here
    }

    onClose() {
        this.isDashboardActive = false;

        // Remove resize listener
        if (this.resizeListener) {
            window.removeEventListener('resize', this.resizeListener);
            this.resizeListener = null;
        }

        if (this._eventRefs) {
            this._eventRefs.forEach(ref => {
                if (ref && typeof ref.off === 'function') {
                    ref.off();
                }
            });
            this._eventRefs = [];
        }

        const { contentEl } = this;
        contentEl.empty();
    }
}

class OrdDashboardPlugin extends Plugin {
    constructor() {
        super(...arguments);
        this.noteViews = {};
        this.saveTimeout = null;
    }

    async onload() {
        console.log(t('logLoading'));

        this.dashboardModal = new OrdDashboardModal(this.app, this);

        this.addRibbonIcon('home', t('openDashboard'), () => {
            this.dashboardModal.open();
        });

        this.addCommand({
            id: 'open-ord-dashboard',
            name: t('openDashboard'),
            callback: () => this.dashboardModal.open()
        });

        this.addCommand({
            id: 'clear-analytics-data',
            name: t('clearAnalytics'),
            callback: () => this.clearAnalyticsData()
        });

        this.addCommand({
            id: 'initialize-existing-notes',
            name: t('initExistingNotes'),
            callback: () => this.initializeExistingNotes()
        });        await this.loadNoteViews();

        if (Object.keys(this.noteViews).length === 0) {
            console.log(t('logFirstRun'));
            await this.initializeExistingNotes();
        }

        this.setupEventListeners();
    }

    setupEventListeners() {
        const debouncedSave = debounce(() => {
            this.saveNoteViews();
        }, 5000);

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file && file instanceof TFile) {
                    this.trackNoteView(file.path);
                    debouncedSave();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file && file instanceof TFile) {
                    this.trackNoteEdit(file.path);
                    debouncedSave();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file && file instanceof TFile) {
                    if (this.noteViews[oldPath]) {
                        this.noteViews[file.path] = this.noteViews[oldPath];
                        delete this.noteViews[oldPath];
                    }
                    this.trackNoteEdit(file.path);
                    debouncedSave();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file && file instanceof TFile) {
                    this.trackNoteEdit(file.path);
                    debouncedSave();
                }
            })
        );
    }

    async getDataFilePath() {
        const configDir = this.app.vault.configDir;
    const pluginDir = `${configDir}/plugins/ord-dashboard`;

        try {
            await this.app.vault.adapter.mkdir(pluginDir);
        } catch (error) {
        }

        return `${pluginDir}/${DATA_FILE}`;
    }

    async loadNoteViews() {
        try {
            const dataPath = await this.getDataFilePath();
            const data = await this.app.vault.adapter.read(dataPath);
            this.noteViews = JSON.parse(data);
            console.log(t('logDataLoaded', { count: Object.keys(this.noteViews).length }));
        } catch (error) {
            console.log(t('logDataFresh'));
            this.noteViews = {};
            await this.saveNoteViews();
        }
        return this.noteViews;
    }

    async saveNoteViews() {
        try {
            const dataPath = await this.getDataFilePath();
            await this.app.vault.adapter.write(dataPath, JSON.stringify(this.noteViews, null, 2));
            console.log(t('logDataSaved'));
        } catch (error) {
            console.error('Error saving note views:', error);
        }
    }

    trackNoteView(path) {
        if (!path) return;

        const now = Date.now();

        if (!this.noteViews[path]) {
            this.noteViews[path] = {
                lastOpened: now,
                viewCount: 1,
                history: [now],
                historyEdit: [],
                created: now,
                refreshData: { stage: 0, lastRefresh: 0, missedDeadlines: 0 }
            };
        } else {
            const lastView = this.noteViews[path].history?.[this.noteViews[path].history.length - 1] || 0;

            if (now - lastView > 30000) {
                this.noteViews[path].lastOpened = now;
                this.noteViews[path].viewCount = (this.noteViews[path].viewCount || 0) + 1;

                if (!this.noteViews[path].history) this.noteViews[path].history = [];
                this.noteViews[path].history.push(now);

                if (this.noteViews[path].history.length > 200) {
                    this.noteViews[path].history = this.noteViews[path].history.slice(-200);
                }
            }
        }
    }

    trackNoteEdit(path) {
        if (!path) return;

        const now = Date.now();

        if (!this.noteViews[path]) {
            this.noteViews[path] = {
                lastOpened: 0,
                viewCount: 0,
                history: [],
                historyEdit: [now],
                created: now,
                refreshData: { stage: 0, lastRefresh: 0, missedDeadlines: 0 }
            };
        } else {
            if (!this.noteViews[path].historyEdit) this.noteViews[path].historyEdit = [];

            const lastEdit = this.noteViews[path].historyEdit[this.noteViews[path].historyEdit.length - 1] || 0;

            if (now - lastEdit > 30000) {
                this.noteViews[path].historyEdit.push(now);

                if (this.noteViews[path].historyEdit.length > 100) {
                    this.noteViews[path].historyEdit = this.noteViews[path].historyEdit.slice(-100);
                }
            }
        }
    }

    async initializeExistingNotes() {
        const files = this.app.vault.getMarkdownFiles();
        const now = Date.now();
        let initializedCount = 0;

        console.log(t('logInitializing', { count: files.length }));

        for (const file of files) {
            if (this.noteViews[file.path]) continue;

            const stat = file.stat;
            if (!stat) continue;

            const created = stat.ctime;
            const modified = stat.mtime;

            this.noteViews[file.path] = {
                lastOpened: 0,
                viewCount: 0,
                history: [],
                historyEdit: [],
                created: created,
                refreshData: { stage: 0, lastRefresh: 0, missedDeadlines: 0 }
            };

            const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);
            const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

            if (modified > thirtyDaysAgo) {
                this.noteViews[file.path].historyEdit.push(modified);

                if (modified > sevenDaysAgo) {
                    this.noteViews[file.path].history.push(modified);
                    this.noteViews[file.path].lastOpened = modified;
                    this.noteViews[file.path].viewCount = 1;

                    const daysSinceModified = (now - modified) / (24 * 60 * 60 * 1000);
                    if (daysSinceModified <= 7) {
                        this.noteViews[file.path].refreshData.stage = 0;
                        this.noteViews[file.path].refreshData.lastRefresh = modified;
                    }
                }
            }

            initializedCount++;
        }

        await this.saveNoteViews();

        console.log(t('logInitialized', { count: initializedCount }));

        if (this.dashboardModal && this.dashboardModal.isDashboardActive) {
            await this.dashboardModal.loadData();
            await this.dashboardModal.renderDashboard(this.dashboardModal.contentEl);
        }

        new Notice(t('initSuccess', { count: initializedCount }));
    }

    async clearAnalyticsData() {
        if (confirm(t('clearConfirm'))) {
            try {
                const dataPath = await this.getDataFilePath();
                await this.app.vault.adapter.remove(dataPath);
                this.noteViews = {};
                console.log(t('logDataCleared'));
                new Notice(t('clearSuccess'));
            } catch (error) {
                console.error('Error clearing analytics data:', error);
                new Notice(t('clearError'));
            }
        }
    }

    async updateRefreshStage(path) {
        if (!path || !this.noteViews[path]) return;

        const now = Date.now();
        const v = this.noteViews[path];

        if (!v.refreshData) {
            v.refreshData = { stage: 0, lastRefresh: 0, missedDeadlines: 0 };
        }

        v.refreshData.stage = Math.min(v.refreshData.stage + 1, 4);
        v.refreshData.lastRefresh = now;

        await this.saveNoteViews();
    }

    onunload() {
        console.log(t('logUnloading'));

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveNoteViews();
    }
}

module.exports = OrdDashboardPlugin;

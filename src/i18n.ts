import { getLanguage } from 'obsidian';

// ---------------------------------------------------------------------------
// Translations
// ---------------------------------------------------------------------------

const EN = {
    ribbonTooltip: 'ORDdashboard: note analytics',
    cmdOpen: 'Open dashboard',
    cmdClear: 'Clear analytics data',
    cmdSeed: 'Seed activity from file dates',

    viewTitle: 'Dashboard',
    actionRefresh: 'Refresh',

    searchPlaceholder: 'Search notes',
    searchEmpty: 'Nothing found',

    statsNotes: 'Notes',
    statsViews: 'Views',
    statsEdits: 'Edits',
    statsActive: 'Active',
    statsActiveHint: 'Opened or edited in the last 30 days',

    sectionTop: 'Most active this month',
    metaViewsEdits: '__views__ views • __edits__ edits',

    sectionReview: 'Ready to refresh',
    reviewEmpty: 'No notes need refreshing',
    reviewStage: 'Stage __stage__',
    reviewDeadline: 'Deadline in __days__ d.',
    reviewOverdue: 'Overdue by __days__ d.',
    reviewNeverOpened: 'Never opened',
    reviewOpened: 'Opened __days__ d. ago',

    sectionRecent: 'Recently active',
    sectionAll: 'All notes',
    metaCreated: 'Created __time__',
    metaEdited: 'Edited __time__',
    metaOpened: 'Opened __time__',
    showMore: 'Show more (__count__)',

    graphTitle: 'Link graph',
    graphEmpty: 'No links in this vault yet',
    graphBuilding: 'Building graph… __percent__%',
    graphStats: '__nodes__ nodes · __edges__ links',
    graphFiltered: 'close links only',
    graphTruncated: 'of __total__ notes',
    graphRebuild: 'Rebuild graph',
    graphFit: 'Fit to panel',

    timeNow: 'just now',
    timeMinutes: '__n__ min ago',
    timeHours: '__n__ h ago',
    timeDays: '__n__ d ago',

    settingTrackViews: 'Track opened notes',
    settingTrackViewsDesc: 'Records when a note is opened.',
    settingTrackEdits: 'Track edited notes',
    settingTrackEditsDesc: 'Records when a note is edited.',
    settingRibbon: 'Show ribbon icon',
    settingRibbonDesc: 'Adds an icon to the ribbon that opens the dashboard.',
    groupGraph: 'Link graph',
    settingGraph: 'Show link graph',
    settingGraphDesc: 'Pins the link graph to the bottom of the panel, outside the scrolling list.',
    settingGraphScope: 'What to show',
    settingGraphScopeDesc: 'The neighbourhood of the open note, rebuilt whenever you open another note, or an overview of the whole vault.',
    graphScopeLocal: 'Around the open note',
    graphScopeVault: 'Whole vault',
    settingGraphDepth: 'Depth',
    settingGraphDepthDesc: 'How many link hops away from the open note the graph reaches.',
    graphDepth1: '1 hop',
    graphDepth2: '2 hops',
    graphDepth3: '3 hops',
    settingGraphRelevance: 'How close is close enough',
    settingGraphRelevanceDesc: 'Notes reached through links are kept only when they are measurably closer to this note than to a random note. "Core-like" keeps everything inside the depth limit, as the core graph does.',
    graphRelevanceStrict: 'Closest only',
    graphRelevanceNormal: 'Close links',
    graphRelevanceRelaxed: 'Same area',
    graphRelevanceCore: 'Core-like (everything)',
    settingGraphIndexNotes: 'Index notes',
    settingGraphIndexNotesDesc: 'A note linked to a large part of the vault is a table of contents, not a connection: it can be shown as dimmed context without lines, hidden, or drawn like the core does.',
    graphIndexContext: 'Dimmed context',
    graphIndexHidden: 'Hidden',
    graphIndexCore: 'Core-like (with links)',
    settingGraphPlace: 'Notes filed next to the open one',
    settingGraphPlaceDesc: 'Treats the notes in the open note\'s folder as its neighbours, even when nothing links them. Folders with more than 50 notes are ignored: there they stop meaning anything.',
    settingGraphNodes: 'Graph nodes',
    settingGraphNodesDesc: 'Upper limit of notes; the most connected ones are kept.',
    settingGraphAnimate: 'Animate layout',
    settingGraphAnimateDesc: 'Lets the graph settle softly and then freeze. Turn off for a static layout.',
    settingGraphNodeScale: 'Node size in the panel',
    settingGraphNodeScaleDesc: 'The core sizes nodes for a full graph window; the panel scales them down so a hub does not become a blob.',
    graphScaleFull: 'As in Obsidian',
    graphScale75: '75%',
    graphScale50: '50%',
    graphScale35: '35%',
    settingGraphHeight: 'Graph height',
    settingGraphHeightDesc: 'Share of the panel taken by the graph.',
    graphSizeSmall: 'Small',
    graphSizeMedium: 'Medium',
    graphSizeLarge: 'Large',
    groupData: 'Data',
    settingRecords: 'Tracked notes',
    settingRecordsDesc: '__count__ notes have recorded activity.',
    settingClear: 'Clear analytics data',
    settingClearDesc: 'Deletes all recorded activity. This cannot be undone.',

    clearTitle: 'Clear analytics data?',
    clearBody: 'All views, edits and refresh stages will be deleted. This cannot be undone.',
    clearCancel: 'Cancel',
    clearConfirm: 'Clear data',

    noticeCleared: 'ORDdashboard: analytics data cleared',
    noticeClearFailed: 'ORDdashboard: could not clear analytics data',
    noticeSeeded: 'ORDdashboard: activity seeded for __count__ notes',
    noticeSeedFailed: 'ORDdashboard: could not seed activity',
};

export type LangKey = keyof typeof EN;

// The Russian dictionary is typed as Record<LangKey, string>: a missing or
// misspelled key becomes a compile-time error.
const RU: Record<LangKey, string> = {
    ribbonTooltip: 'ORDdashboard: аналитика заметок',
    cmdOpen: 'Открыть дашборд',
    cmdClear: 'Очистить данные аналитики',
    cmdSeed: 'Заполнить активность по датам файлов',

    viewTitle: 'Дашборд',
    actionRefresh: 'Обновить',

    searchPlaceholder: 'Поиск заметок',
    searchEmpty: 'Ничего не найдено',

    statsNotes: 'Заметок',
    statsViews: 'Просмотров',
    statsEdits: 'Изменений',
    statsActive: 'Активных',
    statsActiveHint: 'Открывались или изменялись за последние 30 дней',

    sectionTop: 'Самые активные за месяц',
    metaViewsEdits: '__views__ просмотров • __edits__ изменений',

    sectionReview: 'Пора освежить',
    reviewEmpty: 'Нет заметок, которые стоит освежить',
    reviewStage: 'Стадия __stage__',
    reviewDeadline: 'До дедлайна: __days__ дн.',
    reviewOverdue: 'Просрочено на __days__ дн.',
    reviewNeverOpened: 'Не открывали',
    reviewOpened: 'Открывали __days__ дн. назад',

    sectionRecent: 'Недавно открывали',
    sectionAll: 'Все заметки',
    metaCreated: 'Создана __time__',
    metaEdited: 'Изменена __time__',
    metaOpened: 'Открыта __time__',
    showMore: 'Показать ещё (__count__)',

    graphTitle: 'Граф связей',
    graphEmpty: 'В этом хранилище пока нет связей',
    graphBuilding: 'Построение графа… __percent__%',
    graphStats: '__nodes__ узлов · __edges__ связей',
    graphFiltered: 'только близкие связи',
    graphTruncated: 'из __total__ заметок',
    graphRebuild: 'Перестроить граф',
    graphFit: 'Вписать в панель',

    timeNow: 'только что',
    timeMinutes: '__n__ мин назад',
    timeHours: '__n__ ч назад',
    timeDays: '__n__ дн. назад',

    settingTrackViews: 'Отслеживать открытие заметок',
    settingTrackViewsDesc: 'Записывать, когда заметку открывают.',
    settingTrackEdits: 'Отслеживать изменение заметок',
    settingTrackEditsDesc: 'Записывать, когда заметку изменяют.',
    settingRibbon: 'Показывать иконку на панели инструментов',
    settingRibbonDesc: 'Добавляет на панель инструментов иконку, открывающую дашборд.',
    groupGraph: 'Граф связей',
    settingGraph: 'Показывать граф связей',
    settingGraphDesc: 'Закрепляет граф связей внизу панели, вне прокручиваемого списка.',
    settingGraphScope: 'Что показывать',
    settingGraphScopeDesc: 'Окрестность открытой заметки — перестраивается при переходе к другой заметке, либо обзор всего хранилища.',
    graphScopeLocal: 'Вокруг открытой заметки',
    graphScopeVault: 'Всё хранилище',
    settingGraphDepth: 'Глубина',
    settingGraphDepthDesc: 'На сколько переходов по ссылкам от открытой заметки строится граф.',
    graphDepth1: '1 шаг',
    graphDepth2: '2 шага',
    graphDepth3: '3 шага',
    settingGraphRelevance: 'Насколько близко считается близким',
    settingGraphRelevanceDesc: 'Заметки, до которых граф дошёл по связям, остаются только если они измеримо ближе к текущей, чем к случайной заметке хранилища. «Как в ядре» оставляет всё в пределах глубины.',
    graphRelevanceStrict: 'Только ближайшие',
    graphRelevanceNormal: 'Близкие связи',
    graphRelevanceRelaxed: 'Та же область',
    graphRelevanceCore: 'Как в ядре (всё)',
    settingGraphIndexNotes: 'Заметки-оглавления',
    settingGraphIndexNotesDesc: 'Заметка, связанная со значительной частью хранилища, — это оглавление, а не связь: её можно показать приглушённым фоном без линий, скрыть или нарисовать как в ядре.',
    graphIndexContext: 'Приглушённый фон',
    graphIndexHidden: 'Скрывать',
    graphIndexCore: 'Как в ядре (со связями)',
    settingGraphPlace: 'Заметки рядом с открытой',
    settingGraphPlaceDesc: 'Считает заметки той же папки соседями открытой, даже если ссылок между ними нет. Папки, в которых больше 50 заметок, не учитываются: там папка уже ничего не значит.',
    settingGraphNodes: 'Узлов в графе',
    settingGraphNodesDesc: 'Предел числа заметок; остаются самые связанные.',
    settingGraphAnimate: 'Анимировать раскладку',
    settingGraphAnimateDesc: 'Граф мягко устаканивается и замирает. Выключите для статичной раскладки.',
    settingGraphNodeScale: 'Размер узлов в панели',
    settingGraphNodeScaleDesc: 'Ядро рассчитывает размер точек под полное окно графа; в панели они уменьшаются, чтобы хаб не превращался в пятно.',
    graphScaleFull: 'Как в Obsidian',
    graphScale75: '75%',
    graphScale50: '50%',
    graphScale35: '35%',
    settingGraphHeight: 'Высота графа',
    settingGraphHeightDesc: 'Доля панели, занятая графом.',
    graphSizeSmall: 'Маленький',
    graphSizeMedium: 'Средний',
    graphSizeLarge: 'Большой',
    groupData: 'Данные',
    settingRecords: 'Отслеживаемых заметок',
    settingRecordsDesc: 'У __count__ заметок есть записанная активность.',
    settingClear: 'Очистить данные аналитики',
    settingClearDesc: 'Удаляет всю записанную активность. Действие необратимо.',

    clearTitle: 'Очистить данные аналитики?',
    clearBody: 'Все просмотры, изменения и стадии повторения будут удалены. Действие необратимо.',
    clearCancel: 'Отмена',
    clearConfirm: 'Очистить',

    noticeCleared: 'ORDdashboard: данные аналитики очищены',
    noticeClearFailed: 'ORDdashboard: не удалось очистить данные аналитики',
    noticeSeeded: 'ORDdashboard: активность заполнена для __count__ заметок',
    noticeSeedFailed: 'ORDdashboard: не удалось заполнить активность',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isRu(): boolean {
    return getLanguage().toLowerCase().startsWith('ru');
}

export function t(key: LangKey, replacements?: Record<string, string>): string {
    let text: string = isRu() ? RU[key] : EN[key];
    if (replacements) {
        for (const [name, value] of Object.entries(replacements)) {
            text = text.replace(`__${name}__`, value);
        }
    }
    return text;
}

/** Оба словаря: нужны проверкам, чтобы наборы ключей не расходились. */
export const dictionaries: { en: Record<LangKey, string>; ru: Record<LangKey, string> } = {
    en: EN,
    ru: RU,
};

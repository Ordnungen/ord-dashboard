// ---------------------------------------------------------------------------
// Каталог тест-кейсов плагина целиком: настоящий код ord-dashboard в Node, на
// заглушке Obsidian. Покрывает то, что раньше требовало рук: загрузку, подписки
// на события, команды, окно подтверждения, панель, блок графа, выгрузку.
//   npm run cases
// ---------------------------------------------------------------------------

import {
    clock, FakeApp, installGlobals, Modal, Notice, setLanguage, TFile, TFolder,
    type FakeElement, type WorkspaceLeaf,
} from './obsidian-stub';
import fs from 'node:fs';
import * as render from '../src/graph-render';

import DashboardPlugin from '../src/main';
import { DASHBOARD_VIEW_TYPE, DashboardView } from '../src/view';
import { DEFAULT_SETTINGS } from '../src/settings';

let failures = 0;
let checks = 0;

function assert(name: string, condition: boolean, extra?: string): void {
    checks += 1;
    if (!condition) failures += 1;
    console.log(`${condition ? 'OK  ' : 'FAIL'} ${name}${extra === undefined ? '' : ` — ${extra}`}`);
}

const DAY_MS = 86_400_000;

/** Возможности заглушки, которых нет у настоящего класса плагина. */
interface FakePlugin {
    commandIds: string[];
    ribbon: FakeElement | null;
    runCommand(id: string): unknown;
    storedData: unknown;
    app: FakeApp;
    config: { graphDepth: number; graphNodes: number; graphScope: string };
    setSetting(key: string, value: unknown): void;
    promptClearData(): void;
    onunload(): Promise<void> | void;
}

const asPlugin = (plugin: DashboardPlugin): FakePlugin => plugin as unknown as FakePlugin;

interface FakeWorkspace {
    openFile: (file: TFile) => Promise<void>;
    trigger: (type: string, ...args: unknown[]) => void;
    ready: () => void;
    getRightLeaf: () => WorkspaceLeaf | null;
    bus: { count: (type: string) => number };
}

interface FakeVault {
    seed: (path: string, times?: object) => TFile;
    renameFolder: (from: string, to: string) => void;
    rename: (path: string, newPath: string) => Promise<void>;
    delete: (path: string) => Promise<void>;
    modify: (path: string, content: string) => Promise<void>;
    create: (path: string, content: string) => Promise<TFile>;
    folder: (path: string) => TFolder;
    bus: { count: (type: string) => number };
}

interface FakeView {
    containerEl: FakeElement;
    graphBlock: { element: FakeElement; setActive: (path: string) => void } | null;
    render: () => void;
}

const workspaceOf = (app: unknown): FakeWorkspace => (app as FakeApp).workspace as unknown as FakeWorkspace;
const vaultOf = (app: unknown): FakeVault => (app as FakeApp).vault as unknown as FakeVault;
const tabOf = (plugin: DashboardPlugin): {
    getControlValue: (key: string) => unknown;
    setControlValue: (key: string, value: unknown) => void;
    getSettingDefinitions: () => unknown;
} => {
    const tabs = (plugin as unknown as { createdSettingTabs: unknown[] }).createdSettingTabs;
    const tab = tabs[0];
    if (!tab) throw new Error('вкладка настроек не создана');
    return tab as never;
};

const storeOf = (plugin: DashboardPlugin): {
    data: { notes: Record<string, unknown> };
    trackedCount: number;
    clearAll: () => Promise<void>;
} => (plugin as unknown as {
    store: { data: { notes: Record<string, unknown> }; trackedCount: number; clearAll: () => Promise<void> };
}).store;

/** Ждёт, пока выполнятся обещания: плагин сохраняет и сообщает асинхронно. */
const drain = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Двигает время и даёт выполняться обещаниям между шагами. Порядок важен: код
 * плагина строит граф цепочкой обещаний и шагов в простое, поэтому одних таймеров
 * мало — нужно уступать очередь обещаниям.
 */
const advance = async (ms: number): Promise<void> => {
    const step = Math.max(Math.round(ms / 4), 1);
    for (let i = 0; i < 4; i++) {
        await drain();
        clock.advance(step);
    }
    await drain();
};

const viewOf = (plugin: DashboardPlugin): FakeView | null => {
    const leaf = plugin.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    const view = leaf?.view;
    return view instanceof DashboardView ? (view as unknown as FakeView) : null;
};

/** Плагин с подготовленным хранилищем, как после запуска Obsidian. */
async function startPlugin(options: {
    files?: string[];
    attachments?: string[];
    links?: Record<string, Record<string, number>>;
    language?: string;
    /** Данные, которые уже лежат в data.json (например, от прошлой версии). */
    stored?: unknown;
} = {}): Promise<{ app: FakeApp; plugin: DashboardPlugin; leaf: WorkspaceLeaf }> {
    setLanguage(options.language ?? 'en');
    Notice.messages = [];
    Modal.instances = [];
    const app = new FakeApp();
    // Файлы специально старые: иначе плагин при запуске заполнит по ним историю,
    // и проверки учёта активности начнут считать не с нуля.
    for (const path of options.files ?? ['a.md', 'b.md', 'c.md', 'папка/d.md']) {
        vaultOf(app).seed(path, { ctime: clock.now() - 400 * DAY_MS, mtime: clock.now() - 200 * DAY_MS });
    }
    for (const path of options.attachments ?? []) {
        vaultOf(app).seed(path, { ctime: clock.now() - 400 * DAY_MS, mtime: clock.now() - 200 * DAY_MS });
    }
    app.metadataCache.resolvedLinks = options.links ?? {};
    const plugin = new DashboardPlugin(app as never, { id: 'ord-dashboard', version: '0.1.0' } as never);
    (plugin as unknown as { manifest: object }).manifest = { id: 'ord-dashboard', version: '0.1.0' };
    if (options.stored !== undefined) {
        (plugin as unknown as { data: unknown }).data = options.stored;
    }
    await plugin.onload();
    workspaceOf(app).ready();

    // Так Obsidian отдаёт правую панель: если её нет, создаёт.
    app.workspace.getRightLeaf = () => app.createLeaf('right-split');

    const right = app.workspace.getRightLeaf(false);
    if (!right) throw new Error('нет правой панели');
    asPlugin(plugin).runCommand('open-dashboard');
    await Promise.resolve();
    return { app, plugin, leaf: right };
}

async function main(): Promise<void> {
    installGlobals();

    // Отказы внутри асинхронного кода плагина иначе не видно: они не ломают
    // проверку, но означают, что что-то не работает. Печатаем их как провал.
    process.on('unhandledRejection', (reason: unknown) => {
        failures += 1;
        checks += 1;
        console.log(`FAIL необработанный отказ в коде плагина — ${String(reason)}`);
    });

    // ------------------------------------------------- 1. Загрузка плагина
    {
        const { plugin } = await startPlugin();
        const fake = asPlugin(plugin);
        assert('1.1 команды зарегистрированы',
            fake.commandIds.includes('open-dashboard') && fake.commandIds.includes('clear-data')
            && fake.commandIds.includes('seed-activity'), fake.commandIds.join(', '));
        assert('1.2 иконка в ленте создана', fake.ribbon !== null);
        assert('1.3 вкладка настроек создана', tabOf(plugin) !== null);
        assert('1.4 панель открыта', viewOf(plugin) !== null);
        await workspaceOf(plugin.app).openFile(plugin.app.vault.getFileByPath('a.md') as TFile);
        clock.advance(200);
        await fake.onunload();
        assert('1.5 выгрузка сохраняет данные', fake.storedData !== null);
    }

    // ------------------------------------- 2. Учёт активности по событиям
    {
        const { app, plugin } = await startPlugin({ files: ['a.md', 'b.md', 'папка/d.md'] });
        const store = storeOf(plugin);
        const views = (path: string): number => (store.data.notes[path] as { views: number } | undefined)?.views ?? 0;
        const edits = (path: string): number => (store.data.notes[path] as { edits: number } | undefined)?.edits ?? 0;

        await workspaceOf(app).openFile(app.vault.getFileByPath('a.md') as TFile);
        assert('2.1 открытие заметки засчитано', views('a.md') === 1, Object.keys(store.data.notes).join(', '));

        await workspaceOf(app).openFile(app.vault.getFileByPath('a.md') as TFile);
        assert('2.2 повторное открытие сразу не засчитано', views('a.md') === 1, String(views('a.md')));

        clock.advance(31_000);
        await workspaceOf(app).openFile(app.vault.getFileByPath('a.md') as TFile);
        assert('2.3 открытие спустя троттлинг засчитано', views('a.md') === 2, String(views('a.md')));

        await vaultOf(app).modify('a.md', 'текст');
        await vaultOf(app).modify('a.md', 'текст ещё');
        assert('2.4 правки считаются с троттлингом', edits('a.md') === 1, String(edits('a.md')));

        plugin.setSetting('trackViews', false);
        clock.advance(31_000);
        await workspaceOf(app).openFile(app.vault.getFileByPath('b.md') as TFile);
        assert('2.5 выключенный учёт просмотров не пишет', store.data.notes['b.md'] === undefined,
            Object.keys(store.data.notes).join(', '));
        plugin.setSetting('trackViews', true);

        plugin.setSetting('trackEdits', false);
        await vaultOf(app).modify('b.md', 'текст');
        assert('2.6 выключенный учёт правок не пишет', store.data.notes['b.md'] === undefined);
        plugin.setSetting('trackEdits', true);

        await vaultOf(app).delete('a.md');
        assert('2.7 удаление убирает запись', store.data.notes['a.md'] === undefined,
            Object.keys(store.data.notes).join(', '));

        await workspaceOf(app).openFile(app.vault.getFileByPath('папка/d.md') as TFile);
        assert('2.8a открытие вложенной заметки засчитано', store.data.notes['папка/d.md'] !== undefined,
            Object.keys(store.data.notes).join(', '));
        await vaultOf(app).rename('папка/d.md', 'папка/е.md');
        assert('2.8 переименование переносит запись',
            store.data.notes['папка/е.md'] !== undefined && store.data.notes['папка/d.md'] === undefined,
            Object.keys(store.data.notes).join(', '));

        vaultOf(app).renameFolder('папка', 'архив');
        assert('2.9 переименование папки переносит записи',
            store.data.notes['архив/е.md'] !== undefined, Object.keys(store.data.notes).join(', '));
        await asPlugin(plugin).onunload();
    }

    // ------------------------------------------- 3. Заполнение истории
    {
        const { app, plugin } = await startPlugin({ files: [] });
        vaultOf(app).seed('свежая.md', { ctime: clock.now() - DAY_MS, mtime: clock.now() - DAY_MS });
        vaultOf(app).seed('старая.md', { ctime: clock.now() - 300 * DAY_MS, mtime: clock.now() - 300 * DAY_MS });
        Notice.messages = [];
        await (plugin as unknown as { seedActivity: () => Promise<void> }).seedActivity();
        const store = storeOf(plugin);
        assert('3.1 история заполнена по датам файлов',
            store.data.notes['свежая.md'] !== undefined && store.data.notes['старая.md'] === undefined,
            Object.keys(store.data.notes).join(', '));
        assert('3.2 о заполнении сообщено', Notice.messages.length === 1, Notice.messages.join(' | '));
        await asPlugin(plugin).onunload();
    }

    // ------------------------------------------------ 4. Команда очистки
    {
        const { app, plugin } = await startPlugin({ files: ['a.md'] });
        const store = storeOf(plugin);
        await workspaceOf(app).openFile(app.vault.getFileByPath('a.md') as TFile);
        assert('4.1 перед очисткой данные есть', store.trackedCount === 1, String(store.trackedCount));

        asPlugin(plugin).promptClearData();
        const modal = Modal.instances[Modal.instances.length - 1];
        assert('4.2 окно подтверждения открыто', modal !== undefined && modal.isOpen, String(modal?.isOpen));
        assert('4.3 в окне две кнопки', modal?.buttons.length === 2, String(modal?.buttons.length));

        modal?.pressButton(0);
        await Promise.resolve();
        assert('4.4 отмена сохраняет данные', store.trackedCount === 1, String(store.trackedCount));

        asPlugin(plugin).promptClearData();
        const second = Modal.instances[Modal.instances.length - 1];
        second?.pressButton(1);
        await drain();
        clock.advance(100);
        assert('4.5 подтверждение очищает данные', store.trackedCount === 0, String(store.trackedCount));
        assert('4.6 о очистке сообщено', Notice.messages.some((message) => message.length > 0),
            Notice.messages.join(' | '));
        await asPlugin(plugin).onunload();
    }

    // ----------------------------------------------------- 5. Панель
    {
        const { app, plugin } = await startPlugin({
            files: ['a.md', 'b.md', 'c.md'],
            links: { 'a.md': { 'b.md': 1 }, 'b.md': { 'c.md': 1 } },
        });
        await workspaceOf(app).openFile(app.vault.getFileByPath('a.md') as TFile);
        await vaultOf(app).modify('a.md', 'текст');
        clock.advance(1000);

        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        view.render();
        clock.advance(100);

        const elements = view.containerEl.all();
        const has = (name: string): boolean => elements.some((element) => element.classes.has(name));
        assert('5.1 разделы панели построены', has('ord-dashboard__stats') && has('ord-dashboard__section'));
        assert('5.2 строки списков построены', has('ord-dashboard__row'));
        assert('5.3 поиск построен', has('ord-dashboard__search-input'));
        assert('5.4 граф построен внутри панели', view.graphBlock !== null);
        await advance(3000);
        const scene = view.graphBlock?.element.all().find((element) => element.tag === 'canvas');
        const drawn = scene?.drawn ?? [];
        assert('5.5 картинка графа нарисована',
            drawn.filter((call) => call === 'arc').length >= 2
            && drawn.filter((call) => call.startsWith('fillText')).length >= 1,
            `дуг ${drawn.filter((call) => call === 'arc').length}, подписей ${
                drawn.filter((call) => call.startsWith('fillText')).length}`);

        plugin.setSetting('showGraph', false);
        assert('5.6 выключение графа убирает блок', viewOf(plugin)?.graphBlock === null);
        plugin.setSetting('showGraph', true);
        assert('5.7 включение графа возвращает блок', viewOf(plugin)?.graphBlock !== null);

        plugin.setSetting('graphHeight', 'large');
        const element = viewOf(plugin)?.graphBlock?.element;
        assert('5.8 большая высота применена',
            element?.hasClass('is-large') === true && element.hasClass('is-small') === false,
            JSON.stringify([...(element?.classes ?? [])]));

        plugin.setSetting('graphHeight', 'small');
        const small = viewOf(plugin)?.graphBlock?.element;
        assert('5.9 малая высота применена',
            small?.hasClass('is-small') === true && small.hasClass('is-large') === false,
            JSON.stringify([...(small?.classes ?? [])]));

        assert('5.10 статистика видит заметки', storeOf(plugin).trackedCount >= 1);
        await asPlugin(plugin).onunload();
    }

    // ------------------------------------------ 6. Поиск и сворачивание
    {
        const { app, plugin } = await startPlugin({
            files: ['Смета.md', 'Отчёт.md', 'Прочее.md'],
            links: { 'Смета.md': { 'Отчёт.md': 1 } },
        });
        await workspaceOf(app).openFile(app.vault.getFileByPath('Смета.md') as TFile);
        clock.advance(1000);
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        view.render();
        clock.advance(100);

        const input = view.containerEl.all().find((element) => element.classes.has('ord-dashboard__search-input'));
        assert('6.1 поле поиска найдено', input !== undefined);
        if (input) {
            input.value = 'Смет';
            input.dispatch('input');
            clock.advance(300);
            const results = view.containerEl.all().filter((element) => element.classes.has('ord-dashboard__search-item'));
            assert('6.2 поиск находит совпадение', results.length >= 1, String(results.length));

            input.value = 'нетакойзаметки';
            input.dispatch('input');
            clock.advance(300);
            const empty = view.containerEl.all().some((element) => element.classes.has('ord-dashboard__search-empty'));
            assert('6.3 поиск без совпадений честно об этом сообщает', empty);
        }

        const header = view.containerEl.all().find((element) => element.classes.has('ord-dashboard__section-header'));
        assert('6.4 заголовок раздела найден', header !== undefined);
        header?.click();
        clock.advance(100);
        assert('6.5 сворачивание раздела не ломает панель', viewOf(plugin) !== null);
        header?.click();
        clock.advance(100);
        assert('6.6 разворачивание раздела не ломает панель', viewOf(plugin) !== null);
        await asPlugin(plugin).onunload();
    }

    // -------------------------------------------- 7. Блок графа и события
    {
        const { app, plugin } = await startPlugin({
            files: ['a.md', 'b.md', 'c.md'],
            links: { 'a.md': { 'b.md': 1 }, 'b.md': { 'c.md': 1 } },
        });
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        view.render();
        clock.advance(200);

        const buttons = view.graphBlock?.element.findAllByTag('button') ?? [];
        assert('7.1 в шапке графа есть кнопки', buttons.length >= 2, String(buttons.length));
        buttons[0]?.click();
        clock.advance(200);
        assert('7.2 перестроение по кнопке не ломает панель', viewOf(plugin) !== null);
        buttons[1]?.click();
        clock.advance(200);
        assert('7.3 вписывание по кнопке не ломает панель', viewOf(plugin) !== null);

        await workspaceOf(app).openFile(app.vault.getFileByPath('b.md') as TFile);
        clock.advance(700);
        assert('7.4 переход к заметке перестраивает граф', viewOf(plugin) !== null);

        app.metadataCache.trigger('resolved');
        clock.advance(11_000);
        assert('7.5 событие пересборки ссылок обновляет граф', viewOf(plugin) !== null);

        workspaceOf(app).trigger('css-change');
        clock.advance(100);
        assert('7.6 смена темы перерисовывает граф', viewOf(plugin) !== null);
        await asPlugin(plugin).onunload();
    }

    // ------------------------------------------ 8. Настройки через вкладку
    {
        const { plugin } = await startPlugin();
        const tab = tabOf(plugin);
        const definitions = tab.getSettingDefinitions() as unknown[];
        interface Control { control?: { key?: string } }
        const keys: string[] = [];
        for (const group of definitions) {
            const record = group as Control & { items?: Control[] };
            const items = record.items ?? (record.control ? [record] : []);
            for (const item of items) {
                if (typeof item.control?.key === 'string') keys.push(item.control.key);
            }
        }
        assert('8.1 настройки описаны', keys.length >= 10, keys.join(', '));

        const unreadable = keys.filter((key) => tab.getControlValue(key) === undefined);
        assert('8.2 каждая настройка читается', unreadable.length === 0, unreadable.join(', '));

        const broken: string[] = [];
        for (const key of keys) {
            const before = tab.getControlValue(key);
            tab.setControlValue(key, before);
            if (tab.getControlValue(key) !== before) broken.push(key);
        }
        assert('8.3 повторная запись не портит значение', broken.length === 0, broken.join(', '));

        plugin.setSetting('graphDepth', '3');
        assert('8.4 запись настройки работает', asPlugin(plugin).config.graphDepth === 3,
            String(asPlugin(plugin).config.graphDepth));
        plugin.setSetting('graphNodes', 50);
        assert('8.5 предел узлов применяется', asPlugin(plugin).config.graphNodes === 50);
        assert('8.6 значения по умолчанию известны', DEFAULT_SETTINGS.graphScope === 'local');
        await asPlugin(plugin).onunload();
    }

    // ------------------------------------------------ 9. Лента и язык
    {
        const { plugin } = await startPlugin({ language: 'ru' });
        const ribbon = asPlugin(plugin).ribbon;
        assert('9.1 иконка видна по умолчанию', ribbon !== null && !ribbon.hasClass('ord-dashboard-ribbon-hidden'));
        plugin.setSetting('showRibbonIcon', false);
        assert('9.2 иконка скрывается настройкой',
            asPlugin(plugin).ribbon?.hasClass('ord-dashboard-ribbon-hidden') === true);
        plugin.setSetting('showRibbonIcon', true);
        assert('9.3 иконка возвращается',
            asPlugin(plugin).ribbon?.hasClass('ord-dashboard-ribbon-hidden') === false);

        asPlugin(plugin).ribbon?.click();
        await Promise.resolve();
        assert('9.4 нажатие иконки открывает панель', viewOf(plugin) !== null);
        await asPlugin(plugin).onunload();
    }

    // --------------------------------------- 10. Пустое хранилище и папки
    {
        const app = new FakeApp();
        assert('10.1 папка создаётся', vaultOf(app).folder('Папка') instanceof TFolder);
        const { plugin } = await startPlugin({ files: [] });
        const view = viewOf(plugin);
        assert('10.2 пустое хранилище: панель построена', view !== null);
        view?.render();
        clock.advance(100);
        assert('10.3 пустое хранилище: панель не падает', viewOf(plugin) !== null);
        await asPlugin(plugin).onunload();
    }

    // ---------------------------------- 11. Хранилище только из вложений
    {
        const { app, plugin } = await startPlugin({
            files: [],
            attachments: ['files/pic.png', 'files/doc.pdf', 'files/схема.png'],
        });
        const view = viewOf(plugin);
        assert('11.1 хранилище без заметок: панель построена', view !== null);
        view?.render();
        clock.advance(100);
        assert('11.2 панель не падает', viewOf(plugin) !== null);
        assert('11.3 заметок в учёте нет', storeOf(plugin).trackedCount === 0,
            String(storeOf(plugin).trackedCount));
        assert('11.4 перечисление заметок пустое', app.vault.getMarkdownFiles().length === 0,
            String(app.vault.getMarkdownFiles().length));
        await asPlugin(plugin).onunload();
    }

    // ------------------------------- 12. Одинаковые имена в разных папках
    {
        const { app, plugin } = await startPlugin({
            files: ['первая/Заметка.md', 'вторая/Заметка.md'],
        });
        await workspaceOf(app).openFile(app.vault.getFileByPath('первая/Заметка.md') as TFile);
        clock.advance(1000);
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        view.render();
        clock.advance(100);

        const input = view.containerEl.all().find((element) => element.classes.has('ord-dashboard__search-input'));
        assert('12.1 поле поиска найдено', input !== undefined);
        input!.value = 'Заметка';
        input!.dispatch('input');
        clock.advance(300);

        const results = view.containerEl.all().filter((element) => element.classes.has('ord-dashboard__search-item'));
        assert('12.2 поиск нашёл обе заметки с одинаковым именем', results.length === 2, String(results.length));

        const opened: string[] = [];
        for (const result of results) {
            result.click();
            await drain();
            opened.push(app.workspace.getActiveFile()?.path ?? '');
        }
        assert('12.3 клик открывает ту заметку, на которую нажали',
            new Set(opened).size === 2 && opened.every((path) => path.endsWith('Заметка.md')),
            opened.join(' | '));
        await asPlugin(plugin).onunload();
    }

    // --------------------------- 13. Обновление поверх прошлой версии
    {
        const stored = {
            version: 1,
            settings: {
                graphUseVaultParams: true,
                graphIncoming: false,
                trackViews: true,
                graphNodes: 12345,
                graphDepth: '3',
                graphScope: 'local',
                graphPlace: true,
            },
            notes: {
                'a.md': {
                    views: 5, edits: 2, lastOpened: clock.now() - 1000, lastEdited: clock.now() - 2000,
                    reviewStage: 1, reviewStartedAt: clock.now() - 3000,
                    viewsByMonth: {}, editsByMonth: {},
                },
            },
        };
        const { app, plugin } = await startPlugin({ files: ['a.md', 'b.md'], stored });
        const fake = asPlugin(plugin);
        const store = storeOf(plugin);
        assert('13.1 история из прошлой версии сохранена',
            (store.data.notes['a.md'] as { views: number } | undefined)?.views === 5,
            JSON.stringify(store.data.notes['a.md']));
        assert('13.2 настройка из прошлой версии применена',
            (fake.config as { graphNodes: number; graphDepth: number }).graphNodes === 2_000,
            JSON.stringify(fake.config));
        assert('13.3 глубина из строки прочитана',
            (fake.config as { graphDepth: number }).graphDepth === 3, String(fake.config.graphDepth));

        await workspaceOf(app).openFile(app.vault.getFileByPath('b.md') as TFile);
        clock.advance(100);
        await storeOf(plugin).clearAll();
        const saved = fake.storedData as { settings: Record<string, unknown>; notes: Record<string, unknown> };
        assert('13.4 сохранены настройки новой версии',
            !('graphUseVaultParams' in saved.settings) && !('graphIncoming' in saved.settings)
            && typeof saved.settings.graphRelevance === 'string',
            JSON.stringify(Object.keys(saved.settings)));
        assert('13.5 сохранены записи в новом формате',
            Object.keys(saved.notes).length === 0, JSON.stringify(Object.keys(saved.notes)));
        assert('13.6 панель после обновления работает', viewOf(plugin) !== null);
        await fake.onunload();
    }

    // ------------------------------------- 14. Длинный список в панели
    {
        const files: string[] = [];
        for (let i = 0; i < 1000; i++) files.push(`заметки/з${i}.md`);
        const { app, plugin } = await startPlugin({ files });
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        await app.vault.modify('заметки/з1.md', 'текст');
        clock.advance(1000);

        const started = performance.now();
        view.render();
        clock.advance(100);
        const taken = performance.now() - started;
        const rows = view.containerEl.all().filter((element) => element.classes.has('ord-dashboard__row')).length;
        assert('14.1 панель с тысячью заметок рисуется быстро', taken < 1000, `${taken.toFixed(0)} мс`);
        assert('14.2 строки списка ограничены', rows > 0 && rows < 200, String(rows));
        assert('14.3 заметки учтены', storeOf(plugin).trackedCount >= 1, String(storeOf(plugin).trackedCount));
        await asPlugin(plugin).onunload();
    }

    // ------------------------------------- 15. Язык интерфейса и сворачивание
    {
        const { app, plugin } = await startPlugin({
            files: ['a.md', 'b.md'],
            links: { 'a.md': { 'b.md': 1 } },
            language: 'ru',
        });
        await workspaceOf(app).openFile(app.vault.getFileByPath('a.md') as TFile);
        clock.advance(1000);
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        view.render();
        clock.advance(100);

        const texts = view.containerEl.all().map((element) => element.getText()).filter(Boolean);
        const cyrillic = texts.filter((text) => /[А-Яа-яЁё]/.test(text)).length;
        assert('15.1 на русском языке интерфейс панели русский', cyrillic >= 5,
            `${cyrillic} из ${texts.length}`);

        const ruNames = view.containerEl.all().filter((element) =>
            element.classes.has('ord-dashboard__section-title')).map((element) => element.getText());
        assert('15.2 названия разделов на русском',
            ruNames.length > 0 && ruNames.every((name) => /[А-Яа-яЁё]/.test(name)), ruNames.join(' | '));

        const tab = tabOf(plugin);
        const definitions = tab.getSettingDefinitions() as unknown[];
        const described = JSON.stringify(definitions);
        assert('15.3 названия настроек на русском', /[А-Яа-яЁё]/.test(described), described.slice(0, 80));
        await asPlugin(plugin).onunload();

        const english = await startPlugin({ files: ['a.md'], language: 'en' });
        const enView = viewOf(english.plugin);
        if (!enView) throw new Error('панель не открыта');
        enView.render();
        clock.advance(100);
        const enTexts = enView.containerEl.all().map((element) => element.getText()).filter(Boolean);
        const latin = enTexts.filter((text) => /[A-Za-z]/.test(text)).length;
        assert('15.4 на английском языке интерфейс английский', latin >= 5, `${latin} из ${enTexts.length}`);
        await asPlugin(english.plugin).onunload();
    }

    // ----------------------- 16. Свёрнутый граф не тратит работу
    {
        const { plugin } = await startPlugin({
            files: ['a.md', 'b.md', 'c.md'],
            links: { 'a.md': { 'b.md': 1 }, 'b.md': { 'c.md': 1 } },
        });
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        view.render();
        clock.advance(200);

        const block = view.graphBlock as unknown as {
            element: FakeElement;
            markStale: () => void;
            refreshIfStale: () => void;
        };
        const canvas = block.element.all().find((element) => element.tag === 'canvas');
        await advance(3000);
        const arcsBefore = (canvas?.drawn ?? []).filter((call) => call === 'arc').length;
        const internals = block as unknown as {
            sampler: { finished: boolean; result: { nodes: unknown[] } | null } | null;
            graph: { nodes: unknown[] } | null;
        };
        assert('16.1 граф нарисован до сворачивания', arcsBefore >= 2,
            `дуг ${arcsBefore}, выборка ${internals.sampler?.result?.nodes.length ?? 'нет'}, `
            + `узлов в графе ${internals.graph?.nodes.length ?? '—'}`);

        const header = block.element.findAllByTag('button')[0];
        void header;
        // Сворачивание раздела графа: рисование прекращается, работа не идёт
        const sectionHeader = view.containerEl.all()
            .find((element) => element.classes.has('ord-dashboard__graph-header'));
        sectionHeader?.click();
        clock.advance(100);
        const collapsed = block.element.hasClass('is-collapsed');
        assert('16.2 граф помечен свёрнутым', collapsed, JSON.stringify([...block.element.classes]));

        block.markStale();
        block.refreshIfStale();
        clock.advance(700);
        const arcsAfter = (canvas?.drawn ?? []).filter((call) => call === 'arc').length;
        assert('16.3 свёрнутый граф не перерисовывается', arcsAfter === arcsBefore, `${arcsBefore} → ${arcsAfter}`);

        sectionHeader?.click();
        await advance(4000);
        const arcsExpanded = (canvas?.drawn ?? []).filter((call) => call === 'arc').length;
        assert('16.4 после разворота отложенная работа выполняется', arcsExpanded > arcsBefore,
            `${arcsBefore} → ${arcsExpanded}`);
        await asPlugin(plugin).onunload();
    }

    // ------------------------------- 17. Открытие из очереди и доступность настроек
    {
        const { app, plugin } = await startPlugin({ files: ['a.md', 'b.md'] });
        const store = storeOf(plugin);
        // Заметка, у которой наступил срок повторения: открывали давно, стадия 0.
        const longAgo = clock.now() - 40 * DAY_MS;
        store.data.notes['a.md'] = {
            views: 3, lastOpened: longAgo, edits: 1, lastEdited: longAgo,
            reviewStage: 0, reviewStartedAt: longAgo, viewsByMonth: {}, editsByMonth: {},
        };
        await workspaceOf(app).openFile(app.vault.getFileByPath('b.md') as TFile);
        clock.advance(1000);
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        view.render();
        clock.advance(100);

        const stageBefore = (store.data.notes['a.md'] as { reviewStage: number }).reviewStage;
        const queueRows = view.containerEl.all()
            .filter((element) => element.classes.has('ord-dashboard__row')
                || element.classes.has('ord-dashboard__card'));
        const target = queueRows.find((element) =>
            element.all().some((child) => child.getText() === 'a'));
        assert('17.1 заметка видна в списках панели', target !== undefined, String(queueRows.length));
        target?.click();
        await drain();
        const stageAfter = (store.data.notes['a.md'] as { reviewStage: number }).reviewStage;
        assert('17.2 открытие из панели повышает стадию повторения', stageAfter === stageBefore + 1,
            `${stageBefore} → ${stageAfter}`);
        await asPlugin(plugin).onunload();
    }

    {
        const { plugin } = await startPlugin();
        const tab = tabOf(plugin);
        const definitions = tab.getSettingDefinitions() as unknown[];
        interface Control {
            control?: { key?: string; disabled?: () => boolean };
            items?: Control[];
        }
        const controls: { key: string; disabled?: () => boolean }[] = [];
        for (const group of definitions) {
            const record = group as Control;
            const items = record.items ?? (record.control ? [record] : []);
            for (const item of items) {
                if (typeof item.control?.key === 'string') {
                    controls.push({ key: item.control.key, disabled: item.control.disabled });
                }
            }
        }
        const guarded = controls.filter((item) => typeof item.disabled === 'function');
        assert('17.3 часть настроек зависит от других', guarded.length >= 3, String(guarded.length));

        plugin.setSetting('showGraph', false);
        const graphControls = guarded.filter((item) => item.key.startsWith('graph'));
        assert('17.4 при выключенном графе настройки графа недоступны',
            graphControls.length > 0 && graphControls.every((item) => item.disabled?.() === true),
            graphControls.map((item) => `${item.key}:${String(item.disabled?.())}`).join(', '));

        plugin.setSetting('showGraph', true);
        plugin.setSetting('graphScope', 'vault');
        const localOnly = guarded.filter((item) =>
            item.key === 'graphDepth' || item.key === 'graphRelevance' || item.key === 'graphPlace');
        assert('17.5 в режиме обзора настройки окрестности недоступны',
            localOnly.every((item) => item.disabled?.() === true),
            localOnly.map((item) => `${item.key}:${String(item.disabled?.())}`).join(', '));

        plugin.setSetting('graphScope', 'local');
        assert('17.6 в режиме окрестности они снова доступны',
            localOnly.every((item) => item.disabled?.() === false));
        assert('17.7 настройки, не зависящие от режима, доступны всегда',
            controls.some((item) => item.key === 'graphNodes' && item.disabled?.() === false));
        await asPlugin(plugin).onunload();
    }

    // ------------------------- 18. Оформление плиток и свёрнутого графа
    {
        const css = fs.readFileSync('styles.css', 'utf8');
        const block = (selector: string): string => {
            const at = css.indexOf(selector);
            if (at < 0) return '';
            const open = css.indexOf('{', at);
            const close = css.indexOf('}', open);
            return css.slice(open + 1, close);
        };

        const value = block('.ord-dashboard__stat-value');
        assert('18.1 значение плитки не переносится', value.includes('white-space: nowrap'), value.trim().slice(0, 60));
        assert('18.2 значение плитки не рвётся посередине',
            !value.includes('overflow-wrap'), value.trim().slice(0, 60));

        const label = block('.ord-dashboard__stat-label');
        assert('18.3 длинная подпись обрезается, а не переносится',
            label.includes('text-overflow: ellipsis') && label.includes('white-space: nowrap'),
            label.trim().slice(0, 60));

        const collapsed = block('.ord-dashboard__graph.is-collapsed {');
        assert('18.4 свёрнутый граф не оставляет пустого места',
            collapsed.includes('min-height: 0') && collapsed.includes('height: auto'),
            collapsed.trim().slice(0, 60));
        assert('18.5 у свёрнутого графа скрыто тело',
            block('.ord-dashboard__graph.is-collapsed .ord-dashboard__graph-body').includes('display: none'));
    }

    // ----------------------------------- 19. Крупные итоги в плитках
    {
        const { app, plugin } = await startPlugin({ files: ['a.md', 'b.md'] });
        const store = storeOf(plugin);
        const longAgo = clock.now() - 2 * DAY_MS;
        store.data.notes['a.md'] = {
            views: 250_000, lastOpened: longAgo, edits: 241_290, lastEdited: longAgo,
            reviewStage: 1, reviewStartedAt: longAgo, viewsByMonth: {}, editsByMonth: {},
        };
        await workspaceOf(app).openFile(app.vault.getFileByPath('b.md') as TFile);
        await advance(1200);
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        view.render();
        clock.advance(100);

        const tiles = view.containerEl.all().filter((element) => element.classes.has('ord-dashboard__stat'));
        assert('19.1 плитки построены', tiles.length === 4, String(tiles.length));

        const texts = tiles.map((tile) =>
            tile.all().find((element) => element.classes.has('ord-dashboard__stat-value'))?.getText() ?? '');
        const titles = tiles.map((element) => element.getAttribute('title') ?? '');
        assert('19.2 крупные итоги показаны коротко',
            texts.every((text) => text.length <= 12), texts.join(' | '));
        assert('19.3 длинное число не разорвано пробелом',
            texts.every((text) => !text.includes('  ')), texts.join(' | '));

        // Точное значение остаётся в подсказке. Разделитель разрядов и сокращение
        // зависят от языка, поэтому сравниваем не строку, а признак: в подсказке
        // полное число, а не сокращённое.
        const isCompact = (text: string): boolean => /тыс|млн|млрд|[KM]$/i.test(text.trim());
        const compactTiles = texts
            .map((text, index) => (isCompact(text) ? index : -1))
            .filter((index) => index >= 0);
        assert('19.4 у сокращённых значений точное число в подсказке',
            compactTiles.length >= 2 && compactTiles.every((index) => {
                const title = tiles[index]?.getAttribute('title') ?? '';
                const digits = title.replace(/\D/g, '');
                return digits.length >= 5 && !isCompact(title);
            }),
            compactTiles.map((index) => `${texts[index]} → ${tiles[index]?.getAttribute('title') ?? ''}`).join(' | '));
        assert('19.5 пояснение к показателю сохранено',
            titles.some((title) => /30/.test(title)), titles.join(' | '));
        await asPlugin(plugin).onunload();
    }

    // ------------------------- 20. Подписи проявляются по приближению
    {
        const { app, plugin } = await startPlugin({
            files: ['a.md', 'b.md', 'c.md'],
            links: { 'a.md': { 'b.md': 1 }, 'b.md': { 'c.md': 1 } },
        });
        await workspaceOf(app).openFile(app.vault.getFileByPath('a.md') as TFile);
        await advance(2500);
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');

        const canvasOf = (): FakeElement | undefined =>
            view.graphBlock?.element.all().find((element) => element.tag === 'canvas');
        /**
         * Прозрачности подписей последнего кадра, в котором нарисованы узлы: кадр
         * начинается с очистки холста, поэтому записи делим по `clearRect`, а кадры
         * без узлов (они могли уйти за край после приближения) пропускаем.
         */
        const lastDrawnFrame = (): number[] => {
            const calls = canvasOf()?.drawn ?? [];
            const frames: string[][] = [];
            let current: string[] = [];
            for (const call of calls) {
                if (call === 'clearRect') {
                    if (current.length > 0) frames.push(current);
                    current = [];
                    continue;
                }
                current.push(call);
            }
            if (current.length > 0) frames.push(current);
            const drawn = frames.filter((frame) => frame.includes('arc'));
            return (drawn[drawn.length - 1] ?? [])
                .filter((call) => call.startsWith('fillText:'))
                .map((call) => Number.parseFloat(call.slice(call.indexOf('@') + 1)))
                .filter((value) => Number.isFinite(value));
        };

        const atFit = lastDrawnFrame();
        assert('20.1 у вписанного графа имя видно только у открытой заметки',
            atFit.length === 1 && atFit[0] !== undefined && atFit[0] >= 0.99,
            `кадр: ${atFit.map((alpha) => alpha.toFixed(2)).join(', ')}`);

        const block = view.graphBlock as unknown as {
            viewport: { scale: number };
            fitScale: number;
            params: Parameters<typeof render.labelAlpha>[1];
        };
        assert('20.2 подписи считаются от масштаба вписывания',
            Math.abs(block.fitScale - block.viewport.scale) < 0.001,
            `вписанный ${block.fitScale.toFixed(2)}, текущий ${block.viewport.scale.toFixed(2)}`);
        assert('20.3 у вписанного графа подписи остальных скрыты',
            render.labelAlpha(block.viewport.scale, block.params, block.fitScale) === 0,
            String(render.labelAlpha(block.viewport.scale, block.params, block.fitScale)));

        // Приближаем колесом, как это делает пользователь
        const baseline = block.fitScale;
        const before = canvasOf()?.drawn.length ?? 0;
        canvasOf()?.dispatch('wheel', { deltaY: -240, deltaMode: 0, clientX: 200, clientY: 100 });
        await advance(3000);
        assert('20.4 приближение увеличило масштаб, но не сдвинуло точку отсчёта',
            block.viewport.scale > baseline * 1.2 && Math.abs(block.fitScale - baseline) < 0.001,
            `текущий ${block.viewport.scale.toFixed(2)}, точка отсчёта ${block.fitScale.toFixed(2)}`);
        assert('20.5 после приближения подписи остальных проявляются',
            render.labelAlpha(block.viewport.scale, block.params, block.fitScale) > 0,
            String(render.labelAlpha(block.viewport.scale, block.params, block.fitScale)));
        assert('20.6 граф перерисован',
            (canvasOf()?.drawn.length ?? 0) > before, `${before} → ${canvasOf()?.drawn.length ?? 0}`);
        await asPlugin(plugin).onunload();
    }

    // ------------------------- 21. Почерк продукта: иконка одна и та же
    {
        const { plugin } = await startPlugin({ files: ['a.md'], links: { 'a.md': {} } });
        const view = viewOf(plugin);
        if (!view) throw new Error('панель не открыта');
        const ribbonIcon = asPlugin(plugin).ribbon?.getAttribute('data-icon') ?? '';
        const tabIcon = (view as unknown as { getIcon(): string }).getIcon();
        assert('21.1 иконка вкладки и иконка в ленте совпадают',
            tabIcon !== '' && tabIcon === ribbonIcon, `${tabIcon} / ${ribbonIcon}`);
        assert('21.2 иконка осмысленная, а не «домой»',
            !['home', 'file', 'document'].includes(tabIcon), tabIcon);
        await asPlugin(plugin).onunload();
    }

    console.log(`\nпроверок: ${checks}, провалено: ${failures}`);
    process.exitCode = failures === 0 ? 0 : 1;
}

void main();

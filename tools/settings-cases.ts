// ---------------------------------------------------------------------------
// Каталог тест-кейсов: настройки, данные активности, метрики и тексты.
// Вторая половина плагина — то, что не про граф.
//   npm run cases
// ---------------------------------------------------------------------------

import { say } from './output';
import {
    ACTIVE_WINDOW_MS, DAY_MS, REVIEW_STAGES, SCHEMA_VERSION,
    applyEdit, applyReview, applyView, createActivity, hasActivity, isTrackablePath, keptMonths,
    looksLikeLegacyData, migrateLegacyData, monthCount, monthKey, pruneMonths, sanitizeActivity,
    sanitizeDashboardData, type NoteActivity,
} from '../src/model';
import { DashboardStore } from '../src/storage';
import { DEFAULT_SETTINGS } from '../src/settings';
import { computeRecentlyActive, computeReviewQueue, computeTopNotes, computeTotals } from '../src/metrics';
import { dictionaries, t } from '../src/i18n';
import { fs } from './node-io';

let failures = 0;
let checks = 0;

function assert(name: string, condition: boolean, extra?: string): void {
    checks += 1;
    if (!condition) failures += 1;
    say(`${condition ? 'OK  ' : 'FAIL'} ${name}${extra === undefined ? '' : ` — ${extra}`}`);
}

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);

interface Stub {
    plugin: never;
    saved: unknown;
    initial: unknown;
}

/** Заглушка плагина: только то, что нужно хранилищу данных. */
function fakePlugin(initial: unknown = { version: SCHEMA_VERSION, settings: {}, notes: {} }): Stub {
    const stub: Stub = { plugin: undefined as never, saved: null, initial };
    const plugin = {
        manifest: { id: 'ord-dashboard' },
        app: { vault: { configDir: 'vault-config', adapter: { exists: async () => false } } },
        loadData: async () => stub.initial,
        saveData: async (data: unknown) => { stub.saved = data; },
        registerInterval: () => undefined,
        registerEvent: () => undefined,
    };
    stub.plugin = plugin as never;
    return stub;
}

const settingsOf = (store: DashboardStore): Record<string, unknown> =>
    (store as unknown as { settings: Record<string, unknown> }).settings;

/** Заметки для метрик: достаточно пути. */
const file = (path: string): never => ({ path, extension: 'md' } as never);

async function main(): Promise<void> {
    // ------------------------------------------------- 1. Настройки: значения
    {
        const store = new DashboardStore(fakePlugin().plugin);
        await store.load();
        const config = settingsOf(store);
        assert('1.1 значения по умолчанию применены',
            config.graphNodes === DEFAULT_SETTINGS.graphNodes
            && config.graphScope === DEFAULT_SETTINGS.graphScope
            && config.graphRelevance === DEFAULT_SETTINGS.graphRelevance
            && config.graphIndexNotes === DEFAULT_SETTINGS.graphIndexNotes
            && config.graphPlace === DEFAULT_SETTINGS.graphPlace,
            JSON.stringify(config));

        assert('1.2 допустимое значение принимается', store.applySetting('graphRelevance', 'strict') === true);
        assert('1.3 недопустимое значение отклоняется', store.applySetting('graphRelevance', 'как-нибудь') === false);
        assert('1.4 после отклонения значение прежнее', settingsOf(store).graphRelevance === 'strict');
        assert('1.5 повтор того же значения не считается изменением',
            store.applySetting('graphRelevance', 'strict') === false);
        assert('1.6 предел узлов снизу',
            store.applySetting('graphNodes', 1) === true && settingsOf(store).graphNodes === 50);
        assert('1.7 предел узлов сверху',
            store.applySetting('graphNodes', 99999) === true && settingsOf(store).graphNodes === 2000);
        assert('1.8 нечисловой предел отклонён', store.applySetting('graphNodes', 'много') === false);
        assert('1.9 глубина в строке',
            store.applySetting('graphDepth', '1') === true && settingsOf(store).graphDepth === 1);
        assert('1.10 глубина ограничена',
            store.applySetting('graphDepth', '9') === true && settingsOf(store).graphDepth === 3);
        assert('1.11 мусор в глубине отклонён', store.applySetting('graphDepth', 'глубоко') === false);
        assert('1.12 место: строку не принимаем', store.applySetting('graphPlace', 'да') === false);
        assert('1.13 неизвестная настройка отклонена', store.applySetting('graphTeleport', true) === false);
        assert('1.14 размер узлов ограничен',
            store.applySetting('graphNodeScale', '9') === true && settingsOf(store).graphNodeScale === 1.5);
        assert('1.15 режим оглавлений принимается',
            store.applySetting('graphIndexNotes', 'hidden') === true
            && store.applySetting('graphIndexNotes', 'полный') === false);
    }

    // ------------------------------- 2. Настройки: миграция и мусор
    {
        const store = new DashboardStore(fakePlugin({
            version: SCHEMA_VERSION,
            settings: {
                graphUseVaultParams: true,
                graphIncoming: true,
                graphNodeScale: '0.75',
                graphNodes: 12345,
                graphDepth: 99,
                graphScope: 'луна',
                showGraph: 'нет',
            },
            notes: {},
        }).plugin);
        await store.load();
        const settings = settingsOf(store);
        assert('2.1 убранные настройки забыты',
            !('graphUseVaultParams' in settings) && !('graphIncoming' in settings), JSON.stringify(settings));
        assert('2.2 размер узлов прочитан из строки', settings.graphNodeScale === 0.75, String(settings.graphNodeScale));
        assert('2.3 предел узлов приведён к допустимому', settings.graphNodes === 2000, String(settings.graphNodes));
        assert('2.4 глубина приведена к допустимой', settings.graphDepth === 3, String(settings.graphDepth));
        assert('2.5 неизвестный режим заменён значением по умолчанию',
            settings.graphScope === DEFAULT_SETTINGS.graphScope, String(settings.graphScope));
        assert('2.6 неверный тип заменён значением по умолчанию',
            settings.showGraph === DEFAULT_SETTINGS.showGraph, String(settings.showGraph));
    }

    // --------------------------------- 3. Активность: правила и троттлинг
    {
        const activity = createActivity();
        assert('3.1 новая запись пуста', !hasActivity(activity));
        assert('3.2 просмотр засчитан', applyView(activity, NOW) === true);
        assert('3.3 просмотр сразу после просмотра не засчитан', applyView(activity, NOW + 1000) === false);
        assert('3.4 просмотр спустя троттлинг засчитан', applyView(activity, NOW + 31_000) === true);
        assert('3.5 просмотры накоплены', activity.views === 2, String(activity.views));

        assert('3.6 правка засчитана', applyEdit(activity, NOW) === true);
        assert('3.7 повторная правка сразу не засчитана', applyEdit(activity, NOW + 1000) === false);
        assert('3.8 правки накоплены', activity.edits === 1, String(activity.edits));
        assert('3.9 есть активность', hasActivity(activity) === true);

        assert('3.10 повторение переводит на следующую стадию', applyReview(activity, NOW) === true);
        assert('3.11 стадия сдвинулась на одну', activity.reviewStage === 1, String(activity.reviewStage));
        for (let i = 1; i < REVIEW_STAGES.length + 2; i++) applyReview(activity, NOW + i);
        assert('3.12 дальше последней стадии не уходит',
            activity.reviewStage === REVIEW_STAGES.length - 1, String(activity.reviewStage));

        assert('3.13 разбивка по месяцам заполняется',
            monthCount(activity.viewsByMonth, monthKey(NOW)) >= 1, JSON.stringify(activity.viewsByMonth));
        const keep = keptMonths(NOW);
        pruneMonths(activity, keep);
        assert('3.14 старые месяцы вычищаются',
            Object.keys(activity.viewsByMonth).every((key) => keep.has(key)),
            Object.keys(activity.viewsByMonth).join(', '));
    }

    // ------------------------------------------------- 4. Учётные пути
    {
        assert('4.1 обычная заметка учитывается', isTrackablePath('Работа/Заметка.md') === true);
        assert('4.2 скрытые папки не учитываются', isTrackablePath('.hidden/plugins/x/file.md') === false);
        assert('4.3 служебные папки не учитываются', isTrackablePath('.trash/Заметка.md') === false);
        assert('4.4 не Markdown не учитывается', isTrackablePath('файл.png') === false);
        assert('4.5 регистр расширения не важен', isTrackablePath('Заметка.MD') === true);
    }

    // ------------------------------------------- 5. Чистка и миграция данных
    {
        const cleaned = sanitizeActivity({
            views: 'много',
            edits: 12,
            lastOpened: 'вчера',
            reviewStage: 2,
            unknownField: 'лишнее',
            viewsByMonth: { '2026-09': 3, 'кривой ключ': 5 },
            editsByMonth: null,
        });
        assert('5.1 мусор в полях заменён значениями по умолчанию',
            cleaned.views === 0 && cleaned.edits === 12 && cleaned.lastOpened === 0, JSON.stringify(cleaned));
        assert('5.2 неизвестное поле выброшено', !('unknownField' in cleaned));
        assert('5.3 кривые ключи месяцев выброшены', !('кривой ключ' in cleaned.viewsByMonth),
            JSON.stringify(cleaned.viewsByMonth));

        const data = sanitizeDashboardData({
            version: 'сто',
            notes: { 'a.md': { views: 1 }, 'b.md': 'мусор', '.hidden/x.md': { views: 1 } },
        });
        assert('5.4 версия схемы приведена к текущей', data.version === SCHEMA_VERSION, String(data.version));
        assert('5.5 неверные записи заметок выброшены', Object.keys(data.notes).length === 1,
            Object.keys(data.notes).join(', '));

        assert('5.7 старый формат распознан',
            looksLikeLegacyData({ 'a.md': { viewCount: 5, history: [NOW], historyEdit: [NOW] } }) === true);
        assert('5.8 новый формат не принят за старый',
            looksLikeLegacyData({ version: 1, settings: {}, notes: { 'a.md': {} } }) === false);

        const migrated = migrateLegacyData({
            'a.md': {
                viewCount: 5,
                history: [NOW, NOW - DAY_MS],
                historyEdit: [NOW - 2 * DAY_MS],
                refreshData: { stage: 2, lastRefresh: NOW - 4 * DAY_MS },
            },
            'b.md': { viewCount: 0, history: [], historyEdit: [] },
            '.hidden/x.md': { viewCount: 7, history: [NOW] },
            'плохой': 'мусор',
        }, NOW);
        assert('5.9 перенесены только записи с активностью', Object.keys(migrated.notes).length === 1,
            Object.keys(migrated.notes).join(', '));
        assert('5.10 просмотры, правки и стадия сохранены',
            migrated.notes['a.md']?.views === 5 && migrated.notes['a.md']?.edits === 1
            && migrated.notes['a.md']?.reviewStage === 2,
            JSON.stringify(migrated.notes['a.md']));
        assert('5.11 месячные счётчики перенесены',
            monthCount(migrated.notes['a.md']?.viewsByMonth ?? {}, monthKey(NOW)) === 2,
            JSON.stringify(migrated.notes['a.md']?.viewsByMonth));
    }

    // ---------------------------------------------------------- 6. Метрики
    {
        const notes: Record<string, NoteActivity> = {
            'a.md': {
                ...createActivity(), views: 10, edits: 4, lastOpened: NOW, lastEdited: NOW,
                reviewStage: 1, reviewStartedAt: NOW - 3 * DAY_MS,
                viewsByMonth: { [monthKey(NOW)]: 6, [monthKey(NOW - 40 * DAY_MS)]: 4 },
                editsByMonth: { [monthKey(NOW)]: 2 },
            },
            'b.md': {
                ...createActivity(), views: 2, edits: 1, lastOpened: NOW - DAY_MS, lastEdited: NOW - DAY_MS,
                viewsByMonth: { [monthKey(NOW)]: 1 }, editsByMonth: {},
            },
            'c.md': { ...createActivity(), views: 1, edits: 0, lastOpened: NOW - ACTIVE_WINDOW_MS - DAY_MS },
            'd.md': {
                ...createActivity(), views: 3, edits: 0, lastOpened: NOW - 31 * DAY_MS,
                reviewStage: 2, reviewStartedAt: NOW - 31 * DAY_MS,
            },
        };
        const files = [file('a.md'), file('b.md'), file('c.md'), file('d.md')];

        const totals = computeTotals(files, notes, NOW);
        assert('6.1 итоги считают заметки, просмотры и правки',
            totals.notes === 4 && totals.views === 16 && totals.edits === 5, JSON.stringify(totals));
        assert('6.2 активные за месяц посчитаны', totals.active === 2, JSON.stringify(totals));

        const top = computeTopNotes(files, notes, NOW, 10);
        assert('6.3 топ месяца считает просмотры и удвоенные правки',
            top[0]?.file.path === 'a.md' && top[0]?.score === 6 + 2 * 2, JSON.stringify(top[0]));

        const recent = computeRecentlyActive(files, notes, NOW, 10);
        assert('6.4 недавние за неделю', recent.length === 2 && recent[0]?.file.path === 'a.md',
            recent.map((item) => item.file.path).join(', '));

        const queue = computeReviewQueue(files, notes, NOW, 10);
        assert('6.5 в очереди только те, чей срок повторения наступил',
            queue.length === 2
            && queue.some((item) => item.file.path === 'c.md')
            && queue.some((item) => item.file.path === 'd.md'),
            queue.map((item) => `${item.file.path}:${item.stageNumber}`).join(', '));
        assert('6.6 заметка не в срок в очередь не попадает',
            !queue.some((item) => item.file.path === 'a.md'));
        assert('6.7 просрочка посчитана',
            queue.find((item) => item.file.path === 'c.md')?.isOverdue === true
            && queue.find((item) => item.file.path === 'd.md')?.isOverdue === false,
            JSON.stringify(queue.map((item) => ({ path: item.file.path, overdue: item.isOverdue }))));
    }

    // ---------------------------------------------------------- 7. Тексты
    {
        const en = Object.keys(dictionaries.en).sort();
        const ru = Object.keys(dictionaries.ru).sort();
        assert('7.1 наборы ключей совпадают', en.join(',') === ru.join(','),
            `английский ${en.length}, русский ${ru.length}`);
        const empty = en.filter((key) =>
            String(dictionaries.ru[key as keyof typeof dictionaries.ru]).trim() === ''
            || String(dictionaries.en[key as keyof typeof dictionaries.en]).trim() === '');
        assert('7.2 пустых переводов нет', empty.length === 0, empty.join(', '));
        const rendered = t('graphStats', { nodes: '5', edges: '4' });
        assert('7.3 подстановки работают', rendered.includes('5') && rendered.includes('4'), rendered);
        assert('7.4 подстановка не оставляет меток', !rendered.includes('__'), rendered);

        // Почерк продукта: тексты, которые видит пользователь, начинаются с имени
        // продукта из манифеста (docs/IDENTITY.md, форма «Продукт: результат»).
        const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8')) as { name: string };
        const product = manifest.name;
        assert('7.5 имя продукта в форме ORD…', /^ORD[a-z]/.test(product),
            `${product} (ожидается ORD + слово со строчной)`);

        const keys = Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[];
        const prefixed = keys.filter((key) => key === 'ribbonTooltip' || key.startsWith('notice'));
        const wrong = prefixed.filter((key) =>
            !dictionaries.en[key].startsWith(`${product}:`) || !dictionaries.ru[key].startsWith(`${product}:`));
        assert('7.6 подсказка и уведомления начинаются с имени продукта',
            prefixed.length >= 4 && wrong.length === 0,
            wrong.map((key) => `${key}: ${dictionaries.en[key]}`).join(' | ') || `${prefixed.length} проверено`);

        const titled = ['viewTitle'] as const;
        assert('7.7 заголовок панели без имени продукта',
            titled.every((key) => !dictionaries.en[key].includes(product)
                && !dictionaries.ru[key].includes(product)),
            `${dictionaries.en.viewTitle} / ${dictionaries.ru.viewTitle}`);
    }

    // ------------------------------------------- 8. События и переезд записей
    {
        // Браузерные глобальные объекты: плагин планирует запись через window.
        (global as { window?: unknown }).window = global;

        const stub = fakePlugin({ version: SCHEMA_VERSION, settings: {}, notes: {} });
        const store = new DashboardStore(stub.plugin);
        await store.load();
        const notesOf = (): Record<string, NoteActivity> =>
            (store as unknown as { data: { notes: Record<string, NoteActivity> } }).data.notes;

        store.recordView('one.md', NOW);
        store.recordView('one.md', NOW + 60_000);
        assert('8.1 просмотры записаны', notesOf()['one.md']?.views === 2, JSON.stringify(notesOf()['one.md']));

        store.renameNote('one.md', 'two.md');
        assert('8.2 переименование переносит запись',
            notesOf()['two.md']?.views === 2 && !('one.md' in notesOf()), Object.keys(notesOf()).join(', '));
        store.renameNote('two.md', 'two.md');
        assert('8.3 переименование в тот же путь ничего не теряет', notesOf()['two.md']?.views === 2);

        store.recordView('other.md', NOW);
        store.recordEdit('other.md', NOW + 60_000);
        store.renameNote('other.md', 'two.md');
        const merged = notesOf()['two.md'];
        assert('8.4 переименование поверх записи: история складывается, а не пропадает',
            merged?.views === 3 && merged?.edits === 1, JSON.stringify(merged));
        store.recordView('folder/inner.md', NOW);
        store.recordView('folder/deep/inner.md', NOW);
        store.renameFolder('folder', 'moved');
        assert('8.5 переименование папки переносит все записи',
            'moved/inner.md' in notesOf() && 'moved/deep/inner.md' in notesOf(),
            Object.keys(notesOf()).join(', '));

        store.recordView('moved/inner.md', NOW + 120_000);
        store.recordView('target/inner.md', NOW);
        store.renameFolder('target', 'moved');
        assert('8.6 переименование папки поверх записей тоже складывает',
            (notesOf()['moved/inner.md']?.views ?? 0) >= 3, JSON.stringify(notesOf()['moved/inner.md']));

        store.removeNote('moved/deep/inner.md');
        assert('8.7 удаление заметки убирает только её', !('moved/deep/inner.md' in notesOf()));
        store.removeNote('нет-такой.md');
        assert('8.8 удаление неизвестной заметки ничего не ломает', true);

        // Заполнение истории по датам файлов
        const seeded = fakePlugin({ version: SCHEMA_VERSION, settings: {}, notes: {} });
        const seedStore = new DashboardStore(seeded.plugin);
        await seedStore.load();
        const seededNotes = (): Record<string, NoteActivity> =>
            (seedStore as unknown as { data: { notes: Record<string, NoteActivity> } }).data.notes;
        const stamp = (days: number): number => NOW - days * DAY_MS;
        const files = [
            { path: 'fresh.md', extension: 'md', stat: { mtime: stamp(2) } },
            { path: 'month.md', extension: 'md', stat: { mtime: stamp(20) } },
            { path: 'old.md', extension: 'md', stat: { mtime: stamp(200) } },
            { path: 'no-date.md', extension: 'md', stat: {} },
        ] as never[];
        const count = seedStore.seedFromFiles(files, NOW);
        assert('8.9 заполняются только свежие заметки', count === 2, String(count));
        assert('8.10 свежая заметка: правка и открытие',
            seededNotes()['fresh.md']?.edits === 1 && seededNotes()['fresh.md']?.views === 1,
            JSON.stringify(seededNotes()['fresh.md']));
        assert('8.11 заметка месячной давности: только правка',
            seededNotes()['month.md']?.edits === 1 && seededNotes()['month.md']?.lastOpened === 0,
            JSON.stringify(seededNotes()['month.md']));
        assert('8.12 заполненные заметки не попадают в очередь повторения',
            computeReviewQueue(files, seededNotes(), NOW, 10).every((item) => item.file.path !== 'month.md'));
        assert('8.13 повторное заполнение ничего не меняет', seedStore.seedFromFiles(files, NOW) === 0);

        // Сохранение
        const saveStub = fakePlugin({ version: SCHEMA_VERSION, settings: {}, notes: {} });
        const saveStore = new DashboardStore(saveStub.plugin);
        await saveStore.load();
        saveStore.recordView('x.md', NOW);
        saveStore.recordView('y.md', NOW);
        await saveStore.flush();
        assert('8.14 пачка изменений сохраняется', saveStub.saved !== null
            && Object.keys((saveStub.saved as { notes: Record<string, unknown> }).notes).length === 2,
            JSON.stringify(saveStub.saved));
        saveStore.recordView('z.md', NOW);
        await saveStore.flush();
        assert('8.15 новые изменения тоже сохраняются',
            Object.keys((saveStub.saved as { notes: Record<string, unknown> }).notes).length === 3);
        saveStub.saved = null;
        await saveStore.flush();
        assert('8.16 без изменений запись не идёт', saveStub.saved === null);

        await saveStore.clearAll();
        assert('8.17 очистка данных сохраняется сразу',
            Object.keys((saveStub.saved as { notes: Record<string, unknown> }).notes).length === 0);
        saveStore.dispose();

        // Чистка записей без файлов
        const pruneStub = fakePlugin({ version: SCHEMA_VERSION, settings: {}, notes: {} });
        const pruneStore = new DashboardStore(pruneStub.plugin);
        await pruneStore.load();
        pruneStore.recordView('exists.md', NOW);
        pruneStore.recordView('gone.md', NOW);
        const pruned = pruneStore.pruneMissingFiles(new Set(['exists.md']), NOW);
        const left = (pruneStore as unknown as { data: { notes: Record<string, unknown> } }).data.notes;
        assert('8.18 чистка убирает записи без файлов', pruned === true && !('gone.md' in left));
        assert('8.19 чистка бережёт существующие записи', 'exists.md' in left);
        assert('8.20 повторная чистка ничего не меняет',
            pruneStore.pruneMissingFiles(new Set(['exists.md']), NOW) === false);
    }

    // ------------------------------------------ 9. Загрузка: мусор и старый формат
    {
        (global as { window?: unknown }).window = global;

        const broken = new DashboardStore(fakePlugin('не json').plugin);
        await broken.load();
        const brokenSettings = settingsOf(broken);
        assert('9.1 повреждённый файл: настройки по умолчанию',
            brokenSettings.graphNodes === DEFAULT_SETTINGS.graphNodes
            && Object.keys((broken as unknown as { data: { notes: object } }).data.notes).length === 0,
            JSON.stringify(brokenSettings));

        const oldInside = new DashboardStore(fakePlugin({
            'старый.md': { viewCount: 4, history: [Date.now()], historyEdit: [Date.now()] },
        }).plugin);
        await oldInside.load();
        const migrated = (oldInside as unknown as { data: { notes: Record<string, NoteActivity> } }).data.notes;
        assert('9.2 старый формат внутри data.json перенесён',
            migrated['старый.md']?.views === 4, JSON.stringify(migrated));

        // Старый файл рядом лежит на диске: должен перенестись и переименоваться
        const legacyContent = JSON.stringify({
            'легаси.md': { viewCount: 3, history: [Date.now()], historyEdit: [] },
        });
        const files = new Map<string, string>([
            ['vault-config/plugins/ord-dashboard/note-views.json', legacyContent],
        ]);
        const renamed: string[] = [];
        const legacyPlugin = {
            manifest: { id: 'ord-dashboard' },
            app: {
                vault: {
                    configDir: 'vault-config',
                    adapter: {
                        exists: async (path: string) => files.has(path),
                        read: async (path: string) => files.get(path) ?? '',
                        rename: async (from: string, to: string) => {
                            if (!files.has(from)) return;
                            files.set(to, files.get(from) ?? '');
                            files.delete(from);
                            renamed.push(to);
                        },
                    },
                },
            },
            loadData: async () => null,
            saveData: async () => undefined,
            registerInterval: () => undefined,
            registerEvent: () => undefined,
        } as never;
        const legacyStore = new DashboardStore(legacyPlugin);
        await legacyStore.load();
        const legacyNotes = (legacyStore as unknown as { data: { notes: Record<string, NoteActivity> } }).data.notes;
        assert('9.3 старый файл рядом перенесён', legacyNotes['легаси.md']?.views === 3, JSON.stringify(legacyNotes));
        assert('9.4 старый файл переименован, а не удалён',
            renamed.length === 1 && (renamed[0] ?? '').endsWith('note-views.json.bak'), renamed.join(', '));

        // Старый файл есть, но записей в нём нет: не трогаем
        const emptyFiles = new Map<string, string>([
            ['vault-config/plugins/ord-dashboard/note-views.json', JSON.stringify({})],
        ]);
        const untouched: string[] = [];
        const emptyPlugin = {
            manifest: { id: 'ord-dashboard' },
            app: {
                vault: {
                    configDir: 'vault-config',
                    adapter: {
                        exists: async (path: string) => emptyFiles.has(path),
                        read: async (path: string) => emptyFiles.get(path) ?? '',
                        rename: async (_from: string, to: string) => { untouched.push(to); },
                    },
                },
            },
            loadData: async () => null,
            saveData: async () => undefined,
            registerInterval: () => undefined,
            registerEvent: () => undefined,
        } as never;
        const emptyStore = new DashboardStore(emptyPlugin);
        await emptyStore.load();
        assert('9.5 пустой старый файл остаётся на месте', untouched.length === 0, untouched.join(', '));

        // Ошибка чтения старого файла не мешает запуску
        const failingPlugin = {
            manifest: { id: 'ord-dashboard' },
            app: {
                vault: {
                    configDir: 'vault-config',
                    adapter: {
                        exists: async () => true,
                        read: async () => { throw new Error('нет доступа'); },
                        rename: async () => { throw new Error('нет доступа'); },
                    },
                },
            },
            loadData: async () => null,
            saveData: async () => undefined,
            registerInterval: () => undefined,
            registerEvent: () => undefined,
        } as never;
        const failingStore = new DashboardStore(failingPlugin);
        const written: string[] = [];
        // Журнал плагина слушаем на потоке ошибок: сам плагин пишет через
        // console.error, а инструментам правило о логировании это запрещает.
        const originalWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk: string | Uint8Array): boolean => {
            written.push(String(chunk));
            return true;
        };
        try {
            await failingStore.load();
        } finally {
            process.stderr.write = originalWrite;
        }
        assert('9.6 ошибка чтения старого файла не ломает запуск',
            settingsOf(failingStore).graphNodes === DEFAULT_SETTINGS.graphNodes);
        assert('9.7 ошибка чтения записана в журнал',
            written.length > 0, written.join(' | ') || 'журнал пуст');
    }

    say(`\nпроверок: ${checks}, провалено: ${failures}`);
    process.exitCode = failures === 0 ? 0 : 1;
}

void main();
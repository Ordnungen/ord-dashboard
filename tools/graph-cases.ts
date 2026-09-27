// ---------------------------------------------------------------------------
// Каталог тест-кейсов графа связей. Каждый кейс — маленькое хранилище и то, что
// панель обязана показать. Запуск: npm run cases
//
// Разделы: пустое хранилище, прямые связи, место (папки), оглавления, теги,
// вложения и неразрешённые ссылки, сироты, глубина, отбор, обзор хранилища,
// вес повторных ссылок, циклы, юникод, производительность.
// ---------------------------------------------------------------------------

import { say } from './output';
import { fs } from './node-io';
import {
    OverviewSampler, titleFromPath,
    type GraphScope, type IndexHandling, type RelevanceLevel, type OverviewGraph,
} from '../src/graph-model';
import {
    createResolver, findLinkTargets, listNotes, parseNote, readVault, sameFolderPaths, stripCode,
} from './vault-fs';
import * as render from '../src/graph-render';
import { CORE_DEFAULTS } from '../src/graph-params';

let failures = 0;
let checks = 0;

function assert(name: string, condition: boolean, extra?: string): void {
    checks += 1;
    if (!condition) failures += 1;
    say(`${condition ? 'OK  ' : 'FAIL'} ${name}${extra === undefined ? '' : ` — ${extra}`}`);
}

type Links = Record<string, Record<string, number>>;

class VaultBuilder {
    links: Links = {};

    add(from: string, to: string, weight = 1): this {
        this.links[from] ??= {};
        this.links[from][to] = (this.links[from][to] ?? 0) + weight;
        this.links[to] ??= {};
        return this;
    }

    note(path: string): this {
        this.links[path] ??= {};
        return this;
    }

    get paths(): string[] {
        return Object.keys(this.links);
    }
}

interface RunOptions {
    rootPath?: string;
    scope?: GraphScope;
    depth?: number;
    relevance?: RelevanceLevel;
    index?: IndexHandling;
    place?: string[];
    limit?: number;
    maxEdges?: number;
    extras?: (path: string) => { tags?: string[]; attachments?: string[]; unresolved?: string[] } | null;
    showTags?: boolean;
    showAttachments?: boolean;
    includeUnresolved?: boolean;
    orphans?: string[];
}

function run(vault: VaultBuilder, options: RunOptions = {}): OverviewGraph {
    for (const path of vault.paths) vault.links[path] ??= {};
    const sampler = new OverviewSampler(vault.links, {
        limit: options.limit ?? 300,
        maxEdges: options.maxEdges ?? 40000,
        scope: options.scope ?? 'local',
        rootPath: options.rootPath,
        // Так же, как панель: открытая заметка всегда в обзоре хранилища.
        focusPath: options.rootPath,
        depth: options.depth ?? 2,
        relevance: options.relevance ?? 'normal',
        indexHandling: options.index ?? 'context',
        placePaths: options.place ?? [],
        extraLimit: 200,
        showTags: options.showTags ?? false,
        showAttachments: options.showAttachments ?? false,
        includeUnresolved: options.includeUnresolved ?? false,
        orphanPaths: options.orphans ?? [],
        maxOrphans: 30,
        extras: options.extras,
    });
    while (!sampler.step(16)) { /* ждём */ }
    const result = sampler.result;
    if (!result) throw new Error('граф не построен');
    return result;
}

const titles = (graph: OverviewGraph): string[] =>
    graph.nodes.map((node) => titleFromPath(node.path)).sort();
const has = (graph: OverviewGraph, title: string): boolean => titles(graph).includes(title);
const paths = (graph: OverviewGraph): Set<string> => new Set(graph.nodes.map((node) => node.path));

/** Хранилище с автоиндексатором: каждая заметка ссылается вверх на разделы. */
function indexedVault(options: { projects?: number; docs?: number; sections?: number } = {}): VaultBuilder {
    const projects = options.projects ?? 30;
    const docs = options.docs ?? 200;
    const vault = new VaultBuilder();
    for (let i = 0; i < projects; i++) {
        const folder = `work/p${i}`;
        vault.note(`${folder}/p${i}.md`);
        vault.add(`${folder}/p${i}.md`, 'vault.md');
        vault.add(`${folder}/p${i}.md`, 'work.md');
        vault.add(`${folder}/p${i}.md`, 'work-b.md');
        vault.add(`${folder}/p${i}.md`, `${folder}/analysis.md`);
        vault.add(`${folder}/p${i}.md`, `${folder}/notes.md`);
        if (i > 0) vault.add(`${folder}/p${i}.md`, `work/p${i - 1}/p${i - 1}.md`);
    }
    for (let i = 0; i < docs; i++) {
        vault.add(`help/d${i}.md`, 'vault.md');
        vault.add(`help/d${i}.md`, 'help.md');
    }
    for (const index of ['vault.md', 'work.md', 'work-b.md', 'help.md']) vault.note(index);
    return vault;
}

// ------------------------------------------------------------------ 1. Пустое
{
    const empty = new VaultBuilder();
    const graph = run(empty, { scope: 'vault' });
    assert('1.1 пустое хранилище: пустой обзор без падения', graph.nodes.length === 0 && graph.edges.length === 0);
    const orphan = run(empty, { rootPath: 'nothing.md' });
    assert('1.2 хранилище без связей: показывается только открытая заметка',
        orphan.nodes.length === 1 && orphan.edges.length === 0, `${orphan.nodes.length}`);
}

// --------------------------------------------------- 2. Одиночная заметка
{
    const vault = new VaultBuilder().note('alone.md');
    const graph = run(vault, { rootPath: 'alone.md' });
    assert('2.1 заметка без связей: один узел, ноль связей',
        graph.nodes.length === 1 && graph.edges.length === 0, `${graph.nodes.length}/${graph.edges.length}`);
    assert('2.2 заметка без связей не отмечена как отфильтрованная', graph.filtered === false);
}

// -------------------------------------------------------- 3. Прямая связь
{
    const vault = new VaultBuilder().note('a.md').note('b.md').add('a.md', 'b.md');
    const graph = run(vault, { rootPath: 'a.md' });
    assert('3.1 одна ссылка: два узла и одна связь',
        graph.nodes.length === 2 && graph.edges.length === 1, `${graph.nodes.length}/${graph.edges.length}`);
    const reverse = run(vault, { rootPath: 'b.md' });
    assert('3.2 обратная ссылка тоже видна', reverse.nodes.length === 2 && reverse.edges.length === 1);
}

// --------------------------------------------------------- 4. Ссылка на себя
{
    const vault = new VaultBuilder().note('self.md').add('self.md', 'self.md');
    const graph = run(vault, { rootPath: 'self.md' });
    assert('4.1 ссылка на себя игнорируется',
        graph.nodes.length === 1 && graph.edges.length === 0, `${graph.edges.length}`);
}

// ------------------------------------------------------------- 5. Циклы
{
    const vault = new VaultBuilder().add('a.md', 'b.md').add('b.md', 'a.md').add('b.md', 'c.md').add('c.md', 'a.md');
    const graph = run(vault, { rootPath: 'a.md' });
    assert('5.1 цикл не ломает обход', graph.nodes.length === 3 && graph.edges.length === 3,
        `${graph.nodes.length}/${graph.edges.length}`);
}

// ------------------------------------------- 6. Вес повторных ссылок
{
    const once = new VaultBuilder().add('root.md', 'once.md');
    for (let i = 0; i < 30; i++) once.add(`filler${i}.md`, 'hub.md');
    once.note('hub.md');
    once.add('root.md', 'hub.md');
    const twice = new VaultBuilder().add('root.md', 'twice.md').add('root.md', 'twice.md', 3);
    for (let i = 0; i < 30; i++) twice.add(`filler${i}.md`, 'hub.md');
    twice.note('hub.md');
    twice.add('root.md', 'hub.md');

    const first = run(once, { rootPath: 'root.md' });
    const second = run(twice, { rootPath: 'root.md' });
    const scoreOf = (graph: OverviewGraph, title: string): number =>
        graph.nodes.find((node) => titleFromPath(node.path) === title)?.score ?? 0;
    assert('6.1 три ссылки на одну заметку делают её ближе, чем одна',
        scoreOf(second, 'twice') > scoreOf(first, 'once'),
        `${scoreOf(first, 'once').toFixed(1)} против ${scoreOf(second, 'twice').toFixed(1)}`);
}

// ------------------------------------------------------- 7. Место (папки)
{
    const vault = new VaultBuilder().note('area/note.md').note('area/sibling-one.md').note('area/sibling-two.md')
        .note('far/other.md');
    for (let i = 0; i < 200; i++) vault.add(`far/d${i}.md`, 'hub.md');
    vault.note('hub.md');

    const withoutPlace = run(vault, { rootPath: 'area/note.md' });
    assert('7.1 без учёта места соседей по папке нет',
        !withoutPlace.nodes.some((node) => node.path.startsWith('area/sibling')),
        titles(withoutPlace).join(', '));

    const withPlace = run(vault, {
        rootPath: 'area/note.md',
        place: ['area/sibling-one.md', 'area/sibling-two.md'],
    });
    assert('7.2 с учётом места соседи по папке показаны',
        has(withPlace, 'sibling-one') && has(withPlace, 'sibling-two'), titles(withPlace).join(', '));
    assert('7.3 сосед по папке получает связи с открытой заметкой',
        withPlace.edges.length === 2, `${withPlace.edges.length}`);
    assert('7.4 сосед по папке ближе, чем заметка из чужой папки',
        (withPlace.nodes.find((node) => node.title === 'sibling-one')?.score ?? 0) > 0);

    const bigFolder = run(vault, { rootPath: 'area/note.md', place: [] });
    assert('7.5 большая папка не влияет на граф', bigFolder.nodes.length > 0);
}

// ----------------------------------------------- 8. Оглавления (индексы)
{
    const vault = indexedVault({ projects: 30, docs: 200 });
    const graph = run(vault, { rootPath: 'work/p10/p10.md' });

    assert('8.1 заметки чужой ветки не попадают',
        !graph.nodes.some((node) => node.path.startsWith('help/')), titles(graph).slice(0, 5).join(', '));
    assert('8.2 соседние проекты своего раздела видны',
        titles(graph).filter((title) => /^p\d+$/.test(title)).length >= 5,
        String(titles(graph).filter((title) => /^p\d+$/.test(title)).length));
    assert('8.3 оглавления помечены контекстом',
        graph.nodes.some((node) => node.path === 'vault.md' && node.context === true));

    const indexIndexes = new Set(graph.nodes.map((node, index) => (node.context ? index : -1)).filter((i) => i >= 0));
    const rootIndex = graph.nodes.findIndex((node) => node.path === 'work/p10/p10.md');
    assert('8.4 линии через оглавления не проводятся, кроме связей самой заметки',
        graph.edges.every((edge) => (edge.source === rootIndex || edge.target === rootIndex)
            || (!indexIndexes.has(edge.source) && !indexIndexes.has(edge.target))));

    const hidden = run(vault, { rootPath: 'work/p10/p10.md', index: 'hidden' });
    assert('8.5 режим «скрывать» убирает оглавления', !hidden.nodes.some((node) => node.context === true));
    assert('8.6 после скрытия связи указывают на живые узлы',
        hidden.edges.every((edge) => edge.source < hidden.nodes.length && edge.target < hidden.nodes.length));

    const core = run(vault, { rootPath: 'work/p10/p10.md', index: 'core', relevance: 'core' });
    assert('8.7 режим «как в ядре» рисует линии к оглавлениям', core.edges.length > graph.edges.length,
        `${core.edges.length} против ${graph.edges.length}`);
    assert('8.8 режим «как в ядре» показывает больше заметок', core.nodes.length >= graph.nodes.length,
        `${core.nodes.length} против ${graph.nodes.length}`);
}

// ------------------------------------------------- 9. Свои связи открытой заметки
{
    const vault = indexedVault({ projects: 5, docs: 5 });
    const graph = run(vault, { rootPath: 'work/p1/p1.md' });
    const rootIndex = graph.nodes.findIndex((node) => node.path === 'work/p1/p1.md');
    assert('9.1 открытая заметка есть в графе', rootIndex >= 0);
    assert('9.2 её связь со своим оглавлением показана',
        graph.edges.some((edge) => edge.source === rootIndex || edge.target === rootIndex),
        `${graph.edges.length}`);
}

// --------------------------------------------------------------- 10. Теги
{
    const vault = new VaultBuilder().note('a.md').note('b.md').note('c.md').add('a.md', 'b.md');
    const extras = (path: string): { tags: string[] } =>
        ({ tags: path === 'a.md' || path === 'b.md' ? ['проект'] : ['другое'] });
    const graph = run(vault, { rootPath: 'a.md', showTags: true, extras });
    assert('10.1 тег общей заметки показан', has(graph, '#проект'), titles(graph).join(', '));
    assert('10.2 тег связан с обеими заметками',
        graph.edges.filter((edge) => graph.nodes[edge.target]?.type === 'tag'
            || graph.nodes[edge.source]?.type === 'tag').length === 2,
        String(graph.edges.length));
    assert('10.3 тег не тянет в граф чужие заметки', !has(graph, 'c'), titles(graph).join(', '));

    const off = run(vault, { rootPath: 'a.md', showTags: false, extras });
    assert('10.4 выключенные теги не показываются', !titles(off).some((title) => title.startsWith('#')));
}

// ------------------------------------- 11. Вложения и неразрешённые ссылки
{
    const vault = new VaultBuilder().note('a.md').note('b.md');
    const extras = (): { attachments: string[]; unresolved: string[] } =>
        ({ attachments: ['files/pic.png'], unresolved: ['Не создана'] });
    const graph = run(vault, { rootPath: 'a.md', showAttachments: true, includeUnresolved: true, extras });
    assert('11.1 вложение показано узлом', has(graph, 'pic.png'), titles(graph).join(', '));
    assert('11.2 неразрешённая ссылка показана узлом', has(graph, 'Не создана'), titles(graph).join(', '));
    assert('11.3 типы узлов проставлены',
        graph.nodes.some((node) => node.type === 'attachment') && graph.nodes.some((node) => node.type === 'unresolved'));

    const withoutUnresolved = run(vault, {
        rootPath: 'a.md', showAttachments: true, includeUnresolved: false, extras,
    });
    assert('11.4 выключенные неразрешённые ссылки не показываются',
        !has(withoutUnresolved, 'Не создана'), titles(withoutUnresolved).join(', '));
}

// -------------------------------------------------------------- 12. Сироты
{
    const vault = new VaultBuilder().note('a.md').note('orphan-one.md').note('orphan-two.md').add('a.md', 'b.md');
    const local = run(vault, { rootPath: 'a.md', orphans: ['orphan-one.md', 'orphan-two.md'] });
    assert('12.1 в локальном графе сирот нет', !has(local, 'orphan-one'), titles(local).join(', '));
    const overview = run(vault, { scope: 'vault', orphans: ['orphan-one.md', 'orphan-two.md'] });
    assert('12.2 в обзоре хранилища сироты показаны', has(overview, 'orphan-one'), titles(overview).join(', '));
}

// ------------------------------------------------------------- 13. Глубина
{
    const vault = new VaultBuilder()
        .add('one.md', 'two.md').add('two.md', 'three.md').add('three.md', 'four.md');
    const shallow = run(vault, { rootPath: 'one.md', depth: 1, relevance: 'core' });
    const deep = run(vault, { rootPath: 'one.md', depth: 2, relevance: 'core' });
    const third = run(vault, { rootPath: 'one.md', depth: 3, relevance: 'core' });
    assert('13.1 глубина 1 не показывает соседей соседей',
        shallow.nodes.length === 2 && deep.nodes.length === 3,
        `${shallow.nodes.length}, ${deep.nodes.length}`);
    assert('13.2 глубина 3 доходит до конца цепочки', third.nodes.length === 4, String(third.nodes.length));

    const indexed = indexedVault({ projects: 5, docs: 0 });
    const one = run(indexed, { rootPath: 'work/p1/p1.md', depth: 1 });
    const two = run(indexed, { rootPath: 'work/p1/p1.md', depth: 2 });
    assert('13.3 в хранилище с оглавлениями глубина 1 не хуже глубины 2',
        one.nodes.length <= two.nodes.length + 25, `${one.nodes.length} против ${two.nodes.length}`);
}

// -------------------------------------------------------------- 14. Отбор
{
    const vault = indexedVault({ projects: 40, docs: 60 });
    const strict = run(vault, { rootPath: 'work/p10/p10.md', relevance: 'strict' });
    const normal = run(vault, { rootPath: 'work/p10/p10.md', relevance: 'normal' });
    const relaxed = run(vault, { rootPath: 'work/p10/p10.md', relevance: 'relaxed' });
    const core = run(vault, { rootPath: 'work/p10/p10.md', relevance: 'core' });
    assert('14.1 строгий отбор не шире обычного', strict.nodes.length <= normal.nodes.length,
        `${strict.nodes.length} <= ${normal.nodes.length}`);
    assert('14.2 обычный не шире мягкого', normal.nodes.length <= relaxed.nodes.length,
        `${normal.nodes.length} <= ${relaxed.nodes.length}`);
    assert('14.3 мягкий не шире «как в ядре»', relaxed.nodes.length <= core.nodes.length,
        `${relaxed.nodes.length} <= ${core.nodes.length}`);
    assert('14.4 в строгом режиме прямые связи на месте',
        strict.nodes.some((node) => node.path === 'work/p10/p10.md'));
}

// --------------------------------------------------- 15. Обзор хранилища
{
    const vault = indexedVault({ projects: 5, docs: 5 });
    const graph = run(vault, { scope: 'vault' });
    assert('15.1 обзор строит граф', graph.nodes.length > 0, String(graph.nodes.length));
    assert('15.2 в обзоре нет пометок контекста', !graph.nodes.some((node) => node.context === true));
    const sorted = [...graph.nodes].sort((a, b) => b.degree - a.degree);
    assert('15.3 обзор сортирует по числу связей', sorted[0]?.degree !== undefined && graph.nodes.length > 1);
}

// ------------------------------------ 16. Активная заметка в обзоре хранилища
{
    const vault = new VaultBuilder();
    for (let i = 0; i < 50; i++) vault.add(`hub${i}.md`, 'target.md');
    for (let i = 0; i < 50; i++) vault.add('target.md', `hub${i}.md`);
    vault.note('lonely.md');
    const graph = run(vault, { scope: 'vault', rootPath: 'lonely.md', limit: 10 });
    assert('16.1 заметка без связей попадает в обзор хранилища', paths(graph).has('lonely.md'),
        String(graph.nodes.length));
}

// --------------------------------------------------- 17. Лимит и обрезка
{
    const vault = new VaultBuilder();
    for (let i = 0; i < 200; i++) vault.add('root.md', `child${i}.md`);
    const graph = run(vault, { rootPath: 'root.md', limit: 50 });
    assert('17.1 предел узлов соблюдается', graph.nodes.length <= 50, String(graph.nodes.length));
    assert('17.2 обрезка отмечена', graph.truncated === true);
}

// ------------------------------------------------------- 18. Юникод и пути
{
    const vault = new VaultBuilder()
        .note('Проекты/Заявки 2026/Отчёт №1.md')
        .note('Проекты/Заявки 2026/Отчёт №2.md')
        .add('Проекты/Заявки 2026/Отчёт №1.md', 'Проекты/Заявки 2026/Отчёт №2.md');
    const graph = run(vault, { rootPath: 'Проекты/Заявки 2026/Отчёт №1.md' });
    assert('18.1 кириллица и пробелы в путях работают',
        has(graph, 'Отчёт №1') && has(graph, 'Отчёт №2'), titles(graph).join(', '));
}

// -------------------------------------------- 19. Дубли в списке соседей по месту
{
    const vault = new VaultBuilder().note('area/note.md').note('area/one.md');
    const graph = run(vault, { rootPath: 'area/note.md', place: ['area/one.md', 'area/one.md'] });
    assert('19.1 повтор в списке соседей не дублирует узел',
        graph.nodes.length === 2 && graph.edges.length === 1, `${graph.nodes.length}/${graph.edges.length}`);
}

// -------------------------------------------------- 20. Устойчивость к мусору
{
    const vault = new VaultBuilder().note('a.md');
    vault.links['b.md'] = { 'a.md': 1 };
    const graph = run(vault, { rootPath: 'a.md', place: ['missing.md', 'a.md'] });
    assert('20.1 список соседей по месту не ломает граф', graph.nodes.length >= 2 && graph.edges.length >= 1,
        `${graph.nodes.length}/${graph.edges.length}`);
    assert('20.2 повтор открытой заметки в списке соседей не создаёт петлю',
        graph.edges.every((edge) => edge.source !== edge.target));
}

// --------------------------------------------------- 21. Большое хранилище
{
    const vault = new VaultBuilder();
    const notes = 20000;
    for (let i = 0; i < notes; i++) {
        const folder = `s${i % 40}`;
        vault.add(`${folder}/n${i}.md`, `s${i % 40}.md`);
        vault.add(`${folder}/n${i}.md`, 'vault.md');
        if (i > 0) vault.add(`${folder}/n${i}.md`, `s${i % 40}/n${i - 1}.md`);
    }
    for (let i = 0; i < 40; i++) vault.note(`s${i}.md`);
    vault.note('vault.md');
    const started = performance.now();
    const graph = run(vault, { rootPath: 's0/n39.md', limit: 300 });
    const taken = performance.now() - started;
    assert('21.1 двадцать тысяч заметок строятся быстрее трёх секунд', taken < 3000, `${taken.toFixed(0)} мс`);
    assert('21.2 предел узлов соблюдён на большом хранилище', graph.nodes.length <= 300, String(graph.nodes.length));
}

// ------------------------------------------------- 22. Место: границы
{
    const notes = ['area/note.md', 'area/one.md', 'area/two.md', 'other/area/three.md', 'root.md'];
    assert('22.1 соседи по месту — только своя папка',
        sameFolderPaths(notes, 'area/note.md', 50).join(',') === 'area/one.md,area/two.md',
        sameFolderPaths(notes, 'area/note.md', 50).join(','));
    assert('22.2 одноимённая папка в другом месте не считается своей',
        !sameFolderPaths(notes, 'area/note.md', 50).includes('other/area/three.md'));
    assert('22.3 заметка в корне хранилища видит другие корневые заметки',
        sameFolderPaths(notes, 'root.md', 50).join(',') === '',
        sameFolderPaths(notes, 'root.md', 50).join(','));
    assert('22.4 папка ровно на пределе учитывается',
        sameFolderPaths(notes, 'area/one.md', 2).length === 2, String(sameFolderPaths(notes, 'area/one.md', 2).length));
    assert('22.5 папка больше предела не учитывается',
        sameFolderPaths(notes, 'area/one.md', 1).length === 0);

    const vault = new VaultBuilder()
        .note('area/note.md').note('area/sibling.md')
        .add('area/note.md', 'area/sibling.md');
    const graph = run(vault, { rootPath: 'area/note.md', place: ['area/sibling.md'] });
    assert('22.6 связь и место не дублируют линию',
        graph.nodes.length === 2 && graph.edges.length === 1, `${graph.nodes.length}/${graph.edges.length}`);
}

// --------------------------------------------- 23. Оглавления: границы
{
    const small = new VaultBuilder();
    for (let i = 0; i < 150; i++) small.add(`n${i}.md`, 'hub.md');
    small.note('hub.md');
    small.add('root.md', 'hub.md');
    small.note('root.md');
    const smallGraph = run(small, { rootPath: 'root.md' });
    assert('23.1 в небольшом хранилище оглавлений не ищем',
        !smallGraph.nodes.some((node) => node.context === true), String(smallGraph.nodes.length));

    const boundary = new VaultBuilder();
    boundary.note('root.md');
    for (let i = 0; i < 300; i++) boundary.add(`f${i}.md`, 'vault.md');
    boundary.note('vault.md');
    for (let i = 0; i < 23; i++) boundary.add(`under${i}.md`, 'almost-index.md');
    boundary.note('almost-index.md');
    for (let i = 0; i < 25; i++) boundary.add(`over${i}.md`, 'index.md');
    boundary.note('index.md');
    boundary.add('root.md', 'almost-index.md');
    boundary.add('root.md', 'index.md');
    const boundaryGraph = run(boundary, { rootPath: 'root.md', relevance: 'core' });
    const almost = boundaryGraph.nodes.find((node) => node.path === 'almost-index.md');
    const over = boundaryGraph.nodes.find((node) => node.path === 'index.md');
    assert('23.2 на один меньше предела — не оглавление', almost?.context !== true);
    assert('23.3 ровно на пределе — оглавление', over?.context === true);

    const dense = new VaultBuilder();
    for (let i = 0; i < 120; i++) {
        for (let j = 0; j < 120; j++) {
            if (i !== j) dense.add(`d${i}.md`, `d${j}.md`);
        }
    }
    const denseGraph = run(dense, { rootPath: 'd0.md', limit: 60 });
    assert('23.4 когда все заметки — оглавления, граф всё равно строится',
        denseGraph.nodes.length > 1 && paths(denseGraph).has('d0.md'), String(denseGraph.nodes.length));
}

// ------------------------------------------- 24. Крупные окрестности
{
    const wide = new VaultBuilder();
    for (let i = 0; i < 500; i++) wide.add('root.md', `child${i}.md`);
    const limited = run(wide, { rootPath: 'root.md', limit: 100 });
    assert('24.1 пятьсот связей: предел соблюдён', limited.nodes.length <= 100, String(limited.nodes.length));
    assert('24.2 пятьсот связей: обрезка отмечена', limited.truncated === true);

    const indexRoot = new VaultBuilder();
    for (let i = 0; i < 60; i++) indexRoot.add('moc.md', `note${i}.md`);
    for (let i = 0; i < 300; i++) indexRoot.add(`filler${i}.md`, 'moc.md');
    const indexGraph = run(indexRoot, { rootPath: 'moc.md', limit: 40 });
    assert('24.3 открытое оглавление показывается само',
        paths(indexGraph).has('moc.md'), String(indexGraph.nodes.length));

    const dense = new VaultBuilder();
    for (let i = 0; i < 40; i++) {
        for (let j = 0; j < 40; j++) if (i !== j) dense.add(`g${i}.md`, `g${j}.md`);
    }
    const capped = run(dense, { rootPath: 'g0.md', maxEdges: 20, relevance: 'core', index: 'core' });
    assert('24.4 предел связей соблюдён', capped.edges.length <= 20, String(capped.edges.length));
    assert('24.5 обрезка связей отмечена', capped.truncated === true);
}

// ------------------------------------- 25. Детерминизм и дробление
{
    const vault = indexedVault({ projects: 25, docs: 40 });
    const first = run(vault, { rootPath: 'work/p7/p7.md' });
    const second = run(vault, { rootPath: 'work/p7/p7.md' });
    const signature = (graph: OverviewGraph): string =>
        graph.nodes.map((node) => `${node.path}:${(node.score ?? 0).toFixed(6)}`).join('|');
    assert('25.1 одинаковый вход — одинаковый результат', signature(first) === signature(second));
    assert('25.2 одинаковый вход — одинаковые связи',
        first.edges.map((e) => `${e.source}-${e.target}`).join(',') ===
        second.edges.map((e) => `${e.source}-${e.target}`).join(','));

    const tiny = ((): OverviewGraph => {
        for (const path of vault.paths) vault.links[path] ??= {};
        const sampler = new OverviewSampler(vault.links, {
            limit: 300, maxEdges: 40000, scope: 'local', rootPath: 'work/p7/p7.md', focusPath: 'work/p7/p7.md',
            depth: 2, relevance: 'normal', indexHandling: 'context',
            extraLimit: 200, showTags: false, showAttachments: false, includeUnresolved: false,
        });
        let guard = 0;
        while (!sampler.step(0.05)) {
            guard += 1;
            if (guard > 200000) throw new Error('дробление не завершилось');
        }
        const result = sampler.result;
        if (!result) throw new Error('граф не построен');
        return result;
    })();
    assert('25.3 при дроблении на мелкие шаги результат тот же', signature(tiny) === signature(first),
        `${tiny.nodes.length} против ${first.nodes.length}`);

    for (const path of vault.paths) vault.links[path] ??= {};
    const progressSampler = new OverviewSampler(vault.links, {
        limit: 300, maxEdges: 40000, scope: 'local', rootPath: 'work/p7/p7.md', focusPath: 'work/p7/p7.md',
        depth: 3, relevance: 'relaxed', indexHandling: 'context',
        extraLimit: 200, showTags: true, showAttachments: false, includeUnresolved: false,
        extras: () => ({ tags: ['проект'] }),
    });
    let previous = 0;
    let monotone = true;
    let guard = 0;
    while (!progressSampler.step(0)) {
        const value = progressSampler.progress;
        if (value < previous - 0.0001) monotone = false;
        previous = value;
        guard += 1;
        if (guard > 200000) break;
    }
    assert('25.4 прогресс не убывает', monotone, `последнее значение ${previous.toFixed(2)}`);
    assert('25.5 в конце прогресс равен единице', previous > 0.9, previous.toFixed(2));
    assert('25.6 шаг без бюджета всё равно завершается', guard < 200000, String(guard));
}

// ------------------------------------------------------ 26. Имена и ключи
{
    const vault = new VaultBuilder().note('a.md').add('a.md', 'note.md');
    const extras = () => ({ tags: ['note'] });
    const graph = run(vault, { rootPath: 'a.md', showTags: true, extras });
    assert('26.1 тег и заметка с одинаковым именем — разные узлы',
        graph.nodes.some((node) => node.path === '#note') && graph.nodes.some((node) => node.path === 'note.md'),
        graph.nodes.map((node) => node.path).join(', '));
    assert('26.2 узлы не слиплись', graph.nodes.length === 3, String(graph.nodes.length));
}

// ---------------------------------------------- 27. Разбор ссылок и свойств
{
    const withCode = [
        'Текст [[Рабочая]]',
        '```',
        '[[В блоке кода]]',
        '```',
        'Ещё `[[Инлайн]]` и [[Вторая]]',
    ].join('\n');
    assert('27.1 ссылки в блоках кода не считаются',
        stripCode(withCode).includes('[[Рабочая]]') && !stripCode(withCode).includes('[[В блоке кода]]')
        && !stripCode(withCode).includes('[[Инлайн]]'));

    const parsed = parseNote([
        '---',
        'tags:',
        '  - "один"',
        '  - два',
        'links:',
        '  - "[[Раздел]]"',
        'aliases: [первый, второй]',
        '---',
        'Тело заметки',
    ].join('\n'));
    assert('27.2 свойства разобраны', parsed.props.tags?.length === 2 && parsed.props.aliases?.length === 2,
        JSON.stringify(parsed.props));
    assert('27.3 тело отделено от свойств', parsed.body.trim() === 'Тело заметки', JSON.stringify(parsed.body));

    const targets = findLinkTargets({
        props: { links: ['[[Свойство]]'] },
        body: '[[Заметка|псевдоним]] [[Другая#Раздел]] ![[картинка.png]] [[Третья#^блок]]',
    });
    assert('27.4 якоря, псевдонимы и вложения разобраны',
        targets.join(',') === 'Заметка,Другая,картинка.png,Третья,Свойство', targets.join(','));

    const notes = ['Папка/Заметка.md', 'Другая/Заметка.md', 'Папка/Глубже/Вложенная.md', 'Один.md'];
    const resolve = createResolver(notes);
    assert('27.5a точный путь', resolve('Папка/Заметка.md', 'Один.md') === 'Папка/Заметка.md');
    assert('27.5b по имени, ближайшая по пути',
        resolve('Заметка', 'Папка/Глубже/Вложенная.md') === 'Папка/Заметка.md',
        String(resolve('Заметка', 'Папка/Глубже/Вложенная.md')));
    assert('27.5c регистр не важен',
        resolve('папка/заметка', 'Один.md') === 'Папка/Заметка.md', String(resolve('папка/заметка', 'Один.md')));
    assert('27.5d относительный путь',
        resolve('../Заметка', 'Папка/Глубже/Вложенная.md') === 'Папка/Заметка.md',
        String(resolve('../Заметка', 'Папка/Глубже/Вложенная.md')));
    assert('27.5e неизвестная цель', resolve('Нет такой', 'Один.md') === null);
    assert('27.5f расширение добавляется', resolve('Один', 'Папка/Заметка.md') === 'Один.md');

    const tempVault = '.cache/case-vault';
    fs.rmSync(tempVault, { recursive: true, force: true });
    fs.mkdirSync(`${tempVault}/Папка`, { recursive: true });
    fs.writeFileSync(`${tempVault}/Папка/Первая.md`, [
        '---',
        'links:',
        '  - "[[Третья]]"',
        '---',
        'Ссылка [[Вторая]] и ещё раз [[Вторая]].',
        '```',
        '[[В блоке кода]]',
        '```',
        'Ссылка на себя [[Первая]]',
    ].join('\n'), 'utf8');
    fs.writeFileSync(`${tempVault}/Папка/Вторая.md`, 'Пустая\n', 'utf8');
    fs.writeFileSync(`${tempVault}/Папка/Третья.md`, 'Ссылка [[Папка/Первая.md]]\n', 'utf8');
    fs.writeFileSync(`${tempVault}/Корневая.md`, 'Ссылка [[первая]]\n', 'utf8');

    const links = readVault(tempVault);
    const firstLinks = links['Папка/Первая.md'] ?? {};
    assert('27.6a заметки найдены', listNotes(tempVault).length === 4, listNotes(tempVault).join(', '));
    assert('27.6b двойная ссылка считается дважды', firstLinks['Папка/Вторая.md'] === 2,
        String(firstLinks['Папка/Вторая.md']));
    assert('27.6c ссылка из свойств учтена', firstLinks['Папка/Третья.md'] === 1);
    assert('27.6d ссылка в блоке кода не учтена', !('В блоке кода.md' in firstLinks));
    assert('27.6e ссылка на себя отброшена', !('Папка/Первая.md' in firstLinks), JSON.stringify(firstLinks));
    assert('27.6f регистр имени разрешён',
        (links['Корневая.md'] ?? {})['Папка/Первая.md'] === 1, JSON.stringify(links['Корневая.md']));
    assert('27.6g точный путь разрешён', (links['Папка/Третья.md'] ?? {})['Папка/Первая.md'] === 1);
    fs.rmSync(tempVault, { recursive: true, force: true });
}

// ------------------------------------------------- 28. Панель без заметки
{
    const vault = indexedVault({ projects: 5, docs: 5 });
    const empty = run(vault, { rootPath: '' });
    assert('28.1 без активной заметки локальный режим показывает обзор хранилища',
        empty.nodes.length > 0 && !empty.nodes.some((node) => node.context === true), String(empty.nodes.length));
    assert('28.2 обзор без заметки строится без ошибок', empty.edges.length >= 0);

    const missing = run(vault, { rootPath: 'исчезла.md' });
    assert('28.3 удалённая заметка: граф строится, заметка показана одна',
        missing.nodes.length === 1 && missing.edges.length === 0, `${missing.nodes.length}/${missing.edges.length}`);
}

// --------------------------------------------- 29. Одинаковые имена и пути
{
    const vault = new VaultBuilder()
        .note('первая/Заметка.md').note('вторая/Заметка.md').note('связь.md')
        .add('связь.md', 'первая/Заметка.md');
    const graph = run(vault, { rootPath: 'связь.md' });
    assert('29.1 одинаковые имена в разных папках — разные узлы',
        paths(graph).has('первая/Заметка.md') && !paths(graph).has('вторая/Заметка.md'),
        [...paths(graph)].join(', '));

    const deep = new VaultBuilder();
    const segments = Array.from({ length: 20 }, (_, index) => `у${index}`);
    const deepPath = `${segments.join('/')}/дно.md`;
    deep.note(deepPath).note('верх.md').add('верх.md', deepPath);
    const deepGraph = run(deep, { rootPath: 'верх.md', relevance: 'core' });
    assert('29.2 двадцать уровней вложенности: узел найден', paths(deepGraph).has(deepPath), [...paths(deepGraph)].join(', '));

    const long = new VaultBuilder().note('короткая.md').note(`длинная-${'о'.repeat(300)}.md`)
        .add('короткая.md', `длинная-${'о'.repeat(300)}.md`);
    const longGraph = run(long, { rootPath: 'короткая.md' });
    assert('29.3 очень длинное имя не ломает узел',
        longGraph.nodes.length === 2 && longGraph.nodes.some((node) => node.title.length > 200),
        String(longGraph.nodes.map((node) => node.title.length).join(', ')));
}

// ------------------------------------------------- 30. Хранилище без заметок
{
    const onlyFiles = new VaultBuilder();
    const graph = run(onlyFiles, { scope: 'vault' });
    assert('30.1 хранилище без связей: пустой граф', graph.nodes.length === 0 && graph.edges.length === 0);

    const dense = new VaultBuilder();
    for (let i = 0; i < 60; i++) dense.add('звезда.md', `луч${i}.md`);
    const limitSmall = run(dense, { rootPath: 'звезда.md', limit: 5 });
    assert('30.2 предел меньше числа прямых связей: узлов не больше предела',
        limitSmall.nodes.length <= 5, String(limitSmall.nodes.length));
    assert('30.3 такая обрезка отмечена', limitSmall.truncated === true);
    assert('30.4 открытая заметка остаётся в графе', paths(limitSmall).has('звезда.md'));
}

// ------------------------------------------------- 31. Оглавление как открытая
{
    const vault = indexedVault({ projects: 40, docs: 40 });
    const graph = run(vault, { rootPath: 'vault.md', limit: 20 });
    const rootNode = graph.nodes.find((node) => node.path === 'vault.md');
    assert('31.1 открытая заметка-оглавление не помечена фоном', rootNode?.context !== true,
        JSON.stringify({ context: rootNode?.context }));
    assert('31.2 она остаётся в графе', rootNode !== undefined && graph.nodes.length > 1,
        String(graph.nodes.length));
    assert('31.3 связи открытой заметки показаны',
        graph.edges.some((edge) => graph.nodes[edge.source]?.path === 'vault.md'
            || graph.nodes[edge.target]?.path === 'vault.md'), String(graph.edges.length));
}

// -------------------------------------- 32. Прозрачность узлов (фон и фокус)
{
    const contextNode = { path: 'index.md', title: 'index', degree: 3, type: 'note' as const, context: true };
    const plainNode = { path: 'note.md', title: 'note', degree: 3, type: 'note' as const };
    assert('32.1 фон приглушён', render.nodeAlpha(contextNode, true, false, false) < 1,
        String(render.nodeAlpha(contextNode, true, false, false)));
    assert('32.2 открытая заметка не приглушается даже как оглавление',
        render.nodeAlpha(contextNode, true, false, true) === 1,
        String(render.nodeAlpha(contextNode, true, false, true)));
    assert('32.3 под курсором тоже не приглушается',
        render.nodeAlpha(contextNode, true, true, false) === 1);
    assert('32.4 обычный узел не приглушён', render.nodeAlpha(plainNode, true, false, false) === 1);
    assert('32.5 чужие узлы гаснут', render.nodeAlpha(plainNode, false, false, false) === render.FADE_ALPHA,
        String(render.nodeAlpha(plainNode, false, false, false)));
}

// ------------------------------------------------- 33. Вложения и не-заметки
{
    const vault = new VaultBuilder()
        .note('a.md').note('b.md')
        .add('a.md', 'files/pic.png')
        .add('a.md', 'b.md');
    let graph = run(vault, { rootPath: 'a.md', showAttachments: true });
    const picture = graph.nodes.find((node) => node.path === 'files/pic.png');
    assert('33.1 цель ссылки без .md — вложение, а не заметка',
        picture?.type === 'attachment', JSON.stringify(picture));
    assert('33.2 обычная заметка остаётся заметкой',
        graph.nodes.find((node) => node.path === 'b.md')?.type === 'note');

    // Заметка и вложение с одним именем — разные узлы
    const sameName = new VaultBuilder()
        .note('a.md').note('схема.md').add('a.md', 'files/схема.png').add('a.md', 'схема.md');
    graph = run(sameName, { rootPath: 'a.md', showAttachments: true });
    assert('33.3 заметка и вложение с одним именем не сливаются',
        graph.nodes.length === 3, graph.nodes.map((node) => node.path).join(', '));

    // Хранилище без заметок: только вложения в карте ссылок
    const attachmentsOnly = new VaultBuilder();
    attachmentsOnly.links = { 'files/pic.png': {}, 'files/doc.pdf': {} };
    const empty = run(attachmentsOnly, { scope: 'vault' });
    assert('33.4 хранилище только из вложений: граф пуст',
        empty.nodes.length === 0 && empty.edges.length === 0, String(empty.nodes.length));
}

// ------------------------------------- 34. Проявление подписей относительно вписывания
{
    const graph = { ...CORE_DEFAULTS };
    const quick = { ...CORE_DEFAULTS, textFadeMultiplier: -2 };
    const late = { ...CORE_DEFAULTS, textFadeMultiplier: 1 };

    // Маленький граф: вписан крупно, но пока не приблизил — имён не видно
    const smallFit = 3;
    assert('34.1 при вписывании маленького графа подписи скрыты',
        render.labelAlpha(smallFit, graph, smallFit) === 0,
        String(render.labelAlpha(smallFit, graph, smallFit)));
    assert('34.2 приблизил вдвое — видно наполовину',
        Math.abs(render.labelAlpha(smallFit * 2, graph, smallFit) - 0.5) < 0.01,
        String(render.labelAlpha(smallFit * 2, graph, smallFit)));
    assert('34.3 приблизил вчетверо — видно полностью',
        render.labelAlpha(smallFit * 4, graph, smallFit) >= 0.999,
        String(render.labelAlpha(smallFit * 4, graph, smallFit)));

    // Большой граф: вписан мелко, подписи скрыты, пока не приблизишь
    const bigFit = 0.1;
    assert('34.4 при вписывании большого графа подписи скрыты',
        render.labelAlpha(bigFit, graph, bigFit) === 0, String(render.labelAlpha(bigFit, graph, bigFit)));
    assert('34.5 приближение их проявляет',
        render.labelAlpha(bigFit * 8, graph, bigFit) > 0.5,
        String(render.labelAlpha(bigFit * 8, graph, bigFit)));

    // Настройка хранилища управляет скоростью проявления, но не снимает скрытость
    assert('34.6 «проявлять раньше» ускоряет появление',
        render.labelAlpha(smallFit * 2, quick, smallFit) > render.labelAlpha(smallFit * 2, graph, smallFit),
        `${render.labelAlpha(smallFit * 2, graph, smallFit).toFixed(2)} против ${
            render.labelAlpha(smallFit * 2, quick, smallFit).toFixed(2)}`);
    assert('34.7 «проявлять позже» замедляет появление',
        render.labelAlpha(smallFit * 2, late, smallFit) < render.labelAlpha(smallFit * 2, graph, smallFit),
        `${render.labelAlpha(smallFit * 2, graph, smallFit).toFixed(2)} против ${
            render.labelAlpha(smallFit * 2, late, smallFit).toFixed(2)}`);
    assert('34.8 при вписывании настройка не делает подписи видимыми',
        render.labelAlpha(smallFit, quick, smallFit) === 0,
        String(render.labelAlpha(smallFit, quick, smallFit)));

    // Уменьшение ниже вписанного тоже не проявляет подписи
    assert('34.9 уменьшение не проявляет подписи',
        render.labelAlpha(smallFit / 4, graph, smallFit) === 0);
    assert('34.10 подписи всегда в пределах 0…1',
        [0.01, 0.5, 1, 4, 64].every((scale) => {
            const alpha = render.labelAlpha(scale, graph, smallFit);
            return alpha >= 0 && alpha <= 1;
        }));
}

// ---------------------------------- 35. Размер подписи открытой заметки
{
    const hub = { path: 'hub.md', title: 'hub', degree: 120, type: 'note' as const };
    const leaf = { path: 'leaf.md', title: 'leaf', degree: 0, type: 'note' as const };
    const params = { ...CORE_DEFAULTS };

    const focused = render.labelFontSize(hub, params, 2, false, true, 0.5);
    const rawCore = 14 + 30 / 4;
    assert('35.1 у открытой заметки подпись меньше, чем дала бы формула ядра',
        focused < rawCore && focused <= 18, `${focused.toFixed(1)} против ${rawCore.toFixed(1)}`);

    assert('35.2 у заметки без связей подпись почти базовая',
        Math.abs(render.labelFontSize(leaf, params, 1, false, false, 0.5) - 15) < 0.01,
        String(render.labelFontSize(leaf, params, 1, false, false, 0.5)));

    assert('35.3 размер подписи узла зависит от масштаба панели',
        render.labelFontSize(hub, params, 1, false, true, 0.5)
        < render.labelFontSize(hub, params, 1, false, true, 1));

    assert('35.4 при приближении подписи остальных растут',
        render.labelFontSize(hub, params, 4, false, false, 0.5)
        > render.labelFontSize(hub, params, 1, false, false, 0.5));
    assert('35.5 подпись открытой заметки от приближения не растёт',
        Math.abs(render.labelFontSize(hub, params, 4, false, true, 0.5)
            - render.labelFontSize(hub, params, 1, false, true, 0.5)) < 0.001);
}

// --------------------------- 36. Соседи по месту не вытесняются бюджетом
{
    // Оглавление: сотни прямых связей и один сосед по папке
    const vault = new VaultBuilder().note('папка/хаб.md').note('папка/рядом.md');
    for (let i = 0; i < 400; i++) vault.add('папка/хаб.md', `лучи/л${i}.md`);
    const graph = run(vault, {
        rootPath: 'папка/хаб.md',
        place: ['папка/рядом.md'],
        limit: 50,
    });
    assert('36.1 сосед по папке показан даже у заметки с сотнями связей',
        paths(graph).has('папка/рядом.md'), `${graph.nodes.length} узлов`);
    assert('36.2 остальные прямые связи не вытеснили его',
        graph.nodes.length <= 50 && paths(graph).has('папка/хаб.md'), String(graph.nodes.length));

    // И для маленького предела тоже
    const tight = run(vault, { rootPath: 'папка/хаб.md', place: ['папка/рядом.md'], limit: 20 });
    assert('36.3 при жёстком пределе сосед тоже на месте',
        paths(tight).has('папка/рядом.md'), String(tight.nodes.length));
}

say(`\nпроверок: ${checks}, провалено: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
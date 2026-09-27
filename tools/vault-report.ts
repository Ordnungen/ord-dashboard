// ---------------------------------------------------------------------------
// Повторяемый анализатор кейсов: строит граф по настоящему хранилищу и печатает
// то, что увидит панель. Нужен, чтобы проверять правки на реальных заметках, а не
// на догадках.
//
//   npm run analyze -- "C:\путь\к\хранилищу" "путь/к/заметке.md"
//   npm run analyze -- --snapshot=vault.json "путь/к/заметке.md"
//
// Опции: --depth=2 --relevance=normal --index=context --place=on|off --limit=300
//        --write=vault.json  — сохранить снимок связей для тестов
// ---------------------------------------------------------------------------

import { say, sayErr } from './output';
import fs from 'node:fs';
import {
    OverviewSampler, titleFromPath,
    type IndexHandling, type RelevanceLevel,
} from '../src/graph-model';
import { CORE_DEFAULTS, displayParamsFromVault, type GraphParams } from '../src/graph-params';
import { labelAlpha } from '../src/graph-render';
import { readVault, sameFolderPaths } from './vault-fs';

interface Snapshot {
    root: string;
    links: Record<string, Record<string, number>>;
}

interface Options {
    vault: string;
    note: string;
    depth: number;
    relevance: RelevanceLevel;
    index: IndexHandling;
    place: boolean;
    limit: number;
    snapshot?: string;
    write?: string;
    /** Сколько заметок обойти в сплошной проверке хранилища (0 — выключено). */
    survey: number;
}

const PLACE_FOLDER_LIMIT = 50;

/**
 * Настройки графа самого хранилища: панель их уважает, поэтому и отчёт о
 * подписях должен считать по ним, а не по значениям по умолчанию.
 */
function vaultGraphParams(vault: string): GraphParams {
    if (!vault) return { ...CORE_DEFAULTS };
    for (const dir of ['.obsidian', '.config/obsidian', 'config']) {
        try {
            const raw = fs.readFileSync(`${vault}/${dir}/graph.json`, 'utf8');
            return displayParamsFromVault(JSON.parse(raw) as unknown);
        } catch {
            continue;
        }
    }
    return { ...CORE_DEFAULTS };
}

function parseArgs(argv: string[]): Options {    const positional: string[] = [];
    const flags = new Map<string, string>();
    for (const arg of argv) {
        const match = /^--([^=]+)=?(.*)$/.exec(arg);
        if (match?.[1]) flags.set(match[1], match[2] ?? '');
        else positional.push(arg);
    }
    const surveyFlag = flags.get('survey');
    return {
        vault: positional[0] ?? '',
        note: positional[1] ?? '',
        depth: Number(flags.get('depth') ?? 2),
        relevance: (flags.get('relevance') ?? 'normal') as RelevanceLevel,
        index: (flags.get('index') ?? 'context') as IndexHandling,
        place: (flags.get('place') ?? 'on') !== 'off',
        limit: Number(flags.get('limit') ?? 300),
        snapshot: flags.get('snapshot'),
        write: flags.get('write'),
        survey: surveyFlag === undefined ? 0 : Number(surveyFlag || '60'),
    };
}

/**
 * Сплошная проверка: строит граф для выборки заметок и считает, насколько то, что
 * показано, объяснимо. Находит систематические плохие случаи вместо разбора по
 * одной заметке.
 *
 * Метрики на заметку:
 *   за пределами  — доля показанных заметок вне двух верхних уровней пути открытой
 *                   (то есть «не из её области»; это измерение, а не правило отбора);
 *   соседи        — все ли заметки той же папки показаны;
 *   родные        — доля показанных из той же ветки, что и открытая.
 */
function survey(links: Record<string, Record<string, number>>, options: Options): void {
    const notes = Object.keys(links).sort();
    const step = Math.max(1, Math.floor(notes.length / Math.max(options.survey, 1)));
    const sample: string[] = [];
    for (let index = 0; index < notes.length && sample.length < options.survey; index += step) {
        const note = notes[index];
        if (note) sample.push(note);
    }

    // Верхний уровень пути: у заметки в корне хранилища это её собственное имя.
    const rootOf = (path: string): string => path.split('/')[0] ?? path;
    interface Row {
        path: string;
        nodes: number;
        edges: number;
        context: number;
        outside: number;
        outsideShare: number;
        /** Заметки без контекста: то, что читается как содержимое картинки. */
        visible: number;
        /** Ссылки на заметки (не на разделы) у открытой заметки. */
        noteLinks: number;
        mates: number;
        matesShown: number;
        ms: number;
        minScore: number;
        maxScore: number;
    }
    const rows: Row[] = [];

    for (const note of sample) {
        const mates = sameFolderPaths(notes, note, PLACE_FOLDER_LIMIT);
        const sampler = new OverviewSampler(links, {
            limit: options.limit,
            maxEdges: 20000,
            scope: 'local',
            rootPath: note,
            focusPath: note,
            depth: options.depth,
            relevance: options.relevance,
            indexHandling: options.index,
            placePaths: options.place ? mates : [],
            extraLimit: Math.max(40, Math.round(options.limit * 0.5)),
            showTags: true,
            showAttachments: true,
            includeUnresolved: true,
            extras: () => null,
        });
        const started = performance.now();
        while (!sampler.step(8)) { /* ждём */ }
        const ms = performance.now() - started;
        const graph = sampler.result;
        if (!graph) continue;

        const normal = graph.nodes.filter((node) => !node.context);
        const area = rootOf(note);
        const outside = normal.filter((node) => node.path !== note && rootOf(node.path) !== area);
        const scores = normal.map((node) => node.score ?? 0);
        // Ссылки на заметки, а не на разделы: у заметки, которая ссылается только
        // на свои оглавления, связей с другими заметками и нет.
        const contextPaths = new Set(graph.nodes.filter((node) => node.context).map((node) => node.path));
        const noteLinks = Object.keys(links[note] ?? {}).filter((target) => !contextPaths.has(target));
        rows.push({
            path: note,
            nodes: graph.nodes.length,
            // «Пусто» считается по заметкам, а не по контексту: у заметки, которая
            // ссылается только на свои разделы, картинка состоит из её имён.
            visible: normal.length,
            noteLinks: noteLinks.length,
            edges: graph.edges.length,
            context: graph.nodes.filter((node) => node.context).length,
            outside: outside.length,
            outsideShare: normal.length > 1 ? outside.length / (normal.length - 1) : 0,
            mates: mates.length,
            matesShown: mates.filter((mate) => graph.nodes.some((node) => node.path === mate)).length,
            ms,
            minScore: scores.length > 0 ? Math.min(...scores) : 0,
            maxScore: scores.length > 0 ? Math.max(...scores) : 0,
        });
    }

    const median = (values: number[]): number => {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };

    say(`хранилище:      ${notes.length} заметок`);
    say(`проверено:      ${rows.length} заметок (каждая ${step}-я)`);
    say(`настройки:      глубина ${options.depth}, отбор ${options.relevance}, `
        + `оглавления ${options.index}, место ${options.place ? 'да' : 'нет'}, предел ${options.limit}`);
    say(`узлов:          медиана ${median(rows.map((row) => row.nodes))}, `
        + `наибольшее ${Math.max(...rows.map((row) => row.nodes), 0)}`);
    say(`связей:         медиана ${median(rows.map((row) => row.edges))}, `
        + `наибольшее ${Math.max(...rows.map((row) => row.edges), 0)}`);
    say(`время:          медиана ${median(rows.map((row) => row.ms)).toFixed(0)} мс, `
        + `наибольшее ${Math.max(...rows.map((row) => row.ms), 0).toFixed(0)} мс`);
    say(`доля вне области: медиана ${(median(rows.map((row) => row.outsideShare)) * 100).toFixed(0)}%`);

    const missingMates = rows.filter((row) => row.mates > 0 && row.matesShown < row.mates);
    const tooWide = rows.filter((row) => row.outsideShare > 0.5 && row.nodes > 10);
    // «Пусто» — когда у заметки есть связи с другими заметками, но в картинке
    // ничего, кроме неё самой и её разделов: значит, отбор их выбросил.
    const tooNarrow = rows.filter((row) => row.noteLinks > 0 && row.visible <= 1 && row.mates > 0);

    say(`\nсоседи по папке показаны не полностью: ${missingMates.length} из ${rows.length}`);
    for (const row of missingMates.slice(0, 10)) {
        say(`  ${row.matesShown}/${row.mates}  ${row.path}`);
    }
    say(`\nбольше половины показанного — вне области заметки: ${tooWide.length} из ${rows.length}`);
    for (const row of [...tooWide].sort((a, b) => b.outsideShare - a.outsideShare).slice(0, 10)) {
        say(`  ${(row.outsideShare * 100).toFixed(0)}%  узлов ${row.nodes}  ${row.path}`);
    }
    say(`\nподозрительно пусто при наличии соседей: ${tooNarrow.length} из ${rows.length}`);
    for (const row of tooNarrow.slice(0, 10)) {
        say(`  заметок ${row.visible}  соседей ${row.mates}  ${row.path}`);
    }

    const widest = [...rows].sort((a, b) => b.nodes - a.nodes).slice(0, 5);
    say('\nсамые большие графы:');
    for (const row of widest) {
        say(`  узлов ${row.nodes}, связей ${row.edges}, вне области ${(row.outsideShare * 100).toFixed(0)}%  ${row.path}`);
    }
    const slowest = [...rows].sort((a, b) => b.ms - a.ms).slice(0, 5);
    say('\nсамые долгие:');
    for (const row of slowest) {
        say(`  ${row.ms.toFixed(0)} мс, узлов ${row.nodes}  ${row.path}`);
    }
}

function main(): void {
    const options = parseArgs(process.argv.slice(2));

    if (options.survey > 0) {
        if (!options.vault && !options.snapshot) {
            sayErr('для сплошной проверки нужен путь к хранилищу или снимок связей');
            process.exit(2);
        }
        const links = options.snapshot
            ? (JSON.parse(fs.readFileSync(options.snapshot, 'utf8')) as Snapshot).links
            : readVault(options.vault);
        survey(links, options);
        return;
    }

    let links: Record<string, Record<string, number>>;
    let root = options.note;

    if (options.snapshot) {
        const snapshot = JSON.parse(fs.readFileSync(options.snapshot, 'utf8')) as Snapshot;
        links = snapshot.links;
        root = options.note || snapshot.root;
    } else {
        if (!options.vault || !options.note) {
            sayErr('нужен путь к хранилищу и к заметке');
            process.exit(2);
        }
        links = readVault(options.vault);
    }

    if (options.write) {
        fs.writeFileSync(options.write, JSON.stringify({ root, links }), 'utf8');
        say(`снимок связей: ${options.write} (${Object.keys(links).length} заметок)`);
        if (!options.note) return;
    }

    const notes = Object.keys(links).sort();
    const folder = root.slice(0, root.lastIndexOf('/'));
    if (!notes.includes(root)) {
        sayErr(`заметка не найдена: ${root}`);
        process.exit(2);
    }

    // Панель передаёт соседей по месту отдельно, но при чтении с диска список
    // берётся из хранилища и уточняется по найденным заметкам.
    const place = options.place ? sameFolderPaths(notes, root, PLACE_FOLDER_LIMIT) : [];
    const sampler = new OverviewSampler(links, {
        limit: options.limit,
        maxEdges: 20000,
        scope: 'local',
        rootPath: root,
        focusPath: root,
        depth: options.depth,
        relevance: options.relevance,
        indexHandling: options.index,
        placePaths: place,
        extraLimit: Math.max(40, Math.round(options.limit * 0.5)),
        showTags: true,
        showAttachments: true,
        includeUnresolved: true,
        extras: () => null,
    });
    const started = performance.now();
    while (!sampler.step(8)) { /* ждём */ }
    const graph = sampler.result;
    if (!graph) {
        sayErr('граф не построен');
        process.exit(1);
    }
    const taken = performance.now() - started;

    const inDegree = new Map<string, number>();
    for (const note of notes) {
        for (const target of Object.keys(links[note] ?? {})) {
            inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
        }
    }
    const outDegree = (notePath: string): number => Object.keys(links[notePath] ?? {}).length;
    const kept = new Set(graph.nodes.map((node) => node.path));
    const mates = notes.filter((note) => note !== root && note.slice(0, note.lastIndexOf('/')) === folder);

    say(`хранилище:  ${notes.length} заметок`);
    say(`открыта:    ${root}`);
    say(`настройки:  глубина ${options.depth}, отбор ${options.relevance}, оглавления ${options.index}, `
        + `место ${options.place ? 'учитывается' : 'нет'}, предел ${options.limit}`);
    say(`итог:       ${graph.nodes.length} узлов, ${graph.edges.length} связей, `
        + `${taken.toFixed(0)} мс, отбор сработал: ${graph.filtered}`);
    say(`контекст:   ${graph.nodes.filter((node) => node.context).length} узлов-оглавлений`);
    {
        // Что увидят глаза: подписи других заметок в панели. Их прозрачность считается
        // от масштаба вписывания графа: пока граф просто вписан, имён не видно, и они
        // проявляются по мере приближения. Настройка проявления берётся из graph.json
        // самого хранилища, а имя открытой заметки видно всегда.
        const params = vaultGraphParams(options.vault);
        const fade = params.textFadeMultiplier;
        const show = (alpha: number): string => (alpha <= 0 ? 'скрыты' : alpha.toFixed(2));
        say(`подписи:    у вписанного графа ${show(labelAlpha(1, params, 1))}`
            + `, приблизил ×2 — ${show(labelAlpha(2, params, 1))}`
            + `, ×4 — ${show(labelAlpha(4, params, 1))}`
            + ` (проявление из graph.json: ${fade})`);
    }

    say(`\nсоседи по папке (${folder || 'корень хранилища'}, всего ${mates.length}):`);
    if (mates.length === 0) say('  нет');
    for (const mate of mates) {
        say(`  ${kept.has(mate) ? 'ПОКАЗАНА  ' : 'не показана'} ${titleFromPath(mate).slice(0, 64)}`);
    }

    const normal = graph.nodes.filter((node) => !node.context).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const foreign = normal.filter((node) => !node.path.startsWith(folder ? `${folder}/` : ''));
    say(`\nпоказаны без контекста: ${normal.length}, из них вне папки открытой заметки: ${foreign.length}`);
    say('по убыванию близости (близость 1 = ближе, чем случайная заметка):');
    for (const node of normal.slice(0, 40)) {
        const where = node.path.slice(0, node.path.lastIndexOf('/')) || '(корень)';
        say(`  ${(node.score ?? 0).toFixed(2).padStart(7)}  ${node.degree.toString().padStart(3)}·  `
            + `${titleFromPath(node.path).slice(0, 36).padEnd(38)}${where.slice(0, 44).padEnd(46)}`
            + `[${outDegree(node.path)} исх / ${inDegree.get(node.path) ?? 0} вх]`);
    }
    if (normal.length > 40) say(`  ... и ещё ${normal.length - 40}`);
}

main();

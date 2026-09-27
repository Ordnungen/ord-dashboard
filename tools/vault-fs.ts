// ---------------------------------------------------------------------------
// Чтение хранилища для инструментов анализа.
//
// Obsidian в плагине отдаёт готовую карту ссылок (`MetadataCache.resolvedLinks`),
// а инструментам приходится разбирать хранилище самим. Задача — повторять
// поведение ядра там, где это влияет на вывод: ссылки в свойствах, якоря и
// псевдонимы, блоки кода (их ядро не считает), регистр имён, относительные пути.
// ---------------------------------------------------------------------------

import { fs } from './node-io';
import { path } from './node-io';

export interface ParsedNote {
    /** Свойства заметки (упрощённый YAML) и текст без свойств. */
    props: Record<string, string[]>;
    body: string;
}

export type NoteLinks = Record<string, number>;

/** Фрагменты в блоках кода ядро ссылками не считает. */
export function stripCode(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/~~~[\s\S]*?~~~/g, ' ')
        .replace(/`[^`\n]*`/g, ' ');
}

/** Упрощённый разбор свойств: списки, строки и ссылки внутри них. */
export function parseNote(text: string): ParsedNote {
    if (!text.startsWith('---')) return { props: {}, body: text };
    const end = text.indexOf('\n---', 3);
    if (end < 0) return { props: {}, body: text };
    const props: Record<string, string[]> = {};
    let current: string | null = null;
    for (const raw of text.slice(3, end).split('\n')) {
        const line = raw.trimEnd();
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        if ((line.startsWith(' ') || line.startsWith('\t')) && current) {
            const value = line.trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
            if (value) (props[current] ??= []).push(value);
            continue;
        }
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const rest = line.slice(colon + 1).trim();
        current = key;
        if (rest.startsWith('[') && rest.endsWith(']')) {
            props[key] = rest.slice(1, -1).split(',')
                .map((value) => value.trim().replace(/^["']|["']$/g, ''))
                .filter(Boolean);
            current = null;
        } else {
            props[key] = rest ? [rest.replace(/^["']|["']$/g, '')] : [];
        }
    }
    return { props, body: text.slice(end + 4) };
}

const WIKILINK = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Сырые цели ссылок: из текста и из свойства `links`. */
export function findLinkTargets(note: ParsedNote): string[] {
    const haystack = `${stripCode(note.body)}\n${(note.props.links ?? []).join('\n')}`;
    const targets: string[] = [];
    for (const match of haystack.matchAll(WIKILINK)) {
        const target = match[1]?.trim();
        if (target) targets.push(target);
    }
    return targets;
}

export interface Resolver {
    (target: string, from: string): string | null;
}

/**
 * Разрешение ссылки как в ядре: сначала точный путь, потом имя файла (ближайший
 * по пути), при равном регистре — точное совпадение, иначе регистр не важен.
 */
export function createResolver(notes: string[]): Resolver {
    const exact = new Set(notes);
    const exactLower = new Map<string, string>();
    const byName = new Map<string, string[]>();
    const byNameLower = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, key: string, value: string): void => {
        const list = map.get(key);
        if (list) list.push(value);
        else map.set(key, [value]);
    };
    for (const note of notes) {
        exactLower.set(note.toLowerCase(), note);
        const name = path.posix.basename(note, '.md');
        push(byName, name, note);
        push(byNameLower, name.toLowerCase(), note);
    }
    const pick = (candidates: string[], from: string): string | null => {
        if (candidates.length === 0) return null;
        const fromFolder = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
        return [...candidates].sort((a, b) => {
            const nearA = fromFolder && a.startsWith(`${fromFolder}/`) ? 0 : 1;
            const nearB = fromFolder && b.startsWith(`${fromFolder}/`) ? 0 : 1;
            return nearA - nearB
                || a.split('/').length - b.split('/').length
                || a.length - b.length
                || a.localeCompare(b);
        })[0] ?? null;
    };

    return (target: string, from: string): string | null => {
        let clean = target.trim().replace(/^["']|["']$/g, '');
        if (!clean) return null;
        // Относительный путь считается от папки заметки.
        if (clean.startsWith('./') || clean.startsWith('../')) {
            const folder = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
            clean = path.posix.normalize(path.posix.join(folder, clean));
        }
        const path_ = clean.toLowerCase().endsWith('.md') ? clean : `${clean}.md`;
        if (exact.has(path_)) return path_;
        const byCase = exactLower.get(path_.toLowerCase());
        if (byCase) return byCase;
        const name = path.posix.basename(clean, '.md');
        const exactName = byName.get(name);
        if (exactName) return pick(exactName, from);
        const lowerName = byNameLower.get(name.toLowerCase());
        return lowerName ? pick(lowerName, from) : null;
    };
}

export function listNotes(vault: string): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.toLowerCase().endsWith('.md')) {
                found.push(path.relative(vault, full).split(path.sep).join('/'));
            }
        }
    };
    walk(vault);
    return found.sort();
}

/** Ссылки всего хранилища: источник → цели (сколько раз каждая). */
export function readVault(vault: string, notePaths?: string[]): Record<string, NoteLinks> {
    const notes = notePaths ?? listNotes(vault);
    const resolve = createResolver(notes);
    const links: Record<string, NoteLinks> = {};
    for (const note of notes) {
        const text = fs.readFileSync(path.join(vault, note), 'utf8');
        const targets: NoteLinks = {};
        for (const raw of findLinkTargets(parseNote(text))) {
            const resolved = resolve(raw, note);
            if (resolved && resolved !== note) targets[resolved] = (targets[resolved] ?? 0) + 1;
        }
        links[note] = targets;
    }
    for (const note of notes) links[note] ??= {};
    return links;
}

/**
 * Заметки того же места: одна папка с открытой заметкой. Пустой список, если в
 * папке слишком много заметок: там папка уже ничего не значит.
 */
export function sameFolderPaths(notes: string[], root: string, limit: number): string[] {
    const folder = root.slice(0, root.lastIndexOf('/'));
    const mates = notes.filter((note) => note !== root && note.slice(0, note.lastIndexOf('/')) === folder);
    return mates.length <= limit ? mates.sort() : [];
}

// ---------------------------------------------------------------------------
// Заглушка Obsidian API и мини-DOM для инструментов: позволяют гонять настоящий
// код плагина в Node, включая слой вида и работу с событиями, без Obsidian.
//
// Реализовано только то, что использует плагин. Таймеры управляемые: проверки
// сами двигают время (`clock.advance`), поэтому поведение с задержками
// проверяется детерминированно, а не ожиданием.
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

// ---------------------------------------------------------------------------
// Управляемое время
// ---------------------------------------------------------------------------

class FakeClock {
    /** Начало отсчёта: время в проверках идёт от него, а не от нуля. */
    private readonly base = Date.UTC(2026, 8, 26, 12, 0, 0);
    private time = 0;
    private queue: { at: number; run: () => void; cancelled: boolean }[] = [];

    now(): number { return this.base + this.time; }

    setTimeout(run: () => void, delay = 0): number {
        const entry = { at: this.time + Math.max(delay, 0), run, cancelled: false };
        this.queue.push(entry);
        return this.queue.length;
    }

    clearTimeout(id: number): void {
        const entry = this.queue[id - 1];
        if (entry) entry.cancelled = true;
    }

    /** Продвигает время, выполняя всё, что должно было сработать. */
    advance(ms: number): void {
        const target = this.time + ms;
        for (;;) {
            const due = this.queue.filter((entry) => !entry.cancelled && entry.at <= target);
            if (due.length === 0) break;
            due.sort((a, b) => a.at - b.at);
            const next = due[0];
            if (!next) break;
            next.cancelled = true;
            this.time = next.at;
            next.run();
        }
        this.time = target;
    }

    get pending(): number {
        return this.queue.filter((entry) => !entry.cancelled).length;
    }
}

export const clock = new FakeClock();

// ---------------------------------------------------------------------------
// Мини-DOM
// ---------------------------------------------------------------------------

export interface ElementOptions {
    cls?: string;
    text?: string;
    attr?: Record<string, string>;
    type?: string;
    placeholder?: string;
}

export interface RecordingContext {
    calls: string[];
    fillText(text: string, x: number, y: number): void;
    arc(x: number, y: number, radius: number, from: number, to: number): void;
    [key: string]: unknown;
}
class FakeContext implements RecordingContext {
    [key: string]: unknown;

    calls: string[] = [];
    globalAlpha = 1;
    fillStyle: unknown = '';
    strokeStyle: unknown = '';
    font = '';
    textAlign = '';
    textBaseline = '';
    lineWidth = 1;

    private record(name: string): void {
        this.calls.push(name);
    }

    save(): void { this.record('save'); }
    restore(): void { this.record('restore'); }
    clearRect(): void { this.record('clearRect'); }
    setTransform(): void { this.record('setTransform'); }
    scale(): void { this.record('scale'); }
    translate(): void { this.record('translate'); }
    beginPath(): void { this.record('beginPath'); }
    closePath(): void { this.record('closePath'); }
    moveTo(): void { this.record('moveTo'); }
    lineTo(): void { this.record('lineTo'); }
    arc(): void { this.record('arc'); }
    fill(): void { this.record('fill'); }
    stroke(): void { this.record('stroke'); }
    fillText(text: string): void { this.record(`fillText:${text}@${this.globalAlpha.toFixed(2)}`); }
}

export class FakeElement {
    readonly tag: string;
    readonly children: FakeElement[] = [];
    readonly classes = new Set<string>();
    readonly attributes: Record<string, string> = {};
    readonly listeners = new Map<string, Listener[]>();
    textContent = '';
    parent: FakeElement | null = null;
    clientWidth = 400;
    clientHeight = 200;
    width = 400;
    height = 200;
    readonly style: Record<string, string> = {};
    private context: FakeContext | null = null;

    constructor(tag: string, options: ElementOptions = {}) {
        this.tag = tag;
        if (options.cls) for (const name of options.cls.split(' ')) this.classes.add(name);
        if (options.text !== undefined) this.textContent = options.text;
        if (options.type) this.attributes.type = options.type;
        if (options.placeholder) this.attributes.placeholder = options.placeholder;
        for (const [key, value] of Object.entries(options.attr ?? {})) this.attributes[key] = value;
    }

    get classList(): { add: (name: string) => void; remove: (name: string) => void } {
        return {
            add: (name: string) => this.classes.add(name),
            remove: (name: string) => this.classes.delete(name),
        };
    }

    get ownerDocument(): FakeDocument {
        return this.owner ?? new FakeDocument();
    }

    owner: FakeDocument | null = null;

    createEl(tag: string, options: ElementOptions = {}): FakeElement {
        const child = new FakeElement(tag, options);
        this.appendChild(child);
        return child;
    }

    createDiv(options: ElementOptions = {}): FakeElement {
        const element = new FakeElement('div', options);
        this.appendChild(element);
        return element;
    }

    createSpan(options: ElementOptions = {}): FakeElement {
        const element = new FakeElement('span', options);
        this.appendChild(element);
        return element;
    }

    appendChild(child: FakeElement): void {
        child.parent = this;
        child.owner = this.owner;
        this.children.push(child);
    }

    empty(): void { this.children.length = 0; this.textContent = ''; }
    setText(text: string): void { this.textContent = text; }
    getText(): string { return this.textContent; }
    addClass(name: string): void { this.classes.add(name); }
    removeClass(name: string): void { this.classes.delete(name); }
    hasClass(name: string): boolean { return this.classes.has(name); }
    toggleClass(name: string, value?: boolean): void {
        const on = value ?? !this.classes.has(name);
        if (on) this.classes.add(name);
        else this.classes.delete(name);
    }

    setCssProps(props: Record<string, string>): void {
        for (const [key, value] of Object.entries(props)) this.style[key] = value;
    }

    setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
    addEventListener(type: string, listener: Listener): void {
        const list = this.listeners.get(type);
        if (list) list.push(listener);
        else this.listeners.set(type, [listener]);
    }
    removeEventListener(type: string, listener: Listener): void {
        const list = this.listeners.get(type);
        if (!list) return;
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
    }

    /** Сколько раз на элементе слушали это событие. */
    listenerCount(type: string): number { return this.listeners.get(type)?.length ?? 0; }

    /** Вызывает слушателей так, как это сделал бы браузер. */
    dispatch(type: string, event: Record<string, unknown> = {}): void {
        const payload = {
            type,
            stopPropagation: () => undefined,
            preventDefault: () => undefined,
            ...event,
        };
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(payload);
    }

    click(): void { this.dispatch('click'); }
    scrollTo(): void { /* нечего проверять */ }

    getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
        return { width: this.clientWidth, height: this.clientHeight, left: 0, top: 0 };
    }

    getContext(kind: string): RecordingContext | null {
        if (kind !== '2d') return null;
        this.context ??= new FakeContext();
        return this.context;
    }

    /** Записи рисования на canvas (для проверок отрисовки). */
    get drawn(): string[] { return this.context?.calls ?? []; }

    /** Убирает элемент из родителя: так ядро убирает пробные элементы. */
    remove(): void {
        if (!this.parent) return;
        const at = this.parent.children.indexOf(this);
        if (at >= 0) this.parent.children.splice(at, 1);
        this.parent = null;
    }

    /** Видимость элемента: скрытым считается только помеченный классом. */
    isShown(): boolean {
        return !this.classes.has('is-hidden');
    }

    /** Значение полей ввода: браузер отдаёт его свойством, а не атрибутом. */
    get value(): string { return this.attributes.value ?? ''; }
    set value(next: string) { this.attributes.value = next; }

    get placeholder(): string { return this.attributes.placeholder ?? ''; }
    set placeholder(next: string) { this.attributes.placeholder = next; }

    get checked(): boolean { return this.attributes.checked === 'true'; }
    set checked(next: boolean) { this.attributes.checked = String(next); }

    setSelectionRange(): void { /* нечего проверять */ }
    focus(): void { /* нечего проверять */ }

    /** Все потомки, включая самого себя. */
    all(): FakeElement[] {
        const found: FakeElement[] = [this];
        for (const child of this.children) found.push(...child.all());
        return found;
    }

    findByClass(name: string): FakeElement | null {
        return this.all().find((element) => element.classes.has(name)) ?? null;
    }

    findAllByTag(tag: string): FakeElement[] {
        return this.all().filter((element) => element.tag === tag);
    }
}

export class FakeDocument {
    body = new FakeElement('body');
    private listeners = new Map<string, Listener[]>();

    constructor() {
        this.body.owner = this;
    }

    createEl(tag: string, options: ElementOptions = {}): FakeElement {
        const element = new FakeElement(tag, options);
        element.owner = this;
        return element;
    }

    createDiv(options: ElementOptions = {}): FakeElement {
        const element = new FakeElement('div', options);
        element.owner = this;
        return element;
    }

    createSpan(options: ElementOptions = {}): FakeElement {
        const element = new FakeElement('span', options);
        element.owner = this;
        return element;
    }

    get defaultView(): unknown { return fakeWindow; }
    addEventListener(type: string, listener: Listener): void {
        const list = this.listeners.get(type);
        if (list) list.push(listener);
        else this.listeners.set(type, [listener]);
    }

    removeEventListener(type: string, listener: Listener): void {
        const list = this.listeners.get(type);
        if (!list) return;
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
    }
}

// ---------------------------------------------------------------------------
// Окно
// ---------------------------------------------------------------------------

export const fakeWindow = {
    devicePixelRatio: 2,
    setTimeout: (run: () => void, delay?: number): number => clock.setTimeout(run, delay),
    clearTimeout: (id: number): void => clock.clearTimeout(id),
    requestAnimationFrame: (run: () => void): number => clock.setTimeout(run, 16),
    cancelAnimationFrame: (id: number): void => clock.clearTimeout(id),
    requestIdleCallback: (run: () => void): number => clock.setTimeout(run, 1),
    cancelIdleCallback: (id: number): void => clock.clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
};

/** Набор документ-объектов: у каждого элемента свой документ, как в Obsidian. */
export const document = new FakeDocument();

/** Цвета темы: как их отдал бы браузер для классов графа ядра. */
const THEME_VALUES: Record<string, string> = {
    'color-fill': 'rgb(200, 200, 200)',
    'color-fill-focused': 'rgb(120, 80, 255)',
    'color-fill-tag': 'rgb(0, 160, 90)',
    'color-fill-attachment': 'rgb(220, 170, 40)',
    'color-fill-unresolved': 'rgba(150, 150, 150, 0.5)',
    'color-arrow': 'rgb(90, 90, 90)',
    'color-circle': 'rgb(255, 255, 255)',
    'color-line': 'rgb(130, 130, 130)',
    'color-text': 'rgb(30, 30, 30)',
    'fill-highlight': 'rgb(255, 120, 120)',
    'line-highlight': 'rgb(255, 120, 120)',
};

/** Стили для пробного элемента: как их отдал бы браузер. */
export function computedStyle(element: FakeElement): {
    color: string; opacity: string; getPropertyValue: (name: string) => string;
} {
    let color = THEME_VALUES['color-circle'] ?? '';
    let opacity = '1';
    for (const name of element.classes) {
        if (!THEME_VALUES[name]) continue;
        const value = THEME_VALUES[name];
        color = value;
        const alpha = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(value);
        opacity = alpha?.[1] ?? '1';
    }
    return { color, opacity, getPropertyValue: () => color };
}

/** Устанавливает глобальные объекты браузера, которые использует плагин. */
export function installGlobals(): void {
    const globals = globalThis as Record<string, unknown>;
    globals.createDiv = (options?: ElementOptions) => document.createDiv(options);
    globals.createSpan = (options?: ElementOptions) => document.createSpan(options);
    globals.createEl = (tag: string, options?: ElementOptions) => document.createEl(tag, options);
    globals.document = document;
    globals.window = fakeWindow;
    globals.getComputedStyle = (element: FakeElement) => computedStyle(element);
    // Плагин берёт «сейчас» из Date.now: в проверках время идёт через clock.
    Date.now = () => clock.now();
}

// ---------------------------------------------------------------------------
// Obsidian API
// ---------------------------------------------------------------------------

export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export function getLanguage(): string {
    return language;
}

let language = 'en';
export function setLanguage(value: string): void { language = value; }

export function debounce<T extends (...args: never[]) => unknown>(fn: T, timeout = 0, resetTimer = false): T {
    let id: number | null = null;
    const wrapped = (...args: never[]): void => {
        if (id !== null) clock.clearTimeout(id);
        else if (!resetTimer) { /* без сброса таймера второй вызов ничего не меняет */ }
        id = clock.setTimeout(() => { id = null; fn(...args); }, timeout);
    };
    return wrapped as unknown as T;
}

export const Platform = { isMobile: false, isDesktop: true };

export function setIcon(element: FakeElement, name: string): void {
    element.setAttribute('data-icon', name);
}

export class Notice {
    static messages: string[] = [];
    constructor(message: string) { Notice.messages.push(message); }
}

export class TFile {
    path: string;
    extension = 'md';
    stat: { ctime: number; mtime: number };
    parent: TFolder | null = null;
    name: string;

    constructor(path: string, times: { ctime?: number; mtime?: number } = {}) {
        this.path = path;
        this.name = path.slice(path.lastIndexOf('/') + 1);
        this.extension = this.name.includes('.') ? this.name.slice(this.name.lastIndexOf('.') + 1) : '';
        this.stat = { ctime: times.ctime ?? 0, mtime: times.mtime ?? 0 };
    }

    get basename(): string {
        return this.name.endsWith('.md') ? this.name.slice(0, -3) : this.name;
    }
}

export class TFolder {
    path: string;
    name: string;
    children: (TFile | TFolder)[] = [];

    constructor(path: string) {
        this.path = path;
        this.name = path.slice(path.lastIndexOf('/') + 1);
    }
    get isRoot(): boolean { return this.path === '/' || this.path === ''; }
}

export interface FakeFileCache {
    tags?: { tag: string }[];
    frontmatter?: Record<string, unknown>;
    links?: { link: string }[];
    embeds?: { link: string }[];
}

export class FakeAdapter {
    files = new Map<string, string>();
    folders = new Set<string>();

    async exists(path: string): Promise<boolean> { return this.files.has(path); }
    async read(path: string): Promise<string> {
        const content = this.files.get(path);
        if (content === undefined) throw new Error(`нет файла: ${path}`);
        return content;
    }
    async write(path: string, content: string): Promise<void> { this.files.set(path, content); }
    async rename(from: string, to: string): Promise<void> {
        const content = this.files.get(from);
        if (content === undefined) throw new Error(`нет файла: ${from}`);
        this.files.set(to, content);
        this.files.delete(from);
    }
    async mkdir(path: string): Promise<void> { this.folders.add(path); }
    async remove(path: string): Promise<void> { this.files.delete(path); }
}

class EventBus {
    private listeners = new Map<string, Listener[]>();

    on(type: string, listener: Listener): { type: string } {
        const list = this.listeners.get(type);
        if (list) list.push(listener);
        else this.listeners.set(type, [listener]);
        return { type };
    }

    off(type: string, listener: Listener): void {
        const list = this.listeners.get(type);
        if (!list) return;
        const at = list.indexOf(listener);
        if (at >= 0) list.splice(at, 1);
    }

    trigger(type: string, ...args: unknown[]): void {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(...args);
    }

    count(type: string): number { return this.listeners.get(type)?.length ?? 0; }
}

export class FakeApp {
    vault: {
        configDir: string; adapter: FakeAdapter; getMarkdownFiles: () => TFile[];
        getFileByPath: (path: string) => TFile | null; fileAt: (path: string) => TFile; folderAt: (path: string) => TFolder; getAbstractFileByPath: (path: string) => TFile | TFolder | null;
        on: (type: string, listener: Listener) => { type: string }; trigger: (type: string, ...args: unknown[]) => void;
        bus: EventBus; create: (path: string, content: string) => Promise<TFile>;
        modify: (path: string, content: string) => Promise<void>; delete: (path: string) => Promise<void>;
        rename: (path: string, newPath: string) => Promise<void>;
    };
    metadataCache: {
        resolvedLinks: Record<string, Record<string, number>>;
        getFileCache: (file: TFile) => FakeFileCache | null;
        caches: Map<string, FakeFileCache>;
        on: (type: string, listener: Listener) => { type: string }; trigger: (type: string, ...args: unknown[]) => void;
        bus: EventBus;
    };
    workspace: {
        leaves: WorkspaceLeaf[];
        getLeavesOfType: (type: string) => WorkspaceLeaf[];
        getRightLeaf: (split: boolean) => WorkspaceLeaf | null;
        getLeaf: (kind: string) => WorkspaceLeaf;
        getActiveFile: () => TFile | null;
        on: (type: string, listener: Listener) => { type: string }; trigger: (type: string, ...args: unknown[]) => void;
        onLayoutReady: (run: () => void) => void;
        revealLeaf: (leaf: WorkspaceLeaf) => Promise<void>;
        bus: EventBus;
        activeFile: TFile | null;
        layoutReady: boolean;
    };

    constructor() {
        const vaultBus = new EventBus();
        const metaBus = new EventBus();
        const workspaceBus = new EventBus();
        const adapter = new FakeAdapter();
        const files = new Map<string, TFile>();
        const folders = new Map<string, TFolder>();
        const caches = new Map<string, FakeFileCache>();

        const resolveParent = (path: string): TFolder | null => {
            const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/';
            let folder = folders.get(parentPath);
            if (!folder) {
                folder = new TFolder(parentPath === '' ? '/' : parentPath);
                folders.set(folder.path, folder);
            }
            return folder;
        };

        const register = (path: string, times: { ctime?: number; mtime?: number } = {}): TFile => {
            const file = new TFile(path, times);
            files.set(path, file);
            const parent = resolveParent(path);
            file.parent = parent;
            parent?.children.push(file);
            return file;
        };

        const vault = {
            configDir: 'vault-config',
            adapter,
            bus: vaultBus,
            on: (type: string, listener: Listener) => vaultBus.on(type, listener),
            trigger: (type: string, ...args: unknown[]) => vaultBus.trigger(type, ...args),
            getMarkdownFiles: () => [...files.values()].filter((file) => file.extension.toLowerCase() === 'md'),
            getFileByPath: (path: string) => files.get(path) ?? null,
        fileAt: (path: string): TFile => {
            const found = files.get(path);
            if (!found) throw new Error(`в хранилище нет файла ${path}`);
            return found;
        },
        folderAt: (path: string): TFolder => {
            const found = folders.get(path);
            if (!found) throw new Error(`в хранилище нет папки ${path}`);
            return found;
        },
            getAbstractFileByPath: (path: string): TFile | TFolder | null =>
                files.get(path) ?? folders.get(path) ?? null,
            create: async (path: string, content: string): Promise<TFile> => {
                const file = register(path);
                adapter.files.set(path, content);
                vaultBus.trigger('create', file);
                return file;
            },
            modify: async (path: string, content: string): Promise<void> => {
                const file = files.get(path);
                adapter.files.set(path, content);
                if (file) {
                    file.stat.mtime = clock.now();
                    vaultBus.trigger('modify', file);
                }
            },
            delete: async (path: string): Promise<void> => {
                const file = files.get(path);
                if (!file) return;
                files.delete(path);
                adapter.files.delete(path);
                vaultBus.trigger('delete', file);
            },
            rename: async (path: string, newPath: string): Promise<void> => {
                const file = files.get(path);
                if (!file) return;
                files.delete(path);
                const content = adapter.files.get(path) ?? '';
                adapter.files.delete(path);
                file.path = newPath;
                register(newPath, { ctime: file.stat.ctime, mtime: file.stat.mtime });
                adapter.files.set(newPath, content);
                vaultBus.trigger('rename', file, path);
            },
            /** Служебное: добавить файл до старта плагина. */
            seed: (path: string, times: { ctime?: number; mtime?: number } = {}): TFile => register(path, times),
            folder: (path: string): TFolder => {
                const folder = folders.get(path) ?? new TFolder(path);
                folders.set(path, folder);
                return folder;
            },
            renameFolder: (path: string, newPath: string): void => {
                const folder = folders.get(path);
                if (!folder) return;
                folders.delete(path);
                folder.path = newPath;
                folders.set(newPath, folder);
                vaultBus.trigger('rename', folder, path);
            },
        };

        const metadataCache = {
            resolvedLinks: {} as Record<string, Record<string, number>>,
            caches,
            bus: metaBus,
            on: (type: string, listener: Listener) => metaBus.on(type, listener),
            trigger: (type: string, ...args: unknown[]) => metaBus.trigger(type, ...args),
            getFileCache: (file: TFile) => caches.get(file.path) ?? null,
        };

        const workspace = {
            leaves: [] as WorkspaceLeaf[],
            bus: workspaceBus,
            activeFile: null as TFile | null,
            layoutReady: false,
            on: (type: string, listener: Listener) => workspaceBus.on(type, listener),
            trigger: (type: string, ...args: unknown[]) => workspaceBus.trigger(type, ...args),
            getLeavesOfType: (type: string) => workspace.leaves.filter((leaf) => leaf.view?.getViewType() === type),
            getRightLeaf: () => null as WorkspaceLeaf | null,
            getLeaf: (kind: string) => createLeaf(kind),
            getActiveFile: () => workspace.activeFile,
            onLayoutReady: (run: () => void) => {
                if (workspace.layoutReady) run();
                else workspaceBus.on('layout-ready', () => run());
            },
            ready: () => {
                workspace.layoutReady = true;
                workspaceBus.trigger('layout-ready');
            },
            revealLeaf: async (leaf: WorkspaceLeaf) => { workspace.leaves.push(leaf); },
            openFile: async (file: TFile) => {
                workspace.activeFile = file;
                workspaceBus.trigger('file-open', file);
            },
        };

        const createLeaf = (kind: string): WorkspaceLeaf => this.buildLeaf(kind);

        this.vault = vault;
        this.metadataCache = metadataCache;
        this.workspace = workspace;
        this.createLeaf = createLeaf;
    }

    createLeaf: (kind: string) => WorkspaceLeaf;

    /** Создаёт вкладку так, как это делает Obsidian: вид появляется по setViewState. */
    private buildLeaf(kind: string): WorkspaceLeaf {
        const leaf: WorkspaceLeaf = {
            kind,
            view: null,
            app: this,
            containerEl: document.createDiv(),
            getViewState: () => ({ type: 'empty', state: {} }),
            setViewState: async (state: { type: string; state?: unknown }) => {
                leaf.view = viewFactory(state.type, leaf);
                if (leaf.view) await leaf.view.onOpen?.();
                if (!this.workspace.leaves.includes(leaf)) this.workspace.leaves.push(leaf);
            },
            // Открытие файла в вкладке: Obsidian сообщает об этом событием file-open.
            openFile: async (file: TFile) => {
                this.workspace.activeFile = file;
                this.workspace.bus.trigger('file-open', file);
            },
            detach: async () => {
                this.workspace.leaves = this.workspace.leaves.filter((item) => item !== leaf);
            },
            isDeferred: false,
        };
        return leaf;
    }
}

let viewFactory: (type: string, leaf: WorkspaceLeaf) => ItemView | null = () => null;
let viewRegistrations = new Map<string, (leaf: WorkspaceLeaf) => ItemView>();

/** Регистрация фабрик видов: плагин делает это сам через registerView. */
export function createView(type: string, leaf: WorkspaceLeaf): void {
    const factory = viewRegistrations.get(type);
    if (factory && leaf) leaf.view = factory(leaf);
}

export interface WorkspaceLeaf {
    kind: string;
    view: ItemView | null;
    app: FakeApp;
    containerEl: FakeElement;
    getViewState: () => { type: string; state?: unknown };
    setViewState: (state: { type: string; state?: unknown }) => Promise<void>;
    openFile: (file: TFile) => Promise<void>;
    detach: () => Promise<void>;
    isDeferred: boolean;
}

export class ItemView {
    leaf: WorkspaceLeaf;
    app: FakeApp;
    containerEl: FakeElement;
    contentEl: FakeElement;

    constructor(leaf: WorkspaceLeaf) {
        this.leaf = leaf;
        this.app = leaf.app;
        this.containerEl = leaf.containerEl.createDiv({ cls: 'view-content' });
        this.contentEl = this.containerEl.createDiv();
    }

    getViewType(): string { return 'unknown'; }
    getDisplayText(): string { return ''; }
    getIcon(): string { return 'document'; }
    async onOpen(): Promise<void> { /* переопределяется */ }
    async onClose(): Promise<void> { /* переопределяется */ }

    registerEvent(event: unknown): void {
        void event;
    }

    addAction(_icon: string, _title: string, run: () => void): FakeElement {
        const action = this.containerEl.createDiv({ cls: 'view-action' });
        action.addEventListener('click', () => run());
        return action;
    }
}

export class Plugin {
    app: FakeApp;
    manifest = { id: 'ord-dashboard', version: '0.0.0' };
    private events: { bus: EventBus; type: string; listener: Listener }[] = [];
    private commands = new Map<string, () => unknown>();
    private viewTypes = new Map<string, (leaf: WorkspaceLeaf) => ItemView>();
    private ribbons: FakeElement[] = [];
    private settingsTabs: unknown[] = [];
    private data: unknown = null;
    private intervals: number[] = [];
    savedCount = 0;

    constructor(app: FakeApp, manifest?: { id?: string; version?: string }) {
        this.app = app;
        if (manifest?.id) this.manifest = { id: manifest.id, version: manifest.version ?? '0.0.0' };
    }

    async onload(): Promise<void> { /* переопределяется */ }
    onunload(): void { /* переопределяется */ }

    addCommand(command: { id: string; name: string; callback: () => unknown }): void {
        this.commands.set(command.id, command.callback);
    }

    /** Служебное для проверок: выполнить команду по её идентификатору. */
    runCommand(id: string): unknown {
        const command = this.commands.get(id);
        if (!command) throw new Error(`нет команды: ${id}`);
        return command();
    }

    get commandIds(): string[] { return [...this.commands.keys()]; }

    addRibbonIcon(icon: string, title: string, run: () => void): FakeElement {
        const element = document.createDiv({ cls: 'side-dock-ribbon-action' });
        element.setAttribute('data-icon', icon);
        element.setAttribute('aria-label', title);
        element.addEventListener('click', () => run());
        this.ribbons.push(element);
        return element;
    }

    get ribbon(): FakeElement | null { return this.ribbons[0] ?? null; }

    registerView(type: string, factory: (leaf: WorkspaceLeaf) => ItemView): void {
        this.viewTypes.set(type, factory);
        viewRegistrations.set(type, factory);
        viewFactory = (requested, leaf) => this.viewTypes.get(requested)?.(leaf) ?? null;
    }

    addSettingTab(tab: unknown): void { this.settingsTabs.push(tab); }
    /** Вкладки настроек, которые плагин создал (у настоящего класса их нет). */
    get createdSettingTabs(): unknown[] { return this.settingsTabs; }

    registerEvent(event: unknown): void {
        const candidate = event as { bus?: EventBus; type?: string };
        if (candidate?.bus && candidate.type) {
            // Регистрация уже произошла через bus.on; здесь только учёт для выгрузки.
            this.events.push({ bus: candidate.bus, type: candidate.type, listener: () => undefined });
        }
    }

    registerInterval(id: number): number {
        this.intervals.push(id);
        return id;
    }

    registerDomEvent(element: FakeElement, type: string, listener: Listener): void {
        element.addEventListener(type, listener);
    }

    async loadData(): Promise<unknown> { return this.data; }
    async saveData(data: unknown): Promise<void> { this.data = data; this.savedCount += 1; }
    get storedData(): unknown { return this.data; }

    addStatusBarItem(): FakeElement { return document.createDiv({ cls: 'status-bar-item' }); }
}

export class Modal {
    /** Все созданные окна: проверкам нужно нажать кнопку в окне подтверждения. */
    static instances: Modal[] = [];

    app: FakeApp;
    containerEl: FakeElement;
    contentEl: FakeElement;
    titleEl: FakeElement;
    isOpen = false;

    constructor(app: FakeApp) {
        this.app = app;
        this.containerEl = document.createDiv({ cls: 'modal-container' });
        this.contentEl = this.containerEl.createDiv({ cls: 'modal-content' });
        this.titleEl = this.containerEl.createDiv({ cls: 'modal-title' });
        Modal.instances.push(this);
    }

    setTitle(title: string): this { this.titleEl.setText(title); return this; }
    open(): void { this.isOpen = true; this.onOpen(); }
    close(): void { this.isOpen = false; this.onClose(); }
    onOpen(): void { /* переопределяется */ }
    onClose(): void { /* переопределяется */ }

    /** Служебное для проверок: нажать кнопку подтверждения или отмены. */
    pressButton(index: number): void {
        const buttons = this.contentEl.findAllByTag('button');
        buttons[index]?.click();
    }

    get buttons(): FakeElement[] { return this.contentEl.findAllByTag('button'); }
}

class ButtonComponent {
    constructor(private element: FakeElement) {}
    setButtonText(text: string): this { this.element.setText(text); return this; }
    setIcon(icon: string): this { this.element.setAttribute('data-icon', icon); return this; }
    setDestructive(): this { this.element.addClass('mod-warning'); return this; }
    setCta(): this { this.element.addClass('mod-cta'); return this; }
    setTooltip(text: string): this { this.element.setAttribute('aria-label', text); return this; }
    setDisabled(value: boolean): this { this.element.setAttribute('aria-disabled', String(value)); return this; }
    onClick(run: () => void): this { this.element.addEventListener('click', run); return this; }
}

export class Setting {
    settingEl: FakeElement;
    infoEl: FakeElement;
    controlEl: FakeElement;
    nameEl: FakeElement;
    descEl: FakeElement;

    constructor(containerEl: FakeElement) {
        this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
        this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
        this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
        this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
        this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
    }

    setName(name: string): this { this.nameEl.setText(name); return this; }
    setDesc(desc: string): this { this.descEl.setText(desc); return this; }
    setHeading(): this { this.settingEl.addClass('setting-item-heading'); return this; }
    setClass(cls: string): this { this.settingEl.addClass(cls); return this; }
    setDisabled(value: boolean): this { this.settingEl.setAttribute('aria-disabled', String(value)); return this; }

    addButton(run: (button: ButtonComponent) => unknown): this {
        const element = this.controlEl.createEl('button');
        run(new ButtonComponent(element));
        return this;
    }

    addToggle(run: (toggle: ToggleComponent) => unknown): this {
        const element = this.controlEl.createEl('input', { type: 'checkbox' });
        run(new ToggleComponent(element));
        return this;
    }

    addDropdown(run: (dropdown: DropdownComponent) => unknown): this {
        const element = this.controlEl.createEl('select');
        run(new DropdownComponent(element));
        return this;
    }

    addSlider(run: (slider: SliderComponent) => unknown): this {
        const element = this.controlEl.createEl('input', { type: 'range' });
        run(new SliderComponent(element));
        return this;
    }

    addText(run: (text: TextComponent) => unknown): this {
        const element = this.controlEl.createEl('input', { type: 'text' });
        run(new TextComponent(element));
        return this;
    }
}

export class ToggleComponent {
    constructor(private element: FakeElement) {}
    getValue(): boolean { return this.element.getAttribute('value') === 'true'; }
    setValue(value: boolean): this { this.element.setAttribute('value', String(value)); return this; }
    onChange(run: (value: boolean) => void): this {
        this.element.addEventListener('change', () => run(true));
        return this;
    }
    setTooltip(text: string): this { this.element.setAttribute('aria-label', text); return this; }
}

export class DropdownComponent {
    constructor(private element: FakeElement) {}
    getValue(): string { return this.element.getAttribute('value') ?? ''; }
    setValue(value: string): this { this.element.setAttribute('value', value); return this; }
    addOption(value: string, label: string): this {
        const option = this.element.createEl('option', { attr: { value } });
        option.setText(label);
        return this;
    }
    onChange(run: (value: string) => void): this {
        this.element.addEventListener('change', () => run(this.getValue()));
        return this;
    }
    setDisabled(value: boolean): this { this.element.setAttribute('aria-disabled', String(value)); return this; }
}

export class SliderComponent {
    constructor(private element: FakeElement) {}
    getValue(): number { return Number(this.element.getAttribute('value') ?? '0'); }
    setValue(value: number): this { this.element.setAttribute('value', String(value)); return this; }
    setLimits(min: number, max: number, step: number): this {
        this.element.setAttribute('min', String(min));
        this.element.setAttribute('max', String(max));
        this.element.setAttribute('step', String(step));
        return this;
    }
    setDynamicTooltip(): this { return this; }
    onChange(run: (value: number) => void): this {
        this.element.addEventListener('change', () => run(this.getValue()));
        return this;
    }
}

export class TextComponent {
    constructor(private element: FakeElement) {}
    getValue(): string { return this.element.getAttribute('value') ?? ''; }
    setValue(value: string): this { this.element.setAttribute('value', value); return this; }
    setPlaceholder(value: string): this { this.element.setAttribute('placeholder', value); return this; }
    onChange(run: (value: string) => void): this {
        this.element.addEventListener('change', () => run(this.getValue()));
        return this;
    }
}

export class PluginSettingTab {
    app: FakeApp;
    plugin: Plugin;
    containerEl: FakeElement;
    settingEl: FakeElement;

    constructor(app: FakeApp, plugin: Plugin) {
        this.app = app;
        this.plugin = plugin;
        this.containerEl = document.createDiv({ cls: 'vertical-tab-content' });
        this.settingEl = this.containerEl.createDiv();
    }

    display(): void { /* переопределяется */ }
    update(): void { /* переопределяется */ }
    hide(): void { /* переопределяется */ }

    /** Служебное для проверок: строки настроек, которые построил плагин. */
    get rows(): FakeElement[] {
        return this.containerEl.all().filter((element) => element.classes.has('setting-item'));
    }
}

export class Menu {
    items: string[] = [];
    addItem(run: (item: { setTitle: (t: string) => unknown; onClick: (r: () => void) => unknown }) => unknown): this {
        const item = {
            setTitle: (title: string) => { this.items.push(title); return item; },
            setIcon: () => item,
            onClick: () => item,
        };
        run(item);
        return this;
    }
    showAtMouseEvent(): void { /* нечего проверять */ }
}

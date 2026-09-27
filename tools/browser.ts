/*
 * Браузерные имена для инструментов.
 *
 * Плагин в Obsidian видит `document`, `window`, `HTMLElement` и помощники создания
 * элементов как глобальные. В Node их нет, а подменять глобальный объект нельзя:
 * проверка сообщества запрещает `globalThis`. Поэтому те же объекты подставляет
 * сборка — `inject` в `esbuild.config.mjs` заменяет свободные имена на эти
 * экспорты, и код плагина работает без правок.
 */

export {
    createDiv,
    createEl,
    createSpan,
    document,
    fakeWindow as window,
    getComputedStyle,
} from './obsidian-stub';

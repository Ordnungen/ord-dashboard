// ---------------------------------------------------------------------------
// Инструменты работают на машине разработчика под Node, а не в Obsidian, поэтому
// модули Node берутся динамическим импортом — и каждая загрузка начинается с
// проверки платформы. Так это требует проверка сообщества: динамический импорт
// внутри функции, которая первым делом отказывается работать вне Node.
//   npm run cases | npm run analyze | npm run dry-run
// ---------------------------------------------------------------------------

import { Platform } from 'obsidian';

/**
 * Загружает модуль Node только там, где он есть. В Obsidian (в том числе на
 * мобильном) инструменты не запускаются вовсе — отказываемся сразу и понятно.
 */
async function loadFileSystem(): Promise<typeof import('node:fs')> {
    if (!Platform.isDesktop) {
        throw new Error('инструменты запускаются на машине разработчика под Node, а не в Obsidian');
    }
    return import('node:fs');
}

async function loadPath(): Promise<typeof import('node:path')> {
    if (!Platform.isDesktop) {
        throw new Error('инструменты запускаются на машине разработчика под Node, а не в Obsidian');
    }
    return import('node:path');
}

export const fs = await loadFileSystem();
export const path = await loadPath();

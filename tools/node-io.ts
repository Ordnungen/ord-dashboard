// ---------------------------------------------------------------------------
// Инструменты работают на машине разработчика под Node, а не в Obsidian, поэтому
// модули Node берутся динамическим импортом под проверкой платформы — ровно так,
// как советует проверка сообщества. В сборку плагина этот файл не попадает:
//   npm run cases | npm run analyze | npm run dry-run
// ---------------------------------------------------------------------------

import { Platform } from 'obsidian';

if (!Platform.isDesktop) {
    throw new Error('инструменты запускаются на машине разработчика под Node, а не в Obsidian');
}

export const fs: typeof import('node:fs') = await import('node:fs');
export const path: typeof import('node:path') = await import('node:path');

/*
 * Вывод инструментов: отчёт идёт в поток, а не через console — так его видно
 * и в конвейере, и при перенаправлении в файл.
 */

/** Строка в отчёт. */
export function say(text: string): void {
    process.stdout.write(`${text}\n`);
}

/** Строка об ошибке. */
export function sayErr(text: string): void {
    process.stderr.write(`${text}\n`);
}

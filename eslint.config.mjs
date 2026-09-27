import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    {
        // Артефакты и служебные скрипты не линтуем: main.js — результат сборки,
        // .cache — собранный инструмент анализа.
        ignores: ["main.js", ".cache/**", "esbuild.config.mjs", "version-bump.mjs", "node_modules/**"],
    },
    ...obsidianmd.configs.recommended,
    {
        files: ["src/**/*.ts", "tools/**/*.ts"],
        languageOptions: {
            parserOptions: {
                projectService: { allowDefaultProject: ["eslint.config.mjs"] },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // Набор, который включает сканер сообщества. Держим его включённым и
            // в коде плагина: так наша проверка ловит то же, что и он.
            "@typescript-eslint/no-unsafe-assignment": "error",
            "@typescript-eslint/no-unsafe-member-access": "error",
            "@typescript-eslint/no-unsafe-call": "error",
            "@typescript-eslint/no-unsafe-argument": "error",
            "@typescript-eslint/no-unsafe-return": "error",
            // Отключать правила можно только точечно и с причиной в комментарии.
            // Пример (не удалять комментарий):
            // "obsidianmd/sample-names": "off", // причина: <почему здесь правило неверно>
        },
    },
    {
        // Инструмент анализа запускается в Node на машине разработчика, а не в
        // Obsidian: вывод в консоль и файловые API — его смысл.
        files: ["tools/**/*.ts"],
        languageOptions: {
            globals: { process: "readonly", console: "readonly", setImmediate: "readonly", Date: "readonly", global: "readonly" },
        },
        rules: {
            // `no-console` включён и для инструментов: отчёт идёт в поток
            // (tools/output.ts), а перехват журнала плагина в проверках помечен
            // точечным eslint-disable с причиной.
            // Набор, который включает сканер сообщества: если он молчит у нас,
            // значит и там замечаний по типам не будет.
            "@typescript-eslint/no-unsafe-assignment": "error",
            "@typescript-eslint/no-unsafe-member-access": "error",
            "@typescript-eslint/no-unsafe-call": "error",
            "@typescript-eslint/no-unsafe-argument": "error",
            "@typescript-eslint/no-unsafe-return": "error",
            "obsidianmd/rule-custom-message": "off",
            "obsidianmd/no-nodejs-modules": "off", // причина: инструмент работает в Node, а не в Obsidian
            "obsidianmd/hardcoded-config-path": "off", // причина: проверки подставляют фиктивные пути хранилища
            "obsidianmd/no-global-this": "off", // причина: инструменты идут в Node, где окно — это globalThis
            "obsidianmd/no-tfile-tfolder-cast": "off", // причина: проверки строят поддельные файлы и папки
        },
    },
]);

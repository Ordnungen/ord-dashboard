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
            globals: { process: "readonly", console: "readonly", setImmediate: "readonly", Date: "readonly" },
        },
        rules: {
            // `no-console` включён и для инструментов: отчёт идёт в поток
            // (tools/output.ts), а перехват журнала плагина в проверках помечен
            // точечным eslint-disable с причиной.
            "obsidianmd/rule-custom-message": "off",
            "obsidianmd/no-nodejs-modules": "off", // причина: инструмент работает в Node, а не в Obsidian
            "obsidianmd/hardcoded-config-path": "off", // причина: проверки подставляют фиктивные пути хранилища
            "obsidianmd/no-global-this": "off", // причина: в Node окно доступно только как globalThis
            "obsidianmd/no-tfile-tfolder-cast": "off", // причина: проверки строят поддельные файлы и папки
        },
    },
]);

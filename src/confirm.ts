import { App, Modal, Setting } from 'obsidian';

export interface ConfirmOptions {
    title: string;
    body: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void | Promise<void>;
}

/**
 * Native confirmation dialog. Native `confirm()` looks and behaves out of place
 * on Obsidian (and cannot be translated), so destructive actions go through a
 * Modal with an explicit, warning-styled confirm button.
 */
export class ConfirmModal extends Modal {
    private options: ConfirmOptions;

    constructor(app: App, options: ConfirmOptions) {
        super(app);
        this.options = options;
    }

    onOpen(): void {
        this.setTitle(this.options.title);
        this.contentEl.createEl('p', { text: this.options.body, cls: 'ord-dashboard-confirm-body' });

        new Setting(this.contentEl)
            .addButton((button) => button
                .setButtonText(this.options.cancelText)
                .onClick(() => this.close()))
            .addButton((button) => button
                .setButtonText(this.options.confirmText)
                .setDestructive()
                .onClick(() => {
                    this.close();
                    void this.options.onConfirm();
                }));
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

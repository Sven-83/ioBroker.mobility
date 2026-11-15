/*
 * Receipts sent to the Telegram bot (owner's idea 2026-11-15: forward the Electroverse PDF to the bot).
 *
 * The telegram adapter (option "save files") stores a received document under
 * <data dir>/telegram_0/document/<file name> and writes that path to telegram.0.communicate.pathFile.
 * It stores files of ANY sender, so here only files of users the telegram instance knows
 * (communicate.users = logged in with the bot password) are read. Files that are no PDF, or a PDF
 * that is no Electroverse receipt, are left alone without an answer (the bot may be used for other
 * things). A receipt that was taken over (or was already known) is deleted, it contains the e-mail
 * address and the address of the charger.
 */

import { pdfText } from './pdf-text';
import { parseReceipt, type AwayReceipt } from './receipt';
import { describeReceipt } from './away-service';

/** What the intake needs from the adapter */
export interface IntakeDeps {
    /** Telegram user ID of the last request (communicate.requestUserId) */
    senderId(): Promise<string | undefined>;
    /** Chat ID of the last request (communicate.requestChatId) */
    chatId(): Promise<string | number | undefined>;
    /** User IDs the telegram instance knows (communicate.users) */
    knownUsers(): Promise<Set<string>>;
    /** Reads the stored file; throws if it is missing, outside the telegram folder or too large */
    readFile(path: string): Promise<Buffer>;
    /** Deletes the stored file */
    deleteFile(path: string): Promise<void>;
    /** Answers in the chat */
    reply(chatId: string | number | undefined, text: string): Promise<void>;
    /** Takes over a receipt */
    add(receipt: AwayReceipt): Promise<'added' | 'duplicate'>;
    /** Log on level info */
    info(message: string): void;
    /** Log on level warn */
    warn(message: string): void;
}

/** What happened to a file (for tests and the log) */
export type IntakeResult = 'ignored' | 'unknownSender' | 'foreign' | 'broken' | 'added' | 'duplicate' | 'error';

/**
 * Users from telegram.0.communicate.users ({"<id>": {firstName, userName}}).
 *
 * @param value - State value
 */
export function parseUsers(value: unknown): Set<string> {
    try {
        const data: unknown = typeof value === 'string' && value ? JSON.parse(value) : {};
        return new Set(data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : []);
    } catch {
        return new Set();
    }
}

/** Handles the files the telegram adapter saved */
export class ReceiptIntake {
    /** one file after the other */
    private chain: Promise<void> = Promise.resolve();

    /**
     * @param deps - Adapter functions
     * @param german - German answers
     */
    public constructor(
        private readonly deps: IntakeDeps,
        private readonly german: boolean,
    ) {}

    /**
     * The telegram adapter has saved a file.
     *
     * @param path - Value of communicate.pathFile
     */
    public handle(path: string): Promise<IntakeResult> {
        const run = this.chain.then(() => this.process(path));
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async process(path: string): Promise<IntakeResult> {
        const g = this.german;
        if (!/\.pdf$/i.test(path)) {
            return 'ignored';
        }
        const sender = await this.deps.senderId();
        if (!sender || !(await this.deps.knownUsers()).has(sender)) {
            this.deps.warn('Charging on the road: PDF from a Telegram user the bot does not know - ignored');
            return 'unknownSender';
        }
        const chat = await this.deps.chatId();
        let result: ReturnType<typeof parseReceipt>;
        try {
            result = parseReceipt(pdfText(await this.deps.readFile(path)));
        } catch (error) {
            this.deps.warn(`Charging on the road: PDF not readable (${(error as Error).message})`);
            return 'error';
        }
        if (!result.ok) {
            if (result.kind === 'foreign') {
                return 'foreign';
            }
            this.deps.warn(`Charging on the road: receipt not understood (${result.reason})`);
            await this.answer(
                chat,
                g
                    ? `❓ Electroverse-Beleg erkannt, aber nicht vollständig lesbar (${result.reason}). Nichts übernommen.`
                    : `❓ Electroverse receipt found, but not fully readable (${result.reason}). Nothing taken over.`,
            );
            return 'broken';
        }
        const text = describeReceipt(result.receipt, g);
        const outcome = await this.deps.add(result.receipt);
        await this.deps
            .deleteFile(path)
            .catch(error =>
                this.deps.warn(`Charging on the road: stored PDF not deleted (${(error as Error).message})`),
            );
        if (outcome === 'duplicate') {
            await this.answer(chat, g ? `🧾 Beleg war schon da: ${text}` : `🧾 Receipt already known: ${text}`);
            return 'duplicate';
        }
        const discount =
            result.receipt.discount > 0
                ? g
                    ? ` (${result.receipt.discount.toLocaleString('de-DE', { minimumFractionDigits: 2 })} € Rabatt)`
                    : ` (${result.receipt.discount.toFixed(2)} € discount)`
                : '';
        this.deps.info(`Charging on the road: receipt taken over: ${text}`);
        await this.answer(
            chat,
            g ? `🧾 Beleg übernommen: ${text}${discount}` : `🧾 Receipt taken over: ${text}${discount}`,
        );
        return 'added';
    }

    private async answer(chat: string | number | undefined, text: string): Promise<void> {
        try {
            await this.deps.reply(chat, text);
        } catch (error) {
            this.deps.warn(`Charging on the road: answer not sent (${(error as Error).message})`);
        }
    }
}

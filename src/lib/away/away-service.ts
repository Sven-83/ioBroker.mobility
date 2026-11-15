/*
 * Charging on the road: receipts the owner sends to the Telegram bot (see receipt-intake.ts).
 *
 * Object tree:
 * away                         device   Charging on the road (receipts)
 * ├─ lastReceipt               text     last receipt taken over, e.g. "31.10.2026 14:03 · IONITY · 27,02 kWh · 11,03 €"
 * └─ history                   channel  same states as easee.history: days / weeks / months (JSON),
 *                                       monthEnergy / yearEnergy, monthCost / yearCost (amount paid),
 *                                       lastSession (JSON), oldestSession, sessionCount
 *
 * The receipts are kept in the instance file away-receipts.json (no e-mail, address or charge point).
 * Periods roll over at midnight, so the evaluation is written again every hour.
 */

import type { Logger, TimerHandle } from '../fuel/fuel-service';
import type { ObjectDefinition } from '../fuel/objects';
import { historyObjects } from '../easee/objects';
import { DAYS, MONTHS, WEEKS } from '../easee/sessions-sync';
import { SessionReport, type ChargeSession, type SessionSummary } from '../easee/sessions';
import { dayKey, weekKey } from '../util/periods';
import type { AwayReceipt } from './receipt';

export const AWAY_ROOT = 'away';
const REFRESH_MS = 3_600_000;

/** What the service needs from the adapter */
export interface AwayDeps {
    /** Adapter log */
    log: Logger;
    /** Current time (epoch ms) */
    now(): number;
    /** Adapter timer */
    setTimeout(callback: () => void, ms: number): TimerHandle;
    /** Stops an adapter timer */
    clearTimeout(handle: TimerHandle): void;
    /** Creates or updates objects */
    ensureObjects(definitions: ObjectDefinition[]): Promise<void>;
    /** Writes a state with ack */
    setState(id: string, value: ioBroker.StateValue): Promise<void>;
    /** Content of the receipt file, undefined if there is none */
    load(): Promise<string | undefined>;
    /** Writes the receipt file */
    save(text: string): Promise<void>;
}

/** Objects of the part */
export function awayObjects(): ObjectDefinition[] {
    return [
        {
            id: AWAY_ROOT,
            obj: {
                type: 'device',
                common: { name: { en: 'Charging on the road', de: 'Laden unterwegs' } },
                native: {},
            },
        },
        {
            id: `${AWAY_ROOT}.lastReceipt`,
            obj: {
                type: 'state',
                common: {
                    name: { en: 'Last receipt taken over', de: 'Zuletzt übernommener Beleg' },
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                },
                native: {},
            },
        },
        // easee.history has the same states; lastSync only exists per charger
        ...historyObjects(AWAY_ROOT, true).filter(d => !d.id.endsWith('.lastSync')),
    ];
}

/**
 * Reads the receipt file; broken entries are dropped.
 *
 * @param text - File content
 */
export function parseStore(text: string | undefined): AwayReceipt[] {
    try {
        const data: unknown = text ? JSON.parse(text) : {};
        const list = (data as { receipts?: unknown })?.receipts;
        if (!Array.isArray(list)) {
            return [];
        }
        return list.filter(
            (r): r is AwayReceipt =>
                !!r &&
                typeof r === 'object' &&
                Number.isSafeInteger((r as AwayReceipt).id) &&
                typeof (r as AwayReceipt).start === 'number' &&
                typeof (r as AwayReceipt).end === 'number' &&
                typeof (r as AwayReceipt).kwh === 'number' &&
                typeof (r as AwayReceipt).paid === 'number',
        );
    } catch {
        return [];
    }
}

/**
 * A receipt as charging session for the evaluation (cost = amount paid).
 *
 * @param r - Receipt
 */
function asSession(r: AwayReceipt): ChargeSession {
    return {
        id: r.id,
        start: r.start,
        end: r.end,
        kwh: r.kwh,
        seconds: Math.round((r.end - r.start) / 1000),
        easeeCost: r.paid,
        complete: true,
    };
}

/**
 * Adds subscription costs to the periods they start in (subscriptions are no charging sessions).
 *
 * @param list - Sums of the charging sessions
 * @param subscriptions - Subscription invoices
 * @param key - Period key of a time
 */
function withSubscriptions(
    list: SessionSummary[],
    subscriptions: AwayReceipt[],
    key: (t: number) => string,
): SessionSummary[] {
    return list.map(p => {
        const extra = subscriptions.filter(s => key(s.start) === p.period).reduce((a, s) => a + s.paid, 0);
        return extra ? { ...p, cost: Math.round(((p.cost ?? 0) + extra) * 100) / 100 } : p;
    });
}

/**
 * Same key the session report uses for a period list ("2026-11-14", "2026-W46", "2026-11", "2026").
 *
 * @param period - Example key
 */
function keyOf(period: string): (t: number) => string {
    if (/^\d{4}-W\d{2}$/.test(period)) {
        return t => weekKey(dayKey(t));
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
        return dayKey;
    }
    if (/^\d{4}-\d{2}$/.test(period)) {
        return t => dayKey(t).slice(0, 7);
    }
    return t => dayKey(t).slice(0, 4);
}

/**
 * Short text of a receipt.
 *
 * @param r - Receipt
 * @param german - German style
 */
export function describeReceipt(r: AwayReceipt, german: boolean): string {
    const locale = german ? 'de-DE' : 'en-GB';
    const d = new Date(r.start);
    const date = d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const num = (v: number): string => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (r.kind === 'subscription') {
        const until = new Date(r.end).toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });
        return [german ? `Abo ${date}–${until}` : `subscription ${date}–${until}`, r.provider, `${num(r.paid)} €`]
            .filter(Boolean)
            .join(' · ');
    }
    if (r.kind === 'manual') {
        return `${date} · ${num(r.kwh)} kWh · ${num(r.paid)} € (${german ? 'manuell' : 'typed'})`;
    }
    return [`${date} ${time}`, r.provider, `${num(r.kwh)} kWh`, `${num(r.paid)} €`].filter(Boolean).join(' · ');
}

/** Receipts of charging on the road and their evaluation */
export class AwayService {
    private receipts: AwayReceipt[] = [];
    /** Pending update (wrapped: TimerHandle is unknown) */
    private timer: { handle: TimerHandle } | undefined;
    private stopped = false;
    /** writes one after the other */
    private chain: Promise<void> = Promise.resolve();

    /**
     * @param deps - Adapter functions
     * @param german - German texts
     */
    public constructor(
        private readonly deps: AwayDeps,
        private readonly german: boolean,
    ) {}

    /** Creates the objects, reads the file and writes the evaluation */
    public async start(): Promise<void> {
        await this.deps.ensureObjects(awayObjects());
        this.receipts = parseStore(await this.deps.load().catch(() => undefined));
        await this.writeReport();
        this.schedule();
    }

    /** Stops the hourly update */
    public stop(): void {
        this.stopped = true;
        if (this.timer !== undefined) {
            this.deps.clearTimeout(this.timer.handle);
            this.timer = undefined;
        }
    }

    /** Number of stored receipts (sessions and subscriptions) */
    public get count(): number {
        return this.receipts.length;
    }

    /**
     * Takes over a receipt.
     *
     * @param receipt - Receipt read from a PDF
     * @returns added, or duplicate if the receipt number is already known
     */
    public add(receipt: AwayReceipt): Promise<'added' | 'duplicate'> {
        const run = this.chain.then(async (): Promise<'added' | 'duplicate'> => {
            if (this.receipts.some(r => r.id === receipt.id && r.kind === receipt.kind)) {
                return 'duplicate';
            }
            const next = [...this.receipts, receipt].sort((a, b) => a.start - b.start);
            await this.deps.save(JSON.stringify({ version: 1, receipts: next }));
            this.receipts = next;
            await this.writeReport();
            await this.deps.setState(`${AWAY_ROOT}.lastReceipt`, describeReceipt(receipt, this.german));
            return 'added';
        });
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /**
     * Removes the newest typed entry ("Laden löschen").
     *
     * @returns The removed entry, null if there is none
     */
    public removeLastManual(): Promise<AwayReceipt | null> {
        const run = this.chain.then(async (): Promise<AwayReceipt | null> => {
            const manual = this.receipts.filter(r => r.kind === 'manual');
            if (manual.length === 0) {
                return null;
            }
            const last = manual.reduce((a, b) => (b.id > a.id ? b : a));
            const next = this.receipts.filter(r => r !== last);
            await this.deps.save(JSON.stringify({ version: 1, receipts: next }));
            this.receipts = next;
            await this.writeReport();
            return last;
        });
        this.chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private schedule(): void {
        if (this.stopped) {
            return;
        }
        const handle = this.deps.setTimeout(() => {
            this.timer = undefined;
            this.chain = this.chain
                .then(() => this.writeReport())
                .catch(error => this.deps.log.warn(`Charging on the road: ${(error as Error).message}`));
            this.schedule();
        }, REFRESH_MS);
        this.timer = { handle };
    }

    private async writeReport(): Promise<void> {
        const now = this.deps.now();
        const sessions = this.receipts.filter(r => r.kind !== 'subscription');
        const subscriptions = this.receipts.filter(r => r.kind === 'subscription');
        const report = new SessionReport(sessions.map(asSession), 0);
        const add = (list: SessionSummary[]): SessionSummary[] =>
            list.length ? withSubscriptions(list, subscriptions, keyOf(list[0].period)) : list;
        const p = `${AWAY_ROOT}.history`;
        const months = add(report.months(now, MONTHS));
        const month = months[months.length - 1];
        const [year] = add([report.year(new Date(now).getFullYear())]);
        await this.deps.setState(`${p}.days`, JSON.stringify(add(report.days(now, DAYS))));
        await this.deps.setState(`${p}.weeks`, JSON.stringify(add(report.weeks(now, WEEKS))));
        await this.deps.setState(`${p}.months`, JSON.stringify(months));
        await this.deps.setState(`${p}.monthEnergy`, month.kwh);
        await this.deps.setState(`${p}.yearEnergy`, year.kwh);
        await this.deps.setState(`${p}.monthCost`, month.cost ?? 0);
        await this.deps.setState(`${p}.yearCost`, year.cost ?? 0);
        const last = report.last();
        await this.deps.setState(`${p}.lastSession`, last ? JSON.stringify(last) : null);
        await this.deps.setState(`${p}.oldestSession`, report.oldest());
        await this.deps.setState(`${p}.sessionCount`, sessions.length);
    }
}

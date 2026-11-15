import { expect } from 'chai';
import { ReceiptIntake, parseUsers, type IntakeDeps } from './receipt-intake';
import type { AwayReceipt } from './receipt';

/**
 * Minimal PDF whose text pieces are the given lines (Helvetica, uncompressed).
 *
 * @param lines - Text lines
 */
function pdf(lines: string[]): Buffer {
    // WinAnsi: the euro sign is code 0x80
    const content = `BT /F1 9 Tf ${lines.map(l => `(${l.replace(/€/g, '\\200')}) Tj`).join(' ')} ET`;
    return Buffer.from(
        [
            '%PDF-1.4',
            '1 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
            `2 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
            '3 0 obj\n<< /Type /Page /Resources << /Font << /F1 1 0 R >> >> /Contents 2 0 R >>\nendobj',
        ].join('\n'),
        'latin1',
    );
}

const RECEIPT = [
    'Octopus Electroverse Ltd',
    'Beleg',
    '1000002',
    'Anbieter',
    'Netz B',
    'Start des Ladevorgangs',
    '31st Okt. 2026 13:16:37',
    'Ende des Ladevorgangs',
    '31st Okt. 2026 13:25:57',
    '13:16 31/10/26',
    '13:25 31/10/26',
    'Verbrauch [kWh]',
    '0,78 €',
    '14,09',
    '9,24 €',
    '1,75 €',
    '10,99 €',
    'Zu zahlender Betrag',
    '10,99 €',
];

/**
 * Intake with fake adapter functions.
 *
 * @param files - Stored files by path
 * @param sender - Telegram user of the last request
 */
function setup(
    files: Record<string, Buffer>,
    sender = '111',
): {
    intake: ReceiptIntake;
    replies: string[];
    deleted: string[];
    added: AwayReceipt[];
    warnings: string[];
} {
    const replies: string[] = [];
    const deleted: string[] = [];
    const added: AwayReceipt[] = [];
    const warnings: string[] = [];
    const deps: IntakeDeps = {
        senderId: () => Promise.resolve(sender),
        chatId: () => Promise.resolve(42),
        knownUsers: () => Promise.resolve(parseUsers('{"111":{"firstName":"A"}}')),
        readFile: path => (files[path] ? Promise.resolve(files[path]) : Promise.reject(new Error('missing'))),
        deleteFile: path => {
            deleted.push(path);
            return Promise.resolve();
        },
        reply: (chat, text) => {
            replies.push(`${String(chat)}: ${text}`);
            return Promise.resolve();
        },
        add: r => {
            const known = added.some(a => a.id === r.id);
            if (!known) {
                added.push(r);
            }
            return Promise.resolve(known ? 'duplicate' : 'added');
        },
        info: () => undefined,
        warn: message => warnings.push(message),
    };
    return { intake: new ReceiptIntake(deps, true), replies, deleted, added, warnings };
}

describe('away/receipt-intake', () => {
    it('reads the known users of the telegram instance', () => {
        expect([...parseUsers('{"111":{},"222":{}}')]).to.deep.equal(['111', '222']);
        expect(parseUsers('broken').size).to.equal(0);
        expect(parseUsers(null).size).to.equal(0);
    });

    it('takes over a receipt, answers in the chat and deletes the PDF', async () => {
        const t = setup({ '/d/document/a.pdf': pdf(RECEIPT) });
        expect(await t.intake.handle('/d/document/a.pdf')).to.equal('added');
        expect(t.added.map(r => [r.id, r.kwh, r.paid])).to.deep.equal([[1000002, 14.09, 10.99]]);
        expect(t.replies).to.deep.equal(['42: 🧾 Beleg übernommen: 31.10.2026 13:16 · Netz B · 14,09 kWh · 10,99 €']);
        expect(t.deleted).to.deep.equal(['/d/document/a.pdf']);
    });

    it('says when a receipt was already known', async () => {
        const t = setup({ '/d/document/a.pdf': pdf(RECEIPT), '/d/document/b.pdf': pdf(RECEIPT) });
        await t.intake.handle('/d/document/a.pdf');
        expect(await t.intake.handle('/d/document/b.pdf')).to.equal('duplicate');
        expect(t.replies[1]).to.match(/^42: 🧾 Beleg war schon da: 31\.10\.2026 13:16/);
        expect(t.deleted).to.have.length(2);
    });

    it('ignores files of unknown senders without reading them', async () => {
        const t = setup({ '/d/document/a.pdf': pdf(RECEIPT) }, '999');
        expect(await t.intake.handle('/d/document/a.pdf')).to.equal('unknownSender');
        expect(t.added).to.have.length(0);
        expect(t.replies).to.have.length(0);
        expect(t.deleted).to.have.length(0);
        expect(t.warnings[0]).to.contain('does not know');
    });

    it('leaves other files alone without an answer', async () => {
        const t = setup({ '/d/document/x.pdf': pdf(['Rechnung', 'Betrag', '5,00 €']) });
        expect(await t.intake.handle('/d/photo/p.jpg')).to.equal('ignored');
        expect(await t.intake.handle('/d/document/x.pdf')).to.equal('foreign');
        expect(t.replies).to.have.length(0);
        expect(t.deleted).to.have.length(0);
    });

    it('answers when a receipt is not complete and keeps the file', async () => {
        const broken = RECEIPT.filter(p => p !== 'Zu zahlender Betrag');
        const t = setup({ '/d/document/a.pdf': pdf(broken) });
        expect(await t.intake.handle('/d/document/a.pdf')).to.equal('broken');
        expect(t.replies[0]).to.contain('nicht vollständig lesbar (amount missing)');
        expect(t.deleted).to.have.length(0);
    });

    it('reports a file it cannot read', async () => {
        const t = setup({});
        expect(await t.intake.handle('/d/document/gone.pdf')).to.equal('error');
        expect(t.warnings[0]).to.contain('not readable');
    });

    it('takes over a subscription invoice', async () => {
        const t = setup({
            '/d/document/s.pdf': pdf([
                'Octopus Electroverse Ltd',
                'Ladeanbieter Abonnement-Rechnung',
                'Anbieter',
                'Netz A',
                'Beleg',
                '200001',
                'Beginn des Abonnementzeitraums',
                '31st Okt. 2026',
                'Ende des Abonnementzeitraums',
                '29th Nov. 2026',
                'Gesamt (inkl. MwSt.)',
                '11,99 €',
            ]),
        });
        expect(await t.intake.handle('/d/document/s.pdf')).to.equal('added');
        expect(t.replies).to.deep.equal([
            '42: 🧾 Abo-Rechnung übernommen: Abo 31.10.2026–29.11.2026 · Netz A · 11,99 €',
        ]);
        expect(t.deleted).to.deep.equal(['/d/document/s.pdf']);
    });

    it('answers for Electroverse PDFs of an unknown kind and keeps them', async () => {
        const t = setup({ '/d/document/o.pdf': pdf(['Octopus Electroverse Ltd', 'Gutschrift']) });
        expect(await t.intake.handle('/d/document/o.pdf')).to.equal('foreign');
        expect(t.replies[0]).to.contain('weder Ladebeleg noch Abo-Rechnung');
        expect(t.deleted).to.have.length(0);
    });
});

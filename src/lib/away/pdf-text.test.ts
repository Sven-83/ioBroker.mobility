import { expect } from 'chai';
import { deflateSync } from 'node:zlib';
import { MAX_PDF_BYTES, ascii85, parseCMap, pdfText } from './pdf-text';

/**
 * ASCII85 encoder for the tests (Adobe variant with <~ ~>).
 *
 * @param data - Bytes
 */
function toAscii85(data: Buffer): string {
    let out = '';
    for (let i = 0; i < data.length; i += 4) {
        const chunk = data.subarray(i, i + 4);
        const padded = Buffer.concat([chunk, Buffer.alloc(4 - chunk.length)]);
        let v = padded.readUInt32BE(0);
        if (v === 0 && chunk.length === 4) {
            out += 'z';
            continue;
        }
        const chars: string[] = [];
        for (let j = 0; j < 5; j++) {
            chars.unshift(String.fromCharCode((v % 85) + 33));
            v = Math.floor(v / 85);
        }
        out += chars.slice(0, chunk.length + 1).join('');
    }
    return `<~${out}~>`;
}

/**
 * Builds a small PDF like the receipts: a subset font with ToUnicode (codes 1..n) and Helvetica,
 * content stream compressed and ASCII85 encoded.
 *
 * @param lines - Text lines; even lines with the subset font as hex, odd lines with Helvetica as literal
 */
function buildPdf(lines: string[]): Buffer {
    const chars = [...new Set(lines.filter((_, i) => i % 2 === 0).join(''))];
    const code = new Map(chars.map((c, i) => [c, i + 1]));
    const hex = (n: number): string => n.toString(16).padStart(2, '0');
    const utf16 = (c: string): string => Buffer.from(c, 'utf16le').swap16().toString('hex');
    const cmap = [
        '/CIDInit /ProcSet findresource begin',
        'begincmap',
        `${chars.length} beginbfchar`,
        ...chars.map(c => `<${hex(code.get(c) as number)}> <${utf16(c)}>`),
        'endbfchar',
        'endcmap',
    ].join('\n');
    const content = [
        'BT',
        ...lines.map((line, i) =>
            i % 2 === 0
                ? `/F2+0 9 Tf 1 0 0 1 50 ${700 - i * 12} Tm <${[...line].map(c => hex(code.get(c) as number)).join('')}> Tj`
                : `/F1 9 Tf 1 0 0 1 50 ${700 - i * 12} Tm (${line.replace(/([()\\])/g, '\\$1')}) Tj`,
        ),
        'ET',
    ].join('\n');
    const body = toAscii85(deflateSync(Buffer.from(content, 'latin1')));
    const objects = [
        '1 0 obj\n<< /F2+0 2 0 R /F1 4 0 R >>\nendobj',
        '2 0 obj\n<< /ToUnicode 3 0 R /Type /Font /Subtype /TrueType /BaseFont /AAAAAA+Test >>\nendobj',
        `3 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj`,
        '4 0 obj\n<< /Type /Font /Subtype /Type1 /Name /F1 /Encoding /WinAnsiEncoding /BaseFont /Helvetica >>\nendobj',
        '5 0 obj\n<< /Type /Page /Parent 6 0 R /Resources << /Font 1 0 R >> /Contents 7 0 R >>\nendobj',
        '6 0 obj\n<< /Type /Pages /Kids [ 5 0 R ] /Count 1 >>\nendobj',
        `7 0 obj\n<< /Length ${body.length} /Filter [ /ASCII85Decode /FlateDecode ] >>\nstream\n${body}\nendstream\nendobj`,
    ];
    return Buffer.from(`%PDF-1.4\n${objects.join('\n')}\ntrailer\n<< /Root 6 0 R >>\n%%EOF\n`, 'latin1');
}

describe('away/pdf-text', () => {
    it('decodes ASCII85 including the z shortcut and a short last group', () => {
        for (const text of ['Hello world', 'abcd', 'x', '']) {
            expect(ascii85(toAscii85(Buffer.from(text))).toString()).to.equal(text);
        }
        expect([...ascii85(toAscii85(Buffer.from([0, 0, 0, 0, 1, 2])))]).to.deep.equal([0, 0, 0, 0, 1, 2]);
        expect(() => ascii85('<~ab{~>')).to.throw('invalid character');
    });

    it('reads bfchar and bfrange of a ToUnicode map', () => {
        const map = parseCMap(
            '2 beginbfchar\n<01> <0042>\n<02> <00e4>\nendbfchar\n1 beginbfrange\n<10> <12> <0061>\nendbfrange',
        );
        expect([map.get(1), map.get(2), map.get(0x10), map.get(0x12)]).to.deep.equal(['B', 'ä', 'a', 'c']);
    });

    it('returns the text pieces of both font kinds in content order', () => {
        const pdf = buildPdf(['Beleg für den Ladevorgang', 'Zu zahlender Betrag (brutto)', '11,03 €', 'Straße 1\\2']);
        expect(pdfText(pdf)).to.deep.equal([
            'Beleg für den Ladevorgang',
            'Zu zahlender Betrag (brutto)',
            '11,03 €',
            'Straße 1\\2',
        ]);
    });

    it('joins TJ arrays and turns wide gaps into spaces', () => {
        const content = 'BT /F1 9 Tf [(Ver) 10 (brauch) -400 (kWh)] TJ ET';
        const pdf = Buffer.from(
            [
                '%PDF-1.4',
                '1 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
                `2 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj`,
                '3 0 obj\n<< /Type /Page /Resources << /Font << /F1 1 0 R >> >> /Contents 2 0 R >>\nendobj',
            ].join('\n'),
            'latin1',
        );
        expect(pdfText(pdf)).to.deep.equal(['Verbrauch kWh']);
    });

    it('refuses files that are no PDF or too large', () => {
        expect(() => pdfText(Buffer.from('hello'))).to.throw('not a PDF');
        expect(() => pdfText(Buffer.alloc(MAX_PDF_BYTES + 1))).to.throw('too large');
    });

    it('skips streams with unknown filters instead of failing', () => {
        const pdf = Buffer.from(
            [
                '%PDF-1.4',
                '2 0 obj\n<< /Length 3 /Filter /LZWDecode >>\nstream\nabc\nendstream\nendobj',
                '3 0 obj\n<< /Type /Page /Resources << >> /Contents 2 0 R >>\nendobj',
            ].join('\n'),
            'latin1',
        );
        expect(pdfText(pdf)).to.deep.equal([]);
    });
});

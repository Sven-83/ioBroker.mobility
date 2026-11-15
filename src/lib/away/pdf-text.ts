/*
 * Minimal text extraction for simple, generated PDFs (charging receipts).
 *
 * Supports what the receipts use: uncompressed object tables (no object streams), FlateDecode and
 * ASCII85Decode streams, simple fonts with a ToUnicode map (TrueType subsets) or WinAnsi (standard
 * fonts), and the text operators Tj, TJ, ' and ". Anything else is skipped, never executed.
 * The result is the list of text pieces in the order of the content stream - for these receipts a
 * label is directly followed by its value.
 *
 * The files come from outside (Telegram), so all sizes are limited.
 */

import { inflateSync } from 'node:zlib';

/** Largest PDF that is read at all */
export const MAX_PDF_BYTES = 2 * 1024 * 1024;
/** Largest decoded stream */
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
/** Most text pieces returned */
const MAX_PIECES = 5_000;
/** Most pages read */
const MAX_PAGES = 5;

interface PdfObject {
    dict: string;
    stream: Buffer | null | undefined;
}

type Token =
    | { kind: 'str'; bytes: Buffer }
    | { kind: 'num'; value: number }
    | { kind: 'name'; value: string }
    | { kind: 'arr'; items: Token[] }
    | { kind: 'open' }
    | { kind: 'other' };

/**
 * Decodes ASCII85 (Adobe variant, optional <~ ~> frame).
 *
 * @param input - Encoded text
 */
export function ascii85(input: string): Buffer {
    const s = input
        .replace(/\s+/g, '')
        .replace(/^<~/, '')
        .replace(/~>[\s\S]*$/, '');
    const out: number[] = [];
    let tuple: number[] = [];
    const flush = (count: number): void => {
        let v = 0;
        for (const t of tuple) {
            v = v * 85 + t;
        }
        const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
        out.push(...bytes.slice(0, count));
    };
    for (const ch of s) {
        if (ch === 'z' && tuple.length === 0) {
            out.push(0, 0, 0, 0);
            continue;
        }
        const code = ch.charCodeAt(0) - 33;
        if (code < 0 || code > 84) {
            throw new Error('ascii85: invalid character');
        }
        tuple.push(code);
        if (tuple.length === 5) {
            flush(4);
            tuple = [];
        }
        if (out.length > MAX_STREAM_BYTES) {
            throw new Error('ascii85: too large');
        }
    }
    if (tuple.length > 0) {
        const n = tuple.length;
        while (tuple.length < 5) {
            tuple.push(84);
        }
        flush(n - 1);
    }
    return Buffer.from(out);
}

/**
 * Reads all "N G obj ... endobj" of the file.
 *
 * @param s - File content as latin1 text
 */
function readObjects(s: string): Map<number, PdfObject> {
    const objects = new Map<number, PdfObject>();
    for (const m of s.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
        const start = (m.index ?? 0) + m[0].length;
        const end = s.indexOf('endobj', start);
        if (end < 0) {
            continue;
        }
        const body = s.slice(start, end);
        const si = body.search(/\bstream\r?\n/);
        if (si < 0) {
            objects.set(Number(m[1]), { dict: body, stream: undefined });
            continue;
        }
        const dict = body.slice(0, si);
        let d = si + 6;
        if (body[d] === '\r') {
            d++;
        }
        if (body[d] === '\n') {
            d++;
        }
        const e = body.lastIndexOf('endstream');
        objects.set(Number(m[1]), { dict, stream: decodeStream(dict, body.slice(d, e < d ? body.length : e)) });
    }
    return objects;
}

/**
 * Applies the stream filters; null if one is not supported or fails.
 *
 * @param dict - Stream dictionary
 * @param raw - Raw stream (latin1)
 */
function decodeStream(dict: string, raw: string): Buffer | null {
    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? '';
    let data: Buffer = Buffer.from(raw, 'latin1');
    try {
        for (const f of [...filter.matchAll(/\/(\w+)/g)].map(x => x[1])) {
            if (f === 'ASCII85Decode' || f === 'A85') {
                data = ascii85(data.toString('latin1'));
            } else if (f === 'FlateDecode' || f === 'Fl') {
                data = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES });
            } else {
                return null;
            }
        }
    } catch {
        return null;
    }
    return data;
}

/**
 * Object number of "/Key N 0 R".
 *
 * @param text - Dictionary text
 * @param key - Key without slash
 */
function ref(text: string, key: string): number | undefined {
    const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(text);
    return m ? Number(m[1]) : undefined;
}

/**
 * Inner text of the dictionary "/Key << ... >>" (one nesting level is enough here).
 *
 * @param text - Dictionary text
 * @param key - Key without slash
 */
function inlineDict(text: string, key: string): string | undefined {
    const i = text.search(new RegExp(`/${key}\\s*<<`));
    if (i < 0) {
        return undefined;
    }
    let depth = 0;
    for (let j = text.indexOf('<<', i); j < text.length - 1; j++) {
        if (text.startsWith('<<', j)) {
            depth++;
            j++;
        } else if (text.startsWith('>>', j)) {
            depth--;
            if (depth === 0) {
                return text.slice(text.indexOf('<<', i) + 2, j);
            }
            j++;
        }
    }
    return undefined;
}

/**
 * Unicode map of a ToUnicode CMap (bfchar and bfrange).
 *
 * @param text - CMap program
 */
export function parseCMap(text: string): Map<number, string> {
    const map = new Map<number, string>();
    const utf16 = (hex: string): string => {
        const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
        let out = '';
        for (let i = 0; i + 1 < bytes.length; i += 2) {
            out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
        }
        return out;
    };
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
            map.set(parseInt(p[1], 16), utf16(p[2]));
        }
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
            const from = parseInt(p[1], 16);
            const to = Math.min(parseInt(p[2], 16), from + 0xffff);
            let unicode = parseInt(p[3], 16);
            for (let c = from; c <= to; c++) {
                map.set(c, String.fromCodePoint(unicode++));
            }
        }
    }
    return map;
}

/**
 * Splits a content stream into operands and operators.
 *
 * @param content - Content stream (latin1)
 * @param onOperator - Called with each operator and its operands
 */
function tokenize(content: string, onOperator: (op: string, args: Token[]) => void): void {
    let i = 0;
    let stack: Token[] = [];
    const literal = (): Buffer => {
        const out: number[] = [];
        let depth = 1;
        i++;
        while (i < content.length && depth > 0) {
            const c = content[i];
            if (c === '\\') {
                const n = content[i + 1] ?? '';
                const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
                if (n in esc) {
                    out.push(esc[n]);
                    i += 2;
                } else if (/[0-7]/.test(n)) {
                    const oct = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))?.[0] ?? '0';
                    out.push(parseInt(oct, 8) & 255);
                    i += 1 + oct.length;
                } else if (n === '\r' || n === '\n') {
                    i += content[i + 1] === '\r' && content[i + 2] === '\n' ? 3 : 2;
                } else {
                    out.push(n.charCodeAt(0) & 255);
                    i += 2;
                }
                continue;
            }
            if (c === '(') {
                depth++;
            } else if (c === ')') {
                depth--;
                if (depth === 0) {
                    i++;
                    break;
                }
            }
            out.push(c.charCodeAt(0) & 255);
            i++;
        }
        return Buffer.from(out);
    };
    while (i < content.length) {
        const c = content[i];
        if (/\s/.test(c)) {
            i++;
        } else if (c === '%') {
            while (i < content.length && content[i] !== '\n' && content[i] !== '\r') {
                i++;
            }
        } else if (c === '(') {
            stack.push({ kind: 'str', bytes: literal() });
        } else if (c === '<' && content[i + 1] !== '<') {
            const end = content.indexOf('>', i);
            const hex = content.slice(i + 1, end < 0 ? content.length : end).replace(/[^0-9a-fA-F]/g, '');
            stack.push({ kind: 'str', bytes: Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex') });
            i = end < 0 ? content.length : end + 1;
        } else if (c === '<' || c === '>') {
            stack.push({ kind: 'other' });
            i += 2;
        } else if (c === '[') {
            stack.push({ kind: 'open' });
            i++;
        } else if (c === ']') {
            const items: Token[] = [];
            while (stack.length > 0 && stack[stack.length - 1].kind !== 'open') {
                items.unshift(stack.pop() as Token);
            }
            stack.pop();
            stack.push({ kind: 'arr', items });
            i++;
        } else if (c === '{' || c === '}' || c === ')') {
            i++;
        } else if (c === '/') {
            const m = /^\/[^\s/<>[\]()%{}]*/.exec(content.slice(i, i + 128))?.[0] ?? '/';
            stack.push({ kind: 'name', value: m.slice(1) });
            i += m.length;
        } else {
            const m = /^[^\s/<>[\]()%{}]+/.exec(content.slice(i, i + 128))?.[0] ?? c;
            i += m.length;
            if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(m)) {
                stack.push({ kind: 'num', value: Number(m) });
            } else {
                onOperator(m, stack);
                stack = [];
                if (m === 'BI') {
                    // inline image: skip its data
                    const end = content.indexOf('EI', i);
                    i = end < 0 ? content.length : end + 2;
                }
            }
        }
    }
}

/** WinAnsiEncoding where it differs from Latin-1 (0x80-0x9F) */
const WIN_ANSI: Record<number, string> = {
    0x80: '€',
    0x82: '‚',
    0x83: 'ƒ',
    0x84: '„',
    0x85: '…',
    0x86: '†',
    0x87: '‡',
    0x88: 'ˆ',
    0x89: '‰',
    0x8a: 'Š',
    0x8b: '‹',
    0x8c: 'Œ',
    0x8e: 'Ž',
    0x91: '‘',
    0x92: '’',
    0x93: '“',
    0x94: '”',
    0x95: '•',
    0x96: '–',
    0x97: '—',
    0x98: '˜',
    0x99: '™',
    0x9a: 'š',
    0x9b: '›',
    0x9c: 'œ',
    0x9e: 'ž',
    0x9f: 'Ÿ',
};

/**
 * Text of a standard font without ToUnicode map (WinAnsiEncoding).
 *
 * @param bytes - Codes
 */
export function winAnsi(bytes: Buffer): string {
    return [...bytes].map(b => WIN_ANSI[b] ?? String.fromCharCode(b)).join('');
}

/**
 * Text pieces of a PDF in content order (one piece per text operator, trimmed, empty ones dropped).
 *
 * @param pdf - File content
 * @returns The pieces; throws if the file is no PDF or too large
 */
export function pdfText(pdf: Buffer): string[] {
    if (pdf.length > MAX_PDF_BYTES) {
        throw new Error('PDF too large');
    }
    const s = pdf.toString('latin1');
    if (!s.startsWith('%PDF-')) {
        throw new Error('not a PDF');
    }
    const objects = readObjects(s);
    const resolve = (text: string, key: string): string | undefined => {
        const inline = inlineDict(text, key);
        if (inline !== undefined) {
            return inline;
        }
        const n = ref(text, key);
        return n === undefined ? undefined : objects.get(n)?.dict;
    };
    const pieces: string[] = [];
    const pages = [...objects.values()].filter(o => /\/Type\s*\/Page\b/.test(o.dict)).slice(0, MAX_PAGES);
    for (const page of pages) {
        const resources = resolve(page.dict, 'Resources') ?? '';
        const fontDict = resolve(resources, 'Font') ?? '';
        const fonts = new Map<string, Map<number, string> | null>();
        for (const f of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
            const font = objects.get(Number(f[2]));
            const toUnicode = font ? ref(font.dict, 'ToUnicode') : undefined;
            const cmap = toUnicode === undefined ? undefined : objects.get(toUnicode)?.stream;
            fonts.set(f[1], cmap ? parseCMap(cmap.toString('latin1')) : null);
        }
        const contents = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict)?.[1] ?? page.dict;
        const streams = [...contents.matchAll(/(\d+)\s+\d+\s+R/g)]
            .map(m => objects.get(Number(m[1]))?.stream)
            .filter((b): b is Buffer => !!b);
        let font: Map<number, string> | null = null;
        const decode = (bytes: Buffer): string =>
            font ? [...bytes].map(b => font?.get(b) ?? '').join('') : winAnsi(bytes);
        for (const stream of streams) {
            tokenize(stream.toString('latin1'), (op, args) => {
                if (pieces.length >= MAX_PIECES) {
                    return;
                }
                const last = args[args.length - 1];
                if (op === 'Tf') {
                    const name = args.find(a => a.kind === 'name');
                    font = name?.kind === 'name' ? (fonts.get(name.value) ?? null) : null;
                } else if ((op === 'Tj' || op === "'" || op === '"') && last?.kind === 'str') {
                    pieces.push(decode(last.bytes));
                } else if (op === 'TJ' && last?.kind === 'arr') {
                    pieces.push(
                        last.items
                            .map(t =>
                                t.kind === 'str' ? decode(t.bytes) : t.kind === 'num' && t.value < -200 ? ' ' : '',
                            )
                            .join(''),
                    );
                }
            });
        }
    }
    return pieces.map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

import { expect } from 'chai';
import { MAX_POINTS_PER_SERIES, PriceHistory, WINDOW_MS } from './price-history';

const S1 = '00000000-0000-0000-0000-000000000001';
const S2 = '00000000-0000-0000-0000-000000000002';
const KEY1 = PriceHistory.key(S1, 'e10');
const KEY2 = PriceHistory.key(S2, 'e10');
const H = 3_600_000;

describe('fuel/price-history', () => {
    it('stores change points only', () => {
        const history = new PriceHistory();
        expect(history.add(KEY1, 0, 1.7)).to.equal(true);
        expect(history.add(KEY1, H, 1.7)).to.equal(false);
        expect(history.add(KEY1, 2 * H, 1.75)).to.equal(true);
        expect(history.add(KEY1, 3 * H, null)).to.equal(true);
        expect(history.add(KEY1, 4 * H, null)).to.equal(false);
        expect(history.points(KEY1)).to.deep.equal([
            [0, 1.7],
            [2 * H, 1.75],
            [3 * H, null],
        ]);
    });

    it('ignores samples that go back in time', () => {
        const history = new PriceHistory();
        history.add(KEY1, 10 * H, 1.7);
        expect(history.add(KEY1, 5 * H, 1.8)).to.equal(false);
    });

    it('caps a series', () => {
        const history = new PriceHistory();
        for (let i = 0; i < MAX_POINTS_PER_SERIES + 10; i++) {
            history.add(KEY1, i, i % 2 === 0 ? 1.7 : 1.8);
        }
        expect(history.points(KEY1)).to.have.length(MAX_POINTS_PER_SERIES);
        expect(history.points(KEY1)[0][0]).to.equal(10);
    });

    it('prune keeps the last point before the window and drops unknown series', () => {
        const history = new PriceHistory();
        const now = 10 * 24 * H;
        history.add(KEY1, 0, 1.6);
        history.add(KEY1, H, 1.65);
        history.add(KEY1, now - WINDOW_MS - H, 1.7);
        history.add(KEY1, now - H, 1.75);
        history.add(KEY2, 0, 1.6);
        history.prune(now, new Set([KEY1]));
        expect(history.points(KEY1)).to.deep.equal([
            [now - WINDOW_MS - H, 1.7],
            [now - H, 1.75],
        ]);
        expect(history.points(KEY2)).to.deep.equal([]);
    });

    it('round-trips through serialize / parse', () => {
        const history = new PriceHistory();
        history.add(KEY1, 1000, 1.7);
        history.add(KEY1, 2000, null);
        const { history: copy, valid } = PriceHistory.parse(history.serialize());
        expect(valid).to.equal(true);
        expect(copy.points(KEY1)).to.deep.equal(history.points(KEY1));
    });

    it('survives broken files', () => {
        expect(PriceHistory.parse(undefined).valid).to.equal(true);
        expect(PriceHistory.parse('{nope').valid).to.equal(false);
        expect(PriceHistory.parse(JSON.stringify({ version: 99, series: {} })).valid).to.equal(false);
        const mixed = PriceHistory.parse(
            JSON.stringify({
                version: 1,
                series: {
                    [KEY1]: [
                        [1, 1.7],
                        ['x', 1],
                        [2, 'y'],
                        [3, null],
                    ],
                    'bad key': [[1, 1]],
                },
            }),
        );
        expect(mixed.valid).to.equal(true);
        expect(mixed.history.points(KEY1)).to.deep.equal([
            [1, 1.7],
            [3, null],
        ]);
        expect(mixed.history.points('bad key')).to.deep.equal([]);
    });
});

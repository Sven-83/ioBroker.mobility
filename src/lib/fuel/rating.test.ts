import { expect } from 'chai';
import type { PricePoint } from './price-history';
import { MIN_COVERAGE_MS, chartPoints, evaluate, segments } from './rating';

const H = 3_600_000;
const DAY = 24 * H;

/**
 * Local midnight of a fixed day, so hour/weekday tests do not depend on the test machine's date.
 * 2026-11-02 is a Monday.
 */
const MONDAY = new Date(2026, 10, 2, 0, 0, 0, 0).getTime();

/**
 * Daily pattern: expensive 1.80 from 0-18 h, cheap 1.70 from 18-24 h, for the given days.
 *
 * @param days - Number of days
 */
function dailyPattern(days: number): PricePoint[] {
    const points: PricePoint[] = [];
    for (let d = 0; d < days; d++) {
        points.push([MONDAY + d * DAY, 1.8]);
        points.push([MONDAY + d * DAY + 18 * H, 1.7]);
    }
    return points;
}

describe('fuel/rating', () => {
    it('segments clip to the window and skip null', () => {
        const now = MONDAY + 10 * DAY;
        const parts = segments(
            [
                [MONDAY, 1.7],
                [now - H, null],
                [now - H / 2, 1.8],
            ],
            now,
        );
        expect(parts).to.deep.equal([
            { start: now - 7 * DAY, end: now - H, price: 1.7 },
            { start: now - H / 2, end: now, price: 1.8 },
        ]);
    });

    it('gives no rating without data or with less than 24 h', () => {
        expect(evaluate([], 1.7, MONDAY).rating).to.equal('unknown');
        const short = evaluate([[MONDAY, 1.7]], 1.7, MONDAY + MIN_COVERAGE_MS - 1);
        expect(short.rating).to.equal('unknown');
        expect(short.min).to.equal(1.7);
        expect(short.bestHour).to.equal(null);
    });

    it('rates against the time-weighted distribution', () => {
        const points = dailyPattern(3);
        const now = MONDAY + 3 * DAY;
        expect(evaluate(points, 1.7, now).rating).to.equal('cheap');
        expect(evaluate(points, 1.8, now).rating).to.equal('expensive');
        expect(evaluate(points, 1.75, now).rating).to.equal('normal');
        expect(evaluate(points, 1.7, now).rank).to.equal(0); // never cheaper
        expect(evaluate(points, 1.8, now).rank).to.equal(0.25); // cheaper 6 of 24 h
        expect(evaluate(points, null, now).rating).to.equal('unknown');
    });

    it('keeps a price that never changed "normal"', () => {
        const result = evaluate([[MONDAY, 1.7]], 1.7, MONDAY + 2 * DAY);
        expect(result.rating).to.equal('normal');
        expect(result.rank).to.equal(0);
    });

    it('rates a new low as cheap and a new high as expensive', () => {
        const points = dailyPattern(3);
        const now = MONDAY + 3 * DAY;
        expect(evaluate(points, 1.65, now).rating).to.equal('cheap');
        expect(evaluate(points, 1.85, now).rating).to.equal('expensive');
    });

    it('computes min, max and time-weighted average', () => {
        const result = evaluate(dailyPattern(3), 1.7, MONDAY + 3 * DAY);
        expect(result.min).to.equal(1.7);
        expect(result.max).to.equal(1.8);
        expect(result.average).to.equal(1.775); // 18 h * 1.80 + 6 h * 1.70
        expect(result.coverageMs).to.equal(3 * DAY);
    });

    it('finds the usually cheapest hour', () => {
        const result = evaluate(dailyPattern(3), 1.7, MONDAY + 3 * DAY);
        expect(result.bestHour).to.equal(18);
        expect(result.bestHourPrice).to.equal(1.7);
        expect(result.hourProfile).to.have.length(24);
        expect(result.hourProfile[3]).to.equal(1.8);
        expect(result.hourProfile[20]).to.equal(1.7);
        expect(result.bestWeekday).to.equal(null); // less than 6 days
    });

    it('finds the cheapest weekday once 6 days are recorded', () => {
        const points: PricePoint[] = [];
        for (let d = 0; d < 7; d++) {
            // Thursday (d = 3) is the cheap day
            points.push([MONDAY + d * DAY, d === 3 ? 1.65 : 1.8]);
        }
        const result = evaluate(points, 1.8, MONDAY + 7 * DAY);
        expect(result.bestWeekday).to.equal(4); // Thursday, 0 = Sunday
        expect(result.bestWeekdayPrice).to.equal(1.65);
    });

    describe('chartPoints', () => {
        const now = MONDAY + 8 * DAY;
        it('moves the price valid at the window start to the start', () => {
            const points: PricePoint[] = [
                [now - 9 * DAY, 1.9],
                [now - 8 * DAY, 1.8],
                [now - 3 * DAY, null],
                [now - 2 * DAY, 1.7],
            ];
            expect(chartPoints(points, now)).to.deep.equal([
                [now - 7 * DAY, 1.8],
                [now - 3 * DAY, null],
                [now - 2 * DAY, 1.7],
            ]);
        });
        it('keeps a point exactly at the start and drops future points', () => {
            expect(
                chartPoints(
                    [
                        [now - 7 * DAY, 1.8],
                        [now + H, 1.9],
                    ],
                    now,
                ),
            ).to.deep.equal([[now - 7 * DAY, 1.8]]);
        });
        it('empty', () => expect(chartPoints([], now)).to.deep.equal([]));
    });
});

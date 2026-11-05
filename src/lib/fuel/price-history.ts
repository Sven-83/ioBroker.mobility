/*
 * Own price memory for the 7-day rating (decided 2026-11-05 instead of the history adapter):
 * per station and fuel only the change points are kept. A price is valid from its point until
 * the next point; null marks "no price" (station closed / fuel not offered).
 */

/** Length of the window in ms */
export const WINDOW_MS = 7 * 24 * 3_600_000;

/** Hard limit per series (protects memory and file size even with a flapping API) */
export const MAX_POINTS_PER_SERIES = 5_000;

/** Format version of the saved file */
export const FILE_VERSION = 1;

/** One change point: [epoch ms, price in EUR or null] */
export type PricePoint = [number, number | null];

/**
 * Change points of all series, key = "<stationId>|<fuel>".
 */
export class PriceHistory {
    private readonly series = new Map<string, PricePoint[]>();

    /**
     * Key of a series.
     *
     * @param stationId - Station ID
     * @param fuel - Fuel type
     */
    public static key(stationId: string, fuel: string): string {
        return `${stationId.toLowerCase()}|${fuel}`;
    }

    /**
     * Records a sample; only stores it if the price changed.
     *
     * @param key - Series key
     * @param time - Time of the sample (epoch ms)
     * @param price - Price or null
     * @returns true if a new change point was stored
     */
    public add(key: string, time: number, price: number | null): boolean {
        let points = this.series.get(key);
        if (!points) {
            points = [];
            this.series.set(key, points);
        }
        const last = points[points.length - 1];
        if (last && (time < last[0] || last[1] === price)) {
            return false;
        }
        points.push([time, price]);
        if (points.length > MAX_POINTS_PER_SERIES) {
            points.splice(0, points.length - MAX_POINTS_PER_SERIES);
        }
        return true;
    }

    /**
     * Change points of one series (oldest first). The returned array must not be modified.
     *
     * @param key - Series key
     */
    public points(key: string): readonly PricePoint[] {
        return this.series.get(key) ?? [];
    }

    /**
     * Drops points that are no longer needed: everything before the window except the last point
     * before it (it defines the price at the window start). Removes series that are not wanted any more.
     *
     * @param now - Current time (epoch ms)
     * @param keepKeys - Series that are still configured
     */
    public prune(now: number, keepKeys?: ReadonlySet<string>): void {
        const start = now - WINDOW_MS;
        for (const [key, points] of this.series) {
            if (keepKeys && !keepKeys.has(key)) {
                this.series.delete(key);
                continue;
            }
            let firstInside = points.findIndex(point => point[0] >= start);
            if (firstInside === -1) {
                firstInside = points.length;
            }
            if (firstInside > 1) {
                points.splice(0, firstInside - 1);
            }
        }
    }

    /** JSON for the instance file */
    public serialize(): string {
        return JSON.stringify({ version: FILE_VERSION, series: Object.fromEntries(this.series) });
    }

    /**
     * Restores from the instance file. Invalid content results in an empty history (no crash).
     *
     * @param text - File content
     * @returns The history and whether the content was usable
     */
    public static parse(text: string | undefined): { history: PriceHistory; valid: boolean } {
        const history = new PriceHistory();
        if (!text) {
            return { history, valid: true };
        }
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch {
            return { history, valid: false };
        }
        const file = data as { version?: unknown; series?: unknown } | null;
        if (file?.version !== FILE_VERSION || typeof file.series !== 'object' || file.series === null) {
            return { history, valid: false };
        }
        for (const [key, value] of Object.entries(file.series as Record<string, unknown>)) {
            if (!/^[0-9a-f-]{36}\|[a-z0-9]{1,10}$/.test(key) || !Array.isArray(value)) {
                continue;
            }
            for (const point of value) {
                if (
                    Array.isArray(point) &&
                    typeof point[0] === 'number' &&
                    Number.isFinite(point[0]) &&
                    (point[1] === null || (typeof point[1] === 'number' && Number.isFinite(point[1])))
                ) {
                    history.add(key, point[0], point[1] as number | null);
                }
            }
        }
        return { history, valid: true };
    }
}

import { expect } from 'chai';
import { parseTelemetry, type VehicleState } from './telemetry';
import { LIMITS, computeWarnings, worstLevel, type WarningContext } from './warnings';

const NOW = Date.parse('2026-11-13T21:00:00Z');
const HOUR = 3_600_000;

/**
 * @param metrics - Telemetry metrics
 * @param extra - Top-level fields
 */
function st(metrics: Record<string, unknown>, extra: Record<string, unknown> = {}): VehicleState {
    return parseTelemetry({ updateTime: new Date(NOW - HOUR).toISOString(), metrics, ...extra });
}

/**
 * @param more - Overrides
 */
function ctx(more: Partial<WarningContext> = {}): WarningContext {
    return { now: NOW, unlockedSince: null, loginExpires: NOW + 300 * 24 * HOUR, hour: 14, ...more };
}

const keys = (list: { key: string; level: string }[]): string[] => list.map(w => `${w.key}:${w.level}`);

describe('ford/warnings', () => {
    it('is quiet for a healthy parked car', () => {
        const list = computeWarnings(
            st({
                ignitionStatus: { value: 'OFF' },
                fuelLevel: { value: 60 },
                batteryStateOfCharge: { value: 80 },
                oilLifeRemaining: { value: 90 },
                outsideTemperature: { value: 12 },
                doorLockStatus: [{ value: 'LOCKED', vehicleDoor: 'ALL_DOORS' }],
                doorStatus: [{ value: 'CLOSED' }],
                hoodStatus: { value: 'CLOSED' },
                alarmStatus: { value: 'DISARMED' },
                panicAlarmStatus: { value: 'UNDEFINED' },
                tirePressure: [{ value: 250, vehicleWheel: 'FRONT_LEFT', wheelPlacardFront: 206.8 }],
                tirePressureStatus: [{ value: 'NORMAL', vehicleWheel: 'FRONT_LEFT' }],
            }),
            ctx(),
        );
        expect(list).to.deep.equal([]);
        expect(worstLevel(list)).to.equal('none');
    });

    it('reports an unlocked BEV with an open window on a frosty evening', () => {
        const lockTime = new Date(NOW - 2 * HOUR).toISOString();
        const state = st({
            ignitionStatus: { value: 'OFF' },
            xevBatteryStateOfCharge: { value: 90.5 },
            batteryStateOfCharge: { value: 96 },
            outsideTemperature: { value: 0.75 },
            doorLockStatus: [{ value: 'UNLOCKED', vehicleDoor: 'ALL_DOORS', updateTime: lockTime }],
            doorStatus: [{ value: 'CLOSED' }],
            windowStatus: [{ value: { doubleRange: { lowerBound: 0, upperBound: 10 } } }],
            xevBatteryPerformanceStatus: { value: 'NORMAL' },
        });
        expect(state.lockTime).to.equal(Date.parse(lockTime));
        const list = computeWarnings(state, ctx({ unlockedSince: state.lockTime }));
        expect(keys(list)).to.deep.equal(['unlocked:critical', 'window:critical', 'frost:info']);
        expect(worstLevel(list)).to.equal('critical');
    });

    it('waits 10 minutes before "unlocked" and ignores it while driving', () => {
        const state = st({
            ignitionStatus: { value: 'OFF' },
            doorLockStatus: [{ value: 'UNLOCKED', vehicleDoor: 'ALL_DOORS' }],
        });
        expect(computeWarnings(state, ctx({ unlockedSince: NOW - LIMITS.unlockedMs + 1 }))).to.deep.equal([]);
        expect(keys(computeWarnings(state, ctx({ unlockedSince: NOW - LIMITS.unlockedMs })))).to.deep.equal([
            'unlocked:critical',
        ]);
        const driving = st({
            ignitionStatus: { value: 'RUN' },
            doorLockStatus: [{ value: 'UNLOCKED', vehicleDoor: 'ALL_DOORS' }],
        });
        expect(computeWarnings(driving, ctx({ unlockedSince: NOW - HOUR }))).to.deep.equal([]);
    });

    it('flags a tyre by status or below 85 % of the placard, with wheel and bar', () => {
        const list = computeWarnings(
            st({
                tirePressure: [
                    { value: 170, vehicleWheel: 'FRONT_LEFT', wheelPlacardFront: 206.8 },
                    { value: 240, vehicleWheel: 'REAR_RIGHT', wheelPlacardRear: 179.3 },
                    { value: 250, vehicleWheel: 'FRONT_RIGHT', wheelPlacardFront: 206.8 },
                ],
                tirePressureStatus: [{ value: 'LOW', vehicleWheel: 'REAR_RIGHT' }],
            }),
            ctx(),
        );
        expect(list).to.deep.equal([
            { key: 'tyre', level: 'critical', wheel: 'frontLeft', value: 1.7, unit: 'bar' },
            { key: 'tyre', level: 'critical', wheel: 'rearRight', value: 2.4, unit: 'bar' },
        ]);
    });

    it('uses two steps for fuel, battery, 12 V and oil', () => {
        const combustion = (fuel: number, v12: number, oil: number): string[] =>
            keys(
                computeWarnings(
                    st({
                        fuelLevel: { value: fuel },
                        batteryStateOfCharge: { value: v12 },
                        oilLifeRemaining: { value: oil },
                    }),
                    ctx(),
                ),
            );
        expect(combustion(46.3, 30, 95)).to.deep.equal(['battery12v:warning']); // typical: only the 12 V battery is weak
        expect(combustion(25, 39, 15)).to.deep.equal(['fuel:warning', 'battery12v:warning', 'oil:warning']);
        expect(combustion(10, 24, 5)).to.deep.equal(['fuel:critical', 'battery12v:critical', 'oil:critical']);
        const bev = (soc: number): string[] =>
            keys(computeWarnings(st({ xevBatteryStateOfCharge: { value: soc } }), ctx()));
        expect(bev(21)).to.deep.equal([]);
        expect(bev(20)).to.deep.equal(['battery:warning']);
        expect(bev(10)).to.deep.equal(['battery:critical']);
    });

    it('puts red first and orders by importance', () => {
        const list = computeWarnings(
            st({
                ignitionStatus: { value: 'OFF' },
                outsideTemperature: { value: -2 },
                fuelLevel: { value: 20 },
                alarmStatus: { value: 'TRIGGERED' },
                hoodStatus: { value: 'OPEN' },
            }),
            ctx(),
        );
        expect(keys(list)).to.deep.equal(['alarm:critical', 'door:critical', 'fuel:warning', 'frost:info']);
    });

    it('warns in the evening when the BEV is low and not plugged in', () => {
        const state = st({ xevBatteryStateOfCharge: { value: 40 }, xevPlugChargerStatus: { value: 'DISCONNECTED' } });
        expect(computeWarnings(state, ctx({ hour: 19 }))).to.deep.equal([]);
        expect(keys(computeWarnings(state, ctx({ hour: 20 })))).to.deep.equal(['notPluggedIn:warning']);
        const plugged = st({ xevBatteryStateOfCharge: { value: 40 }, xevPlugChargerStatus: { value: 'CONNECTED' } });
        expect(computeWarnings(plugged, ctx({ hour: 21 }))).to.deep.equal([]);
    });

    it('reports charge faults, limited battery power, stale data and an expiring login', () => {
        const list = computeWarnings(
            st(
                {
                    xevBatteryStateOfCharge: { value: 70 },
                    xevBatteryChargeDisplayStatus: { value: 'FAULT' },
                    xevBatteryPerformanceStatus: { value: 'REDUCED' },
                },
                { updateTime: new Date(NOW - 20 * HOUR).toISOString() },
            ),
            ctx({ loginExpires: NOW + 3 * 24 * HOUR }),
        );
        expect(list).to.deep.equal([
            { key: 'chargeFault', level: 'critical' },
            { key: 'batteryPerformance', level: 'warning' },
            { key: 'stale', level: 'info', value: 20, unit: 'h' },
            { key: 'login', level: 'info', value: 3, unit: 'd' },
        ]);
    });

    it('adds slow tyre loss only for wheels without a red tyre warning', () => {
        const state = st({ tirePressure: [{ value: 150, vehicleWheel: 'FRONT_LEFT', wheelPlacardFront: 206.8 }] });
        const list = computeWarnings(state, ctx({ tyreLoss: { frontLeft: 40, rearLeft: 25, rearRight: 10 } }));
        expect(keys(list)).to.deep.equal(['tyre:critical', 'tyreLoss:warning']);
        expect(list[1].wheel).to.equal('rearLeft');
    });
});

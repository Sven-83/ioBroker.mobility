import { expect } from 'chai';
import { Notifier, notifyInstance, notifyUsers, type MessageKind, type NotifyHost } from './notifier';

const H = 3_600_000;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test helper
function setup(kinds: MessageKind[] = ['fuel', 'charge', 'plug', 'tyres'], stored?: string, failWith?: Error) {
    const sent: string[] = [];
    const logs: string[] = [];
    let memory: string | undefined = stored;
    const clock = { now: new Date(2026, 10, 14, 20, 30).getTime() };
    const host: NotifyHost = {
        send: text => {
            if (failWith) {
                return Promise.reject(failWith);
            }
            sent.push(text);
            return Promise.resolve();
        },
        read: () => Promise.resolve(memory),
        write: value => {
            memory = value;
            return Promise.resolve();
        },
        now: () => clock.now,
        info: m => logs.push(`info ${m}`),
        warn: m => logs.push(`warn ${m}`),
    };
    const notifier = new Notifier(host, { kinds: new Set(kinds), german: true });
    return { notifier, sent, logs, clock, memory: () => memory };
}

/**
 * the values the adapter writes for two cars, a station ranking and two chargers
 *
 * @param n - Notifier under test
 */
function base(n: Notifier): void {
    n.observe('ford.vehicle1.name', 'Benziner');
    n.observe('ford.vehicle1.engineType', 'HEV');
    n.observe('ford.vehicle2.name', 'Stromer');
    n.observe('ford.vehicle2.engineType', 'BEV');
    n.observe('easee.charger1.name', 'Wallbox A');
    n.observe('easee.charger2.name', 'Wallbox B');
}

const ranking = (rating: string, price = 1.809): string =>
    JSON.stringify([
        { station: 'station1', name: 'Tankstelle Eins', price, rating },
        { station: 'station2', name: 'Tankstelle Zwei', price: price + 0.01, rating: 'normal' },
    ]);

describe('notify/notifier', () => {
    it('fuel: low tank and cheap station, once until refuelled', async () => {
        const t = setup();
        await t.notifier.start();
        base(t.notifier);
        t.notifier.observe('fuel.ranking', ranking('normal'));
        t.notifier.observe('ford.vehicle1.fuelLevel', 22);
        expect(t.sent).to.deep.equal([]); // low, but not cheap
        t.notifier.observe('fuel.ranking', ranking('cheap'));
        t.notifier.observe('fuel.ranking', ranking('cheap', 1.799));
        await t.notifier.flush();
        expect(t.sent).to.deep.equal([
            '⛽ Benziner: Tank 22 % · Tankstelle Eins ist gerade günstig: 1,809 € (Super E10)',
        ]);
        t.notifier.observe('ford.vehicle1.fuelLevel', 95); // refuelled
        t.notifier.observe('ford.vehicle1.fuelLevel', 20);
        await t.notifier.flush();
        expect(t.sent).to.have.length(2);
    });

    it('fuel: still low the next day sends again, the electric car never', async () => {
        const t = setup();
        await t.notifier.start();
        base(t.notifier);
        t.notifier.observe('ford.vehicle2.fuelLevel', 10);
        t.notifier.observe('ford.vehicle1.fuelLevel', 20);
        t.notifier.observe('fuel.ranking', ranking('cheap'));
        t.clock.now += 5 * H;
        t.notifier.observe('fuel.ranking', ranking('cheap'));
        await t.notifier.flush();
        expect(t.sent).to.have.length(1);
        t.clock.now += 20 * H;
        t.notifier.observe('fuel.ranking', ranking('cheap'));
        await t.notifier.flush();
        expect(t.sent).to.have.length(2);
        expect(t.sent.every(s => s.includes('Benziner'))).to.equal(true);
    });

    it('charge finished: charging -> completed, with kWh, costs and the plugged-in car', async () => {
        const t = setup();
        await t.notifier.start();
        base(t.notifier);
        t.notifier.observe('ford.vehicle2.plugStatus', 'CONNECTED');
        t.notifier.observe('ford.vehicle2.soc', 100);
        t.notifier.observe('easee.charger1.opMode', 3);
        t.notifier.observe('easee.charger1.sessionEnergy', 24.81);
        t.notifier.observe('easee.charger1.sessionCost', 8.93);
        t.notifier.observe('easee.charger1.opMode', 4);
        await t.notifier.flush();
        expect(t.sent).to.deep.equal(['🔋 Stromer fertig geladen an Wallbox A · 24,8 kWh · 8,93 € · Akku 100 %']);
    });

    it('a stop by the user and the first value after a start are no events', async () => {
        const t = setup();
        await t.notifier.start();
        base(t.notifier);
        t.notifier.observe('easee.charger2.opMode', 4); // first value after the start
        t.notifier.observe('easee.charger1.opMode', 3);
        t.notifier.observe('easee.charger1.opMode', 7); // stopped with the button
        await t.notifier.flush();
        expect(t.sent).to.deep.equal([]);
    });

    it('charger error once, again only after it was gone', async () => {
        const t = setup();
        await t.notifier.start();
        base(t.notifier);
        t.notifier.observe('easee.charger1.reasonText', 'Charger error');
        for (const mode of [3, 5, 3, 5]) {
            t.notifier.observe('easee.charger1.opMode', mode);
        }
        await t.notifier.flush();
        expect(t.sent).to.deep.equal([
            '⚠️ Laden abgebrochen an Wallbox A: Wallbox meldet einen Fehler (Charger error)',
            '⚠️ Laden abgebrochen an Wallbox A: Wallbox meldet einen Fehler (Charger error)',
        ]);
    });

    it('not plugged in: once per evening, a restart repeats nothing', async () => {
        const t = setup();
        await t.notifier.start();
        base(t.notifier);
        const warn = JSON.stringify([{ key: 'notPluggedIn', level: 'warning', value: 35, unit: '%' }]);
        t.notifier.observe('ford.vehicle2.warnings', warn);
        t.notifier.observe('ford.vehicle2.warnings', '[]');
        t.notifier.observe('ford.vehicle2.warnings', warn);
        await t.notifier.flush();
        expect(t.sent).to.deep.equal(['🔌 Stromer ist nicht eingesteckt · Akku 35 %']);

        const again = setup(undefined, t.memory());
        again.clock.now = t.clock.now + H;
        await again.notifier.start();
        base(again.notifier);
        again.notifier.observe('ford.vehicle2.warnings', warn);
        await again.notifier.flush();
        expect(again.sent).to.deep.equal([]);
        again.clock.now += 24 * H; // next evening
        again.notifier.observe('ford.vehicle2.warnings', warn);
        await again.notifier.flush();
        expect(again.sent).to.have.length(1);
    });

    it('tyre loss per wheel, at most every 7 days', async () => {
        const t = setup();
        await t.notifier.start();
        base(t.notifier);
        const loss = JSON.stringify([
            { key: 'tyreLoss', level: 'warning', wheel: 'rearLeft', value: 0.25, unit: 'bar' },
        ]);
        t.notifier.observe('ford.vehicle1.warnings', loss);
        t.notifier.observe('ford.vehicle1.warnings', '[]');
        t.clock.now += 2 * 24 * H;
        t.notifier.observe('ford.vehicle1.warnings', loss);
        await t.notifier.flush();
        expect(t.sent).to.deep.equal([
            '🛞 Benziner: Reifen hinten links verliert Luft (−0,25 bar in 7 Tagen). Bitte prüfen.',
        ]);
        t.notifier.observe('ford.vehicle1.warnings', '[]');
        t.clock.now += 6 * 24 * H;
        t.notifier.observe('ford.vehicle1.warnings', loss);
        await t.notifier.flush();
        expect(t.sent).to.have.length(2);
    });

    it('charging fault reported by the car', async () => {
        const t = setup();
        await t.notifier.start();
        base(t.notifier);
        t.notifier.observe('ford.vehicle2.warnings', JSON.stringify([{ key: 'chargeFault', level: 'critical' }]));
        t.notifier.observe('ford.vehicle2.warnings', JSON.stringify([{ key: 'chargeFault', level: 'critical' }]));
        await t.notifier.flush();
        expect(t.sent).to.deep.equal(['⚠️ Stromer: Laden abgebrochen (meldet das Auto)']);
    });

    it('sends only the kinds switched on and logs a failed delivery', async () => {
        const t = setup(['tyres'], undefined, new Error('telegram.0 is not running'));
        await t.notifier.start();
        base(t.notifier);
        t.notifier.observe('ford.vehicle2.warnings', JSON.stringify([{ key: 'notPluggedIn', level: 'warning' }]));
        t.notifier.observe(
            'ford.vehicle1.warnings',
            JSON.stringify([{ key: 'tyreLoss', level: 'warning', wheel: 'frontLeft', value: 0.3 }]),
        );
        await t.notifier.flush();
        expect(t.logs).to.have.length(1);
        expect(t.logs[0]).to.match(/^warn Message not sent \(telegram\.0 is not running\): 🛞/);
    });

    it('reads instance and receivers from the settings', () => {
        expect(notifyInstance('')).to.equal('telegram.0');
        expect(notifyInstance('system.adapter.telegram.1')).to.equal('telegram.1');
        expect(notifyInstance('telegram')).to.equal(undefined);
        expect(notifyUsers(' a, b ,a,')).to.deep.equal(['a', 'b']);
    });
});

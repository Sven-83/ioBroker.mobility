![Logo](admin/mobility.png)

# ioBroker.mobility

[![NPM version](https://img.shields.io/npm/v/iobroker.mobility.svg)](https://www.npmjs.com/package/iobroker.mobility)
[![Downloads](https://img.shields.io/npm/dm/iobroker.mobility.svg)](https://www.npmjs.com/package/iobroker.mobility)
![Number of Installations](https://iobroker.live/badges/mobility-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/mobility-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.mobility.png?downloads=true)](https://nodei.co/npm/iobroker.mobility/)

**Tests:** ![Test and Release](https://github.com/Sven-83/ioBroker.mobility/workflows/Test%20and%20Release/badge.svg)

## mobility adapter for ioBroker

Ford vehicles (FordConnect Query), Easee chargers and fuel prices (Tankerkönig).

> Work in progress. Fuel prices and Easee chargers are implemented and tested; the Ford part is
> implemented but not yet tested against the real API.

### Fuel prices (Tankerkönig)

- Current Super E10 price of two stations you choose (two fixed slots in the settings).
- Own price memory of the last 7 days (instance file `fuel-history.json`, no history adapter needed):
  rating of the current price (`cheap` / `normal` / `expensive`), minimum, maximum and average,
  the usually cheapest hour and, after 6 days, the usually cheapest weekday.
- `fuel.ranking` (JSON) and `fuel.cheapestStation` / `fuel.cheapestPrice` for dashboards.
- Polls at most every 5 minutes with a random offset, as the Tankerkönig terms require; master data once a day.
  An answer with `ok: false` pauses all requests for one hour (the terms say: no further requests);
  a rejected key stops the fuel part.
- You need a free API key from [onboarding.tankerkoenig.de](https://onboarding.tankerkoenig.de);
  station IDs can be found with the [station finder](https://creativecommons.tankerkoenig.de/TankstellenFinder/index.html).
  Never share your key.

Fuel price data: [Tankerkönig](https://creativecommons.tankerkoenig.de), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), source MTS-K.

### Easee chargers

- **Charger selection:** enter the names of your two chargers as shown in the Easee app
  (`easee.charger1` / `easee.charger2`). Only these are read, subscribed and can be switched - important
  if the account sees more chargers, e.g. as admin of a car park. Without names the adapter uses the
  chargers automatically only if the account has at most two; otherwise it does nothing and lists the
  names in the log. Serial numbers are not stored.
- User name: e-mail, or phone number **with country code** (e.g. `+49...`).
- Status (op mode, car plugged in, charging, online), power, energy of the session, lifetime meter,
  currents, cable lock, error code and the charging costs of the session (price in the settings).
- Values come from the new Easee observations API (the old `/state` endpoint was switched off
  on 2026-09-01). Poll interval 30-600 s (default 60 s); Easee allows 100 requests per 5 minutes.
- **Start/stop:** write `true` / `false` to `easee.chargerN.charge`. Without RFID authorization the
  adapter uses pause/resume (dynamic current), with authorization start/stop. At most one command per
  10 s and charger; the values are read again 10 s and 40 s later. `easee.chargerN.refresh` reads at once.
- **Real-time values (SignalR):** with the option on (default), Easee pushes every change at once over
  `streams.easee.com/hubs/products`; polling then only runs every 5 minutes as a check and takes over
  while the stream is down (reconnect 5 s ... 5 min). `easee.streamConnected` shows the stream state.
  15 s after a command the charger is subscribed again, because the stream can go silent after start/stop.
- A wrong login stops the Easee part with an error message (no retries that could lock the account).
- **Nothing is ever deleted on the Easee side:** the client only sends requests from a fixed allow list
  (login, token refresh, charger list, observations, start/stop/pause/resume). No DELETE, no settings,
  sites or users - important for site admin accounts. Easee objects in ioBroker are never deleted either.
- Tip: use a separate Easee account for ioBroker with shared access to the chargers.

### Ford vehicles (FordConnect Query)

- Official, read-only FordConnect Query API. Create an app "for personal use" in the
  [Ford developer portal (EU)](https://developer.ford.com/developer-eu) and enter client ID, client secret and
  the redirect URI (default `http://localhost/fordconnect`, must be identical in the portal).
- Use a separate FordPass account for ioBroker that has access to the vehicles (protects the main account).
- **Login, once per vehicle (about once a year):** after saving, open `ford.vehicleN.login.url` in the browser,
  log in and pick the vehicle. The browser then shows an error page - copy its whole address into
  `ford.vehicleN.login.response`. The adapter takes the code, empties the field at once and stores the tokens
  encrypted. A week before the login expires the log reminds you.
- One Ford login gives access to exactly one vehicle, so two vehicles need two logins (vehicle 1 and 2).
- Login error `AADB2C90085`: reported for FordPass accounts that only have shared vehicle access. The log
  then suggests trying the login with the owner's main FordPass account.
- Values: fuel level and range, battery and electric range, plug and charging status, odometer, 12 V battery,
  oil life, temperatures, ignition, alarm, doors, tyre pressure per wheel; `metricKeys` and `raw` (without VIN
  and position) show what the vehicle delivers.
- Polls every 5-60 minutes (default 30) with a random offset; frequent polling can get the account locked.
- No VIN, number plate or position in object IDs, states or logs.

## Developer manual

This section is intended for the developer. It can be deleted later.

### DISCLAIMER

Please make sure that you consider copyrights and trademarks when you use names or logos of a company and add a disclaimer to your README.
You can check other adapters for examples or ask in the developer community. Using a name or logo of a company without permission may cause legal problems for you.

### Getting started

You are almost done, only a few steps left:

1. Create a new repository on GitHub with the name `ioBroker.mobility`
1. Initialize the current folder as a new git repository:
    ```bash
    git init -b main
    git add .
    git commit -m "Initial commit"
    ```
1. Link your local repository with the one on GitHub:

    ```bash
    git remote add origin https://github.com/Sven-83/ioBroker.mobility
    ```

1. Push all files to the GitHub repo:
    ```bash
    git push origin main
    ```
1. Add a new secret under https://github.com/Sven-83/ioBroker.mobility/settings/secrets. It must be named `AUTO_MERGE_TOKEN` and contain a personal access token with push access to the repository, e.g. yours. You can create a new token under https://github.com/settings/tokens.

1. Head over to [src/main.ts](src/main.ts) and start programming!

### Best Practices

We've collected some [best practices](https://github.com/ioBroker/ioBroker.repositories#development-and-coding-best-practices) regarding ioBroker development and coding in general. If you're new to ioBroker or Node.js, you should
check them out. If you're already experienced, you should also take a look at them - you might learn something new :)

### State Roles

When creating state objects, it is important to use the correct role for the state. The role defines how the state should be interpreted by visualizations and other adapters. For a list of available roles and their meanings, please refer to the [state roles documentation](https://www.iobroker.net/#en/documentation/dev/stateroles.md).

**Important:** Do not invent your own custom role names. If you need a role that is not part of the official list, please contact the ioBroker developer community for guidance and discussion about adding new roles.

### Scripts in `package.json`

Several npm scripts are predefined for your convenience. You can run them using `npm run <scriptname>`

| Script name        | Description                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build`            | Compile the TypeScript sources.                                                                                                                                          |
| `watch`            | Compile the TypeScript sources and watch for changes.                                                                                                                    |
| `test:ts`          | Executes the tests you defined in `*.test.ts` files.                                                                                                                     |
| `test:package`     | Ensures your `package.json` and `io-package.json` are valid.                                                                                                             |
| `test:integration` | Tests the adapter startup with an actual instance of ioBroker.                                                                                                           |
| `test`             | Performs a minimal test run on package files and your tests.                                                                                                             |
| `check`            | Performs a type-check on your code (without compiling anything).                                                                                                         |
| `coverage`         | Generates code coverage using your test files.                                                                                                                           |
| `lint`             | Runs `ESLint` to check your code for formatting errors and potential bugs.                                                                                               |
| `translate`        | Translates texts in your adapter to all required languages, see [`@iobroker/adapter-dev`](https://github.com/ioBroker/adapter-dev#manage-translations) for more details. |

### Configuring the compilation

The adapter template uses [esbuild](https://esbuild.github.io/) to compile TypeScript and/or React code. You can configure many compilation settings
either in `tsconfig.json` or by changing options for the build tasks. These options are described in detail in the
[`@iobroker/adapter-dev` documentation](https://github.com/ioBroker/adapter-dev#compile-adapter-files).

### Writing tests

When done right, testing code is invaluable, because it gives you the
confidence to change your code while knowing exactly if and when
something breaks. A good read on the topic of test-driven development
is https://hackernoon.com/introduction-to-test-driven-development-tdd-61a13bc92d92.
Although writing tests before the code might seem strange at first, but it has very
clear upsides.

The template provides you with basic tests for the adapter startup and package files.
It is recommended that you add your own tests into the mix.

### Publishing the adapter

Using GitHub Actions, you can enable automatic releases on npm whenever you push a new git tag that matches the form
`v<major>.<minor>.<patch>`. We **strongly recommend** that you do. The necessary steps are described in `.github/workflows/test-and-release.yml`.

To get your adapter released in ioBroker, please refer to the documentation
of [ioBroker.repositories](https://github.com/ioBroker/ioBroker.repositories#requirements-for-adapter-to-get-added-to-the-latest-repository).

### Test the adapter manually with dev-server

Since you set up `dev-server`, you can use it to run, test and debug your adapter.

You may start `dev-server` by calling from your dev directory:

```bash
dev-server watch
```

The ioBroker.admin interface will then be available at http://localhost:8083/

Please refer to the [`dev-server` documentation](https://github.com/ioBroker/dev-server#command-line) for more details.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (Sven-83) Super E10 prices of two stations from Tankerkönig with own 7-day price memory, rating and cheapest time
- (Sven-83) Easee chargers via the observations API: status, power, energy, costs, start/stop
- (Sven-83) Easee real-time values via the SignalR stream, polling as fallback
- (Sven-83) Ford vehicles via FordConnect Query: browser login per vehicle, telemetry (not yet tested live)
- (Sven-83) Ford: hint for login error AADB2C90085 (shared vehicle access); admin >= 7.6.20

### 0.0.1

- (Sven-83) initial release

## License

MIT License

Copyright (c) 2026 Sven-83 <276080681+Sven-83@users.noreply.github.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

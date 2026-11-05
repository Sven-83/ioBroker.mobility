// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Fuel prices on/off */
            fuelEnabled: boolean;
            /** Tankerkoenig API key (encryptedNative + protectedNative) */
            fuelApiKey: string;
            /** Station 1: display name and Tankerkoenig ID */
            fuelStation1Name: string;
            fuelStation1Id: string;
            /** Station 2: display name and Tankerkoenig ID */
            fuelStation2Name: string;
            fuelStation2Id: string;
            /** Poll interval in minutes (5-60) */
            fuelInterval: number;
            /** Easee chargers on/off */
            easeeEnabled: boolean;
            /** Easee account (e-mail or phone number) */
            easeeUser: string;
            /** Easee password (encryptedNative + protectedNative) */
            easeePassword: string;
            /** Easee poll interval in seconds (30-600) */
            easeeInterval: number;
            /** Electricity price for the charging costs in EUR/kWh */
            easeePrice: number;
            /** Use the Easee SignalR real-time stream */
            easeeStream: boolean;
            /** Name of charger 1 in the Easee app (only selected chargers are used) */
            easeeCharger1: string;
            /** Name of charger 2 in the Easee app */
            easeeCharger2: string;
            /** Ford vehicles on/off */
            fordEnabled: boolean;
            /** App client ID from the Ford developer portal */
            fordClientId: string;
            /** App client secret (encryptedNative + protectedNative) */
            fordClientSecret: string;
            /** Redirect URI registered in the portal */
            fordRedirectUri: string;
            /** Poll interval in minutes (5-60) */
            fordInterval: number;
            /** Name of vehicle 1 (empty = unused) */
            fordVehicle1Name: string;
            /** Name of vehicle 2 (empty = unused) */
            fordVehicle2Name: string;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};

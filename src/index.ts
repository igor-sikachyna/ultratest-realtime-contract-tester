import { HTTP_API } from '@ultraos/ultratest/apis/http';
import * as api from '@ultraos/ultratest/apis/pluginApi';
import { Plugin, argsToParams, collectFromPluginAndTestMethods } from '@ultraos/ultratest/interfaces/plugin';
import { UltraTest, UltraTestAPI } from '@ultraos/ultratest/interfaces/test';
import { config, keychain } from '@ultraos/ultratest/services';
import { logger } from '@ultraos/ultratest/utility';
import { SystemAPI, system } from 'ultratest-system-plugin/system';
import { ABI, Serializer } from '@wharfkit/antelope';
import * as fs from 'fs';
import path from 'path';
import * as crypto from 'crypto';
import * as stream from 'stream/promises';

export interface MonitoredContract {
    account: string;
    contract?: string;
    abiPath?: string;
    wasmPath?: string;
    abiLastModifiedTimestamp?: number;
    wasmLastModifiedTimestamp?: number;
}

abstract class RealtimeContractTesterTest extends UltraTest {
    abstract monitorContracts(): Array<MonitoredContract>;;
}

export class RealtimeContractTesterAPI {
    private logger: typeof logger;
    private api: HTTP_API;

    constructor(ultra: UltraTestAPI, customNodeos: api.INodeos = undefined) {
        this.api = ultra.api;
        this.logger = ultra.logger;
        if (customNodeos) this.api = new HTTP_API(customNodeos);
    }

    private collectWasmAndAbi(testPath: string, monitored: MonitoredContract[]) {
        for (let i = 0; i < monitored.length; i++) {
            if (monitored[i].contract && !monitored[i].abiPath && !monitored[i].wasmPath) {
                const dirCont = fs.readdirSync(path.join(path.dirname(testPath), monitored[i].contract));
                let foundAbi = false;
                let foundWasm = false;
                for (let file of dirCont) {
                    if (file.match(/.*\.(abi)$/gi)) {
                        if (foundAbi) {
                            throw new Error(`Found multiple ABIs at ${monitored[i].contract}. Either ensure there is only 1 or specify .abiPath manually`);
                        }
                        foundAbi = true;
                        monitored[i].abiPath = path.join(path.dirname(testPath), monitored[i].contract, file);
                    }
                    if (file.match(/.*\.(wasm)$/gi)) {
                        if (foundWasm) {
                            throw new Error(`Found multiple WASMs at ${monitored[i].contract}. Either ensure there is only 1 or specify .wasmPath manually`);
                        }
                        foundWasm = true;
                        monitored[i].wasmPath = path.join(path.dirname(testPath), monitored[i].contract, file);
                    }
                }
            }
        }
        return monitored;
    }

    async computeHash(filepath) {
        const input = fs.createReadStream(filepath);
        const hash = crypto.createHash('sha256');
        
        // Connect the output of the `input` stream to the input of `hash`
        // and let Node.js do the streaming
        await stream.pipeline(input, hash);
      
        return hash.digest('hex');
    }

    private getDiff(monitored: MonitoredContract[]): MonitoredContract[] {
        let result: MonitoredContract[] = [];
        for (let i = 0; i < monitored.length; i++) {
            let updateAbi = false;
            let updateWasm = false;
            if (monitored[i].abiPath) {
                let stat = fs.statSync(monitored[i].abiPath);
                updateAbi = monitored[i].abiLastModifiedTimestamp !== stat.mtimeMs;
                monitored[i].abiLastModifiedTimestamp = stat.mtimeMs;
            }
            if (monitored[i].wasmPath) {
                let stat = fs.statSync(monitored[i].wasmPath);
                updateWasm = monitored[i].wasmLastModifiedTimestamp !== stat.mtimeMs;
                monitored[i].wasmLastModifiedTimestamp = stat.mtimeMs;
            }

            if (updateAbi || updateWasm) {
                result.push({
                    account: monitored[i].account,
                    abiPath: updateAbi ? monitored[i].abiPath : null,
                    wasmPath: updateWasm ? monitored[i].wasmPath : null
                });
            }
        }
        return result;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async setAbiAndWasm(ultra: UltraTestAPI, account: string, abiPath?: string, wasmPath?: string) {
        const actions: Array<{
            account: string;
            name: string;
            authorization: { actor: string; permission: string }[];
            data: any;
        }> = [];

        if (wasmPath) {
            const wasm = fs.readFileSync(wasmPath).toString(`hex`);

            actions.push({
                account: 'eosio',
                name: 'setcode',
                authorization: [{actor: account, permission: 'active'}],
                data: {
                    account,
                    vmtype: 0,
                    vmversion: 0,
                    code: wasm,
                },
            });
        }

        if (abiPath) {
            let abi = JSON.parse(fs.readFileSync(abiPath, `utf8`));
            const encoded = Serializer.encode({ object: ABI.from(abi) });
            let abiHex = Buffer.from(encoded.array).toString(`hex`);

            actions.push({
                account: 'eosio',
                name: 'setabi',
                authorization: [{actor: account, permission: 'active'}],
                data: {
                    account,
                    abi: abiHex,
                },
            });
        }

        return await ultra.api.transact(actions);
    }

    public async runTests(ultra: UltraTestAPI, tests: { [key: string]: Function }) {
        let monitored: MonitoredContract[] = [];
        let func = (<RealtimeContractTesterTest>ultra.activeTestState.file).monitorContracts;
        if (func) {
            monitored = func();
        }
        monitored = this.collectWasmAndAbi(ultra.activeTestState.filePath, monitored);

        // Get initial difference to initialize timestamps
        this.getDiff(monitored);

        let runForever = config.configData.testsPath.endsWith('.ts') && monitored.length > 0;
        if (runForever) {
            logger.log(`> Running tets repeatedly`, 'green');
        } else {
            logger.log(`> Running tets once`, 'green');
        }

        let snapshotCounter = 0;
        do {
            // Create a snapshot to revert to
            let snapshot = await ultra.activeTestState.snapshot(`realtime-tester-${snapshotCounter}`);
            snapshotCounter++;
            logger.log(`✔ Created a snapshot`, 'green');

            // Run all the tests
            let allPassed = true;
            for (let key of Object.keys(tests)) {
                const testName = key;
                const testFunc = tests[key];

                try {
                    await testFunc();
                    logger.log(`✔ ${testName}`, 'green', 2);
                } catch (err) {
                    allPassed = false;
                    logger.log(`✗ ${testName}`, 'red', 2);
                    logger.error(err);
                }
            }

            // Wait for smart contract update
            if (runForever) {
                let diff = await this.getDiff(monitored);
                logger.log(`> Waiting for smart contracts to be modified`, 'green', 1);
                while(diff.length === 0) {
                    await this.sleep(1000);
                    diff = await this.getDiff(monitored);
                }

                // Revert to the last snapshot
                await ultra.activeTestState.restore(snapshot);

                logger.log(`✔ Restored from snapshot`, 'green');

                // Update smart contracts
                for (let i = 0; i < diff.length; i++) {
                    await this.setAbiAndWasm(ultra, diff[i].account, diff[i].abiPath, diff[i].wasmPath);
                    logger.log(`✔ Refreshed ${diff[i].account}`, 'green');
                }

                await this.sleep(1000 * ultra.activeTestState.nodeosInstances.length);

                logger.log(`> Repeating tests`, 'green');
            }
        } while (runForever)
    }
}
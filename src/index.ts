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

interface MonitoredFile {
    file: string;
    lastModifiedTimestamp?: number;
}

abstract class RealtimeContractTesterTest extends UltraTest {
    abstract monitorContracts(): Array<MonitoredContract>;
    abstract monitorFiles(): Array<string>;
}

export class RealtimeContractTesterAPI {
    private logger: typeof logger;
    private api: HTTP_API;

    constructor(ultra: UltraTestAPI, customNodeos: api.INodeos = undefined) {
        this.api = ultra.api;
        this.logger = ultra.logger;
        if (customNodeos) this.api = new HTTP_API(customNodeos);
    }

    private fixPath(testPath: string, filePath: string) {
        // Don't touch absolute path
        if (path.isAbsolute(filePath)) return filePath;
        return path.join(path.dirname(testPath), filePath)
    }

    private collectWasmAndAbi(testPath: string, monitored: MonitoredContract[]) {
        for (let i = 0; i < monitored.length; i++) {
            if (monitored[i].contract && !monitored[i].abiPath && !monitored[i].wasmPath) {
                const dirCont = fs.readdirSync(this.fixPath(testPath, monitored[i].contract));
                let foundAbi = false;
                let foundWasm = false;
                for (let file of dirCont) {
                    if (file.match(/.*\.(abi)$/gi)) {
                        if (foundAbi) {
                            throw new Error(`Found multiple ABIs at ${monitored[i].contract}. Either ensure there is only 1 or specify .abiPath manually`);
                        }
                        foundAbi = true;
                        monitored[i].abiPath = path.join(this.fixPath(testPath, path.join(monitored[i].contract, file)));
                    }
                    if (file.match(/.*\.(wasm)$/gi)) {
                        if (foundWasm) {
                            throw new Error(`Found multiple WASMs at ${monitored[i].contract}. Either ensure there is only 1 or specify .wasmPath manually`);
                        }
                        foundWasm = true;
                        monitored[i].wasmPath = path.join(this.fixPath(testPath, path.join(monitored[i].contract, file)));
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

    private getDiffContracts(monitored: MonitoredContract[]): MonitoredContract[] {
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

    private getDiffFiles(monitored: MonitoredFile[]): MonitoredFile[] {
        let result: MonitoredFile[] = [];
        for (let i = 0; i < monitored.length; i++) {
            if (fs.existsSync(monitored[i].file)) {
                let stat = fs.statSync(monitored[i].file);
                if (monitored[i].lastModifiedTimestamp !== stat.mtimeMs) {
                    result.push(monitored[i]);
                }
                monitored[i].lastModifiedTimestamp = stat.mtimeMs;
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

    private async runTestsGroup(ultra: UltraTestAPI, tests: { [key: string]: Function } | string) {
        let testCases: { [key: string]: Function } = {};
        if (typeof tests === 'string') {
            try {
                // Use require instead of import to have ability to delete cache
                let module = this.fixPath(ultra.activeTestState.filePath, tests);
                delete require.cache[module];
                testCases = require(module)(ultra);
            } catch (e) {
                logger.error(e);
                testCases = {};
            }
        } else {
            testCases = tests;
        }

        return await this.runTestCases(testCases);
    }

    private async runTestCases(testCases: { [key: string]: Function }) {
        logger.setIndentation(2);
        for (let key of Object.keys(testCases)) {
            const testName = key;
            const testFunc = testCases[key];

            try {
                await testFunc();
                logger.log(`✔ ${testName}`, 'green', 2);
            } catch (err) {
                logger.log(`✗ ${testName}`, 'red', 2);
                logger.error(err);
            }
        }
    }

    public async runTests(ultra: UltraTestAPI, tests: { [key: string]: Function } | string | string[]) {
        let monitoredContracts: MonitoredContract[] = [];
        let monitoredFiles: MonitoredFile[] = [];
        let func = (<RealtimeContractTesterTest>ultra.activeTestState.file).monitorContracts;
        if (func) {
            monitoredContracts = func();
        }
        let func2 = (<RealtimeContractTesterTest>ultra.activeTestState.file).monitorFiles;
        if (func2) {
            monitoredFiles = func2().map((f) => {return {file: this.fixPath(ultra.activeTestState.filePath, f)}});
        }

        // Add test cases files to the list of tracked files
        if (typeof tests === 'string') {
            let module = this.fixPath(ultra.activeTestState.filePath, tests);
            if (!monitoredFiles.find((f) => f.file === module)) {
                monitoredFiles.push({file: module});
            }
        }
        if (Array.isArray(tests)) {
            for (let t of tests) {
                let module = this.fixPath(ultra.activeTestState.filePath, t);
                if (!monitoredFiles.find((f) => f.file === module)) {
                    monitoredFiles.push({file: module});
                }
            }
        }

        monitoredContracts = this.collectWasmAndAbi(ultra.activeTestState.filePath, monitoredContracts);

        for (let i = 0; i < monitoredContracts.length; i++) {
            if (monitoredContracts[i].abiPath) logger.log(`> Monitoring: ${monitoredContracts[i].abiPath}`, 'green');
            if (monitoredContracts[i].wasmPath) logger.log(`> Monitoring: ${monitoredContracts[i].wasmPath}`, 'green');
        }
        for (let i = 0; i < monitoredFiles.length; i++) {
            logger.log(`> Monitoring: ${monitoredFiles[i].file}`, 'green');
            if (!fs.existsSync(monitoredFiles[i].file)) {
                logger.log(`> Monitored file ${monitoredFiles[i].file} does not currently exist`, 'yellow');
            }
        }

        // Get initial difference to initialize timestamps
        this.getDiffContracts(monitoredContracts);
        this.getDiffFiles(monitoredFiles);

        let runForever = config.configData.testsPath.endsWith('.ts') && (monitoredContracts.length > 0 || monitoredFiles.length > 0);
        if (runForever) {
            logger.log(`> Running tets repeatedly`, 'green');
        } else {
            logger.log(`> Running tets once`, 'green');
        }

        let snapshotCounter = 0;
        let needSnapshot = true;
        let lastSnapshot;
        do {
            // Create a snapshot to revert to
            if (needSnapshot) {
                lastSnapshot = await ultra.activeTestState.snapshot(`realtime-tester-${snapshotCounter}`);
                snapshotCounter++;
                logger.log(`✔ Created a snapshot`, 'green');
            }

            if (Array.isArray(tests)) {
                for (let t of tests) {
                    await this.runTestsGroup(ultra, t);
                }
            } else {
                await this.runTestsGroup(ultra, tests);
            }

            // Wait for smart contract or file update
            if (runForever) {
                let diffContracts = await this.getDiffContracts(monitoredContracts);
                let diffFiles = await this.getDiffFiles(monitoredFiles);
                logger.log(`> Waiting for smart contracts or files to be modified`, 'green', 1);
                while(diffContracts.length === 0 && diffFiles.length === 0) {
                    await this.sleep(1000);
                    diffContracts = await this.getDiffContracts(monitoredContracts);
                    diffFiles = await this.getDiffFiles(monitoredFiles);

                    // Snapshot is only needed if smart contract was updated
                    // Otherwise there should be no new transactions to warrant a snapshot
                    needSnapshot = false;
                    if (diffContracts.length > 0) {
                        needSnapshot = true;
                    }
                }

                // Revert to the last snapshot
                await ultra.activeTestState.restore(lastSnapshot);

                logger.log(`✔ Restored from snapshot`, 'green');

                // Update smart contracts
                for (let i = 0; i < diffContracts.length; i++) {
                    await this.setAbiAndWasm(ultra, diffContracts[i].account, diffContracts[i].abiPath, diffContracts[i].wasmPath);
                    logger.log(`✔ Refreshed ${diffContracts[i].account}`, 'green');
                }

                // The additional delay helps prevent duplicate snapshot hashes
                // Obviously not needed if we won't create a snapshot
                if (needSnapshot) {
                    await this.sleep(1000 * ultra.activeTestState.nodeosInstances.length);
                }

                logger.log(`> Repeating tests`, 'green');
            }
        } while (runForever)
    }
}
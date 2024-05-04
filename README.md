# ultratest Realtime Contract Tester

## What this is

This plugin allows you to run your test cases repeatedly each time you recompile your smart contract.

This means you can save some time on test initialization and you don't need to invoke the `ultratest` command again!

## How to install

Add this repository to the `ultratestPlugins` of your tests `package.json` like so:

```json
"ultratestPlugins": {

    ...

    "ultratest-realtime-contract-tester": {
        "url": "git@github.com:igor-sikachyna/ultratest-realtime-contract-tester.git",
        "ref": "master"
    }
}
```

The next time you run your tests this plugin will be automatically downloaded.

## How to use

The basics to get the plugin to pick up the changes in smart contracts are as follows:

1. Import the interface provided by the plugin

```ts
import { RealtimeContractTesterAPI } from 'ultratest-realtime-contract-tester'
```

2. Ensure that your contract is deployed first and provide the information about your contract to the plugin

```ts
// This requires ultraContracts plugin
// You can use other means to deploy your contract like putting it before using the API from the tester
// Your contract must exist already before use use the API from this plugin
requiredContracts() {
    return [{
        account: '1aa2aa3aa4aa',
        contract: '../src'
    }];
}

// Here you need to provide the file path of your contract that will be monitored for changes
// You can also manually specify abiPath and wasmPath in case there are multiple in the same directory
// Otherwise you can use the contract property
monitorContracts() {
    return [{
        account: '1aa2aa3aa4aa',
        contract: '../src'
    }];
}
```

3. Wrap your tests around the method provided by the plugin

```ts
async tests(ultra: UltraTestAPI) {
    const tester = new RealtimeContractTesterAPI(ultra);

    await tester.runTests(ultra, {
        'My test 1': async () => {
            ...
        },
        'My test 2': async () => {
            ...
        }
    });

    return {};
}
```

4. Run a single test file which uses this plugin. If you run tests from a directory the plugin will only do them once and will not be checking for contract changes

```sh
ultratest -t ./mytest.spec.ts
```

5. To stop the tester use the `Ctrl+C` or its equivalent for your system

## How it works

The plugin will periodically check the modification date of the ABI and WASM files and will revert to an older snapshot, redeploy the contract and run the tests again if any of the tracked contracts are updated.

Since it effectively runs in the infinite loop it makes no sense to run multiple test files with this plugin and as such it will only serve its intended purpose if you run a single test.

When you run the test with this plugin it will report if any of the test cases fail:

```
Cases: 

    > Running tets repeatedly
    ✔ Created a snapshot
        ✔ Push transaction
    > Waiting for smart contracts to be modified
    ✔ Restored from snapshot
    ✔ Refreshed 1aa2aa3aa4aa
    > Repeating tests
    ✔ Created a snapshot
        ✔ Push transaction
    > Waiting for smart contracts to be modified
    ✔ Restored from snapshot
    ✔ Refreshed 1aa2aa3aa4aa
    > Repeating tests
    ✔ Created a snapshot
        ✗ Push transaction
        Error: failed to push transaction
            at Push transaction ...
    > Waiting for smart contracts to be modified
```
# ultratest Realtime Contract Tester

## What this is

This plugin allows you to run your test cases repeatedly each time you recompile your smart contract.

This means you can save some time on test initialization and you don't need to invoke the `ultratest` command again!

It also provides functionality to hot reload test cases.

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

4. Run a single test file which uses this plugin. If you run tests from a directory the plugin will only do them once and will not be checking for contract changes (so it will NOT re-run with `-t ./directory` or if there is no `-t` argument at all)

```sh
ultratest -t ./mytest.spec.ts
```

5. To stop the tester use the `Ctrl+C` or its equivalent for your system

Note that smart contract WASM/ABI must already exist for the plugin to work!

## How to track other types of files

In addition to smart contract files you can track arbitrary file changes. To do so use the `monitorFiles` method:

```ts
monitorFiles() {
    return ['data.json', '/home/user/transaciton.json'];
}
```

The plugin will run your test cases again when ANY of the files is modified.

Files can be missing when you start the tests and will be tracked as soon as they appear.

Note that relative `~/` home paths are not supported!

## How to hot reload tests

Argument for test cases of `runTests` can be replaced with a path to a `.ts` file containing a module export with test cases you want to run like so:

```ts
await tester.runTests(ultra, './testCases.ts');
```

The contents of `testCases.ts` should look similar to this:

```ts
import { UltraTestAPI } from '@ultraos/ultratest/interfaces/test';

module.exports = ((ultra: UltraTestAPI) => {
    return {
        'Print hello': async() => {
            ultra.logger.log('hello');
        }
    };
});
```

The requirement is that there should be a `module.exports` providing a single function that accepts only a single argument. The same `ultra: UltraTestAPI` will be provided here just like for your regular test cases.

Now if you run the test any time you make a change to the test cases file it will re-import it and run the tests again:

```
    > Monitoring: /home/.../tests/testCases.ts
    > Running tets repeatedly
    ✔ Created a snapshot
        hello
        ✔ Print hello
    > Waiting for smart contracts or files to be modified
    ✔ Restored from snapshot
    > Repeating tests
        hello 2
        ✔ Print hello 2
    > Waiting for smart contracts or files to be modified
```

You don't have to provide file names in `monitorFiles` for the tracking to work, these source files will be automatically be added to the tracking list.

You can also provide an array of test cases files instead of a single file:

```ts
await tester.runTests(ultra, ['./action1_tests.ts', './action2_tests.ts']);
```

Note that the test cases file must already exist before you run the plugin!

## How it works

The plugin will periodically check the modification date of the ABI and WASM files and will revert to an older snapshot, redeploy the contract and run the tests again if any of the tracked contracts are updated.

Since it effectively runs in the infinite loop it makes no sense to run multiple test files with this plugin and as such it will only serve its intended purpose if you run a single test.

When you run the test with this plugin it will report if any of the test cases fail:

```
Cases: 

    > Monitoring: /home/.../src/main.abi
    > Monitoring: /home/.../src/main.wasm
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

When hot reloading test cases the plugin will use `require()` syntax to be able to delete the cache later. This is required for this feature to work. If your test cases cannot be written in a way that supports being able to be loaded through `require()` then you won't be able to use this feature.
# Lodestar ETH2.0 API

[![Discord](https://img.shields.io/discord/593655374469660673.svg?label=Discord&logo=discord)](https://discord.gg/aMxzVcr)
![ETH2.0_Spec_Version 1.0.0](https://img.shields.io/badge/ETH2.0_Spec_Version-1.0.0-2e86c1.svg)
![ES Version](https://img.shields.io/badge/ES-2020-yellow)
![Node Version](https://img.shields.io/badge/node-12.x-green)

> This package is part of [ChainSafe's Lodestar](https://lodestar.chainsafe.io) project

Typescript REST client for the [Eth2.0 API spec](https://ethereum.github.io/eth2.0-APIs/)

## Usage

```typescript
import {getClient} from "@chainsafe/lodestar-api";
import {config} from "@chainsafe/lodestar-config/default";

const api = getClient(config, {
  baseUrl: "http://localhost:9596",
});

api.beacon.getStateValidator(
  "head",
  "0x933ad9491b62059dd065b560d256d8957a8c402cc6e8d8ee7290ae11e8f7329267a8811c397529dac52ae1342ba58c95"
).then((res) => console.log("Your balance is:", res.data.balance));
```

## Prerequisites

- [Lerna](https://github.com/lerna/lerna)
- [Yarn](https://yarnpkg.com/)

## What you need

You will need to go over the [specification](https://github.com/ethereum/eth2.0-specs). You will also need to have a [basic understanding of sharding](https://github.com/ethereum/wiki/wiki/Sharding-FAQs).

## Getting started

- Follow the [installation guide](https://chainsafe.github.io/lodestar/installation) to install Lodestar.
- Quickly try out the whole stack by [starting a local testnet](https://chainsafe.github.io/lodestar/usage).
- View the [typedoc code docs](https://chainsafe.github.io/lodestar/packages).

## Contributors

Read our [contributors document](/CONTRIBUTING.md), [submit an issue](https://github.com/ChainSafe/lodestar/issues/new/choose) or talk to us on our [discord](https://discord.gg/yjyvFRP)!

## License

Apache-2.0 [ChainSafe Systems](https://chainsafe.io)

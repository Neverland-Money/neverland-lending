# Neverland Lending Core

<p>
  <a href="./README.md"><img src="https://img.shields.io/badge/Neverland%20Lending-v1.0.0%20%C2%B7%20Upstream%20Aave%20core--v3%20v1.19.3%20%C2%B7%20Node%2022%20%C2%B7-192170?style=for-the-badge" alt="Neverland Lending v1.0.0 - Aave core-v3 v1.19.3 - Node 22"/></a>
</p>

Core Solidity contracts and generated TypeScript bindings for the Neverland lending protocol.

This repository starts from `@aave/core-v3` version `1.19.3` and is maintained by Neverland as the canonical core-contract package for downstream Neverland lending deployments and integrations. Upstream Aave licensing, attribution, and notices are preserved where they apply.

## Package

The package is prepared for publication as:

```bash
npm install @neverland-money/lending-core
```

The published package includes:

- `contracts/`: Solidity sources.
- `artifacts/`: Hardhat artifacts with ABI and bytecode.
- `types/`: TypeChain bindings.
- `dist/`: compiled helper exports.

Example Solidity import:

```solidity
import { IPool } from '@neverland-money/lending-core/contracts/interfaces/IPool.sol';

contract Example {
  function supply(address pool, address token, address user, uint256 amount) external {
    IPool(pool).supply(token, amount, user, 0);
  }
}
```

Example artifact import:

```js
const PoolArtifact = require('@neverland-money/lending-core/artifacts/contracts/protocol/pool/Pool.sol/Pool.json');

console.log(PoolArtifact.abi);
```

## Neverland Changes

The initial Neverland setup keeps the Aave V3 core architecture intact while adding Neverland token price-observation behavior directly to the canonical token implementations:

- `AToken` emits `PriceObserved` on supply, transfer, withdraw, and liquidation-transfer paths.
- `VariableDebtToken` emits `PriceObserved` on variable borrow and repay paths.
- `PriceEmitter` centralizes the event and oracle-read helper.
- Token implementation revisions are bumped so upgrades can distinguish the Neverland implementations from the upstream base.

Neverland-specific tests live under `test-suites/neverland/`.

## Development

Use Node `22.18.0` via `.nvmrc`.

```bash
nvm use
npm install
npm run compile
npm run build
npm test
```

Useful focused commands:

```bash
npm run compile:clean
npx hardhat test test-suites/__setup.spec.ts test-suites/neverland/price-emitter.spec.ts
npm run prettier:check
```

## Layout

- `contracts/protocol/`: core protocol contracts and token implementations.
- `contracts/interfaces/`: public protocol interfaces.
- `contracts/mocks/`: test and upgradeability mocks.
- `helpers/`: TypeScript helpers used by tests and scripts.
- `test-suites/`: upstream Aave V3 tests plus Neverland-specific tests.
- `artifacts/`, `types/`, `dist/`: generated package outputs.

## Upstream Provenance

This package is derived from:

- Package: `@aave/core-v3`
- Version: `1.19.3`
- Repository: [aave/aave-v3-core](https://github.com/aave/aave-v3-core)

For the original upstream README retained from the base package, see [README_UPSTREAM.md](./README_UPSTREAM.md).

## License And Notices

See [LICENSE.md](./LICENSE.md). Solidity sources retain their original SPDX headers where applicable. This repository preserves upstream Aave licensing and attribution while documenting Neverland-maintained changes in package metadata and source history.

<p>
  <a href="https://neverland.money"><img src="https://img.shields.io/badge/Website-neverland.money-480052?style=for-the-badge&logo=safari&logoColor=white" height="22" alt="Website"/></a>
  <a href="https://app.neverland.money"><img src="https://img.shields.io/badge/App-app.neverland.money-192170?style=for-the-badge&logo=ethereum&logoColor=white" height="22" alt="App"/></a>
  <a href="https://x.com/Neverland_Money"><img src="https://img.shields.io/badge/%F0%9D%95%8F-%40Neverland__Money-1DA1F2?style=for-the-badge" height="22" alt="X"/></a>
  <a href="https://discord.com/invite/neverland"><img src="https://img.shields.io/badge/Discord-Join%20Server-5865F2?style=for-the-badge&logo=discord&logoColor=white" height="22" alt="Discord"/></a>
</p>

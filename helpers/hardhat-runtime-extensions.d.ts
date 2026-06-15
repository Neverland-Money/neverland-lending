// Hardhat Runtime Environment type augmentation for the published library build.
//
// `hardhat.config.ts` is intentionally excluded from `lib.tsconfig.json` so the
// published `dist/` never `require()`s the Hardhat plugin devDependencies at
// runtime. That config was, however, also what made the `hre.ethers`
// augmentation visible to `helpers/*` during type-checking (it imports
// `@nomicfoundation/hardhat-toolbox`, which pulls in `@nomiclabs/hardhat-ethers`).
// This declaration restores the same augmentation type-only: tsc emits no JS for
// a `.d.ts`, so nothing is added to the package's runtime dependency surface.
import '@nomicfoundation/hardhat-toolbox';

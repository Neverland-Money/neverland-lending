import fs from 'fs';
import path from 'path';

interface Artifact {
  deployedBytecode?: string;
}

const artifactsDir = process.argv[2] || 'artifacts';
const EIP170_LIMIT = 24576;
const MIN_HEADROOM = 500;

const contracts = [
  'contracts/protocol/libraries/logic/BorrowLogic.sol/BorrowLogic.json',
  'contracts/protocol/libraries/logic/SupplyLogic.sol/SupplyLogic.json',
  'contracts/protocol/libraries/logic/LiquidationLogic.sol/LiquidationLogic.json',
  'contracts/protocol/libraries/logic/FlashLoanLogic.sol/FlashLoanLogic.json',
  'contracts/protocol/libraries/logic/PoolLogic.sol/PoolLogic.json',
  'contracts/protocol/libraries/logic/EModeLogic.sol/EModeLogic.json',
  'contracts/protocol/libraries/logic/ValidationLogic.sol/ValidationLogic.json',
  'contracts/protocol/libraries/logic/GenericLogic.sol/GenericLogic.json',
  'contracts/protocol/libraries/logic/ReserveLogic.sol/ReserveLogic.json',
  'contracts/protocol/libraries/logic/BridgeLogic.sol/BridgeLogic.json',
  'contracts/protocol/pool/Pool.sol/Pool.json',
  'contracts/protocol/tokenization/AToken.sol/AToken.json',
  'contracts/protocol/tokenization/VariableDebtToken.sol/VariableDebtToken.json',
];

console.log('EIP-170 Size Check (limit: 24,576 bytes)\n');
console.log('Library / Contract'.padEnd(35), '| Size'.padEnd(12), '| Headroom');
console.log('-'.repeat(70));

let maxSize = 0;
let maxName = '';
let failed = false;

for (const contract of contracts) {
  const fullPath = path.join(artifactsDir, contract);
  if (!fs.existsSync(fullPath)) {
    console.log(contract.padEnd(35), '| NOT FOUND'.padEnd(12), '| -');
    failed = true;
    continue;
  }

  let size;
  try {
    const artifact = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as Artifact;
    if (typeof artifact.deployedBytecode !== 'string') {
      throw new Error('artifact.deployedBytecode is missing or not a string');
    }
    size = (artifact.deployedBytecode.length - 2) / 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Invalid artifact ${fullPath}: ${message}`);
    failed = true;
    continue;
  }

  const headroom = EIP170_LIMIT - size;
  const name = path.basename(contract, '.json');
  console.log(name.padEnd(35), `| ${size}B`.padEnd(12), `| ${headroom}B`);

  if (size > EIP170_LIMIT || headroom < MIN_HEADROOM) failed = true;
  if (size > maxSize) {
    maxSize = size;
    maxName = name;
  }
}

console.log(`\nMax size: ${maxName} at ${maxSize}B (headroom: ${EIP170_LIMIT - maxSize}B)`);

if (failed) process.exit(1);

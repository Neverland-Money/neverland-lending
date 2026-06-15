#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const packageJsonPath = path.join(root, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const requiredFiles = ['contracts', 'artifacts', 'types', 'dist'];
const requiredExportKeys = [
  '.',
  './types',
  './types/*',
  './artifacts/*',
  './contracts/*',
  './dist/*',
  './package.json',
];
const requiredRuntimeDependencies = ['eth-sig-util', 'ethereumjs-util', 'ethers'];

const tokenChecks = [
  {
    name: 'AToken',
    sourcePath: 'contracts/protocol/tokenization/AToken.sol',
    artifactPath: 'artifacts/contracts/protocol/tokenization/AToken.sol/AToken.json',
    debugPath: 'artifacts/contracts/protocol/tokenization/AToken.sol/AToken.dbg.json',
    requiresPriceEmitter: true,
    initializeInputs: [
      'address:initializingPool',
      'address:treasury',
      'address:underlyingAsset',
      'address:incentivesController',
      'uint8:aTokenDecimals',
      'string:aTokenName',
      'string:aTokenSymbol',
      'bytes:params',
    ],
  },
  {
    name: 'DelegationAwareAToken',
    sourcePath: 'contracts/protocol/tokenization/DelegationAwareAToken.sol',
    artifactPath:
      'artifacts/contracts/protocol/tokenization/DelegationAwareAToken.sol/DelegationAwareAToken.json',
    debugPath:
      'artifacts/contracts/protocol/tokenization/DelegationAwareAToken.sol/DelegationAwareAToken.dbg.json',
    requiresPriceEmitter: false,
    initializeInputs: [
      'address:initializingPool',
      'address:treasury',
      'address:underlyingAsset',
      'address:incentivesController',
      'uint8:aTokenDecimals',
      'string:aTokenName',
      'string:aTokenSymbol',
      'bytes:params',
    ],
  },
  {
    name: 'StableDebtToken',
    sourcePath: 'contracts/protocol/tokenization/StableDebtToken.sol',
    artifactPath:
      'artifacts/contracts/protocol/tokenization/StableDebtToken.sol/StableDebtToken.json',
    debugPath:
      'artifacts/contracts/protocol/tokenization/StableDebtToken.sol/StableDebtToken.dbg.json',
    requiresPriceEmitter: false,
    initializeInputs: [
      'address:initializingPool',
      'address:underlyingAsset',
      'address:incentivesController',
      'uint8:debtTokenDecimals',
      'string:debtTokenName',
      'string:debtTokenSymbol',
      'bytes:params',
    ],
  },
  {
    name: 'VariableDebtToken',
    sourcePath: 'contracts/protocol/tokenization/VariableDebtToken.sol',
    artifactPath:
      'artifacts/contracts/protocol/tokenization/VariableDebtToken.sol/VariableDebtToken.json',
    debugPath:
      'artifacts/contracts/protocol/tokenization/VariableDebtToken.sol/VariableDebtToken.dbg.json',
    requiresPriceEmitter: true,
    initializeInputs: [
      'address:initializingPool',
      'address:underlyingAsset',
      'address:incentivesController',
      'uint8:debtTokenDecimals',
      'string:debtTokenName',
      'string:debtTokenSymbol',
      'bytes:params',
    ],
  },
];

const issues = [];

const fail = (message) => issues.push(message);

const resolveRoot = (relativePath) => path.resolve(root, relativePath);

const exists = (relativePath) => fs.existsSync(resolveRoot(relativePath));

const readJson = (relativePath) => JSON.parse(fs.readFileSync(resolveRoot(relativePath), 'utf8'));

const stripDotSlash = (value) => value.replace(/^\.\//, '');

const toPackagePath = (absolutePath) => path.relative(root, absolutePath).split(path.sep).join('/');

const listFiles = (relativeDir, predicate) => {
  const dir = resolveRoot(relativeDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const results = [];
  const walk = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!predicate || predicate(absolutePath)) {
        results.push(toPackagePath(absolutePath));
      }
    }
  };

  walk(dir);
  return results.sort();
};

const buildInfoCache = new Map();

const readBuildInfo = (debugPath, buildInfoReference) => {
  const buildInfoPath = path.resolve(path.dirname(resolveRoot(debugPath)), buildInfoReference);
  if (!fs.existsSync(buildInfoPath)) {
    return { buildInfoPath, buildInfo: undefined };
  }

  const packageBuildInfoPath = toPackagePath(buildInfoPath);
  if (!buildInfoCache.has(packageBuildInfoPath)) {
    buildInfoCache.set(packageBuildInfoPath, JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')));
  }

  return {
    buildInfoPath,
    packageBuildInfoPath,
    buildInfo: buildInfoCache.get(packageBuildInfoPath),
  };
};

const checkExportTarget = (exportKey, field, target) => {
  if (!target) {
    fail(`exports.${exportKey}.${field} is missing`);
    return;
  }

  const normalized = stripDotSlash(target);
  if (normalized.includes('*')) {
    const base = normalized.slice(0, normalized.indexOf('*'));
    const suffix = normalized.slice(normalized.indexOf('*') + 1);
    if (exportKey === './types/*' && field === 'types' && suffix !== '.d.ts') {
      fail(`exports.${exportKey}.${field} wildcard must target .d.ts files: ${target}`);
    }
    if (
      exportKey === './types/*' &&
      (field === 'require' || field === 'default') &&
      suffix !== '.js'
    ) {
      fail(`exports.${exportKey}.${field} wildcard must target .js files: ${target}`);
    }
    if (!fs.existsSync(resolveRoot(base))) {
      fail(`exports.${exportKey}.${field} base path does not exist: ${target}`);
    }
    return;
  }

  if (!exists(normalized)) {
    fail(`exports.${exportKey}.${field} path does not exist: ${target}`);
  }
};

if (packageJson.name !== '@neverland-money/lending-core') {
  fail(`unexpected package name ${packageJson.name}`);
}

if (packageJson.version === '1.0.0') {
  fail(
    'package version is still 1.0.0; publish metadata/artifact changes under a new immutable version'
  );
}

const requiredPackScript = 'npm run compile:clean && npm run build && npm run verify:package';
if (packageJson.scripts?.prepack !== requiredPackScript) {
  fail(`package.json prepack must be "${requiredPackScript}"`);
}
if (packageJson.scripts?.prepublishOnly !== 'npm run verify:package') {
  fail('package.json prepublishOnly must run verify:package');
}

for (const dependencyName of requiredRuntimeDependencies) {
  if (!packageJson.dependencies?.[dependencyName]) {
    fail(`package.json dependencies missing runtime dependency ${dependencyName}`);
  }
  if (packageJson.devDependencies?.[dependencyName]) {
    fail(`${dependencyName} must not be dev-only because exported JS requires it at runtime`);
  }
}

if (exists('package-lock.json')) {
  const packageLock = readJson('package-lock.json');
  const rootPackage = packageLock.packages?.[''];
  if (packageLock.version !== packageJson.version || rootPackage?.version !== packageJson.version) {
    fail('package-lock.json root version does not match package.json version');
  }
  for (const dependencyName of requiredRuntimeDependencies) {
    if (!rootPackage?.dependencies?.[dependencyName]) {
      fail(`package-lock.json root dependencies missing ${dependencyName}`);
    }
  }
}

for (const file of requiredFiles) {
  if (!packageJson.files?.includes(file)) {
    fail(`package files does not include ${file}`);
  }
}

if (!packageJson.types) {
  fail('package.json missing top-level types field');
} else {
  checkExportTarget('package', 'types', packageJson.types);
}

for (const key of requiredExportKeys) {
  if (!Object.prototype.hasOwnProperty.call(packageJson.exports || {}, key)) {
    fail(`package.json missing exports entry ${key}`);
  }
}

for (const [key, value] of Object.entries(packageJson.exports || {})) {
  if (typeof value === 'string') {
    checkExportTarget(key, 'default', value);
    continue;
  }

  if (value && typeof value === 'object') {
    if ('types' in value) checkExportTarget(key, 'types', value.types);
    if ('require' in value) checkExportTarget(key, 'require', value.require);
    if ('default' in value) checkExportTarget(key, 'default', value.default);
  }
}

const artifactPaths = listFiles(
  'artifacts/contracts',
  (absolutePath) => absolutePath.endsWith('.json') && !absolutePath.endsWith('.dbg.json')
);

if (!artifactPaths.length) {
  fail('no contract artifacts found under artifacts/contracts');
}

for (const artifactPath of artifactPaths) {
  const artifact = readJson(artifactPath);
  const debugPath = artifactPath.replace(/\.json$/, '.dbg.json');

  if (!artifact.contractName) {
    fail(`${artifactPath} missing contractName`);
  }
  if (!artifact.sourceName) {
    fail(`${artifactPath} missing sourceName`);
    continue;
  }
  if (!exists(artifact.sourceName)) {
    fail(`${artifactPath} source is missing: ${artifact.sourceName}`);
    continue;
  }
  if (!exists(debugPath)) {
    fail(`${artifactPath} debug artifact is missing: ${debugPath}`);
    continue;
  }

  const debugArtifact = readJson(debugPath);
  if (!debugArtifact.buildInfo) {
    fail(`${debugPath} does not reference build-info`);
    continue;
  }

  const { buildInfoPath, packageBuildInfoPath, buildInfo } = readBuildInfo(
    debugPath,
    debugArtifact.buildInfo
  );
  if (!buildInfo) {
    fail(`${artifactPath} build-info is missing: ${buildInfoPath}`);
    continue;
  }

  const source = fs.readFileSync(resolveRoot(artifact.sourceName), 'utf8');
  const buildInfoSource = buildInfo.input?.sources?.[artifact.sourceName]?.content;
  if (buildInfoSource !== source) {
    fail(
      `${artifactPath} source ${artifact.sourceName} does not match packaged build-info ${packageBuildInfoPath}`
    );
  }
}

for (const token of tokenChecks) {
  if (!exists(token.sourcePath)) {
    fail(`${token.name} source is missing: ${token.sourcePath}`);
    continue;
  }
  if (!exists(token.artifactPath)) {
    fail(`${token.name} artifact is missing: ${token.artifactPath}`);
    continue;
  }
  if (!exists(token.debugPath)) {
    fail(`${token.name} debug artifact is missing: ${token.debugPath}`);
    continue;
  }

  const source = fs.readFileSync(resolveRoot(token.sourcePath), 'utf8');
  const artifact = readJson(token.artifactPath);
  const debugArtifact = readJson(token.debugPath);

  if (artifact.contractName !== token.name) {
    fail(`${token.name} artifact has contractName=${artifact.contractName || 'missing'}`);
  }
  if (artifact.sourceName !== token.sourcePath) {
    fail(`${token.name} artifact has sourceName=${artifact.sourceName || 'missing'}`);
  }
  if (!artifact.bytecode || artifact.bytecode === '0x') {
    fail(`${token.name} artifact has empty bytecode`);
  }
  if (!artifact.deployedBytecode || artifact.deployedBytecode === '0x') {
    fail(`${token.name} artifact has empty deployedBytecode`);
  }

  const abiIncludesPriceObserved = artifact.abi?.some(
    (entry) => entry.type === 'event' && entry.name === 'PriceObserved'
  );
  const initialize = artifact.abi?.find(
    (entry) => entry.type === 'function' && entry.name === 'initialize'
  );
  const initializeInputs = initialize?.inputs?.map((input) => `${input.type}:${input.name}`) || [];
  const sourceUsesPriceEmitter = source.includes('PriceEmitter') && source.includes('emitPrice(');
  const sourceMentionsLegacyPE =
    source.includes('ATokenPE') || source.includes('VariableDebtTokenPE');

  if (token.requiresPriceEmitter && !abiIncludesPriceObserved) {
    fail(`${token.name} ABI does not include PriceObserved`);
  }
  if (token.requiresPriceEmitter && !sourceUsesPriceEmitter) {
    fail(`${token.name} source does not use PriceEmitter emitPrice hooks`);
  }
  if (sourceMentionsLegacyPE) {
    fail(`${token.name} source includes legacy PE identifiers`);
  }
  if (JSON.stringify(initializeInputs) !== JSON.stringify(token.initializeInputs)) {
    fail(`${token.name} initialize ABI does not match the expected canonical token shape`);
  }

  if (!debugArtifact.buildInfo) {
    fail(`${token.name} debug artifact does not reference build-info`);
    continue;
  }

  const { buildInfoPath, buildInfo } = readBuildInfo(token.debugPath, debugArtifact.buildInfo);
  if (!buildInfo) {
    fail(`${token.name} build-info is missing: ${buildInfoPath}`);
    continue;
  }

  const buildInfoSource = buildInfo.input?.sources?.[token.sourcePath]?.content;
  if (buildInfoSource !== source) {
    fail(`${token.name} source does not match packaged build-info input`);
  }
}

if (issues.length > 0) {
  console.error('Package release verification failed:');
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Package release verification passed for ${packageJson.name}@${packageJson.version}`);

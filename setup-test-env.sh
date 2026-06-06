#!/bin/bash

# @dev
# This bash script sets up the needed artifacts to use
# the @aave/deploy-v3 package as source of deployment
# scripts for testing or coverage purposes.
#
# A separate artifacts directory was created
# because running tests deletes external artifacts
# located at /artifacts, causing
# the deploy library to not find the external
# artifacts.

echo "[BASH] Setting up testnet environment"

# Export market variables before compilation, because Hardhat config reads them
# while loading deployment tasks and market configuration.
export MARKET_NAME="Test"
export ENABLE_REWARDS="false"

if [ "$SKIP_TEST_SETUP_COMPILE" = true ]; then
    echo "[BASH] Reusing existing compilation artifacts"
elif [ ! "$COVERAGE" = true ]; then
    # remove hardhat and artifacts cache
    npm run ci:clean

    # compile @aave/core-v3 contracts
    npm run compile
else
    echo "[BASH] Skipping compilation to keep coverage artifacts"
fi

# Copy artifacts into separate directory to allow
# the hardhat-deploy library load all artifacts without duplicates
mkdir -p temp-artifacts
cp -r artifacts/* temp-artifacts

# Import external @aave/periphery artifacts
mkdir -p temp-artifacts/periphery
cp -r node_modules/@aave/periphery-v3/artifacts/contracts/* temp-artifacts/periphery

# Import external @aave/deploy artifacts
mkdir -p temp-artifacts/deploy
cp -r node_modules/@aave/deploy-v3/artifacts/contracts/* temp-artifacts/deploy
if [ -d node_modules/@aave/deploy-v3/artifacts/@aave/safety-module ]; then
    mkdir -p temp-artifacts/deploy/@aave
    cp -r node_modules/@aave/deploy-v3/artifacts/@aave/safety-module temp-artifacts/deploy/@aave
fi

echo "[BASH] Testnet environment ready"

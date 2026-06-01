import { expect } from 'chai';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const repoFile = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

const upstreamRoot = dirname(require.resolve('@aave/core-v3/package.json'));
const upstreamFile = (relativePath: string) =>
  readFileSync(join(upstreamRoot, relativePath), 'utf8');

describe('Neverland rounding patch baseline diff', () => {
  it('anchors the comparison to Aave core v1.19.3', () => {
    const upstreamPackage = JSON.parse(
      readFileSync(require.resolve('@aave/core-v3/package.json'), 'utf8')
    );

    expect(upstreamPackage.version).to.eq('1.19.3');
  });

  it('replaces token half-up scaled accounting with directional token math', () => {
    const upstreamAToken = upstreamFile('contracts/protocol/tokenization/AToken.sol');
    const upstreamVariableDebtToken = upstreamFile(
      'contracts/protocol/tokenization/VariableDebtToken.sol'
    );
    const targetAToken = repoFile('contracts/protocol/tokenization/AToken.sol');
    const targetVariableDebtToken = repoFile(
      'contracts/protocol/tokenization/VariableDebtToken.sol'
    );

    expect(upstreamAToken).to.include('super.balanceOf(user).rayMul');
    expect(upstreamAToken).to.include(
      'emit BalanceTransfer(from, to, amount.rayDiv(index), index)'
    );
    expect(targetAToken).to.include('TokenMath.getATokenBalance');
    expect(targetAToken).to.include('TokenMath.getATokenTransferScaledAmount');
    expect(targetAToken).to.not.include('amount.rayDiv(index)');

    expect(upstreamVariableDebtToken).to.include('scaledBalance.rayMul');
    expect(targetVariableDebtToken).to.include('TokenMath.getVTokenBalance');
    expect(targetVariableDebtToken).to.include('TokenMath.getVTokenMintScaledAmount');
    expect(targetVariableDebtToken).to.include('TokenMath.getVTokenBurnScaledAmount');
  });

  it('uses explicit rounding directions in reserve, treasury, validation, and flashloan paths', () => {
    const upstreamPoolLogic = upstreamFile('contracts/protocol/libraries/logic/PoolLogic.sol');
    const upstreamValidationLogic = upstreamFile(
      'contracts/protocol/libraries/logic/ValidationLogic.sol'
    );
    const upstreamFlashLoanLogic = upstreamFile(
      'contracts/protocol/libraries/logic/FlashLoanLogic.sol'
    );

    const targetPoolLogic = repoFile('contracts/protocol/libraries/logic/PoolLogic.sol');
    const targetValidationLogic = repoFile(
      'contracts/protocol/libraries/logic/ValidationLogic.sol'
    );
    const targetFlashLoanLogic = repoFile('contracts/protocol/libraries/logic/FlashLoanLogic.sol');

    expect(upstreamPoolLogic).to.include('uint256 amountToMint = accruedToTreasury.rayMul');
    expect(targetPoolLogic).to.include('accruedToTreasury.rayMulCeil');
    expect(targetPoolLogic).to.include('accruedToTreasury.getATokenBalance');

    expect(upstreamValidationLogic).to.include('.percentDiv(vars.currentLtv)');
    expect(targetValidationLogic).to.include('.percentDivCeil(vars.currentLtv)');

    expect(upstreamFlashLoanLogic).to.include('params.amount.percentMul');
    expect(targetFlashLoanLogic).to.include('params.amount.percentMulCeil');
    expect(targetFlashLoanLogic).to.include('.getATokenMintScaledAmount');
  });

  it('keeps liquidation rounding and dust-guard surfaces explicit', () => {
    const upstreamLiquidationLogic = upstreamFile(
      'contracts/protocol/libraries/logic/LiquidationLogic.sol'
    );
    const targetLiquidationLogic = repoFile(
      'contracts/protocol/libraries/logic/LiquidationLogic.sol'
    );

    expect(upstreamLiquidationLogic).to.include('percentMul(liquidationBonus)');
    expect(upstreamLiquidationLogic).to.include('percentDiv(liquidationBonus)');
    expect(targetLiquidationLogic).to.include('percentMulFloor(liquidationBonus)');
    expect(targetLiquidationLogic).to.include('percentDivCeil(liquidationBonus)');
    expect(targetLiquidationLogic).to.include('percentDivFloor(liquidationBonus)');
    expect(targetLiquidationLogic).to.include('percentMulCeil(');

    expect(targetLiquidationLogic).to.include('getVTokenBurnScaledAmount');
    expect(targetLiquidationLogic).to.include('params.debtToCover >= vars.userVariableDebt');
    expect(targetLiquidationLogic).to.include('vars.actualDebtToLiquidate = vars.userVariableDebt');
    expect(targetLiquidationLogic).to.include('realizedDebtRepaid');
    expect(targetLiquidationLogic).to.include('scaledBalanceOf(params.user) == 0');
  });

  it('keeps portal and bridge entry points disabled in the canonical Pool runtime', () => {
    const upstreamPool = upstreamFile('contracts/protocol/pool/Pool.sol');
    const targetPool = repoFile('contracts/protocol/pool/Pool.sol');

    expect(upstreamPool).to.include('import {BridgeLogic}');
    expect(upstreamPool).to.include('BridgeLogic.executeMintUnbacked');
    expect(upstreamPool).to.include('BridgeLogic.executeBackUnbacked');

    expect(targetPool).to.not.include('import {BridgeLogic}');
    expect(targetPool).to.not.include('BridgeLogic.executeMintUnbacked');
    expect(targetPool).to.not.include('BridgeLogic.executeBackUnbacked');
    expect(targetPool).to.include('Neverland: portal/bridge disabled');
  });

  it('keeps stable-rate execution disabled at every retained ABI entrypoint', () => {
    const targetBorrowLogic = repoFile('contracts/protocol/libraries/logic/BorrowLogic.sol');

    expect(targetBorrowLogic).to.not.include('IStableDebtToken');
    expect(targetBorrowLogic).to.match(
      /function executeBorrow\([\s\S]+?params\.interestRateMode == DataTypes\.InterestRateMode\.STABLE[\s\S]{0,120}revert\(Errors\.STABLE_BORROWING_NOT_ENABLED\);/
    );
    expect(targetBorrowLogic).to.match(
      /function executeRepay\([\s\S]+?params\.interestRateMode == DataTypes\.InterestRateMode\.STABLE[\s\S]{0,120}revert\(Errors\.STABLE_BORROWING_NOT_ENABLED\);/
    );
    expect(targetBorrowLogic).to.match(
      /function executeRebalanceStableBorrowRate\([\s\S]+?\) external pure \{[\s\S]{0,80}revert\(Errors\.STABLE_BORROWING_NOT_ENABLED\);/
    );
    expect(targetBorrowLogic).to.match(
      /function executeSwapBorrowRateMode\([\s\S]+?\) external pure \{[\s\S]{0,80}revert\(Errors\.STABLE_BORROWING_NOT_ENABLED\);/
    );
    expect(
      (targetBorrowLogic.match(/revert\(Errors\.STABLE_BORROWING_NOT_ENABLED\);/g) || []).length
    ).to.be.gte(4);
  });

  it('keeps eMode and flashloan debt-mode solvency checks on fresh state', () => {
    const targetEModeLogic = repoFile('contracts/protocol/libraries/logic/EModeLogic.sol');
    const targetFlashLoanLogic = repoFile('contracts/protocol/libraries/logic/FlashLoanLogic.sol');

    expect(targetEModeLogic).to.include('if (prevCategoryId == params.categoryId)');
    expect(targetEModeLogic).to.include('usersEModeCategory[msg.sender] = params.categoryId');
    expect(targetEModeLogic).to.include('ValidationLogic.validateHealthFactor');
    expect(targetEModeLogic).to.not.include('prevCategoryId != 0');

    expect(targetFlashLoanLogic).to.include('.getUserEMode(params.onBehalfOf)');
    expect(targetFlashLoanLogic).to.match(
      /vars\.receiver\.executeOperation[\s\S]+?vars\.userEModeCategory = IPool/
    );
    expect(targetFlashLoanLogic).to.include('userEModeCategory: vars.userEModeCategory');
  });

  it('keeps liquidation eligibility tied to the user collateral flag, not standalone LT', () => {
    const targetValidationLogic = repoFile(
      'contracts/protocol/libraries/logic/ValidationLogic.sol'
    );

    expect(targetValidationLogic).to.include(
      'userConfig.isUsingAsCollateral(collateralReserve.id)'
    );
    expect(targetValidationLogic).to.not.include(
      'collateralReserve.configuration.getLiquidationThreshold() != 0 &&'
    );
  });

  it('keeps protocol-favoring base-currency valuation and borrow validation helpers', () => {
    const targetGenericLogic = repoFile('contracts/protocol/libraries/logic/GenericLogic.sol');
    const targetValidationLogic = repoFile(
      'contracts/protocol/libraries/logic/ValidationLogic.sol'
    );

    expect(targetGenericLogic).to.include(
      'uint256 normalizedIncome = reserve.getNormalizedIncome()'
    );
    expect(targetGenericLogic).to.match(/getATokenBalance\(\s*normalizedIncome\s*\)/);
    expect(targetGenericLogic).to.include('.getVTokenBalance(reserve.getNormalizedDebt())');
    expect(targetGenericLogic).to.include(
      'return productDebt % assetUnit == 0 ? quotient : quotient + 1'
    );

    expect(targetValidationLogic).to.include(
      '(userScaledVariableDebt + vars.amountScaled).getVTokenBalance'
    );
    expect(targetValidationLogic).to.include('function _ceilMulDiv');
    expect(targetValidationLogic).to.include(
      'return product % denominator == 0 ? quotient : quotient + 1'
    );
  });
});

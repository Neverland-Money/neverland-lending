// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.10;

import {GPv2SafeERC20} from '../../../dependencies/gnosis/contracts/GPv2SafeERC20.sol';
import {SafeCast} from '../../../dependencies/openzeppelin/contracts/SafeCast.sol';
import {IERC20} from '../../../dependencies/openzeppelin/contracts/IERC20.sol';
import {IVariableDebtToken} from '../../../interfaces/IVariableDebtToken.sol';
import {IAToken} from '../../../interfaces/IAToken.sol';
import {IPool} from '../../../interfaces/IPool.sol';
import {UserConfiguration} from '../configuration/UserConfiguration.sol';
import {ReserveConfiguration} from '../configuration/ReserveConfiguration.sol';
import {Helpers} from '../helpers/Helpers.sol';
import {Errors} from '../helpers/Errors.sol';
import {DataTypes} from '../types/DataTypes.sol';
import {ValidationLogic} from './ValidationLogic.sol';
import {ReserveLogic} from './ReserveLogic.sol';
import {IsolationModeLogic} from './IsolationModeLogic.sol';

interface IATokenPoolGetter {
  function POOL() external view returns (IPool);
}

/**
 * @title BorrowLogic library
 * @author Aave
 * @notice Implements the base logic for all the actions related to borrowing
 */
library BorrowLogic {
  using ReserveLogic for DataTypes.ReserveCache;
  using ReserveLogic for DataTypes.ReserveData;
  using GPv2SafeERC20 for IERC20;
  using UserConfiguration for DataTypes.UserConfigurationMap;
  using ReserveConfiguration for DataTypes.ReserveConfigurationMap;
  using SafeCast for uint256;

  uint256 internal constant HEALTH_FACTOR_LIQUIDATION_THRESHOLD = 1e18;

  // See `IPool` for descriptions
  event Borrow(
    address indexed reserve,
    address user,
    address indexed onBehalfOf,
    uint256 amount,
    DataTypes.InterestRateMode interestRateMode,
    uint256 borrowRate,
    uint16 indexed referralCode
  );
  event Repay(
    address indexed reserve,
    address indexed user,
    address indexed repayer,
    uint256 amount,
    bool useATokens
  );
  event RebalanceStableBorrowRate(address indexed reserve, address indexed user);
  event SwapBorrowRateMode(
    address indexed reserve,
    address indexed user,
    DataTypes.InterestRateMode interestRateMode
  );
  event IsolationModeTotalDebtUpdated(address indexed asset, uint256 totalDebt);
  event ReserveUsedAsCollateralDisabled(address indexed reserve, address indexed user);

  /**
   * @notice Implements the borrow feature. Borrowing allows users that provided collateral to draw liquidity from the
   * Aave protocol proportionally to their collateralization power. For isolated positions, it also increases the
   * isolated debt.
   * @dev  Emits the `Borrow()` event
   * @param reservesData The state of all the reserves
   * @param reservesList The addresses of all the active reserves
   * @param eModeCategories The configuration of all the efficiency mode categories
   * @param userConfig The user configuration mapping that tracks the supplied/borrowed assets
   * @param params The additional parameters needed to execute the borrow function
   */
  function executeBorrow(
    mapping(address => DataTypes.ReserveData) storage reservesData,
    mapping(uint256 => address) storage reservesList,
    mapping(uint8 => DataTypes.EModeCategory) storage eModeCategories,
    DataTypes.UserConfigurationMap storage userConfig,
    DataTypes.ExecuteBorrowParams memory params
  ) public {
    DataTypes.ReserveData storage reserve = reservesData[params.asset];
    DataTypes.ReserveCache memory reserveCache = reserve.cache();
    uint16 cachedReserveId = reserve.id;

    reserve.updateState(reserveCache);

    if (
      reserveCache.variableDebtTokenAddress != address(0) &&
      !userConfig.isBorrowing(cachedReserveId) &&
      IERC20(reserveCache.variableDebtTokenAddress).balanceOf(params.onBehalfOf) != 0
    ) {
      userConfig.setBorrowing(cachedReserveId, true);
    }

    (
      bool isolationModeActive,
      address isolationModeCollateralAddress,
      uint256 isolationModeDebtCeiling
    ) = userConfig.getIsolationModeState(reservesData, reservesList);

    ValidationLogic.validateBorrow(
      reservesData,
      reservesList,
      eModeCategories,
      DataTypes.ValidateBorrowParams({
        reserveCache: reserveCache,
        userConfig: userConfig,
        asset: params.asset,
        userAddress: params.onBehalfOf,
        amount: params.amount,
        interestRateMode: params.interestRateMode,
        maxStableLoanPercent: params.maxStableRateBorrowSizePercent,
        reservesCount: params.reservesCount,
        oracle: params.oracle,
        userEModeCategory: params.userEModeCategory,
        priceOracleSentinel: params.priceOracleSentinel,
        isolationModeActive: isolationModeActive,
        isolationModeCollateralAddress: isolationModeCollateralAddress,
        isolationModeDebtCeiling: isolationModeDebtCeiling
      })
    );

    if (params.interestRateMode == DataTypes.InterestRateMode.STABLE) {
      revert(Errors.STABLE_BORROWING_NOT_ENABLED);
    } else {
      {
        uint256 preMintVariableDebt = isolationModeActive
          ? IERC20(reserveCache.variableDebtTokenAddress).balanceOf(params.onBehalfOf)
          : 0;
        (, reserveCache.nextScaledVariableDebt) = IVariableDebtToken(
          reserveCache.variableDebtTokenAddress
        ).mint(params.user, params.onBehalfOf, params.amount, reserveCache.nextVariableBorrowIndex);
        if (!userConfig.isBorrowing(cachedReserveId)) {
          userConfig.setBorrowing(cachedReserveId, true);
        }
        if (isolationModeActive) {
          uint256 realizedIncrease = IERC20(reserveCache.variableDebtTokenAddress).balanceOf(
            params.onBehalfOf
          ) - preMintVariableDebt;
          _bumpIsolationModeTotalDebt(
            reservesData,
            reserveCache,
            realizedIncrease,
            isolationModeCollateralAddress
          );
        }
      }
    }

    reserve.updateInterestRates(
      reserveCache,
      params.asset,
      0,
      params.releaseUnderlying ? params.amount : 0
    );

    if (params.releaseUnderlying) {
      IAToken(reserveCache.aTokenAddress).transferUnderlyingTo(params.user, params.amount);
    }

    emit Borrow(
      params.asset,
      params.user,
      params.onBehalfOf,
      params.amount,
      params.interestRateMode,
      reserve.currentVariableBorrowRate,
      params.referralCode
    );
  }

  /**
   * @notice Implements the repay feature. Repaying transfers the underlying back to the aToken and clears the
   * equivalent amount of debt for the user by burning the corresponding debt token. For isolated positions, it also
   * reduces the isolated debt.
   * @dev  Emits the `Repay()` event
   * @param reservesData The state of all the reserves
   * @param reservesList The addresses of all the active reserves
   * @param userConfig The user configuration mapping that tracks the supplied/borrowed assets
   * @param params The additional parameters needed to execute the repay function
   * @return The actual amount being repaid
   */
  function executeRepay(
    mapping(address => DataTypes.ReserveData) storage reservesData,
    mapping(uint256 => address) storage reservesList,
    DataTypes.UserConfigurationMap storage userConfig,
    DataTypes.ExecuteRepayParams memory params
  ) external returns (uint256) {
    DataTypes.ReserveData storage reserve = reservesData[params.asset];
    DataTypes.ReserveCache memory reserveCache = reserve.cache();
    reserve.updateState(reserveCache);

    if (params.interestRateMode == DataTypes.InterestRateMode.STABLE) {
      revert(Errors.STABLE_BORROWING_NOT_ENABLED);
    }

    (uint256 stableDebt, uint256 variableDebt) = Helpers.getUserCurrentDebt(
      params.onBehalfOf,
      reserveCache
    );

    ValidationLogic.validateRepay(
      reserveCache,
      params.amount,
      params.interestRateMode,
      params.onBehalfOf,
      stableDebt,
      variableDebt
    );

    uint256 paybackAmount = variableDebt;

    uint256 aTokenBalance;
    if (params.useATokens) {
      aTokenBalance = IAToken(reserveCache.aTokenAddress).balanceOf(msg.sender);
      if (params.amount == type(uint256).max) {
        params.amount = aTokenBalance;
      }
    }

    if (params.amount < paybackAmount) {
      paybackAmount = params.amount;
    }

    if (params.useATokens) {
      if (paybackAmount > aTokenBalance) {
        paybackAmount = aTokenBalance;
      }
    }
    require(paybackAmount != 0, Errors.INVALID_AMOUNT);

    reserveCache.nextScaledVariableDebt = IVariableDebtToken(reserveCache.variableDebtTokenAddress)
      .burn(params.onBehalfOf, paybackAmount, reserveCache.nextVariableBorrowIndex);

    reserve.updateInterestRates(
      reserveCache,
      params.asset,
      params.useATokens ? 0 : paybackAmount,
      0
    );

    uint256 variableDebtAfter = IERC20(reserveCache.variableDebtTokenAddress).balanceOf(
      params.onBehalfOf
    );
    uint256 stableDebtAfter = IERC20(reserveCache.stableDebtTokenAddress).balanceOf(
      params.onBehalfOf
    );
    if (stableDebtAfter + variableDebtAfter == 0) {
      userConfig.setBorrowing(reserve.id, false);
    }

    {
      uint256 realizedRepay = variableDebt - variableDebtAfter;

      IsolationModeLogic.updateIsolatedDebtIfIsolated(
        reservesData,
        reservesList,
        userConfig,
        reserveCache,
        realizedRepay
      );
    }

    if (params.useATokens) {
      bool wasUsingAsCollateral = userConfig.isUsingAsCollateral(reserve.id);
      IAToken(reserveCache.aTokenAddress).burn(
        msg.sender,
        reserveCache.aTokenAddress,
        paybackAmount,
        reserveCache.nextLiquidityIndex
      );
      if (
        wasUsingAsCollateral && IAToken(reserveCache.aTokenAddress).scaledBalanceOf(msg.sender) == 0
      ) {
        userConfig.setUsingAsCollateral(reserve.id, false);
        address asset = params.asset;
        emit ReserveUsedAsCollateralDisabled(asset, msg.sender);
      }
      if (wasUsingAsCollateral && userConfig.isBorrowingAny()) {
        _validatePostATokenRepayHealthFactor(reserveCache.aTokenAddress, params.onBehalfOf);
      }
    } else {
      IERC20(params.asset).safeTransferFrom(msg.sender, reserveCache.aTokenAddress, paybackAmount);
      IAToken(reserveCache.aTokenAddress).handleRepayment(
        msg.sender,
        params.onBehalfOf,
        paybackAmount
      );
    }

    emit Repay(params.asset, params.onBehalfOf, msg.sender, paybackAmount, params.useATokens);

    return paybackAmount;
  }

  function _validatePostATokenRepayHealthFactor(address aToken, address user) private view {
    (, , , , , uint256 healthFactor) = IATokenPoolGetter(aToken).POOL().getUserAccountData(user);
    require(
      healthFactor >= HEALTH_FACTOR_LIQUIDATION_THRESHOLD,
      Errors.HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD
    );
  }

  /// @notice Stable-rate rebalancing is disabled in this release.
  function executeRebalanceStableBorrowRate(
    DataTypes.ReserveData storage,
    address,
    address
  ) external pure {
    revert(Errors.STABLE_BORROWING_NOT_ENABLED);
  }

  /// @notice Stable-rate mode swaps are disabled in this release.
  function executeSwapBorrowRateMode(
    DataTypes.ReserveData storage,
    DataTypes.UserConfigurationMap storage,
    address,
    DataTypes.InterestRateMode
  ) external pure {
    revert(Errors.STABLE_BORROWING_NOT_ENABLED);
  }

  function _bumpIsolationModeTotalDebt(
    mapping(address => DataTypes.ReserveData) storage reservesData,
    DataTypes.ReserveCache memory reserveCache,
    uint256 isolationDebtIncrease,
    address isolationModeCollateralAddress
  ) private {
    uint256 nextIsolationModeTotalDebt = reservesData[isolationModeCollateralAddress]
      .isolationModeTotalDebt += (isolationDebtIncrease /
      10 **
        (reserveCache.reserveConfiguration.getDecimals() -
          ReserveConfiguration.DEBT_CEILING_DECIMALS)).toUint128();
    emit IsolationModeTotalDebtUpdated(isolationModeCollateralAddress, nextIsolationModeTotalDebt);
  }
}

// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.10;

import {ReserveLogic} from '../protocol/libraries/logic/ReserveLogic.sol';
import {DataTypes} from '../protocol/libraries/types/DataTypes.sol';

contract ReserveLogicHarness {
  DataTypes.ReserveData private _reserve;

  function accrueToTreasury(
    uint256 currScaledVariableDebt,
    uint256 currVariableBorrowIndex,
    uint256 nextVariableBorrowIndex,
    uint256 nextLiquidityIndex,
    uint256 reserveFactor
  ) external returns (uint256) {
    delete _reserve;

    DataTypes.ReserveCache memory cache;
    cache.currScaledVariableDebt = currScaledVariableDebt;
    cache.currVariableBorrowIndex = currVariableBorrowIndex;
    cache.nextVariableBorrowIndex = nextVariableBorrowIndex;
    cache.nextLiquidityIndex = nextLiquidityIndex;
    cache.reserveFactor = reserveFactor;
    cache.stableDebtLastUpdateTimestamp = uint40(block.timestamp);
    cache.reserveLastUpdateTimestamp = uint40(block.timestamp);

    ReserveLogic._accrueToTreasury(_reserve, cache);
    return _reserve.accruedToTreasury;
  }
}

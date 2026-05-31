// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.10;

import {IPool} from '../../../interfaces/IPool.sol';
import {IPoolAddressesProvider} from '../../../interfaces/IPoolAddressesProvider.sol';
import {IPriceOracleGetter} from '../../../interfaces/IPriceOracleGetter.sol';

/**
 * @title PriceEmitter
 * @author Neverland
 * @notice Emits best-effort oracle price observations for token accounting actions.
 * @dev The Pool and addresses provider are trusted protocol dependencies. After the
 *      oracle address is resolved, oracle reads use try/catch so read failures do not
 *      block the token action. Logs are reverted if the guarded action reverts. `ok`
 *      only reports whether `getAssetPrice(asset)` succeeded.
 */
abstract contract PriceEmitter {
  /// @dev Unified action codes across Neverland price emitters.
  uint8 internal constant ACTION_SUPPLY = 1;
  uint8 internal constant ACTION_BORROW = 2;
  uint8 internal constant ACTION_REPAY = 3;
  uint8 internal constant ACTION_FLASHLOAN = 4;
  uint8 internal constant ACTION_FLASHLOAN_SIMPLE = 5;
  uint8 internal constant ACTION_LIQUIDATION = 6;
  uint8 internal constant ACTION_WITHDRAW = 7;
  uint8 internal constant ACTION_ATOKEN_TRANSFER = 8;

  /**
   * @notice Emitted with a best-effort oracle price sample before a token action continues.
   * @param asset The reserve asset whose price was observed.
   * @param price The returned oracle price, or zero if the price read failed.
   * @param baseUnit The returned oracle base currency unit, or zero if unavailable or the read failed.
   * @param oracle The oracle address resolved from the Pool addresses provider.
   * @param action The Neverland action code associated with the token operation.
   * @param ok True when `getAssetPrice(asset)` returned successfully.
   * @param user The account associated with the observed action.
   * @param timestamp The block timestamp of the observation.
   */
  event PriceObserved(
    address indexed asset,
    uint256 price,
    uint256 baseUnit,
    address indexed oracle,
    uint8 action,
    bool ok,
    address indexed user,
    uint256 timestamp
  );

  /**
   * @notice Emits a price observation before running the guarded function body.
   * @param pool The Pool used to resolve the addresses provider and oracle.
   * @param asset The reserve asset to price.
   * @param action The Neverland action code for the token operation.
   * @param user The account associated with the operation.
   */
  modifier emitPrice(
    IPool pool,
    address asset,
    uint8 action,
    address user
  ) {
    _emitAssetPrice(pool, asset, action, user);
    _;
  }

  /**
   * @notice Resolves the configured oracle and emits a best-effort price observation.
   * @param pool The Pool used to resolve the addresses provider and oracle.
   * @param asset The reserve asset to price.
   * @param action The Neverland action code for the token operation.
   * @param user The account associated with the operation.
   */
  function _emitAssetPrice(IPool pool, address asset, uint8 action, address user) internal {
    address oracleAddr = IPoolAddressesProvider(pool.ADDRESSES_PROVIDER()).getPriceOracle();
    uint256 baseUnit = 0;
    uint256 price = 0;
    bool ok = false;
    if (oracleAddr != address(0)) {
      IPriceOracleGetter oracle = IPriceOracleGetter(oracleAddr);

      try oracle.BASE_CURRENCY_UNIT() returns (uint256 unit) {
        baseUnit = unit;
      } catch {}

      try oracle.getAssetPrice(asset) returns (uint256 p) {
        price = p;
        ok = true;
      } catch {}
    }

    emit PriceObserved(asset, price, baseUnit, oracleAddr, action, ok, user, block.timestamp);
  }
}

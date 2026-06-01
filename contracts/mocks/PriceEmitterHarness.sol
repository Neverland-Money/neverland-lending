// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.10;

import {IPool} from '../interfaces/IPool.sol';
import {IPoolAddressesProvider} from '../interfaces/IPoolAddressesProvider.sol';
import {IPriceOracleGetter} from '../interfaces/IPriceOracleGetter.sol';
import {PriceEmitter} from '../protocol/tokenization/base/PriceEmitter.sol';

contract PriceEmitterHarness is PriceEmitter {
  function emitAssetPrice(IPool pool, address asset, uint8 action, address user) external {
    _emitAssetPrice(pool, asset, action, user);
  }
}

contract MockPriceEmitterPool {
  IPoolAddressesProvider private _provider;
  bool private _revertProvider;

  constructor(IPoolAddressesProvider provider) {
    _provider = provider;
  }

  function setRevertProvider(bool revertProvider) external {
    _revertProvider = revertProvider;
  }

  function ADDRESSES_PROVIDER() external view returns (IPoolAddressesProvider) {
    require(!_revertProvider, 'PROVIDER_REVERT');
    return _provider;
  }
}

contract MockPriceEmitterAddressesProvider {
  address private _oracle;
  bool private _revertOracle;

  function setPriceOracle(address oracle) external {
    _oracle = oracle;
  }

  function setRevertOracle(bool revertOracle) external {
    _revertOracle = revertOracle;
  }

  function getPriceOracle() external view returns (address) {
    require(!_revertOracle, 'ORACLE_REVERT');
    return _oracle;
  }
}

contract MockPriceEmitterOracle is IPriceOracleGetter {
  uint256 private _price = 123;
  uint256 private _baseUnit = 1e8;
  bool private _revertPrice;

  function setRevertPrice(bool revertPrice) external {
    _revertPrice = revertPrice;
  }

  function BASE_CURRENCY() external pure returns (address) {
    return address(0);
  }

  function BASE_CURRENCY_UNIT() external view returns (uint256) {
    return _baseUnit;
  }

  function getAssetPrice(address) external view returns (uint256) {
    require(!_revertPrice, 'PRICE_REVERT');
    return _price;
  }
}

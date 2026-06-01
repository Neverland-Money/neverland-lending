// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.10;

import {IERC20} from '../../dependencies/openzeppelin/contracts/IERC20.sol';
import {SafeCast} from '../../dependencies/openzeppelin/contracts/SafeCast.sol';
import {VersionedInitializable} from '../libraries/aave-upgradeability/VersionedInitializable.sol';
import {Errors} from '../libraries/helpers/Errors.sol';
import {TokenMath} from '../libraries/helpers/TokenMath.sol';
import {IPool} from '../../interfaces/IPool.sol';
import {IAaveIncentivesController} from '../../interfaces/IAaveIncentivesController.sol';
import {IInitializableDebtToken} from '../../interfaces/IInitializableDebtToken.sol';
import {IVariableDebtToken} from '../../interfaces/IVariableDebtToken.sol';
import {EIP712Base} from './base/EIP712Base.sol';
import {DebtTokenBase} from './base/DebtTokenBase.sol';
import {ScaledBalanceTokenBase} from './base/ScaledBalanceTokenBase.sol';
import {PriceEmitter} from './base/PriceEmitter.sol';

/**
 * @title VariableDebtToken
 * @author Aave
 * @notice Implements a variable debt token to track the borrowing positions of users
 * at variable rate mode
 * @dev Transfer and approve functionalities are disabled since its a non-transferable token
 */
contract VariableDebtToken is
  DebtTokenBase,
  ScaledBalanceTokenBase,
  IVariableDebtToken,
  PriceEmitter
{
  using SafeCast for uint256;
  using TokenMath for uint256;

  uint256 public constant DEBT_TOKEN_REVISION = 0x2;

  /**
   * @dev Constructor.
   * @param pool The address of the Pool contract
   */
  constructor(
    IPool pool
  )
    DebtTokenBase()
    ScaledBalanceTokenBase(pool, 'VARIABLE_DEBT_TOKEN_IMPL', 'VARIABLE_DEBT_TOKEN_IMPL', 0)
  {
    // Intentionally left blank
  }

  /// @inheritdoc IInitializableDebtToken
  function initialize(
    IPool initializingPool,
    address underlyingAsset,
    IAaveIncentivesController incentivesController,
    uint8 debtTokenDecimals,
    string memory debtTokenName,
    string memory debtTokenSymbol,
    bytes calldata params
  ) external override initializer {
    require(initializingPool == POOL, Errors.POOL_ADDRESSES_DO_NOT_MATCH);
    _setName(debtTokenName);
    _setSymbol(debtTokenSymbol);
    _setDecimals(debtTokenDecimals);

    _underlyingAsset = underlyingAsset;
    _incentivesController = incentivesController;

    _domainSeparator = _calculateDomainSeparator();

    emit Initialized(
      underlyingAsset,
      address(POOL),
      address(incentivesController),
      debtTokenDecimals,
      debtTokenName,
      debtTokenSymbol,
      params
    );
  }

  /// @inheritdoc VersionedInitializable
  function getRevision() internal pure virtual override returns (uint256) {
    return DEBT_TOKEN_REVISION;
  }

  /// @inheritdoc IERC20
  function balanceOf(address user) public view virtual override returns (uint256) {
    return
      TokenMath.getVTokenBalance(
        uint256(_userState[user].balance),
        POOL.getReserveNormalizedVariableDebt(_underlyingAsset)
      );
  }

  /// @inheritdoc IVariableDebtToken
  function mint(
    address user,
    address onBehalfOf,
    uint256 amount,
    uint256 index
  )
    external
    virtual
    override
    onlyPool
    emitPrice(POOL, _underlyingAsset, ACTION_BORROW, onBehalfOf)
    returns (bool, uint256)
  {
    uint256 amountScaled = TokenMath.getVTokenMintScaledAmount(amount, index);
    require(amountScaled != 0, Errors.INVALID_MINT_AMOUNT);

    if (user != onBehalfOf) {
      uint256 scaledBalanceOfOnBehalfOf = uint256(_userState[onBehalfOf].balance);
      uint256 debtIncrease = TokenMath.getVTokenBalance(
        scaledBalanceOfOnBehalfOf + amountScaled,
        index
      ) - TokenMath.getVTokenBalance(scaledBalanceOfOnBehalfOf, index);
      _decreaseBorrowAllowanceCapped(onBehalfOf, user, amount, debtIncrease);
    }

    bool firstAction = _mintScaledV2(user, onBehalfOf, amountScaled, index);
    return (firstAction, scaledTotalSupply());
  }

  /// @inheritdoc IVariableDebtToken
  function burn(
    address from,
    uint256 amount,
    uint256 index
  )
    external
    virtual
    override
    onlyPool
    emitPrice(POOL, _underlyingAsset, ACTION_REPAY, from)
    returns (uint256)
  {
    uint256 userScaled = uint256(_userState[from].balance);
    uint256 amountScaled = TokenMath.getVTokenBurnScaledAmount(amount, index);
    uint256 userBalance = TokenMath.getVTokenBalance(userScaled, index);

    if (amount >= userBalance) {
      amountScaled = userScaled;
    }

    require(amountScaled != 0, Errors.INVALID_BURN_AMOUNT);

    _burnScaledV2(from, address(0), amountScaled, index);
    return scaledTotalSupply();
  }

  /// @inheritdoc IERC20
  function totalSupply() public view virtual override returns (uint256) {
    return
      TokenMath.getVTokenBalance(
        scaledTotalSupply(),
        POOL.getReserveNormalizedVariableDebt(_underlyingAsset)
      );
  }

  /// @inheritdoc EIP712Base
  function _EIP712BaseId() internal view override returns (string memory) {
    return name();
  }

  /**
   * @dev Being non transferrable, the debt token does not implement any of the
   * standard ERC20 functions for transfer and allowance.
   */
  function transfer(address, uint256) external virtual override returns (bool) {
    revert(Errors.OPERATION_NOT_SUPPORTED);
  }

  function allowance(address, address) external view virtual override returns (uint256) {
    revert(Errors.OPERATION_NOT_SUPPORTED);
  }

  function approve(address, uint256) external virtual override returns (bool) {
    revert(Errors.OPERATION_NOT_SUPPORTED);
  }

  function transferFrom(address, address, uint256) external virtual override returns (bool) {
    revert(Errors.OPERATION_NOT_SUPPORTED);
  }

  function increaseAllowance(address, uint256) external virtual override returns (bool) {
    revert(Errors.OPERATION_NOT_SUPPORTED);
  }

  function decreaseAllowance(address, uint256) external virtual override returns (bool) {
    revert(Errors.OPERATION_NOT_SUPPORTED);
  }

  /// @inheritdoc IVariableDebtToken
  function UNDERLYING_ASSET_ADDRESS() external view override returns (address) {
    return _underlyingAsset;
  }

  function _mintScaledV2(
    address caller,
    address onBehalfOf,
    uint256 amountScaled,
    uint256 index
  ) private returns (bool) {
    uint256 scaledBalance = uint256(_userState[onBehalfOf].balance);
    uint256 previousBalance = TokenMath.getVTokenBalance(
      scaledBalance,
      _userState[onBehalfOf].additionalData
    );
    uint256 currentBalanceAtIndex = TokenMath.getVTokenBalance(scaledBalance, index);
    uint256 nextBalance = TokenMath.getVTokenBalance(scaledBalance + amountScaled, index);
    uint256 balanceIncrease = currentBalanceAtIndex - previousBalance;
    uint256 amountToMint = nextBalance - previousBalance;

    _userState[onBehalfOf].additionalData = index.toUint128();

    _mint(onBehalfOf, amountScaled.toUint128());

    emit Transfer(address(0), onBehalfOf, amountToMint);
    emit Mint(caller, onBehalfOf, amountToMint, balanceIncrease, index);

    return (scaledBalance == 0);
  }

  function _burnScaledV2(
    address user,
    address target,
    uint256 amountScaled,
    uint256 index
  ) private {
    uint256 scaledBalance = uint256(_userState[user].balance);
    uint256 previousBalance = TokenMath.getVTokenBalance(
      scaledBalance,
      _userState[user].additionalData
    );
    uint256 nextBalance = TokenMath.getVTokenBalance(scaledBalance - amountScaled, index);
    uint256 balanceIncrease = TokenMath.getVTokenBalance(scaledBalance, index) - previousBalance;

    _userState[user].additionalData = index.toUint128();

    _burn(user, amountScaled.toUint128());

    if (nextBalance > previousBalance) {
      uint256 amountToMint = nextBalance - previousBalance;
      emit Transfer(address(0), user, amountToMint);
      emit Mint(user, user, amountToMint, balanceIncrease, index);
    } else {
      uint256 amountToBurn = previousBalance - nextBalance;
      emit Transfer(user, address(0), amountToBurn);
      emit Burn(user, target, amountToBurn, balanceIncrease, index);
    }
  }

  function _decreaseBorrowAllowanceCapped(
    address delegator,
    address delegatee,
    uint256 amount,
    uint256 correctedAmount
  ) private {
    uint256 oldBorrowAllowance = _borrowAllowances[delegator][delegatee];
    oldBorrowAllowance - amount;

    uint256 consumption = oldBorrowAllowance >= correctedAmount
      ? correctedAmount
      : oldBorrowAllowance;
    uint256 newAllowance = oldBorrowAllowance - consumption;

    _borrowAllowances[delegator][delegatee] = newAllowance;
    emit BorrowAllowanceDelegated(delegator, delegatee, _underlyingAsset, newAllowance);
  }
}

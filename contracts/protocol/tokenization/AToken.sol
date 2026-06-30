// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.10;

import {IERC20} from '../../dependencies/openzeppelin/contracts/IERC20.sol';
import {GPv2SafeERC20} from '../../dependencies/gnosis/contracts/GPv2SafeERC20.sol';
import {SafeCast} from '../../dependencies/openzeppelin/contracts/SafeCast.sol';
import {ECDSA} from '../../dependencies/openzeppelin/contracts/ECDSA.sol';
import {VersionedInitializable} from '../libraries/aave-upgradeability/VersionedInitializable.sol';
import {Errors} from '../libraries/helpers/Errors.sol';
import {TokenMath} from '../libraries/helpers/TokenMath.sol';
import {IPool} from '../../interfaces/IPool.sol';
import {IAToken} from '../../interfaces/IAToken.sol';
import {IAaveIncentivesController} from '../../interfaces/IAaveIncentivesController.sol';
import {IInitializableAToken} from '../../interfaces/IInitializableAToken.sol';
import {ScaledBalanceTokenBase} from './base/ScaledBalanceTokenBase.sol';
import {IncentivizedERC20} from './base/IncentivizedERC20.sol';
import {EIP712Base} from './base/EIP712Base.sol';
import {PriceEmitter} from './base/PriceEmitter.sol';

/**
 * @title Aave ERC20 AToken
 * @author Aave
 * @notice Implementation of the interest bearing token for the Aave protocol
 */
contract AToken is
  VersionedInitializable,
  ScaledBalanceTokenBase,
  EIP712Base,
  IAToken,
  PriceEmitter
{
  using SafeCast for uint256;
  using GPv2SafeERC20 for IERC20;
  using TokenMath for uint256;

  bytes32 public constant PERMIT_TYPEHASH =
    keccak256('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)');

  uint256 public constant ATOKEN_REVISION = 0x3;

  address internal _treasury;
  address internal _underlyingAsset;

  /// @inheritdoc VersionedInitializable
  function getRevision() internal pure virtual override returns (uint256) {
    return ATOKEN_REVISION;
  }

  /**
   * @dev Constructor.
   * @param pool The address of the Pool contract
   */
  constructor(
    IPool pool
  ) ScaledBalanceTokenBase(pool, 'ATOKEN_IMPL', 'ATOKEN_IMPL', 0) EIP712Base() {
    // Intentionally left blank
  }

  /// @inheritdoc IInitializableAToken
  function initialize(
    IPool initializingPool,
    address treasury,
    address underlyingAsset,
    IAaveIncentivesController incentivesController,
    uint8 aTokenDecimals,
    string calldata aTokenName,
    string calldata aTokenSymbol,
    bytes calldata params
  ) public virtual override initializer {
    require(initializingPool == POOL, Errors.POOL_ADDRESSES_DO_NOT_MATCH);
    _setName(aTokenName);
    _setSymbol(aTokenSymbol);
    _setDecimals(aTokenDecimals);

    _treasury = treasury;
    _underlyingAsset = underlyingAsset;
    _incentivesController = incentivesController;

    _domainSeparator = _calculateDomainSeparator();

    emit Initialized(
      underlyingAsset,
      address(POOL),
      treasury,
      address(incentivesController),
      aTokenDecimals,
      aTokenName,
      aTokenSymbol,
      params
    );
  }

  /// @inheritdoc IAToken
  function mint(
    address caller,
    address onBehalfOf,
    uint256 amount,
    uint256 index
  )
    external
    virtual
    override
    onlyPool
    emitPrice(POOL, _underlyingAsset, ACTION_SUPPLY, onBehalfOf)
    returns (bool)
  {
    return _mintScaledFloor(caller, onBehalfOf, amount, index);
  }

  /// @inheritdoc IAToken
  function burn(
    address from,
    address receiverOfUnderlying,
    uint256 amount,
    uint256 index
  ) external virtual override onlyPool emitPrice(POOL, _underlyingAsset, ACTION_WITHDRAW, from) {
    uint256 amountScaled = TokenMath.getATokenBurnScaledAmount(amount, index);
    require(amountScaled != 0, Errors.INVALID_BURN_AMOUNT);

    uint256 scaledBalance = _userState[from].balance;
    require(amountScaled <= scaledBalance, Errors.INVALID_BURN_AMOUNT);

    _burnScaledLeaf(from, receiverOfUnderlying, amountScaled, index);

    if (receiverOfUnderlying != address(this)) {
      IERC20(_underlyingAsset).safeTransfer(receiverOfUnderlying, amount);
    }
  }

  /// @inheritdoc IAToken
  function mintToTreasury(
    uint256 amount,
    uint256 index
  ) external virtual override onlyPool emitPrice(POOL, _underlyingAsset, ACTION_SUPPLY, _treasury) {
    if (amount == 0) {
      return;
    }

    uint256 amountScaled = TokenMath.getATokenMintScaledAmount(amount, index);
    if (amountScaled == 0) {
      return;
    }

    _mintScaledFloor(address(POOL), _treasury, amount, index);
  }

  /// @inheritdoc IAToken
  function transferOnLiquidation(
    address from,
    address to,
    uint256 value
  ) external virtual override onlyPool emitPrice(POOL, _underlyingAsset, ACTION_LIQUIDATION, from) {
    // Being a normal transfer, the Transfer() and BalanceTransfer() are emitted
    // so no need to emit a specific event here
    _transfer(from, to, value, false);
  }

  /// @inheritdoc IERC20
  function balanceOf(
    address user
  ) public view virtual override(IncentivizedERC20, IERC20) returns (uint256) {
    return
      TokenMath.getATokenBalance(
        _userState[user].balance,
        POOL.getReserveNormalizedIncome(_underlyingAsset)
      );
  }

  /// @inheritdoc IERC20
  function totalSupply() public view virtual override(IncentivizedERC20, IERC20) returns (uint256) {
    uint256 currentSupplyScaled = _totalSupply;

    if (currentSupplyScaled == 0) {
      return 0;
    }

    return currentSupplyScaled.getATokenBalance(POOL.getReserveNormalizedIncome(_underlyingAsset));
  }

  /// @inheritdoc IAToken
  function RESERVE_TREASURY_ADDRESS() external view override returns (address) {
    return _treasury;
  }

  /// @inheritdoc IAToken
  function UNDERLYING_ASSET_ADDRESS() external view override returns (address) {
    return _underlyingAsset;
  }

  /// @inheritdoc IAToken
  function transferUnderlyingTo(address target, uint256 amount) external virtual override onlyPool {
    IERC20(_underlyingAsset).safeTransfer(target, amount);
  }

  /// @inheritdoc IAToken
  function handleRepayment(
    address user,
    address onBehalfOf,
    uint256 amount
  ) external virtual override onlyPool {
    // Intentionally left blank
  }

  /// @inheritdoc IAToken
  function permit(
    address owner,
    address spender,
    uint256 value,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
  ) external override {
    require(owner != address(0), Errors.ZERO_ADDRESS_NOT_VALID);
    //solium-disable-next-line
    require(block.timestamp <= deadline, Errors.INVALID_EXPIRATION);
    uint256 currentValidNonce = _nonces[owner];
    bytes32 digest = keccak256(
      abi.encodePacked(
        '\x19\x01',
        DOMAIN_SEPARATOR(),
        keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, currentValidNonce, deadline))
      )
    );
    require(owner == ECDSA.recover(digest, v, r, s), Errors.INVALID_SIGNATURE);
    _nonces[owner] = currentValidNonce + 1;
    _approve(owner, spender, value);
  }

  /// @inheritdoc IERC20
  function transferFrom(
    address sender,
    address recipient,
    uint256 amount
  ) external virtual override(IncentivizedERC20, IERC20) returns (bool) {
    amount.toUint128();

    uint256 currentAllowance = this.allowance(sender, _msgSender());
    require(currentAllowance >= amount, Errors.INSUFFICIENT_ALLOWANCE);

    if (currentAllowance == type(uint256).max) {
      _transfer(sender, recipient, amount, true);
      return true;
    }

    uint256 index = POOL.getReserveNormalizedIncome(_underlyingAsset);
    uint256 scaledBefore = _userState[sender].balance;
    uint256 senderBalanceBefore = TokenMath.getATokenBalance(scaledBefore, index);
    uint256 senderBalanceAfter = TokenMath.getATokenBalance(
      scaledBefore - TokenMath.getATokenTransferScaledAmount(amount, index),
      index
    );
    uint256 unscaledDelta = senderBalanceBefore - senderBalanceAfter;
    uint256 allowanceSpent = unscaledDelta > currentAllowance ? currentAllowance : unscaledDelta;

    _approve(sender, _msgSender(), currentAllowance - allowanceSpent);
    _transfer(sender, recipient, amount, true);

    return true;
  }

  /**
   * @notice Transfers the aTokens between two users. Validates the transfer
   * (ie checks for valid HF after the transfer) if required
   * @param from The source address
   * @param to The destination address
   * @param amount The amount getting transferred
   * @param validate True if the transfer needs to be validated, false otherwise
   */
  struct TransferAccrualState {
    uint256 fromBalanceBefore;
    uint256 toBalanceBefore;
    uint256 fromBalanceIncrease;
    uint256 toBalanceIncrease;
  }

  function _transfer(
    address from,
    address to,
    uint256 amount,
    bool validate
  ) internal virtual emitPrice(POOL, _underlyingAsset, ACTION_ATOKEN_TRANSFER, from) {
    uint256 index = POOL.getReserveNormalizedIncome(_underlyingAsset);
    TransferAccrualState memory accrual = _captureAccrualAndRefreshAdditionalData(from, to, index);

    uint256 scaledAmount = TokenMath.getATokenTransferScaledAmount(amount, index);
    IncentivizedERC20._transfer(from, to, scaledAmount.toUint128());

    if (accrual.fromBalanceIncrease > 0) {
      emit Transfer(address(0), from, accrual.fromBalanceIncrease);
      emit Mint(
        _msgSender(),
        from,
        accrual.fromBalanceIncrease,
        accrual.fromBalanceIncrease,
        index
      );
    }

    if (from != to && accrual.toBalanceIncrease > 0) {
      emit Transfer(address(0), to, accrual.toBalanceIncrease);
      emit Mint(_msgSender(), to, accrual.toBalanceIncrease, accrual.toBalanceIncrease, index);
    }

    emit Transfer(from, to, amount);
    emit BalanceTransfer(from, to, scaledAmount, index);

    if (validate) {
      POOL.finalizeTransfer(
        _underlyingAsset,
        from,
        to,
        amount,
        accrual.fromBalanceBefore,
        accrual.toBalanceBefore
      );
    }
  }

  /**
   * @notice Overrides the parent _transfer to force validated transfer() and transferFrom()
   * @param from The source address
   * @param to The destination address
   * @param amount The amount getting transferred
   */
  function _transfer(address from, address to, uint128 amount) internal virtual override {
    _transfer(from, to, amount, true);
  }

  function _captureAccrualAndRefreshAdditionalData(
    address from,
    address to,
    uint256 index
  ) private returns (TransferAccrualState memory state) {
    uint256 fromScaled = _userState[from].balance;
    state.fromBalanceBefore = TokenMath.getATokenBalance(fromScaled, index);
    state.fromBalanceIncrease =
      state.fromBalanceBefore -
      TokenMath.getATokenBalance(fromScaled, _userState[from].additionalData);
    _userState[from].additionalData = index.toUint128();

    if (from != to) {
      uint256 toScaled = _userState[to].balance;
      state.toBalanceBefore = TokenMath.getATokenBalance(toScaled, index);
      state.toBalanceIncrease =
        state.toBalanceBefore -
        TokenMath.getATokenBalance(toScaled, _userState[to].additionalData);
      _userState[to].additionalData = index.toUint128();
    } else {
      state.toBalanceBefore = state.fromBalanceBefore;
    }
  }

  function _mintScaledFloor(
    address caller,
    address onBehalfOf,
    uint256 amount,
    uint256 index
  ) internal returns (bool) {
    uint256 amountScaled = TokenMath.getATokenMintScaledAmount(amount, index);
    require(amountScaled != 0, Errors.INVALID_MINT_AMOUNT);

    uint256 scaledBalance = _userState[onBehalfOf].balance;
    uint256 previousBalance = TokenMath.getATokenBalance(
      scaledBalance,
      _userState[onBehalfOf].additionalData
    );
    uint256 currentBalanceAtIndex = TokenMath.getATokenBalance(scaledBalance, index);
    uint256 nextBalance = TokenMath.getATokenBalance(scaledBalance + amountScaled, index);
    uint256 balanceIncrease = currentBalanceAtIndex - previousBalance;
    uint256 amountToMint = nextBalance - previousBalance;

    _userState[onBehalfOf].additionalData = index.toUint128();

    _mint(onBehalfOf, amountScaled.toUint128());

    emit Transfer(address(0), onBehalfOf, amountToMint);
    emit Mint(caller, onBehalfOf, amountToMint, balanceIncrease, index);

    return (scaledBalance == 0);
  }

  function _burnScaledLeaf(
    address user,
    address target,
    uint256 amountScaled,
    uint256 index
  ) internal {
    uint256 scaledBalance = _userState[user].balance;
    uint256 previousBalance = TokenMath.getATokenBalance(
      scaledBalance,
      _userState[user].additionalData
    );
    uint256 nextBalance = TokenMath.getATokenBalance(scaledBalance - amountScaled, index);
    uint256 balanceIncrease = TokenMath.getATokenBalance(scaledBalance, index) - previousBalance;

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

  /**
   * @dev Overrides the base function to fully implement IAToken
   * @dev see `EIP712Base.DOMAIN_SEPARATOR()` for more detailed documentation
   */
  function DOMAIN_SEPARATOR() public view override(IAToken, EIP712Base) returns (bytes32) {
    return super.DOMAIN_SEPARATOR();
  }

  /**
   * @dev Overrides the base function to fully implement IAToken
   * @dev see `EIP712Base.nonces()` for more detailed documentation
   */
  function nonces(address owner) public view override(IAToken, EIP712Base) returns (uint256) {
    return super.nonces(owner);
  }

  /// @inheritdoc EIP712Base
  function _EIP712BaseId() internal view override returns (string memory) {
    return name();
  }

  /// @inheritdoc IAToken
  function rescueTokens(address token, address to, uint256 amount) external override onlyPoolAdmin {
    require(token != _underlyingAsset, Errors.UNDERLYING_CANNOT_BE_RESCUED);
    IERC20(token).safeTransfer(to, amount);
  }
}

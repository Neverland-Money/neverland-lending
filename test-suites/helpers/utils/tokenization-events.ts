import { ethers } from 'hardhat';
import { utils } from 'ethers';
import { BigNumber } from '@ethersproject/bignumber';
import { TransactionReceipt } from '@ethersproject/providers';
import { RAY, ZERO_ADDRESS } from '../../../helpers/constants';
import { SignerWithAddress } from '../make-suite';
import { calcExpectedStableDebtTokenBalance } from './calculations';
import { getTxCostAndTimestamp } from '../actions';
import { RateMode } from '../../../helpers/types';
import { convertToCurrencyDecimals } from '../../../helpers/contracts-helpers';
import { matchEvent } from './helpers';
import './wadraymath';
import { expect } from 'chai';

const ATOKEN_EVENTS = [
  { sig: 'Transfer(address,address,uint256)', args: ['from', 'to', 'value'] },
  {
    sig: 'Mint(address,address,uint256,uint256,uint256)',
    args: ['caller', 'onBehalfOf', 'value', 'balanceIncrease', 'index'],
  },
  {
    sig: 'Burn(address,address,uint256,uint256,uint256)',
    args: ['from', 'target', 'value', 'balanceIncrease', 'index'],
  },
  {
    sig: 'BalanceTransfer(address,address,uint256,uint256)',
    args: ['from', 'to', 'value', 'index'],
  },
];
const VARIABLE_DEBT_TOKEN_EVENTS = [
  { sig: 'Transfer(address,address,uint256)', args: ['from', 'to', 'value'] },
  {
    sig: 'Mint(address,address,uint256,uint256,uint256)',
    args: ['caller', 'onBehalfOf', 'value', 'balanceIncrease', 'index'],
  },
  {
    sig: 'Burn(address,address,uint256,uint256,uint256)',
    args: ['from', 'target', 'value', 'balanceIncrease', 'index'],
  },
];
const STABLE_DEBT_TOKEN_EVENTS = [
  { sig: 'Transfer(address,address,uint256)', args: ['from', 'to', 'value'] },
  {
    sig: 'Mint(address,address,uint256,uint256,uint256,uint256,uint256,uint256)',
    args: [
      'user',
      'onBehalfOf',
      'amount',
      'currentBalance',
      'balanceIncrease',
      'newRate',
      'avgStableRate',
      'newTotalSupply',
    ],
  },
  {
    sig: 'Burn(address,uint256,uint256,uint256,uint256,uint256)',
    args: [
      'from',
      'amount',
      'currentBalance',
      'balanceIncrease',
      'avgStableRate',
      'newTotalSupply',
    ],
  },
];

const ray = BigNumber.from(RAY);

const rayMulFloor = (a: BigNumber, b: BigNumber) => a.mul(b).div(ray);

const rayMulCeil = (a: BigNumber, b: BigNumber) => {
  if (a.isZero() || b.isZero()) return BigNumber.from(0);
  return a.mul(b).add(ray.sub(1)).div(ray);
};

const rayDivFloor = (a: BigNumber, b: BigNumber) => a.mul(ray).div(b);

const rayDivCeil = (a: BigNumber, b: BigNumber) => {
  if (a.isZero()) return BigNumber.from(0);
  return a.mul(ray).add(b.sub(1)).div(b);
};

const getATokenBalance = (scaledBalance: BigNumber, index: BigNumber) => {
  return rayMulFloor(scaledBalance, index);
};

const getVTokenBalance = (scaledBalance: BigNumber, index: BigNumber) => {
  return rayMulCeil(scaledBalance, index);
};

const getATokenBalanceIncrease = (
  scaledBalance: BigNumber,
  indexBeforeAction: BigNumber,
  indexAfterAction: BigNumber
) => {
  return getATokenBalance(scaledBalance, indexAfterAction).sub(
    getATokenBalance(scaledBalance, indexBeforeAction)
  );
};

const getVTokenBalanceIncrease = (
  scaledBalance: BigNumber,
  indexBeforeAction: BigNumber,
  indexAfterAction: BigNumber
) => {
  return getVTokenBalance(scaledBalance, indexAfterAction).sub(
    getVTokenBalance(scaledBalance, indexBeforeAction)
  );
};

export const supply = async (
  pool: any,
  user: SignerWithAddress,
  underlying: string,
  amountToConvert: string,
  onBehalfOf: string,
  debug: boolean = false
) => {
  const amount = await convertToCurrencyDecimals(underlying, amountToConvert);
  const { aTokenAddress } = await pool.getReserveData(underlying);
  const underlyingToken = await ethers.getContractAt('IERC20', underlying, user.signer);
  const aToken = await ethers.getContractAt('AToken', aTokenAddress, user.signer);

  const previousIndex = await aToken.getPreviousIndex(onBehalfOf);
  const scaledBalanceBefore = await aToken.scaledBalanceOf(onBehalfOf);

  const tx = await pool.connect(user.signer).supply(underlying, amount, onBehalfOf, '0');
  const rcpt = await tx.wait();

  const indexAfter = await pool.getReserveNormalizedIncome(underlying);
  const amountScaled = rayDivFloor(amount, indexAfter);
  const balanceIncrease = getATokenBalanceIncrease(scaledBalanceBefore, previousIndex, indexAfter);
  const amountToMint = getATokenBalance(scaledBalanceBefore.add(amountScaled), indexAfter).sub(
    getATokenBalance(scaledBalanceBefore, previousIndex)
  );

  if (debug) printATokenEvents(aToken, rcpt);
  matchEvent(rcpt, 'Transfer', underlyingToken, underlying, [user.address, aToken.address, amount]);
  matchEvent(rcpt, 'Transfer', aToken, aToken.address, [ZERO_ADDRESS, onBehalfOf, amountToMint]);
  matchEvent(rcpt, 'Mint', aToken, aToken.address, [
    user.address,
    onBehalfOf,
    amountToMint,
    balanceIncrease,
    indexAfter,
  ]);
  return rcpt;
};

export const withdraw = async (
  pool: any,
  user: SignerWithAddress,
  underlying: string,
  amountToConvert: string,
  to: string,
  debug: boolean = false
) => {
  const amount = await convertToCurrencyDecimals(underlying, amountToConvert);
  const { aTokenAddress } = await pool.getReserveData(underlying);
  const underlyingToken = await ethers.getContractAt('IERC20', underlying, user.signer);
  const aToken = await ethers.getContractAt('AToken', aTokenAddress, user.signer);

  const previousIndex = await aToken.getPreviousIndex(user.address);
  const scaledBalanceBefore = await aToken.scaledBalanceOf(user.address);

  const tx = await pool.connect(user.signer).withdraw(underlying, amount, to);
  const rcpt = await tx.wait();

  const indexAfter = await pool.getReserveNormalizedIncome(underlying);
  const scaledBalanceAfter = await aToken.scaledBalanceOf(user.address);
  const previousBalance = getATokenBalance(scaledBalanceBefore, previousIndex);
  const nextBalance = getATokenBalance(scaledBalanceAfter, indexAfter);
  const balanceIncrease = getATokenBalance(scaledBalanceBefore, indexAfter).sub(previousBalance);

  if (debug) printATokenEvents(aToken, rcpt);
  matchEvent(rcpt, 'Transfer', underlyingToken, underlying, [aToken.address, to, amount]);

  if (nextBalance.gt(previousBalance)) {
    const amountToMint = nextBalance.sub(previousBalance);
    matchEvent(rcpt, 'Transfer', aToken, aToken.address, [
      ZERO_ADDRESS,
      user.address,
      amountToMint,
    ]);
    matchEvent(rcpt, 'Mint', aToken, aToken.address, [
      user.address,
      user.address,
      amountToMint,
      balanceIncrease,
      indexAfter,
    ]);
  } else {
    const amountToBurn = previousBalance.sub(nextBalance);
    matchEvent(rcpt, 'Transfer', aToken, aToken.address, [
      user.address,
      ZERO_ADDRESS,
      amountToBurn,
    ]);
    matchEvent(rcpt, 'Burn', aToken, aToken.address, [
      user.address,
      to,
      amountToBurn,
      balanceIncrease,
      indexAfter,
    ]);
  }

  return rcpt;
};

export const transfer = async (
  pool: any,
  user: SignerWithAddress,
  underlying: string,
  amountToConvert: string,
  to: string,
  debug: boolean = false
) => {
  const amount = await convertToCurrencyDecimals(underlying, amountToConvert);
  const { aTokenAddress } = await pool.getReserveData(underlying);
  const aToken = await ethers.getContractAt('AToken', aTokenAddress, user.signer);

  const fromPreviousIndex = await aToken.getPreviousIndex(user.address);
  const toPreviousIndex = await aToken.getPreviousIndex(to);
  const fromScaledBalance = await aToken.scaledBalanceOf(user.address);
  const toScaledBalance = await aToken.scaledBalanceOf(to);

  const tx = await aToken.connect(user.signer).transfer(to, amount);
  const rcpt = await tx.wait();

  const indexAfter = await pool.getReserveNormalizedIncome(underlying);
  const scaledAmount = rayDivCeil(amount, indexAfter);
  const fromBalanceIncrease = getATokenBalanceIncrease(
    fromScaledBalance,
    fromPreviousIndex,
    indexAfter
  );
  const toBalanceIncrease =
    user.address == to
      ? BigNumber.from(0)
      : getATokenBalanceIncrease(toScaledBalance, toPreviousIndex, indexAfter);

  if (debug) printATokenEvents(aToken, rcpt);

  matchEvent(rcpt, 'Transfer', aToken, aToken.address, [user.address, to, amount]);
  matchEvent(rcpt, 'BalanceTransfer', aToken, aToken.address, [
    user.address,
    to,
    scaledAmount,
    indexAfter,
  ]);
  if (fromBalanceIncrease.gt(0)) {
    matchEvent(rcpt, 'Transfer', aToken, aToken.address, [
      ZERO_ADDRESS,
      user.address,
      fromBalanceIncrease,
    ]);
    matchEvent(rcpt, 'Mint', aToken, aToken.address, [
      user.address,
      user.address,
      fromBalanceIncrease,
      fromBalanceIncrease,
      indexAfter,
    ]);
  }
  if (user.address != to && toBalanceIncrease.gt(0)) {
    matchEvent(rcpt, 'Transfer', aToken, aToken.address, [ZERO_ADDRESS, to, toBalanceIncrease]);
    matchEvent(rcpt, 'Mint', aToken, aToken.address, [
      user.address,
      to,
      toBalanceIncrease,
      toBalanceIncrease,
      indexAfter,
    ]);
  }

  return rcpt;
};

export const transferFrom = async (
  pool: any,
  user: SignerWithAddress,
  origin: string,
  underlying: string,
  amountToConvert: string,
  to: string,
  debug: boolean = false
) => {
  const amount = await convertToCurrencyDecimals(underlying, amountToConvert);
  const { aTokenAddress } = await pool.getReserveData(underlying);
  const aToken = await ethers.getContractAt('AToken', aTokenAddress, user.signer);

  const fromPreviousIndex = await aToken.getPreviousIndex(origin);
  const toPreviousIndex = await aToken.getPreviousIndex(to);
  const fromScaledBalance = await aToken.scaledBalanceOf(origin);
  const toScaledBalance = await aToken.scaledBalanceOf(to);

  const tx = await aToken.connect(user.signer).transferFrom(origin, to, amount);
  const rcpt = await tx.wait();

  const indexAfter = await pool.getReserveNormalizedIncome(underlying);
  const scaledAmount = rayDivCeil(amount, indexAfter);
  const fromBalanceIncrease = getATokenBalanceIncrease(
    fromScaledBalance,
    fromPreviousIndex,
    indexAfter
  );
  const toBalanceIncrease =
    origin == to
      ? BigNumber.from(0)
      : getATokenBalanceIncrease(toScaledBalance, toPreviousIndex, indexAfter);

  if (debug) printATokenEvents(aToken, rcpt);

  matchEvent(rcpt, 'Transfer', aToken, aToken.address, [origin, to, amount]);
  matchEvent(rcpt, 'BalanceTransfer', aToken, aToken.address, [
    origin,
    to,
    scaledAmount,
    indexAfter,
  ]);
  if (fromBalanceIncrease.gt(0)) {
    matchEvent(rcpt, 'Transfer', aToken, aToken.address, [
      ZERO_ADDRESS,
      origin,
      fromBalanceIncrease,
    ]);
    matchEvent(rcpt, 'Mint', aToken, aToken.address, [
      user.address,
      origin,
      fromBalanceIncrease,
      fromBalanceIncrease,
      indexAfter,
    ]);
  }
  if (origin != to && toBalanceIncrease.gt(0)) {
    matchEvent(rcpt, 'Transfer', aToken, aToken.address, [ZERO_ADDRESS, to, toBalanceIncrease]);
    matchEvent(rcpt, 'Mint', aToken, aToken.address, [
      user.address,
      to,
      toBalanceIncrease,
      toBalanceIncrease,
      indexAfter,
    ]);
  }

  return rcpt;
};

export const variableBorrow = async (
  pool: any,
  user: SignerWithAddress,
  underlying: string,
  amountToConvert: string,
  onBehalfOf: string,
  debug: boolean = false
) => {
  const amount = await convertToCurrencyDecimals(underlying, amountToConvert);
  const { aTokenAddress, variableDebtTokenAddress } = await pool.getReserveData(underlying);
  const underlyingToken = await ethers.getContractAt('IERC20', underlying, user.signer);
  const aToken = await ethers.getContractAt('AToken', aTokenAddress, user.signer);
  const variableDebtToken = await ethers.getContractAt(
    'VariableDebtToken',
    variableDebtTokenAddress,
    user.signer
  );

  let previousIndex = await variableDebtToken.getPreviousIndex(onBehalfOf);
  const scaledBalanceBefore = await variableDebtToken.scaledBalanceOf(onBehalfOf);

  const tx = await pool
    .connect(user.signer)
    .borrow(underlying, amount, RateMode.Variable, 0, onBehalfOf);
  const rcpt = await tx.wait();

  const indexAfter = await pool.getReserveNormalizedVariableDebt(underlying);
  const amountScaled = rayDivCeil(amount, indexAfter);
  const balanceIncrease = getVTokenBalanceIncrease(scaledBalanceBefore, previousIndex, indexAfter);
  const amountToMint = getVTokenBalance(scaledBalanceBefore.add(amountScaled), indexAfter).sub(
    getVTokenBalance(scaledBalanceBefore, previousIndex)
  );

  if (debug) printVariableDebtTokenEvents(variableDebtToken, rcpt);

  matchEvent(rcpt, 'Transfer', underlyingToken, underlying, [aToken.address, user.address, amount]);
  matchEvent(rcpt, 'Transfer', variableDebtToken, variableDebtToken.address, [
    ZERO_ADDRESS,
    onBehalfOf,
    amountToMint,
  ]);
  matchEvent(rcpt, 'Mint', variableDebtToken, variableDebtToken.address, [
    user.address,
    onBehalfOf,
    amountToMint,
    balanceIncrease,
    indexAfter,
  ]);
  return rcpt;
};

export const repayVariableBorrow = async (
  pool: any,
  user: SignerWithAddress,
  underlying: string,
  amountToConvert: string,
  onBehalfOf: string,
  debug: boolean = false
) => {
  const amount = await convertToCurrencyDecimals(underlying, amountToConvert);
  const { aTokenAddress, variableDebtTokenAddress } = await pool.getReserveData(underlying);
  const underlyingToken = await ethers.getContractAt('IERC20', underlying, user.signer);
  const aToken = await ethers.getContractAt('AToken', aTokenAddress, user.signer);
  const variableDebtToken = await ethers.getContractAt(
    'VariableDebtToken',
    variableDebtTokenAddress,
    user.signer
  );

  const previousIndex = await variableDebtToken.getPreviousIndex(onBehalfOf);
  const scaledBalanceBefore = await variableDebtToken.scaledBalanceOf(onBehalfOf);

  const tx = await pool
    .connect(user.signer)
    .repay(underlying, amount, RateMode.Variable, onBehalfOf);
  const rcpt = await tx.wait();

  // check handleRepayment function is correctly called
  await expect(tx)
    .to.emit(
      await ethers.getContractAt('MockATokenRepayment', aTokenAddress, user.signer),
      'MockRepayment'
    )
    .withArgs(user.address, onBehalfOf, amount);

  const indexAfter = await pool.getReserveNormalizedVariableDebt(underlying);
  const scaledBalanceAfter = await variableDebtToken.scaledBalanceOf(onBehalfOf);
  const previousBalance = getVTokenBalance(scaledBalanceBefore, previousIndex);
  const nextBalance = getVTokenBalance(scaledBalanceAfter, indexAfter);
  const balanceIncrease = getVTokenBalance(scaledBalanceBefore, indexAfter).sub(previousBalance);

  if (debug) printVariableDebtTokenEvents(variableDebtToken, rcpt);

  matchEvent(rcpt, 'Transfer', underlyingToken, underlying, [user.address, aToken.address, amount]);
  if (nextBalance.gt(previousBalance)) {
    const amountToMint = nextBalance.sub(previousBalance);
    matchEvent(rcpt, 'Transfer', variableDebtToken, variableDebtToken.address, [
      ZERO_ADDRESS,
      onBehalfOf,
      amountToMint,
    ]);
    matchEvent(rcpt, 'Mint', variableDebtToken, variableDebtToken.address, [
      onBehalfOf,
      onBehalfOf,
      amountToMint,
      balanceIncrease,
      indexAfter,
    ]);
  } else {
    const amountToBurn = previousBalance.sub(nextBalance);
    matchEvent(rcpt, 'Transfer', variableDebtToken, variableDebtToken.address, [
      onBehalfOf,
      ZERO_ADDRESS,
      amountToBurn,
    ]);
    matchEvent(rcpt, 'Burn', variableDebtToken, variableDebtToken.address, [
      onBehalfOf,
      ZERO_ADDRESS,
      amountToBurn,
      balanceIncrease,
      indexAfter,
    ]);
  }

  return rcpt;
};

export const stableBorrow = async (
  pool: any,
  user: SignerWithAddress,
  underlying: string,
  amountToConvert: string,
  onBehalfOf: string,
  debug: boolean = false
) => {
  const amount = await convertToCurrencyDecimals(underlying, amountToConvert);
  const { aTokenAddress, stableDebtTokenAddress } = await pool.getReserveData(underlying);
  const underlyingToken = await ethers.getContractAt('IERC20', underlying, user.signer);
  const aToken = await ethers.getContractAt('AToken', aTokenAddress, user.signer);
  const stableDebtToken = await ethers.getContractAt(
    'StableDebtToken',
    stableDebtTokenAddress,
    user.signer
  );

  const previousIndex = await stableDebtToken.getUserStableRate(onBehalfOf);
  const principalBalance = await stableDebtToken.principalBalanceOf(onBehalfOf);
  const lastTimestamp = await stableDebtToken.getUserLastUpdated(onBehalfOf);

  const tx = await pool
    .connect(user.signer)
    .borrow(underlying, amount, RateMode.Stable, 0, onBehalfOf);
  const rcpt = await tx.wait();

  const { txTimestamp } = await getTxCostAndTimestamp(rcpt);

  const newPrincipalBalance = calcExpectedStableDebtTokenBalance(
    principalBalance,
    previousIndex,
    BigNumber.from(lastTimestamp),
    txTimestamp
  );
  const balanceIncrease = newPrincipalBalance.sub(principalBalance);
  const currentAvgStableRate = await stableDebtToken.getAverageStableRate();
  const stableRateAfter = await stableDebtToken.getUserStableRate(onBehalfOf);
  const [totalSupply] = await stableDebtToken.getSupplyData();

  if (debug) printStableDebtTokenEvents(stableDebtToken, rcpt);

  matchEvent(rcpt, 'Transfer', underlyingToken, underlying, [aToken.address, user.address, amount]);
  matchEvent(rcpt, 'Transfer', stableDebtToken, stableDebtToken.address, [
    ZERO_ADDRESS,
    onBehalfOf,
    amount.add(balanceIncrease),
  ]);
  matchEvent(rcpt, 'Mint', stableDebtToken, stableDebtToken.address, [
    user.address,
    onBehalfOf,
    amount.add(balanceIncrease),
    newPrincipalBalance,
    balanceIncrease,
    stableRateAfter,
    currentAvgStableRate,
    totalSupply,
  ]);
  return rcpt;
};

export const repayStableBorrow = async (
  pool: any,
  user: SignerWithAddress,
  underlying: string,
  amountToConvert: string,
  onBehalfOf: string,
  debug: boolean = false
) => {
  const amount = await convertToCurrencyDecimals(underlying, amountToConvert);
  const { aTokenAddress, stableDebtTokenAddress } = await pool.getReserveData(underlying);
  const underlyingToken = await ethers.getContractAt('IERC20', underlying, user.signer);
  const aToken = await ethers.getContractAt('AToken', aTokenAddress, user.signer);
  const stableDebtToken = await ethers.getContractAt(
    'StableDebtToken',
    stableDebtTokenAddress,
    user.signer
  );

  const principalBalance = await stableDebtToken.principalBalanceOf(onBehalfOf);
  const previousIndex = await stableDebtToken.getUserStableRate(onBehalfOf);
  const lastTimestamp = await stableDebtToken.getUserLastUpdated(onBehalfOf);

  const tx = await pool.connect(user.signer).repay(underlying, amount, RateMode.Stable, onBehalfOf);
  const rcpt = await tx.wait();

  const { txTimestamp } = await getTxCostAndTimestamp(rcpt);

  const newPrincipalBalance = calcExpectedStableDebtTokenBalance(
    principalBalance,
    previousIndex,
    BigNumber.from(lastTimestamp),
    txTimestamp
  );

  const balanceIncrease = newPrincipalBalance.sub(principalBalance);
  const currentAvgStableRate = await stableDebtToken.getAverageStableRate();
  const stableRateAfter = await stableDebtToken.getUserStableRate(onBehalfOf);
  const [totalSupply] = await stableDebtToken.getSupplyData();

  if (debug) printStableDebtTokenEvents(stableDebtToken, rcpt);

  matchEvent(rcpt, 'Transfer', underlyingToken, underlying, [user.address, aToken.address, amount]);
  if (balanceIncrease.gt(amount)) {
    matchEvent(rcpt, 'Transfer', stableDebtToken, stableDebtToken.address, [
      ZERO_ADDRESS,
      onBehalfOf,
      balanceIncrease.sub(amount),
    ]);
    matchEvent(rcpt, 'Mint', stableDebtToken, stableDebtToken.address, [
      onBehalfOf,
      onBehalfOf,
      balanceIncrease.sub(amount),
      newPrincipalBalance,
      balanceIncrease,
      stableRateAfter,
      currentAvgStableRate,
      totalSupply,
    ]);
  } else {
    matchEvent(rcpt, 'Transfer', stableDebtToken, stableDebtToken.address, [
      onBehalfOf,
      ZERO_ADDRESS,
      amount.sub(balanceIncrease),
    ]);
    matchEvent(rcpt, 'Burn', stableDebtToken, stableDebtToken.address, [
      onBehalfOf,
      amount.sub(balanceIncrease),
      newPrincipalBalance,
      balanceIncrease,
      currentAvgStableRate,
      totalSupply,
    ]);
  }

  return rcpt;
};

export const printATokenEvents = (aToken: any, receipt: TransactionReceipt) => {
  for (const eventSig of ATOKEN_EVENTS) {
    const eventName = eventSig.sig.split('(')[0];
    const encodedSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(eventSig.sig));
    const rawEvents = receipt.logs.filter(
      (log) => log.topics[0] === encodedSig && log.address == aToken.address
    );
    for (const rawEvent of rawEvents) {
      const rawParsed = aToken.interface.decodeEventLog(eventName, rawEvent.data, rawEvent.topics);
      const parsed: any[] = [];

      let i = 0;
      for (const arg of eventSig.args) {
        parsed[i] = ['value', 'balanceIncrease'].includes(arg)
          ? ethers.utils.formatEther(rawParsed[arg])
          : rawParsed[arg];
        i++;
      }

      console.log(`event ${eventName} ${parsed[0]} -> ${parsed[1]}: ${parsed.slice(2).join(' ')}`);
    }
  }
};

export const getATokenEvent = (aToken: any, receipt: TransactionReceipt, eventName: string) => {
  const eventSig = ATOKEN_EVENTS.find((item) => item.sig.split('(')[0] === eventName);
  const results: utils.Result = [];
  if (eventSig) {
    const encodedSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(eventSig.sig));
    const rawEvents = receipt.logs.filter(
      (log) => log.topics[0] === encodedSig && log.address == aToken.address
    );
    for (const rawEvent of rawEvents) {
      results.push(aToken.interface.decodeEventLog(eventName, rawEvent.data, rawEvent.topics));
    }
  }
  return results;
};

export const printVariableDebtTokenEvents = (
  variableDebtToken: any,
  receipt: TransactionReceipt
) => {
  for (const eventSig of VARIABLE_DEBT_TOKEN_EVENTS) {
    const eventName = eventSig.sig.split('(')[0];
    const encodedSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(eventSig.sig));
    const rawEvents = receipt.logs.filter(
      (log) => log.topics[0] === encodedSig && log.address == variableDebtToken.address
    );
    for (const rawEvent of rawEvents) {
      const rawParsed = variableDebtToken.interface.decodeEventLog(
        eventName,
        rawEvent.data,
        rawEvent.topics
      );
      const parsed: any[] = [];

      let i = 0;
      for (const arg of eventSig.args) {
        parsed[i] = ['value', 'balanceIncrease'].includes(arg)
          ? ethers.utils.formatEther(rawParsed[arg])
          : rawParsed[arg];
        i++;
      }

      console.log(`event ${eventName} ${parsed[0]} -> ${parsed[1]}: ${parsed.slice(2).join(' ')}`);
    }
  }
};

export const getVariableDebtTokenEvent = (
  variableDebtToken: any,
  receipt: TransactionReceipt,
  eventName: string
) => {
  const eventSig = VARIABLE_DEBT_TOKEN_EVENTS.find((item) => item.sig.split('(')[0] === eventName);
  const results: utils.Result = [];
  if (eventSig) {
    const encodedSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(eventSig.sig));
    const rawEvents = receipt.logs.filter(
      (log) => log.topics[0] === encodedSig && log.address == variableDebtToken.address
    );
    for (const rawEvent of rawEvents) {
      results.push(
        variableDebtToken.interface.decodeEventLog(eventName, rawEvent.data, rawEvent.topics)
      );
    }
  }
  return results;
};

export const printStableDebtTokenEvents = (stableDebtToken: any, receipt: TransactionReceipt) => {
  for (const eventSig of STABLE_DEBT_TOKEN_EVENTS) {
    const eventName = eventSig.sig.split('(')[0];
    const encodedSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(eventSig.sig));
    const rawEvents = receipt.logs.filter(
      (log) => log.topics[0] === encodedSig && log.address == stableDebtToken.address
    );
    for (const rawEvent of rawEvents) {
      const rawParsed = stableDebtToken.interface.decodeEventLog(
        eventName,
        rawEvent.data,
        rawEvent.topics
      );
      const parsed: any[] = [];

      let i = 0;
      for (const arg of eventSig.args) {
        parsed[i] = ['value', 'currentBalance', 'balanceIncrease'].includes(arg)
          ? ethers.utils.formatEther(rawParsed[arg])
          : rawParsed[arg];
        i++;
      }

      console.log(`event ${eventName} ${parsed[0]} -> ${parsed[1]}: ${parsed.slice(2).join(' ')}`);
    }
  }
};

export const getStableDebtTokenEvent = (
  stableDebtToken: any,
  receipt: TransactionReceipt,
  eventName: string
) => {
  const eventSig = STABLE_DEBT_TOKEN_EVENTS.find((item) => item.sig.split('(')[0] === eventName);
  const results: utils.Result = [];
  if (eventSig) {
    const encodedSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(eventSig.sig));
    const rawEvents = receipt.logs.filter(
      (log) => log.topics[0] === encodedSig && log.address == stableDebtToken.address
    );
    for (const rawEvent of rawEvents) {
      results.push(
        stableDebtToken.interface.decodeEventLog(eventName, rawEvent.data, rawEvent.topics)
      );
    }
  }
  return results;
};

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';

const RAY = BigNumber.from(10).pow(27);
const PERCENTAGE_FACTOR = BigNumber.from(10000);

const ceilDiv = (value: BigNumber, denominator: BigNumber) =>
  value.div(denominator).add(value.mod(denominator).isZero() ? 0 : 1);

describe('Neverland rounding math', () => {
  let math: any;

  before(async () => {
    const factory = await ethers.getContractFactory('MathPropertyHarness');
    math = await factory.deploy();
    await math.deployed();
  });

  it('exposes directional ray helpers', async () => {
    const a = BigNumber.from(7);
    const b = RAY.mul(2).add(3);
    const product = a.mul(b);

    expect(await math.rayMulFloor(a, b)).to.eq(product.div(RAY));
    expect(await math.rayMulCeil(a, b)).to.eq(ceilDiv(product, RAY));

    const numerator = BigNumber.from(1).mul(RAY);
    const denominator = RAY.mul(2);
    expect(await math.rayDivFloor(1, denominator)).to.eq(numerator.div(denominator));
    expect(await math.rayDivCeil(1, denominator)).to.eq(ceilDiv(numerator, denominator));
  });

  it('exposes directional percentage helpers', async () => {
    const value = BigNumber.from(101);
    const percentage = BigNumber.from(3333);
    const product = value.mul(percentage);

    expect(await math.percentMulFloor(value, percentage)).to.eq(product.div(PERCENTAGE_FACTOR));
    expect(await math.percentMulCeil(value, percentage)).to.eq(ceilDiv(product, PERCENTAGE_FACTOR));

    const divisionProduct = value.mul(PERCENTAGE_FACTOR);
    expect(await math.percentDivFloor(value, percentage)).to.eq(divisionProduct.div(percentage));
    expect(await math.percentDivCeil(value, percentage)).to.eq(
      ceilDiv(divisionProduct, percentage)
    );
  });

  it('maps token helpers to protocol-favoring directions', async () => {
    const amount = BigNumber.from(1);
    const scaled = BigNumber.from(1);
    const highIndex = RAY.mul(2);

    expect(await math.getATokenMintScaledAmount(amount, highIndex)).to.eq(0);
    expect(await math.getATokenBurnScaledAmount(amount, highIndex)).to.eq(1);
    expect(await math.getATokenTransferScaledAmount(amount, highIndex)).to.eq(1);
    expect(await math.getATokenBalance(scaled, highIndex)).to.eq(2);

    expect(await math.getVTokenMintScaledAmount(amount, highIndex)).to.eq(1);
    expect(await math.getVTokenBurnScaledAmount(amount, highIndex)).to.eq(0);
    expect(await math.getVTokenBalance(scaled, highIndex)).to.eq(2);
  });
});

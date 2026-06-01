// Seeded fuzz property tests for the in-tree directional math helpers.
//
// What this proves and why it lives in `rounding-patch/`:
//   - The four directional ray helpers (rayMulFloor / rayMulCeil /
//     rayDivFloor / rayDivCeil) and the four directional percent helpers
//     (percentMulFloor / percentMulCeil / percentDivFloor / percentDivCeil)
//     match a TS reference oracle across thousands of seeded random cases,
//     and each ceil/floor pair sandwiches the half-up reference with a
//     residue of exactly 0 or 1 wei.
//   - Directional round-trip protection holds: the protocol never owes the
//     user more than it stored (rayMulCeil(rayDivFloor(x, idx), idx) <= x)
//     and never recovers less than the user requested
//     (rayMulFloor(rayDivCeil(x, idx), idx) >= x).
//   - The documented overflow/zero boundaries revert.
//   - Each TokenMath wrapper delegates to the documented directional ray
//     primitive (aMint->rayDivFloor, aBurn->rayDivCeil, aTransfer->rayDivCeil,
//     aBalance->rayMulFloor; vMint->rayDivCeil, vBurn->rayDivFloor,
//     vBalance->rayMulCeil).
//   - ReserveLogic._accrueToTreasury floors the variable-debt index delta before
//     reserve-factor scaling.
//
// This is the FUZZ spec; rounding-math.spec.ts in this dir does only point
// checks and is intentionally left untouched. We use a seeded LCG instead of
// a property-test framework so the spec is deterministic across CI runs and
// adds no runtime dependency. The harness is a pure (stateless) contract, so
// the TS reference oracle below is the source of truth and the on-chain
// result is compared against it directly.
//
// Light harness: MathPropertyHarness is deployed directly (no makeSuite).

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { ethers } from 'hardhat';
import { evmRevert, evmSnapshot } from '@aave/deploy-v3';

// Literal-free BigNumber RAY (constants.ts exports RAY as a string; we want a
// BigNumber here for the oracle math, so build it locally).
const RAY = BigNumber.from(10).pow(27);
const HALF_RAY = RAY.div(2);
const PERCENTAGE_FACTOR = BigNumber.from(10000);
const HALF_PERCENTAGE_FACTOR = BigNumber.from(5000);
const MAX_UINT = BigNumber.from(ethers.constants.MaxUint256.toString());

// ---- TS reference oracles (the patched directional contracts must match) ----

const rayMulFloorRef = (a: BigNumber, b: BigNumber): BigNumber => a.mul(b).div(RAY);
const rayMulCeilRef = (a: BigNumber, b: BigNumber): BigNumber => {
  const prod = a.mul(b);
  const q = prod.div(RAY);
  return prod.mod(RAY).isZero() ? q : q.add(1);
};
const rayMulHalfUpRef = (a: BigNumber, b: BigNumber): BigNumber => a.mul(b).add(HALF_RAY).div(RAY);

const rayDivFloorRef = (a: BigNumber, b: BigNumber): BigNumber => a.mul(RAY).div(b);
const rayDivCeilRef = (a: BigNumber, b: BigNumber): BigNumber => {
  const num = a.mul(RAY);
  const q = num.div(b);
  return num.mod(b).isZero() ? q : q.add(1);
};
const rayDivHalfUpRef = (a: BigNumber, b: BigNumber): BigNumber => a.mul(RAY).add(b.div(2)).div(b);

const percentMulFloorRef = (v: BigNumber, p: BigNumber): BigNumber =>
  v.mul(p).div(PERCENTAGE_FACTOR);
const percentMulCeilRef = (v: BigNumber, p: BigNumber): BigNumber => {
  const prod = v.mul(p);
  const q = prod.div(PERCENTAGE_FACTOR);
  return prod.mod(PERCENTAGE_FACTOR).isZero() ? q : q.add(1);
};
const percentMulHalfUpRef = (v: BigNumber, p: BigNumber): BigNumber =>
  v.mul(p).add(HALF_PERCENTAGE_FACTOR).div(PERCENTAGE_FACTOR);

const percentDivFloorRef = (v: BigNumber, p: BigNumber): BigNumber =>
  v.mul(PERCENTAGE_FACTOR).div(p);
const percentDivCeilRef = (v: BigNumber, p: BigNumber): BigNumber => {
  const num = v.mul(PERCENTAGE_FACTOR);
  const q = num.div(p);
  return num.mod(p).isZero() ? q : q.add(1);
};
const percentDivHalfUpRef = (v: BigNumber, p: BigNumber): BigNumber =>
  v.mul(PERCENTAGE_FACTOR).add(p.div(2)).div(p);

// ---- Seeded uint256 RNG (deterministic across runs) ----
// Self-contained port of the POOL spec's xorshift64* generator. Kept
// literal-free (BigInt(n), never 0n) so it compiles under es2018 without
// touching the project tsconfig.

const B0 = BigInt(0);
const B1 = BigInt(1);
const B2 = BigInt(2);
const B12 = BigInt(12);
const B25 = BigInt(25);
const B27 = BigInt(27);
const B64 = BigInt(64);
const B256 = BigInt(256);
const U64_MASK = (B1 << B64) - B1;
const XORSHIFT_MUL = BigInt('0x2545F4914F6CDD1D');

class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = seed === B0 ? B1 : seed;
  }
  // xorshift64*
  next64(): bigint {
    let x = this.s;
    x ^= x >> B12;
    x ^= (x << B25) & U64_MASK;
    x ^= x >> B27;
    this.s = x;
    return (x * XORSHIFT_MUL) & U64_MASK;
  }
  uint256(): bigint {
    let v = B0;
    for (let i = 0; i < 4; i++) {
      v = (v << B64) | this.next64();
    }
    return v;
  }
  // Random uint256 with at most `bits` significant bits.
  uintBits(bits: number): bigint {
    const mask = bits >= 256 ? (B1 << B256) - B1 : (B1 << BigInt(bits)) - B1;
    return this.uint256() & mask;
  }
}

const RAY_BIG = BigInt(10) ** B27;

// Picks an index in a realistic ray range: [RAY, ~3 * RAY).
function realisticIndex(r: Rng): BigNumber {
  const span = RAY_BIG * B2;
  const off = r.uintBits(96) % span;
  return BigNumber.from((RAY_BIG + off).toString());
}

// Picks an amount up to ~10^36 (well above any realistic supply but below
// overflow when multiplied by 3 * RAY).
function realisticAmount(r: Rng): BigNumber {
  const cap = BigInt(10) ** BigInt(36);
  const v = r.uintBits(120) % cap;
  return BigNumber.from(v.toString());
}

function realisticPercent(r: Rng): BigNumber {
  // 0..100% in basis points (PERCENTAGE_FACTOR = 1e4).
  return BigNumber.from((r.uintBits(16) % BigInt(10001)).toString());
}

// ---- Cases ----

const CASES_PER_SEED = 200;
// 8 seeds * 200 = 1600 cases per ray property, 4 seeds * 200 = 800 per percent.
const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34].map((n) => BigInt(n));

makeDescribe();

function makeDescribe() {
  describe('Neverland rounding patch: math properties (seeded fuzz)', function () {
    this.timeout(180000);

    let harness: any;
    let reserveLogicHarness: any;
    let snapId: string;

    before(async () => {
      const MathPropertyHarnessFactory = await ethers.getContractFactory('MathPropertyHarness');
      harness = await MathPropertyHarnessFactory.deploy();
      await harness.deployed();
      reserveLogicHarness = await (await ethers.getContractFactory('ReserveLogicHarness')).deploy();
      await reserveLogicHarness.deployed();
    });

    beforeEach(async () => {
      snapId = await evmSnapshot();
    });

    afterEach(async () => {
      await evmRevert(snapId);
    });

    describe('rayMul* sandwich and residue', () => {
      for (const seed of SEEDS) {
        it(`seed ${seed}: floor <= halfUp <= ceil, residue in {0,1}, matches oracle`, async () => {
          const r = new Rng(seed);
          let observedNonzeroResidue = 0;
          for (let i = 0; i < CASES_PER_SEED; i++) {
            const a = realisticAmount(r);
            const b = realisticIndex(r);
            const [floor, half, ceil] = await Promise.all([
              harness.rayMulFloor(a, b),
              harness.rayMul(a, b),
              harness.rayMulCeil(a, b),
            ]);
            expect(floor).to.equal(rayMulFloorRef(a, b));
            expect(ceil).to.equal(rayMulCeilRef(a, b));
            expect(half).to.equal(rayMulHalfUpRef(a, b));
            expect(floor.lte(half)).to.equal(true);
            expect(half.lte(ceil)).to.equal(true);
            const residue = ceil.sub(floor);
            expect(residue.eq(0) || residue.eq(1)).to.equal(true);
            if (residue.eq(1)) observedNonzeroResidue++;
          }
          // Non-vacuous: the harness ran every case and the floor/ceil split
          // is real (some case produced a 1-wei residue), so this is not a
          // silently-empty loop or an all-exact sweep.
          expect(observedNonzeroResidue).to.be.gt(0);
        });
      }
    });

    describe('rayDiv* sandwich and residue', () => {
      for (const seed of SEEDS) {
        it(`seed ${seed}: floor <= halfUp <= ceil, residue in {0,1}, matches oracle`, async () => {
          const r = new Rng(seed);
          let observedNonzeroResidue = 0;
          for (let i = 0; i < CASES_PER_SEED; i++) {
            const a = realisticAmount(r);
            const b = realisticIndex(r);
            const [floor, half, ceil] = await Promise.all([
              harness.rayDivFloor(a, b),
              harness.rayDiv(a, b),
              harness.rayDivCeil(a, b),
            ]);
            expect(floor).to.equal(rayDivFloorRef(a, b));
            expect(ceil).to.equal(rayDivCeilRef(a, b));
            expect(half).to.equal(rayDivHalfUpRef(a, b));
            expect(floor.lte(half)).to.equal(true);
            expect(half.lte(ceil)).to.equal(true);
            const residue = ceil.sub(floor);
            expect(residue.eq(0) || residue.eq(1)).to.equal(true);
            if (residue.eq(1)) observedNonzeroResidue++;
          }
          expect(observedNonzeroResidue).to.be.gt(0);
        });
      }
    });

    describe('percentMul* and percentDiv* sandwich and residue', () => {
      for (const seed of SEEDS.slice(0, 4)) {
        it(`seed ${seed}: floor <= halfUp <= ceil, residue in {0,1}, matches oracle`, async () => {
          const r = new Rng(seed);
          let observedMulResidue = 0;
          let observedDivResidue = 0;
          for (let i = 0; i < CASES_PER_SEED; i++) {
            const v = realisticAmount(r);
            let p = realisticPercent(r);
            if (p.isZero()) p = BigNumber.from(1);
            const [floor, half, ceil, divFloor, divHalf, divCeil] = await Promise.all([
              harness.percentMulFloor(v, p),
              harness.percentMul(v, p),
              harness.percentMulCeil(v, p),
              harness.percentDivFloor(v, p),
              harness.percentDiv(v, p),
              harness.percentDivCeil(v, p),
            ]);
            expect(floor).to.equal(percentMulFloorRef(v, p));
            expect(ceil).to.equal(percentMulCeilRef(v, p));
            expect(half).to.equal(percentMulHalfUpRef(v, p));
            expect(divFloor).to.equal(percentDivFloorRef(v, p));
            expect(divCeil).to.equal(percentDivCeilRef(v, p));
            expect(divHalf).to.equal(percentDivHalfUpRef(v, p));
            expect(floor.lte(half)).to.equal(true);
            expect(half.lte(ceil)).to.equal(true);
            const residue = ceil.sub(floor);
            expect(residue.eq(0) || residue.eq(1)).to.equal(true);
            if (residue.eq(1)) observedMulResidue++;
            expect(divFloor.lte(divHalf)).to.equal(true);
            expect(divHalf.lte(divCeil)).to.equal(true);
            const divResidue = divCeil.sub(divFloor);
            expect(divResidue.eq(0) || divResidue.eq(1)).to.equal(true);
            if (divResidue.eq(1)) observedDivResidue++;
          }
          // Non-vacuous: both the mul and div ceil/floor splits are exercised.
          expect(observedMulResidue).to.be.gt(0);
          expect(observedDivResidue).to.be.gt(0);
        });
      }
    });

    describe('rayMul / rayDiv directional round-trip protection', () => {
      it('rayMulCeil(rayDivFloor(x, idx), idx) <= x (protocol never owes the user)', async () => {
        const r = new Rng(BigInt(0xaaaabeef));
        let strictlyBelow = 0;
        const ITER = 500;
        for (let i = 0; i < ITER; i++) {
          const x = realisticAmount(r);
          const idx = realisticIndex(r);
          const scaled = await harness.rayDivFloor(x, idx);
          const back = await harness.rayMulCeil(scaled, idx);
          // rayDivFloor undershoots, rayMulCeil corrects up by at most one
          // residue, so the round-trip can never exceed the original x.
          expect(back.lte(x)).to.equal(true);
          if (back.lt(x)) strictlyBelow++;
        }
        // Non-vacuous: at least one round-trip lost a residue (lt, not just
        // eq), proving the floor-then-ceil path is actually directional and
        // the loop ran rather than reverting silently.
        expect(strictlyBelow).to.be.gt(0);
      });

      it('rayMulFloor(rayDivCeil(x, idx), idx) >= x (user always recovers their request)', async () => {
        const r = new Rng(BigInt(0xbeefaaaa));
        let strictlyAbove = 0;
        const ITER = 500;
        for (let i = 0; i < ITER; i++) {
          const x = realisticAmount(r);
          const idx = realisticIndex(r);
          const scaled = await harness.rayDivCeil(x, idx);
          const back = await harness.rayMulFloor(scaled, idx);
          // rayDivCeil overshoots, rayMulFloor trims down by at most one
          // residue, so the round-trip recovers at least the original x.
          expect(back.gte(x)).to.equal(true);
          if (back.gt(x)) strictlyAbove++;
        }
        expect(strictlyAbove).to.be.gt(0);
      });
    });

    describe('TokenMath wrappers delegate to the documented directional ray helper', () => {
      it('each AToken wrapper matches its expected ray primitive (mint->divFloor, burn/transfer->divCeil, balance->mulFloor)', async () => {
        const r = new Rng(BigInt('0xA770EBABE'));
        const ITER = 400;
        let checked = 0;
        for (let i = 0; i < ITER; i++) {
          const amount = realisticAmount(r);
          const idx = realisticIndex(r);
          expect(await harness.getATokenMintScaledAmount(amount, idx)).to.equal(
            rayDivFloorRef(amount, idx)
          );
          expect(await harness.getATokenBurnScaledAmount(amount, idx)).to.equal(
            rayDivCeilRef(amount, idx)
          );
          expect(await harness.getATokenTransferScaledAmount(amount, idx)).to.equal(
            rayDivCeilRef(amount, idx)
          );
          expect(await harness.getATokenBalance(amount, idx)).to.equal(rayMulFloorRef(amount, idx));
          checked++;
        }
        // Non-vacuous: every iteration was asserted, the loop fully ran.
        expect(checked).to.equal(ITER);
      });

      it('each VToken wrapper matches its expected ray primitive (mint->divCeil, burn->divFloor, balance->mulCeil)', async () => {
        const r = new Rng(BigInt(0xb07cabba));
        const ITER = 400;
        let checked = 0;
        for (let i = 0; i < ITER; i++) {
          const amount = realisticAmount(r);
          const idx = realisticIndex(r);
          expect(await harness.getVTokenMintScaledAmount(amount, idx)).to.equal(
            rayDivCeilRef(amount, idx)
          );
          expect(await harness.getVTokenBurnScaledAmount(amount, idx)).to.equal(
            rayDivFloorRef(amount, idx)
          );
          expect(await harness.getVTokenBalance(amount, idx)).to.equal(rayMulCeilRef(amount, idx));
          checked++;
        }
        expect(checked).to.equal(ITER);
      });

      it('aMint/aBalance and vBurn round-down while aBurn/vMint round-up at a 1-wei boundary (direction is observable, not a no-op)', async () => {
        // amount = 1 unit, index = 2 RAY. rayDiv(1, 2RAY) = 0.5 exactly.
        // Floor -> 0, ceil -> 1, so the mint/burn split is directly visible.
        const amount = BigNumber.from(1);
        const scaled = BigNumber.from(1);
        const highIndex = RAY.mul(2);

        // AToken: mint floors to 0 (protocol mints no dust), burn/transfer
        // ceil to 1 (user pays full residue).
        expect(await harness.getATokenMintScaledAmount(amount, highIndex)).to.equal(0);
        expect(await harness.getATokenBurnScaledAmount(amount, highIndex)).to.equal(1);
        expect(await harness.getATokenTransferScaledAmount(amount, highIndex)).to.equal(1);
        // aBalance reads scaled 1 at 2 RAY -> 2 (mulFloor, exact here).
        expect(await harness.getATokenBalance(scaled, highIndex)).to.equal(2);

        // VToken: mint ceils to 1 (debt rounds against the borrower), burn
        // floors to 0 (borrower repays no extra dust scaled).
        expect(await harness.getVTokenMintScaledAmount(amount, highIndex)).to.equal(1);
        expect(await harness.getVTokenBurnScaledAmount(amount, highIndex)).to.equal(0);
        // vBalance reads scaled 1 at 2 RAY -> 2 (mulCeil, exact here).
        expect(await harness.getVTokenBalance(scaled, highIndex)).to.equal(2);
      });
    });

    describe('Documented overflow and division-by-zero boundaries revert', () => {
      it('rayMulFloor / rayMulCeil revert when a * b overflows uint256', async () => {
        // a = 2^192, b = 2^65 -> a*b = 2^257 (overflows).
        const a = BigNumber.from(1).shl(192);
        const b = BigNumber.from(1).shl(65);
        await expect(harness.rayMulFloor(a, b)).to.be.reverted;
        await expect(harness.rayMulCeil(a, b)).to.be.reverted;
        // Non-vacuous control: a finite case directly below the guard works.
        const ok = BigNumber.from(1).shl(160);
        expect(await harness.rayMulFloor(ok, RAY)).to.equal(ok);
      });

      it('rayDivFloor / rayDivCeil revert when a * RAY overflows', async () => {
        // a > floor((2^256 - 1) / RAY) makes a*RAY overflow.
        const a = MAX_UINT.div(RAY).add(1);
        await expect(harness.rayDivFloor(a, RAY)).to.be.reverted;
        await expect(harness.rayDivCeil(a, RAY)).to.be.reverted;
        // Non-vacuous control: exactly at the boundary it does not revert.
        const okMax = MAX_UINT.div(RAY);
        expect(await harness.rayDivFloor(okMax, RAY)).to.equal(rayDivFloorRef(okMax, RAY));
      });

      it('rayDivFloor / rayDivCeil revert on division by zero', async () => {
        await expect(harness.rayDivFloor(BigNumber.from(1), 0)).to.be.reverted;
        await expect(harness.rayDivCeil(BigNumber.from(1), 0)).to.be.reverted;
        // Non-vacuous control: a nonzero divisor returns a real value.
        expect(await harness.rayDivFloor(BigNumber.from(1), RAY)).to.equal(1);
      });

      it('percentMul variants return zero at zero percent', async () => {
        const v = realisticAmount(new Rng(BigInt(0xc0ffee)));
        expect(await harness.percentMul(v, 0)).to.equal(0);
        expect(await harness.percentMulFloor(v, 0)).to.equal(0);
        expect(await harness.percentMulCeil(v, 0)).to.equal(0);
        // Non-vacuous control: a real percentage produces a nonzero result.
        expect(await harness.percentMulCeil(v, PERCENTAGE_FACTOR)).to.equal(v);
      });

      it('percentMul variants revert when value * percentage overflows', async () => {
        const p = BigNumber.from(2);
        // half-up guard trips at (MAX - HALF_PF)/p + 1; directional guards at MAX/p + 1.
        const halfUpOverflowValue = MAX_UINT.sub(HALF_PERCENTAGE_FACTOR).div(p).add(1);
        const directionalOverflowValue = MAX_UINT.div(p).add(1);
        await expect(harness.percentMul(halfUpOverflowValue, p)).to.be.reverted;
        await expect(harness.percentMulFloor(directionalOverflowValue, p)).to.be.reverted;
        await expect(harness.percentMulCeil(directionalOverflowValue, p)).to.be.reverted;
        // Non-vacuous control: just under the directional boundary works.
        const okValue = MAX_UINT.div(p);
        expect(await harness.percentMulFloor(okValue, p)).to.equal(percentMulFloorRef(okValue, p));
      });

      it('percentDiv / percentDivFloor / percentDivCeil revert on zero percent or numerator overflow', async () => {
        await expect(harness.percentDiv(BigNumber.from(1), 0)).to.be.reverted;
        await expect(harness.percentDivFloor(BigNumber.from(1), 0)).to.be.reverted;
        await expect(harness.percentDivCeil(BigNumber.from(1), 0)).to.be.reverted;

        const overflowValue = MAX_UINT.div(PERCENTAGE_FACTOR).add(1);
        await expect(harness.percentDiv(overflowValue, 1)).to.be.reverted;
        await expect(harness.percentDivFloor(overflowValue, 1)).to.be.reverted;
        await expect(harness.percentDivCeil(overflowValue, 1)).to.be.reverted;
        // Non-vacuous control: at the boundary value it does not revert.
        const okValue = MAX_UINT.div(PERCENTAGE_FACTOR);
        expect(await harness.percentDivFloor(okValue, PERCENTAGE_FACTOR)).to.equal(
          percentDivFloorRef(okValue, PERCENTAGE_FACTOR)
        );
      });
    });

    describe('ReserveLogic treasury accrual direction', () => {
      it('_accrueToTreasury floors variable-debt index delta before reserve-factor scaling', async () => {
        const currScaledVariableDebt = BigNumber.from(1);
        const currVariableBorrowIndex = RAY;
        const indexDelta = RAY.add(HALF_RAY);
        const nextVariableBorrowIndex = currVariableBorrowIndex.add(indexDelta);
        const nextLiquidityIndex = RAY;
        const reserveFactor = PERCENTAGE_FACTOR;

        const variableDebtAccruedFloor = rayMulFloorRef(currScaledVariableDebt, indexDelta);
        const variableDebtAccruedHalfUp = rayMulHalfUpRef(currScaledVariableDebt, indexDelta);
        expect(variableDebtAccruedFloor).to.equal(1);
        expect(variableDebtAccruedHalfUp).to.equal(2);

        const expectedAccrued = rayDivFloorRef(
          percentMulHalfUpRef(variableDebtAccruedFloor, reserveFactor),
          nextLiquidityIndex
        );
        const halfUpAccrued = rayDivFloorRef(
          percentMulHalfUpRef(variableDebtAccruedHalfUp, reserveFactor),
          nextLiquidityIndex
        );
        expect(halfUpAccrued).to.be.gt(expectedAccrued);

        expect(
          await reserveLogicHarness.callStatic.accrueToTreasury(
            currScaledVariableDebt,
            currVariableBorrowIndex,
            nextVariableBorrowIndex,
            nextLiquidityIndex,
            reserveFactor
          )
        ).to.equal(expectedAccrued);
      });
    });
  });
}

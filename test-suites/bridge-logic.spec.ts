const { expect } = require('chai');
import { waitForTx } from '@aave/deploy-v3';
import { getACLManager } from '@aave/deploy-v3/dist/helpers/contract-getters';
import { ACLManager } from '../types';
import { TestEnv, makeSuite } from './helpers/make-suite';

const PORTAL_DISABLED = 'Neverland: portal/bridge disabled';

makeSuite('BridgeLogic: disabled portal gates', (testEnv: TestEnv) => {
  let aclManager: ACLManager;

  before(async () => {
    const { users } = testEnv;

    aclManager = await getACLManager();
    await waitForTx(await aclManager.addBridge(users[2].address));
  });

  it('keeps mintUnbacked disabled for bridge and non-bridge callers', async () => {
    const { users, pool, dai } = testEnv;

    await expect(
      pool.connect(users[0].signer).mintUnbacked(dai.address, 1, users[0].address, 0)
    ).to.be.revertedWith(PORTAL_DISABLED);

    await expect(
      pool.connect(users[2].signer).mintUnbacked(dai.address, 1, users[2].address, 0)
    ).to.be.revertedWith(PORTAL_DISABLED);
  });

  it('keeps backUnbacked disabled for bridge and non-bridge callers', async () => {
    const { users, pool, dai } = testEnv;

    await expect(pool.connect(users[0].signer).backUnbacked(dai.address, 1, 0)).to.be.revertedWith(
      PORTAL_DISABLED
    );

    await expect(pool.connect(users[2].signer).backUnbacked(dai.address, 1, 0)).to.be.revertedWith(
      PORTAL_DISABLED
    );
  });
});

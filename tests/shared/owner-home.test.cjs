'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { expandOwnerPath, ownerHome, runtimeHome } = require('../../shared/owner-home.cjs');

const RUNTIME = '/fixture/home/runtime/user';
const OWNER = '/fixture/owner';
const account = os.userInfo().homedir;

test('the explicit owner home wins over HOME in and out of the Host', () => {
  assert.equal(ownerHome({ HOME23_PRODUCT_HOST: 'true', HOME: RUNTIME, HOME23_OWNER_HOME: OWNER }), OWNER);
  assert.equal(ownerHome({ HOME: '/fixture/dev', HOME23_OWNER_HOME: `${OWNER}/` }), OWNER);
});

test('under the Host HOME is Home23 private home, so the passwd entry names the owner', () => {
  assert.equal(ownerHome({ HOME23_PRODUCT_HOST: 'true', HOME: RUNTIME }), account);
  // A relative or empty owner variable is not a home.
  assert.equal(ownerHome({ HOME23_PRODUCT_HOST: 'true', HOME: RUNTIME, HOME23_OWNER_HOME: 'owner' }), account);
  assert.equal(ownerHome({ HOME23_PRODUCT_HOST: 'true', HOME: RUNTIME, HOME23_OWNER_HOME: '' }), account);
});

test('outside the Host a development checkout or test may redirect HOME', () => {
  assert.equal(ownerHome({ HOME: '/fixture/dev' }), '/fixture/dev');
  assert.equal(ownerHome({ HOME23_PRODUCT_HOST: 'false', HOME: '/fixture/dev' }), '/fixture/dev');
  assert.equal(ownerHome({ HOME: 'relative' }), account);
  assert.equal(ownerHome({}), account);
});

test('the runtime home follows HOME23_RUNTIME_HOME so an owner child still finds Home23 state', () => {
  assert.equal(runtimeHome({ HOME: OWNER, HOME23_RUNTIME_HOME: RUNTIME }), RUNTIME);
  assert.equal(runtimeHome({ HOME: RUNTIME }), RUNTIME);
  assert.equal(runtimeHome({}), os.homedir());
});

test("'~' and '~/x' expand to the owner home; everything else is unchanged", () => {
  const env = { HOME23_PRODUCT_HOST: 'true', HOME: RUNTIME, HOME23_OWNER_HOME: OWNER };
  assert.equal(expandOwnerPath('~', env), OWNER);
  assert.equal(expandOwnerPath('~/', env), OWNER);
  assert.equal(expandOwnerPath('~/.health_log.jsonl', env), path.join(OWNER, '.health_log.jsonl'));
  assert.equal(expandOwnerPath('~/a/../b', env), path.join(OWNER, 'b'));
  // '~user' names another account; the old replace(/^~/) turned it into "<home>user".
  assert.equal(expandOwnerPath('~user/x', env), '~user/x');
  assert.equal(expandOwnerPath('~foo', env), '~foo');
  assert.equal(expandOwnerPath('/abs/~/x', env), '/abs/~/x');
  assert.equal(expandOwnerPath('relative/x', env), 'relative/x');
  assert.equal(expandOwnerPath('', env), '');
  assert.equal(expandOwnerPath(undefined, env), undefined);
  assert.equal(expandOwnerPath(null, env), null);
  assert.equal(expandOwnerPath(42, env), 42);
});

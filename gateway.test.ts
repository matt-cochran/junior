// ---------------------------------------------------------------------------
// Gateway resolution: one per-kind table for base URL, key source and model-id
// mapping. Every test injects env/readAuthFile; no test reads a real HOME or a
// real credential.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  GATEWAYS,
  GATEWAY_KINDS,
  validateGatewayKind,
  resolveGatewayKey,
  validateJevProvider,
  resolveJevGateway,
  companionGatewayEnv,
  GatewayError,
} from './gateway.ts';

const auth = (entry: string, value: unknown) => JSON.stringify({ [entry]: value });
const deps = (over: { env?: NodeJS.ProcessEnv; readAuthFile?: (path: string) => string } = {}) => ({
  env: {},
  readAuthFile: () => '{}',
  ...over,
});

// --- table ---
test('Gateway kinds list the openrouter and typesafe kinds in order', () => {
  assert.deepEqual([...GATEWAY_KINDS], ['openrouter', 'typesafe']);
});
test('Openrouter gateway carries the Pi transport', () => {
  assert.equal(GATEWAYS.openrouter.jevTransport, 'pi');
});
test('Typesafe gateway carries the direct http transport', () => {
  assert.equal(GATEWAYS.typesafe.jevTransport, 'http');
});
test('Typesafe gateway maps to the direct Jev model id', () => {
  assert.equal(GATEWAYS.typesafe.jevModel, 'jev-1.13');
});
test('Typesafe gateway points at the TypeSafe base URL', () => {
  assert.equal(GATEWAYS.typesafe.baseUrl, 'https://api.typesafe.ai');
});

// --- validation ---
test('Valid gateway kind is returned unchanged', () => {
  assert.equal(validateGatewayKind('typesafe'), 'typesafe');
});
test('Unknown gateway kind is rejected with the allowed kinds named', () => {
  assert.throws(() => validateGatewayKind('litellm'), /openrouter or typesafe/);
});
test('Unknown gateway kind error names the offending kind', () => {
  assert.throws(() => validateGatewayKind('litellm'), /Invalid gateway kind litellm/);
});
test('Unknown jev provider is rejected naming the allowed values', () => {
  assert.throws(() => validateJevProvider('local'), /auto, openrouter or typesafe/);
});

// --- key resolution ---
test('Gateway key resolves from the injected environment', () => {
  assert.equal(resolveGatewayKey('openrouter', deps({ env: { OPENROUTER_API_KEY: 'or-key' } })), 'or-key');
});
test('Gateway key is trimmed from the environment', () => {
  assert.equal(resolveGatewayKey('openrouter', deps({ env: { OPENROUTER_API_KEY: '  or-key  ' } })), 'or-key');
});
test('Gateway key is null when the environment value is blank', () => {
  assert.equal(resolveGatewayKey('openrouter', deps({ env: { OPENROUTER_API_KEY: '   ' } })), null);
});
test('Openrouter gateway key falls back to the auth file', () => {
  const readAuthFile = () => auth('openrouter', { type: 'api_key', key: 'or-auth' });
  assert.equal(resolveGatewayKey('openrouter', deps({ readAuthFile })), 'or-auth');
});
test('Typesafe gateway key resolves from the auth file under its auth key', () => {
  const readAuthFile = () => auth('typesafe', { type: 'api_key', key: 'ts-auth' });
  assert.equal(resolveGatewayKey('typesafe', deps({ readAuthFile })), 'ts-auth');
});
test('Gateway key resolves from an oauth auth entry access field', () => {
  const readAuthFile = () => auth('typesafe', { type: 'oauth', access: 'ts-oauth' });
  assert.equal(resolveGatewayKey('typesafe', deps({ readAuthFile })), 'ts-oauth');
});
test('Gateway key is null for a malformed auth file', () => {
  const readAuthFile = () => 'not json';
  assert.equal(resolveGatewayKey('typesafe', deps({ readAuthFile })), null);
});

// --- jev provider resolution ---
test('Jev resolves to the openrouter gateway when only its key is present', () => {
  const resolved = resolveJevGateway('auto', deps({ env: { OPENROUTER_API_KEY: 'or-key' } }));
  assert.equal(resolved?.kind, 'openrouter');
});
test('Auto provider resolves Jev to the typesafe gateway when both keys are present', () => {
  const env = { OPENROUTER_API_KEY: 'or-key', TYPESAFE_JEV_API_KEY: 'ts-key' };
  const resolved = resolveJevGateway('auto', deps({ env }));
  assert.equal(resolved?.kind, 'typesafe');
});
test('Resolved typesafe gateway carries its base URL', () => {
  const resolved = resolveJevGateway('typesafe', deps({ env: { TYPESAFE_JEV_API_KEY: 'ts-key' } }));
  assert.equal(resolved?.baseUrl, 'https://api.typesafe.ai');
});
test('Resolved typesafe gateway carries its direct model id', () => {
  const resolved = resolveJevGateway('typesafe', deps({ env: { TYPESAFE_JEV_API_KEY: 'ts-key' } }));
  assert.equal(resolved?.model, 'jev-1.13');
});
test('Jev gateway is null when no gateway key resolves', () => {
  assert.equal(resolveJevGateway('auto', deps()), null);
});
test('Explicit typesafe provider without its key raises a typed gateway error', () => {
  assert.throws(
    () => resolveJevGateway('typesafe', deps({ env: { OPENROUTER_API_KEY: 'or-key' } })),
    (error: unknown) => error instanceof GatewayError,
  );
});
test('Gateway error code identifies the missing provider key', () => {
  try {
    resolveJevGateway('typesafe', deps({ env: { OPENROUTER_API_KEY: 'or-key' } }));
    assert.fail('expected resolveJevGateway to throw');
  } catch (error) {
    assert.equal((error as GatewayError).code, 'jev_provider_key_missing');
  }
});
test('Gateway error names the missing provider key environment variable', () => {
  try {
    resolveJevGateway('typesafe', deps({ env: { OPENROUTER_API_KEY: 'or-key' } }));
    assert.fail('expected resolveJevGateway to throw');
  } catch (error) {
    assert.match(String((error as Error).message), /TYPESAFE_JEV_API_KEY/);
  }
});
test('Resolver error for a missing key does not contain another key value', () => {
  const secret = 'sk-openrouter-secret-value';
  try {
    resolveJevGateway('typesafe', deps({ env: { OPENROUTER_API_KEY: secret } }));
    assert.fail('expected resolveJevGateway to throw');
  } catch (error) {
    assert.doesNotMatch(String((error as Error).message), new RegExp(secret));
  }
});
test('Explicit openrouter provider without its key raises a typed gateway error', () => {
  assert.throws(
    () => resolveJevGateway('openrouter', deps({ env: { TYPESAFE_JEV_API_KEY: 'ts-key' } })),
    (error: unknown) => error instanceof GatewayError,
  );
});

// --- companion environment ---
test('Companion environment includes the openrouter key when only it resolves', () => {
  const out = companionGatewayEnv(deps({ env: { OPENROUTER_API_KEY: 'or-key' } }));
  assert.deepEqual(out, { OPENROUTER_API_KEY: 'or-key' });
});
test('Companion environment includes the typesafe key when it resolves', () => {
  const out = companionGatewayEnv(deps({ env: { TYPESAFE_JEV_API_KEY: 'ts-key' } }));
  assert.deepEqual(out, { TYPESAFE_JEV_API_KEY: 'ts-key' });
});
test('Companion environment is empty when no gateway key resolves', () => {
  assert.deepEqual(companionGatewayEnv(deps()), {});
});

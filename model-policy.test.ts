// Behavioral tests for the Junior model policy.
//
// A provider/model pair is eligible as a Junior executor only when it is a
// commodity / open-weight model. Frontier and unrecognized models fail closed.
// Every scenario is offline, deterministic, and asserts exactly one observable
// outcome through the module's public API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelPolicyError,
  assertCommodity,
  classifyModel,
  isCommodity,
  modelVendor,
} from './model-policy.ts';

test('classifyModel treats an OpenRouter DeepSeek execution model as commodity', () => {
  assert.equal(classifyModel('openrouter', 'deepseek/deepseek-v4.1-flash').class, 'commodity');
});

test('classifyModel treats an OpenRouter floating DeepSeek alias as commodity', () => {
  assert.equal(classifyModel('openrouter', '~deepseek/deepseek-flash-latest').class, 'commodity');
});

test('classifyModel treats an OpenRouter MoonshotAI model as commodity', () => {
  assert.equal(classifyModel('openrouter', 'moonshotai/kimi-k3').class, 'commodity');
});

test('classifyModel treats an OpenRouter Z.ai model as commodity', () => {
  assert.equal(classifyModel('openrouter', 'z-ai/glm-5.3').class, 'commodity');
});

test('classifyModel treats an OpenRouter Qwen model as commodity', () => {
  assert.equal(classifyModel('openrouter', 'qwen/qwen3.6-flash').class, 'commodity');
});

test('classifyModel treats an OpenRouter MiniMax model as commodity', () => {
  assert.equal(classifyModel('openrouter', 'minimax/minimax-m3').class, 'commodity');
});

test('classifyModel treats a direct DeepSeek execution model as commodity', () => {
  assert.equal(classifyModel('deepseek', 'deepseek-chat').class, 'commodity');
});

test('classifyModel treats an OpenRouter gpt-oss model as commodity', () => {
  assert.equal(classifyModel('openrouter', 'openai/gpt-oss-120b').class, 'commodity');
});

test('classifyModel treats an OpenRouter Anthropic model as frontier', () => {
  assert.equal(classifyModel('openrouter', 'anthropic/claude-sonnet-4').class, 'frontier');
});

test('classifyModel treats a floating OpenRouter Anthropic alias as frontier', () => {
  assert.equal(classifyModel('openrouter', '~anthropic/claude-opus-latest').class, 'frontier');
});

test('classifyModel treats an OpenRouter OpenAI model as frontier', () => {
  assert.equal(classifyModel('openrouter', 'openai/gpt-5').class, 'frontier');
});

test('classifyModel treats an OpenRouter Google model as frontier', () => {
  assert.equal(classifyModel('openrouter', 'google/gemini-3-pro').class, 'frontier');
});

test('classifyModel treats an OpenRouter xAI model as frontier', () => {
  assert.equal(classifyModel('openrouter', 'x-ai/grok-4').class, 'frontier');
});

test('classifyModel treats a direct Anthropic model as frontier', () => {
  assert.equal(classifyModel('anthropic', 'claude-opus').class, 'frontier');
});

test('classifyModel treats a direct xai model as frontier', () => {
  assert.equal(classifyModel('xai', 'grok-4').class, 'frontier');
});

test('classifyModel treats a TypeSafe Jev model as unknown', () => {
  assert.equal(classifyModel('typesafe', 'jev-1.13').class, 'unknown');
});

test('classifyModel explains that TypeSafe Jev is a classifier rather than an executor', () => {
  assert.match(classifyModel('typesafe', 'jev-1.13').reason, /classifier/);
});

test('classifyModel treats an unlisted vendor as unknown', () => {
  assert.equal(classifyModel('openrouter', 'acme/model-1').class, 'unknown');
});

test('classifyModel treats a bare OpenRouter id with no vendor as unknown', () => {
  assert.equal(classifyModel('openrouter', 'm').class, 'unknown');
});

test('classifyModel treats an empty provider as unknown', () => {
  assert.equal(classifyModel('', 'deepseek-chat').class, 'unknown');
});

test('classifyModel treats an empty id as unknown', () => {
  assert.equal(classifyModel('deepseek', '').class, 'unknown');
});

test('classifyModel is case-insensitive and trims whitespace', () => {
  assert.equal(classifyModel('  OpenRouter ', '  DeepSeek/DeepSeek-V4  ').class, 'commodity');
});

test('modelVendor resolves the leading segment of an OpenRouter id', () => {
  assert.equal(modelVendor('openrouter', 'deepseek/deepseek-v4.1-flash'), 'deepseek');
});

test('modelVendor removes a leading floating-alias tilde', () => {
  assert.equal(modelVendor('openrouter', '~deepseek/deepseek-flash-latest'), 'deepseek');
});

test('modelVendor normalizes a direct zai provider to z-ai', () => {
  assert.equal(modelVendor('zai', 'glm-5.3'), 'z-ai');
});

test('modelVendor prefers an id vendor prefix over the direct provider', () => {
  assert.equal(modelVendor('anthropic', 'deepseek/deepseek-chat'), 'deepseek');
});

test('modelVendor returns null when no vendor can be determined', () => {
  assert.equal(modelVendor('', ''), null);
});

test('isCommodity is true for a commodity execution model', () => {
  assert.equal(isCommodity('deepseek', 'deepseek-chat'), true);
});

test('isCommodity is false for a frontier model', () => {
  assert.equal(isCommodity('anthropic', 'claude-opus'), false);
});

test('assertCommodity returns the verdict for a commodity model', () => {
  assert.equal(assertCommodity('deepseek', 'deepseek-chat').class, 'commodity');
});

test('assertCommodity refuses a frontier model with frontier_model_refused', () => {
  assert.throws(
    () => assertCommodity('anthropic', 'claude-opus'),
    (err: unknown) => err instanceof ModelPolicyError && err.code === 'frontier_model_refused',
  );
});

test('assertCommodity refuses an unknown model with unknown_model_refused', () => {
  assert.throws(
    () => assertCommodity('typesafe', 'jev-1.13'),
    (err: unknown) => err instanceof ModelPolicyError && err.code === 'unknown_model_refused',
  );
});

test('ModelPolicyError message names the code and provider/id', () => {
  assert.throws(
    () => assertCommodity('anthropic', 'claude-opus'),
    (err: unknown) =>
      err instanceof ModelPolicyError &&
      err.message.includes('frontier_model_refused') &&
      err.message.includes('provider/id'),
  );
});

test('classifyModel treats a frontier direct provider as frontier even when the id names a commodity vendor', () => {
  assert.equal(classifyModel('anthropic', 'deepseek/deepseek-v4.1-flash').class, 'frontier');
});

test('classifyModel fails closed for an unrecognized direct provider serving a commodity id', () => {
  assert.equal(classifyModel('amazon-bedrock', 'deepseek/deepseek-v4.1-flash').class, 'unknown');
});

test('classifyModel accepts a direct commodity provider whose id carries its own vendor prefix', () => {
  assert.equal(classifyModel('deepseek', 'deepseek/deepseek-chat').class, 'commodity');
});

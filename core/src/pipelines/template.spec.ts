/**
 * The templating engine (BE-8) — the small PURE substitution language
 * (findings §R2: outputs templated into successors, never via context) + the
 * when/loop condition grammar. Positive/negative/edge.
 */

import { describe, expect, it } from 'vitest';

import { evaluateCondition, renderTemplate, resolveArray, type TemplateScope } from './template.js';

const scope: TemplateScope = {
  workspace: '/ws',
  inputs: { paths: ['a', 'b'], name: 'demo' },
  steps: {
    inventory: { files: ['x.ts', 'y.ts'], count: 2 },
    audit: { outputs: ['finding'] },
  },
  item: 'x.ts',
};

describe('renderTemplate', () => {
  it('resolves workspace / inputs / item / step output paths', () => {
    expect(renderTemplate('cd ${workspace}', scope)).toBe('cd /ws');
    expect(renderTemplate('name=${inputs.name}', scope)).toBe('name=demo');
    expect(renderTemplate('audit ${item}', scope)).toBe('audit x.ts');
    expect(renderTemplate('n=${steps.inventory.output.count}', scope)).toBe('n=2');
  });

  it('JSON-stringifies a non-string resolved value', () => {
    expect(renderTemplate('${steps.inventory.output.files}', scope)).toBe('["x.ts","y.ts"]');
  });

  it('renders an unresolved reference as empty string', () => {
    expect(renderTemplate('x=${inputs.missing}', scope)).toBe('x=');
  });
});

describe('resolveArray (forEach)', () => {
  it('resolves a ${…} reference to the actual array', () => {
    expect(resolveArray('${steps.inventory.output.files}', scope)).toEqual(['x.ts', 'y.ts']);
  });
  it('a non-array reference resolves to [] (empty forEach → skip)', () => {
    expect(resolveArray('${steps.inventory.output.count}', scope)).toEqual([]);
    expect(resolveArray('${inputs.missing}', scope)).toEqual([]);
  });
});

describe('evaluateCondition (when / loop.until)', () => {
  it('numeric comparison', () => {
    expect(evaluateCondition('${steps.inventory.output.count} > 0', scope)).toBe(true);
    expect(evaluateCondition('${steps.inventory.output.count} > 5', scope)).toBe(false);
  });
  it('the .length pseudo-property', () => {
    expect(evaluateCondition('${steps.audit.outputs.length} > 0', scope)).toBe(true);
    expect(evaluateCondition('${steps.inventory.output.files.length} == 2', scope)).toBe(true);
  });
  it('string equality', () => {
    expect(evaluateCondition("${inputs.name} == 'demo'", scope)).toBe(true);
    expect(evaluateCondition("${inputs.name} != 'demo'", scope)).toBe(false);
  });
  it('bare truthiness', () => {
    expect(evaluateCondition('${inputs.name}', scope)).toBe(true);
    expect(evaluateCondition('${inputs.missing}', scope)).toBe(false);
    expect(evaluateCondition('${steps.inventory.output.files}', scope)).toBe(true); // non-empty array
  });
});
